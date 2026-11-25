// Which agent provider runs a session: the one the role names (`roles.<role>.provider`), else Claude.

import { roleProvider } from "../../config/defaults.ts";
import type { ProjectConfig } from "../../config/types.ts";
import type { SessionRole } from "../../model/types.ts";
import type { AgentProvider } from "../agent.ts";
import { claudeProvider } from "./claude/index.ts";
import { copilotProvider } from "./copilot/index.ts";

const PROVIDERS: readonly AgentProvider[] = [claudeProvider, copilotProvider];

/** The provider sessions run on unless the configuration says otherwise. */
export const defaultProvider: AgentProvider = claudeProvider;

/** The provider a new session of this role runs on. */
export function providerFor(config: ProjectConfig, role: SessionRole): AgentProvider {
  // A configuration without roles (a test's stand-in) runs on the default.
  const spec = (config.roles as ProjectConfig["roles"] | undefined)?.[role];
  return spec ? providerNamed(roleProvider(spec)) : defaultProvider;
}

/** Every provider Scope Soup knows. */
export function allProviders(): readonly AgentProvider[] {
  return PROVIDERS;
}

/** The provider that ran a stored session (`Session.provider`); a session stored without one ran on the default. */
export function providerNamed(name: string | undefined): AgentProvider {
  return PROVIDERS.find((provider) => provider.name === name) ?? defaultProvider;
}
