// The Jira host's filter and components against the fake Jira: which issues are Items, where new ones go.

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
      assert.match(reported[0]!, new RegExp(`${made.work.id} was created with component Other, but it is not an Item`));
      assert.equal((await host.work.listWork()).items.some((item) => item.ref.id === made.work.id), false);
      await assert.rejects(host.write!.setLabels!(made.work, ["x"], []), /outside host\.filter/);
      assert.deepEqual(fake.issues.get(made.work.id)!.fields.labels, []);
    });

    test("a live filter holds from the next read and write: the next listing is full and names the Items that left", async () => {
      const live = { filter: "labels = frontend" as string | undefined, components: [] as string[] };
      const { another, ref, fake } = writable(deployment, { fake: { components: ["Board"] } });
      const host = another("laptop-a", { filter: () => live.filter, components: () => live.components });
      const first = await host.work.listWork();
      assert.deepEqual(first.items.map((item) => item.ref.id), ["DEMO-1"]);
      assert.equal(await host.work.getWork(ref("DEMO-2")), null);
      live.filter = "labels = bug";
      // A cursor listing would miss DEMO-2 (not updated since): the change makes it a full one.
      const next = await host.work.listWork(first.cursor);
      assert.deepEqual(next.items.map((item) => item.ref.id), ["DEMO-2"]);
      assert.deepEqual(next.removed?.map((each) => each.id), ["DEMO-1"]);
      assert.equal((await host.work.listWork(next.cursor)).removed, undefined);
      assert.equal((await host.work.getWork(ref("DEMO-2")))?.ref.id, "DEMO-2");
      assert.equal(await host.work.getWork(ref("DEMO-1")), null);
      // The write refusal asks the same live filter.
      await assert.rejects(host.write!.setLabels!(ref("DEMO-1"), ["x"], []), /outside host\.filter \(labels = bug\)/);
      await host.write!.setLabels!(ref("DEMO-2"), ["x"], []);
      live.filter = undefined;
      assert.equal((await host.work.getWork(ref("DEMO-1")))?.ref.id, "DEMO-1");
      live.components = ["Board"];
      const made = await host.write!.createWork!({ title: "With the new component" });
      assert.deepEqual(fake.issues.get(made.work.id)!.fields.components, [{ name: "Board" }]);
    });

    test("a component the project lacks is refused by Jira", async () => {
      const { another } = writable(deployment, { fake: { components: ["Board"] } });
      await assert.rejects(another("laptop-a", { components: ["Nope"] }).write!.createWork!({ title: "x" }), /Component name 'Nope' is not valid/);
    });
  });
}
