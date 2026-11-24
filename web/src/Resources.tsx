// The limited resources (license seats, emulators, a phone on USB): who holds each unit and what waits for one.
// `who` is Scope Soup's own text (a session's role and Item, or a machine's name): shown as text.

import type { BoardView } from "./api.ts";
import { useNow } from "./api.ts";
import { ago } from "./format.ts";

const USERS: Record<string, string> = { triage: "triage", implement: "implementing", review: "reviewing", check: "the check" };
const and = (words: string[]): string => (words.length < 2 ? words.join("") : `${words.slice(0, -1).join(", ")} and ${words[words.length - 1]}`);

const clock = (iso: string): string => new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false });

export function Resources({ resources }: { resources: NonNullable<BoardView["resources"]> }) {
  const now = useNow();
  return (
    <section class="panel resources" aria-labelledby="resources-title">
      <h3 id="resources-title">Resources</h3>
      {resources.resources.map((resource) => (
        <div key={resource.name} class="resource">
          <h4>
            {resource.name} <span class="muted num">{resource.held.length} of {resource.units} in use</span>
          </h4>
          <p class="muted">
            {resource.shared ? "Shared by every machine" : "This machine's"}; needed for {and(resource.neededBy.map((user) => USERS[user] ?? user))}
          </p>
          <ul>
            {resource.held.map((held) => (
              <li key={`${held.unit}-${held.who}`}>
                <span class="num">Unit {held.unit}</span>: {held.who}
                {held.elsewhere ? <span class="when">{held.until ? ` (another machine, until ${clock(held.until)})` : " (another machine)"}</span> : null}
                {held.since && <span class="when num"> since {ago(held.since, now)}</span>}
              </li>
            ))}
            {resource.waiting.map((wait) => (
              <li key={`wait-${wait.who}`} class="resource-wait">
                Waits: {wait.who}
                <span class="when num"> since {ago(wait.since, now)}</span>
              </li>
            ))}
            {resource.held.length === 0 && resource.waiting.length === 0 && <li class="empty">Free.</li>}
          </ul>
        </div>
      ))}
    </section>
  );
}
