// Which project the board belongs to: the browser tab's title and icon, and the project's colour.
// Pure, so src/webProject.test.ts can test it without a browser.

import { PROJECT_NAME_MAX } from "../../src/core/views.ts";
import type { FolderName, ProjectView } from "../../src/core/views.ts";
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
  checkout: { label: "Your project folder", title: "Opens the folder you work on this project in, in the file manager" },
  clone: { label: "Scope Soup's copy of the project", title: "Opens Scope Soup's own copy of the project, where its agents work, in the file manager; leave it to Scope Soup" },
  config: { label: "Scope Soup's settings folder", title: "Opens the folder with this machine's Scope Soup settings (scopesoup.config.json), in the file manager" },
};

/** The hover of the header's folder button: where it goes, and the remote the project lives on. */
export function checkoutHover(project: Pick<ProjectView, "checkoutPath" | "remote">): string {
  const open = project.checkoutPath ? `Open ${project.checkoutPath}` : FOLDER_WORDS.checkout.title;
  return project.remote ? `${open}
Remote: ${project.remote}` : open;
}

/** A typed project name for saving: trimmed, or the reason it cannot be one. `same` when it is the current name (nothing to save). */
export function checkRename(typed: string, current: string): { name: string } | { same: true } | { problem: string } {
  const name = typed.trim();
  if (name === "") return { problem: "The project needs a name." };
  if (name.length > PROJECT_NAME_MAX) return { problem: `The name can be at most ${PROJECT_NAME_MAX} characters.` };
  return name === current ? { same: true } : { name };
}
