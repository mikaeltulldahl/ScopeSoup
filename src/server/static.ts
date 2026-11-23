// Serves the built web app: files from one directory, with index.html for any other page URL.

import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import type { ServerResponse } from "node:http";
import { extname, join, normalize, resolve, sep } from "node:path";

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".txt": "text/plain; charset=utf-8",
};

export function contentType(path: string): string {
  return TYPES[extname(path).toLowerCase()] ?? "application/octet-stream";
}

async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

/** Resolves a URL path to a file inside `root`. Null when it would leave the directory. */
export function resolveInside(root: string, urlPath: string): string | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(urlPath);
  } catch {
    return null;
  }
  if (decoded.includes("\0")) return null;
  const base = resolve(root);
  const full = resolve(join(base, normalize(decoded)));
  return full === base || full.startsWith(base + sep) ? full : null;
}

/** Sends the file for `urlPath`, or index.html for a page URL. Returns false when there is nothing to send. */
export async function serveStatic(root: string, urlPath: string, response: ServerResponse, headOnly: boolean): Promise<boolean> {
  const wanted = resolveInside(root, urlPath);
  if (wanted === null) return false;
  let file = wanted;
  if (!(await isFile(file))) {
    // A missing asset is a 404; any other path is a page of the app.
    if (extname(urlPath) !== "") return false;
    file = join(resolve(root), "index.html");
    if (!(await isFile(file))) return false;
  }
  const hashed = /[\\/]assets[\\/]/.test(file);
  response.writeHead(200, {
    "Content-Type": contentType(file),
    "Cache-Control": hashed ? "public, max-age=31536000, immutable" : "no-cache",
    "X-Content-Type-Options": "nosniff",
  });
  if (headOnly) {
    response.end();
    return true;
  }
  await new Promise<void>((done) => {
    const stream = createReadStream(file);
    stream.on("error", () => {
      response.destroy();
      done();
    });
    stream.on("end", done);
    stream.pipe(response);
  });
  return true;
}
