// The one interface between Scope Soup and an agent provider: the agent CLI Scope Soup starts for a session.
// Everything that depends on which CLI runs sits behind it, in `providers/<name>/`: starting a session, reading its events,
// resuming it, limiting its commands, reading usage, and asking for an answer that fits a schema. The runner, the cycle and
// the board use only this. `docs/research/providers.md` is what it was shaped from.

import type { ProjectConfig } from "../config/types.ts";
import type { AllowanceWords } from "../core/allowanceBudget.ts";
import type { SessionRole, UsageSample } from "../model/types.ts";

/** A process environment. Spelled out, not `NodeJS.ProcessEnv`: the board's build reads these types without Node's. */
export type Env = Record<string, string | undefined>;

/**
 * How the CLI holds a session to the commands its role may run (a core rule, `docs/RULES.md`):
 * - "allowlist": the CLI refuses every command that is not on the role's list (`roles.<role>.allowedTools`).
 * - "sandbox": the CLI only keeps the session in a sandbox and refuses what deny rules name; any other command runs.
 * The runner starts sessions only on "allowlist" until a person decides that a sandbox is enough.
 */
export type CommandLimit = "allowlist" | "sandbox";

/** What the person should change when the program cannot be started (a shell shim on Windows, or not found at all). */
export interface ProgramAdvice {
  shim: string;
  missing: string;
}

/** One session to start, or one more turn of a session to resume. */
export interface LaunchRequest {
  config: ProjectConfig;
  role: SessionRole;
  /** All the session is sent: the rendered prompt, or only the message for a resumed session. */
  prompt: string;
  /** The answer's JSON schema on one line: the session must end with an answer that fits it. Absent: free text. */
  schema?: string;
  /** The agent's own session id (from an `init` event) to continue. */
  resume?: string;
  /** A chat turn: the reply is to stream as it is written. */
  partial: boolean;
  /** The environment the child would inherit; the provider may take out what must not reach it. */
  env: Env;
  /** Where the runner writes the session's stdout. A provider may keep a file of its own beside it (`<streamPath>.<suffix>`). */
  streamPath?: string;
  /** The Node program that runs Scope Soup, for a provider that runs a helper script of its own with it. */
  nodePath?: string;
}

/** Reads a provider's file beside a finished stream (`<streamPath><suffix>`); undefined when there is none. */
export type BesideStream = (suffix: string) => string | undefined;

/** A child process to spawn, never through a shell. */
export interface Launch {
  command: string;
  args: string[];
  /** Written to the child's stdin when the prompt does not travel as an argument. */
  stdin?: string;
  env: Env;
}

/** How a session ended, as its last event says. */
export interface AgentResult {
  isError: boolean;
  /** The provider's own word for how it ended (kept in the session's result record). */
  subtype?: string;
  /** The final text, used in the end reason of a failed session. */
  text?: string;
  /** Present only when the run produced an answer that fits the schema. */
  structuredOutput?: unknown;
  hasStructuredOutput: boolean;
  costUsd?: number;
  /** Premium requests the agent's session used so far, for a plan that counts them. */
  premiumRequests?: number;
  /** AI credits the agent's session used so far, for a plan that counts them. */
  aiCredits?: number;
  turns?: number;
  sessionId?: string;
  /** The commands (or tools) the CLI refused, as the command or the tool's name. */
  denied?: string[];
}

export type AgentEvent =
  /** The session has its id: the one to resume it with. */
  | { kind: "init"; raw: string; sessionId: string; model?: string }
  /** What the agent did last, in a few words for the card. */
  | { kind: "action"; raw: string; text: string }
  /** A reading of the plan's usage windows, when the stream carries them. */
  | { kind: "usage"; raw: string; sample: UsageSample }
  | { kind: "result"; raw: string; result: AgentResult }
  | { kind: "other"; raw: string; type: string }
  | { kind: "malformed"; raw: string };

