// Advice about a configuration that is valid as it stands. Nothing here stops anything:
// which model a role runs on is the project's choice.

import type { ProjectConfig } from "./types.ts";

/** One sentence per piece of advice. Empty when there is nothing to say. */
export function recommendations(config: ProjectConfig): string[] {
  const { roles } = config;
  const advice: string[] = [];
  if (config.level >= 3 && roles.review.model === roles.implement.model) {
    advice.push(
      `The reviewer and the implementor both run on "${roles.implement.model}". A reviewer on another model catches more: the same model tends to repeat the author's blind spots.`,
    );
  }
  return advice;
}
