// A fake `fetch` for tests: serves hand-written JSON by path, with ETags, 304s, Link headers and
// rate-limit headers the way GitHub sends them. Never touches the network.

import type { FetchLike, FetchResponse } from "./client.ts";

export interface FakeRoute {
  body?: unknown;
  status?: number;
  /** Path (with query) of the next page. */
  next?: string;
  headers?: Record<string, string>;
}

export interface FakeCall {
  path: string;
  status: number;
  headers: Record<string, string>;
}

export interface FakeGitHub {
  fetch: FetchLike;
  calls: FakeCall[];
  /** Adds or replaces a route. The path includes the query string. */
  set(path: string, route: FakeRoute | unknown[]): void;
  /** Paths requested since the last call of this, with their status. */
  take(): string[];
  remaining: number;
}

export const FAKE_API = "https://api.github.test";

function etagOf(body: unknown): string {
  const text = JSON.stringify(body);
  let hash = 0;
  for (let index = 0; index < text.length; index++) hash = (hash * 31 + text.charCodeAt(index)) | 0;
  return `"${text.length}-${hash}"`;
}

export function fakeGitHub(routes: Record<string, FakeRoute | unknown[]> = {}): FakeGitHub {
  const table = new Map<string, FakeRoute>();
  const calls: FakeCall[] = [];
  let taken = 0;
  const set = (path: string, route: FakeRoute | unknown[]): void => {
    table.set(path, Array.isArray(route) ? { body: route } : route);
  };
  for (const [path, route] of Object.entries(routes)) set(path, route);

  const fake: FakeGitHub = {
    calls,
    set,
    remaining: 5000,
    take() {
      const fresh = calls.slice(taken).map((call) => `${call.status} ${call.path}`);
      taken = calls.length;
      return fresh;
    },
    async fetch(url, init) {
      const path = url.startsWith(FAKE_API) ? url.slice(FAKE_API.length) : url;
      const sent = init?.headers ?? {};
      const route = table.get(path);
      const headers = new Map<string, string>();
      let status = route ? (route.status ?? 200) : 404;
      const body: unknown = route ? route.body : { message: "Not Found" };
      if (status === 200) {
        const etag = etagOf(body);
        headers.set("etag", etag);
        if (sent["If-None-Match"] === etag) status = 304;
        if (route?.next) headers.set("link", `<${FAKE_API}${route.next}>; rel="next"`);
      }
      // A 304 is free, as on GitHub for an authorized request.
      if (status !== 304) fake.remaining -= 1;
      headers.set("x-ratelimit-remaining", String(fake.remaining));
      headers.set("x-ratelimit-reset", "1795000000");
      for (const [name, value] of Object.entries(route?.headers ?? {})) headers.set(name.toLowerCase(), value);
      calls.push({ path, status, headers: sent });
      const response: FetchResponse = {
        status,
        headers: { get: (name) => headers.get(name.toLowerCase()) ?? null },
        json: async () => body,
        text: async () => JSON.stringify(body),
      };
      return response;
    },
  };
  return fake;
}
