// The board's themes (web/src/theme.ts): every neutral key has a word and a colour in every theme, the default is the theme with id default,
// the choice is remembered per viewer and nothing breaks without storage.

import assert from "node:assert/strict";
import { test } from "node:test";
import { LANE_TITLES } from "../src/core/lanes.ts";
import { COLOUR_VARS, LANE_KEYS, DEFAULT_THEME, THEMES, THEME_IDS, fill, itemNoun, readTheme, taglineAt, themeCss, writeTheme } from "../web/src/theme.ts";
import { faviconHref } from "../web/src/project.ts";

/** Words a theme may leave empty: flair only some themes have. */
const FLAIR = ["doneBadge", "sessionBadge", "staleBadge", "logoHover"];

const memory = () => {
  const map = new Map<string, string>();
  return { getItem: (key: string) => map.get(key) ?? null, setItem: (key: string, value: string) => void map.set(key, value), removeItem: (key: string) => void map.delete(key) };
};
const broken = { getItem: (): string | null => { throw new Error("blocked"); }, setItem: (): void => { throw new Error("blocked"); }, removeItem: (): void => { throw new Error("blocked"); } };

test("the default theme is the one called default, and default and Plain exist", () => {
  assert.equal(DEFAULT_THEME, "default");
  assert.deepEqual([...THEME_IDS], ["default", "plain", "graveyard"]);
});

test("every theme has a non-empty word for every key, a colour for every variable, and a logo", () => {
  const keys = Object.keys(THEMES[DEFAULT_THEME].words).sort();
  for (const id of THEME_IDS) {
    const theme = THEMES[id];
    assert.deepEqual(Object.keys(theme.words).sort(), keys, id);
    for (const [key, word] of Object.entries(theme.words)) if (typeof word === "string" && !FLAIR.includes(key) && key !== "abandonedIcon" && key !== "mergeLaneIcon") assert.ok(word.trim() !== "", `${id}.${key}`);
    for (const name of COLOUR_VARS) assert.ok(theme.light[name], `${id} light ${name}`);
    for (const name of Object.keys(theme.dark)) assert.ok((COLOUR_VARS as readonly string[]).includes(name), `${id} dark ${name}`);
    for (const lane of LANE_KEYS) assert.ok(theme.words.lanes[lane].trim() !== "", `${id} lane ${lane}`);
    assert.ok(theme.words.abandoned.trim() !== "" && theme.words.itemOne !== "" && theme.words.itemMany !== "", id);
    assert.ok(theme.mark.length > 0 && theme.mark.some((shape) => shape.cls === "light"), id);
    assert.match(faviconHref("hsl(10 65% 55%)", id), /^data:image\/svg\+xml,/);
  }
});

test("the stylesheet has a light and a dark block for each theme", () => {
  const css = themeCss();
  for (const id of THEME_IDS) assert.equal(css.split(`:root[data-theme="${id}"]`).length - 1, 2, id);
});

test("the theme is remembered, an unknown or missing value is the default, and a storage that throws is fine", () => {
  const storage = memory();
  assert.equal(readTheme(storage), "default");
  writeTheme(storage, "plain");
  assert.equal(readTheme(storage), "plain");
  storage.setItem("scopesoup.theme", "nonsense");
  assert.equal(readTheme(storage), "default");
  assert.equal(readTheme(null), "default");
  assert.equal(readTheme(broken), "default");
  writeTheme(broken, "plain");
  writeTheme(null, "plain");
});

test("The default theme words the lanes as the core does, and Graveyard Shift has the approved words", () => {
  for (const lane of LANE_KEYS) assert.equal(THEMES.default.words.lanes[lane], LANE_TITLES[lane]);
  const graveyard = THEMES.graveyard.words;
  assert.deepEqual(Object.values(graveyard.lanes), ["Tip-offs", "Stakeout", "At large", "On the case", "Cross-examination", "Awaiting DNA", "Autopsy", "Laid to rest"]);
  assert.equal(graveyard.abandoned, "Cold case");
  assert.equal(THEMES.default.words.mergeLane, "Merge queue");
  assert.equal(graveyard.mergeLane, "Crime lab");
  assert.equal(graveyard.yourTurn, "Wanted for questioning");
  assert.equal(graveyard.itemOne, "case");
  assert.equal(graveyard.summaryTitle, "Coroner's report");
});

test("every word key is in every theme, and the default theme and Plain have no flair and read as the board always did", () => {
  const keys = Object.keys(THEMES.default.words).sort();
  for (const id of THEME_IDS) assert.deepEqual(Object.keys(THEMES[id].words).sort(), keys, id);
  for (const id of ["default", "plain"] as const) {
    const words = THEMES[id].words;
    for (const key of FLAIR) assert.equal((words as unknown as Record<string, string>)[key], "", `${id}.${key}`);
    assert.equal(words.turnYours, "your turn");
    assert.equal(words.turnOf, "{name}'s turn");
    assert.equal(words.emptyLane, "Nothing here.");
    assert.equal(words.itemOne, "item");
    assert.equal(words.itemMany, "items");
    assert.equal(words.taglineNight, words.tagline);
    assert.equal(words.summaryTitle, "Overnight summary");
    assert.equal(words.abandoned, "Abandoned");
  }
  assert.equal(THEMES.default.words.yourTurn, "Your turn");
  assert.equal(THEMES.default.words.startPage, "Overview");
  assert.equal(THEMES.default.words.tagline, "The light stays on while the agents work.");
});

test("Graveyard Shift has its flair, and the holes in its words fill", () => {
  const words = THEMES.graveyard.words;
  for (const key of FLAIR) assert.ok((words as unknown as Record<string, string>)[key]!.trim() !== "", key);
  assert.equal(fill(words.sessionBadge, { n: 2 }), "detective 2 on it");
  assert.match(fill(words.staleBadge, { date: "3 Nov" }), /^no leads since 3 Nov$/);
  assert.equal(fill(words.turnOf, { name: "Ann" }), "Ann is wanted");
  assert.equal(fill("{name} {other}", { name: "x" }), "x {other}");
  assert.notEqual(words.taglineNight, words.tagline);
  assert.equal(taglineAt(words, new Date(2026, 0, 1, 23, 30)), words.taglineNight);
  assert.equal(taglineAt(words, new Date(2026, 0, 1, 4, 59)), words.taglineNight);
  assert.equal(taglineAt(words, new Date(2026, 0, 1, 12, 0)), words.tagline);
  assert.equal(itemNoun(), "item");
});
