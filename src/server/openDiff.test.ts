// POST /api/open-diff against a temporary repository, with a fake launcher: no diff tool is ever started. The global git config
// names the tool; a repository config that names another one must not reach the arguments git is started with.

import assert from "node:assert/strict";
import { request } from "node:http";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { validateConfig } from "../config/validate.ts";
import { ref, T0, work } from "../core/testing.ts";
import { git, isolateGitConfig } from "../orchestrator/fixtures/git-env.ts";
import { itemDiff } from "../orchestrator/diff.ts";
import { openInDiffTool } from "../orchestrator/diffTool.ts";
import { workBranch, workspaceKey } from "../orchestrator/paths.ts";
import { realGit } from "../orchestrator/process.ts";
import type { Store } from "../store/store.ts";
import { openStore } from "../store/store.ts";
import type { ScopeSoupServer } from "./server.ts";
import { createServer } from "./server.ts";

const restore = isolateGitConfig();
const dir = mkdtempSync(join(tmpdir(), "scopesoup-opendiff-"));
let store: Store;
let server: ScopeSoupServer;
let base: string;
let clone: string;
const launched: { args: string[]; cwd: string }[] = [];
let launchFails = false;

before(async () => {
  const item = ref("work", 7);
  const repo = join(dir, "repo");
  mkdirSync(repo);
  git(repo, "init", "-q", "-b", "main");
  writeFileSync(join(repo, "keep.txt"), "one\ntwo\n");
  git(repo, "add", ".");
  git(repo, "commit", "-q", "-m", "first");
  const spaces = join(dir, "spaces");
  mkdirSync(spaces);
  clone = join(spaces, workspaceKey(item));
  git(dir, "clone", "-q", repo, clone);
  git(clone, "checkout", "-q", "-b", workBranch(item));
  writeFileSync(join(clone, "keep.txt"), "one\nTWO\n");
  git(clone, "add", ".");
  git(clone, "commit", "-q", "-m", "the change");
  const checked = validateConfig({ project: "tides", machineName: "laptop-a", repoPath: repo, workspacesDir: spaces }, dir);
  if (!checked.ok) assert.fail(checked.errors.join("\n"));
  store = openStore(":memory:");
  store.put(work(7), "sync", T0);
  store.put(work(8), "sync", T0);
  const deps = { store, config: () => checked.config, git: realGit, now: () => new Date(T0) };
  server = createServer({
    store,
    port: 0,
    now: () => new Date(T0),
    diff: (each) => itemDiff(deps, each),
    openDiff: (each, file) =>
      openInDiffTool(
        {
          ...deps,
          launch: async (args, cwd) => {
            if (launchFails) throw new Error("spawn git ENOENT");
            launched.push({ args, cwd });
          },
        },
        each,
        file,
      ),
  });
  base = (await server.start()).url;
});

after(async () => {
  await server.stop();
  store.close();
  rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  restore();
});

const post = (body: unknown, headers: Record<string, string> = {}) =>
  fetch(`${base}/api/open-diff`, { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body) });
const errorCode = async (response: Response) => ((await response.json()) as { error: { code: string; message: string } }).error;
const globalConfig = (text: string) => writeFileSync(process.env.GIT_CONFIG_GLOBAL!, text);

test("without a diff tool in the global git config, it says what to set and starts nothing", async () => {
  globalConfig("");
  git(clone, "config", "diff.tool", "evil");
  git(clone, "config", "difftool.evil.cmd", "echo EVIL");
  launched.length = 0;
  const response = await post({ ref: "demo:work:7" });
  assert.equal(response.status, 409);
  const error = await errorCode(response);
  assert.equal(error.code, "NO_DIFF_TOOL");
  assert.match(error.message, /git config --global diff\.tool vscode/);
  assert.deepEqual(launched, [], "the repository's own tool is not a tool");
});

