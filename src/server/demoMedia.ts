// The demo's images: small synthetic pictures of a made-up app, drawn in code and encoded as PNG here, so no image file is
// committed and nothing comes from a real screen. Item 66's implementor attaches a before and after of its row, and asks a
// question with a picture of each option. Kept in memory; Delete takes one out and records it, as the real one does.

import { crc32, deflateSync } from "node:zlib";
import type { Media } from "../orchestrator/media.ts";
import type { Store } from "../store/store.ts";
import { mediaType } from "../core/media.ts";
import { refKey } from "../model/types.ts";

type Rgb = [number, number, number];

/** A picture to draw on: width × height pixels of RGB. */
function canvas(width: number, height: number, background: Rgb) {
  const pixels = Buffer.alloc(width * height * 3);
  const rect = (x: number, y: number, w: number, h: number, color: Rgb) => {
    for (let row = Math.max(0, y); row < Math.min(height, y + h); row++) {
      for (let col = Math.max(0, x); col < Math.min(width, x + w); col++) pixels.set(color, (row * width + col) * 3);
    }
  };
  rect(0, 0, width, height, background);
  return { width, height, pixels, rect };
}

function chunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "latin1"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body) >>> 0);
  return Buffer.concat([length, body, crc]);
}

/** The picture as a PNG file: 8-bit RGB, no filter. */
export function png({ width, height, pixels }: { width: number; height: number; pixels: Buffer }): Buffer {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.set([8, 2, 0, 0, 0], 8);
  const raw = Buffer.alloc((width * 3 + 1) * height);
  for (let row = 0; row < height; row++) pixels.copy(raw, row * (width * 3 + 1) + 1, row * width * 3, (row + 1) * width * 3);
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", header), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}

const PAGE: Rgb = [246, 248, 250];
const INK: Rgb = [60, 72, 88];
const FAINT: Rgb = [196, 204, 214];
const SEA: Rgb = [46, 125, 190];
const SUN: Rgb = [240, 170, 40];
const WRONG: Rgb = [214, 64, 64];

/**
 * A day list of a tide app: one row per day with a bar for its tides and a sun row under it. `polar` is how the polar day's
 * missing sunset shows: "zero" (a wrong 00:00, in red), "none" (left out) or "dash".
 */
function dayList(polar: "zero" | "none" | "dash"): Buffer {
  const c = canvas(240, 150, PAGE);
  c.rect(0, 0, 240, 22, SEA);
  c.rect(10, 8, 70, 6, [255, 255, 255]);
  for (let day = 0; day < 3; day++) {
    const y = 32 + day * 38;
    c.rect(10, y, 40, 6, INK);
    c.rect(60, y, 120 - day * 20, 6, SEA);
    // The sun row: sunrise always, the sunset as the case shows it.
    c.rect(20, y + 14, 8, 8, SUN);
    c.rect(32, y + 16, 34, 4, FAINT);
    const isPolar = day === 1;
    if (!isPolar) {
      c.rect(90, y + 14, 8, 8, SUN);
      c.rect(102, y + 16, 34, 4, FAINT);
    } else if (polar === "zero") {
      c.rect(90, y + 14, 8, 8, WRONG);
      c.rect(102, y + 14, 34, 8, WRONG);
    } else if (polar === "dash") {
      c.rect(102, y + 17, 14, 2, INK);
    }
    c.rect(10, y + 30, 220, 1, FAINT);
  }
  return png(c);
}

/** The demo's images, by Item key and name. */
export function demoImages(): Map<string, Map<string, Buffer>> {
  return new Map([["demo:work:66", new Map([
    ["polar-before.png", dayList("zero")],
    ["polar-after.png", dayList("none")],
    ["polar-none.png", dayList("none")],
    ["polar-dash.png", dayList("dash")],
  ])]]);
}

/** The board's media for the demo: the images above, in memory. A delete is recorded as the real one records it. */
export function demoMedia(store: Store): Pick<Media, "list" | "read" | "remove" | "pushing"> {
  const images = demoImages();
  return {
    list: async (item) => [...(images.get(refKey(item))?.keys() ?? [])].sort(),
    read: async (item, name) => {
      const bytes = images.get(refKey(item))?.get(name);
      const type = bytes ? mediaType(name, bytes) : null;
      return bytes && type ? { bytes, type } : null;
    },
    remove: async (item, name, by) => {
      const removed = images.get(refKey(item))?.delete(name) ?? false;
      if (removed) store.appendEvent({ kind: "media.deleted", subject: refKey(item), actor: "scopesoup", data: { name, by, ref: "none", reason: `${by} deleted the image ${name}.` } }, new Date().toISOString());
      return { removed, ref: "none" };
    },
    pushing: () => false,
  };
}
