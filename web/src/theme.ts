// Themes. The code names things neutrally; a theme supplies the words the board shows and its look (colours, the logo
// drawing, the tab icon). The choice is the viewer's own, kept in this browser (localStorage), so it needs no config key.
// To add a theme: add its id to THEME_IDS and one entry to THEMES; the test checks that every key is filled.
// Pure (no DOM at import), so src/webTheme.test.ts can test it without a browser.

import type { HeldStorage } from "./heldAnswers.ts";
import { browserStorage } from "./heldAnswers.ts";

export const THEME_IDS = ["default", "plain", "graveyard"] as const;
export type ThemeId = (typeof THEME_IDS)[number];
export const DEFAULT_THEME: ThemeId = "default";
export const THEME_KEY = "scopesoup.theme";

/** The words a theme supplies, by neutral key. */
export interface ThemeWords {
  /** The theme's name in the picker. */
  name: string;
  /** One line under the name in the picker. */
  about: string;
  /** The logo's label while sessions run. */
  statusOn: string;
  /** The logo's label while nothing runs. */
  statusOff: string;
  /** The top bar's link to the start page. */
  startPage: string;
  /** The heading of the list of what waits for the viewer. */
  yourTurn: string;
  /** The line under the brand (its tooltip) and in the picker's text. */
  tagline: string;
  /** What the board calls one work item, and several, in lower case. */
  itemOne: string;
  itemMany: string;
  /** The title of the overnight summary (the board has none yet; a theme words it for when it does). */
  summaryTitle: string;
  /** The words of the lanes, and of an abandoned item. */
  lanes: Readonly<Record<LaneKey, string>>;
  abandoned: string;
  /** The overview's one lane for Queued and Checking (web/src/mergeLane.ts), and its glyph ("" for none). */
  mergeLane: string;
  mergeLaneIcon: string;
  /** The tag on a card whose turn it is yours; and another's ("{name}" is filled in). */
  turnYours: string;
  turnOf: string;
  /** What an empty lane says. */
  emptyLane: string;
  /** Flair, "" for none: a line on a done card, a badge for a running session ("{n}" is its attempt), a badge for a quiet item ("{date}" is when it last moved). */
  doneBadge: string;
  sessionBadge: string;
  staleBadge: string;
  /** Easter eggs: the tagline between 22:00 and 05:00 local time, and a line for hovering the logo ("" for none). */
  taglineNight: string;
  logoHover: string;
  /** A small glyph before a lane's name; "" for none. */
  laneIcons: Readonly<Record<LaneKey, string>>;
  abandonedIcon: string;
  /** The Item page's last row: the button that abandons, what it does, and the button that reopens, with what it does. */
  abandonButton: string;
  abandonAbout: string;
  reopenButton: string;
  reopenAbout: string;
  /** The State menu (#154): the Triage option, the agents by role in its toast's notes, the toast ("{id}", "{state}") and its Undo; the toast for an abandon. */
  triageState: string;
  roles: Readonly<Record<"triage" | "implement" | "review" | "queue", string>>;
  moveToast: string;
  abandonToast: string;
  undo: string;
}

export const LANE_KEYS = ["blocked", "backlog", "in-progress", "in-review", "queued", "checking", "done"] as const;
export type LaneKey = (typeof LANE_KEYS)[number];

const NO_ICONS: Readonly<Record<LaneKey, string>> = { blocked: "", backlog: "", "in-progress": "", "in-review": "", queued: "", checking: "", done: "" };
const STANDARD_LANES: Readonly<Record<LaneKey, string>> = { blocked: "Blocked", backlog: "Backlog", "in-progress": "In progress", "in-review": "In review", queued: "Queued", checking: "Checking", done: "Done" };

