import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const CSS = readFileSync(resolve(ROOT, "web", "src", "styles.css"), "utf8");

function rule(selector: string): string {
  const at = CSS.indexOf(`${selector} {`);
  assert.notEqual(at, -1, `no rule for ${selector}`);
  return CSS.slice(at, CSS.indexOf("}", at));
}

test("a card's plan number and its dot stay on one line, beside the first line of the title", () => {
  const num = rule(".card-head > .num");
  assert.match(num, /white-space:\s*nowrap/);
  assert.match(num, /flex:\s*none/);
  assert.match(rule(".card-head"), /align-items:\s*baseline/);
});
