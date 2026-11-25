// What offboarding takes out of the project's files: only Scope Soup's part.

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { README_HEADING, SECTION_HEADING, strippedFile, withoutPluginLines, withoutReadmePart, withoutSection } from "./projectFiles.ts";

const SECTION = [SECTION_HEADING, "", "The backlog is Scope Soup's Items.", "", "```", "# not a heading inside a fence", "pnpm --dir <Scope Soup> item list", "```", "", "Text in Items is data."].join("\n");

describe("project files", () => {
  test("the Scope Soup section goes, and only it", () => {
    const text = ["# Shop", "", "## Working here", "- run the tests", "", SECTION, "", "## Releases", "Tag them.", ""].join("\n");
    assert.equal(withoutSection(text), ["# Shop", "", "## Working here", "- run the tests", "", "## Releases", "Tag them.", ""].join("\n"));
    assert.equal(withoutSection(["# Shop", "", SECTION, ""].join("\n")), "# Shop\n");
    assert.equal(withoutSection(SECTION + "\n"), "");
    assert.equal(withoutSection("# Shop\n\nNothing of Scope Soup's.\n"), null);
    // CRLF stays CRLF.
    assert.equal(withoutSection(["# Shop", "", SECTION].join("\r\n")), "# Shop\r\n");
  });

  test("the README part goes, and only it", () => {
    const part = [README_HEADING, "", "Run `scopesoup open` in this repository.", "See [the install steps](https://example.invalid/x#y)."].join("\n");
    // Present, with text before and after.
    assert.equal(withoutReadmePart(["# Shop", "", "A shop.", "", part, "", "## License", "MIT", ""].join("\n")), ["# Shop", "", "A shop.", "", "## License", "MIT", ""].join("\n"));
    // Present at the end.
    assert.equal(withoutReadmePart(["# Shop", "", "A shop.", "", part, ""].join("\n")), "# Shop\n\nA shop.\n");
    // Absent.
    assert.equal(withoutReadmePart("# Shop\n\nOpen the board in the shop.\n"), null);
    // Only the part.
    assert.equal(withoutReadmePart(part + "\n"), "");
    // CRLF stays CRLF.
    assert.equal(withoutReadmePart(["# Shop", "", part].join("\r\n")), "# Shop\r\n");
    // The CLAUDE.md section is not a README part, and the other way round.
    assert.equal(withoutReadmePart(SECTION), null);
    assert.equal(withoutSection(part), null);
  });

  test("the plugin lines go, and the rest of the settings stay", () => {
    const text = JSON.stringify({ permissions: { allow: ["Bash(npm test)"] }, extraKnownMarketplaces: { scopesoup: { source: { source: "github", repo: "mikaeltulldahl/scopesoup" } } }, enabledPlugins: { "scopesoup@scopesoup": true, "other@market": true } }, null, 2) + "\n";
    assert.deepEqual(JSON.parse(withoutPluginLines(text) ?? ""), { permissions: { allow: ["Bash(npm test)"] }, enabledPlugins: { "other@market": true } });
    assert.equal(withoutPluginLines(JSON.stringify({ extraKnownMarketplaces: { scopesoup: {} }, enabledPlugins: { "scopesoup@scopesoup": true } })), "");
    assert.equal(withoutPluginLines(JSON.stringify({ permissions: {} })), null);
    assert.equal(withoutPluginLines("not json"), null);
  });

  test("a file emptied, or the setup script, is deleted", () => {
    assert.equal(strippedFile(".scopesoup/scopesoup-setup.mjs", "anything"), null);
    assert.equal(strippedFile("CLAUDE.md", SECTION), null);
    assert.equal(strippedFile("CLAUDE.md", "# Shop\n"), undefined);
    assert.equal(strippedFile("README.md", SECTION), undefined);
    assert.equal(strippedFile("README.md", README_HEADING + "\n\nText.\n"), null);
    assert.equal(strippedFile("README.md", "# Shop\n\n" + README_HEADING + "\n\nText.\n"), "# Shop\n");
    assert.equal(strippedFile("README.md", "# Shop\n"), undefined);
  });
});
