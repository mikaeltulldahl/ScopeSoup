// The HTTP side of the GitHub adapter: headers, ETag conditional requests, pagination and the
// rate-limit budget. Nothing here knows the model.

export interface FetchResponse {
  status: number;
  headers: { get(name: string): string | null };
  json(): Promise<unknown>;
  text(): Promise<string>;
}

/** `redirect: "manual"` lets a 301 (a transferred issue) through as an answer instead of following it. */
export type FetchLike = (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string; redirect?: "manual" }) => Promise<FetchResponse>;

export interface ClientConfig {
  token: string;
  /** "owner/name". */
  repo: string;
  fetchImpl?: FetchLike;
  apiUrl?: string;
  apiVersion?: string;
  /** Milliseconds since the epoch. */
  now?: () => number;
  /** How many responses are kept for conditional requests. */
  cacheSize?: number;
}

export class GitHubError extends Error {
  status: number;
  path: string;
  /** A 403 or 429 that is a rate limit (primary or secondary), or a request not sent because one is still waited out. */
  rateLimited: boolean;
  /** Where a 301 points (a transferred issue). */
  location?: string;
  constructor(status: number, path: string, message: string, more: { rateLimited?: boolean; location?: string } = {}) {
    super(`GitHub ${status} on ${path}: ${message}`);
    this.name = "GitHubError";
    this.status = status;
    this.path = path;
    this.rateLimited = more.rateLimited === true;
    if (more.location) this.location = more.location;
  }
}

/**
 * A failure that can change by itself: GitHub down or overloaded (5xx), a rate limit, or no answer at all (offline, a dropped
 * connection). A refusal (a 403 for missing rights, a 404, a 422) is not.
 */
