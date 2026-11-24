// For tests: a Jira host with writes and the conventions on, against a fake Jira of the synthetic project DEMO, Cloud or Data
// Center. The token's own account is "Scope Soup Bot"; Robin is a person. Never touches the network.

import type { Ref } from "../../model/types.ts";
import type { JiraConfig, JiraHost } from "./adapter.ts";
import { createJiraHost } from "./adapter.ts";
import type { Deployment } from "./client.ts";
import type { FakeJira } from "./fakeJira.ts";
import { FAKE_DC_SITE, FAKE_SITE, fakeJira } from "./fakeJira.ts";
import { CLOUD_EMAIL, CLOUD_ROBIN, CLOUD_SCOPESOUP, cloudIssues, DC_ROBIN, dcIssues, TOKEN } from "./fixtures.ts";
import type { JiraUser } from "./rest.ts";

export const DC_SCOPESOUP: JiraUser = { name: "scopesoup", key: "JIRAUSER10001", displayName: "Scope Soup Bot" };

export interface Writable {
  fake: FakeJira;
  host: JiraHost;
  write: NonNullable<JiraHost["write"]>;
  ref(id: string): Ref;
  clock: { ms: number };
  /** Robin, a person on the site. */
  person: JiraUser;
  /** Another Scope Soup machine on the same site and account, with its own settings if given. */
  another(machine: string, extra?: Partial<JiraConfig>): JiraHost;
}

export function writable(deployment: Deployment, more: { commentLimit?: number; conventions?: boolean; clock?: { ms: number }; transitions?: JiraConfig["transitions"]; answerers?: string[]; people?: JiraUser[]; emptyExpand?: boolean } = {}): Writable {
  const cloud = deployment === "cloud";
  const clock = more.clock ?? { ms: Date.parse("2026-11-21T09:00:00Z") };
  const fake = fakeJira({
    deployment, token: TOKEN, ...(cloud ? { email: CLOUD_EMAIL } : {}), user: cloud ? CLOUD_SCOPESOUP : DC_SCOPESOUP, people: [cloud ? CLOUD_ROBIN : DC_ROBIN, ...(more.people ?? [])], ...(more.emptyExpand ? { emptyExpand: true } : {}),
    issues: cloud ? cloudIssues() : dcIssues(), now: () => (clock.ms += 1000), ...(more.commentLimit ? { commentLimit: more.commentLimit } : {}),
  });
  const make = (machine: string, extra: Partial<JiraConfig> = {}): JiraHost => createJiraHost({
    site: cloud ? FAKE_SITE : FAKE_DC_SITE, project: "DEMO", deployment, token: TOKEN, ...(cloud ? { email: CLOUD_EMAIL } : {}),
    fetchImpl: fake.fetch, now: () => clock.ms, sleep: async () => {}, allowWrites: true, conventions: more.conventions ?? true, machine,
    ...(more.commentLimit ? { commentLimit: more.commentLimit } : {}), ...(more.transitions ? { transitions: more.transitions } : {}),
    ...(more.answerers ? { answerers: more.answerers } : {}), log: () => {},
    ...extra,
  });
  const host = make("laptop-a");
  return { fake, host, write: host.write!, ref: (id) => ({ host: "jira", kind: "work", id }), clock, person: cloud ? CLOUD_ROBIN : DC_ROBIN, another: make };
}
