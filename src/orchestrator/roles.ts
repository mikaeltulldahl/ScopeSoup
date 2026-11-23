// A role's prompt template and answer schema. The command line built from them is the provider's (`agent.ts`).

import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { SessionRole } from "../model/types.ts";

export interface RoleSpec {
  role: SessionRole;
  template: string;
  /** The answer's JSON schema on one line, or undefined when the role has none. */
  schema?: string;
}

/** Reads `prompts/<role>.md` and `prompts/<role>.schema.json`. Throws with the path when one is unusable. */
export function loadRole(promptsDir: string, role: SessionRole): RoleSpec {
  // A checkout with CRLF endings must not put mixed endings into a prompt.
  const template = readFileSync(join(promptsDir, `${role}.md`), "utf8").replace(/\r\n/g, "\n");
  const schemaPath = join(promptsDir, `${role}.schema.json`);
  let schemaText: string | undefined;
  try {
    schemaText = readFileSync(schemaPath, "utf8");
  } catch {
    schemaText = undefined;
  }
  if (schemaText === undefined) return { role, template };
  try {
    return { role, template, schema: JSON.stringify(JSON.parse(schemaText)) };
  } catch (error) {
    throw new Error(`${schemaPath} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/**
 * Replaces each `{{name}}` in one pass, so a value that itself contains `{{...}}` is left alone.
 * A name the template uses and `vars` lacks is an error: a prompt with a hole is never sent.
 */
export function renderTemplate(template: string, vars: Record<string, string>): string {
  const missing = new Set<string>();
  const text = template.replace(/\{\{\s*([A-Za-z][A-Za-z0-9_]*)\s*\}\}/g, (_match, name: string) => {
    const value = vars[name];
    if (value === undefined) {
      missing.add(name);
      return "";
    }
    return value;
  });
  if (missing.size > 0) throw new Error(`The prompt template uses variables nobody supplied: ${[...missing].join(", ")}.`);
  return text;
}
