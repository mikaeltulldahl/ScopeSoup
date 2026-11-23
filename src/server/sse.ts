// Server-sent events from the store's event log. The event id is the store's sequence
// number, so a browser that reconnects with Last-Event-ID gets what it missed, then live.

import type { IncomingMessage, ServerResponse } from "node:http";
import type { ScopeSoupEvent } from "../model/types.ts";
import type { Store } from "../store/store.ts";

const REPLAY_PAGE = 500;

/** What goes over the wire: enough to know what changed. The browser refetches the view. */
function frame(event: ScopeSoupEvent): string {
  const data = JSON.stringify({ seq: event.seq, at: event.at, kind: event.kind, subject: event.subject, actor: event.actor });
  return `id: ${event.seq}\ndata: ${data}\n\n`;
}

function lastEventId(request: IncomingMessage, url: URL): number | null {
  const header = request.headers["last-event-id"];
  const raw = (Array.isArray(header) ? header[0] : header) ?? url.searchParams.get("lastEventId");
  if (raw === null || raw === undefined || !/^\d+$/.test(raw.trim())) return null;
  return Number(raw.trim());
}

export interface EventStreams {
  /** Takes over the response as an event stream. */
  open(request: IncomingMessage, response: ServerResponse, url: URL): void;
  /** Ends every open stream. */
  closeAll(): void;
  size(): number;
}

export function createEventStreams(store: Store, heartbeatMs: number): EventStreams {
  const closers = new Set<() => void>();

  return {
    open(request, response, url) {
      response.writeHead(200, {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
      });
      response.write(`retry: 2000\n: connected\n\n`);

      // Replay and subscribe in one synchronous stretch: the store has one writer, in this
      // process, so no event can fall between the last replayed one and the first live one.
      let sent = lastEventId(request, url);
      if (sent !== null) {
        for (;;) {
          const page = store.eventsAfter(sent, REPLAY_PAGE);
          for (const event of page) response.write(frame(event));
          if (page.length > 0) sent = page[page.length - 1]!.seq;
          if (page.length < REPLAY_PAGE) break;
        }
      }
      const unsubscribe = store.onEvent((event) => {
        if (sent !== null && event.seq <= sent) return;
        response.write(frame(event));
      });
      const heartbeat = setInterval(() => response.write(`: ping\n\n`), heartbeatMs);
      heartbeat.unref();

      let closed = false;
      const close = () => {
        if (closed) return;
        closed = true;
        clearInterval(heartbeat);
        unsubscribe();
        closers.delete(close);
        response.end();
      };
      closers.add(close);
      request.on("close", close);
      response.on("error", close);
    },

    closeAll() {
      for (const close of [...closers]) close();
    },

    size() {
      return closers.size;
    },
  };
}
