// The board's tab says which project it is (web/src/project.ts). All names are synthetic.

import assert from "node:assert/strict";
import { test } from "node:test";
import { faviconHref, projectColour, tabTitle } from "../web/src/project.ts";

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