/** The words every theme but a themed one shares. */
const STANDARD_WORDS = { turnYours: "your turn", turnOf: "{name}'s turn", emptyLane: "Nothing here.", doneBadge: "", sessionBadge: "", staleBadge: "", logoHover: "", itemOne: "item", itemMany: "items", summaryTitle: "Overnight summary", lanes: STANDARD_LANES, abandoned: "Abandoned", mergeLane: "Merge queue", mergeLaneIcon: "", laneIcons: NO_ICONS, abandonedIcon: "", abandonButton: "Abandon", abandonAbout: "Stops the work and takes it off the board.", reopenButton: "Reopen", reopenAbout: "Back to the backlog.", triageState: "Triage", roles: { triage: "triage", implement: "implementor", review: "reviewer", queue: "merge queue" }, moveToast: "{id} → {state}", abandonToast: "{id} → {state}", undo: "Undo" } as const;

/** The custom properties that make up a look; each theme gives all of them, for light and for dark. */
export const COLOUR_VARS = [
  "bg", "surface", "sunken", "line", "text", "muted", "accent", "accent-soft", "moving", "moving-soft", "yours", "yours-soft", "yours-line",
  "blocked", "blocked-soft", "done", "bar", "bar-text", "bar-muted", "bar-line", "brand", "glow",
  // The Usage page's roles: implement, review, triage, outside Scope Soup (a neutral grey: nobody of Scope Soup's).
  "use-implement", "use-review", "use-triage", "use-outside",
] as const;
export type ColourVar = (typeof COLOUR_VARS)[number];
export type Palette = Readonly<Record<ColourVar, string>>;

/** One shape of the logo: `cls` is styled by the board's CSS (`.mark .<cls>`). */
export interface Shape {
  tag: "path" | "rect" | "circle";
  cls: string;
  attrs: Readonly<Record<string, string>>;
}

export interface Theme {
  words: ThemeWords;
  light: Palette;
  /** Only what differs from `light` when the viewer's system is dark. */
  dark: Partial<Palette>;
  /** The logo in the top bar, drawn in a 32 by 32 box. */
  mark: readonly Shape[];
  /** The tab icon, in the project's colour. */
  icon: (colour: string) => string;
}

const DEFAULT_LIGHT: Palette = {
  "use-implement": "#3a6fc0", "use-review": "#d07a2a", "use-triage": "#9a4f9e", "use-outside": "#8a8f98",
  bg: "#f4f2ee", surface: "#ffffff", sunken: "#ebe8e2", line: "#d9d5cc", text: "#1f2328", muted: "#5d6470",
  accent: "#1f5f8b", "accent-soft": "#e3eef6", moving: "#2b7a4b", "moving-soft": "#e2f1e7",
  yours: "#85500a", "yours-soft": "#fbefd5", "yours-line": "#e0b252", blocked: "#b3372c", "blocked-soft": "#fae6e3", done: "#7b8088",
  bar: "#12263a", "bar-text": "#e8eef4", "bar-muted": "#b4c4d4", "bar-line": "#46607a", brand: "#f2c14e", glow: "rgba(224, 160, 40, 0.12)",
};

const PLAIN_LIGHT: Palette = {
  "use-implement": "#3a6fc0", "use-review": "#d07a2a", "use-triage": "#9a4f9e", "use-outside": "#8a8f98",
  bg: "#f5f5f6", surface: "#ffffff", sunken: "#ebebed", line: "#d6d7da", text: "#202124", muted: "#5b5e66",
  accent: "#3b5f86", "accent-soft": "#e6edf4", moving: "#2f7a52", "moving-soft": "#e4f1ea",
  yours: "#7a5a12", "yours-soft": "#f6efdc", "yours-line": "#d3b968", blocked: "#b03a32", "blocked-soft": "#f8e7e5", done: "#7c8086",
  bar: "#2e3440", "bar-text": "#eceff4", "bar-muted": "#c0c6d0", "bar-line": "#5b6577", brand: "#e5e9f0", glow: "rgba(120, 140, 170, 0.12)",
};

