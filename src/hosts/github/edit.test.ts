// Scope Soup's own edits of a GitHub Item are written through (docs/github-mapping.md, sections 2 to 4). A fake GitHub that
// keeps one issue checks the exact calls, and that a 200 which did not take effect fails. All names and texts are synthetic.

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { Ref } from "../../model/types.ts";
import type { WorkPatch } from "../../ports/host.ts";
import { createGitHubHost } from "./adapter.ts";
import type { FetchLike } from "./client.ts";
import { issueToWork, splitBody, spliceBody } from "./map.ts";
import type { RestComment, RestIssue } from "./rest.ts";

const R = "/repos/harbour/tides";
const ISSUE = `${R}/issues/7`;
const ref: Ref = { host: "github", kind: "work", id: "7" };

interface World {
  issue: RestIssue;
  comments?: RestComment[];
  /** Labels the repository has already. */
  repoLabels?: string[];
  /** GitHub answers 200 but drops label and assignee writes (no push access). */
  drops?: boolean;
  /** GitHub refuses the PATCH. */
  refusesPatch?: boolean;
}

function fake(world: World) {
  const issue = world.issue;
  const repoLabels = new Set(world.repoLabels ?? []);
  const calls: string[] = [];
  const bodies: unknown[] = [];
  const fetchImpl: FetchLike = async (url, init) => {
    const method = init?.method ?? "GET";
    const path = url.replace("https://api.github.test", "");
    const body = init?.body ? (JSON.parse(init.body) as Record<string, unknown>) : undefined;
    calls.push(`${method} ${path}`);
    if (body) bodies.push(body);
    let answer: [number, unknown] = [404, { message: "Not Found" }];
    if (method === "GET" && path === ISSUE) answer = [200, structuredClone(issue)];
    else if (method === "GET" && path === `${ISSUE}/comments?per_page=100`) answer = [200, world.comments ?? []];
    else if (method === "PATCH" && path === ISSUE) {
      if (world.refusesPatch) answer = [403, { message: "Resource not accessible by personal access token" }];
      else answer = [200, Object.assign(issue, body)];
    } else if (method === "POST" && path === `${R}/labels`) {
      const name = String(body?.name);
      answer = repoLabels.has(name) ? [422, { message: "Validation Failed", errors: [{ resource: "Label", code: "already_exists", field: "name" }] }] : [201, body];
      repoLabels.add(name);
    } else if (method === "POST" && path === `${ISSUE}/labels`) {
      if (!world.drops) issue.labels.push(...(body?.labels as string[]).map((name) => ({ name })));
      answer = [200, issue.labels];
    } else if (method === "DELETE" && path.startsWith(`${ISSUE}/labels/`)) {
      const name = decodeURIComponent(path.slice(`${ISSUE}/labels/`.length));
      const at = issue.labels.findIndex((label) => (typeof label === "string" ? label : label.name) === name);
      if (at < 0) answer = [404, { message: "Label does not exist" }];
      else {
        if (!world.drops) issue.labels.splice(at, 1);
        answer = [200, issue.labels];
      }
    } else if (method === "POST" && path === `${ISSUE}/assignees`) {
      if (!world.drops) issue.assignees = [...(issue.assignees ?? []), ...(body?.assignees as string[]).map((login) => ({ login }))];
      answer = [201, issue];
    }
    return { status: answer[0], headers: { get: () => null }, json: async () => answer[1], text: async () => JSON.stringify(answer[1]) };
  };
  const host = createGitHubHost({ token: "t", repo: "harbour/tides", apiUrl: "https://api.github.test", fetchImpl, allowWrites: true, conventions: true, login: "scopesoup-bot" });
  return { host, calls, bodies, issue };
}

const issueOf = (fields: Partial<RestIssue> = {}): RestIssue => ({
  number: 7, id: 9007, title: "Tide table", body: "Show the tides.\n\n## Verification\n\nThe table shows metres.", state: "open", state_reason: null,
  labels: [{ name: "tidy" }], assignees: [], updated_at: "2026-11-22T09:00:00Z", ...fields,
});

const edit = (world: World, patch: WorkPatch) => {
  const f = fake(world);
  return { ...f, done: f.host.write!.editWork!(ref, patch) };
};

