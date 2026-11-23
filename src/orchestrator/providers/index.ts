// Which agent provider runs a session. One provider today; choosing one per role is planned.

import type { ProjectConfig } from "../../config/types.ts";
import type { SessionRole } from "../../model/types.ts";
import type { AgentProvider } from "../agent.ts";
import { claudeProvider } from "./claude/index.ts";

const PROVIDERS: readonly AgentProvider[] = [claudeProvider];

/** The provider sessions run on unless the configuration says otherwise. */
export const defaultProvider: AgentProvider = claudeProvider;

/** The provider a new session of this role runs on. */
export function providerFor(_config: ProjectConfig, _role: SessionRole): AgentProvider {
  return defaultProvider;
}

/** Every provider Scope Soup knows. */
export function allProviders(): readonly AgentProvider[] {
  return PROVIDERS;
}

/** The provider that ran a stored session (`Session.provider`); a session stored without one ran on the default. */
export function providerNamed(name: string | undefined): AgentProvider {
  return PROVIDERS.find((provider) => provider.name === name) ?? defaultProvider;
}