const iconSvg = (body: string): string => `<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16'>${body}</svg>`;

export const THEMES: Readonly<Record<ThemeId, Theme>> = {
  default: {
    words: {
      name: "Default",
      about: "The lighthouse: a dark bar with a lamp that lights while sessions run.",
      statusOn: "Light on: sessions are running",
      statusOff: "Light off: nothing running",
      startPage: "Overview",
      yourTurn: "Your turn",
      tagline: "The light stays on while the agents work.",
      taglineNight: "The light stays on while the agents work.",
      ...STANDARD_WORDS,
    },
    light: DEFAULT_LIGHT,
    dark: {
      "use-implement": "#5b8ad0", "use-review": "#c97a35", "use-triage": "#a874c0", "use-outside": "#61676f",
      bg: "#15171a", surface: "#1e2125", sunken: "#191b1f", line: "#33383f", text: "#e4e6e9", muted: "#9aa2ad", accent: "#7db8e0",
      "accent-soft": "#1d2f3d", moving: "#6cc08b", "moving-soft": "#1b3024", yours: "#e9b656", "yours-soft": "#35290f", "yours-line": "#7d5f1f",
      blocked: "#f08a7e", "blocked-soft": "#3a1d1a", done: "#7f8690", bar: "#0d1824", glow: "rgba(233, 182, 86, 0.2)",
    },
    mark: [
      { tag: "path", cls: "rays", attrs: { d: "M9 8H2M9 12L3 15M23 8h7M23 12l6 3" } },
      { tag: "path", cls: "body", attrs: { d: "M11 30l2-16h6l2 16z" } },
      { tag: "path", cls: "band", attrs: { d: "M12.2 22h7.6l.3 2.6h-8.2zM12.9 17h6.2l.3 2.4h-6.8z" } },
      { tag: "rect", cls: "body", attrs: { x: "10", y: "13", width: "12", height: "2", rx: "1" } },
      { tag: "rect", cls: "light", attrs: { x: "12", y: "6.5", width: "8", height: "6.5", rx: "1.5" } },
      { tag: "path", cls: "body", attrs: { d: "M16 2l5 4.5H11z" } },
    ],
    icon: (colour) => iconSvg(`<path d='M6 15h4l-1-9H7z' fill='${colour}'/><circle cx='8' cy='4' r='2.5' fill='#e8a33d'/>`),
  },
  plain: {
    words: {
      name: "Plain",
      about: "Ordinary words and a calm grey palette.",
      statusOn: "Running: sessions are active",
      statusOff: "Idle: nothing running",
      startPage: "Board",
      yourTurn: "Waiting for you",
      tagline: "Agents work through the items; you answer their questions.",
      taglineNight: "Agents work through the items; you answer their questions.",
      ...STANDARD_WORDS,
    },
    light: PLAIN_LIGHT,
    dark: {
      "use-implement": "#5b8ad0", "use-review": "#c97a35", "use-triage": "#a874c0", "use-outside": "#61676f",
      bg: "#17181b", surface: "#212226", sunken: "#1b1c1f", line: "#34363b", text: "#e6e7ea", muted: "#9ca0a8", accent: "#8db4dc",
      "accent-soft": "#212e3b", moving: "#72c096", "moving-soft": "#1c2e25", yours: "#dcbb6a", "yours-soft": "#322a14", "yours-line": "#7a6428",
      blocked: "#ee8f86", "blocked-soft": "#3a1f1c", done: "#80858d", bar: "#101114", glow: "rgba(150, 170, 200, 0.16)",
    },
    mark: [
      { tag: "rect", cls: "body", attrs: { x: "3", y: "6", width: "26", height: "21", rx: "4" } },
      { tag: "rect", cls: "band", attrs: { x: "6.5", y: "10", width: "5", height: "13", rx: "1" } },
      { tag: "rect", cls: "band", attrs: { x: "13.5", y: "10", width: "5", height: "13", rx: "1" } },
      { tag: "rect", cls: "band", attrs: { x: "20.5", y: "10", width: "5", height: "13", rx: "1" } },
      { tag: "circle", cls: "light", attrs: { cx: "26", cy: "6", r: "3.5" } },
    ],
    icon: (colour) => iconSvg(`<rect x='1.5' y='3' width='13' height='11' rx='2' fill='${colour}'/><circle cx='12.5' cy='3' r='2.3' fill='#e5e9f0'/>`),
  },
  graveyard: {
    words: {
      name: "Graveyard Shift",
      about: "Murder mystery at night: the night crew works the cases while you sleep.",
      statusOn: "Moon up: the night crew is on the case",
      statusOff: "Moon down: the night crew is resting",
      startPage: "Case board",
      yourTurn: "Wanted for questioning",
      tagline: "The night crew works the cases. You read the coroner's report at breakfast.",
      taglineNight: "Past midnight. The night crew has the whole building to itself.",
      turnYours: "for questioning",
      turnOf: "{name} is wanted",
      emptyLane: "Not a soul.",
      doneBadge: "R.I.P.",
      sessionBadge: "detective {n} on it",
      staleBadge: "no leads since {date}",
      logoHover: "Dig deep. The case never sleeps.",
      itemOne: "case",
      itemMany: "cases",
      summaryTitle: "Coroner's report",
      lanes: {
        blocked: "Stakeout",
        backlog: "At large",
        "in-progress": "On the case",
        "in-review": "Cross-examination",
        queued: "Awaiting DNA",
        checking: "Autopsy",
        done: "Laid to rest",
      },
      abandoned: "Cold case",
      mergeLane: "Crime lab",
      mergeLaneIcon: "🧪",
      laneIcons: { blocked: "🔭", backlog: "🕵", "in-progress": "🔍", "in-review": "⚖", queued: "🧬", checking: "🩺", done: "🪦" },
      abandonedIcon: "❄",
      abandonButton: "Murder",
      abandonAbout: "The night crew drops the case for good.",
      reopenButton: "Resurrect",
      reopenAbout: "Back to the cases at large.",
      triageState: "Line-up",
      roles: { triage: "profiler", implement: "detective", review: "prosecutor", queue: "crime lab" },
      moveToast: "{id} → {state}",
      abandonToast: "Murdered {id}",
      undo: "Resurrect",
    },
    light: {
      "use-implement": "#3a6fc0", "use-review": "#d07a2a", "use-triage": "#9a4f9e", "use-outside": "#8a8f98",
      bg: "#eeedf1", surface: "#ffffff", sunken: "#e3e1e8", line: "#cfccd8", text: "#1e1d26", muted: "#5a5768",
      accent: "#4b4a8f", "accent-soft": "#e7e6f5", moving: "#2c7a5a", "moving-soft": "#e1f1ea",
      yours: "#7d4a12", "yours-soft": "#f7ecd9", "yours-line": "#d8aa62", blocked: "#a8343f", "blocked-soft": "#f8e5e7", done: "#7a7886",
      bar: "#1a1a2e", "bar-text": "#e9e8f2", "bar-muted": "#b7b5cc", "bar-line": "#4a4a6a", brand: "#e8e2b0", glow: "rgba(190, 180, 230, 0.14)",
    },
    dark: {
      "use-implement": "#5b8ad0", "use-review": "#c97a35", "use-triage": "#a874c0", "use-outside": "#61676f",
      bg: "#14131b", surface: "#1d1c27", sunken: "#181720", line: "#33324a", text: "#e6e5ee", muted: "#9d9bb2", accent: "#a3a2f0",
      "accent-soft": "#25244a", moving: "#6cc4a0", "moving-soft": "#1a2e27", yours: "#e6b86a", "yours-soft": "#342914", "yours-line": "#7d5f27",
      blocked: "#f08a94", "blocked-soft": "#3a1d22", done: "#807e92", bar: "#0c0c17", glow: "rgba(190, 180, 240, 0.2)",
    },
    // A shovel in a dark circle, with a small moon.
    mark: [
      { tag: "circle", cls: "body", attrs: { cx: "16", cy: "16", r: "14" } },
      { tag: "path", cls: "band", attrs: { d: "M14.8 8h2.4l-.3 12h-1.8z" } },
      { tag: "path", cls: "band", attrs: { d: "M11.5 20h9l-1.2 7h-6.6z" } },
      { tag: "circle", cls: "light", attrs: { cx: "24", cy: "8", r: "3.6" } },
    ],
    icon: (colour) => iconSvg(`<circle cx='8' cy='8' r='7' fill='${colour}'/><path d='M7 3h2v6H7zM5.5 9h5l-.6 4H6.1z' fill='#1a1a2e'/><circle cx='12.5' cy='3.5' r='2' fill='#e8e2b0'/>`),
  },
};

