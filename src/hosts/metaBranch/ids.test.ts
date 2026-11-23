import assert from "node:assert/strict";
import { test } from "node:test";
import { allocateId, isBranchName, isIdPrefix, isItemId, isMetaRef } from "./ids.ts";

test("item ids: short names only, nothing that is a path or an option", () => {
  for (const id of ["A-12", "a", "7", "LAPTOP_B-3"]) assert.equal(isItemId(id), true, id);
  for (const id of ["", "-rf", "..", "a..b", "a/b", "a\\b", ".hidden", "a.b", "a b", "a:b", "x".repeat(65)]) assert.equal(isItemId(id), false, id);
});

test("meta refs: under refs/, no dots or dashes where git would read them otherwise", () => {
  for (const ref of ["refs/heads/scopesoup-meta", "refs/scopesoup/meta"]) assert.equal(isMetaRef(ref), true, ref);
  for (const ref of ["scopesoup-meta", "refs/", "refs/heads/../main", "refs/heads/.x", "refs/heads/x.lock", "refs/heads//x", "refs/heads/x/", "refs/heads/-x", "refs/heads/x@{1}", "--upload-pack=x"]) {
    assert.equal(isMetaRef(ref), false, ref);
  }
});

test("new ids: one more than the highest with the same prefix; other prefixes and gaps do not matter", () => {
  assert.equal(allocateId("A", []), "A-1");
  assert.equal(allocateId("A", ["A-1", "A-3", "B-9", "AB-7", "A-x", "a-12", "A-02"]), "A-4");
  assert.equal(allocateId("RB2", ["RB2-10"]), "RB2-11");
  for (const prefix of ["", "-", "A/", "..", "A-", "1A", "A.B", "x".repeat(17)]) assert.throws(() => allocateId(prefix, []), /not a letter followed/, prefix);
  assert.equal(isIdPrefix("A"), true);
});

test("new ids: counters of any length, never an id that exists", () => {
  // As Numbers, 9007199254740993 rounds down and one more would be that id again.
  assert.equal(allocateId("A", ["A-9007199254740993"]), "A-9007199254740994");
  assert.equal(allocateId("A", ["A-123456789012345678901234567890"]), "A-123456789012345678901234567891");
  assert.throws(() => allocateId("A", [`A-${"9".repeat(62)}`]), /not a free item id/);
});

test("branch names follow the same rules", () => {
  assert.equal(isBranchName("scopesoup/A-12"), true);
  assert.equal(isBranchName("-delete"), false);
  assert.equal(isBranchName("a..b"), false);
});
