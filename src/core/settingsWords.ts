// A save of the settings in plain words, for History: "Models: triage Haiku, implementor Haiku", "Level 2 → 3",
// "Stall timeout 10 → 15 min". Pure. Values are data from people: shown as text, cut short, never interpreted.

/** One value that changed, as the settings' log has it (`settingChanges`): a dotted key, the value before and after. */
export interface SettingChangeLike {
  key: string;
  from?: unknown;
  to?: unknown;
}

const ROLE_WORDS: Record<string, string> = { triage: "triage", implement: "implementor", review: "reviewer" };
const ROLE_FIELDS: Record<string, string> = { model: "model", maxTurns: "turn limit", allowedTools: "allowed commands", permissionMode: "permission mode", provider: "agent CLI", autoTier: "automatic model" };

/** The numbers in `settings`, with their unit. */
const NUMBERS: Record<string, [string, string]> = {
  stallTimeoutMinutes: ["Stall timeout", "min"],
  sessionTimeoutMinutes: ["Session timeout", "min"],
  persistence: ["Persistence", ""],
  retryBackoffCapSeconds: ["Longest wait between retries", "s"],
  checkTimeoutMinutes: ["Check timeout", "min"],
  queueMinBatch: ["Smallest merge queue batch", ""],
  queueMaxBatch: ["Largest merge queue batch", ""],
  queueRerunCost: ["Cost of a rerun in the merge queue", ""],
  queueMinOutcomes: ["Outcomes the merge queue waits for", ""],
  triageMaxAgeDays: ["Oldest triage still used", "days"],
  maxParallelSessions: ["Sessions at once", ""],
  budgetReserve: ["Usage reserve", "%"],
  reserveFiveHour: ["Reserve of the 5-hour window", "%"],
  reserveSevenDay: ["Reserve of the weekly window", "%"],
  tickSeconds: ["Time between looks", "s"],
};

const TOP: Record<string, string> = {
  project: "Project name",
  mainBranch: "Main branch",
  checkCommand: "Check command",
  rerunFilesCommand: "Command that reruns files",
  setupCommand: "Setup command",
  setupWatch: "Files that rerun the setup",
  bugLabels: "Bug labels",
  sharedResources: "Shared resources",
  resources: "This machine's resources",
  remoteUrl: "Remote URL",
  keepAwake: "Keep the machine awake",
};

/** "rerunFilesCommand" → "rerun files command". */
const spaced = (key: string): string => key.replace(/([a-z0-9])([A-Z])/g, "$1 $2").toLowerCase();
const capital = (text: string): string => (text ? text[0]!.toUpperCase() + text.slice(1) : text);
const clip = (text: string, max = 60): string => (text.length > max ? `${text.slice(0, max - 1)}…` : text);
/** "haiku" → "Haiku"; a full model id stays as it is. */
const model = (value: unknown): string => (typeof value === "string" && /^[a-z]+$/.test(value) ? capital(value) : shown(value));
const isObj = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

/** One value in words: lists joined, a number setting by its value, a command as one line. */
export function shown(value: unknown, command = false): string {
  if (value === undefined || value === null) return "none";
  if (typeof value === "boolean") return value ? "on" : "off";
  if (typeof value === "number") return String(value);
  if (typeof value === "string") return clip(command ? `"${value}"` : value);
  if (Array.isArray(value)) {
    if (value.length === 0) return "none";
    if (command && value.every((each) => typeof each === "string")) return clip(`"${value.join(" ")}"`);
    return clip(value.map((each) => (isObj(each) && typeof each.name === "string" ? each.name : typeof each === "string" ? each : shown(each))).join(", "));
  }
  if (isObj(value) && "value" in value) return shown(value.value);
  return clip(JSON.stringify(value));
}

/** "X 10 → 15 min", "X set to 15 min", "X removed (was 10 min)". */
function fromTo(label: string, change: SettingChangeLike, show: (value: unknown) => string = (value) => shown(value), unit = ""): string {
  const tail = unit ? ` ${unit}` : "";
  if (change.from === undefined) return `${label} set to ${show(change.to)}${tail}`;
  if (change.to === undefined) return `${label} removed (was ${show(change.from)}${tail})`;
  return `${label} ${show(change.from)} → ${show(change.to)}${tail}`;
}

/**
 * One save in words, one phrase per thing changed, in the order of the save. The models of the roles are one phrase,
 * and a number setting's `reason` changed with its value is not named.
 */
export function settingsWords(changes: readonly SettingChangeLike[]): string[] {
  if (changes.length > 3 && changes.every((change) => change.from === undefined)) return [`Saved the project's settings for the first time (${changes.length} values)`];
  const valueKeys = new Set(changes.filter((change) => change.key.endsWith(".value")).map((change) => change.key.slice(0, -".value".length)));
  const models: string[] = [];
  let modelsAt = -1;
  const out: string[] = [];
  for (const change of changes) {
    const parts = change.key.split(".");
    const [top, second, third] = parts;
    if (top === "roles" && second && third === "model" && parts.length === 3) {
      if (modelsAt < 0) modelsAt = out.length;
      const role = ROLE_WORDS[second] ?? second;
      models.push(change.to === undefined ? `${role} back to its default` : change.from === undefined ? `${role} ${model(change.to)}` : `${role} ${model(change.from)} → ${model(change.to)}`);
      continue;
    }
    if (top === "level" && parts.length === 1) {
      out.push(change.from === undefined ? `Level set to ${shown(change.to)}` : `Level ${shown(change.from)} → ${shown(change.to)}`);
      continue;
    }
    if (top === "roles" && second && third) {
      const field = ROLE_FIELDS[third] ?? spaced(parts.slice(2).join(" "));
      out.push(fromTo(`${capital(ROLE_WORDS[second] ?? second)}'s ${field}`, change));
      continue;
    }
    if (top === "roles" && second && !third) {
      out.push(change.to === undefined ? `${capital(ROLE_WORDS[second] ?? second)} back to its defaults` : `${capital(ROLE_WORDS[second] ?? second)}'s settings changed`);
      continue;
    }
    if (top === "settings" && second) {
      if (third === "reason" && valueKeys.has(`settings.${second}`)) continue;
      const [label, unit] = NUMBERS[second] ?? [capital(spaced(second)), ""];
      if (third === "reason") out.push(`${label}: reason changed`);
      else out.push(fromTo(label, change, (value) => shown(value), unit));
      continue;
    }
    if (top === "mergeQueue") {
      out.push(fromTo(second ? `Merge queue ${spaced(parts.slice(1).join(" "))}` : "Merge queue", change));
      continue;
    }
    if (top === "media") {
      if (second === "push" && parts.length === 2) out.push(change.to === true ? "Images pushed to the remote" : "Images kept on each machine only");
      else if (second === "keepDaysAfterClose" && parts.length === 2) out.push(typeof change.to === "number" ? `Images deleted ${change.to} days after an Item closes` : "Images kept after an Item closes");
      else out.push(fromTo("Images", change));
      continue;
    }
    if (top === "host") {
      out.push(fromTo(second ? `Host ${spaced(parts.slice(1).join(" "))}` : "Host", change));
      continue;
    }
    if (top && TOP[top] && parts.length === 1) {
      out.push(fromTo(TOP[top], change, (value) => shown(value, top.endsWith("Command"))));
      continue;
    }
    out.push(fromTo(capital(spaced(parts.join(" "))), change));
  }
  if (models.length > 0) out.splice(modelsAt, 0, `Models: ${models.join(", ")}`);
  return out;
}
