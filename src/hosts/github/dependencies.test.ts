// Blockers of a GitHub Item are issue dependencies (docs/github-mapping.md, sections 2 and 4). A fake GitHub that keeps
// issues and dependencies checks the exact calls, and that an OK which did not take effect fails. All names are synthetic.

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { Ref } from "../../model/types.ts";
import { createGitHubHost } from "./adapter.ts";
import { fakeIssues, ISSUES_API } from "./fakeIssues.ts";

const R = "/repos/harbour/tides/issues";
const work = (id: string): Ref => ({ host: "github", kind: "work", id });

function world(numbers = [3, 4, 5, 7]) {
  const fake = fakeIssues("harbour/tides", numbers, [{ repo: "harbour/charts", number: 2, id: 7702 }]);
  const host = createGitHubHost({ token: "t", repo: "harbour/tides", apiUrl: ISSUES_API, fetchImpl: fake.fetch, allowWrites: true });
  return { fake, host };
}

describe("blockers as issue dependencies", { concurrency: 4 }, () => {
  test("a new blocker is one POST of the blocker's database id, then a re-read of the blockers", async () => {
    const { fake, host } = world();
    await host.write!.editWork!(work("7"), { blockedBy: [work("3")] });
    assert.deepEqual(fake.calls, [
      `GET ${R}/7`,
      `GET ${R}/7/dependencies/blocked_by?per_page=100`,
      `GET ${R}/3`,
      `POST ${R}/7/dependencies/blocked_by`,
      `GET ${R}/7`,
      `GET ${R}/7/dependencies/blocked_by?per_page=100`,
    ]);
    assert.deepEqual(fake.sent, [{ call: `POST ${R}/7/dependencies/blocked_by`, body: { issue_id: 9003 } }]);
    assert.deepEqual((await host.work.getWork(work("7")))?.blockedBy.map((each) => each.id), ["3"]);
  });

  test("a dependency write GitHub answers OK to but does not keep fails on the re-read", async () => {
    const { fake, host } = world();
    fake.dropsDependencies = true;
    await assert.rejects(host.write!.editWork!(work("7"), { blockedBy: [work("3")] }), /did not apply it on #7 \(blocked by #3 not added\)/);
    assert.equal(fake.calls.filter((call) => call.startsWith("POST")).length, 1);
  });

  test("a refused dependency write fails with GitHub's answer", async () => {
    const { fake, host } = world();
    fake.refuses.add("7");
    await assert.rejects(host.write!.editWork!(work("7"), { blockedBy: [work("3")] }), /403/);
  });

  test("an open blocker left out is removed with a DELETE of its database id; a closed one and one already there are left alone", async () => {
    const { fake, host } = world();
    fake.blockedBy.set("7", new Set([9003, 9004, 9005]));
    fake.issues.get("5")!.state = "closed";
    await host.write!.editWork!(work("7"), { blockedBy: [work("3")] });
    assert.deepEqual(fake.calls.filter((call) => !call.startsWith("GET")), [`DELETE ${R}/7/dependencies/blocked_by/9004`]);
    assert.deepEqual([...fake.blockedBy.get("7")!], [9003, 9005]);
  });

  test("a DELETE GitHub answers OK to but does not keep fails on the re-read", async () => {
    const { fake, host } = world();
    fake.blockedBy.set("7", new Set([9004]));
    fake.dropsDependencies = true;
    await assert.rejects(host.write!.editWork!(work("7"), { blockedBy: [] }), /blocked by #4 not removed/);
  });

  test("adding blockers (a triage) POSTs only the missing ones and never DELETEs, then re-reads", async () => {
    const { fake, host } = world();
    fake.blockedBy.set("7", new Set([9004]));
    await host.write!.addBlockers!(work("7"), [work("3"), work("4")]);
    assert.deepEqual(fake.calls, [
      `GET ${R}/7/dependencies/blocked_by?per_page=100`,
      `GET ${R}/3`,
      `POST ${R}/7/dependencies/blocked_by`,
      `GET ${R}/7/dependencies/blocked_by?per_page=100`,
    ]);
    assert.deepEqual([...fake.blockedBy.get("7")!], [9004, 9003]);
    fake.dropsDependencies = true;
    await assert.rejects(host.write!.addBlockers!(work("7"), [work("5")]), /blocked by #5 not added/);
  });

  test("a blocker in another repository is looked up there for its database id", async () => {
    const { fake, host } = world();
    await host.write!.editWork!(work("7"), { blockedBy: [work("harbour/charts#2")] });
    assert.ok(fake.calls.includes("GET /repos/harbour/charts/issues/2"));
    assert.deepEqual(fake.sent, [{ call: `POST ${R}/7/dependencies/blocked_by`, body: { issue_id: 7702 } }]);
  });

  test("labels and parent are still not changed through here", async () => {
    const { fake, host } = world();
    await assert.rejects(host.write!.editWork!(work("7"), { labels: ["tidy"], blockedBy: [] }), /does not change the labels/);
    assert.deepEqual(fake.calls, []);
  });

  test("the Items an issue blocks: one request, open issues only", async () => {
    const { fake, host } = world();
    fake.blockedBy.set("3", new Set([9007]));
    fake.blockedBy.set("4", new Set([9007]));
    fake.issues.get("4")!.state = "closed";
    assert.deepEqual((await host.blocking(work("7"))).map((each) => each.id), ["3"]);
    assert.deepEqual(fake.calls, [`GET ${R}/7/dependencies/blocking?per_page=100`]);
  });
});
