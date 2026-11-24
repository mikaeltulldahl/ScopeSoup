// The Jira host's writes against the fake Jira, Cloud and Data Center: each write, then what the fake holds and what a re-read shows.

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { BodyChanged, TooLarge } from "../../ports/host.ts";
import { FAKE_DC_SITE, FAKE_SITE } from "./fakeJira.ts";
import { writable } from "./testHost.ts";

for (const deployment of ["cloud", "datacenter"] as const) {
  const cloud = deployment === "cloud";
  describe(`Jira ${deployment} writes`, { concurrency: 4 }, () => {
    test("with writes on the host has the write capability and no change ports", () => {
      const { host } = writable(deployment);
      assert.deepEqual([...host.info.capabilities].sort(), ["work", "write"]);
      assert.equal(host.info.claimMachine, "laptop-a");
      assert.equal(host.write?.openChange, undefined);
      assert.equal(host.write?.merge, undefined);
      assert.equal(host.info.commentLimit, 32_000);
    });

    test("creates an issue with its description, verification, labels and priority; the text is the deployment's format", async () => {
      const { fake, host, write } = writable(deployment);
      const outcome = await write.createWork!({ title: "Tide table in metres", body: "Show **metres**.", verification: "The table says m.", labels: ["units"], priority: "critical" });
      assert.deepEqual(outcome, { work: { host: "jira", kind: "work", id: "DEMO-7", url: `${cloud ? FAKE_SITE : FAKE_DC_SITE}/browse/DEMO-7` }, shared: "shared", conflict: false });
      const stored = fake.issues.get("DEMO-7")!;
      assert.equal(stored.fields.issuetype?.name, "Task");
      assert.equal(stored.fields.priority?.name, "High");
      if (cloud) assert.equal((stored.fields.description as { type: string }).type, "doc");
      else assert.equal(stored.fields.description, "Show *metres*.\n\nh2. Verification\n\nThe table says m.");
      const item = await host.work.getWork(outcome.work);
      assert.equal(item?.body, "Show **metres**.");
      assert.equal(item?.verification, "The table says m.");
      assert.deepEqual(item?.labels, ["units"]);
      assert.equal(item?.priority, "critical");
    });

    test("a split's child is a Sub-task under its parent; a hierarchy the project refuses gives an issue of its own, not linked", async () => {
      const { fake, write, ref } = writable(deployment);
      const child = await write.createWork!({ title: "Part one", parent: ref("DEMO-3") });
      assert.equal(child.linked, undefined);
      assert.equal(fake.issues.get(child.work.id)!.fields.issuetype?.name, "Sub-task");
      assert.equal(fake.issues.get(child.work.id)!.fields.parent?.key, "DEMO-3");
      // DEMO-5 is a Sub-task itself: nothing can go under it.
      const deeper = await write.createWork!({ title: "Part two", parent: ref("DEMO-5") });
      assert.equal(deeper.linked, false);
      assert.match(deeper.problem ?? "", /could not put it under DEMO-5/);
      assert.equal(fake.issues.get(deeper.work.id)!.fields.issuetype?.name, "Task");
      await assert.rejects(write.linkChild!(ref("DEMO-5"), deeper.work), /cannot be a child/);
    });

    test("edits the summary and the description; a new verification alone keeps the rest of the description as it is", async () => {
      const { fake, host, write, ref } = writable(deployment);
      const before = JSON.stringify(fake.issues.get("DEMO-1")!.fields.description);
      await write.editWork!(ref("DEMO-1"), { verification: "Open the board, see DEMO-1 and DEMO-2." });
      const after = fake.issues.get("DEMO-1")!.fields.description;
      const item = await host.work.getWork(ref("DEMO-1"));
      assert.equal(item?.verification, "Open the board, see DEMO-1 and DEMO-2.");
      if (cloud) {
        const nodes = (after as { content: unknown[] }).content;
        const old = (JSON.parse(before) as { content: unknown[] }).content;
        assert.deepEqual(nodes.slice(0, 4), old.slice(0, 4), "the nodes before the section are kept as they were");
      } else assert.match(after as string, /^h2\. Goal\nShow \*every\* Item, see \[the notes\|https:\/\/example\.test\/notes\]\.\n\* columns\n\* cards\n\nh2\. Verification\n\n/);
      await write.editWork!(ref("DEMO-1"), { title: "Board shows DEMO", body: "Show every Item." });
      const edited = await host.work.getWork(ref("DEMO-1"));
      assert.equal(edited?.title, "Board shows DEMO");
      assert.equal(edited?.body, "Show every Item.");
      assert.equal(edited?.verification, "Open the board, see DEMO-1 and DEMO-2.");
    });

    test("a description with what Scope Soup cannot write is not replaced, but its verification can be added", async () => {
      const { fake, write, ref } = writable(deployment);
      await assert.rejects(write.editWork!(ref("DEMO-2"), { body: "Flattened." }), (error: Error) => error instanceof BodyChanged && /cannot write back \((mention|panel)/.test(error.message));
      const kept = JSON.stringify(fake.issues.get("DEMO-2")!.fields.description);
      await write.editWork!(ref("DEMO-2"), { verification: "Log in on a Friday." });
      const after = fake.issues.get("DEMO-2")!.fields.description;
      if (cloud) assert.deepEqual((after as { content: unknown[] }).content.slice(0, 2), (JSON.parse(kept) as { content: unknown[] }).content);
      else assert.ok((after as string).startsWith(JSON.parse(kept) as string));
    });

    test("labels are added and removed, never replaced; a label with a space is refused", async () => {
      const { fake, write, ref } = writable(deployment);
      await write.setLabels!(ref("DEMO-1"), ["units"], ["frontend"]);
      assert.deepEqual(fake.issues.get("DEMO-1")!.fields.labels, ["units"]);
      assert.deepEqual(fake.calls.filter((call) => call.method === "PUT").map((call) => call.body), [{ update: { labels: [{ add: "units" }, { remove: "frontend" }] } }]);
      await assert.rejects(write.setLabels!(ref("DEMO-1"), ["two words"], []), /hold no spaces/);
      assert.deepEqual(await write.changeLabels!(ref("DEMO-1"), ["units", "docs"], ["missing"]), { added: ["docs"], removed: [] });
    });

    test("priority by the configured names", async () => {
      const { fake, write, ref } = writable(deployment);
      await write.editWork!(ref("DEMO-3"), { priority: "blocker" });
      assert.equal(fake.issues.get("DEMO-3")!.fields.priority?.name, "Highest");
    });

    test("done, abandoned and back to todo are transitions; a done screen gets its resolution", async () => {
      const { fake, host, write, ref } = writable(deployment);
      await write.editWork!(ref("DEMO-3"), { state: "done" });
      assert.deepEqual([fake.issues.get("DEMO-3")!.fields.status?.name, fake.issues.get("DEMO-3")!.fields.resolution?.name], ["Done", "Done"]);
      await write.editWork!(ref("DEMO-3"), { state: "todo" });
      assert.equal((await host.work.getWork(ref("DEMO-3")))?.state, "todo");
      // No transition is called "Won't Do": the one into the done category, with the "won't do" resolution.
      await write.editWork!(ref("DEMO-3"), { state: "abandoned" });
      assert.equal((await host.work.getWork(ref("DEMO-3")))?.state, "abandoned");
      assert.equal(fake.issues.get("DEMO-3")!.fields.resolution?.name, "Won't Do");
      await assert.rejects(write.editWork!(ref("DEMO-1"), { state: "waiting" }), /waiting is not a state/);
    });

    test("a configured transition name the workflow lacks falls back to a transition into the same category", async () => {
      const { write, ref, fake } = writable(deployment, { transitions: { doing: "Start Work" } });
      // Into the doing category anyway: the configured name is tried first, then the category.
      fake.issues.get("DEMO-3")!.fields.status = { name: "To Do", statusCategory: { key: "new" } };
      await write.editWork!(ref("DEMO-3"), { state: "doing" });
      assert.equal(fake.issues.get("DEMO-3")!.fields.status?.name, "In Progress");
    });

    test("blockers are Blocks links: added, and removed only by an edit, never by a triage", async () => {
      const { host, write, ref } = writable(deployment);
      await write.addBlockers!(ref("DEMO-1"), [ref("DEMO-3")]);
      assert.deepEqual((await host.work.getWork(ref("DEMO-1")))?.blockedBy.map((each) => each.id), ["DEMO-3"]);
      await write.addBlockers!(ref("DEMO-1"), [ref("DEMO-5")]);
      assert.deepEqual((await host.work.getWork(ref("DEMO-1")))?.blockedBy.map((each) => each.id), ["DEMO-3", "DEMO-5"]);
      await write.editWork!(ref("DEMO-1"), { blockedBy: [ref("DEMO-5")] });
      assert.deepEqual((await host.work.getWork(ref("DEMO-1")))?.blockedBy.map((each) => each.id), ["DEMO-5"]);
    });

    test("a duplicate is abandoned with the Duplicate resolution and a Duplicate link", async () => {
      const { fake, write, ref } = writable(deployment);
      await write.editWork!(ref("DEMO-3"), { state: "abandoned", duplicateOf: ref("DEMO-1") });
      assert.equal(fake.issues.get("DEMO-3")!.fields.resolution?.name, "Duplicate");
      assert.ok(fake.issues.get("DEMO-3")!.fields.issuelinks?.some((link) => link.type.name === "Duplicate" && link.outwardIssue?.key === "DEMO-1"));
    });

    test("a person's hold is the assignee, set and taken off", async () => {
      const { host, write, ref, person } = writable(deployment);
      const id = person.accountId ?? person.name!;
      await write.setAssignees!(ref("DEMO-3"), [id], []);
      assert.equal((await host.work.getWork(ref("DEMO-3")))?.holder?.actor.id, id);
      await write.setAssignees!(ref("DEMO-3"), [], [id]);
      assert.equal((await host.work.getWork(ref("DEMO-3")))?.holder, undefined);
    });

    test("a comment is converted; over the host's limit it is refused before anything is posted", async () => {
      const { fake, write, ref } = writable(deployment, { commentLimit: 100 });
      await write.comment!(ref("DEMO-3"), "**Done** on main.");
      assert.equal(fake.comments["DEMO-3"]?.length, 1);
      await assert.rejects(write.comment!(ref("DEMO-3"), "x".repeat(101)), (error: Error) => error instanceof TooLarge && (error as TooLarge).limit === 100);
      assert.equal(fake.comments["DEMO-3"]?.length, 1);
    });

    test("closing a merged Item: the done transition, then the comment with the merged property", async () => {
      const { fake, host, write, ref } = writable(deployment);
      await write.closeWork!(ref("DEMO-3"), "Merged on main as 2222222.", { sha: "2".repeat(40), target: "main" });
      const item = await host.work.getWork(ref("DEMO-3"));
      assert.equal(item?.state, "done");
      assert.equal(item?.merged?.sha, "2".repeat(40));
      assert.equal(item?.merged?.reopened, undefined);
      const id = fake.comments["DEMO-3"]![0]!.id;
      assert.equal((fake.commentProperties[id]?.scopesoup as { kind: string }).kind, "merged");
      // Reopened on Jira after the merge: the marker no longer counts.
      fake.issues.get("DEMO-3")!.fields.status = { name: "To Do", statusCategory: { key: "new" } };
      assert.ok((await host.work.getWork(ref("DEMO-3")))?.merged?.reopened);
    });

    test("a follow-up's mark becomes a Relates link and a property, and comes back in its text", async () => {
      const { fake, host, write } = writable(deployment);
      const mark = `<!-- scopesoup:follow-up ${JSON.stringify({ item: "jira:work:DEMO-1", sha: "abc1234" })} -->`;
      const made = await write.createWork!({ title: "Follow-up to DEMO-1", body: `Rename it.\n\n${mark}` });
      const stored = fake.issues.get(made.work.id)!;
      assert.ok(stored.fields.issuelinks?.some((link) => link.type.name === "Relates" && link.outwardIssue?.key === "DEMO-1"));
      assert.equal(JSON.stringify(stored.fields.description).includes("scopesoup"), false);
      assert.ok((await host.work.getWork(made.work))?.body?.endsWith(mark));
    });
  });
}
