// The board says which project it is, and the server opens only the project's configured folders, by name. The opener is a
// fake: nothing is really opened. All names are synthetic.

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { T0 } from "../core/testing.ts";
import type { BoardView } from "../core/views.ts";
import type { ProjectConfig } from "../config/types.ts";
import { openStore } from "../store/store.ts";
import type { Store } from "../store/store.ts";
import { createServer } from "./server.ts";
import type { ScopeSoupServer } from "./server.ts";
import { fileManager, projectInfo, projectView, repositoryFromUrl } from "./project.ts";
import type { ProjectInfo } from "./project.ts";

test("owner/name is read from the usual remote URLs; only github.com gets a GitHub link", () => {
  assert.deepEqual(repositoryFromUrl("https://github.com/sam/tidepool.git"), { name: "sam/tidepool", github: "https://github.com/sam/tidepool" });
  assert.deepEqual(repositoryFromUrl("git@github.com:sam/tidepool.git"), { name: "sam/tidepool", github: "https://github.com/sam/tidepool" });
  assert.deepEqual(repositoryFromUrl("ssh://git@GitHub.com/sam/tidepool"), { name: "sam/tidepool", github: "https://github.com/sam/tidepool" });
  assert.deepEqual(repositoryFromUrl("git@forge.example:tide/tidepool.git"), { name: "tide/tidepool", github: null });
  assert.deepEqual(repositoryFromUrl("https://forge.example/group/tide/tidepool/"), { name: "tide/tidepool", github: null });
  assert.equal(repositoryFromUrl("C:/work/tidepool"), null);
  assert.equal(repositoryFromUrl("/srv/git/tidepool.git"), null);
  assert.equal(repositoryFromUrl("file:///srv/git/tidepool.git"), null);
  assert.equal(repositoryFromUrl(""), null);
});

test("the project's info: the GitHub host's repository, else the remote's, else the remote's name; the folders from the configuration", () => {
  const config = { project: "tidepool", repoPath: "/x/clone", remote: "origin", realPaths: ["/x/own", "/x/other"] } as unknown as ProjectConfig;
  const failing = () => {
    throw new Error("no such remote");
  };
  assert.deepEqual(projectInfo(config, "/x/conf/scopesoup.config.json", failing), { name: "tidepool", repository: "origin", github: null, remote: "origin", folders: { clone: "/x/clone", config: "/x/conf", checkout: "/x/own" } });
  assert.equal(projectInfo(config, "/x/c.json", () => "git@github.com:sam/tidepool.git").github, "https://github.com/sam/tidepool");
  assert.equal(projectInfo(config, "/x/c.json", () => "git@github.com:sam/tidepool.git").remote, "sam/tidepool", "a GitHub remote: owner/name");
  assert.equal(projectInfo(config, "/x/c.json", () => "https://tok:secret@forge.example/sam/tidepool.git").remote, "https://forge.example/sam/tidepool.git", "another host: the URL, without credentials");
  assert.equal(projectInfo(config, "/x/c.json", () => "/srv/git/tidepool.git").remote, "/srv/git/tidepool.git", "a local remote: its path");
  assert.equal(projectInfo({ ...config, remoteUrl: "git@forge.example:sam/tidepool.git" }, "/x/c.json", failing).remote, "git@forge.example:sam/tidepool.git");
  const github = projectInfo({ ...config, ownClone: "/x/mine", host: { kind: "github", repo: "sam/tidepool", write: false } }, "/x/c.json", failing);
  assert.equal(github.repository, "sam/tidepool");
  assert.equal(github.remote, "sam/tidepool");
  assert.equal(github.github, "https://github.com/sam/tidepool");
  assert.equal(github.folders.checkout, "/x/mine", "ownClone is the person's checkout, before realPaths");
  assert.deepEqual(projectView(github, (path) => path !== "/x/clone").folders, ["checkout", "config"], "only folders that are there are offered");
  assert.equal(projectView(github, () => true).checkoutPath, "/x/mine");
  assert.equal(projectView(github, (path) => path !== "/x/mine").checkoutPath, undefined, "no hover path for a folder that is not offered");
});

