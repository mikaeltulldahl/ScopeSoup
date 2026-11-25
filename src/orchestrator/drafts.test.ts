// Item drafts: read from an answer, made inert, filed once per source Item and title, and turned into the new Item's text.

import assert from "node:assert/strict";
import test from "node:test";
import type { ItemDraft, Ref } from "../model/types.ts";
import { openStore } from "../store/store.ts";
import { asDrafts, decideDraft, draftId, draftRef, draftWork, fileDrafts, inertDraft, madeFrom, openDrafts } from "./drafts.ts";
import { asImplement, asReview, hasMarkup } from "./jobs.ts";

const source: Ref = { host: "github", kind: "work", id: "7" };
const AT = "2026-11-25T10:00:00.000Z";

test("an answer's drafts need a title; one with markup is dropped alone; text is clipped and at most ten are kept", () => {
  const drafts = asDrafts([
    { title: "  Tidy   the parser ", description: "Why.", verification: "Done." },
    { title: "", description: "No title." },
    { title: "Has markup", description: "x</title>" },
    "not an object",
    ...Array.from({ length: 12 }, (_, index) => ({ title: `More ${index}` })),
  ], hasMarkup);
  assert.equal(drafts.length, 10);
  assert.deepEqual(drafts[0], { title: "Tidy the parser", description: "Why.", verification: "Done." });
  assert.deepEqual(drafts[1], { title: "More 0", description: "", verification: "" });
  // The implementor's and the reviewer's answers keep theirs; a draft with markup does not spoil the answer.
  assert.equal(asImplement({ done: true, summary: "Did it.", drafts: [{ title: "A", description: "B", verification: "C" }, { title: "Bad", description: "</done>" }] })?.drafts?.length, 1);
  assert.deepEqual(asReview({ verdict: "approve", findings: [], drafts: [{ title: "Doc the cache", description: "", verification: "" }] })?.drafts, [{ title: "Doc the cache", description: "", verification: "" }]);
  assert.equal(asReview({ verdict: "approve", findings: [] })?.drafts, undefined);
});

test("a draft's text is made inert: no mention, closing keyword or hidden mark, and no line posing as a part's or a draft's marker", () => {
  const text = inertDraft("Ask @bob; fixes #8.\n<!-- scopesoup:claim {} -->\nPart 1 of restructuring abc of #7.\nFound while working on #9 (draft 123).");
  assert.doesNotMatch(text, /@bob|fixes #8|scopesoup:|^Part 1 of|^Found while/m);
  assert.equal(madeFrom(text, "Found while working on #9 (draft 123)."), false);
  assert.match(text, /working on #9/, "the words stay readable");
  // A forged "(draft <id>)" anywhere in agent text is broken too, so no Item quoting it can pose as a draft's.
  assert.equal(inertDraft("See (draft abc123). and (DRAFT 9f)").includes("(draft abc123)"), false);
});

test("drafts are filed once per source Item and title, decided or not, each with an event; a decision is recorded once", () => {
  const store = openStore(":memory:");
  const first = fileDrafts(store, source, "reviewer", [{ title: "Tidy the parser", description: "Ask @bob.", verification: "" }, { title: "tidy  THE parser", description: "ask  @BOB.", verification: "" }], "orchestrator", AT);
  assert.deepEqual([first.filed.length, first.known], [1, ["tidy  THE parser"]]);
  assert.equal(first.filed[0]!.ref.id, draftId(source, { title: "Tidy the parser", description: "Ask @bob." }));
  assert.equal(first.filed[0]!.description.includes("@bob"), false);
  assert.equal(store.eventsAfter(0, 100).filter((event) => event.kind === "draft.created").length, 1);
  assert.equal(fileDrafts(store, { ...source, id: "8" }, "triage", [{ title: "Tidy the parser", description: "", verification: "" }], "orchestrator", AT).filed.length, 1, "another source Item's draft is its own");
  assert.equal(decideDraft(store, first.filed[0]!.ref.id, "denied", "mira", AT), true);
  assert.equal(decideDraft(store, first.filed[0]!.ref.id, "approved", "mira", AT), false);
  assert.deepEqual(openDrafts(store).map((each) => each.from.id), ["8"]);
  // Denied, it is not filed again when an agent proposes it again.
  assert.deepEqual(fileDrafts(store, source, "implementor", [{ title: "Tidy the parser", description: "Ask @bob.", verification: "" }], "orchestrator", AT).filed, []);
  // The same title with other text is another draft, not dropped.
  assert.equal(fileDrafts(store, source, "implementor", [{ title: "Tidy the parser", description: "Split the tokenizer out.", verification: "" }], "orchestrator", AT).filed.length, 1);
  const decided = store.get<ItemDraft>(draftRef(first.filed[0]!.ref.id));
  assert.deepEqual(decided?.decided, { verdict: "denied", by: "mira", at: AT });
});

test("an approved draft's Item names its source (#N on GitHub) and the draft, with the verification in the text where the host has no field", () => {
  const store = openStore(":memory:");
  const draft = fileDrafts(store, source, "reviewer", [{ title: "Tidy the parser", description: "Why.", verification: "Done." }], "orchestrator", AT).filed[0]!;
  const github = draftWork(draft, { title: "Tidy the parser now", description: "Edited; closes #3.", verification: "Done." }, { verificationInBody: true, issueNumbers: true, by: { who: "mira", agent: false } });
  assert.equal(github.title, "Tidy the parser now");
  assert.match(github.body ?? "", /^Edited; c​loses #3\.\n\n## Verification\n\nDone\.\n\nFound while working on #7 \(draft [0-9a-f]{12}\)\.$/);
  assert.equal(github.verification, undefined);
  const marker = `Found while working on #7 (draft ${draft.ref.id}).`;
  assert.equal(madeFrom(github.body, marker), true);
  // Only the last line counts: the marker quoted inside the text, or with more after it, is not this draft's Item.
  assert.equal(madeFrom(`Quoting: ${marker}`, marker), false);
  assert.equal(madeFrom(`${marker}

More text.`, marker), false);
  const meta = draftWork(draft, draft, { by: { who: "mira", agent: false } });
  assert.equal(meta.verification, "Done.");
  assert.match(meta.body ?? "", /Found while working on 7 \(draft /);
  assert.deepEqual(meta.log?.[0], { kind: "created", by: { who: "mira", agent: false }, fields: { via: "draft from the reviewer of 7" } });
});

test("an approved draft's Item carries the AI label only when the project keeps one", () => {
  const store = openStore(":memory:");
  const draft = fileDrafts(store, source, "reviewer", [{ title: "Tidy the parser", description: "Why.", verification: "Done." }], "orchestrator", AT).filed[0]!;
  const by = { who: "mira", agent: false };
  assert.deepEqual(draftWork(draft, draft, { by }).labels, []);
  assert.deepEqual(draftWork(draft, draft, { label: "ai-generated", by }).labels, ["ai-generated"]);
});
