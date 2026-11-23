import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { compareVersions, parseVersion } from "./version.ts";
import { downloadAsset, latestRelease, readRelease } from "./releases.ts";
import { apiRelease, fakeFetch } from "./testRelease.ts";

const API = "https://api.example";
const LATEST = `${API}/repos/owner/scopesoup/releases/latest`;

describe("versions", () => {
  test("compare as numbers, not text", () => {
    assert.ok(compareVersions("0.10.0", "0.9.9") > 0);
    assert.ok(compareVersions("v1.2.3", "1.2.3") === 0);
    assert.ok(compareVersions("0.4.1", "0.5.0") < 0);
    assert.equal(parseVersion("1.2.3-rc.1"), null);
  });
});

describe("the update check against a fake releases API", { concurrency: 4 }, () => {
  test("reads the newest release, its notes, its zip and the zip's digest", async () => {
    const digest = "ab".repeat(32);
    const asked: { url: string; headers: Record<string, string> }[] = [];
    const fetch = fakeFetch({ [LATEST]: () => Response.json(apiRelease("0.6.0", `${API}/assets/1`, 1234, digest)) }, asked);
    const release = await latestRelease({ fetch, repo: "owner/scopesoup", api: API });
    assert.equal(release?.version, "0.6.0");
    assert.equal(release?.notes, "Notes for 0.6.0.");
    assert.deepEqual(release?.zip, { name: "scopesoup-0.6.0.zip", url: `${API}/assets/1`, size: 1234, sha256: digest });
    assert.equal(asked[0]?.headers.Authorization, undefined, "no token, none sent");
  });

  test("sends the token from the environment for a private repository, and says so when refused", async () => {
    const asked: { url: string; headers: Record<string, string> }[] = [];
    const fetch = fakeFetch({ [LATEST]: () => new Response("{}", { status: 404 }) }, asked);
    assert.equal(await latestRelease({ fetch, repo: "owner/scopesoup", api: API, token: "t0ken" }), null, "a repository without releases has none");
    assert.equal(asked[0]?.headers.Authorization, "Bearer t0ken");
    const refused = fakeFetch({ [LATEST]: () => new Response("{}", { status: 403 }) });
    await assert.rejects(latestRelease({ fetch: refused, repo: "owner/scopesoup", api: API }), /403.*SCOPESOUP_UPDATE_TOKEN/);
  });

  test("drafts, pre-releases and other tags are not releases", () => {
    assert.equal(readRelease({ ...apiRelease("0.6.0", "u", 1), draft: true }), null);
    assert.equal(readRelease({ ...apiRelease("0.6.0", "u", 1), prerelease: true }), null);
    assert.equal(readRelease({ ...apiRelease("0.6.0", "u", 1), tag_name: "nightly" }), null);
    assert.equal(readRelease({ ...apiRelease("0.6.0", "u", 1), assets: [] })?.zip, null);
  });

  test("a download whose size is not the one GitHub reported is refused", async () => {
    const fetch = fakeFetch({ [`${API}/assets/1`]: () => new Response(new Uint8Array(10)) });
    await assert.rejects(downloadAsset({ fetch, repo: "owner/scopesoup" }, { name: "z.zip", url: `${API}/assets/1`, size: 11 }), /10 bytes.*11/);
    assert.equal((await downloadAsset({ fetch, repo: "owner/scopesoup" }, { name: "z.zip", url: `${API}/assets/1`, size: 10 })).length, 10);
  });
});
