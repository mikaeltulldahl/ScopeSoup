import assert from "node:assert/strict";
import { test } from "node:test";
import { checkRules, withCheckRules } from "./checkRule.ts";

test("the check command becomes the rule a session types", () => {
  assert.deepEqual(checkRules(["cmd.exe", "/d", "/c", "npm", "run", "check"]), ["Bash(npm run check*)"]);
  assert.deepEqual(checkRules(["pnpm", "check"]), ["Bash(pnpm check*)"]);
  assert.deepEqual(checkRules(["pnpm", "run", "check"]), ["Bash(pnpm run check*)", "Bash(pnpm check*)"]);
  assert.deepEqual(checkRules(["npm", "run", "test"]), ["Bash(npm run test*)", "Bash(npm test*)"]);
  assert.deepEqual(checkRules(["node", "--test"]), ["Bash(node --test*)"]);
  assert.deepEqual(checkRules(["node", "my script.js"]), ['Bash(node "my script.js"*)']);
  assert.deepEqual(checkRules([]), []);
});

test("withCheckRules keeps the list, adds each rule once, and leaves a full shell alone", () => {
  assert.deepEqual(withCheckRules(["Read", "Bash(npm run check*)"], ["npm", "run", "check"]), ["Read", "Bash(npm run check*)"]);
  assert.deepEqual(withCheckRules(["Read"], ["npm", "run", "check"]), ["Read", "Bash(npm run check*)"]);
  assert.deepEqual(withCheckRules(["Read"], null), ["Read"]);
  assert.deepEqual(withCheckRules(["Bash"], ["npm", "run", "check"]), ["Bash"]);
});
