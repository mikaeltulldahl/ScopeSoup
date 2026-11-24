// The HTTP side of the Jira host: authentication for Jira Cloud (Basic, email and API token) and Data Center (Bearer, a
// personal access token), JSON requests, the two ways of paging, errors and the 429 wait. Nothing here knows the model.
// API details marked "unconfirmed" are from docs/research/jira.md's [known] marks: from memory, not yet checked on a real site.

import type { FetchLike, FetchResponse } from "../github/client.ts";

export type { FetchLike, FetchResponse };

export type Deployment = "cloud" | "datacenter";

export interface JiraClientConfig {
  /** The site: `https://example.atlassian.net`, or a Data Center base URL (may have a context path). */
  site: string;
  deployment: Deployment;
  /** Passed in by the caller from SCOPESOUP_JIRA_TOKEN; the client never reads the environment. */
  token: string;
  /** Cloud only: the account's email, the user name of Basic authentication. */
  email?: string;
  fetchImpl?: FetchLike;
  /** Milliseconds since the epoch. */
  now?: () => number;
  /** Waits `ms`; injectable so tests do not wait. */
  sleep?: (ms: number) => Promise<void>;
  /** A 429 whose Retry-After is at most this long is waited out and tried again; a longer one holds requests. Default 30 s. */
  maxRetryWaitMs?: number;
  /** Tries of one request in all, with 429 answers between them. Default 4 (Atlassian's advice). */
  maxTries?: number;
}

export class JiraError extends Error {
  status: number;
  path: string;
  /** A 429, or a request not sent because one is still waited out. */
  rateLimited: boolean;
  constructor(status: number, path: string, message: string, more: { rateLimited?: boolean } = {}) {
    super(`Jira ${status} on ${path}: ${message}`);
    this.name = "JiraError";
    this.status = status;
    this.path = path;
    this.rateLimited = more.rateLimited === true;
  }
}

