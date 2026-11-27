// The four switches on the overview's lanes (src/store/control.ts): triage on To do, implementors on In progress, review on
// In review, the merge queue on Merge queue (the overview's lane for Queued and Checking). Below the level that uses a role its
// switch is not shown.

export type SwitchName = "triage" | "implement" | "review" | "mergeQueue";
export type SwitchState = "started" | "paused" | "stopped";
export type Switches = Record<SwitchName, SwitchState>;

export const SWITCH_NAMES: readonly SwitchName[] = ["triage", "implement", "review", "mergeQueue"];

/** The level from which each switch means something. */
export const SWITCH_LEVEL: Record<SwitchName, number> = { triage: 1, implement: 2, review: 3, mergeQueue: 4 };

/** The lane each switch sits on. */
const LANE_OF: Record<SwitchName, string> = { triage: "todo", implement: "in-progress", review: "in-review", mergeQueue: "merge-queue" };

export const SWITCH_WORDS: Record<SwitchName, string> = { triage: "Triage", implement: "Implementors", review: "Review", mergeQueue: "Merge queue" };

export type SwitchPath = `/api/${"triage" | "implement" | "review" | "merge-queue"}/${"start" | "pause"}`;

/** The switches shown at this level; none without a project configuration (no level). */
export function switchesAt(level: number | undefined): SwitchName[] {
  return level === undefined ? [] : SWITCH_NAMES.filter((name) => SWITCH_LEVEL[name] <= level);
}

/** The switch whose button sits on this lane, if it is shown at this level. */
export function laneSwitch(lane: string, level: number | undefined): SwitchName | null {
  return switchesAt(level).find((name) => LANE_OF[name] === lane) ?? null;
}

/** What pressing the switch does now: Pause when it runs, else Resume. */
export function switchPath(name: SwitchName, state: SwitchState): SwitchPath {
  const base = name === "mergeQueue" ? "merge-queue" : name;
  return `/api/${base}/${state === "started" ? "pause" : "start"}`;
}

export function switchTitle(name: SwitchName, state: SwitchState): string {
  const what: Record<SwitchName, string> = {
    triage: "Triage: sessions that look at new Items.",
    implement: "Implementors: sessions that write the changes.",
    review: "Review: sessions that review the changes.",
    mergeQueue: "Merge queue: merges reviewed changes on main.",
  };
  if (state === "started") return `${what[name]} Pause lets ${name === "mergeQueue" ? "a merge under way finish and starts no new one" : "running sessions finish their step and starts no new one"}; the others go on.`;
  return `${what[name]} ${state === "stopped" ? "Stopped by Stop." : "Paused."} Resume to let it start again.`;
}

/** Every switch shown at this level is paused or stopped (from level 1): the board says so in one short banner. */
export function allPaused(switches: Switches, level: number | undefined): boolean {
  const shown = switchesAt(level);
  return shown.length > 0 && shown.every((name) => switches[name] !== "started");
}

/** The switches shown at this level that are paused or stopped, in lane order. */
export function pausedSwitches(switches: Switches, level: number | undefined): SwitchName[] {
  return switchesAt(level).filter((name) => switches[name] !== "started");
}

/** The words the status bar uses for them: "Paused: implementors, review, merge queue". */
export function pausedText(names: readonly SwitchName[]): string {
  return `Paused: ${names.map((name) => SWITCH_WORDS[name].toLowerCase()).join(", ")}`;
}
