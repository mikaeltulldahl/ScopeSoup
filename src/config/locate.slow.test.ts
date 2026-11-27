// Commands find the project's config from the git repository they run in, matched against the configs this machine knows.
// Real git in temp folders; the home is a temp folder passed explicitly, never this machine's.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, test } from "node:test";
import { findConfig, isKnown, knownConfigs, knownConfigsPath, registerConfig, unregisterConfig } from "./locate.ts";
import { register } from "./register.ts";

const root = realpathSync.native(mkdtempSync(join(tmpdir(), "scopesoup-locate-")));
after(() => rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }));
// The folder "outside any project" must not find a repository above the temp folder.
process.env.GIT_CEILING_DIRECTORIES = root;

const git = (cwd: string, ...args: string[]): string =>
  execFileSync("git", args, { cwd, encoding: "utf8", windowsHide: true, stdio: ["ignore", "pipe", "pipe"] }).trim();

/** A project: the person's clone, a bare remote and Scope Soup's clone of it. */
function project(name: string): { mine: string; remote: string; scopesoup: string } {
  const mine = join(root, `${name}-mine`);
  mkdirSync(mine);
  git(mine, "init", "-q", "-b", "main");
  git(mine, "-c", "user.name=T", "-c", "user.email=t@example.invalid", "commit", "-q", "--allow-empty", "-m", "first");
  const remote = join(root, `${name}.git`);
  git(root, "clone", "-q", "--bare", mine, remote);
  git(mine, "remote", "add", "origin", remote);
  const scopesoup = join(root, `${name}-scopesoup`);
  git(root, "clone", "-q", remote, scopesoup);
  return { mine, remote, scopesoup };
}

function configFile(folder: string, raw: Record<string, unknown>): string {
  const dir = join(root, folder);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, "scopesoup.config.json");
  writeFileSync(file, JSON.stringify({ version: 3, machineName: "laptop", ...raw }, null, 2));
  return file;
}

const a = project("shop");
const b = project("blog");
// Config A names the person's clone as ownClone and Scope Soup's clone relative to the config folder.
const configA = configFile("shop-config", { repoPath: "../shop-scopesoup", ownClone: a.mine });
// Config B names the person's clone in realPaths.
const configB = configFile("blog-config", { repoPath: b.scopesoup, realPaths: [b.mine] });
const home = join(root, "home");
mkdirSync(home);
registerConfig(home, configA);
registerConfig(home, configB);
const worktree = join(root, "shop-wt");
git(a.mine, "worktree", "add", "-q", "-b", "wt", worktree);
const elsewhere = join(root, "shop-other");
git(root, "clone", "-q", a.remote, elsewhere);
const outside = join(root, "outside");
mkdirSync(outside);
const sub = join(a.mine, "src", "deep");
mkdirSync(sub, { recursive: true });

const found = (cwd: string, more: { given?: string; env?: Record<string, string>; home?: string | null } = {}) =>
  findConfig({ cwd, env: more.env ?? {}, home: more.home === undefined ? home : more.home, ...(more.given ? { given: more.given } : {}) });

describe("finding the config from the repository", { concurrency: 1 }, () => {
  test("from a project's clone, a folder in it, a worktree of it, Scope Soup's clone and another clone of the same remote", () => {
    for (const cwd of [a.mine, sub, worktree, a.scopesoup, elsewhere]) assert.deepEqual(found(cwd), { ok: true, file: configA, how: "repository" }, cwd);
  });

  test("two projects on one machine each pick their own config", () => {
    assert.equal(found(a.mine).file, configA);
    assert.equal(found(b.mine).file, configB);
    assert.equal(found(b.scopesoup).file, configB);
  });

  test("outside any project, the command says so and names --config", () => {
    const result = found(outside);
    assert.equal(result.ok, false);
    assert.match(!result.ok ? result.error : "", /is not in a git repository.*--config/);
  });

  test("--config and SCOPESOUP_CONFIG win, and --config over SCOPESOUP_CONFIG; ./scopesoup.config.json over the list", () => {
    assert.deepEqual(found(a.mine, { given: configB }), { ok: true, file: configB, how: "option" });
    assert.deepEqual(found(a.mine, { env: { SCOPESOUP_CONFIG: configB } }), { ok: true, file: configB, how: "environment" });
    assert.deepEqual(found(a.mine, { given: configA, env: { SCOPESOUP_CONFIG: configB } }), { ok: true, file: configA, how: "option" });
    assert.deepEqual(found(outside, { given: "../blog-config/scopesoup.config.json" }), { ok: true, file: configB, how: "option" });
    const local = join(sub, "scopesoup.config.json");
    writeFileSync(local, "{}");
    try {
      assert.deepEqual(found(sub), { ok: true, file: local, how: "folder" });
    } finally {
      rmSync(local);
    }
  });

  test("two configs for the same repository are refused; none, or no home, too", () => {
    const twice = join(root, "home-twice");
    mkdirSync(twice);
    const second = configFile("shop-config-2", { repoPath: a.scopesoup });
    registerConfig(twice, configA);
    registerConfig(twice, second);
    const result = found(a.mine, { home: twice });
    assert.match(!result.ok ? result.error : "", /More than one config this machine knows.*shop-config.*shop-config-2.*--config/);
    const empty = join(root, "home-empty");
    mkdirSync(empty);
    assert.match((r => (!r.ok ? r.error : ""))(found(a.mine, { home: empty })), /No config this machine knows .* is for the repository at .*--config/);
    assert.match((r => (!r.ok ? r.error : ""))(found(a.mine, { home: null })), /not installed in a home.*--config/);
  });

  test("register and unregister keep each config once; a missing file is not registered", () => {
    const list = join(root, "home-list");
    mkdirSync(list);
    assert.equal(register(list, configA).ok, true);
    assert.match(register(list, configA).lines[0]!, /already/);
    assert.equal(register(list, join(root, "nope", "scopesoup.config.json")).ok, false);
    assert.equal(register(null, configA).ok, false);
    assert.deepEqual(knownConfigs(list), [configA]);
    assert.equal(isKnown(list, configA), true);
    assert.deepEqual(JSON.parse(readFileSync(knownConfigsPath(list), "utf8")), { configs: [configA] });
    assert.equal(unregisterConfig(list, configA), true);
    assert.equal(unregisterConfig(list, configA), false);
    assert.equal(found(a.mine, { home: list }).ok, false);
  });
});