describe("editWork on GitHub", { concurrency: 4 }, () => {
  test("title: a PATCH of the title alone, between two reads", async () => {
    const f = edit({ issue: issueOf() }, { title: "Tide table in metres" });
    assert.deepEqual(await f.done, { work: ref, shared: "shared", conflict: false });
    assert.deepEqual(f.calls, [`GET ${ISSUE}`, `PATCH ${ISSUE}`, `GET ${ISSUE}`]);
    assert.deepEqual(f.bodies, [{ title: "Tide table in metres" }]);
  });

  test("body: only the description changes; the Verification section stays", async () => {
    const f = edit({ issue: issueOf() }, { body: "Show the tides in metres." });
    await f.done;
    assert.deepEqual(f.calls, [`GET ${ISSUE}`, `PATCH ${ISSUE}`, `GET ${ISSUE}`]);
    assert.deepEqual(f.bodies, [{ body: "Show the tides in metres.\n\n## Verification\n\nThe table shows metres." }]);
  });

  test("verification: replaced in its place, appended when missing, removed when cleared", async () => {
    const middle = "Intro.\n\n## Verification\n\nOld check.\n\n## Notes\n\nKept.";
    const replaced = edit({ issue: issueOf({ body: middle }) }, { verification: "New check." });
    await replaced.done;
    assert.deepEqual(replaced.bodies, [{ body: "Intro.\n\n## Verification\n\nNew check.\n\n## Notes\n\nKept." }]);
    const appended = edit({ issue: issueOf({ body: "Show the tides." }) }, { verification: "The table shows metres." });
    await appended.done;
    assert.deepEqual(appended.bodies, [{ body: "Show the tides.\n\n## Verification\n\nThe table shows metres." }]);
    const cleared = edit({ issue: issueOf() }, { verification: null });
    await cleared.done;
    assert.deepEqual(cleared.bodies, [{ body: "Show the tides." }]);
    const same = edit({ issue: issueOf() }, { verification: "The table shows metres." });
    await same.done;
    assert.deepEqual(same.calls, [`GET ${ISSUE}`, `GET ${ISSUE}`]);
  });

  test("state todo: reopens, removes the claim label, and never touches an assignee, needs-decision or other labels", async () => {
    const f = edit({ issue: issueOf({ state: "closed", state_reason: "completed", labels: [{ name: "tidy" }, { name: "scopesoup:claimed" }, { name: "scopesoup:needs-decision" }] }) }, { state: "todo" });
    await f.done;
    assert.deepEqual(f.calls, [`GET ${ISSUE}`, `PATCH ${ISSUE}`, `DELETE ${ISSUE}/labels/scopesoup%3Aclaimed`, `GET ${ISSUE}`]);
    assert.deepEqual(f.bodies, [{ state: "open", state_reason: "reopened" }]);
    assert.deepEqual(f.issue.labels, [{ name: "tidy" }, { name: "scopesoup:needs-decision" }]);
  });

  test("state doing: keeps needs-decision on an item a person holds; refused, with nothing written, when nobody does", async () => {
    const held = edit({ issue: issueOf({ assignees: [{ login: "robin" }], labels: [{ name: "scopesoup:needs-decision" }] }) }, { state: "doing" });
    await held.done;
    assert.deepEqual(held.calls.filter((call) => !call.startsWith("GET")), []);
    const free = edit({ issue: issueOf() }, { state: "doing" });
    await assert.rejects(free.done, /only while a person holds it.*assigns nobody/);
    assert.deepEqual(free.calls, [`GET ${ISSUE}`]);
  });

  test("state waiting is refused for a GitHub issue, with nothing written", async () => {
    const f = edit({ issue: issueOf() }, { state: "waiting" });
    await assert.rejects(f.done, /waiting is not a state of a GitHub issue/);
    assert.deepEqual(f.calls, [`GET ${ISSUE}`]);
  });

  test("state done and abandoned: close as completed and as not planned", async () => {
    const done = edit({ issue: issueOf() }, { state: "done" });
    await done.done;
    assert.deepEqual(done.calls, [`GET ${ISSUE}`, `PATCH ${ISSUE}`, `GET ${ISSUE}`]);
    assert.deepEqual(done.bodies, [{ state: "closed", state_reason: "completed" }]);
    const abandoned = edit({ issue: issueOf({ state: "closed", state_reason: "completed" }) }, { state: "abandoned" });
    await abandoned.done;
    assert.deepEqual(abandoned.bodies, [{ state: "closed", state_reason: "not_planned" }]);
    const already = edit({ issue: issueOf({ state: "closed", state_reason: "completed" }) }, { state: "done" });
    await already.done;
    assert.deepEqual(already.calls, [`GET ${ISSUE}`, `GET ${ISSUE}`]);
  });

  test("priority: adds the new label and deletes the other priority labels, never a full replace", async () => {
    const f = edit({ issue: issueOf({ labels: [{ name: "tidy" }, { name: "Priority:Major" }, { name: "size:small" }] }) }, { priority: "critical" });
    await f.done;
    assert.deepEqual(f.calls, [`GET ${ISSUE}`, `POST ${R}/labels`, `POST ${ISSUE}/labels`, `DELETE ${ISSUE}/labels/Priority%3AMajor`, `GET ${ISSUE}`]);
    assert.deepEqual(f.bodies.at(-1), { labels: ["priority:critical"] });
    assert.deepEqual(f.issue.labels, [{ name: "tidy" }, { name: "size:small" }, { name: "priority:critical" }]);
    const cleared = edit({ issue: issueOf({ labels: [{ name: "priority:minor" }, { name: "priority:blocker" }] }) }, { priority: null });
    await cleared.done;
    assert.deepEqual(cleared.calls.filter((call) => !call.startsWith("GET")), [`DELETE ${ISSUE}/labels/priority%3Aminor`, `DELETE ${ISSUE}/labels/priority%3Ablocker`]);
  });

  test("a label GitHub answered 200 for but dropped is a failure", async () => {
    const f = edit({ issue: issueOf(), drops: true }, { priority: "minor" });
    await assert.rejects(f.done, /did not apply it on #7 \(label priority:minor not added\)/);
    const removed = edit({ issue: issueOf({ labels: [{ name: "priority:minor" }] }), drops: true }, { priority: null });
    await assert.rejects(removed.done, /label priority:minor not removed/);
  });

  test("an assignee GitHub answered 200 for but dropped is a failure", async () => {
    const f = fake({ issue: issueOf(), drops: true });
    await assert.rejects(f.host.write!.setAssignees!(ref, ["robin"], []), /assignee robin not added/);
    const kept = fake({ issue: issueOf() });
    await kept.host.write!.setAssignees!(ref, ["robin"], []);
    assert.deepEqual(kept.calls, [`POST ${ISSUE}/assignees`, `GET ${ISSUE}`]);
  });

  test("a refused PATCH fails before any label is written", async () => {
    const f = edit({ issue: issueOf(), refusesPatch: true }, { title: "Never", priority: "minor" });
    await assert.rejects(f.done, /403/);
    assert.deepEqual(f.calls, [`GET ${ISSUE}`, `PATCH ${ISSUE}`]);
  });

  test("labels and parent are not changed through here", async () => {
    const f = edit({ issue: issueOf() }, { labels: ["tidy"] });
    await assert.rejects(f.done, /does not change the labels/);
    assert.deepEqual(f.calls, []);
  });
});

describe("the body and state as Scope Soup reads them", () => {
  test("the Verification section: the last heading outside code fences, to the next # or ## heading", () => {
    assert.deepEqual(splitBody("Do it.\n\n## verification \n\nCheck it.\n"), { description: "Do it.", verification: "Check it." });
    assert.deepEqual(splitBody("Do it.\n\n```\n## Verification\n```\n"), { description: "Do it.\n\n```\n## Verification\n```" });
    assert.deepEqual(splitBody("A.\n\n## Verification\n\nOne.\n\n## Verification\n\nTwo.\n\n# Later\n\nB."), { description: "A.\n\n## Verification\n\nOne.\n\n# Later\n\nB.", verification: "Two." });
    assert.deepEqual(splitBody("A.\n\n## Verification\n\n## How\n\nB."), { description: "A.\n\n## How\n\nB." });
    assert.deepEqual(splitBody("A.\r\n\r\n## Verification\r\n\r\nOne.\r\nTwo."), { description: "A.", verification: "One.\r\nTwo." });
    assert.equal(spliceBody("A.\n\n## Verification\n\nOne.", { description: "B.", verification: "Two." }), "B.\n\n## Verification\n\nTwo.");
    assert.equal(spliceBody("", { verification: "Two." }), "## Verification\n\nTwo.");
  });

  test("an issue reads with its description and verification apart; the needs-decision label is never read as state", () => {
    const scope = { host: "github", repo: "harbour/tides" };
    const item = issueToWork(scope, issueOf({ assignees: [{ login: "robin" }] }));
    assert.equal(item.body, "Show the tides.");
    assert.equal(item.verification, "The table shows metres.");
    assert.equal(item.state, "doing");
    assert.equal(issueToWork(scope, issueOf({ assignees: [{ login: "robin" }], labels: [{ name: "scopesoup:needs-decision" }] })).state, "doing");
    assert.equal(issueToWork(scope, issueOf({ labels: [{ name: "scopesoup:needs-decision" }] })).state, "todo");
    assert.equal(issueToWork(scope, issueOf({ state: "closed", state_reason: "completed", labels: [{ name: "scopesoup:needs-decision" }] })).state, "done");
  });

  test("needsDecision comes from the question comments, not from the label", async () => {
    const question: RestComment = { id: 501, user: { login: "scopesoup-bot" }, created_at: "2026-11-22T08:00:00Z", body: 'Q1: Metric?\n\n<!-- scopesoup:question {"v":1,"question":"Metric?","n":1} -->' };
    const open = fake({ issue: issueOf({ labels: [{ name: "scopesoup:needs-decision" }] }), comments: [question] });
    const asked = await open.host.work.getWork(ref);
    assert.equal(asked?.state, "todo");
    assert.equal(asked?.needsDecision, true);
    const label = await fake({ issue: issueOf({ labels: [{ name: "scopesoup:needs-decision" }] }) }).host.work.getWork(ref);
    assert.equal(label?.state, "todo");
    assert.equal(label?.needsDecision, undefined);
  });
});