export interface EventSummary {
  lines: number;
  /** Lines that were not one clean event (including the repaired ones). */
  malformed: number;
  /** Malformed lines from which at least one event was still recovered. */
  repaired: number;
  sessionId?: string;
  lastAction?: string;
  result?: AgentResult;
  /** The last usage reading in the stream. */
  lastUsage?: UsageSample;
}

/** Reads one session's stdout as it comes. Lines are not trusted: a line may be cut, or something else entirely. */
export interface EventReader {
  /** Feed a chunk of stdout. Returns the events of the lines it completed. */
  push(chunk: string): AgentEvent[];
  /** Flush a last line that had no newline. */
  end(): AgentEvent[];
  summary(): EventSummary;
  /**
   * True when the run ended on the plan's usage limit (not on a transient overload). `lastUsage` is the newest reading,
   * from the stream or from `readUsage`.
   */
  limitHit(lastUsage: UsageSample | undefined): boolean;
}

/** One tool the agent called, read from a finished stream: its name and the call in a few words. */
export interface ToolCall {
  name: string;
  text: string;
}

/**
 * A provider whose plan reports no usage window but counts a monthly allowance the person sets (`allowance` on `AgentProvider`):
 * Scope Soup paces its sessions by what they used this month (`core/allowanceBudget.ts`) instead of by readings.
 */
export interface AllowanceBudget extends AllowanceWords {
  /** The allowance and the reset day (1 to 28, UTC) from the configuration; no allowance when the person set none. */
  budget(config: ProjectConfig): { allowance?: number; resetDay: number };
  /** What a finished session used of it, from its result record (`SessionResultRecord`); undefined when its provider said none. */
  used(result: object): number | undefined;
}

export interface AgentProvider {
  /** Kept on each session (`Session.provider`), so its stream is read by the provider that wrote it. */
  readonly name: string;
  /** What the person calls the program, for the level's needs (the CLI's own name). */
  readonly label: string;
  /** The program the configuration names, to look for before a level that needs it is picked. */
  program(config: ProjectConfig): string;
  /** What to do when the program cannot be started. */
  readonly advice: ProgramAdvice;
  /** Environment variables that carry the provider's API key: never passed to a project's setup command (`setup.ts`). */
  readonly keyEnv: readonly string[];

  // --- Starting and resuming ---
  /** The command line for one session, or one more turn of a session (`resume`). */
  launch(request: LaunchRequest): Launch;
  /**
   * A reader for one session's stdout. `root`: the folder it runs in; paths inside it are shown relative to it. `schema`: the
   * answer's schema as given to `launch`, for a provider that checks the answer itself.
   */
  reader(now: () => string, root?: string, schema?: string): EventReader;

  // --- Command limits ---
  readonly commandLimit: CommandLimit;
  /** The `allowedCommands` prompt text: the commands the role may run, in words an agent can follow. */
  commandsText(allowedTools: readonly string[]): string;
  /**
   * The allowed prefix a refused command starts with, when what was refused was the command's shape and not its program;
   * null when unsure. Decides the advice a person gets.
   */
  refusedProgram(refused: string, allowedTools: readonly string[]): string | null;

  // --- Usage ---
  /** Set when the plan has a monthly allowance and no window to read; see `AllowanceBudget`. */
  readonly allowance?: AllowanceBudget;
  /**
   * Reads the plan's usage windows outside the session's stream, for a CLI whose stream does not carry them. The runner
   * calls it once a session is over, stores the reading and uses it to tell a limit hit apart. Absent: the stream has them.
   */
  readUsage?(config: ProjectConfig, env: Env): Promise<UsageSample | null>;

  // --- Reading a finished stream file ---
  /** The reply of a chat turn: the text the agent wrote. */
  replyIn(stream: string): string;
  /** Every tool call, oldest first. */
  toolCallsIn(stream: string, root?: string): ToolCall[];
  /** The tokens the session used, when the stream (or the provider's file beside it, read with `beside`) says. */
  tokensIn(stream: string, beside?: BesideStream): number | undefined;
}
