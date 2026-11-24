// The levels as the settings page offers them: one plain sentence each, and what a level needs that the
// configuration or the machine lacks. A level whose needs are missing is shown but cannot be picked, unless the page can ask
// for them right there (level 4's check command and remote URL).
// Only what Scope Soup can tell from here is a need: whether the agent CLI is logged in, or whether the remote takes a push,
// shows only when a session runs, so the sentences say it and the needs do not check it.
// No I/O here, so the board can import the types: the program lookup is given (`programFound` in program.ts).

import { defaultProvider, providerFor } from "../orchestrator/providers/index.ts";
import { mergeQueueCi, LEVEL_NAMES, LEVELS, type Level, type ProjectConfig } from "./types.ts";

/** What Scope Soup does at each level and what it needs, one sentence each. */
export const LEVEL_TEXT: Readonly<Record<Level, string>> = {
  0: "Scope Soup shows your Items, issues and pull requests with their history and starts nothing on its own; it needs only the host it reads.",
  1: `Scope Soup takes a read-only triage at each Item (size, open questions, blockers, a proposed split) and changes no code; it needs ${defaultProvider.label}, logged in.`,
  2: "Scope Soup picks Items from the backlog and runs an implementor in its own clone, which merges to the main branch when it judges the work done; it needs push access to the remote.",
  3: "A reviewer reads every finished change, and the implementor merges only after the reviewer approves; it needs nothing more than level 2.",
  4: "Scope Soup merges reviewed changes itself through its merge queue (newest main merged in, the check command run, a fast-forward push); it needs a check command and the remote's URL.",
};

/** Level 4 with `mergeQueue.ci: "github"`: the project's own CI on GitHub checks each batch instead of the check command. */
export const LEVEL_4_GITHUB_TEXT =
  "Scope Soup merges reviewed changes itself through its merge queue (newest main merged in, a pull request for each batch, every check on GitHub waited for, then a fast-forward push of that commit); with mergeQueue.ci \"github\" it needs a GitHub host with writes on and the remote's URL.";

/** A need the Settings page asks for right where the level is picked, and saves with it. */
export type AskedField = "checkCommand" | "remoteUrl";

/** One row of the level picker. `missing` holds what this level and the ones below it need and do not have. */
export interface LevelChoice {
  level: Level;
  name: string;
  text: string;
  missing: string[];
  /** "Level 4 needs a check command and the remote's URL.", or null when the level has all it needs. */
  blocked: string | null;
  /** The missing needs the page asks for when this level is picked (level 4: checkCommand, remoteUrl). */
  asks: AskedField[];
  /** Whether the level can be picked: nothing missing, or only what the page asks for. */
  pickable: boolean;
}

interface Need {
  text: string;
  asks?: AskedField;
}

/** The needs each level adds on top of the one below, as a person reads them; empty when they are met. */
function ownNeeds(level: Level, config: ProjectConfig, found: (command: string) => boolean): Need[] {
  switch (level) {
    case 1: {
      // Level 1 starts triages; the provider they run on names its program.
      const provider = providerFor(config, "triage");
      const program = provider.program(config);
      return [
        // A Jira host with writes off: Scope Soup can show the project and do nothing more.
        ...(config.host?.kind === "jira" && !config.host.write ? [{ text: "writes on for the Jira host (host.write true)" }] : []),
        ...(found(program) ? [] : [{ text: `${provider.label} (the program "${program}" was not found)` }]),
      ];
    }
    case 4:
      return [
        ...(mergeQueueCi(config) === "github"
          ? config.host?.kind === "github" && config.host.write ? [] : [{ text: 'a GitHub host with writes on (host: kind "github", write true), since mergeQueue.ci is "github"' }]
          : config.checkCommand ? [] : [{ text: "a check command (checkCommand)", asks: "checkCommand" as const }]),
        ...(config.remoteUrl ? [] : [{ text: "the remote's URL (remoteUrl)", asks: "remoteUrl" as const }]),
      ];
    default:
      return [];
  }
}

function andList(parts: string[]): string {
  return parts.length <= 1 ? (parts[0] ?? "") : `${parts.slice(0, -1).join(", ")} and ${parts.at(-1)}`;
}

/** The five rows of the level picker, each with what it lacks; each level needs what the ones below it need. */
export function levelChoices(config: ProjectConfig, found: (command: string) => boolean): LevelChoice[] {
  const needs: Need[] = [];
  return LEVELS.map((level) => {
    needs.push(...ownNeeds(level, config, found));
    const missing = needs.map((need) => need.text);
    const asks = needs.flatMap((need) => (need.asks ? [need.asks] : []));
    return {
      level, name: LEVEL_NAMES[level], text: level === 4 && mergeQueueCi(config) === "github" ? LEVEL_4_GITHUB_TEXT : LEVEL_TEXT[level], missing,
      blocked: missing.length > 0 ? `Level ${level} needs ${andList(missing)}.` : null,
      asks, pickable: asks.length === missing.length,
    };
  });
}

/** A check command found in the repository, and where. */
export interface CheckCandidate {
  command: string[];
  /** "the test script in package.json", "the workflow .github/workflows/ci.yml", "the Makefile". */
  from: string;
}

/**
 * What the page shows for level 4's missing needs, filled from the file where it has them (made in mergeQueue.ts).
 * With `mergeQueue.ci: "github"` there is no check command to ask for; the host is file-only.
 */
export interface MergeQueueSetup {
  /** The command to propose: the file's own, or one made from package.json; null when nothing fits. */
  checkCommand: string[] | null;
  /** Where the proposal came from, in a few words. */
  checkCommandFrom: string;
  /** Why the proposed command could not be started, or null. */
  checkCommandProblem: string | null;
  /** Commands found in the repository to pick from (package.json scripts, CI workflow steps, Makefile targets). */
  checkCandidates?: CheckCandidate[];
  /** The git remote the URL is read from (`remote` in the file). */
  remote: string;
  remoteUrl: string | null;
  /** Why the URL could not be read, or null. */
  remoteUrlProblem: string | null;
}
