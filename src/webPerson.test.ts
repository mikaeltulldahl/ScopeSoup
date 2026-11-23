// The board's person picker (web/src/person.ts): remembered in the browser when it can be, working without storage,
// and named on every request. All names are synthetic.

import assert from "node:assert/strict";
import { test } from "node:test";
import { cleanName, personHeaders, pickerNames, readPerson, writePerson } from "../web/src/person.ts";

const memory = () => {
  const map = new Map<string, string>();
  return { getItem: (key: string) => map.get(key) ?? null, setItem: (key: string, value: string) => void map.set(key, value), removeItem: (key: string) => void map.delete(key) };
};
const broken = { getItem: (): string | null => { throw new Error("blocked"); }, setItem: (): void => { throw new Error("blocked"); }, removeItem: (): void => { throw new Error("blocked"); } };

test("the picked person is remembered, forgotten, and nothing breaks without storage", () => {
  const storage = memory();
  assert.equal(readPerson(storage), "");
  writePerson(storage, "Åsa");
  assert.equal(readPerson(storage), "Åsa");
  writePerson(storage, "");
  assert.equal(readPerson(storage), "");
  writePerson(broken, "Bo");
  assert.equal(readPerson(broken), "");
  writePerson(null, "Bo");
  assert.equal(readPerson(null), "");
});

test("names are cleaned; the picker offers the known people and a new pick, each once and sorted", () => {
  assert.equal(cleanName("  Ada \n Lovelace "), "Ada Lovelace");
  assert.equal(cleanName("x".repeat(150)).length, 100);
  assert.deepEqual(pickerNames(["bo", " ada", "bo", ""], "cy"), ["ada", "bo", "cy"]);
  assert.deepEqual(pickerNames([], ""), []);
});

test("every request names the picked person, URI-encoded; none when nobody is picked", () => {
  assert.deepEqual(personHeaders("Åsa Öberg"), { "X-ScopeSoup-Person": "%C3%85sa%20%C3%96berg" });
  assert.deepEqual(personHeaders(""), {});
});
