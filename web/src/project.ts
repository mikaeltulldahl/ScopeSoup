// Which project the board belongs to: the browser tab's title and icon, and the project's colour.
// Pure, so src/webProject.test.ts can test it without a browser.

import type { FolderName } from "../../src/core/views.ts";
import { DEFAULT_THEME, THEMES } from "./theme.ts";
import type { ThemeId } from "./theme.ts";

/** "Scope Soup · <project>", so tabs tell projects apart; "Scope Soup" without a project. */
export function tabTitle(project: string | undefined): string {
  const name = project?.trim();
  return name ? `Scope Soup · ${name}` : "Scope Soup";
}

/** A colour of the project's own, the same for the same name everywhere: a hue made from the name. */
export function projectColour(name: string): string {
  let hash = 0;
  for (const char of name) hash = (hash * 31 + (char.codePointAt(0) ?? 0)) >>> 0;
  return `hsl(${hash % 360} 65% 55%)`;
}

/** The tab icon: the theme's drawing in the project's colour. */
export function faviconHref(colour: string, theme: ThemeId = DEFAULT_THEME): string {
  return `data:image/svg+xml,${encodeURIComponent(THEMES[theme].icon(colour))}`;
}

/** What each folder button says. */
export const FOLDER_WORDS: Readonly<Record<FolderName, { label: string; title: string }>> = {
  checkout: { label: "Open your checkout", title: "Open your own checkout of the project in the file manager" },
  clone: { label: "Open Scope Soup's clone", title: "Open the clone Scope Soup makes its worktrees from (repoPath) in the file manager" },
  config: { label: "Open the configuration folder", title: "Open the folder of this machine's scopesoup.config.json in the file manager" },
};
