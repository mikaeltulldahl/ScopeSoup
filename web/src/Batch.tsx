// A batch is a box around its changes, in chain order, with one progress bar.
// A bisect is drawn inside it: which prefix is known good, which is known red, the suspect,
// and each probe as a row covering the members it tested.

import type { BatchMemberView, BatchView, ProbeView } from "./api.ts";
import { ProgressBar } from "./Progress.tsx";
import { itemHref } from "./route.ts";

const MARKS: Record<string, string> = { good: "cleared", "in-doubt": "in doubt", culprit: "broke it", untested: "not tested" };
const STATES: Record<string, string> = { waiting: "waiting", testing: "testing", merged: "merged", culprit: "broke it", requeued: "back in queue" };

function Member({ member, position }: { member: BatchMemberView; position: number }) {
  const item = member.items[0];
  const mark = member.state === "culprit" ? "culprit" : member.mark;
  const word = mark ? MARKS[mark] : STATES[member.state];
  const body = (
    <>
      <span class="member-head">
        <span class="order num" aria-hidden="true">{position}</span>
        <span class="ref num">{item?.label ?? member.change.label}</span>
        {member.suspect && <span class="tag tag-suspect">suspect</span>}
      </span>
      <span class="member-title">{item?.title ?? member.change.title}</span>
      <span class="member-state">{member.state === "requeued" && mark !== "culprit" ? STATES.requeued : word}</span>
    </>
  );
  const cls = `member member-${member.state}${mark ? ` mark-${mark}` : ""}${member.suspect ? " is-suspect" : ""}`;
  return item ? (
    <a class={cls} href={itemHref(item.key)}>
      {body}
    </a>
  ) : (
    <span class={cls}>{body}</span>
  );
}

function Probe({ probe, size }: { probe: ProbeView; size: number }) {
  return (
    <li class={`probe probe-${probe.status}`}>
      <div class="probe-cells" style={{ "--n": size }} aria-hidden="true">
        {Array.from({ length: size }, (_, index) => (
          <span key={index} class={index < probe.prefix ? "cell cell-on" : "cell"} />
        ))}
      </div>
      <div class="probe-text">
        <span class="num">{probe.words}</span>
      </div>
    </li>
  );
}

export function BatchBox({ batch }: { batch: BatchView }) {
  const size = batch.members.length;
  const culprit = batch.members.find((member) => member.mark === "culprit");
  return (
    <article class={`batch batch-${batch.status}`}>
      <header class="batch-head">
        <h3>{batch.name}</h3>
        <span class={`tag tag-batch-${batch.status}`}>{batch.status}</span>
        <span class="batch-words">{batch.words}</span>
      </header>
      <ProgressBar progress={batch.progress} />
      <div class="members" style={{ "--n": size }}>
        {batch.members.map((member, index) => (
          <Member key={member.change.label} member={member} position={index + 1} />
        ))}
      </div>
      {batch.bisect && (
        <div class="bisect">
          <h4>
            Bisect
            <span class="muted">
              {" "}
              · first {batch.bisect.goodPrefix} cleared
              {culprit ? ` · ${culprit.items[0]?.label ?? culprit.change.label} broke it` : ` · fails within the first ${batch.bisect.badPrefix}`}
            </span>
          </h4>
          {batch.bisect.probes.length === 0 ? (
            <p class="muted">No probe has started yet.</p>
          ) : (
            <ol class="probes">
              {batch.bisect.probes.map((probe, index) => (
                <Probe key={index} probe={probe} size={size} />
              ))}
            </ol>
          )}
        </div>
      )}
      {batch.note && <p class="batch-note">{batch.note}</p>}
    </article>
  );
}

/** The small box in the overview's "Checking" lane. */
export function BatchMini({ batch }: { batch: BatchView }) {
  return (
    <a class={`batch batch-mini batch-${batch.status}`} href="#/queue">
      <div class="batch-head">
        <h3>{batch.name}</h3>
        <span class={`tag tag-batch-${batch.status}`}>{batch.status}</span>
      </div>
      <ProgressBar progress={batch.progress} />
      <p class="reason">{batch.words}</p>
      <div class="mini-members">
        {batch.members.map((member) => (
          <span
            key={member.change.label}
            class={`ref num mini-member${member.mark ? ` mark-${member.mark}` : ""}${member.suspect ? " is-suspect" : ""}`}
            title={member.items[0]?.title ?? member.change.title}
          >
            {member.items[0]?.label ?? member.change.label}
          </span>
        ))}
      </div>
    </a>
  );
}