/** Fills "{name}" style holes in a theme's text. */
export const fill = (text: string, values: Readonly<Record<string, string | number>>): string => text.replace(/\{(\w+)\}/g, (hole, key: string) => (key in values ? String(values[key]) : hole));

/** "Item" / "item": the theme's noun, for sentences. */
export const itemNoun = (plural = false, capital = false): string => {
  const word = plural ? words().itemMany : words().itemOne;
  return capital ? word.replace(/^./, (first) => first.toUpperCase()) : word;
};

/** The tagline for `at`: the night one between 22:00 and 05:00. */
export const taglineAt = (theme: ThemeWords, at: Date): string => (at.getHours() >= 22 || at.getHours() < 5 ? theme.taglineNight : theme.tagline);

/** The words of the picked theme. */
export const words = (): ThemeWords => THEMES[currentTheme()].words;

export function isThemeId(value: unknown): value is ThemeId {
  return typeof value === "string" && (THEME_IDS as readonly string[]).includes(value);
}

/** The stylesheet text of every theme's palette: `:root[data-theme="<id>"]`, with the dark values under the system's dark setting. */
export function themeCss(): string {
  const block = (id: ThemeId, vars: Partial<Palette>) => `:root[data-theme="${id}"] { ${Object.entries(vars).map(([name, value]) => `--${name}: ${value};`).join(" ")} }`;
  const light = THEME_IDS.map((id) => block(id, THEMES[id].light)).join("\n");
  const dark = THEME_IDS.map((id) => block(id, THEMES[id].dark)).join("\n");
  return `${light}\n@media (prefers-color-scheme: dark) {\n${dark}\n}\n`;
}

/** The theme remembered in `storage`; the default when none is, it is unknown, or the storage cannot be read. */
export function readTheme(storage: HeldStorage | null): ThemeId {
  try {
    const value = storage?.getItem(THEME_KEY);
    return isThemeId(value) ? value : DEFAULT_THEME;
  } catch {
    return DEFAULT_THEME;
  }
}

/** Remembers `id`. A storage that throws is left alone: the pick then holds for this page only. */
export function writeTheme(storage: HeldStorage | null, id: ThemeId): void {
  try {
    storage?.setItem(THEME_KEY, id);
  } catch {
    // No storage here.
  }
}

let current: ThemeId | undefined;
const listeners = new Set<(id: ThemeId) => void>();

export function currentTheme(): ThemeId {
  if (current === undefined) current = readTheme(browserStorage());
  return current;
}

/** Picks a theme for this viewer, remembers it if it can, and tells every view. */
export function setTheme(id: ThemeId): void {
  current = id;
  writeTheme(browserStorage(), id);
  for (const listener of listeners) listener(id);
}

export function onThemeChange(listener: (id: ThemeId) => void): () => void {
  listeners.add(listener);
  return () => void listeners.delete(listener);
}
