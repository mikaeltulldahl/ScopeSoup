// The status line: what nobody is told today. Runners, usage windows, the queue, sync.

import { refKey } from "../model/types.ts";
import type { Index, RunnerState } from "./snapshot.ts";
import { forecastWindow } from "./forecast.ts";
import type { ForecastLoad } from "./forecast.ts";
import { durationWords, ms } from "./snapshot.ts";
import type { BoardView, QueueView, RunnerView, StatusLine, StatusView } from "./views.ts";
import type { Lane } from "./lanes.ts";
import { LANES, isLive, laneOf } from "./lanes.ts";

function runnerView(runner: RunnerState, index: Index, now: Date): RunnerView {
  const run = runner.current ? index.run.get(refKey(runner.current)) : undefined;
  const since = runner.since ?? (runner.busy ? run?.startedAt : undefined);
  const then = ms(since);
  const span = then === null ? "" : ` ${durationWords(now.getTime() - then)}`;
  let words: string;
  if (!runner.online) words = span ? `away for${span}` : "away";
  else if (runner.busy) words = `online, busy${span}`;
  else words = span ? `online, idle for${span}` : "online, idle";
  const view: RunnerView = { id: runner.id, name: runner.name, online: runner.online, busy: runner.busy, words };
  if (since) view.since = since;
  return view;
}

/** What the usage forecast plans with: the pause, and whether work is ready. Undefined without a plan. */
export function forecastLoad(index: Index): ForecastLoad | undefined {
  const { snapshot } = index;
  if (snapshot.plannedSessions === undefined) return undefined;
  const workReady =
    snapshot.sessions.some(isLive) ||
    snapshot.works.some((item) => {
      const lane = laneOf(item, index);
      return lane === "todo" || lane === "in-progress";
    });
  return { paused: snapshot.paused, workReady };
}

export function buildStatusLine(index: Index, queue: QueueView, now: Date): StatusLine {
  const { snapshot } = index;
  const list = snapshot.runners.map((runner) => runnerView(runner, index, now));
  const online = list.filter((runner) => runner.online).length;
  const counts = {
    waiting: queue.waiting.length,
    forming: queue.forming.length,
    testing: queue.batches.filter((batch) => batch.status === "testing").length,
    bisecting: queue.batches.filter((batch) => batch.status === "bisecting").length,
  };
  const alerts: string[] = [];
  const load = forecastLoad(index);
  const work = counts.waiting + counts.forming + counts.testing + counts.bisecting;
  if (list.length > 0 && online === 0 && work > 0) alerts.push("No runner is online and work is waiting for one.");
  for (const batch of queue.batches) {
    if (batch.status === "bisecting" && !batch.members.some((member) => member.suspect) && !batch.bisect?.culprit) alerts.push(`${batch.name} is red with no suspect yet.`);
    if (batch.progress.likelyStuck) alerts.push(`${batch.name} is likely stuck: ${batch.progress.words}.`);
  }
  const health = snapshot.queue;
  if (health?.paused) alerts.push(`The merge queue is paused: ${health.paused.reason} Resume it on the Queue page.`);
  const lately = health?.notes.filter((note) => note.kind === "problem" && now.getTime() - (ms(note.at) ?? 0) < 24 * 3600_000) ?? [];
  const lastProblem = lately.at(-1);
  if (lastProblem && !health?.paused) alerts.push(`The merge queue reported a problem: ${lastProblem.text}`);
  if (snapshot.sync.error) alerts.push(`The last sync failed: ${snapshot.sync.error}`);
  if (snapshot.usage?.status === "rejected") alerts.push("The usage limit is reached; sessions wait for the reset.");
  return {
    paused: snapshot.paused,
    agents: snapshot.agents,
    triage: snapshot.triage,
    implement: snapshot.implement,
    review: snapshot.review,
    mergeQueue: snapshot.mergeQueue,
    ...(snapshot.level === undefined ? {} : { level: snapshot.level }),
    runners: { online, busy: list.filter((runner) => runner.online && runner.busy).length, total: list.length, list },
    usage: snapshot.usage
      ? {
          at: snapshot.usage.at,
          status: snapshot.usage.status,
          windows: snapshot.usage.windows.map((window) => {
            const forecast = forecastWindow(snapshot.usageHistory ?? [], window.kind, now, load);
            const reset = Date.parse(window.resetsAt) <= now.getTime();
            const utilization = reset && window.utilization !== undefined ? 0 : window.utilization;
            return { kind: window.kind, label: window.kind === "five_hour" ? "5 h" : "week", utilization, resetsAt: window.resetsAt, ...(reset ? { reset: true as const } : {}), ...(forecast ? { forecast } : {}) };
          }),
        }
      : null,
    queue: counts,
    sync: { ...snapshot.sync },
    ...(snapshot.share ? { share: snapshot.share } : {}),
    ...(snapshot.idle ? { idle: snapshot.idle } : {}),
    alerts,
  };
}

/** The board boiled down for `GET /api/status`. */
export function toStatusView(board: BoardView): StatusView {
  const lanes = Object.fromEntries(LANES.map((lane) => [lane, 0])) as Record<Lane, number>;
  for (const lane of board.lanes) lanes[lane.lane] = lane.total;
  return {
    now: board.now,
    paused: board.status.paused,
    agents: board.status.agents,
    triage: board.status.triage,
    implement: board.status.implement,
    review: board.status.review,
    mergeQueue: board.status.mergeQueue,
    ...(board.status.level === undefined ? {} : { level: board.status.level }),
    lanes,
    yourTurn: board.yourTurn.map((card) => ({ ref: card.key, label: card.label, title: card.title, reason: card.reason, unblocks: card.unblocks })),
    batches: [...board.queue.batches, ...board.queue.forming].map((batch) => ({
      name: batch.name,
      status: batch.status,
      words: batch.words,
      members: batch.members.map((member) => member.items[0]?.label ?? member.change.label),
      progress: batch.progress.words,
    })),
    queue: board.status.queue,
    runners: board.status.runners.list.map((runner) => ({ name: runner.name, words: runner.words })),
    usage: (board.status.usage?.windows ?? []).map((window) => ({ kind: window.kind, utilization: window.utilization, resetsAt: window.resetsAt, ...(window.reset ? { reset: true as const } : {}), ...(window.forecast ? { forecast: window.forecast } : {}) })),
    sync: board.status.sync,
    ...(board.status.share ? { share: board.status.share } : {}),
    alerts: board.status.alerts,
  };
}
