// Limited resources (a license seat, an emulator, a phone on USB, a test database) shared between parallel sessions and
// the merge queue's check. A session or check that needs one takes a unit before it starts and gives it back when it ends; the
// runner gives a session's back however it ended (done, failed, stalled, timed out, stopped). Without a free unit the work waits
// and other work goes on.
// - This machine's resources (`resources`) are counted here.
// - A shared resource (`sharedResources`) is also held on the project's remote, one merge-queue-style lease per unit
//   (`refs/scopesoup/resources/<name>/<unit>`, mergeQueue.ts): a unit another machine holds is not free here. A lease lasts the longest a
//   session (with its setup) or a check may run, so it needs no renewal; one whose holder died lapses by itself.
// What is held and what waits is kept in the store for the board (`KEYS.resources`). Nothing survives a restart: the sessions
// do not either (the runner's reconcile ends them), so `recover` gives everything back at start.

import type { ProjectConfig, ResourceConfig, ResourceUser } from "../config/types.ts";
import type { ResourcesView } from "../core/views.ts";
import { KEYS } from "../store/keys.ts";
import type { Store } from "../store/store.ts";
import type { MergeQueue } from "./mergeQueue.ts";
import { plural } from "../model/plural.ts";

/** The holder name of the merge queue's check. A session's holder is its Item's refKey. */
export const CHECK_HOLDER = "check";

/** The ref of one unit of a shared resource on the remote. */
export const unitRef = (resource: string, unit: number): string => `refs/scopesoup/resources/${resource}/${unit}`;

interface Held {
  resource: string;
  unit: number;
  holder: string;
  /** For the board: "implement for A-12", "the check of batch 3". */
  label: string;
  since: string;
}

interface Waiting {
  resource: string;
  holder: string;
  label: string;
  since: string;
}

/** A unit of a shared resource another machine held when this one last tried it. */
interface Elsewhere {
  resource: string;
  unit: number;
  machine: string;
  until?: string;
}

interface State {
  held: Held[];
  waiting: Waiting[];
  elsewhere: Elsewhere[];
}

export type Taken = { ok: true; env: Record<string, string> } | { ok: false; why: string; resource: string; first: boolean };

export interface Resources {
  /** Takes a unit of every resource `user` needs, all or none. `first`: this holder was not waiting for it yet. */
  take(holder: string, label: string, user: ResourceUser): Promise<Taken>;
  /** Gives back every unit `holder` holds. Never throws: a lease not let go lapses by itself. */
  give(holder: string): Promise<void>;
  /** Forgets the sessions that waited (the tick says again which still do); the check's wait stays. */
  clearSessionWaits(): void;
  /** At start: gives back what an earlier run held, here and on the remote. */
  recover(): Promise<void>;
}

export interface ResourcesDeps {
  store: Store;
  config: () => ProjectConfig;
  /** ISO 8601, UTC. */
  now: () => string;
  /** The lease of one unit of a shared resource on the remote. Absent: shared resources are counted on this machine only. */
  lease?: (resource: string, unit: number) => MergeQueue;
}

export function readResourceState(store: Pick<Store, "getValue">): State {
  try {
    const value = JSON.parse(store.getValue(KEYS.resources) ?? "") as Partial<State>;
    return { held: value.held ?? [], waiting: value.waiting ?? [], elsewhere: value.elsewhere ?? [] };
  } catch {
    return { held: [], waiting: [], elsewhere: [] };
  }
}

/** `{{unit}}` in each value is the unit's number. */
export function unitEnv(resource: ResourceConfig, unit: number): Record<string, string> {
  return Object.fromEntries(Object.entries(resource.env).map(([name, text]) => [name, text.split("{{unit}}").join(String(unit))]));
}

/** The longest a unit stays held without a give: a session with its setup, or a check with its setup, and a margin. */
function leaseMinutes(config: ProjectConfig): number {
  const { sessionTimeoutMinutes, checkTimeoutMinutes } = config.settings;
  return Math.max(sessionTimeoutMinutes.value, checkTimeoutMinutes.value) + checkTimeoutMinutes.value + 15;
}

