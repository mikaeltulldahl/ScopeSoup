import assert from "node:assert/strict";
import { test } from "node:test";
import { inertFile, inertText } from "./hostText.ts";

const Z = "\u200b";

test("every closing keyword is broken, in any case", () => {
  for (const word of ["close", "closes", "closed", "fix", "fixes", "fixed", "resolve", "resolves", "resolved", "CLOSES", "Fixes", "rEsOlVeD"]) {
    const out = inertText(`${word} #3`);
    assert.equal(out, `${word[0]}${Z}${word.slice(1)} #3`);
    assert.doesNotMatch(out, /\b(close[sd]?|fix(e[sd])?|resolve[sd]?)\s+#/i);
  }
});

test("keywords before every reference form are broken", () => {
  const out = inertText("closes owner/other#9, resolves https://github.com/o/r/issues/9, Fixes: #3");
  assert.doesNotMatch(out, /\b(closes|resolves|fixes)\b/i);
  assert.equal(out.replaceAll(Z, ""), "closes owner/other#9, resolves https://github.com/o/r/issues/9, Fixes: #3");
});

test("words that only contain a keyword are left alone", () => {
  assert.equal(inertText("prefix fixture closet disclose unresolved"), "prefix fixture closet disclose unresolved");
});

test("mentions are broken, also in an email-like text", () => {
  assert.equal(inertText("thanks @someone"), `thanks @${Z}someone`);
  assert.equal(inertText("a@b.se"), `a@${Z}b.se`);
  assert.equal(inertText("@9lives and @ alone"), `@${Z}9lives and @ alone`);
});

test("text without keywords or mentions is returned unchanged", () => {
  const text = "Caches per harbour.\n\n- one `thing` (see #4)";
  assert.equal(inertText(text), text);
});

test("a file name loses its backticks and its mentions", () => {
  assert.equal(inertFile("src/`x`.ts"), "src/x.ts");
  assert.equal(inertFile("@scope/pkg"), `@${Z}scope/pkg`);
});

test("no image reaches a host: an attached one is named, any other becomes its alt text and address in words", () => {
  const out = inertText([
    "Attached: ![the header, before](media/head-before.png) ![](media/x.svg)",
    "Inline: ![a cat](https://example.com/cat.png) and ![titled](<https://example.com/t.png> \"Title\")",
    "Reference: ![logo][brand] and ![collapsed][] and a shortcut ![brand]",
    "HTML: <img src=\"https://tracker.example/pixel.gif\" alt=\"pixel\"> <IMG SRC=x>",
    "",
    "[brand]: https://example.com/logo.png",
  ].join("\n"));
  assert.match(out, /\(the header, before: image on the board\) \(image on the board\)/);
  assert.match(out, /a cat \(image: https:\/\/example\.com\/cat\.png\)/);
  assert.match(out, /titled \(image: https:\/\/example\.com\/t\.png\)/);
  assert.match(out, /logo \(image: brand\) and collapsed \(image: collapsed\)/);
  assert.match(out, /pixel \(image: https:\/\/tracker\.example\/pixel\.gif\) \(image: x\)/);
  // Nothing a host would draw as a picture is left.
  assert.doesNotMatch(out, /!\[|<img|media\//i);
});
