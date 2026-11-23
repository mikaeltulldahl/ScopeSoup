// The upgrade trial, automated: a stand-in v0.1.0, built from this checkout as a real release, is set up in a home, started
// by the launcher, finds a test release v0.2.0 on a fake releases API (a local server: nothing comes from the internet),
// gets it, restarts on it through the launcher, and goes back to v0.1.0. Board only: no project, no git, no agent.

import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { buildRelease, zipFolder } from "../release.ts";
import { extractZip, sha256 } from "./unpack.ts";
import type { UpgradeView } from "./view.ts";

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

function stopTree(child: ChildProcess): void {
  if (child.pid === undefined || child.exitCode !== null) return;
  try {
    if (process.platform === "win32") execFileSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore" });
    else process.kill(-child.pid, "SIGKILL");
  } catch {
    // Already gone.
  }
}

test("a stand-in v0.1.0 upgrades to a test release through the launcher, and goes back", { timeout: 240_000 }, async () => {
  const work = mkdtempSync(join(tmpdir(), "scopesoup-trial-150-"));
  let child: ChildProcess | undefined;
  let api: ReturnType<typeof createServer> | undefined;
  const output: string[] = [];
  try {
    // Two releases of this checkout, as `pnpm release` makes them, with a stand-in web app.
    const dist = join(work, "dist");
    mkdirSync(dist);
    writeFileSync(join(dist, "index.html"), "<html>stand-in</html>");
    const zips: Record<string, Uint8Array> = {};
    for (const version of ["0.1.0", "0.2.0"]) {
      const out = buildRelease({ outDir: join(work, "build", `scopesoup-${version}`), webDist: dist, version, commit: null, checked: false });
      const zip = zipFolder(out);
      assert.ok(zip, "a zip tool");
      zips[version] = new Uint8Array(readFileSync(zip));
    }

    // The first install: the v0.1.0 zip unpacked into the home, then `setup-home` (the launcher and the pointer).
    const home = join(work, "home");
    mkdirSync(home);
    writeFileSync(join(work, "v0.1.0.zip"), zips["0.1.0"]!);
    extractZip(join(work, "v0.1.0.zip"), home);
    const setup = execFileSync(process.execPath, ["--disable-warning=ExperimentalWarning", join(home, "scopesoup-0.1.0", "src", "scopesoup.ts"), "setup-home"], { encoding: "utf8" });
    assert.match(setup, /does not change it/);
    assert.equal(readFileSync(join(home, "current"), "utf8"), "scopesoup-0.1.0");

    // The fake releases API serves v0.2.0 and its zip.
    const testZip = zips["0.2.0"]!;
    api = createServer((request, response) => {
      const base = `http://127.0.0.1:${(api!.address() as AddressInfo).port}`;
      if (request.url === "/repos/owner/scopesoup/releases/latest") {
        response.setHeader("Content-Type", "application/json");
        response.end(JSON.stringify({ tag_name: "v0.2.0", draft: false, prerelease: false, body: "The test release.", html_url: `${base}/v0.2.0`, published_at: "2026-11-20T10:00:00Z", assets: [{ name: "scopesoup-0.2.0.zip", url: `${base}/assets/2`, size: testZip.length, digest: `sha256:${sha256(testZip)}` }] }));
      } else if (request.url === "/assets/2") {
        response.end(testZip);
      } else {
        response.statusCode = 404;
        response.end();
      }
    });
    await new Promise<void>((resolve) => api!.listen(0, "127.0.0.1", resolve));
    const apiUrl = `http://127.0.0.1:${(api.address() as AddressInfo).port}`;

    // Started by the launcher, board only, on a port of its own.
    const port = await freePort();
    const env: NodeJS.ProcessEnv = {};
    for (const [key, value] of Object.entries(process.env)) if (!key.startsWith("SCOPESOUP_")) env[key] = value;
    Object.assign(env, { SCOPESOUP_DATA: join(work, "data"), SCOPESOUP_CONFIG: join(work, "no-config.json"), SCOPESOUP_PORT: String(port), SCOPESOUP_UPDATE_API: apiUrl, SCOPESOUP_UPDATE_REPO: "owner/scopesoup" });
    child = process.platform === "win32"
      ? spawn("cmd.exe", ["/d", "/c", join(home, "bin", "scopesoup.cmd"), "start"], { cwd: work, env, windowsHide: true })
      : spawn("sh", [join(home, "bin", "scopesoup"), "start"], { cwd: work, env, detached: true });
    child.stdout?.on("data", (chunk: Buffer) => output.push(chunk.toString()));
    child.stderr?.on("data", (chunk: Buffer) => output.push(chunk.toString()));
    const board = `http://127.0.0.1:${port}`;
    const read = async (): Promise<UpgradeView | null> => {
      try {
        const response = await fetch(`${board}/api/upgrade`, { signal: AbortSignal.timeout(2000) });
        return response.ok ? ((await response.json()) as UpgradeView) : null;
      } catch {
        return null;
      }
    };
    const until = async (what: string, ok: (view: UpgradeView) => boolean, ms = 60_000): Promise<UpgradeView> => {
      const end = Date.now() + ms;
      while (Date.now() < end) {
        const view = await read();
        if (view && ok(view)) return view;
        if (child?.exitCode !== null) assert.fail(`The launcher exited (${child?.exitCode}) waiting for ${what}:\n${output.join("")}`);
        await new Promise((resolve) => setTimeout(resolve, 300));
      }
      return assert.fail(`Timed out waiting for ${what}:\n${output.join("")}`);
    };
    const post = async (what: string): Promise<UpgradeView> => (await (await fetch(`${board}/api/upgrade/${what}`, { method: "POST", headers: { Origin: board } })).json()) as UpgradeView;

    const first = await until("v0.1.0 to answer", (view) => view.version === "0.1.0");
    assert.equal(first.install, "release");
    const checked = await post("check");
    assert.equal(checked.available, true);
    assert.equal(checked.latest?.version, "0.2.0");
    assert.equal(checked.getLatest.can, true, checked.getLatest.why);

    assert.equal((await post("get")).task?.kind, "upgrade");
    const upgraded = await until("v0.2.0 after Get latest", (view) => view.version === "0.2.0");
    assert.equal(readFileSync(join(home, "current"), "utf8"), "scopesoup-0.2.0");
    assert.deepEqual(upgraded.back, { version: "0.1.0", newer: false, can: true });
    assert.ok(existsSync(join(home, "backups", "before-scopesoup-0.2.0", "scopesoup.sqlite")), "the database was copied before the switch");
    assert.ok(existsSync(join(home, "scopesoup-0.1.0")), "the old version stays for Go back");

    assert.equal((await post("back")).task?.kind, "back");
    const back = await until("v0.1.0 after Go back", (view) => view.version === "0.1.0");
    assert.equal(readFileSync(join(home, "current"), "utf8"), "scopesoup-0.1.0");
    assert.equal(back.back?.version, "0.2.0");
    assert.equal(back.back?.newer, true);
  } finally {
    if (child) stopTree(child);
    await new Promise<void>((resolve) => (api ? api.close(() => resolve()) : resolve()));
    rmSync(work, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
  }
});
