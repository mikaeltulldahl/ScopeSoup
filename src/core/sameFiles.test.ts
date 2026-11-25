import assert from "node:assert/strict";
import { test } from "node:test";
import type { Ref } from "../model/types.ts";
import { pathsOverlap, sameFilesAs, sameFilesWords } from "./sameFiles.ts";

const ref = (id: string): Ref => ({ host: "fake", kind: "work", id });

test("named paths overlap on the same file, or one inside the other's folder; a glob counts as its folder", () => {
  assert.ok(pathsOverlap(["src/a.ts"], ["./src/a.ts"]));
  assert.ok(pathsOverlap(["src\\core\\a.ts"], ["src/core/"]));
  assert.ok(pathsOverlap(["src/core"], ["src/core/deep/b.ts"]));
  assert.ok(pathsOverlap(["src/core/*.test.ts"], ["src/core/a.ts"]));
  assert.ok(!pathsOverlap(["src/core/a.ts"], ["src/core/b.ts"]), "files side by side do not overlap");
  assert.ok(!pathsOverlap(["src/core"], ["src/corex/a.ts"]));
  assert.ok(!pathsOverlap(["**/*.ts", "*.md", " "], ["src/a.ts", "README.md"]), "a glob at the root names no place");
  assert.ok(!pathsOverlap([], ["src/a.ts"]));
});

test("an Item waits for each busy Item whose paths overlap, never for itself; the card names them", () => {
  const busy = [{ item: ref("A-5"), paths: ["src/a.ts"] }, { item: ref("6"), paths: ["src"] }, { item: ref("7"), paths: ["web"] }];
  assert.deepEqual(sameFilesAs({ item: ref("8"), paths: ["src/a.ts"] }, busy), [ref("A-5"), ref("6")]);
  assert.deepEqual(sameFilesAs({ item: ref("A-5"), paths: ["src/a.ts"] }, busy), [ref("6")]);
  assert.deepEqual(sameFilesAs({ item: ref("9"), paths: [] }, busy), []);
  assert.equal(sameFilesWords([ref("A-5")]), "waits for A-5, which changes the same files");
  assert.equal(sameFilesWords([ref("A-5"), ref("6"), ref("7")]), "waits for A-5, #6 and #7, which change the same files");
});
