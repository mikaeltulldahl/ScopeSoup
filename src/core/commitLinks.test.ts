import assert from "node:assert/strict";
import { test } from "node:test";
import { commitLinks, linkCommit } from "./commitLinks.ts";
import { work } from "./testing.ts";

const branch = (item: { ref: { id: string } }) => `scopesoup/${item.ref.id}`;
const links = commitLinks(
  [
    work(12, { state: "done", log: [{ at: "2026-03-01T10:00:00Z", by: { who: "scopesoup", agent: true }, kind: "merged", fields: { sha: "aaaa1111", target: "main" } }] }),
    work(58, { state: "doing" }),
    work(91, { state: "done" }),
    work(7, { state: "todo", merged: { sha: "cccc3333", target: "main", at: "2026-03-01T10:00:00Z" } }),
  ],
  branch,
);
const place = (over: Partial<Parameters<typeof linkCommit>[0]>) => ({ sha: "ffff0000", subject: "", refs: [], onMain: true, firstParent: true, ...over });

test("a main commit links to the Item whose log or merged marker names it", () => {
  assert.deepEqual(linkCommit(place({ sha: "aaaa1111", subject: "Something" }), links), { item: "demo:work:12", merged: true });
  assert.deepEqual(linkCommit(place({ sha: "cccc3333" }), links), { item: "demo:work:7", merged: true });
});

test("a subject's first number that is an Item wins: the pull request's number after it is not one", () => {
  assert.deepEqual(linkCommit(place({ subject: "Talk to a session (#91) (#98)" }), links), { item: "demo:work:91", merged: true });
  assert.deepEqual(linkCommit(place({ subject: "Nothing here (#98)" }), links), {});
});

test("a branch that only starts at a main commit is not merged there, and does not name the Item", () => {
  assert.deepEqual(linkCommit(place({ refs: ["main", "scopesoup/58"] }), links), { starts: ["scopesoup/58"] });
  // The same commit merged another Item: that one is linked, and 58 still only starts here.
  assert.deepEqual(linkCommit(place({ subject: "Tide table (#12)", refs: ["scopesoup/58"] }), links), { item: "demo:work:12", merged: true, starts: ["scopesoup/58"] });
});

test("a branch tip on main brought in by a merge commit, or of a done Item, is merged there", () => {
  assert.deepEqual(linkCommit(place({ refs: ["scopesoup/58"], firstParent: false }), links), { item: "demo:work:58", merged: true });
  assert.deepEqual(linkCommit(place({ refs: ["scopesoup/91"] }), links), { item: "demo:work:91", merged: true });
});

test("off main, the branch's tip links to its Item, not merged", () => {
  assert.deepEqual(linkCommit(place({ onMain: false, firstParent: false, refs: ["scopesoup/58"], subject: "Work on (#12)" }), links), { item: "demo:work:58" });
  assert.deepEqual(linkCommit(place({ onMain: false, firstParent: false }), links), {});
});
