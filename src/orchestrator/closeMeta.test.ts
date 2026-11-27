// Closing a duplicate on the meta branch: the host actions write `state: abandoned` and `duplicateOf` to item.md with an `edited`
// line, the Item reads back as a duplicate, and a reopen drops it. A real temporary meta ref; synthetic data.

import assert from "node:assert/strict";
import { after, test } from "node:test";
import { validateConfig } from "../config/validate.ts";
import { createMetaBranchHost } from "../hosts/metaBranch/index.ts";
import type { MetaBranchHost } from "../hosts/metaBranch/index.ts";
import type { TestRepo } from "../hosts/metaBranch/testRepo.ts";
import { createTestRepo } from "../hosts/metaBranch/testRepo.ts";
import type { Ref, WorkItem } from "../model/types.ts";
import { openStore } from "../store/store.ts";
import { createHostActions } from "./hostActions.ts";

const repos: TestRepo[] = [];
const hosts: MetaBranchHost[] = [];
after(async () => {
  for (const host of hosts) await host.stop();
  for (const repo of repos) repo.cleanup();
});

const ref = (id: string): Ref => ({ host: "metaBranch", kind: "work", id });

test("on the meta branch a duplicate is closed there: abandoned, naming the other Item, and a reopen drops it", async () => {
  const repo = createTestRepo();
  repos.push(repo);
  repo.commit("refs/heads/main", { "README.md": "The project.\n" }, "2026-11-17T08:00:00Z");
  let ms = Date.parse("2026-11-20T09:00:00Z");
  const host = createMetaBranchHost({ repoDir: repo.dir, allowWrites: true, remote: null, person: { name: "Ada", email: "ada@example.invalid" }, machine: "laptop-a", idPrefix: "A", now: () => new Date((ms += 1000)).toISOString() });
  hosts.push(host);
  const write = host.write!;
  await write.createWork!({ title: "Tide table in metres" });
  await write.createWork!({ title: "Metric tide table" });
  const result = validateConfig({ project: "tides", machineName: "laptop-a", repoPath: repo.dir }, "/srv/scopesoup");
  if (!result.ok) assert.fail(result.errors.join("\n"));
  const store = openStore(":memory:");
  const actions = createHostActions({ host, git: async () => ({ code: 0, stdout: "", stderr: "" }), config: () => result.config, store });

  assert.equal(await actions.closeDuplicate!(ref("A-2"), ref("A-1")), true);
  const closed = await host.work!.getWork(ref("A-2"));
  assert.deepEqual([closed?.state, closed?.duplicateOf?.id], ["abandoned", "A-1"]);
  assert.match(repo.git(["show", "refs/scopesoup/meta:items/A-2/item.md"]), /^duplicateOf: A-1$/m);
  assert.deepEqual(closed?.log?.at(-1)?.fields, { changed: ["state", "duplicate of"], state: "abandoned", via: "a person's answer" });
  // Into the store at once, so the next tick sees it abandoned.
  assert.equal(store.get<WorkItem>(ref("A-2"))?.duplicateOf?.id, "A-1");
  // Another host's Item is not closed here.
  assert.equal(await actions.closeDuplicate!({ host: "github", kind: "work", id: "3" }, ref("A-1")), false);

  await write.editWork!(ref("A-2"), { state: "todo" });
  const reopened = await host.work!.getWork(ref("A-2"));
  assert.deepEqual([reopened?.state, reopened?.duplicateOf], ["todo", undefined]);
  assert.doesNotMatch(repo.git(["show", "refs/scopesoup/meta:items/A-2/item.md"]), /duplicateOf/);
});