export function transient(error: unknown): boolean {
  if (error instanceof GitHubError) return error.status >= 500 || error.status === 429 || error.rateLimited;
  // `fetch` itself failed: Node says "fetch failed", with the network error as the cause.
  return (error instanceof TypeError && error.message === "fetch failed") || (error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError"));
}

export interface Got<T> {
  data: T;
  /** True when every request behind it was answered 304. */
  unchanged: boolean;
}

export interface GetOptions {
  /** A 301 is an answer (a `GitHubError` with its `location`), not followed. */
  noRedirect?: boolean;
}

export interface ListOptions extends GetOptions {
  /** The property that holds the array, for wrapped lists (`workflow_runs`, `check_runs`, `jobs`). */
  key?: string;
  /** Stop paging once this many items are read. */
  max?: number;
}

export interface Budget {
  remaining: number;
  resetAt: string;
}

export interface Client {
  repo: string;
  /** `/repos/{owner}/{name}` + path. */
  repoPath(path: string): string;
  get<T>(path: string, options?: GetOptions): Promise<Got<T>>;
  /** Follows `Link: rel="next"`. */
  list<T>(path: string, options?: ListOptions): Promise<Got<T[]>>;
  /** A GET whose answer is plain text (a job's log), redirects followed. Never cached. */
  text(path: string): Promise<string>;
  /** A write: POST, PATCH, PUT or DELETE with a JSON body. Never cached. Returns the parsed answer, or null when there is none. */
  send<T>(method: "POST" | "PATCH" | "PUT" | "DELETE", path: string, body?: unknown): Promise<T | null>;
  /** The budget the last response reported, or null before any response. */
  budget(): Budget | null;
  /** Counts for tests and the status line: requests sent, and how many of them were free 304s. */
  stats(): { sent: number; notModified: number };
}

interface Cached {
  etag: string;
  body: unknown;
  next: string | null;
}

export const DEFAULT_API_VERSION = "2022-11-28";

function nextLink(header: string | null): string | null {
  if (!header) return null;
  for (const part of header.split(",")) {
    const match = /<([^>]+)>\s*;\s*rel="next"/.exec(part);
    if (match?.[1]) return match[1];
  }
  return null;
}

export function createClient(config: ClientConfig): Client {
  const fetchImpl: FetchLike = config.fetchImpl ?? (globalThis.fetch as FetchLike);
  const base = (config.apiUrl ?? "https://api.github.com").replace(/\/+$/, "");
  const now = config.now ?? Date.now;
  const cacheSize = config.cacheSize ?? 2000;
  const cache = new Map<string, Cached>();
  const counters = { sent: 0, notModified: 0 };
  let budget: Budget | null = null;
  let blockedUntil = 0;

  function noteBudget(response: FetchResponse): void {
    const remaining = Number(response.headers.get("x-ratelimit-remaining") ?? NaN);
    const reset = Number(response.headers.get("x-ratelimit-reset") ?? NaN);
    if (Number.isFinite(remaining) && Number.isFinite(reset)) {
      budget = { remaining, resetAt: new Date(reset * 1000).toISOString() };
    }
  }

  /**
   * A 403 or 429 that is a rate limit holds every request until it is over: `retry-after`, else the reset of a used-up
   * budget, else a minute (GitHub's advice for a secondary limit that names no time). A 403 for missing rights holds nothing.
   */
  function noteLimit(response: FetchResponse, text: string): boolean {
    if (response.status !== 403 && response.status !== 429) return false;
    const retryAfter = Number(response.headers.get("retry-after") ?? NaN);
    const remaining = Number(response.headers.get("x-ratelimit-remaining") ?? NaN);
    const reset = Number(response.headers.get("x-ratelimit-reset") ?? NaN);
    if (Number.isFinite(retryAfter)) blockedUntil = now() + retryAfter * 1000;
    else if (remaining === 0 && Number.isFinite(reset)) blockedUntil = reset * 1000;
    else if (response.status === 429 || /rate limit/i.test(text)) blockedUntil = now() + 60_000;
    else return false;
    return true;
  }

  /** The error for an answer that is not 2xx (nor a 304 with something cached). */
  async function failure(response: FetchResponse, path: string, chars: number): Promise<GitHubError> {
    let text = "";
    try {
      text = (await response.text()).slice(0, chars);
    } catch {
      // The status is enough.
    }
    const location = response.headers.get("location");
    return new GitHubError(response.status, path, text, { rateLimited: noteLimit(response, text), ...(location ? { location } : {}) });
  }

  const blocked = (path: string): GitHubError =>
    new GitHubError(429, path, `rate limited until ${new Date(blockedUntil).toISOString()}; no request sent`, { rateLimited: true });

  async function request(url: string, options: GetOptions = {}): Promise<{ body: unknown; next: string | null; unchanged: boolean }> {
    if (blockedUntil > now()) throw blocked(url);
    const cached = cache.get(url);
    const headers: Record<string, string> = {
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": config.apiVersion ?? DEFAULT_API_VERSION,
      Authorization: `Bearer ${config.token}`,
      "User-Agent": "scopesoup",
    };
    if (cached) headers["If-None-Match"] = cached.etag;
    counters.sent += 1;
    const response = await fetchImpl(url, { method: "GET", headers, ...(options.noRedirect ? { redirect: "manual" as const } : {}) });
    noteBudget(response);
    if (response.status === 304 && cached) {
      counters.notModified += 1;
      return { body: cached.body, next: cached.next, unchanged: true };
    }
    if (response.status < 200 || response.status >= 300) throw await failure(response, url.slice(base.length), 300);
    const body = await response.json();
    const next = nextLink(response.headers.get("link"));
    const etag = response.headers.get("etag");
    if (etag) {
      cache.delete(url);
      cache.set(url, { etag, body, next });
      if (cache.size > cacheSize) {
        const oldest = cache.keys().next().value;
        if (oldest !== undefined) cache.delete(oldest);
      }
    }
    return { body, next, unchanged: false };
  }

  const absolute = (path: string): string => (path.startsWith("http") ? path : `${base}${path}`);

  return {
    repo: config.repo,
    repoPath: (path) => `/repos/${config.repo}${path}`,

    async get<T>(path: string, options?: GetOptions): Promise<Got<T>> {
      const result = await request(absolute(path), options);
      return { data: result.body as T, unchanged: result.unchanged };
    },

    async list<T>(path: string, options: ListOptions = {}): Promise<Got<T[]>> {
      const items: T[] = [];
      let unchanged = true;
      let url: string | null = absolute(path);
      while (url !== null && (options.max === undefined || items.length < options.max)) {
        const result: { body: unknown; next: string | null; unchanged: boolean } = await request(url, options);
        const page = options.key ? (result.body as Record<string, unknown> | null)?.[options.key] : result.body;
        if (Array.isArray(page)) items.push(...(page as T[]));
        unchanged = unchanged && result.unchanged;
        url = result.next;
      }
      return { data: options.max === undefined ? items : items.slice(0, options.max), unchanged };
    },

    async text(path: string): Promise<string> {
      const url = absolute(path);
      if (blockedUntil > now()) throw blocked(path);
      counters.sent += 1;
      const response = await fetchImpl(url, {
        method: "GET",
        headers: { Accept: "application/vnd.github+json", "X-GitHub-Api-Version": config.apiVersion ?? DEFAULT_API_VERSION, Authorization: `Bearer ${config.token}`, "User-Agent": "scopesoup" },
      });
      noteBudget(response);
      if (response.status < 200 || response.status >= 300) throw await failure(response, url.slice(base.length), 300);
      return response.text();
    },

    async send<T>(method: "POST" | "PATCH" | "PUT" | "DELETE", path: string, body?: unknown): Promise<T | null> {
      const url = absolute(path);
      if (blockedUntil > now()) throw blocked(path);
      const headers: Record<string, string> = {
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": config.apiVersion ?? DEFAULT_API_VERSION,
        Authorization: `Bearer ${config.token}`,
        "User-Agent": "scopesoup",
      };
      if (body !== undefined) headers["Content-Type"] = "application/json";
      counters.sent += 1;
      const response = await fetchImpl(url, { method, headers, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
      noteBudget(response);
      if (response.status < 200 || response.status >= 300) throw await failure(response, url.slice(base.length), 400);
      if (response.status === 204) return null;
      try {
        return (await response.json()) as T;
      } catch {
        return null;
      }
    },

    budget: () => budget,
    stats: () => ({ ...counters }),
  };
}