test("the file manager is Explorer, Finder or xdg-open", () => {
  assert.equal(fileManager("win32"), "explorer.exe");
  assert.equal(fileManager("darwin"), "open");
  assert.equal(fileManager("linux"), "xdg-open");
});

describe("POST /api/open-folder", () => {
  let store: Store;
  let server: ScopeSoupServer;
  let base: string;
  let dir: string;
  let info: ProjectInfo | null;
  const opened: string[] = [];
  let fail = false;

  before(async () => {
    dir = mkdtempSync(join(tmpdir(), "scopesoup-folders-"));
    for (const name of ["own", "clone", "conf"]) mkdirSync(join(dir, name));
    info = { name: "tidepool", repository: "sam/tidepool", github: "https://github.com/sam/tidepool", remote: "sam/tidepool", folders: { checkout: join(dir, "own"), clone: join(dir, "clone"), config: join(dir, "conf") } };
    store = openStore(":memory:");
    server = createServer({
      store,
      now: () => new Date(T0),
      port: 0,
      project: () => info,
      openFolder: async (path) => {
        if (fail) throw new Error("spawn explorer.exe ENOENT");
        opened.push(path);
      },
    });
    base = (await server.start()).url;
  });

  after(async () => {
    await server.stop();
    store.close();
    rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
  });

  const post = (body: unknown, headers: Record<string, string> = {}) =>
    fetch(`${base}/api/open-folder`, { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: typeof body === "string" ? body : JSON.stringify(body) });

  test("the board names the project and the folders it can open", async () => {
    const board = (await (await fetch(`${base}/api/board`)).json()) as BoardView;
    assert.deepEqual(board.project, { name: "tidepool", repository: "sam/tidepool", github: "https://github.com/sam/tidepool", folders: ["checkout", "clone", "config"], checkoutPath: join(dir, "own"), remote: "sam/tidepool" });
  });

  test("each configured folder is opened by its name, with the configuration's path", async () => {
    opened.length = 0;
    for (const [folder, sub] of [["checkout", "own"], ["clone", "clone"], ["config", "conf"]] as const) {
      const response = await post({ folder });
      assert.equal(response.status, 200, folder);
      assert.deepEqual(await response.json(), { opened: folder, path: join(dir, sub) });
    }
    assert.deepEqual(opened, [join(dir, "own"), join(dir, "clone"), join(dir, "conf")]);
  });

  test("anything else is refused and nothing is opened: a path, an unknown name, a missing or unconfigured folder, another origin", async () => {
    opened.length = 0;
    const refused = async (body: unknown, status: number, code: string, headers?: Record<string, string>) => {
      const response = await post(body, headers);
      assert.equal(response.status, status, JSON.stringify(body));
      assert.equal(((await response.json()) as { error: { code: string } }).error.code, code, JSON.stringify(body));
    };
    await refused({ folder: "checkout", path: "C:/Windows" }, 400, "BAD_FOLDER");
    await refused({ path: join(dir, "own") }, 400, "BAD_FOLDER");
    await refused({ folder: join(dir, "own") }, 400, "BAD_FOLDER");
    await refused({ folder: "../clone" }, 400, "BAD_FOLDER");
    await refused({ folder: "home" }, 400, "BAD_FOLDER");
    await refused({ folder: ["checkout"] }, 400, "BAD_FOLDER");
    await refused("not json", 400, "BAD_BODY");
    await refused({ folder: "checkout" }, 403, "CROSS_ORIGIN", { Origin: "https://elsewhere.example" });
    const saved = info;
    info = { ...saved!, folders: { clone: join(dir, "clone"), config: join(dir, "gone") } };
    await refused({ folder: "checkout" }, 404, "NO_FOLDER");
    await refused({ folder: "config" }, 404, "FOLDER_MISSING");
    info = null;
    await refused({ folder: "clone" }, 404, "NO_CONFIG");
    info = saved;
    assert.deepEqual(opened, []);
    assert.equal((await fetch(`${base}/api/open-folder`)).status, 404, "GET opens nothing");
  });

  test("a file manager that cannot be started is a 500 that says so", async () => {
    fail = true;
    const response = await post({ folder: "clone" });
    fail = false;
    assert.equal(response.status, 500);
    assert.match(((await response.json()) as { error: { message: string } }).error.message, /file manager.*ENOENT/);
  });
});
