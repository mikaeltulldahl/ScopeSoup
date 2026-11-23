// The manifest: one line per thing Scope Soup made outside its config folder, appended, each thing once.

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, test } from "node:test";
import { linesToAdd, manifestPath, parseManifest, readManifest, recordInManifest } from "./manifest.ts";

const dir = mkdtempSync(join(tmpdir(), "scopesoup-manifest-"));
after(() => rmSync(dir, { recursive: true, force: true }));

describe("manifest", () => {
  test("lines are read leniently: unknown and broken lines are skipped, each thing once", () => {
    const text = [
      JSON.stringify({ kind: "ref", ref: "refs/scopesoup/meta", what: "settings", at: "2026-11-23T10:00:00.000Z", by: "onboarding" }),
      "not json",
      JSON.stringify({ kind: "ref", ref: "refs/heads/main", what: "not Scope Soup's" }),
      JSON.stringify({ kind: "label", repo: "owner/name", name: "scopesoup:claimed", at: "x", by: "scopesoup" }),
      JSON.stringify({ kind: "label", repo: "Owner/Name", name: "ScopeSoup:Claimed", at: "y", by: "scopesoup" }),
      JSON.stringify({ kind: "something-new", path: "x" }),
      JSON.stringify({ kind: "project-file", path: "CLAUDE.md", change: "claude-md-section" }),
      "",
    ].join("\n");
    const entries = parseManifest(text);
    assert.deepEqual(entries.map((entry) => entry.kind), ["ref", "label", "project-file"]);
    assert.equal(entries[1]?.kind === "label" && entries[1].at, "x");
  });

  test("only what is new is appended", () => {
    const existing = parseManifest(JSON.stringify({ kind: "branch", branch: "scopesoup/onboard", what: "setup" }));
    const lines = linesToAdd(existing, [
      { kind: "branch", branch: "scopesoup/onboard", what: "again" },
      { kind: "folder", path: "/x/repo", what: "clone" },
      { kind: "folder", path: "/x/repo", what: "clone, twice" },
    ], "2026-11-23T10:00:00.000Z", "scopesoup");
    assert.equal(lines.length, 1);
    assert.deepEqual(JSON.parse(lines[0] ?? ""), { kind: "folder", path: "/x/repo", what: "clone", at: "2026-11-23T10:00:00.000Z", by: "scopesoup" });
  });

  test("recordInManifest appends beside the config file and leaves out folders inside the config folder", () => {
    const config = join(dir, "shop-scopesoup");
    mkdirSync(config);
    const file = join(config, "scopesoup.config.json");
    writeFileSync(file, "{}\n");
    const outside = join(dir, "elsewhere", "repo");
    recordInManifest(file, [{ kind: "folder", path: join(config, "data"), what: "the data folder" }, { kind: "folder", path: outside, what: "Scope Soup's clone" }], "scopesoup", "t1");
    recordInManifest(file, [{ kind: "folder", path: outside, what: "Scope Soup's clone" }, { kind: "label", repo: "o/n", name: "scopesoup:claimed" }], "scopesoup", "t2");
    assert.equal(manifestPath(file), join(config, "scopesoup.manifest.jsonl"));
    assert.equal(readFileSync(manifestPath(file), "utf8").trim().split("\n").length, 2);
    assert.deepEqual(readManifest(manifestPath(file)).map((entry) => [entry.kind, entry.at]), [["folder", "t1"], ["label", "t2"]]);
  });

  test("recordInManifest never throws, even when the config folder is not there", () => {
    assert.deepEqual(recordInManifest(join(dir, "missing", "scopesoup.config.json"), [{ kind: "ref", ref: "refs/scopesoup/meta", what: "x" }], "scopesoup"), []);
  });
});
