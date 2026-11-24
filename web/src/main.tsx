import { h, render } from "preact";
import type { ComponentChildren } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";
import { fetchBoard, post, usePerson, useView } from "./api.ts";
import { PersonPicker } from "./PersonPicker.tsx";
import { ProjectHeader, useProjectTab } from "./ProjectHeader.tsx";
import { History } from "./History.tsx";
import { Usage } from "./Usage.tsx";
import { Item } from "./Item.tsx";
import { ItemList } from "./ItemList.tsx";
import { Overview } from "./Overview.tsx";
import { Queue } from "./Queue.tsx";
import { Settings } from "./Settings.tsx";
import { StopUsing } from "./StopUsing.tsx";
import { UpgradeNote, VersionFooter } from "./Version.tsx";
import { useRoute } from "./route.ts";
import { StatusLine } from "./StatusLine.tsx";
import { THEMES, taglineAt } from "./theme.ts";
import { startThemes, useThemeId } from "./useTheme.ts";
import "./styles.css";

/** The item as a dialog over the view it was opened from. Esc, the close button and the backdrop close it. */
function ItemDialog({ closeHref, children }: { closeHref: string; children: ComponentChildren }) {
  const panel = useRef<HTMLDivElement>(null);
  const close = () => {
    location.hash = closeHref;
  };
  useEffect(() => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    panel.current?.focus({ preventScroll: true });
    document.body.classList.add("dialog-open");
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") location.hash = closeHref;
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.classList.remove("dialog-open");
      opener?.focus({ preventScroll: true });
    };
  }, [closeHref]);
  return (
    <div
      class="dialog-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) close();
      }}
    >
      <div class="dialog" role="dialog" aria-modal="true" aria-label="Item" tabIndex={-1} ref={panel}>
        <button type="button" class="dialog-close" aria-label="Close" onClick={close}>
          ×
        </button>
        {children}
      </div>
    </div>
  );
}

