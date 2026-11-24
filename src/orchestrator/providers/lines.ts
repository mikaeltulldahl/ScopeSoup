// What every provider's line reader shares: lifting JSON objects out of untrusted lines, and the short forms a card shows.
// No provider's CLI or event format is named here.

export type Obj = Record<string, unknown>;

export function isObj(value: unknown): value is Obj {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parseObj(text: string): Obj | null {
  try {
    const value: unknown = JSON.parse(text);
    return isObj(value) ? value : null;
  } catch {
    return null;
  }
}

/** The end (exclusive) of the JSON object that starts at `start`, or -1 when it never closes. */
function objectEnd(text: string, start: number): number {
  let depth = 0;
  let inString = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (ch === "\\") i++;
      else if (ch === '"') inString = false;
    } else if (ch === '"') inString = true;
    else if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return i + 1;
    }
  }
  return -1;
}

/**
 * The objects on one line. A clean line gives one. Otherwise look for whole event objects
 * (`{"type":...}`) sitting inside the line, lift them out, and try what remains.
 */
export function objectsOnLine(line: string): { objects: Obj[]; clean: boolean } {
  const whole = parseObj(line);
  if (whole) return { objects: [whole], clean: true };

  const objects: Obj[] = [];
  let rest = line;
  let from = 1;
  for (;;) {
    const at = rest.indexOf('{"type":', from);
    if (at < 0) break;
    const end = objectEnd(rest, at);
    const inner = end > 0 ? parseObj(rest.slice(at, end)) : null;
    if (!inner) {
      from = at + 1;
      continue;
    }
    objects.push(inner);
    rest = rest.slice(0, at) + rest.slice(end);
    from = Math.max(1, at);
    const outer = parseObj(rest);
    if (outer) {
      // The line the injected object interrupted comes first in time.
      objects.unshift(outer);
      break;
    }
  }
  return { objects, clean: false };
}

/** Text on one line, cut to `max` characters. */
export function oneLine(text: string, max = 160): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/** Longest detail (path or command) shown on a card. */
export const DETAIL_MAX = 60;

/** A path in the work clone shown relative to it, with forward slashes; a path elsewhere is only given forward slashes. */
export function shortPath(path: string, root?: string): string {
  const flat = path.replace(/\\/g, "/");
  if (root) {
    const base = root.replace(/\\/g, "/").replace(/\/+$/, "");
    const windows = /^[A-Za-z]:/.test(base);
    const inside = windows ? flat.toLowerCase().startsWith(`${base.toLowerCase()}/`) : flat.startsWith(`${base}/`);
    if (inside) return cutStart(flat.slice(base.length + 1));
  }
  return cutStart(flat);
}

/** Keeps the end of a long path, which is the part that tells files apart. */
function cutStart(text: string, max = DETAIL_MAX): string {
  return text.length > max ? `…${text.slice(text.length - max + 1)}` : text;
}
