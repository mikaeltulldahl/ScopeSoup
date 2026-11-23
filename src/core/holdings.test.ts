import assert from "node:assert/strict";
import { test } from "node:test";
import type { LogRecord, WorkItem } from "../model/types.ts";
import { buildHoldings, isSelfPerson } from "./holdings.ts";

const NOW = new Date("2026-11-19T12:00:00.000Z");

function item(id: string, over: Partial<WorkItem> = {}): WorkItem {
  return { ref: { host: "metaBranch", kind: "work", id }, title: `Item ${id}`, state: "doing", hostState: "doing", labels: [], blockedBy: [], openChildren: 0, updatedAt: "2026-11-19T11:00:00.000Z", ...over };
}

const line = (at: string, who: string, machine: string, agent: boolean, kind: string, fields: Record<string, unknown> = {}): LogRecord => ({ at, by: { who, machine, agent }, kind, fields });

test("holdings: agents by machine, people by name; mine is marked; the log's last session is shown", () => {
  const works = [
    item("A-1", {
      holder: { actor: { id: "scopesoup@laptop-b", name: "scopesoup on laptop-b", bot: true }, until: "2026-11-19T13:00:00.000Z" },
      log: [
        line("2026-11-19T10:00:00.000Z", "scopesoup", "laptop-b", true, "claimed", { until: "2026-11-19T13:00:00.000Z" }),
        line("2026-11-19T10:30:00.000Z", "scopesoup", "laptop-b", true, "session", { role: "implement", outcome: "succeeded", summary: "Added the parser." }),
      ],
    }),
    item("A-2", { holder: { actor: { id: "scopesoup@laptop-a", name: "scopesoup on laptop-a", bot: true }, until: "2026-11-19T11:00:00.000Z" } }),
    item("A-3", {
      holder: { actor: { id: "anna@laptop-b", name: "anna on laptop-b" } },
      log: [line("2026-11-19T09:00:00.000Z", "anna", "laptop-b", false, "claimed")],
    }),
    item("A-4", { state: "done", holder: { actor: { id: "scopesoup@laptop-b", name: "x", bot: true } } }),
  ];
  const view = buildHoldings(works, NOW, { machine: "laptop-a", person: "robin" });
  assert.deepEqual(view.groups.map((group) => [group.id, group.person, group.mine, group.items.map((held) => held.label)]), [
    ["scopesoup@laptop-a", false, true, ["A-2"]],
    ["anna@laptop-b", true, false, ["A-3"]],
    ["scopesoup@laptop-b", false, false, ["A-1"]],
  ]);
  const a1 = view.groups.find((group) => group.id === "scopesoup@laptop-b")?.items[0];
  assert.equal(a1?.since, "2026-11-19T10:00:00.000Z");
  assert.equal(a1?.last?.words, "implement succeeded: Added the parser.");
  assert.equal(a1?.last?.machine, "laptop-b");
  // An agent's claim that ran out; a person's hold never does, but it is quiet after a day without a line.
  assert.equal(view.groups[0]?.items[0]?.expired, true);
  const anna = view.groups[1]?.items[0];
  assert.deepEqual([anna?.expired, anna?.quiet, anna?.until], [false, false, undefined]);
  const later = buildHoldings(works, new Date("2026-11-21T12:00:00.000Z"), undefined);
  assert.equal(later.groups.find((group) => group.person)?.items[0]?.quiet, true);
  // Machines are the ones that wrote lines to the logs.
  assert.deepEqual(view.machines.map((machine) => [machine.name, machine.mine, machine.holding]), [["laptop-b", false, 2]]);
});

test("a person is the board's own person by name, on any machine; an agent never is", () => {
  const anna = { id: "anna@laptop-b", name: "anna on laptop-b" };
  assert.equal(isSelfPerson(anna, { person: "anna", machine: "laptop-b" }), true);
  assert.equal(isSelfPerson(anna, { person: "anna", machine: "laptop-c" }), true);
  assert.equal(isSelfPerson(anna, { person: "bo", machine: "laptop-b" }), false);
  assert.equal(isSelfPerson(anna, { machine: "laptop-b" }), false);
  assert.equal(isSelfPerson({ ...anna, bot: true }, { person: "anna", machine: "laptop-b" }), false);
});
