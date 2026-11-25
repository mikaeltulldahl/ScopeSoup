// Providers that count a monthly allowance instead of reporting usage windows (`AgentProvider.allowance`): which of them the
// roles use, what their sessions used this month, and the usage check for a session of a role on one of them.

import type { ProjectConfig } from "../config/types.ts";
import { allowanceCheck, allowancePeriod, allowanceUse } from "../core/allowanceBudget.ts";
import type { AllowanceSessionUse, AllowanceWords } from "../core/allowanceBudget.ts";
import type { Session, SessionRole } from "../model/types.ts";
import type { Store } from "../store/store.ts";
import type { AgentProvider } from "./agent.ts";
import { providerFor, providerNamed } from "./providers/index.ts";
import { readSessionResult } from "./runner.ts";
import type { UsageCheckDecision } from "./usageCheck.ts";

/** One provider's allowance as the configuration sets it. */
export interface AllowancePlan extends AllowanceWords {
  /** The provider's name (`Session.provider`). */
  provider: string;
  /** Absent when the person set none. */
  allowance?: number;
  /** Day of the month (1 to 28, UTC) it resets. */
  resetDay: number;
  /** The share kept for people's own use. */
  reserve: number;
}

function planOf(provider: AgentProvider, config: ProjectConfig, reserve: number): AllowancePlan | undefined {
  const spec = provider.allowance;
  if (!spec) return undefined;
  const { label, unit, setting } = spec;
  return { provider: provider.name, label, unit, setting, ...spec.budget(config), reserve };
}

/** The allowances of the providers some role runs on, for the Usage page; empty when none has one. `reserve` is the share kept. */
export function allowancePlans(config: ProjectConfig, reserve: number): AllowancePlan[] {
  const roles = Object.keys(config.roles) as SessionRole[];
  const named = new Set(roles.map((role) => providerFor(config, role).name));
  return [...named].flatMap((name) => planOf(providerNamed(name), config, reserve) ?? []);
}

/** What the provider's sessions used, as their results recorded it. */
export function allowanceSessionUse(store: Store, provider: string): AllowanceSessionUse[] {
  const spec = providerNamed(provider).allowance;
  if (!spec) return [];
  return store.list<Session>("session").filter((session) => session.provider === provider).map((session) => {
    const used = spec.used(readSessionResult(store, session.ref.id));
    return { role: session.role, startedAt: session.startedAt, ...(used !== undefined ? { used } : {}) };
  });
}

/** The usage check for a session of `role` when its provider counts an allowance; undefined when it reports windows instead. */
export function allowanceDecision(store: Store, config: ProjectConfig, role: SessionRole, at: string, reserve: number): UsageCheckDecision | undefined {
  const plan = planOf(providerFor(config, role), config, reserve);
  if (!plan) return undefined;
  const period = allowancePeriod(Date.parse(at), plan.resetDay);
  return allowanceCheck({ ...plan, used: allowanceUse(allowanceSessionUse(store, plan.provider), period).used, period });
}
