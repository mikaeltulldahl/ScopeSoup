// The update check: the newest GitHub release of Scope Soup's own repository. Read only; nothing is downloaded here.

import { parseVersion } from "./version.ts";

export const DEFAULT_REPO = "mikaeltulldahl/scopesoup";
export const API = "https://api.github.com";

export interface ReleaseAsset {
  name: string;
  /** The API address of the asset: downloaded with `Accept: application/octet-stream`, which also works for a private repository. */
  url: string;
  size: number;
  /** The SHA-256 GitHub reports for the asset (lower-case hex), when it does. */
  sha256?: string;
}

export interface Release {
  version: string;
  tag: string;
  /** The release's notes, as written (Markdown). */
  notes: string;
  /** The release's page. */
  page: string;
  publishedAt: string;
  /** `scopesoup-<version>.zip`, the folder `pnpm release` makes. */
  zip: ReleaseAsset | null;
  /** `scopesoup-<version>.zip.sha256`, written by `pnpm release`, when it is attached. */
  checksum: ReleaseAsset | null;
}

export interface ReleasesDeps {
  fetch: typeof fetch;
  repo: string;
  /** For a private repository: from the environment (SCOPESOUP_UPDATE_TOKEN), never from a file. */
  token?: string | undefined;
  api?: string;
}

export function headers(token: string | undefined, accept = "application/vnd.github+json"): Record<string, string> {
  return { Accept: accept, "User-Agent": "scopesoup", "X-GitHub-Api-Version": "2022-11-28", ...(token ? { Authorization: `Bearer ${token}` } : {}) };
}

interface RawAsset {
  name?: unknown;
  url?: unknown;
  size?: unknown;
  digest?: unknown;
}

function asset(raw: RawAsset | undefined): ReleaseAsset | null {
  if (!raw || typeof raw.name !== "string" || typeof raw.url !== "string" || typeof raw.size !== "number") return null;
  const digest = typeof raw.digest === "string" ? /^sha256:([0-9a-f]{64})$/i.exec(raw.digest)?.[1]?.toLowerCase() : undefined;
  return { name: raw.name, url: raw.url, size: raw.size, ...(digest ? { sha256: digest } : {}) };
}

/** Reads one release of the API's shape; null when it is not a full release of a version (a draft, a pre-release, another tag). */
export function readRelease(raw: unknown): Release | null {
  if (typeof raw !== "object" || raw === null) return null;
  const r = raw as Record<string, unknown>;
  if (r.draft === true || r.prerelease === true || typeof r.tag_name !== "string") return null;
  const parsed = parseVersion(r.tag_name);
  if (!parsed) return null;
  const version = parsed.join(".");
  const assets = Array.isArray(r.assets) ? (r.assets as RawAsset[]) : [];
  const zipName = `scopesoup-${version}.zip`;
  return {
    version,
    tag: r.tag_name,
    notes: typeof r.body === "string" ? r.body : "",
    page: typeof r.html_url === "string" ? r.html_url : "",
    publishedAt: typeof r.published_at === "string" ? r.published_at : "",
    zip: asset(assets.find((each) => each.name === zipName)),
    checksum: asset(assets.find((each) => each.name === `${zipName}.sha256`)),
  };
}

/** The newest release, or null when the repository has none. Throws with a plain reason when GitHub cannot be asked. */
export async function latestRelease(deps: ReleasesDeps): Promise<Release | null> {
  const response = await deps.fetch(`${deps.api ?? API}/repos/${deps.repo}/releases/latest`, { headers: headers(deps.token), signal: AbortSignal.timeout(20_000) });
  if (response.status === 404) {
    await response.body?.cancel();
    return null;
  }
  if (!response.ok) {
    await response.body?.cancel();
    const hint = response.status === 401 || response.status === 403 ? " (for a private repository, set SCOPESOUP_UPDATE_TOKEN to a token that can read it)" : "";
    throw new Error(`GitHub answered ${response.status} for the releases of ${deps.repo}${hint}`);
  }
  return readRelease(await response.json());
}

/** Downloads an asset whole. Throws when GitHub refuses or the size is not the one it reported. */
export async function downloadAsset(deps: ReleasesDeps, item: ReleaseAsset): Promise<Uint8Array> {
  const response = await deps.fetch(item.url, { headers: headers(deps.token, "application/octet-stream"), redirect: "follow", signal: AbortSignal.timeout(10 * 60_000) });
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(`GitHub answered ${response.status} for ${item.name}`);
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.length !== item.size) throw new Error(`${item.name} is ${bytes.length} bytes, and GitHub said ${item.size}: not kept.`);
  return bytes;
}
