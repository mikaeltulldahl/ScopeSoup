// Failure reports: capped on the way in, and the two questions the engine asks of them.

import type { FailureReport } from "./types.ts";

const EXCERPT_MAX = 1500;

/** Keeps the end of a log excerpt, which is where the failure is. */
export function trimExcerpt(text: string, max = EXCERPT_MAX): string {
  return text.length <= max ? text : `...${text.slice(text.length - max)}`;
}

export function capReport(report: { files: string[]; excerpt?: string } | undefined, cap: number): FailureReport {
  const all = (report?.files ?? []).filter((f) => typeof f === "string" && f.length > 0);
  const capped: FailureReport = { files: all.slice(0, cap), excerpt: trimExcerpt(report?.excerpt ?? "") };
  if (all.length > cap) capped.more = all.length - cap;
  return capped;
}

/** Few enough failing files to rerun them or map them to a member. */
export function usableFiles(report: FailureReport | undefined): report is FailureReport {
  return !!report && report.files.length > 0 && !report.more;
}

/** A green rerun counts only if every failed file really ran. */
export function rerunRan(failed: readonly string[], ran: readonly string[] | undefined): boolean {
  return failed.length > 0 && !!ran && failed.every((f) => ran.includes(f));
}
