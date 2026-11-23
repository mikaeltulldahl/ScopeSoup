// Who holds what across the laptops: people and agents by machine, with what their sessions did as
// far as the items' logs tell, and who merges now. Everything in `last` is text from logs: shown as text.

import type { BoardView } from "./api.ts";
import { useNow } from "./api.ts";
import { ago, fromWords } from "./format.ts";
import { itemNoun } from "./theme.ts";
import { itemHref } from "./route.ts";

export function Holdings({ holdings }: { holdings: NonNullable<BoardView["holdings"]> }) {
  const now = useNow();
  const mergeQueue = holdings.mergeQueue;
  return (
    <section class="panel holdings" aria-labelledby="holdings-title">
      <h3 id="holdings-title">Who holds what</h3>
      <p class="muted">
        {holdings.machines.length === 0
          ? `No other machine has written to the ${itemNoun(true)} yet.`
          : holdings.machines.map((machine) => `${machine.name}${machine.mine ? " (this one)" : ""}, last seen ${ago(machine.lastAt, now)}`).join(" · ")}
      </p>
      {mergeQueue && (
        <p class="merge-queue">
          Merges: {mergeQueue.holder === null ? "nobody at the moment" : mergeQueue.mine ? "this machine" : mergeQueue.holder}
          {mergeQueue.until && mergeQueue.holder !== null ? `, until ${new Date(mergeQueue.until).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false })}` : ""}
        </p>
      )}
      {holdings.groups.length === 0 && <p class="empty">Nothing is held.</p>}
      {holdings.groups.map((group) => (
        <div key={group.id} class="holder">
          <h4>
            {group.person ? group.who : `Agents of ${group.machine ?? group.who}`}
            {group.person && group.machine ? ` on ${group.machine}` : ""}
            {group.mine ? " (you)" : ""}
          </h4>
          <ul>
            {group.items.map((held) => (
              <li key={held.key}>
                <a href={itemHref(held.key)}>
                  <span class="ref num">{held.label}</span> {held.title}
                </a>
                {held.since && <span class="when num"> since {ago(held.since, now)}</span>}
                {held.from && <span class="when"> ({fromWords(held.from)})</span>}
                {held.expired && <span class="tag tag-blocked">claim ran out</span>}
                {held.quiet && <span class="tag tag-blocked">quiet for a while: ask, or release it</span>}
                {held.last && (
                  <span class="when">
                    {" "}
                    · {held.last.machine ? `${held.last.machine}: ` : ""}
                    {held.last.words} ({ago(held.last.at, now)})
                  </span>
                )}
              </li>
            ))}
          </ul>
        </div>
      ))}
    </section>
  );
}
