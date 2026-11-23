import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { after, test } from "node:test";
import { levelChoices } from "./levels.ts";
import { programFound } from "./program.ts";
import { validateConfig } from "./validate.ts";

const dir = mkdtempSync(join(tmpdir(), "scopesoup-levels-"));
after(() => rmSync(dir, { recursive: true, force: true, maxRetries: 3 }));

function config(raw: Record<string, unknown>) {
  const result = validateConfig({ project: "demo", machineName: "laptop-a", repoPath: "repo", ...raw }, dir);
  assert.ok(result.ok, result.ok ? "" : result.errors.join("\n"));
  return result.config;
}

test("each level needs what the ones below it need: claude from level 1, a check command and remoteUrl at level 4", () => {
  const none = levelChoices(config({}), () => false);
  assert.deepEqual(none.map((choice) => choice.missing.length), [0, 1, 1, 1, 3]);
  const ready = levelChoices(config({ checkCommand: ["node", "--test"], remoteUrl: "git@example.invalid:demo.git" }), () => true);
  assert.ok(ready.every((choice) => choice.blocked === null));
  const noCheck = levelChoices(config({ remoteUrl: "git@example.invalid:demo.git" }), () => true);
  assert.equal(noCheck[4]?.blocked, "Level 4 needs a check command (checkCommand).");
  assert.ok(noCheck.slice(0, 4).every((choice) => choice.blocked === null));
  // What level 4 lacks the page asks for, so it can be picked; a missing claude it cannot ask for.
  assert.deepEqual([noCheck[4]?.asks, noCheck[4]?.pickable], [["checkCommand"], true]);
  assert.deepEqual([none[4]?.asks, none[4]?.pickable, none[1]?.pickable], [["checkCommand", "remoteUrl"], false, false]);
  assert.ok(ready.every((choice) => choice.pickable && choice.asks.length === 0));
});

test("level 4 with mergeQueue.ci github needs a GitHub host with writes on and the remote's URL, not a check command", () => {
  const remoteUrl = "git@example.invalid:demo.git";
  const off = levelChoices(config({ remoteUrl, mergeQueue: { ci: "github" }, host: { kind: "github", repo: "acme/widgets", write: false } }), () => true)[4];
  assert.equal(off?.blocked, 'Level 4 needs a GitHub host with writes on (host: kind "github", write true), since mergeQueue.ci is "github".');
  assert.deepEqual([off?.asks, off?.pickable], [[], false]);
  assert.match(off?.text ?? "", /a pull request for each batch, every check on GitHub waited for.*needs a GitHub host with writes on/);
  const on = levelChoices(config({ remoteUrl, mergeQueue: { ci: "github" }, host: { kind: "github", repo: "acme/widgets", write: true } }), () => true)[4];
  assert.deepEqual([on?.blocked, on?.pickable], [null, true]);
  const noUrl = levelChoices(config({ mergeQueue: { ci: "github" }, host: { kind: "github", repo: "acme/widgets", write: true } }), () => true)[4];
  assert.deepEqual(noUrl?.asks, ["remoteUrl"]);
});

test("the claude need looks up the configured program", () => {
  const asked: string[] = [];
  levelChoices(config({ claude: { path: "my-claude" } }), (command) => (asked.push(command), true));
  assert.deepEqual(asked, ["my-claude"]);
});

test("programFound: a path must be a file; a bare name is looked up on PATH, with PATHEXT on Windows", () => {
  const bin = join(dir, "bin");
  mkdirSync(bin);
  writeFileSync(join(bin, "tool"), "");
  writeFileSync(join(bin, "winTool.CMD"), "");
  assert.equal(programFound(join(bin, "tool")), true);
  assert.equal(programFound(join(bin, "absent")), false);
  assert.equal(programFound(bin), false);
  assert.equal(programFound("tool", { PATH: ["/nowhere", bin].join(delimiter) }, "linux"), true);
  assert.equal(programFound("absent", { PATH: bin }, "linux"), false);
  assert.equal(programFound("winTool", { PATH: bin, PATHEXT: ".EXE;.CMD" }, "win32"), true);
  assert.equal(programFound("winTool", { PATH: bin }, "linux"), false);
  assert.equal(programFound("", { PATH: bin }, "linux"), false);
});