export function createResources(deps: ResourcesDeps): Resources {
  const { store } = deps;
  // The state lives in memory while Scope Soup runs (takes may interleave across awaits), and is written for the board on every change.
  let state: State = { held: [], waiting: [], elsewhere: [] };
  const write = (): void => {
    // What another machine holds is shown only while something here waits for that resource: nobody looks otherwise.
    state.elsewhere = state.elsewhere.filter((each) => state.waiting.some((wait) => wait.resource === each.resource));
    store.setValue(KEYS.resources, JSON.stringify(state));
  };
  const declared = (): ResourceConfig[] => {
    try {
      return deps.config().resources ?? [];
    } catch {
      return [];
    }
  };

  /** Lets one held unit go, on the remote too for a shared resource. */
  async function letGo(unit: Held, shared: boolean): Promise<void> {
    if (!shared || !deps.lease) return;
    try {
      await deps.lease(unit.resource, unit.unit).release(deps.now());
    } catch {
      // It lapses by itself.
    }
  }

  /** A free unit of `resource` for `holder`, marked held before anything is awaited; null and why when there is none. */
  async function takeOne(resource: ResourceConfig, holder: string, label: string): Promise<{ held: Held } | { why: string }> {
    const at = deps.now();
    const mine = new Set(state.held.filter((each) => each.resource === resource.name).map((each) => each.unit));
    const others: Elsewhere[] = [];
    for (let unit = 1; unit <= resource.units; unit++) {
      if (mine.has(unit)) continue;
      const held: Held = { resource: resource.name, unit, holder, label, since: at };
      state.held.push(held);
      if (!resource.shared || !deps.lease) return { held };
      const lease = await deps.lease(resource.name, unit).acquire(at, leaseMinutes(deps.config()));
      if (lease.held) {
        state.elsewhere = state.elsewhere.filter((each) => !(each.resource === resource.name && each.unit === unit));
        return { held };
      }
      state.held = state.held.filter((each) => each !== held);
      others.push(lease.holder ? { resource: resource.name, unit, machine: lease.holder, ...(lease.until ? { until: lease.until } : {}) } : { resource: resource.name, unit, machine: `unknown (${lease.why})` });
    }
    if (resource.shared && deps.lease) state.elsewhere = [...state.elsewhere.filter((each) => each.resource !== resource.name), ...others];
    const here = state.held.filter((each) => each.resource === resource.name).map((each) => each.label);
    const there = others.map((each) => each.machine);
    const by = [...here, ...there.map((machine) => `${machine}${machine.startsWith("unknown") ? "" : " (another machine)"}`)];
    return { why: `all ${plural(resource.units, "unit")} of ${resource.name} ${resource.units === 1 ? "is" : "are"} held${by.length > 0 ? `: ${by.join(", ")}` : ""}` };
  }

  return {
    async take(holder, label, user) {
      const needed = declared().filter((resource) => resource.neededBy.includes(user));
      if (needed.length === 0) return { ok: true, env: {} };
      const taken: { resource: ResourceConfig; held: Held }[] = [];
      for (const resource of needed) {
        const already = state.held.find((each) => each.resource === resource.name && each.holder === holder);
        if (already) {
          taken.push({ resource, held: already });
          continue;
        }
        const one = await takeOne(resource, holder, label);
        if ("why" in one) {
          // All or none: what was taken for this start goes back.
          for (const each of taken) {
            state.held = state.held.filter((held) => held !== each.held);
            await letGo(each.held, each.resource.shared);
          }
          const first = !state.waiting.some((each) => each.holder === holder && each.resource === resource.name);
          state.waiting = [...state.waiting.filter((each) => each.holder !== holder), { resource: resource.name, holder, label, since: first ? deps.now() : state.waiting.find((each) => each.holder === holder)!.since }];
          write();
          return { ok: false, why: one.why, resource: resource.name, first };
        }
        taken.push({ resource, held: one.held });
      }
      state.waiting = state.waiting.filter((each) => each.holder !== holder);
      write();
      return { ok: true, env: Object.assign({}, ...taken.map((each) => unitEnv(each.resource, each.held.unit))) as Record<string, string> };
    },

    async give(holder) {
      const mine = state.held.filter((each) => each.holder === holder);
      if (mine.length === 0) return;
      state.held = state.held.filter((each) => each.holder !== holder);
      write();
      const shared = new Set(declared().filter((each) => each.shared).map((each) => each.name));
      for (const unit of mine) await letGo(unit, shared.has(unit.resource));
    },

    clearSessionWaits() {
      const kept = state.waiting.filter((each) => each.holder === CHECK_HOLDER);
      if (kept.length === state.waiting.length) return;
      state.waiting = kept;
      write();
    },

    async recover() {
      state = { held: [], waiting: [], elsewhere: [] };
      write();
      if (!deps.lease) return;
      for (const resource of declared().filter((each) => each.shared)) {
        for (let unit = 1; unit <= resource.units; unit++) {
          try {
            // Lets go only a lease this machine holds.
            await deps.lease(resource.name, unit).release(deps.now());
          } catch {
            // It lapses by itself.
          }
        }
      }
    },
  };
}

/** The board's view: each declared resource with who holds its units and what waits for it. */
export function resourcesView(declared: readonly ResourceConfig[], state: State): ResourcesView {
  return {
    resources: declared.map((resource) => ({
      name: resource.name,
      units: resource.units,
      shared: resource.shared,
      neededBy: resource.neededBy,
      held: [
        ...state.held.filter((each) => each.resource === resource.name).map((each) => ({ unit: each.unit, who: each.label, since: each.since })),
        ...state.elsewhere.filter((each) => each.resource === resource.name).map((each) => ({ unit: each.unit, who: each.machine, ...(each.until ? { until: each.until } : {}), elsewhere: true as const })),
      ].sort((a, b) => a.unit - b.unit),
      waiting: state.waiting.filter((each) => each.resource === resource.name).map((each) => ({ who: each.label, since: each.since })),
    })),
  };
}
