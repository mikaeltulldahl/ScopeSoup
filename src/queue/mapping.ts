// From failing test files to the member that most likely broke them, by the paths each member touches.

import type { MappingRule } from "./types.ts";

const slashes = (path: string) => path.replace(/\\/g, "/");
const baseName = (path: string) => path.split("/").pop() ?? path;

/** What a test file is about: its name without folders, the test suffix and the rule's prefix. */
export function testKey(file: string, rule: MappingRule): string {
  let key = baseName(slashes(file)).replace(new RegExp(rule.testSuffix, "i"), "");
  if (rule.stripPrefix) key = key.replace(new RegExp(`^(?:${rule.stripPrefix})`, "i"), "");
  return key.toLowerCase();
}

/** Does a touched path plausibly belong to a failing test file? */
export function relates(failingFile: string, touched: string, rule: MappingRule): boolean {
  const f = slashes(failingFile);
  const c = slashes(touched);
  if (f === c || f.endsWith(`/${c}`) || c.endsWith(`/${f}`)) return true;
  const key = testKey(f, rule);
  if (!key) return false;
  const name = baseName(c).replace(new RegExp(rule.testSuffix, "i"), "").replace(new RegExp(rule.sourceSuffix, "i"), "").toLowerCase();
  if (name === key) return true;
  const parts = c.split("/");
  for (let i = 0; i < parts.length - 2; i++) {
    const feature = parts[i + 1]?.toLowerCase();
    if (rule.featureFolders.includes(parts[i] ?? "") && feature && key.startsWith(feature)) return true;
  }
  return rule.aliases.some((a) => key.startsWith(a.test.toLowerCase()) && c.startsWith(a.path));
}

/**
 * The 1-based position whose touched paths match the failing test files, when exactly one does.
 * Null when no files are named, or none or several members match.
 */
export function mapCulprit(failingFiles: readonly string[], touched: readonly (readonly string[])[], rule: MappingRule): number | null {
  if (failingFiles.length === 0) return null;
  const hits: number[] = [];
  touched.forEach((paths, i) => {
    if (paths.some((c) => failingFiles.some((f) => relates(f, c, rule)))) hits.push(i + 1);
  });
  return hits.length === 1 ? (hits[0] ?? null) : null;
}
