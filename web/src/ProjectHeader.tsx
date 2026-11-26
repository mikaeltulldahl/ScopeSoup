// Which project the board belongs to, in the header: its name (renamed in place), and a button that opens
// the person's own checkout in the file manager, whose hover says where and which remote. Also the tab's title and icon.

import { useEffect, useRef, useState } from "preact/hooks";
import { postConfig, postOpenFolder } from "./api.ts";
import type { FolderName, ProjectView } from "./api.ts";
import { DEFAULT_THEME } from "./theme.ts";
import type { ThemeId } from "./theme.ts";
import { PROJECT_NAME_MAX } from "../../src/core/views.ts";
import { FOLDER_WORDS, checkRename, checkoutHover, faviconHref, projectColour, tabTitle } from "./project.ts";

/** A button that has the server open one of the project's folders. Failures go to `onError`. */
export function FolderButton({ folder, onError, iconOnly, title }: { folder: FolderName; onError: (problem: string | null) => void; iconOnly?: boolean; title?: string }) {
  const [busy, setBusy] = useState(false);
  const words = FOLDER_WORDS[folder];
  const hover = title ?? words.title;
  const open = () => {
    setBusy(true);
    postOpenFolder(folder)
      .then(() => onError(null), (problem: unknown) => onError(problem instanceof Error ? problem.message : String(problem)))
      .finally(() => setBusy(false));
  };
  return (
    <button type="button" class={`folder-button${iconOnly ? " icon-only" : ""}`} disabled={busy} title={hover} aria-label={iconOnly ? hover : undefined} onClick={open}>
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

/** The project's name in the header, renamed in place where the settings can be written, with the button that opens the person's checkout. */
export function ProjectHeader({ project, onError, onRenamed }: { project: ProjectView; onError: (problem: string | null) => void; onRenamed?: () => void }) {
  const [editing, setEditing] = useState(false);
  const [typed, setTyped] = useState("");
  const [saving, setSaving] = useState(false);
  const [refusal, setRefusal] = useState<string | null>(null);
  const refusalTimer = useRef<number | undefined>(undefined);
  // Enter saves and then the input goes away, which blurs it: one save per edit.
  const done = useRef(false);
  const refuse = (reason: string) => {
    setRefusal(reason);
    window.clearTimeout(refusalTimer.current);
    refusalTimer.current = window.setTimeout(() => setRefusal(null), 6000);
  };
  useEffect(() => () => window.clearTimeout(refusalTimer.current), []);
  const start = () => {
    done.current = false;
    setTyped(project.name);
    setRefusal(null);
    setEditing(true);
  };
  const finish = (save: boolean) => {
    if (done.current) return;
    done.current = true;
    setEditing(false);
    if (!save) return;
    const checked = checkRename(typed, project.name);
    if ("problem" in checked) return refuse(checked.problem);
    if ("same" in checked) return;
    setSaving(true);
    postConfig({ project: checked.name })
      .then(() => onRenamed?.(), (problem: unknown) => refuse(problem instanceof Error ? problem.message : String(problem)))
      .finally(() => setSaving(false));
  };
  return (
    <div class="project" style={{ "--project": projectColour(project.name) }}>
      <span class="project-dot" aria-hidden="true" />
      <span class="project-text">
        {editing ? (
          <input
            class="project-rename"
            type="text"
            value={typed}
            maxLength={PROJECT_NAME_MAX}
            aria-label="Project name"
            ref={(input) => input?.focus()}
            onInput={(event) => setTyped(event.currentTarget.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") finish(true);
              else if (event.key === "Escape") finish(false);
            }}
            onBlur={() => finish(true)}
          />
        ) : (
          <b class="project-name" title={project.renamable ? "Double-click to rename" : "The project this board belongs to"} onDblClick={project.renamable && !saving ? start : undefined}>
            {project.name}
          </b>
        )}
        {refusal && <span class="project-refusal" role="alert">{refusal}</span>}
      </span>
      {project.folders.includes("checkout") && <FolderButton folder="checkout" onError={onError} iconOnly title={checkoutHover(project)} />}
    </div>
  );
}
