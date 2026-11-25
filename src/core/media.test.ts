// What counts as an agent's image, the limits, the names in a text, the words a host gets, and when images go.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { hostImageText, MAX_MEDIA_BYTES, MAX_MEDIA_PER_ITEM, mediaExpired, mediaKey, mediaNamesIn, mediaPromptText, mediaRef, mediaType, planMedia } from "./media.ts";
import { settingsWords } from "./settingsWords.ts";

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0]);
const GIF = new TextEncoder().encode("GIF89a....");
const WEBP = new TextEncoder().encode("RIFF\u0000\u0000\u0000\u0000WEBPVP8 ");
const text = (value: string): Uint8Array => new TextEncoder().encode(value);

describe("media", () => {
  it("takes an image only when its name and its first bytes agree", () => {
    assert.equal(mediaType("shot.png", PNG), "image/png");
    assert.equal(mediaType("shot.JPG", JPEG), "image/jpeg");
    assert.equal(mediaType("shot.jpeg", JPEG), "image/jpeg");
    assert.equal(mediaType("anim.gif", GIF), "image/gif");
    assert.equal(mediaType("pic.webp", WEBP), "image/webp");
    assert.equal(mediaType("diagram.svg", text('<?xml version="1.0"?>\n<!-- made by hand -->\n<svg xmlns="http://www.w3.org/2000/svg"></svg>')), "image/svg+xml");
    // A page posing as a picture, a picture under another name, and names that are no image name.
    assert.equal(mediaType("shot.png", text("<html><script>alert(1)</script>")), null);
    assert.equal(mediaType("shot.png", JPEG), null);
    assert.equal(mediaType("diagram.svg", text("<html><svg></svg></html>")), null);
    for (const name of ["shot.html", "../shot.png", ".hidden.png", "a/b.png", "shot", "-x.png", "a..b.png", `${"x".repeat(100)}.png`]) assert.equal(mediaType(name, PNG), null, name);
  });

  it("keeps images within the size and the Item's room; a name used again takes no more room", () => {
    const existing = Array.from({ length: MAX_MEDIA_PER_ITEM - 1 }, (_, index) => `old-${index}.png`);
    const plan = planMedia([
      { name: "b-new.png", size: 100, head: PNG },
      { name: "a-new.png", size: 100, head: PNG },
      { name: "old-3.png", size: 100, head: PNG },
      { name: "huge.png", size: MAX_MEDIA_BYTES + 1, head: PNG },
      { name: "fake.png", size: 10, head: text("hello") },
      { name: "notes.txt", size: 10, head: text("hello") },
    ], existing);
    assert.deepEqual(plan.keep.map((each) => each.name), ["a-new.png", "old-3.png"]);
    assert.deepEqual(plan.refused.map((each) => each.name), ["b-new.png", "fake.png", "huge.png", "notes.txt"]);
    assert.match(plan.refused[0]!.why, /20 images/);
  });

  it("names the ref and the folder safely", () => {
    assert.equal(mediaRef("A-12"), "refs/scopesoup/media/A-12");
    assert.equal(mediaRef("88"), "refs/scopesoup/media/88");
    assert.equal(mediaKey("../x"), "i___x");
    assert.equal(mediaKey("a.b"), "a_b");
  });

  it("finds the images a text refers to, and gives a host words instead", () => {
    const summary = "Changed the header. ![before](media/head-before.png) ![after](media/head-after.png) ![x](media/../etc.png) ![y](https://example.com/y.png)";
    assert.deepEqual(mediaNamesIn(summary), ["head-before.png", "head-after.png"]);
    const host = hostImageText(summary);
    assert.doesNotMatch(host, /media\//);
    assert.match(host, /\(before: image on the board\) \(after: image on the board\)/);
    assert.match(host, /!\[y\]\(https:\/\/example\.com\/y\.png\)/);
  });

  it("deletes a closed Item's images only when the setting says so and the days have passed", () => {
    assert.equal(mediaExpired("2026-11-01T00:00:00Z", null, "2027-11-01T00:00:00Z"), false);
    assert.equal(mediaExpired("2026-11-01T00:00:00Z", 30, "2026-11-30T00:00:00Z"), false);
    assert.equal(mediaExpired("2026-11-01T00:00:00Z", 30, "2026-12-01T00:00:00Z"), true);
    assert.equal(mediaExpired(undefined, 0, "2026-12-01T00:00:00Z"), false);
  });

  it("tells agents where images go and who sees them, both ways", () => {
    assert.match(mediaPromptText(false), /\.scopesoup\/media\/.*this machine only/s);
    assert.match(mediaPromptText(true), /everyone with the repository/);
    assert.match(mediaPromptText(true), /!\[before\]\(media\/x-before\.png\) !\[after\]/);
  });

  it("says a change of the setting in words", () => {
    assert.deepEqual(settingsWords([{ key: "media.push", from: false, to: true }, { key: "media.keepDaysAfterClose", to: 30 }]), ["Images pushed to the remote", "Images deleted 30 days after an Item closes"]);
  });
});
