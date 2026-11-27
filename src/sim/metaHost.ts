// The simulator's meta branch: a remote in memory with compare-and-swap writes (decision 7, and the plan's later remote-only
// writes), and a Host over it built from the pure parts of the real one (`serialize.ts`, `item.ts`, `map.ts`). Every write reads
// the remote's version, builds the next files, and swaps only if the remote has not moved; otherwise it reads again and decides
// again. No three-way merge, no local state. The remote refuses a write that changes or removes a log line (rule E2).

import { patched } from "../hosts/metaBranch/adapter.ts";
import { parseItem } from "../hosts/metaBranch/item.ts";
import type { ItemFields } from "../hosts/metaBranch/item.ts";
import { mapItems } from "../hosts/metaBranch/map.ts";
import { canonicalItem, serializeItem, serializeLogLine } from "../hosts/metaBranch/serialize.ts";
import type { Change, Ref, WorkItem } from "../model/types.ts";
import type { Host, LogLineInput, NewWork, Page, WorkPatch, WriteOutcome, WritePort } from "../ports/host.ts";

export interface MetaFiles {
  itemMd: string;
  log: string;
}

/** The shared remote. Several hosts (machines) may write to it; each write is a compare-and-swap on `version`. */
export class MetaRemote {
  version = 0;
  files: ReadonlyMap<string, MetaFiles> = new Map();
  /** The next number per id prefix. */
  next = new Map<string, number>();
  /** While above 0 the remote does not answer (the world step "the host fails for a few steps"). */
  down = 0;
  /** Writes the remote refused because they changed or removed a log line. */
  refusedRewrites: string[] = [];
  /** How many swaps lost the race and were decided again. */
  retries = 0;

  /** Swaps in `next` if the remote is still at `expected`. Throws on a write that is not append-only. */
  swap(expected: number, next: ReadonlyMap<string, MetaFiles>): boolean {
    if (this.down > 0) throw new Error("the remote did not answer");
    if (expected !== this.version) return false;
    for (const [id, before] of this.files) {
      const after = next.get(id);
      if (!after || !after.log.startsWith(before.log)) {
        const why = `the write would ${after ? "change" : "remove"} the log of ${id}`;
        this.refusedRewrites.push(why);
        throw new Error(`The remote refused it: ${why}.`);
      }
    }
    this.files = next;
    this.version++;
    return true;
  }

  read(): { version: number; files: ReadonlyMap<string, MetaFiles> } {
    if (this.down > 0) throw new Error("the remote did not answer");
    return { version: this.version, files: this.files };
  }
}

export interface MetaHostOptions {
  remote: MetaRemote;
  machine: string;
  idPrefix: string;
  now: () => string;
  id?: string;
}

const HOST = "metaBranch";

/** A Host over the remote, as the real meta branch host is with writes on and a remote to share with. */
export function metaHost(options: MetaHostOptions): Host {
  const { remote, machine, idPrefix, now } = options;
  const host = options.id ?? HOST;
  const scope = () => ({ host, target: "main", fallbackTime: now() });

  function readAll(): { works: WorkItem[]; changes: Change[]; version: number } {
    const { version, files } = remote.read();
    const mapped = mapItems(scope(), [...files].map(([id, f]) => ({ id, itemMd: f.itemMd, log: f.log })));
    return { works: mapped.works, changes: mapped.changes, version };
  }

  const idOf = (ref: Ref): string => {
    if (ref.host !== host || ref.kind !== "work") throw new Error(`${ref.host}:${ref.kind}:${ref.id} is not an item of ${host}.`);
    return ref.id;
  };

  const line = (input: LogLineInput): string =>
    serializeLogLine({ at: now(), by: { who: input.by.who, machine, agent: input.by.agent }, kind: input.kind, ...(input.fields ? { fields: input.fields } : {}) });

  /** Reads, changes and swaps, again on a lost race, at most 5 times. */
  function write(id: string | null, change: (files: Map<string, MetaFiles>, id: string) => void): WriteOutcome {
    for (let attempt = 0; attempt < 5; attempt++) {
      const { version, files } = remote.read();
      const next = new Map(files);
      let target = id;
      if (target === null) {
        const n = remote.next.get(idPrefix) ?? 1;
        target = `${idPrefix}-${n}`;
      }
      change(next, target);
      if (remote.swap(version, next)) {
        if (id === null) remote.next.set(idPrefix, (remote.next.get(idPrefix) ?? 1) + 1);
        return { work: { host, kind: "work", id: target }, shared: "shared", conflict: false };
      }
      remote.retries++;
    }
    throw new Error("the remote kept moving");
  }

  const fieldsOf = (files: Map<string, MetaFiles>, id: string): ItemFields => {
    const there = files.get(id);
    if (!there) throw new Error(`There is no item ${id}.`);
    const parsed = parseItem(there.itemMd, id);
    if (!parsed.ok) throw new Error(`The item ${id} cannot be read: ${parsed.problems.join("; ")}`);
    return parsed.fields;
  };

  const writePort: WritePort = {
    async createWork(input: NewWork) {
      const fields = canonicalItem({
        title: input.title, ...(input.body !== undefined ? { body: input.body } : {}), ...(input.state ? { state: input.state } : {}),
        ...(input.labels ? { labels: input.labels } : {}), ...(input.blockedBy ? { blockedBy: input.blockedBy.map(idOf) } : {}),
        ...(input.verification ? { verification: input.verification } : {}), ...(input.priority ? { priority: input.priority } : {}),
      });
      return write(null, (files, id) => {
        const lines = (input.log ?? []).map(line);
        files.set(id, { itemMd: serializeItem(id, fields), log: lines.map((l) => `${l}\n`).join("") });
      });
    },
    async editWork(target: Ref, patch: WorkPatch) {
      const id = idOf(target);
      return write(id, (files) => {
        const next = patched(fieldsOf(files, id), patch, idOf);
        files.set(id, { itemMd: serializeItem(id, next), log: files.get(id)!.log });
      });
    },
    async appendLog(target: Ref, input: LogLineInput) {
      const id = idOf(target);
      return write(id, (files) => {
        const there = files.get(id);
        if (!there) throw new Error(`There is no item ${id}.`);
        files.set(id, { itemMd: there.itemMd, log: `${there.log}${line(input)}\n` });
      });
    },
    async appendLogs(target: Ref, inputs: LogLineInput[]) {
      const id = idOf(target);
      return write(id, (files) => {
        const there = files.get(id);
        if (!there) throw new Error(`There is no item ${id}.`);
        files.set(id, { itemMd: there.itemMd, log: `${there.log}${inputs.map((i) => `${line(i)}\n`).join("")}` });
      });
    },
  };

  const page = <T extends { ref: Ref }>(items: T[], version: number): Page<T> => ({ items, cursor: String(version) });

  return {
    info: {
      id: host, capabilities: new Set(["work", "changes", "write"]), machine, shared: true,
      whoami: async () => ({ id: `scopesoup@${machine}`, name: `scopesoup on ${machine}` }),
    },
    work: {
      async listWork() {
        const all = readAll();
        return page(all.works, all.version);
      },
      async getWork(ref) {
        return readAll().works.find((w) => w.ref.id === ref.id) ?? null;
      },
    },
    changes: {
      async listChanges() {
        const all = readAll();
        return page(all.changes, all.version);
      },
      async getChange(ref) {
        return readAll().changes.find((c) => c.ref.id === ref.id) ?? null;
      },
    },
    write: writePort,
  };
}
