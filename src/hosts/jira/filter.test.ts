// The Jira host's filter, createProject and components against the fake Jira: which issues are Items, where new ones go.

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { writable } from "./testHost.ts";

for (const deployment of ["cloud", "datacenter"] as const) {
  describe(`Jira ${deployment} filter`, { concurrency: 4 }, () => {
    test("only issues that match the filter are listed and read; a write to another is refused", async () => {
      const { host, another, ref, fake } = writable(deployment);
      const filtered = another("laptop-a", { filter: 'labels = frontend AND labels = "frontend"' });
      const page = await filtered.work.listWork();
      assert.deepEqual(page.items.map((item) => item.ref.id), ["DEMO-1"]);
      assert.equal(await filtered.work.getWork(ref("DEMO-1")).then((item) => item?.ref.id), "DEMO-1");
      assert.equal(await filtered.work.getWork(ref("DEMO-2")), null);
      assert.ok((await host.work.listWork()).items.length > 1);
      const before = fake.calls.length;
      await assert.rejects(filtered.write!.setLabels!(ref("DEMO-2"), ["x"], []), /DEMO-2 is not an Item here: it is outside host\.filter/);
      assert.equal(fake.calls.slice(before).some((call) => call.method !== "POST" && call.method !== "GET"), false);
      await filtered.write!.setLabels!(ref("DEMO-1"), ["extra"], []);
      assert.ok(fake.issues.get("DEMO-1")!.fields.labels?.includes("extra"));
    });

    test("a filter the fake cannot read is a 400, not an empty list", async () => {
      const { another } = writable(deployment);
      await assert.rejects(another("laptop-a", { filter: "assignee = currentUser()" }).work.listWork(), /does not know this JQL filter/);
    });

    test("a new Item gets the components; one that matches the filter is not reported", async () => {
      const reported: string[] = [];
      const { fake, another } = writable(deployment, { fake: { components: ["Board", "Other"] } });
      const host = another("laptop-a", { filter: 'component = "Board"', components: ["Board"], onOutsideFilter: (key, reason) => reported.push(`${key} ${reason}`) });
      const made = await host.write!.createWork!({ title: "Inside" });
      assert.deepEqual(fake.issues.get(made.work.id)!.fields.components, [{ name: "Board" }]);
      assert.deepEqual(reported, []);
      assert.equal((await host.work.getWork(made.work))?.ref.id, made.work.id);
    });

    test("a new Item outside the filter is reported as an event, not thrown, and then not touched", async () => {
      const reported: string[] = [];
      const { fake, another } = writable(deployment, { fake: { components: ["Board", "Other"] } });
      const host = another("laptop-a", { filter: 'component = "Board"', components: ["Other"], onOutsideFilter: (key, reason) => reported.push(`${key} ${reason}`) });
      const made = await host.write!.createWork!({ title: "Outside" });
      assert.equal(reported.length, 1);
      assert.match(reported[0]!, new RegExp(`${made.work.id} was created in DEMO with component Other, but it is not an Item`));
      assert.equal((await host.work.listWork()).items.some((item) => item.ref.id === made.work.id), false);
      await assert.rejects(host.write!.setLabels!(made.work, ["x"], []), /outside host\.filter/);
      assert.deepEqual(fake.issues.get(made.work.id)!.fields.labels, []);
    });

    test("a component the project lacks is refused by Jira", async () => {
      const { another } = writable(deployment, { fake: { components: ["Board"] } });
      await assert.rejects(another("laptop-a", { components: ["Nope"] }).write!.createWork!({ title: "x" }), /Component name 'Nope' is not valid/);
    });

    test("createProject makes the issue in that project, and it is reported as not read back", async () => {
      const reported: string[] = [];
      const { fake, another } = writable(deployment, { fake: { otherProjects: ["OTHER"] } });
      const host = another("laptop-a", { createProject: "OTHER", onOutsideFilter: (key, reason) => reported.push(`${key} ${reason}`) });
      const made = await host.write!.createWork!({ title: "Elsewhere" });
      assert.equal(made.work.id, "OTHER-1");
      assert.ok(fake.issues.has("OTHER-1"));
      assert.match(reported[0] ?? "", /^OTHER-1 was created in OTHER/);
    });
  });
}
