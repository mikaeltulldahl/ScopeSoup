// Reads the configuration: this machine's private file and the project's shared settings, read from the meta ref
// `refs/scopesoup/meta` of the repository the private file names (shared.ts, metaSettings.ts). A bad reload keeps the last good configuration and reports why. A file of an older
// format is migrated (migrate.ts) and written back, with a copy of the old file beside it (write.ts).

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { CONFIG_VERSION, formatOf } from "./migrate.ts";
import type { ProjectConfig } from "./types.ts";
import { metaSettings } from "./metaSettings.ts";
import { parseShared, repositoryOf, SHARED_WHERE, type SharedRead, type SharedSettings, validateFiles } from "./shared.ts";
import { backupPath, configText, writeConfigFile } from "./write.ts";

export const CONFIG_FILE = "scopesoup.config.json";

export interface ConfigState {
  /** The last good configuration; null when none has ever loaded. */
  config: ProjectConfig | null;
  /** Why the newest read was rejected. Absent when the file on disk is the one in use. */
  error?: string;
  /** True when this read replaced the configuration in use. */
  changed: boolean;
  /** What a migration to the current format changed, one line each; set when this read replaced the configuration. */
  notices?: string[];
}

export interface ConfigSource {
  load(): ConfigState;
}

export interface LoaderOptions {
  /**
   * How a file of an older format is written back in the current one: writeConfigFile by default; injectable for tests.
   * false: read it migrated in memory and leave the file alone (the item commands, which a session may run).
   */
  write?: false | ((path: string, text: string, backup: { version: number }) => string | null);
  /** Where the shared settings are read from: the meta ref by default; tests give their own. */
  shared?: SharedSettings;
  /** How long a read of the shared settings is used before git is asked again: 2 s by default, 0 for a source given. */
  sharedTtlMs?: number;
}

/** `readFile` is injectable for tests. */
export function createConfigLoader(file: string, readFile: (path: string) => string = (path) => readFileSync(path, "utf8"), options: LoaderOptions = {}): ConfigSource {
  const write = options.write ?? writeConfigFile;
  const shared = options.shared ?? metaSettings();
  const ttl = options.sharedTtlMs ?? (options.shared ? 0 : 2000);
  const path = resolve(file);
  let good: ProjectConfig | null = null;
  let goodText: string | null = null;
  let cached: { key: string; at: number; read: SharedRead } | null = null;
  const readShared = (repoPath: string): SharedRead => {
    const key = repoPath;
    if (cached && cached.key === key && Date.now() - cached.at < ttl) return cached.read;
    const read = shared.read(repoPath);
    cached = { key, at: Date.now(), read };
    return read;
  };

  return {
    load() {
      let text: string;
      try {
        text = readFile(path);
      } catch (error) {
        return { config: good, error: `Cannot read ${path}: ${message(error)}`, changed: false };
      }
      let raw: unknown;
      try {
        raw = JSON.parse(text);
      } catch (error) {
        return { config: good, error: `${path} is not valid JSON: ${message(error)}`, changed: false };
      }
      const where = repositoryOf(raw, dirname(path));
      const sharedRead = parseShared(readShared(where.repoPath));
      if (!sharedRead.ok) return { config: good, error: sharedRead.error, changed: false };
      const both = JSON.stringify([text, sharedRead.text]);
      if (both === goodText) return { config: good, changed: false };
      const result = validateFiles(raw, sharedRead.raw, dirname(path));
      // A file that does not load is not migrated either: it is changed only into a file Scope Soup can read.
      if (!result.ok) {
        const format = typeof raw === "object" && raw !== null && !Array.isArray(raw) ? formatOf(raw as Record<string, unknown>) : null;
        const note = format !== null && format < CONFIG_VERSION ? ` The file is format ${format}: it was not changed, and is migrated to format ${CONFIG_VERSION} once it loads.` : "";
        return { config: good, error: `${path} with ${SHARED_WHERE}: ${result.errors.join(" ")}${note}`, changed: false };
      }
      const { from, notices: changes } = result;
      const old = from < CONFIG_VERSION;
      let notices: string[] = [];
      let read = text;
      if (old && write !== false) {
        const out = configText(result.raw, text);
        const failed = write(path, out, { version: from });
        if (failed) {
          return { config: good, error: `${path} is format ${from} and must be migrated to format ${CONFIG_VERSION}, but ${failed} Make it writable and start again. The migration would change: ${changes.join(" ") || `only "version": ${CONFIG_VERSION}.`}`, changed: false };
        }
        read = out;
        notices = [`${path} was migrated from format ${from} to format ${CONFIG_VERSION}; the old file is kept as ${backupPath(path, from)}.`, ...changes];
      } else if (old) {
        notices = [`${path} is format ${from}: it is read as format ${CONFIG_VERSION}, and Scope Soup writes it so when it starts.`, ...changes];
      }
      good = result.config;
      goodText = JSON.stringify([read, sharedRead.text]);
      return { config: good, changed: true, ...(notices.length > 0 ? { notices } : {}) };
    },
  };
}

/** A fixed configuration, for tests and embedding. */
export function fixedConfig(config: ProjectConfig): ConfigSource {
  return { load: () => ({ config, changed: false }) };
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
