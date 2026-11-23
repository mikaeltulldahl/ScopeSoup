// A literal control character in a source file (a NUL inside a string, say) makes git treat the
// file as binary, so a review sees no diff. Write such a character as an escape instead.

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function sourceFiles(dir: string): string[] {
  let found: string[] = [];
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return found;
  }
  for (const entry of entries) {
    if (entry === "node_modules") continue;
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) found = found.concat(sourceFiles(path));
    else found.push(path);
  }
  return found;
}

/** One problem per line that holds a control character other than tab, newline or carriage return. */
function controlCharProblems(dirs: string[], base: string): string[] {
  const problems: string[] = [];
  for (const dir of dirs) {
    for (const file of sourceFiles(dir)) {
      const lines = readFileSync(file, "utf8").split("\n");
      lines.forEach((line, index) => {
        const match = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.exec(line);
        if (match === null) return;
        const code = (match[0].codePointAt(0) ?? 0).toString(16).padStart(4, "0");
        problems.push(`${relative(base, file)}:${index + 1} holds the control character U+${code}; write it as an escape`);
      });
    }
  }
  return problems;
}

test("no file under src/ or web/src/ holds a control character", () => {
  assert.deepEqual(controlCharProblems([join(root, "src"), join(root, "web", "src")], root), []);
});

test("the check names the file and line of a NUL, and lets tab, newline and carriage return through", () => {
  const dir = mkdtempSync(join(tmpdir(), "scopesoup-ctrl-"));
  try {
    mkdirSync(join(dir, "sub"));
    writeFileSync(join(dir, "ok.ts"), "a\tb\r\nc\n");
    writeFileSync(join(dir, "sub", "bad.ts"), 'const a = 1;\nfile.includes("\u0000");\n');
    const problems = controlCharProblems([dir], dir);
    assert.equal(problems.length, 1);
    assert.match(problems[0] ?? "", /^sub[\\/]bad\.ts:2 /);
    assert.match(problems[0] ?? "", /U\+0000/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
