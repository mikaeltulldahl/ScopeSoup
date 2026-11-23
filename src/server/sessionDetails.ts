// `GET /api/session?id=`: one session's details behind its row in the Item page's Rounds table: its record, the tools
// it called and what it did, read from its stream file. Text only: nothing here is interpreted.

import { readFileSync } from "node:fs";
import { basename } from "node:path";
import { sessionView } from "../core/board.ts";
import type { SessionDetailsView } from "../core/views.ts";
import type { Session } from "../model/types.ts";
import { providerNamed } from "../orchestrator/providers/index.ts";
import type { Store } from "../store/store.ts";

/** The most actions listed; the earlier ones are counted. */
export const ACTIONS_SHOWN = 200;

/** The tools a stream called, most used first, and each call in a few words, oldest first. */
export function toolsFromStream(text: string, root?: string, provider?: string): Pick<SessionDetailsView, "tools" | "actions" | "actionsOmitted"> {
  const counts = new Map<string, number>();
  const actions: string[] = [];
  for (const call of providerNamed(provider).toolCallsIn(text, root)) {
    counts.set(call.name, (counts.get(call.name) ?? 0) + 1);
    actions.push(call.text);
  }
  const tools = [...counts].map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
  const omitted = Math.max(0, actions.length - ACTIONS_SHOWN);
  return { tools, actions: actions.slice(omitted), actionsOmitted: omitted };
}

/** Null when the store has no such session. */
export function sessionDetails(store: Pick<Store, "get">, id: string): SessionDetailsView | null {
  const session = store.get<Session>({ host: "scopesoup", kind: "session", id });
  if (!session) return null;
  const view: SessionDetailsView = {
    session: {
      ...sessionView(session),
      ...(session.agentSessionId ? { agentSession: session.agentSessionId } : {}),
      ...(session.streamPath ? { streamName: basename(session.streamPath) } : {}),
    },
    tools: [],
    actions: [],
    actionsOmitted: 0,
  };
  if (!session.streamPath) return { ...view, missing: "Scope Soup kept no stream for this session." };
  let text: string;
  try {
    text = readFileSync(session.streamPath, "utf8");
  } catch {
    return { ...view, missing: "The session's stream file is gone (moved or deleted)." };
  }
  return { ...view, ...toolsFromStream(text, session.cwd, session.provider) };
}
