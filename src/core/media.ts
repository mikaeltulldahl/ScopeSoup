// Images an agent attaches to its answer: what is accepted, how many, where they are referenced, and when they go. Pure.
//
// An agent saves a picture in `.scopesoup/media/` of its clone (git-ignored) and writes `![what it shows](media/<name>)` in its
// summary, question, options or decisions. After the session Scope Soup takes the files that pass `mediaType` and the limits
// into its data folder (`src/orchestrator/media.ts`); the board serves them, and the Markdown parser accepts only these
// relative `media/<name>` paths. Hosts get "image on the board" instead (`hostImageText`), never the picture.

/** Where in its clone an agent saves an image; `.gitignore` inside makes git ignore the folder. */
export const MEDIA_FOLDER = ".scopesoup/media";
/** The most one image may weigh. */
export const MAX_MEDIA_BYTES = 5 * 1024 * 1024;
/** The most images one Item may have. */
export const MAX_MEDIA_PER_ITEM = 20;
/** How many bytes of a file `mediaType` needs to see. */
export const MEDIA_HEAD_BYTES = 1024;

export type MediaType = "image/png" | "image/jpeg" | "image/gif" | "image/webp" | "image/svg+xml";

const EXTENSIONS: Record<string, MediaType> = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", svg: "image/svg+xml" };

/** A name an image may have: a letter or digit first, then letters, digits, `.`, `_`, `-`, an image extension; at most 100 characters. */
const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,94}\.(png|jpe?g|gif|webp|svg)$/i;

export function isMediaName(name: string): boolean {
  return NAME.test(name) && !name.includes("..");
}

const startsWith = (head: Uint8Array, bytes: readonly number[], at = 0): boolean => bytes.every((byte, index) => head[at + index] === byte);

/** An SVG: XML text whose first element is `<svg`, after an optional BOM, XML declaration, comments and doctype. */
function looksLikeSvg(head: Uint8Array): boolean {
  let text = "";
  for (const byte of head) text += String.fromCharCode(byte);
  text = text.replace(/^ï»¿/, "");
  for (;;) {
    const before = text;
    text = text.replace(/^\s+/, "").replace(/^<\?xml[^>]*\?>/, "").replace(/^<!--[\s\S]*?-->/, "").replace(/^<!DOCTYPE\s+svg[^>]*>/i, "");
    if (text === before) break;
  }
  return /^<svg[\s>]/.test(text);
}

/**
 * The content type of an image, from its name's extension and its first bytes (`MEDIA_HEAD_BYTES`), which must agree; null
 * for anything else. An SVG is served only as an image (`<img>` runs no script) and is never put into a page as markup.
 */
export function mediaType(name: string, head: Uint8Array): MediaType | null {
  if (!isMediaName(name)) return null;
  const type = EXTENSIONS[name.slice(name.lastIndexOf(".") + 1).toLowerCase()];
  switch (type) {
    case "image/png": return startsWith(head, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]) ? type : null;
    case "image/jpeg": return startsWith(head, [0xff, 0xd8, 0xff]) ? type : null;
    case "image/gif": return startsWith(head, [0x47, 0x49, 0x46, 0x38]) && (head[4] === 0x37 || head[4] === 0x39) && head[5] === 0x61 ? type : null;
    case "image/webp": return startsWith(head, [0x52, 0x49, 0x46, 0x46]) && startsWith(head, [0x57, 0x45, 0x42, 0x50], 8) ? type : null;
    case "image/svg+xml": return looksLikeSvg(head) ? type : null;
    default: return null;
  }
}

/** A file found in the media folder after a session. */
export interface FoundMedia {
  name: string;
  size: number;
  head: Uint8Array;
}

export interface MediaPlan {
  keep: { name: string; type: MediaType }[];
  refused: { name: string; why: string }[];
}

/**
 * Which of the files found are kept: a known image within the size, while the Item has room (`existing` are its images already
 * kept; one of the same name is replaced and takes no more room). In name order, so the outcome does not depend on the folder.
 */