/** A failure that can change by itself: Jira down (5xx), a rate limit, or no answer at all. A refusal (401, 403, 404, 400) is not. */
export function transient(error: unknown): boolean {
  if (error instanceof JiraError) return error.status >= 500 || error.status === 429 || error.rateLimited;
  return (error instanceof TypeError && error.message === "fetch failed") || (error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError"));
}

export interface JiraClient {
  deployment: Deployment;
  site: string;
  /** `/rest/api/3` on Cloud, `/rest/api/2` on Data Center. */
  api: string;
  get<T>(path: string): Promise<T>;
  post<T>(path: string, body: unknown): Promise<T>;
  put<T>(path: string, body: unknown): Promise<T>;
  delete<T>(path: string): Promise<T>;
  /**
   * All results of a JQL search with the given fields. Cloud: `POST /rest/api/3/search/jql` with `nextPageToken` (unconfirmed:
   * the response's `nextPageToken` and `isLast`). Data Center: `GET /rest/api/2/search` with `startAt` and `total`.
   */
  search<T>(jql: string, fields: string[]): Promise<T[]>;
  /** A list paged by `startAt`, `maxResults` and `total`, the array under `key` (comments: `comments`). */
  paged<T>(path: string, key: string): Promise<T[]>;
  stats(): { sent: number; retried: number };
}

const PAGE = 100;

/** Jira's error body: `{ errorMessages: [...], errors: { field: message } }`, read into one line. */
function errorText(text: string): string {
  try {
    const body = JSON.parse(text) as { errorMessages?: unknown; errors?: unknown; message?: unknown };
    const parts: string[] = [];
    if (Array.isArray(body.errorMessages)) parts.push(...body.errorMessages.filter((entry): entry is string => typeof entry === "string"));
    if (body.errors && typeof body.errors === "object") for (const [field, why] of Object.entries(body.errors)) parts.push(`${field}: ${String(why)}`);
    if (typeof body.message === "string") parts.push(body.message);
    if (parts.length > 0) return parts.join("; ");
  } catch {
    // Not JSON: the text itself.
  }
  return text;
}

export function createJiraClient(config: JiraClientConfig): JiraClient {
  const fetchImpl: FetchLike = config.fetchImpl ?? (globalThis.fetch as FetchLike);
  const site = config.site.replace(/\/+$/, "");
  const api = config.deployment === "cloud" ? "/rest/api/3" : "/rest/api/2";
  const now = config.now ?? Date.now;
  const sleep = config.sleep ?? ((ms: number) => new Promise<void>((done) => setTimeout(done, ms)));
  const maxRetryWaitMs = config.maxRetryWaitMs ?? 30_000;
  const maxTries = config.maxTries ?? 4;
  if (config.deployment === "cloud" && !config.email) throw new Error("Jira Cloud needs the account's email with the API token (jira.email in this machine's scopesoup.config.json).");
  const authorization = config.deployment === "cloud"
    ? `Basic ${Buffer.from(`${config.email}:${config.token}`).toString("base64")}`
    : `Bearer ${config.token}`;
  const counters = { sent: 0, retried: 0 };
  let blockedUntil = 0;

  async function failure(response: FetchResponse, path: string): Promise<JiraError> {
    let text = "";
    try {
      text = errorText((await response.text()).slice(0, 2000)).slice(0, 400);
    } catch {
      // The status is enough.
    }
    if (response.status === 401) text = `the token was refused (it may have expired, or the email does not match it)${text ? `: ${text}` : ""}`;
    return new JiraError(response.status, path, text, { rateLimited: response.status === 429 });
  }

  async function request<T>(method: "GET" | "POST" | "PUT" | "DELETE", path: string, body?: unknown): Promise<T> {
    const url = `${site}${path}`;
    for (let attempt = 1; ; attempt += 1) {
      if (blockedUntil > now()) throw new JiraError(429, path, `rate limited until ${new Date(blockedUntil).toISOString()}; no request sent`, { rateLimited: true });
      const headers: Record<string, string> = { Accept: "application/json", Authorization: authorization, "User-Agent": "scopesoup" };
      if (body !== undefined) headers["Content-Type"] = "application/json";
      counters.sent += 1;
      const response = await fetchImpl(url, { method, headers, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
      if (response.status === 429) {
        // Retry-After in seconds (Atlassian's rate-limiting page); RateLimit-Reason says which limit, kept in the message.
        const seconds = Number(response.headers.get("retry-after") ?? NaN);
        const wait = Number.isFinite(seconds) && seconds >= 0 ? seconds * 1000 : 5000 * 2 ** (attempt - 1);
        if (attempt < maxTries && wait <= maxRetryWaitMs) {
          counters.retried += 1;
          // A little jitter, so several waiting requests do not all come back in the same instant.
          await sleep(wait + Math.floor(Math.random() * 250));
          continue;
        }
        blockedUntil = now() + wait;
        const error = await failure(response, path);
        const reason = response.headers.get("ratelimit-reason");
        if (reason) error.message += ` (${reason})`;
        throw error;
      }
      if (response.status < 200 || response.status >= 300) throw await failure(response, path);
      if (response.status === 204) return null as T;
      // Some writes answer 200 or 201 with no body (a property PUT, an issue link POST).
      const text = await response.text();
      return (text.trim() === "" ? null : JSON.parse(text)) as T;
    }
  }

  return {
    deployment: config.deployment,
    site,
    api,
    get: (path) => request("GET", path),
    post: (path, body) => request("POST", path, body),
    put: (path, body) => request("PUT", path, body),
    delete: (path) => request("DELETE", path),

    async search<T>(jql: string, fields: string[]): Promise<T[]> {
      const found: T[] = [];
      if (config.deployment === "cloud") {
        // The old `/rest/api/3/search` was removed on Cloud; `/search/jql` pages by token (unconfirmed shape, research section 1).
        let token: string | undefined;
        for (;;) {
          const page = await request<{ issues?: T[]; nextPageToken?: string; isLast?: boolean }>("POST", `${api}/search/jql`, { jql, fields, maxResults: PAGE, ...(token ? { nextPageToken: token } : {}) });
          found.push(...(page.issues ?? []));
          if (!page.nextPageToken || page.isLast === true || (page.issues ?? []).length === 0) return found;
          token = page.nextPageToken;
        }
      }
      for (;;) {
        const query = `jql=${encodeURIComponent(jql)}&startAt=${found.length}&maxResults=${PAGE}&fields=${encodeURIComponent(fields.join(","))}`;
        const page = await request<{ issues?: T[]; total?: number }>("GET", `${api}/search?${query}`);
        const issues = page.issues ?? [];
        found.push(...issues);
        if (issues.length === 0 || found.length >= (page.total ?? 0)) return found;
      }
    },

    async paged<T>(path: string, key: string): Promise<T[]> {
      const found: T[] = [];
      const join = path.includes("?") ? "&" : "?";
      for (;;) {
        const page = await request<Record<string, unknown>>("GET", `${path}${join}startAt=${found.length}&maxResults=${PAGE}`);
        const items = Array.isArray(page[key]) ? (page[key] as T[]) : [];
        found.push(...items);
        const total = typeof page.total === "number" ? page.total : found.length;
        if (items.length === 0 || found.length >= total) return found;
      }
    },

    stats: () => ({ ...counters }),
  };
}
