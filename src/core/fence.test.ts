import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { FENCE_LINES, FENCE_OUTSIDE_FILES, fenceBreach, insideNamed, proposedSplit } from "./fence.ts";

describe("the fence", { concurrency: 4 }, () => {
  test("a path is inside when it is named, under a named folder, matched by a glob, or beside a named file", () => {
    const named = ["src/day/SunRow.tsx", "src/tides/", "docs/*.md", "web/**/*.css"];
    for (const path of ["src/day/SunRow.tsx", "src/day/SunRow.test.tsx", "src/tides/table.ts", "src/tides/deep/x.ts", "docs/RUNNING.md", "web/src/a/b.css", "./src\\tides\\y.ts"]) {
      assert.equal(insideNamed(path, named), true, path);
    }
    for (const path of ["src/night/Moon.tsx", "docs/sub/a.md", "src/tidesX/a.ts", "web/a.ts", "README.md"]) {
      assert.equal(insideNamed(path, named), false, path);
    }
    // A named file at the root does not let in every file at the root.
    assert.equal(insideNamed("package.json", ["README.md"]), false);
  });

  test("a change inside the triage's paths and size passes", () => {
    const change = [{ path: "src/day/SunRow.tsx", lines: 120 }, { path: "src/day/SunRow.test.tsx", lines: 80 }, { path: "docs/RUNNING.md", lines: 4 }];
    assert.equal(fenceBreach("small", ["src/day/SunRow.tsx"], change), null);
  });

  test("no named paths: the fence does not apply, however large", () => {
    const change = Array.from({ length: 40 }, (_, index) => ({ path: `src/x${index}.ts`, lines: 500 }));
    assert.equal(fenceBreach("small", [], change), null);
    assert.equal(fenceBreach("small", ["  "], change), null);
  });

  test(`more than ${FENCE_OUTSIDE_FILES} files outside the paths trips it; that many does not`, () => {
    const outside = (count: number) => Array.from({ length: count }, (_, index) => ({ path: `src/far${index}/a.ts`, lines: 1 }));
    const inside = [{ path: "src/day/SunRow.tsx", lines: 10 }];
    assert.equal(fenceBreach("medium", ["src/day/"], [...inside, ...outside(FENCE_OUTSIDE_FILES)]), null);
    const breach = fenceBreach("medium", ["src/day/"], [...inside, ...outside(FENCE_OUTSIDE_FILES + 1)]);
    assert.deepEqual([breach?.tooWide, breach?.tooLarge, breach?.outside.length, breach?.inside], [true, false, FENCE_OUTSIDE_FILES + 1, ["src/day/SunRow.tsx"]]);
  });

  test("more changed lines than the size allows trips it; unknown lines compare only the paths", () => {
    const change = [{ path: "src/day/SunRow.tsx", lines: FENCE_LINES.small + 1 }];
    const breach = fenceBreach("small", ["src/day/SunRow.tsx"], change);
    assert.deepEqual([breach?.tooWide, breach?.tooLarge, breach?.lines, breach?.limit], [false, true, FENCE_LINES.small + 1, FENCE_LINES.small]);
    assert.equal(fenceBreach("medium", ["src/day/SunRow.tsx"], change), null);
    assert.equal(fenceBreach("small", ["src/day/SunRow.tsx"], [{ path: "src/day/SunRow.tsx" }]), null);
  });

  test("what a person saw and let go on widens the fence; a change that grows past it again trips it", () => {
    const change = [{ path: "src/day/SunRow.tsx", lines: 500 }, ...Array.from({ length: 7 }, (_, index) => ({ path: `lib/x${index}.ts`, lines: 10 }))];
    const seen = { paths: change.map((file) => file.path), lines: 570 };
    assert.notEqual(fenceBreach("small", ["src/day/SunRow.tsx"], change), null);
    assert.equal(fenceBreach("small", ["src/day/SunRow.tsx"], change, seen), null);
    assert.equal(fenceBreach("small", ["src/day/SunRow.tsx"], [...change, { path: "src/day/More.tsx", lines: 1 }], seen)?.tooLarge, true);
  });

  test("the proposed split: the part inside the paths, then the outside by folder, at most four parts", () => {
    const change = [
      { path: "src/day/SunRow.tsx", lines: 40 },
      ...["a", "b", "c"].map((name) => ({ path: `src/night/${name}.ts`, lines: 10 })),
      ...["a", "b"].map((name) => ({ path: `lib/tide/${name}.ts`, lines: 5 })),
      { path: "tools/gen.ts", lines: 3 }, { path: "web/x/y.css", lines: 2 },
    ];
    const breach = fenceBreach("small", ["src/day/"], change)!;
    assert.deepEqual(proposedSplit(breach, change), [
      { label: "the triage's paths", files: ["src/day/SunRow.tsx"], lines: 40 },
      { label: "src/night", files: ["src/night/a.ts", "src/night/b.ts", "src/night/c.ts"], lines: 30 },
      { label: "lib/tide", files: ["lib/tide/a.ts", "lib/tide/b.ts"], lines: 10 },
      { label: "the rest", files: ["tools", "web/x"].flatMap((folder) => change.filter((file) => file.path.startsWith(`${folder}/`)).map((file) => file.path)), lines: 5 },
    ]);
  });

  test("only larger: the split is the change by folder", () => {
    const change = [{ path: "src/day/a.ts", lines: 200 }, { path: "src/day/b.ts", lines: 200 }, { path: "docs/DAY.md", lines: 20 }];
    const breach = fenceBreach("small", ["src/day/", "docs/"], change)!;
    assert.deepEqual(proposedSplit(breach, change).map((part) => [part.label, part.lines]), [["src/day", 400], ["docs", 20]]);
  });
});
