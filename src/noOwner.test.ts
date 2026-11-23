// There is no owner in Scope Soup; people are equals. The word is gone from the board, the prompts and Scope Soup's own texts.
// What stays is GitHub's: a repository's owner (`owner/name`, `/repos/{owner}/...`) and the `OWNER` author association.

import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function files(dir: string, keep: (name: string) => boolean): string[] {
  const found: string[] = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) {
      if (name !== "node_modules" && name !== "dist" && name !== "fixtures") found.push(...files(path, keep));
    } else if (keep(name)) found.push(path);
  }
  return found;
}

function hits(paths: readonly string[], allowed: readonly RegExp[] = []): string[] {
  return paths.flatMap((path) =>
    readFileSync(path, "utf8")
      .split("\n")
      .map((line, index) => ({ line, at: `${relative(root, path)}:${index + 1}` }))
      .filter(({ line }) => /owner/i.test(line) && !allowed.some((pattern) => pattern.test(line)))
      .map(({ line, at }) => `${at}: ${line.trim()}`),
  );
}

test("the board's code and the prompts never say owner", () => {
  assert.deepEqual(hits(files(join(root, "web", "src"), () => true)), []);
  assert.deepEqual(hits(files(join(root, "prompts"), (name) => name.endsWith(".md"))), []);
});

test("Scope Soup's own texts never say owner; GitHub's repository owner stays", () => {
  const github = [
    /owner\/name/i, /\{owner\}/, /\$\{owner\}/, /const owner = (config\.repo|repo)\.split/, /"OWNER"|OWNER,/, /an owner, member or collaborator/, /from owners, members and collaborators/,
    // Not the word: a clone's owners (workspaces) and the id that owns a path (the writer).
    /\bowners\b|const owner = itemPath|\(owner\)|owner === undefined/,
  ];
  assert.deepEqual(hits(files(join(root, "src"), (name) => name.endsWith(".ts") && !name.endsWith(".test.ts")), github), []);
});
