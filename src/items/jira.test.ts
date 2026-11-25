// The item commands on a Jira host, Cloud and Data Center, against the fake Jira: Robin works with her own token, and Scope
// Soup's server host (another token) reads what she did. All names and texts are synthetic.

import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, test } from "node:test";
import type { HostSettings } from "../hostSetup.ts";
import type { JiraHost } from "../hosts/jira/index.ts";
import { CLAIM_PROPERTY, COMMENT_PROPERTY } from "../hosts/jira/conventions.ts";
import type { Writable } from "../hosts/jira/testHost.ts";
import { writable } from "../hosts/jira/testHost.ts";
import { findHandbacks } from "../orchestrator/handback.ts";
import type { CliDeps } from "./cli.ts";
import { runItemCli } from "./cli.ts";
import { execFileSyncRetrying } from "../hosts/spawnRetry.ts";
import { fixedBranches } from "./remoteBranch.ts";
import type { Backend } from "./service.ts";
import { claimItem, createItem, handBackItem, listItems, Refused, releaseItem } from "./service.ts";

const cleanups: (() => void)[] = [];
after(() => {
  for (const cleanup of cleanups) cleanup();
});

const SHA = "b".repeat(40);
const UNTIL = "2026-11-21T11:00:00.000Z";

/** Robin's commands straight on her host, as `item` builds them on Jira. */
async function robinBackend(w: Writable, afterClaim?: Backend["afterClaim"]): Promise<{ host: JiraHost; backend: Backend }> {
  const host = w.robin();
  const me = await host.info.whoami();
  const backend: Backend = {
    kind: "jira", host: host.info.id, who: me.id, name: me.name, work: host.work, write: host.write!, now: () => new Date(w.clock.ms), mainBranch: "main",
    branches: fixedBranches(() => ({ state: "ready", sha: SHA, ahead: 1 })), ...(afterClaim ? { afterClaim } : {}),
  };
  return { host, backend };
}

/** A configuration file whose host is the fake Jira of `w`, and the command line with Robin's host in place of the real one. */
function cli(w: Writable, deployment: "cloud" | "datacenter", over: Partial<CliDeps> = {}) {
  const root = mkdtempSync(join(tmpdir(), "scopesoup-jira-items-"));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const file = join(root, "scopesoup.config.json");
  const site = deployment === "cloud" ? "https://example.atlassian.net" : "https://jira.example.test";
  // The project's shared settings, with the Jira host, on its meta ref; this machine's own file names the email on Cloud.
  const repo = join(root, "project");
  execFileSyncRetrying("git", ["init", "--quiet", "-b", "main", repo], { windowsHide: true });
  const put = (args: string[], input: string): string => execFileSyncRetrying("git", args, { cwd: repo, input, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] }).toString("utf8").trim();
  const shared = put(["hash-object", "-w", "--stdin"], JSON.stringify({ project: "demo", host: { kind: "jira", site, project: "DEMO", deployment, write: true } }) + "\n");
  const format = put(["hash-object", "-w", "--stdin"], "1\n");
  const folder = put(["mktree"], `100644 blob ${shared}\tsettings.json\n`);
  const tree = put(["mktree"], `100644 blob ${format}\tformat\n040000 tree ${folder}\tsettings\n`);
  put(["update-ref", "refs/scopesoup/meta", put(["-c", "user.name=Robin", "-c", "user.email=robin@example.invalid", "commit-tree", tree, "-m", "Settings"], "")], "");
  writeFileSync(file, JSON.stringify({ machineName: "robins-laptop", repoPath: repo, ...(deployment === "cloud" ? { jira: { email: "robin.person@example.test" } } : {}) }));
  const out: string[] = [];
  const err: string[] = [];
  const settings: HostSettings[] = [];
  const deps: CliDeps = {
    env: { SCOPESOUP_CONFIG: file }, cwd: repo, home: null, out: (line) => out.push(line), err: (line) => err.push(line),
    makeHosts: (given) => (settings.push(given), [w.robin()]), now: () => new Date(w.clock.ms), sleep: async () => {}, remoteUrlOf: () => "", ...over,
  };
  return { out, err, settings, run: (...argv: string[]) => runItemCli(argv, deps) };
}

