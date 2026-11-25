import { h, render } from "preact";
import type { ComponentChildren } from "preact";
import { useCallback, useState } from "preact/hooks";
import { fetchBoard, post, usePerson, useView } from "./api.ts";
import { Dialog } from "./Dialog.tsx";
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
import { BranchProtectionNote, UpgradeNote, VersionFooter } from "./Version.tsx";
import { MachineSetupNote } from "./Connect.tsx";
import { useRoute } from "./route.ts";
import { StatusLine } from "./StatusLine.tsx";
import { Toasts } from "./Pending.tsx";
import { allPaused, switchesAt } from "./switches.ts";
import { mergeLane, queueShown } from "./mergeLane.ts";
import { THEMES, taglineAt } from "./theme.ts";
import { startThemes, useThemeId } from "./useTheme.ts";
import "./styles.css";

/** The item as a dialog over the view it was opened from. Esc, the close button and the backdrop close it. */
function ItemDialog({ closeHref, children }: { closeHref: string; children: ComponentChildren }) {
  const close = useCallback(() => {
    location.hash = closeHref;
  }, [closeHref]);
  return (
    <Dialog label="Item" onClose={close}>
      {children}
    </Dialog>
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
  const switches = { triage: status?.triage ?? "paused", implement: status?.implement ?? "paused", review: status?.review ?? "paused", mergeQueue: status?.mergeQueue ?? "paused" } as const;
  // Stop is pressed once per stop: all four read "stopped" until each is resumed.
  const allStopped = Object.values(switches).every((state) => state === "stopped");
  const anyStopped = Object.values(switches).some((state) => state === "stopped");
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
        <PersonPicker known={board?.people ?? []} names={board?.peopleNames} />
        <nav aria-label="Views">
          <a href="#/" aria-current={route.view === "overview" ? "page" : undefined}>{theme.words.startPage}</a>
          <a href="#/items" aria-current={route.view === "items" ? "page" : undefined}>{theme.words.itemMany.replace(/^./, (first) => first.toUpperCase())}</a>
          {(!board || queueShown(level, mergeLane(board.lanes.find((lane) => lane.lane === "queued"), board.lanes.find((lane) => lane.lane === "checking"), board.queue).count)) && (
            <a href="#/queue" aria-current={route.view === "queue" ? "page" : undefined}>Merge queue</a>
          )}
          <a href="#/history" aria-current={route.view === "history" ? "page" : undefined}>History</a>
          <a href="#/usage" aria-current={route.view === "usage" ? "page" : undefined}>Usage</a>
          <a href="#/settings" aria-current={route.view === "settings" || route.view === "stop" ? "page" : undefined}>Settings</a>
        </nav>
        <div class="actions">
          <button type="button" disabled={busy} onClick={() => act("/api/refresh")}>Sync now</button>
          {level !== undefined && (
            <button
              type="button"
              id="stop-switch"
              class="stop"
              disabled={busy || allStopped}
              title="The stop switch: pauses triage, implementors, review and the merge queue at once, ends running sessions and cuts off a merge under way before it pushes. Each must be resumed on its lane again."
              onClick={() => act("/api/stop")}
            >
              Stop
            </button>
          )}
        </div>
      </header>
      {/* One switch paused shows on its lane; only when everything is paused does the board say so here. */}
      {allPaused(switches, level) && (
        <p class="notice notice-paused" role="status" id="paused-banner">
          {anyStopped ? <b>Stopped.</b> : <b>Everything is paused.</b>} {anyStopped ? "Running sessions were ended; nothing new starts." : "Nothing new starts; running sessions finish their step."} Press Resume on {switchesAt(level).length > 1 ? "the lanes" : "the Backlog"} to go on.
        </p>
      )}
      {!person && (
        <p class="notice notice-person" role="status" id="person-banner">
          <b>Who are you?</b> Pick your name at the top (or add it). People are equals here: anyone answers Scope Soup's questions, takes and releases Items, and the log records who did.
        </p>
      )}
      {/* A switch that changes takes the note off on the server; read it again at once. */}
      <UpgradeNote switches={Object.values(switches).join(" ")} />
      <BranchProtectionNote />
      <MachineSetupNote />
      {(error || failed) && <p class="notice notice-bad" role="alert">{failed ?? `Cannot reach the server: ${error}`}</p>}
      <main>
        {board && route.view !== "settings" && route.view !== "stop" && route.view !== "history" && route.view !== "usage" && route.view !== "items" && <StatusLine status={board.status} />}
        {!board && !error && route.view !== "settings" && route.view !== "stop" && route.view !== "history" && route.view !== "usage" && route.view !== "items" && <p class="empty">Loading…</p>}
        {board && route.view === "overview" && <Overview board={board} busy={busy} onSwitch={act} />}
        {board && route.view === "queue" && <Queue board={board} />}
        {route.view === "items" && <ItemList key={route.query} query={route.query} />}
        {route.view === "settings" && <Settings project={board?.project} openHistory={route.history === true} />}
        {route.view === "stop" && <StopUsing stopped={allStopped} busy={busy} onStop={() => act("/api/stop")} />}
        {route.view === "history" && <History />}
        {route.view === "usage" && <Usage />}
      </main>
      <VersionFooter />
      {current.view === "item" && (
        <ItemDialog closeHref={belowHash}>
          <Item key={current.key} refKey={current.key} resources={board?.resources} />
        </ItemDialog>
      )}
      {/* The State menu's Undo toasts live here, so closing the Item or changing view keeps their timers. */}
      <Toasts />
    </>
  );
}

startThemes();
render(<App />, document.getElementById("app")!);
