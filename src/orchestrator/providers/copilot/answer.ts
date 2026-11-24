// Copilot CLI has no JSON-schema output: the session is asked to end with its answer as JSON, and Scope Soup checks it here.
// The checker covers what the role schemas in `prompts/` use: type, enum, required, properties, additionalProperties and items.
// A schema with any other keyword fails closed: no answer fits it, and the problem says which keyword.

type Schema = Record<string, unknown>;
const isObj = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

/** What the prompt says about the answer, after the role's own text. */
export function answerInstruction(schema: string): string {
  return `When you are done, your last message is your answer and nothing else: one JSON object that fits this JSON schema, with no code fence and no other text.\n${schema}`;
}

/** What a session whose answer did not fit is sent, once. */
export function askAgainMessage(problems: readonly string[], schema: string): string {
  return `Your last message was not an answer that fits the schema (${problems.slice(0, 3).join("; ")}). Reply now with only your answer: one JSON object that fits this JSON schema, with no code fence and no other text.\n${schema}`;
}

/** The JSON object in an answer: the whole text, or inside a code fence, or from its first `{` to its last `}`. */
export function answerObject(text: string): { value?: unknown; problem?: string } {
  const trimmed = text.trim();
  const fenced = /^```(?:json)?\s*\n([\s\S]*?)\n```$/.exec(trimmed);
  const candidates = [trimmed, fenced?.[1] ?? "", trimmed.slice(trimmed.indexOf("{"), trimmed.lastIndexOf("}") + 1)];
  for (const candidate of candidates) {
    if (candidate === "") continue;
    try {
      return { value: JSON.parse(candidate) as unknown };
    } catch {
      // the next form
    }
  }
  return { problem: trimmed === "" ? "the answer was empty" : "the answer was not JSON" };
}

const CHECKED = new Set(["type", "enum", "required", "properties", "additionalProperties", "items"]);
/** Keywords that only describe and need no check. */
const NOTES = new Set(["description", "title", "$schema", "$id", "$comment", "examples"]);

/** The keywords in `schema` (and the schemas inside it) the checker cannot check, as `path: keyword`. */
export function uncheckedKeywords(schema: Schema, at = "schema"): string[] {
  const found: string[] = [];
  for (const [key, value] of Object.entries(schema)) {
    if (NOTES.has(key)) continue;
    if (!CHECKED.has(key)) found.push(`${at}: ${key}`);
    else if (key === "properties" && isObj(value)) {
      for (const [name, sub] of Object.entries(value)) if (isObj(sub)) found.push(...uncheckedKeywords(sub, `${at}.${name}`));
    } else if (key === "items" && isObj(value)) found.push(...uncheckedKeywords(value, `${at}[]`));
    else if (key === "additionalProperties" && typeof value !== "boolean") found.push(`${at}: additionalProperties as a schema`);
    else if (key === "type" && typeof value !== "string") found.push(`${at}: type as a list`);
  }
  return found;
}

function typeOf(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  if (typeof value === "number") return Number.isInteger(value) ? "integer" : "number";
  return typeof value;
}

/** Where `value` breaks `schema`, one line each; empty when it fits. */
export function schemaProblems(value: unknown, schema: Schema, at = "answer"): string[] {
  const problems: string[] = [];
  if (Array.isArray(schema.enum) && !schema.enum.some((option) => option === value)) {
    problems.push(`${at} must be one of ${schema.enum.map((option) => JSON.stringify(option)).join(", ")}`);
    return problems;
  }
  const type = schema.type;
  if (typeof type === "string") {
    const actual = typeOf(value);
    const fits = actual === type || (type === "number" && actual === "integer");
    if (!fits) return [`${at} must be ${type === "array" || type === "integer" || type === "object" ? `an ${type}` : `a ${type}`}`];
  }
  if (isObj(value)) {
    const properties = isObj(schema.properties) ? schema.properties : {};
    if (Array.isArray(schema.required)) {
      for (const key of schema.required) if (typeof key === "string" && !(key in value)) problems.push(`${at}.${key} is missing`);
    }
    for (const [key, entry] of Object.entries(value)) {
      const sub = properties[key];
      if (isObj(sub)) problems.push(...schemaProblems(entry, sub, `${at}.${key}`));
      else if (schema.additionalProperties === false) problems.push(`${at}.${key} is not in the schema`);
    }
  }
  if (Array.isArray(value) && isObj(schema.items)) {
    const items = schema.items;
    value.forEach((entry, index) => problems.push(...schemaProblems(entry, items, `${at}[${index}]`)));
  }
  return problems;
}

/** The answer read from the session's last message: the value when it fits the schema, else the problems. */
export function checkAnswer(text: string | undefined, schema: string): { ok: true; value: unknown } | { ok: false; problems: string[] } {
  if (text === undefined) return { ok: false, problems: ["the session gave no final answer"] };
  const { value, problem } = answerObject(text);
  if (problem) return { ok: false, problems: [problem] };
  let parsed: unknown;
  try {
    parsed = JSON.parse(schema) as unknown;
  } catch {
    return { ok: false, problems: ["the schema is not JSON"] };
  }
  if (!isObj(parsed)) return { ok: false, problems: ["the schema is not an object"] };
  const unchecked = uncheckedKeywords(parsed);
  if (unchecked.length > 0) return { ok: false, problems: [`the schema uses what Scope Soup cannot check (${unchecked.join(", ")})`] };
  const problems = schemaProblems(value, parsed);
  return problems.length === 0 ? { ok: true, value } : { ok: false, problems };
}
