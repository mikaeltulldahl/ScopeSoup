import assert from "node:assert/strict";
import { test } from "node:test";
import { isSelfPerson } from "./holdings.ts";

test("a person is the board's own person by name, on any machine; an agent never is", () => {
  const anna = { id: "anna@laptop-b", name: "anna on laptop-b" };
  assert.equal(isSelfPerson(anna, { person: "anna", machine: "laptop-b" }), true);
  assert.equal(isSelfPerson(anna, { person: "anna", machine: "laptop-c" }), true);
  assert.equal(isSelfPerson(anna, { person: "bo", machine: "laptop-b" }), false);
  assert.equal(isSelfPerson(anna, { machine: "laptop-b" }), false);
  assert.equal(isSelfPerson({ ...anna, bot: true }, { person: "anna", machine: "laptop-b" }), false);
});
