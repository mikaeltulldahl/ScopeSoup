// The board's side of agents' images: `GET /media/<item>/<name>` as an image and nothing else, the Item page's list and who
// sees them, and the delete with who pressed it. Over a fake media store: no git, no files.

import assert from "node:assert/strict";
import { test } from "node:test";
import { work } from "../core/testing.ts";
import type { ItemPage } from "../core/views.ts";
import type { Media } from "../orchestrator/media.ts";
import { openStore } from "../store/store.ts";
import { createServer } from "./server.ts";

const PNG = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex");

test("an image is served with its fixed type, nosniff and a strict policy; the page lists them; a delete names who", async () => {
  const store = openStore(":memory:");
  const item = work(5);
  store.put(item, "test", "2026-11-25T10:00:00.000Z");
  const names = new Set(["shot.png"]);
  const removed: string[] = [];
  const media: Pick<Media, "list" | "read" | "remove" | "pushing"> = {
    list: async () => [...names],
    read: async (ref, name) => (ref.id === "5" && names.has(name) ? { bytes: PNG, type: "image/png" } : null),
    remove: async (_ref, name, by) => {
      removed.push(`${name} by ${by}`);
      return { removed: names.delete(name), ref: "none" };
    },
    pushing: () => false,
  };
  const server = createServer({ store, port: 0, media });
  const { url } = await server.start();
  try {
    const key = encodeURIComponent("demo:work:5");
    const image = await fetch(`${url}/media/${key}/shot.png`);
    assert.equal(image.status, 200);
    assert.equal(image.headers.get("content-type"), "image/png");
    assert.equal(image.headers.get("x-content-type-options"), "nosniff");
    assert.match(image.headers.get("content-security-policy") ?? "", /default-src 'none'.*sandbox/);
    assert.ok(Buffer.from(await image.arrayBuffer()).equals(PNG));
    for (const path of [`/media/${key}/other.png`, `/media/${encodeURIComponent("demo:work:9")}/shot.png`, `/media/${key}/a/shot.png`, `/media/%E0%A4%A/shot.png`]) {
      assert.equal((await fetch(`${url}${path}`)).status, 404, path);
    }

    const page = (await (await fetch(`${url}/api/item?ref=${key}`)).json()) as ItemPage;
    assert.deepEqual(page.media, { names: ["shot.png"], shared: false });

    const post = (headers: Record<string, string>) => fetch(`${url}/api/item/media/delete`, { method: "POST", headers: { Origin: url, "Content-Type": "application/json", ...headers }, body: JSON.stringify({ ref: "demo:work:5", name: "shot.png" }) });
    assert.equal((await post({})).status, 400);
    assert.equal((await post({ Origin: "http://evil.example", "X-ScopeSoup-Person": "mira" })).status, 403);
    assert.equal((await post({ "X-ScopeSoup-Person": "mira" })).status, 200);
    assert.deepEqual(removed, ["shot.png by mira"]);
    assert.equal((await post({ "X-ScopeSoup-Person": "mira" })).status, 404);
    const after = (await (await fetch(`${url}/api/item?ref=${key}`)).json()) as ItemPage;
    assert.equal(after.media, undefined);
  } finally {
    await server.stop();
    store.close();
  }
});

test("the demo's images are real PNGs that pass the same checks", async () => {
  const { demoImages } = await import("./demoMedia.ts");
  const { mediaType } = await import("../core/media.ts");
  const images = demoImages().get("demo:work:66")!;
  assert.equal(images.size, 4);
  for (const [name, bytes] of images) assert.equal(mediaType(name, bytes), "image/png", name);
});
