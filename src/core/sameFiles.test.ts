import assert from "node:assert/strict";
import { test } from "node:test";
import type { Ref } from "../model/types.ts";
import { conflictQuestion, GO_ON_WITH_BOTH } from "./answerReuse.ts";
import { mayConflictWith, pathsOverlap, sameFilesAs, sameFilesWords } from "./sameFiles.ts";

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

test("an Item may conflict with a busy Item a conflictsWith link names, either way, until a person says to go on with both", () => {
  const busy = [
    { item: ref("5"), paths: [] },
    { item: ref("6"), paths: [], links: [{ type: "conflictsWith" as const, item: "#8" }] },
    { item: ref("7"), paths: [], links: [{ type: "related" as const, item: "8" }] },
  ];
  const candidate = { item: ref("8"), paths: [], links: [{ type: "conflictsWith" as const, item: "fake:work:5" }, { type: "related" as const, item: "#7" }] };
  assert.deepEqual(mayConflictWith(candidate, busy, []), [ref("5"), ref("6")]);
  const answers = [{ subject: ref("6"), question: conflictQuestion("6", "8", "Six"), answer: GO_ON_WITH_BOTH, by: "Ada", at: "2026-11-01T00:00:00Z" }];
  assert.deepEqual(mayConflictWith(candidate, busy, answers), [ref("5")]);
  assert.equal(sameFilesWords([], [ref("5")]), "waits for #5, which may conflict with it");
  assert.equal(sameFilesWords([ref("A-5")], [ref("6"), ref("7")]), "waits for A-5, which changes the same files, and #6 and #7, which may conflict with it");
});
