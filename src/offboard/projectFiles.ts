// What offboarding takes out of the project's own files, as text. Pure. The result becomes a patch the person reads and
// commits (`act.ts`); Scope Soup never commits it, and never touches the person's own checkout.
// - The Scope Soup section of CLAUDE.md (`plugins/scopesoup/claude-md-section.md`): from its heading to the next heading of the same
//   level or higher, or the end. Nothing else of the file changes.
// - The README part (`plugins/scopesoup/readme-line.md`): the same way, from its heading.
// - The plugin lines of `.claude/settings.json` (the onboarding skill's step 8): `extraKnownMarketplaces.scopesoup` and
//   `enabledPlugins["scopesoup@scopesoup"]`; an object left empty goes too.
// - The setup script `.scopesoup/scopesoup-setup.mjs`: the whole file.

/** The heading the Scope Soup section of a project's CLAUDE.md starts with. */
export const SECTION_HEADING = "## Work on this project is run with Scope Soup";

/** The heading the README part starts with. */
export const README_HEADING = "## Open the Scope Soup board";

export const CLAUDE_MD = "CLAUDE.md";
export const README = "README.md";
export const PLUGIN_SETTINGS = ".claude/settings.json";
export const SETUP_SCRIPT = ".scopesoup/scopesoup-setup.mjs";

/** CLAUDE.md without the Scope Soup section; null when it has none. "" when nothing else was in it. */
export function withoutSection(text: string): string | null {
  return withoutPart(text, SECTION_HEADING);
}

/** README.md without the "Open the Scope Soup board" part; null when it has none. "" when nothing else was in it. */
export function withoutReadmePart(text: string): string | null {
  return withoutPart(text, README_HEADING);
}

function withoutPart(text: string, heading: string): string | null {
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex((line) => line.trimEnd() === heading);
  if (start < 0) return null;
  let end = lines.length;
  let fenced = false;
  for (let at = start + 1; at < lines.length; at++) {
    const line = lines[at] ?? "";
    if (/^\s*(```|~~~)/.test(line)) fenced = !fenced;
    if (!fenced && /^#{1,2}\s/.test(line)) {
      end = at;
      break;
    }
  }
  // The blank lines before the section go with it.
  let from = start;
  while (from > 0 && (lines[from - 1] ?? "").trim() === "") from--;
  const kept = [...lines.slice(0, from), ...(from > 0 && end < lines.length ? [""] : []), ...lines.slice(end)];
  const out = kept.join(eol).replace(/\s+$/, "");
  return out === "" ? "" : out + eol;
}

type Obj = Record<string, unknown>;
const isObj = (value: unknown): value is Obj => typeof value === "object" && value !== null && !Array.isArray(value);

/** `.claude/settings.json` without Scope Soup's plugin lines; null when it has none (or is not JSON: it is left alone). "" when nothing else was in it. */
export function withoutPluginLines(text: string): string | null {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isObj(raw)) return null;
  let changed = false;
  const out: Obj = { ...raw };
  const drop = (key: string, inner: string) => {
    const value = out[key];
    if (!isObj(value) || !(inner in value)) return;
    const rest = { ...value };
    delete rest[inner];
    changed = true;
    if (Object.keys(rest).length === 0) delete out[key];
    else out[key] = rest;
  };
  drop("extraKnownMarketplaces", "scopesoup");
  drop("enabledPlugins", "scopesoup@scopesoup");
  if (!changed) return null;
  if (Object.keys(out).length === 0) return "";
  const indent = /\n(\s+)"/.exec(text)?.[1] ?? "  ";
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  return JSON.stringify(out, null, indent).replace(/\n/g, eol) + eol;
}

/** A file of the project with Scope Soup's part taken out: the new text, or null to delete the file. Undefined: nothing of Scope Soup's in it. */
export function strippedFile(path: string, text: string): string | null | undefined {
  if (path === SETUP_SCRIPT) return null;
  const out = path === CLAUDE_MD ? withoutSection(text) : path === README ? withoutReadmePart(text) : path === PLUGIN_SETTINGS ? withoutPluginLines(text) : null;
  if (out === null) return undefined;
  return out === "" ? null : out;
}
