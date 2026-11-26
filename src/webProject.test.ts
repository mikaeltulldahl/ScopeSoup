// The board's tab says which project it is (web/src/project.ts). All names are synthetic.

import assert from "node:assert/strict";
import { test } from "node:test";
import { checkRename, checkoutHover, faviconHref, projectColour, tabTitle } from "../web/src/project.ts";

test("the tab title is Scope Soup and the project's name, or Scope Soup alone without one", () => {
  assert.equal(tabTitle("tidepool"), "Scope Soup · tidepool");
  assert.equal(tabTitle("  tidepool "), "Scope Soup · tidepool");
  assert.equal(tabTitle(""), "Scope Soup");
  assert.equal(tabTitle(undefined), "Scope Soup");
});

test("a project's colour is the same for the same name, differs between names, and colours the tab icon", () => {
  assert.equal(projectColour("tidepool"), projectColour("tidepool"));
  assert.notEqual(projectColour("tidepool"), projectColour("harbour"));
  assert.match(projectColour("tidepool"), /^hsl\(\d{1,3} 65% 55%\)$/);
  assert.ok(decodeURIComponent(faviconHref(projectColour("tidepool"))).includes(projectColour("tidepool")));
});

test("the folder button's hover names the path and the remote, and falls back to the plain words without them", () => {
  assert.equal(checkoutHover({ checkoutPath: "C:/work/tidepool", remote: "sam/tidepool" }), "Open C:/work/tidepool\nRemote: sam/tidepool");
  assert.equal(checkoutHover({ checkoutPath: "/w/t" }), "Open /w/t");
  assert.match(checkoutHover({ remote: "origin" }), /^Opens the folder you work on [^\n]*\nRemote: origin$/);
});

test("a typed project name is trimmed; empty, too long and unchanged names are not saved", () => {
  assert.deepEqual(checkRename("  harbour ", "tidepool"), { name: "harbour" });
  assert.deepEqual(checkRename(" tidepool", "tidepool"), { same: true });
  assert.ok("problem" in checkRename("   ", "tidepool"));
  assert.ok("problem" in checkRename("x".repeat(61), "tidepool"));
});
