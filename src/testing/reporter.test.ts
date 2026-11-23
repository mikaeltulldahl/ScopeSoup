import assert from "node:assert/strict";
import { test } from "node:test";
import { ENDED_FROM_OUTSIDE, retryGitOnceSync } from "../hosts/gitRetry.ts";
import { retried } from "./reporter.ts";

test("the test reporter lists each retry, so none passes unseen", () => {
  const lines: string[] = [];
  assert.equal(retried([]), "");
  assert.equal(retried([{ file: "src/a.test.ts", message: "other output\n" }]), "");
  retryGitOnceSync(["rev-parse", "HEAD"], (() => {
    let tries = 0;
    return () => {
      if (++tries === 1) throw Object.assign(new Error("Command failed"), { status: ENDED_FROM_OUTSIDE, stderr: "" });
      return "ok";
    };
  })(), { log: (line) => lines.push(line) });
  const text = retried([{ file: "src/a.test.ts", message: `${lines[0]}\n` }]);
  assert.match(text, /Retried, ended from outside \(1\):\n {2}src\/a\.test\.ts {2}git rev-parse: exited with 4294967295/);
});