function App() {
  const { route: current, below: route, belowHash } = useRoute();
  const { data: board, error, reload } = useView(fetchBoard, "board");
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);
  const person = usePerson();
  const themeId = useThemeId();
  const theme = THEMES[themeId];
  useProjectTab(board?.project, themeId);

  const act = (path: Parameters<typeof post>[0]) => {
    setBusy(true);
    post(path)
      .then(() => setFailed(null), (problem: unknown) => setFailed(problem instanceof Error ? problem.message : String(problem)))
      .finally(() => {
        setBusy(false);
        reload();
      });
  };
  const status = board?.status;
  // No level: board only (no project configuration), so there is no orchestrator to start.
  const level = status?.level;
  const agents = status?.agents ?? "paused";
  const merging = status?.mergeQueue ?? "paused";
  const agentsWhy = level === 0 ? "Level 0 (Watch) starts no agents. Raise the level on the Settings page." : null;
  const mergeQueueWhy = level !== undefined && level < 4 ? `Autopilot is level 4 (the merge queue merges reviewed changes). This project is at level ${level}.` : null;
  const stopped = agents === "stopped";
  const working = board ? board.status.runners.list.filter((runner) => runner.online && runner.busy).length + board.status.queue.testing : 0;

  return (
    <>
      <header class="top">
        <a class="brand" href="#/" title={taglineAt(theme.words, new Date())}>
          <svg class={`mark${working > 0 ? " active" : ""}`} viewBox="0 0 32 32" role="img" aria-label={working > 0 ? theme.words.statusOn : theme.words.statusOff}>
            {theme.words.logoHover && <title>{theme.words.logoHover}</title>}
            {theme.mark.map((shape, index) => h(shape.tag, { key: index, class: shape.cls, ...shape.attrs }))}
          </svg>
          Scope Soup
        </a>
        {board?.project && <ProjectHeader project={board.project} onError={setFailed} />}
        <PersonPicker known={board?.people ?? []} />
        <nav aria-label="Views">
          <a href="#/" aria-current={route.view === "overview" ? "page" : undefined}>{theme.words.startPage}</a>
          <a href="#/items" aria-current={route.view === "items" ? "page" : undefined}>{theme.words.itemMany.replace(/^./, (first) => first.toUpperCase())}</a>
          <a href="#/queue" aria-current={route.view === "queue" ? "page" : undefined}>Queue</a>
          <a href="#/history" aria-current={route.view === "history" ? "page" : undefined}>History</a>
          <a href="#/usage" aria-current={route.view === "usage" ? "page" : undefined}>Usage</a>
          <a href="#/settings" aria-current={route.view === "settings" || route.view === "stop" ? "page" : undefined}>Settings</a>
        </nav>
        <div class="actions">
          <button type="button" disabled={busy} onClick={() => act("/api/refresh")}>Sync now</button>
          {level !== undefined && (
            <>
              <button
                type="button"
                id="agents-switch"
                class={agents === "started" ? undefined : "primary"}
                disabled={busy || agentsWhy !== null}
                title={agentsWhy ?? (agents === "started" ? "Agents: sessions on items. Pause lets running sessions finish their step and starts nothing new." : "Agents: let Scope Soup start sessions on items again.")}
                onClick={() => act(agents === "started" ? "/api/agents/pause" : "/api/agents/start")}
              >
                {agents === "started" ? "Pause agents" : "Start agents"}
              </button>
              <button
                type="button"
                id="merge-queue-switch"
                class={merging === "started" || mergeQueueWhy ? undefined : "primary"}
                disabled={busy || mergeQueueWhy !== null}
                title={mergeQueueWhy ?? (merging === "started" ? "Merge queue: merges reviewed changes on main. Pause lets a merge under way finish and starts no new one." : "Merge queue: merge reviewed changes on main again.")}
                onClick={() => act(merging === "started" ? "/api/merge-queue/pause" : "/api/merge-queue/start")}
              >
                {merging === "started" ? "Pause merge queue" : "Start merge queue"}
              </button>
              <button
                type="button"
                id="stop-switch"
                class="stop"
                disabled={busy || (stopped && merging === "stopped")}
                title="The stop switch: pauses agents and the merge queue at once, ends running sessions and cuts off a merge under way before it pushes. Start agents (and Start merge queue) must be pressed again."
                onClick={() => act("/api/stop")}
              >
                Stop
              </button>
            </>
          )}
        </div>
      </header>
      {level !== undefined && level > 0 && (stopped || agents === "paused") && (
        <p class="notice notice-paused" role="status" id="paused-banner">
          {stopped ? (
            <>
              <b>Stopped.</b> Running sessions were ended; agents and the merge queue are paused. Press Start agents{level >= 4 ? " and Start merge queue" : ""} to go on.
            </>
          ) : (
            <>
              <b>Agents are paused.</b> Nothing new starts; running sessions finish their step. Press Start agents to go on.
              {level >= 4 && merging !== "started" ? " The merge queue is paused too: no new merge starts." : ""}
            </>
          )}
        </p>
      )}
      {level !== undefined && level >= 4 && agents === "started" && merging !== "started" && (
        <p class="notice notice-paused" role="status" id="merge-queue-banner">
          <b>The merge queue is paused.</b> A merge under way finishes; reviewed changes then wait and no new merge starts. Press Start merge queue to go on.
        </p>
      )}
      {!person && (
        <p class="notice notice-person" role="status" id="person-banner">
          <b>Who are you?</b> Pick your name at the top (or add it). People are equals here: anyone answers Scope Soup's questions, takes and releases Items, and the log records who did.
        </p>
      )}
      <UpgradeNote />
      {(error || failed) && <p class="notice notice-bad" role="alert">{failed ?? `Cannot reach the server: ${error}`}</p>}
      <main>
        {board && route.view !== "settings" && route.view !== "stop" && route.view !== "history" && route.view !== "usage" && route.view !== "items" && <StatusLine status={board.status} />}
        {!board && !error && route.view !== "settings" && route.view !== "stop" && route.view !== "history" && route.view !== "usage" && route.view !== "items" && <p class="empty">Loading…</p>}
        {board && route.view === "overview" && <Overview board={board} />}
        {board && route.view === "queue" && <Queue board={board} />}
        {route.view === "items" && <ItemList key={route.query} query={route.query} />}
        {route.view === "settings" && <Settings project={board?.project} />}
        {route.view === "stop" && <StopUsing stopped={stopped && merging === "stopped"} busy={busy} onStop={() => act("/api/stop")} />}
        {route.view === "history" && <History />}
        {route.view === "usage" && <Usage />}
      </main>
      <VersionFooter />
      {current.view === "item" && (
        <ItemDialog closeHref={belowHash}>
          <Item key={current.key} refKey={current.key} />
        </ItemDialog>
      )}
    </>
  );
}

startThemes();
render(<App />, document.getElementById("app")!);
