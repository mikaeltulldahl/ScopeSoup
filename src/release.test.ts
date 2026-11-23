import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { buildRelease, foreignImports, importsOf } from "./release.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

test("importsOf finds static, re-exported and dynamic imports", () => {
  const source = [
    'import { a } from "node:fs";', 'import type { B } from "./b.ts";', 'export * from "left-pad";',
    'import "side-effect";', 'const m = await import("lazy");',
  ].join("\n");
  assert.deepEqual(importsOf(source), ["node:fs", "./b.ts", "left-pad", "side-effect", "lazy"]);
});

test("the server sources import only Node built-ins and each other (nothing from devDependencies)", () => {
  const dev = Object.keys((JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as { devDependencies: object }).devDependencies);
  const bad = foreignImports(join(ROOT, "src")).filter((b) => !b.file.endsWith(".test.ts"));
  assert.deepEqual(bad, [], `packages imported at run time (dev: ${dev.join(", ")})`);
});

test("a release holds sources without tests, prompts, the web app and the start scripts", () => {
  const work = mkdtempSync(join(tmpdir(), "scopesoup-release-"));
  try {
    const dist = join(work, "dist");
    mkdirSync(dist);
    writeFileSync(join(dist, "index.html"), "<html></html>");
    const out = buildRelease({ outDir: join(work, "out"), webDist: dist });
    for (const file of ["src/main.ts", "prompts/triage.md", "web/dist/index.html", "package.json", "scopesoup.cmd", "scopesoup.sh", "LICENSE"]) {
      assert.ok(existsSync(join(out, file)), file);
    }
    assert.ok(!existsSync(join(out, "src", "release.test.ts")));
    assert.ok(!existsSync(join(out, "node_modules")));
    // What the onboarding skill reads from the install.
    for (const file of ["plugins/scopesoup/claude-md-section.md", "docs/RUNNING.md"]) {
      assert.ok(existsSync(join(out, file)), file);
    }
    const pkg = JSON.parse(readFileSync(join(out, "package.json"), "utf8")) as { scripts: Record<string, string> };
    assert.equal(pkg.scripts["web:build"], undefined);
    assert.equal(pkg.scripts["install"], undefined);
    // The commands `pnpm --dir <release>` runs, each pointing at a file the release holds.
    const scripts = pkg.scripts;
    for (const name of ["start", "item", "config:check", "meta:accept"]) {
      const file = scripts[name]?.split(" ").pop() ?? "";
      assert.ok(existsSync(join(out, file)), `${name} -> ${file}`);
    }
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

test("a release without a built web app is refused", () => {
  const work = mkdtempSync(join(tmpdir(), "scopesoup-release-"));
  try {
    assert.throws(() => buildRelease({ outDir: join(work, "out"), webDist: join(work, "none") }), /pnpm web:build/);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});