for (const deployment of ["cloud", "datacenter"] as const) {
  describe(`item commands on Jira ${deployment}`, { concurrency: 4 }, () => {
    test("new, claim, list and release from the command line: the assignee is Robin's hold", async () => {
      const w = writable(deployment);
      const c = cli(w, deployment);
      assert.equal(await c.run("new", "--title", "Sort the tide table", "--body", "Fixes the order, ask @robin.", "--priority", "critical", "--label", "data", "--claim"), 0, c.err.join("\n"));
      assert.equal(c.settings[0]?.personCommands, true);
      assert.match(c.out.at(-1)!, /^Filed DEMO-7: Sort the tide table\. Note: Robin Example holds it; Scope Soup will not start it$/);
      const created = w.fake.issues.get("DEMO-7")!;
      assert.equal(created.fields.assignee?.displayName, "Robin Example");
      assert.equal(created.fields.priority?.name, "High");
      assert.deepEqual(created.fields.labels, ["data"]);
      // The text went out inert: the closing keyword and the mention are broken by a zero-width space.
      const description = JSON.stringify(created.fields.description);
      assert.ok(description.includes("F​ixes") || description.includes("F\\u200bixes"), description);
      assert.ok(!description.includes("@robin"), description);

      assert.equal(await c.run("list", "--mine"), 0, c.err.join("\n"));
      assert.match(c.out.at(-1)!, /^DEMO-7\s+todo\s+critical\s+held by Robin Example \(you\)\s+Sort the tide table$/);
      assert.equal(await c.run("claim", "demo-5"), 0, c.err.join("\n"));
      assert.match(c.out.at(-1)!, /^Robin Example holds DEMO-5 "Colour the cards" \(assigned on Jira\)\. Scope Soup will not start it\.$/);
      assert.equal(await c.run("claim", "DEMO-5"), 0);
      assert.match(c.out.at(-1)!, /is already yours/);
      assert.equal(await c.run("release", "DEMO-5", "--note", "Not today."), 0, c.err.join("\n"));
      assert.equal(w.fake.issues.get("DEMO-5")!.fields.assignee, null);
      assert.match(JSON.stringify(w.fake.comments["DEMO-5"]?.at(-1)?.body), /Released by Robin Example: Not today\./);
      assert.equal(await c.run("list", "--free"), 0);
      assert.ok(c.out.some((line) => /^DEMO-5\s+todo\s+minor\s+free\s+Colour the cards$/.test(line)), c.out.join("\n"));

      assert.equal(await c.run("claim", "DEMO-5", "--as", "Kim"), 1);
      assert.match(c.err.at(-1)!, /On Jira the item is held by the token's account, Robin Example; --as Kim cannot hold it\./);
      assert.equal(await c.run("claim", "five"), 1);
      assert.match(c.err.at(-1)!, /"five" is not a Jira issue key/);
    });

    test("an agent's claim, written by the server's token, refuses Robin's claim and release", async () => {
      const w = writable(deployment);
      assert.deepEqual(await w.write.claim!(w.ref("DEMO-5"), { until: UNTIL, shown: "laptop-a" }), { won: true });
      const { backend } = await robinBackend(w);
      await assert.rejects(claimItem(backend, "DEMO-5"), (error) => error instanceof Refused && /held by scopesoup on laptop-a, an agent that is working on it/.test(error.message));
      await assert.rejects(releaseItem(backend, "DEMO-5"), (error) => error instanceof Refused && /an agent that is working on it/.test(error.message));
      assert.equal(w.fake.issues.get("DEMO-5")!.fields.assignee, null);
      assert.deepEqual((await listItems(backend, {})).filter((row) => row.id === "DEMO-5").map((row) => [row.holder, row.holderKind]), [["scopesoup on laptop-a", "agent"]]);
      // And the server's own claim sees Robin's assignee first: the agent does not take an issue she holds.
      await claimItem(backend, "DEMO-3");
      assert.equal((await w.write.claim!(w.ref("DEMO-3"), { until: UNTIL, shown: "laptop-a" })).won, false);
    });

    test("an agent's claim written while Robin's assignee settles stands: she is unassigned again", async () => {
      const w = writable(deployment);
      const self = deployment === "cloud" ? "000000:scopesoup-0002" : "scopesoup";
      const c = cli(w, deployment, {
        // The agent's claim lands during the wait, as one written just before the assignee showed would.
        sleep: async () => void (w.fake.issueProperties["DEMO-5"] = { [CLAIM_PROPERTY]: { v: 1, by: self, claims: [{ machine: "desk", until: UNTIL, released: false, at: "2026-11-21T09:00:00.000Z", nonce: "n1" }] } }),
      });
      assert.equal(await c.run("claim", "DEMO-5"), 1);
      assert.match(c.err.at(-1)!, /DEMO-5 "Colour the cards" was taken by scopesoup on desk first, an agent that is working on it\. It is not yours\./);
      assert.equal(w.fake.issues.get("DEMO-5")!.fields.assignee, null);
    });

    test("hand back: a comment names the branch and its tip, Robin is unassigned, and the server adopts it", async () => {
      const w = writable(deployment);
      const { backend } = await robinBackend(w);
      await assert.rejects(handBackItem(backend, "DEMO-5"), (error) => error instanceof Refused && /not held by anyone/.test(error.message));
      await claimItem(backend, "DEMO-5");
      const done = await handBackItem(backend, "DEMO-5", { note: "Fixes the colours, ask @kim." });
      assert.match(done.message, /^Handed back DEMO-5 "Colour the cards" on scopesoup\/DEMO-5 \(bbbbbbbbb\), with a comment on Jira, and unassigned\./);
      assert.equal(w.fake.issues.get("DEMO-5")!.fields.assignee, null);
      const comment = w.fake.comments["DEMO-5"]!.at(-1)!;
      assert.equal(comment.author?.displayName, "Robin Example");
      const property = w.fake.commentProperties[comment.id]![COMMENT_PROPERTY] as Record<string, unknown>;
      assert.deepEqual({ ...property, note: undefined }, { v: 1, kind: "handback", sha: SHA, branch: "scopesoup/DEMO-5", note: undefined });
      assert.ok(!String(property.note).includes("@kim") && !String(property.note).includes("Fixes"));

      // Scope Soup's server host, with its own token, reads the hand-back from a person of the project and adopts it.
      const item = (await w.host.work.getWork(w.ref("DEMO-5")))!;
      assert.equal(item.handedBack?.sha, SHA);
      assert.equal(item.handedBack?.branch, "scopesoup/DEMO-5");
      assert.equal(item.handedBack?.by.name, "Robin Example");
      const found = findHandbacks([item], []);
      assert.deepEqual(found.map((each) => [each.key, each.branch, each.sha, each.by]), [[`jira:work:DEMO-5@${SHA}`, "scopesoup/DEMO-5", SHA, "Robin Example"]]);
      assert.deepEqual((await listItems(backend, {})).filter((row) => row.id === "DEMO-5").map((row) => [row.free, row.inReview]), [[false, true]]);

      // Scope Soup's own later revision supersedes it.
      await w.write.logLine!(w.ref("DEMO-5"), { kind: "revision", fields: { sha: "c".repeat(40), branch: "scopesoup/DEMO-5" } });
      assert.equal((await w.host.work.getWork(w.ref("DEMO-5")))!.handedBack, undefined);
    });

    test("a hand-back comment by someone outside the project is a plain comment", async () => {
      const w = writable(deployment);
      const stranger = deployment === "cloud" ? { accountId: "000000:stranger-0009", displayName: "Stranger" } : { name: "stranger", displayName: "Stranger" };
      w.fake.comments["DEMO-5"] = [{ id: "39001", author: stranger, created: "2026-11-21T09:30:00.000+0000", body: deployment === "cloud" ? { version: 1, type: "doc", content: [] } : "" }];
      w.fake.commentProperties["39001"] = { [COMMENT_PROPERTY]: { v: 1, kind: "handback", sha: SHA, branch: "scopesoup/DEMO-5" } };
      assert.equal((await w.host.work.getWork(w.ref("DEMO-5")))!.handedBack, undefined);
    });

    test("new without writes, and new and claim with nothing to write on, are refused", async () => {
      const w = writable(deployment);
      const { backend } = await robinBackend(w);
      const readOnly: Backend = { ...backend, write: {} };
      await assert.rejects(createItem(readOnly, { title: "A" }), (error) => error instanceof Refused && /read-only here/.test(error.message));
      await assert.rejects(claimItem(readOnly, "DEMO-5"), (error) => error instanceof Refused && /read-only here/.test(error.message));
      await assert.rejects(createItem(backend, { title: " " }), (error) => error instanceof Refused && /Give the item a title/.test(error.message));
    });
  });
}
