// Checks the import rule in docs/DESIGN.md: the model, the pure rules, the queue engine and the
// store never import a host or a convention, and the pure parts do no I/O.

import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve, dirname } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const src = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function files(dir: string): string[] {
  let found: string[] = [];
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return found;
  }
  for (const entry of entries) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) found = found.concat(files(path));
    else if (path.endsWith(".ts")) found.push(path);
  }
  return found;
}

function imports(file: string): string[] {
  const text = readFileSync(file, "utf8");
  return [...text.matchAll(/(?:from|import)\s+["']([^"']+)["']/g)].map((match) => match[1] ?? "");
}

/** The top-level directory under src that a relative import merges in. */
function target(file: string, specifier: string): string | null {
  if (!specifier.startsWith(".")) return null;
  return relative(src, resolve(dirname(file), specifier)).split(/[\\/]/)[0] ?? null;
}

const allowed: Record<string, string[]> = {
  model: ["model"],
  ports: ["ports", "model"],
  core: ["core", "model"],
  queue: ["queue", "model"],
  store: ["store", "model"],
  hosts: ["hosts", "ports", "model"],
};

test("directories import only what docs/DESIGN.md allows", () => {
  const problems: string[] = [];
  for (const [dir, may] of Object.entries(allowed)) {
    for (const file of files(join(src, dir))) {
      for (const specifier of imports(file)) {
        const to = target(file, specifier);
        if (to !== null && !may.includes(to)) problems.push(`${relative(src, file)} imports ${specifier}`);
      }
    }
  }
  assert.deepEqual(problems, []);
});

test("the pure parts import no node modules outside tests", () => {
  const problems: string[] = [];
  for (const dir of ["model", "core", "queue"]) {
    for (const file of files(join(src, dir))) {
      if (file.endsWith(".test.ts")) continue;
      for (const specifier of imports(file)) {
        if (specifier.startsWith("node:")) problems.push(`${relative(src, file)} imports ${specifier}`);
      }
    }
  }
  assert.deepEqual(problems, []);
});