test("the change opens with the global tool; the repository's tool settings are overridden on the command line", async () => {
  globalConfig('[diff]\n\ttool = good\n[difftool "good"]\n\tcmd = mine $LOCAL $REMOTE\n');
  git(clone, "config", "difftool.good.cmd", "echo REPO");
  git(clone, "config", "difftool.good.path", "/repo/path");
  git(clone, "config", "difftool.guiDefault", "true");
  launched.length = 0;
  const response = await post({ ref: "demo:work:7" });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { opened: true, tool: "good" });
  assert.equal(launched.length, 1);
  const { args, cwd } = launched[0]!;
  assert.equal(cwd, clone);
  const settings = args.filter((_, index) => args[index - 1] === "-c");
  assert.deepEqual(settings, [
    "diff.tool=good",
    "difftool.good.cmd=mine $LOCAL $REMOTE",
    "difftool.good.path=",
    "mergetool.good.cmd=",
    "mergetool.good.path=",
    "difftool.guiDefault=false",
  ]);
  const rest = args.slice(settings.length * 2);
  assert.deepEqual(rest.slice(0, 2), ["difftool", "--no-prompt"]);
  assert.match(rest[2]!, /^[0-9a-f]{40}$/);
  assert.match(rest[3]!, /^[0-9a-f]{40}$/);
  assert.equal(rest.length, 4, "no file: the whole change");
  assert.equal(JSON.stringify(args).includes("REPO"), false);
  const [event] = store.eventsOfKinds(["person.opened_diff"], 10);
  assert.equal(event?.subject, "demo:work:7");
  assert.equal((event?.data as { tool?: string } | undefined)?.tool, "good");
});

test("one file of the change opens as a literal path; a file the diff does not show is refused", async () => {
  launched.length = 0;
  const response = await post({ ref: "demo:work:7", file: "keep.txt" });
  assert.equal(response.status, 200);
  assert.deepEqual(launched[0]!.args.slice(-2), ["--", ":(literal)keep.txt"]);
  launched.length = 0;
  for (const file of ["other.txt", "../repo/keep.txt", "*", ":(top)keep.txt"]) {
    const refused = await post({ ref: "demo:work:7", file });
    assert.equal(refused.status, 400, file);
    assert.equal((await errorCode(refused)).code, "BAD_FILE", file);
  }
  assert.deepEqual(launched, []);
});

test("only an item and a file are read; another origin, a non-local host, an unknown item and an item without a branch are refused", async () => {
  launched.length = 0;
  const code = async (body: unknown, status: number, expected: string, headers?: Record<string, string>) => {
    const response = await post(body, headers);
    assert.equal(response.status, status, JSON.stringify(body));
    assert.equal((await errorCode(response)).code, expected, JSON.stringify(body));
  };
  await code({ ref: "demo:work:7", tool: "evil" }, 400, "BAD_BODY");
  await code({ ref: "demo:work:7", cmd: "calc" }, 400, "BAD_BODY");
  await code({ file: "keep.txt" }, 400, "REF_MISSING");
  await code({ ref: "demo:work:7", file: ["keep.txt"] }, 400, "BAD_FILE");
  await code({ ref: "demo:work:7" }, 403, "CROSS_ORIGIN", { Origin: "https://elsewhere.example" });
  await code({ ref: "demo:work:99" }, 404, "ITEM_NOT_FOUND");
  await code({ ref: "demo:work:8" }, 404, "NO_DIFF");
  assert.deepEqual(launched, []);
  assert.equal((await fetch(`${base}/api/open-diff`)).status, 404, "GET opens nothing");
});

test("a failed start of git is reported", async () => {
  launchFails = true;
  const response = await post({ ref: "demo:work:7" });
  launchFails = false;
  assert.equal(response.status, 500);
  assert.equal((await errorCode(response)).code, "OPEN_FAILED");
});

test("a request whose Host is not this machine (a rebinding page) is refused", async () => {
  launched.length = 0;
  const status = await new Promise<number>((resolve, reject) => {
    const asked = request(`${base}/api/open-diff`, { method: "POST", headers: { Host: "evil.example", "Content-Type": "application/json" } }, (response) => {
      response.resume();
      resolve(response.statusCode ?? 0);
    });
    asked.on("error", reject);
    asked.end(JSON.stringify({ ref: "demo:work:7" }));
  });
  assert.equal(status, 403);
  assert.deepEqual(launched, []);
});
