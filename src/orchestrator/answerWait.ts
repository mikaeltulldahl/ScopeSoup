// Telling the people at this machine that Scope Soup is idle because everything ready waits for an answer. One desktop
// notification per stretch of waiting, with the count and the first entries. The board's idle
// line stays as the fallback when the notification command cannot run.

import { execFile } from "node:child_process";
import type { Store } from "../store/store.ts";
import { buildIndex } from "../core/snapshot.ts";
import type { Snapshot } from "../core/snapshot.ts";
import { assessAll, yourTurn } from "../core/turns.ts";
import type { TickReport } from "./tick.ts";

const STRETCH_KEY = "orchestrator.answers_wait";
const SHOWN = 3;

/** One entry of "Your turn": the item and what is asked. */
export interface WaitingEntry {
  id: string;
  title: string;
  reason: string;
}

export interface AnswerWaitInput {
  /** Nothing was started this tick and no session runs. */
  idle: boolean;
  /** "Your turn" as a board with no person picked shows it, most urgent first. */
  entries: readonly WaitingEntry[];
  at: string;
}

export type Notify = (title: string, body: string) => Promise<void>;

/** The tick part of the input: idle when nothing started and no session runs; the entries only when idle. */
export function answerWaitInput(
  report: Pick<TickReport, "at" | "started" | "running">,
  snapshot: () => Snapshot,
): AnswerWaitInput {
  const idle = report.started.length === 0 && report.running === 0;
  // The server has no person of its own (each board picks one): every turn, less the items a person holds (they know).
  const entries = idle
    ? yourTurn(assessAll(buildIndex(snapshot()), new Date(report.at))).filter((each) => !(each.turn.actor === "person" && each.situation.item.holder)).map((each) => ({ id: each.situation.item.ref.id, title: each.situation.item.title, reason: each.turn.reason }))
    : [];
  return { idle, entries, at: report.at };
}

/** Text of the notification: the count and the first entries. */
export function answerWaitText(entries: readonly WaitingEntry[]): { title: string; body: string } {
  const first = entries.slice(0, SHOWN).map((entry) => `${entry.id} ${entry.title}`).join("; ");
  const more = entries.length > SHOWN ? `; and ${entries.length - SHOWN} more` : "";
  return {
    title: `Scope Soup is idle: ${entries.length} item${entries.length === 1 ? " waits" : "s wait"} on you`,
    body: `${first}${more}`,
  };
}

/**
 * Called after each tick. While idle with a non-empty Your turn, the first such tick records an
 * `orchestrator.answers_waiting` event and notifies; later ticks of the same stretch do nothing.
 * The stretch ends at the first tick that is not idle or has nothing waiting for an answer.
 * Returns true when it notified.
 */
export async function noteAnswerWait(store: Store, notify: Notify, input: AnswerWaitInput): Promise<boolean> {
  const waiting = input.idle && input.entries.length > 0;
  const inStretch = store.getValue(STRETCH_KEY) === "true";
  if (!waiting) {
    if (inStretch) store.setValue(STRETCH_KEY, "false");
    return false;
  }
  if (inStretch) return false;
  const { title, body } = answerWaitText(input.entries);
  // Marked first: a failing command is not tried again on every tick.
  store.tx(() => {
    store.setValue(STRETCH_KEY, "true");
    store.appendEvent({ kind: "orchestrator.answers_waiting", actor: "orchestrator", data: { reason: `${title}: ${body}`, count: input.entries.length } }, input.at);
  });
  try {
    await notify(title, body);
  } catch (error) {
    const why = error instanceof Error ? error.message : String(error);
    store.appendEvent({ kind: "orchestrator.notify_failed", actor: "orchestrator", data: { reason: `Could not show the desktop notification (the board still shows Your turn): ${why}` } }, input.at);
  }
  return true;
}

/**
 * What the loop's tick hook does: derive the input from the tick report and note the wait.
 * Never throws (a notification must not disturb the loop); resolves to whether it notified.
 */
export async function onTickAnswerWait(
  store: Store,
  notify: Notify,
  report: Pick<TickReport, "at" | "started" | "running">,
  snapshot: () => Snapshot,
): Promise<boolean> {
  try {
    return await noteAnswerWait(store, notify, answerWaitInput(report, snapshot));
  } catch {
    return false;
  }
}

/** The loop's tick hook as main.ts installs it: fire and forget, so the loop never waits on a notification. Resolves to what onTickAnswerWait resolves to (for tests). */
export function answerWaitTickHook(store: Store, notify: Notify, snapshot: () => Snapshot): (report: Pick<TickReport, "at" | "started" | "running">) => Promise<boolean> {
  return (report) => onTickAnswerWait(store, notify, report, snapshot);
}

const POWERSHELL = [
  "Add-Type -AssemblyName System.Windows.Forms",
  "Add-Type -AssemblyName System.Drawing",
  "$n = New-Object System.Windows.Forms.NotifyIcon",
  "$n.Icon = [System.Drawing.SystemIcons]::Information",
  "$n.Visible = $true",
  "$n.ShowBalloonTip(10000, $env:SCOPESOUP_NOTE_TITLE, $env:SCOPESOUP_NOTE_BODY, [System.Windows.Forms.ToolTipIcon]::Info)",
  "Start-Sleep -Seconds 11",
  "$n.Dispose()",
].join("; ");

/** Runs a program with an environment; the default starts a real process (30 s at most). Tests pass a fake. */
export type RunProgram = (file: string, args: string[], env: NodeJS.ProcessEnv) => Promise<void>;

const realRun: RunProgram = (file, args, env) =>
  new Promise((resolve, reject) => {
    execFile(file, args, { env, windowsHide: true, timeout: 30_000 }, (error) => (error ? reject(error) : resolve()));
  });

/** A local desktop notification with the platform's own tool; no dependency and no elevation. Text goes in the environment, never into a command line. */
export function desktopNotify(platform: NodeJS.Platform = process.platform, run: RunProgram = realRun): Notify {
  return (title, body) => {
    const env = { ...process.env, SCOPESOUP_NOTE_TITLE: title, SCOPESOUP_NOTE_BODY: body };
    if (platform === "win32") return run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", POWERSHELL], env);
    if (platform === "darwin") {
      return run("osascript", ["-e", 'display notification (system attribute "SCOPESOUP_NOTE_BODY") with title (system attribute "SCOPESOUP_NOTE_TITLE")'], env);
    }
    return run("notify-send", [title, body], env);
  };
}
