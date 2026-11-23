// Which project the board belongs to, in the header: its name, its repository (linked on GitHub), and a button that opens
// the person's own checkout in the file manager. Also the tab's title and icon.

import { useEffect, useState } from "preact/hooks";
import { postOpenFolder } from "./api.ts";
import type { FolderName, ProjectView } from "./api.ts";
import { DEFAULT_THEME } from "./theme.ts";
import type { ThemeId } from "./theme.ts";
import { FOLDER_WORDS, faviconHref, projectColour, tabTitle } from "./project.ts";

/** A button that has the server open one of the project's folders. Failures go to `onError`. */
export function FolderButton({ folder, onError, iconOnly }: { folder: FolderName; onError: (problem: string | null) => void; iconOnly?: boolean }) {
  const [busy, setBusy] = useState(false);
  const words = FOLDER_WORDS[folder];
  const open = () => {
    setBusy(true);
    postOpenFolder(folder)
      .then(() => onError(null), (problem: unknown) => onError(problem instanceof Error ? problem.message : String(problem)))
      .finally(() => setBusy(false));
  };
  return (
    <button type="button" class={`folder-button${iconOnly ? " icon-only" : ""}`} disabled={busy} title={words.title} aria-label={iconOnly ? words.title : undefined} onClick={open}>
      <svg viewBox="0 0 16 16" aria-hidden="true">
        <path d="M1.5 3.5h4.2l1.5 1.6h7.3v7.4H1.5z" />
      </svg>
      {iconOnly ? null : words.label}
    </button>
  );
}

/** Keeps the tab's title ("Scope Soup · <project>") and icon (in the project's colour) in step with the project and the theme. */
export function useProjectTab(project: ProjectView | undefined, theme: ThemeId = DEFAULT_THEME): void {
  const name = project?.name;
  useEffect(() => {
    document.title = tabTitle(name);
    const icon = document.querySelector<HTMLLinkElement>("link[rel='icon']");
    if (icon && name) icon.href = faviconHref(projectColour(name), theme);
  }, [name, theme]);
}

/** The project's name and repository in the header, with the button that opens the person's checkout. */
export function ProjectHeader({ project, onError }: { project: ProjectView; onError: (problem: string | null) => void }) {
  const repository = project.repository && project.repository !== project.name ? project.repository : null;
  return (
    <div class="project" style={{ "--project": projectColour(project.name) }}>
      <span class="project-dot" aria-hidden="true" />
      <span class="project-text">
        <b class="project-name" title="The project this board belongs to">{project.name}</b>
        {repository &&
          (project.github ? (
            <a class="project-repo" href={project.github} target="_blank" rel="noreferrer" title="The repository on GitHub">{repository}</a>
          ) : (
            <span class="project-repo" title="The repository">{repository}</span>
          ))}
        {!repository && project.github && <a class="project-repo" href={project.github} target="_blank" rel="noreferrer">GitHub</a>}
      </span>
      {project.folders.includes("checkout") && <FolderButton folder="checkout" onError={onError} iconOnly />}
    </div>
  );
}