export function planMedia(found: readonly FoundMedia[], existing: readonly string[]): MediaPlan {
  const plan: MediaPlan = { keep: [], refused: [] };
  const names = new Set(existing);
  for (const file of [...found].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
    if (!isMediaName(file.name)) {
      plan.refused.push({ name: file.name, why: "not an image name (letters, digits, \".\", \"_\", \"-\" and .png, .jpg, .gif, .webp or .svg)" });
      continue;
    }
    if (file.size > MAX_MEDIA_BYTES) {
      plan.refused.push({ name: file.name, why: `larger than ${MAX_MEDIA_BYTES / 1024 / 1024} MB` });
      continue;
    }
    const type = mediaType(file.name, file.head);
    if (!type) {
      plan.refused.push({ name: file.name, why: "its content is not the image its name says" });
      continue;
    }
    if (!names.has(file.name) && names.size >= MAX_MEDIA_PER_ITEM) {
      plan.refused.push({ name: file.name, why: `the Item has ${MAX_MEDIA_PER_ITEM} images already` });
      continue;
    }
    names.add(file.name);
    plan.keep.push({ name: file.name, type });
  }
  return plan;
}

/** The ref an Item's images are shared on: `refs/scopesoup/media/<id>`, the id as it is when it is safe in a ref, else made safe. */
export function mediaRef(id: string): string {
  return `refs/scopesoup/media/${mediaKey(id)}`;
}

/** The Item's id as a folder and ref name: letters, digits, `-` and `_`, a letter or digit first; anything else becomes `_`. */
export function mediaKey(id: string): string {
  const safe = id.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 64);
  return /^[A-Za-z0-9]/.test(safe) ? safe : `i${safe}`.slice(0, 64);
}

/** `![alt](media/name)`: an image reference as agents write it. */
export const IMAGE_REFERENCE = /!\[([^\]]*)\]\(media\/([^)\s]+)\)/g;

/** The names of the images a text refers to, each once, in order. */
export function mediaNamesIn(text: string): string[] {
  const names: string[] = [];
  for (const match of text.matchAll(new RegExp(IMAGE_REFERENCE.source, "g"))) if (isMediaName(match[2]!) && !names.includes(match[2]!)) names.push(match[2]!);
  return names;
}

/** Text for a host: each image reference becomes words, so no picture leaves this machine through a host. */
export function hostImageText(text: string): string {
  return text.replace(new RegExp(IMAGE_REFERENCE.source, "g"), (_match, alt: string) => `(${alt.trim() ? `${alt.trim()}: ` : ""}image on the board)`);
}

/** Whether a closed Item's images are due to go: `keepDays` after it closed (null: kept). */
export function mediaExpired(closedAt: string | undefined, keepDays: number | null, now: string): boolean {
  if (keepDays === null || !closedAt) return false;
  const closed = Date.parse(closedAt);
  const at = Date.parse(now);
  return Number.isFinite(closed) && Number.isFinite(at) && at - closed >= keepDays * 86_400_000;
}

/** What the prompts tell agents about images: where to save them, how to refer to them, and who will see them. */
export function mediaPromptText(push: boolean): string {
  return [
    `To show a picture (a screenshot, a before and after of a UI change, a diagram), save it as PNG, JPEG, GIF, WebP or SVG in \`${MEDIA_FOLDER}/\` of your clone (git ignores it; never commit it or add it elsewhere) and write \`![what it shows](media/<name>)\` in your summary, a question, an option or a decision.`,
    `Names: letters, digits, ".", "_" and "-"; at most ${MAX_MEDIA_BYTES / 1024 / 1024} MB each and ${MAX_MEDIA_PER_ITEM} per Item; a name used again replaces the image. For a before and after, put the two next to each other: \`![before](media/x-before.png) ![after](media/x-after.png)\`.`,
    push
      ? "The images are shown on the board and pushed to the project's remote, where everyone with the repository sees them: never capture secrets, tokens or personal data."
      : "The images are shown on the board of this machine only: never capture secrets, tokens or personal data.",
  ].join(" ");
}
