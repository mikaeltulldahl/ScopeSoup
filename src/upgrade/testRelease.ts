// For the tests of the upgrade: synthetic release folders and zips, and a fake GitHub releases API. No network.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { zipFolder } from "../release.ts";
import { sha256 } from "./unpack.ts";
import { RELEASE_FILES } from "./unpack.ts";

/** Makes `<parent>/<name>` look like a release of `version` (the files a release must have, nothing that runs). */
export function fakeReleaseFolder(parent: string, version: string, name = `scopesoup-${version}`): string {
  const folder = join(parent, name);
  for (const file of RELEASE_FILES) {
    mkdirSync(dirname(join(folder, file)), { recursive: true });
    writeFileSync(join(folder, file), file === "package.json" ? JSON.stringify({ name: "scopesoup", version }) : `// ${file} of ${version}\n`);
  }
  return folder;
}

/** A zip of a fake release; returns its path, bytes and SHA-256. */
export function fakeReleaseZip(work: string, version: string, name?: string): { zip: string; bytes: Uint8Array; sha: string } {
  const parent = join(work, `build-${version}-${name ?? "ok"}`);
  mkdirSync(parent, { recursive: true });
  const folder = fakeReleaseFolder(parent, version, name);
  const zip = zipFolder(folder);
  if (!zip) throw new Error("No zip tool on this machine.");
  const bytes = new Uint8Array(readFileSync(zip));
  return { zip, bytes, sha: sha256(bytes) };
}

/** A GitHub API release of `version` whose zip asset is served from `assetUrl`. */
export function apiRelease(version: string, assetUrl: string, size: number, digest?: string): Record<string, unknown> {
  return {
    tag_name: `v${version}`,
    draft: false,
    prerelease: false,
    body: `Notes for ${version}.`,
    html_url: `https://github.example/releases/v${version}`,
    published_at: "2026-11-20T10:00:00Z",
    assets: [{ name: `scopesoup-${version}.zip`, url: assetUrl, size, ...(digest ? { digest: `sha256:${digest}` } : {}) }],
  };
}

/** A fetch that answers from a table of URL to response; records what was asked. Anything else is a 404. */
export function fakeFetch(routes: Record<string, () => Response>, asked: { url: string; headers: Record<string, string> }[] = []): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    asked.push({ url, headers: (init?.headers ?? {}) as Record<string, string> });
    const route = routes[url];
    return route ? route() : new Response("Not Found", { status: 404 });
  }) as typeof fetch;
}
