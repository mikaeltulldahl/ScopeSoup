// The item page: the item with everything attached. The item is the one thing a person follows.

import type { ConflictVersions, DecisionOption, ProposedPart, ParkedDraft } from "../../src/model/types.ts";
import type { BoardView, DiffFile, DiffView, ItemPage, RoundRow, SessionDetailsView } from "./api.ts";
import { useEffect, useId, useState } from "preact/hooks";
import { fetchChat, fetchDiff, fetchItem, fetchItemBranch, fetchSession, postAnswers, postChat, postDraft, postEdit, postHandBack, postProposal, postRelease, postResolve, postStartOver, postClaim, useNow, usePerson, useView } from "./api.ts";
import { actorClass, actorWords, Mention, VoteButtons } from "./Card.tsx";
import { placeText, statusText } from "./cardText.ts";
import { ItemForm } from "./ItemForm.tsx";
import { Assumptions } from "./Assumptions.tsx";
import { Stepper } from "./Stepper.tsx";
import { Markdown } from "./Markdown.tsx";
import { BatchBox } from "./Batch.tsx";
import { hostDiffers } from "../../src/core/lanes.ts";
import { itemNoun, words } from "./theme.ts";
import { ago, fromWords, laneWord, optionRows, span, stateFacts, unmatchedRecommendation } from "./format.ts";
import { ProgressBar } from "./Progress.tsx";
import { collapse, diffLines, hasChanges } from "./textDiff.ts";
import type { DiffRow } from "./textDiff.ts";
import { rememberViewed } from "./ItemList.tsx";
import { itemHref } from "./route.ts";
import type { Held } from "./heldAnswers.ts";
import { answerText, browserStorage, clearHeld, dropOther, loadHeld, pick, pickOther, saveHeld } from "./heldAnswers.ts";

/** A session's details behind its row: what its stream shows, and the way to its chat. Loaded when opened. */
function SessionDetails({ id, now, onTalk }: { id: string; now: number; onTalk?: () => void }) {
  const [view, setView] = useState<SessionDetailsView | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let current = true;
    fetchSession(id).then(
      (loaded) => current && setView(loaded),
      (failed: unknown) => current && setError(failed instanceof Error ? failed.message : String(failed)),
    );
    return () => {
      current = false;
    };
  }, [id]);
  if (error) return <p class="muted">{error}</p>;
  if (!view) return <p class="empty">Loading…</p>;
  const { session } = view;
  const length = session.finishedAt ? span(Date.parse(session.finishedAt) - Date.parse(session.startedAt)) : span(now - Date.parse(session.startedAt));
  const steps = view.actions.length + view.actionsOmitted;
  return (
    <div class="round-details">
      <p class="muted num">
        {CHAT_ROLES[session.role] ?? session.role}
        {session.model ? ` · ${session.model}` : ""} · {session.status} · started {ago(session.startedAt, now)}, {session.live ? `running for ${length}` : `took ${length}`}
        {session.attempt > 1 ? ` · attempt ${session.attempt}` : ""}
        {session.costUsd !== undefined ? ` · ${money(session.costUsd)}` : ""}
      </p>
      {session.lastAction && <p class="reason">{session.live ? "Now: " : "Last: "}{session.lastAction}</p>}
      {session.endReason && <p class="reason">Ended: {session.endReason}</p>}
      {view.tools.length > 0 && (
        <p class="tags">
          <span class="muted">Tools used:</span>
          {view.tools.map((tool) => (
            <span class="tag num" key={tool.name}>
              {tool.name} ×{tool.count}
            </span>
          ))}
        </p>
      )}
      {view.actions.length > 0 && (
        <details>
          <summary>
            What it did ({steps} step{steps === 1 ? "" : "s"})
          </summary>
          {view.actionsOmitted > 0 && <p class="muted">The first {view.actionsOmitted} are left out.</p>}
          <ol class="round-actions">
            {view.actions.map((action, index) => (
              <li key={index}>{action}</li>
            ))}
          </ol>
        </details>
      )}
      {view.missing && <p class="muted">{view.missing}</p>}
      {session.streamName && <p class="muted num">Stream: {session.streamName}</p>}
      {onTalk && (
        <div>
          <button type="button" onClick={onTalk}>
            Talk to this session
          </button>
        </div>
      )}
    </div>
  );
}

const money = (usd: number): string => `$${usd.toFixed(2)}`;

/** The Rounds table: one row per step of the cycle, what it found or decided, what it did, then the Item's outcome. */
function Rounds({ rows, now, onTalk }: { rows: RoundRow[]; now: number; onTalk: (agentSession: string) => void }) {
  const [open, setOpen] = useState<Record<number, boolean>>({});
  if (rows.length === 0) return <p class="empty">No agent has worked on this yet.</p>;
  const steps = rows.filter((row) => row.kind !== "end");
  const cost = steps.reduce((sum, row) => sum + (row.costUsd ?? 0), 0);
  const time = steps.reduce((sum, row) => sum + (row.durationMs ?? 0), 0);
  return (
    <>
      <table class="rounds">
        <thead>
          <tr>
            <th scope="col">Step</th>
            <th scope="col">Found or decided</th>
            <th scope="col">Did</th>
            <th scope="col" class="num">Time · cost</th>
          </tr>
        </thead>
        <tbody>
          {rows.flatMap((row, index) => {
            const shown = open[index] === true;
            const out = [
              <tr key={index} class={`round round-kind-${row.kind}${row.tone ? ` round-${row.tone}` : ""}`}>
                <th scope="row" class="round-step">
                  <span class="round-name">{row.step}</span>
                  {row.round !== undefined && (row.step === "review" || row.round > 1) && <span class="muted"> · round {row.round}</span>}
                  {row.model && <span class="round-model muted">{row.model}</span>}
                  {row.resumed && <span class="round-resumed muted">resumed {row.resumed}</span>}
                </th>
                <td class="round-found">
                  {row.found && <p>{row.found}</p>}
                  {row.findings.length > 0 && (
                    <ul class="round-findings">
                      {row.findings.map((finding, at) => (
                        <li key={at}>
                          {finding.severity && <span class={`tag severity-${finding.severity}`}>{finding.severity}</span>} <span class="round-finding">{finding.text}</span>
                        </li>
                      ))}
                    </ul>
                  )}
                </td>
                <td class="round-did">
                  {row.did && <p>{row.did}</p>}
                  {row.commits.length > 0 && (
                    <p class="muted num">
                      {row.kind === "step" ? (row.commits.length === 1 ? "Commit " : "Commits ") : ""}
                      {row.commits.map((sha) => sha.slice(0, 7)).join(", ")}
                    </p>
                  )}
                </td>
                <td class="round-cost num muted">
                  {row.live ? "running" : row.durationMs !== undefined ? span(row.durationMs) : <time dateTime={row.at} title={row.at}>{ago(row.at, now)}</time>}
                  {row.costUsd !== undefined && <span> · {money(row.costUsd)}</span>}
                  {row.session !== undefined && (
                    <button type="button" class="round-toggle" aria-expanded={shown} onClick={() => setOpen({ ...open, [index]: !shown })}>
                      {shown ? "Hide details" : "Details"}
                    </button>
                  )}
                </td>
              </tr>,
            ];
            if (row.session !== undefined && shown) {
              const agentSession = row.agentSession;
              out.push(
                <tr key={`${index}-details`} class="round-more">
                  <td colSpan={4}>
                    <SessionDetails id={row.session} now={now} {...(agentSession ? { onTalk: () => onTalk(agentSession) } : {})} />
                  </td>
                </tr>,
              );
            }
            return out;
          })}
        </tbody>
      </table>
      {(cost > 0 || time > 0) && (
        <p class="muted num">
          In all: {[time > 0 ? span(time) : "", cost > 0 ? money(cost) : ""].filter(Boolean).join(" · ")}
        </p>
      )}
    </>
  );
}

/** The changed files, each opening its diff. Text only: nothing from a diff is ever set as HTML. */
export function DiffFiles({ files }: { files: DiffFile[] }) {
  return (
    <>
      {files.map((file) => (
        <details class="diff-file" key={file.path}>
          <summary>
            <span class="diff-path">{file.path}</span>
            <span class="num muted">{file.binary ? "binary" : `+${file.added} −${file.removed}`}</span>
          </summary>
          {file.note && <p class="muted">{file.note}</p>}
          {file.diff !== undefined && (
            <pre class="diff-text">
              {file.diff.split("\n").map((line, index) => (
                <div key={index} class={line.startsWith("@@") ? "diff-line-hunk" : line.startsWith("+") ? "diff-line-add" : line.startsWith("-") ? "diff-line-del" : undefined}>
                  {line || " "}
                </div>
              ))}
            </pre>
          )}
        </details>
      ))}
    </>
  );
}

/** The files the item's branch changes, each opening its diff. Text only: nothing from the diff is ever set as HTML. */
function Diff({ itemKey, version }: { itemKey: string; version: string }) {
  const [view, setView] = useState<DiffView | null>(null);
  useEffect(() => {
    let current = true;
    fetchDiff(itemKey).then(
      (loaded) => current && setView(loaded),
      () => current && setView(null),
    );
    return () => {
      current = false;
    };
  }, [itemKey, version]);
  if (!view || !view.available) return null;
  return (
    <section class="panel">
      <h3>Files changed</h3>
      <p class="muted num">
        {view.files.length + view.omitted} file{view.files.length + view.omitted === 1 ? "" : "s"} · +{view.totalAdded} −{view.totalRemoved} · {view.branch} from {view.base.slice(0, 9)}
      </p>
      <DiffFiles files={view.files} />
      {view.omitted > 0 && <p class="muted">{view.omitted} more files are not listed.</p>}
    </section>
  );
}

const CHAT_ROLES: Record<string, string> = { triage: "Triage", implement: "Implementor", review: "Reviewer" };
/** The chat panel's element id: a row's "Talk to this session" scrolls to it. */
const CHAT_PANEL = "item-chat";

/**
 * A person talks to one of the item's sessions. Each message is one more turn of that session; the reply shows as it is
 * written (polled each second while a turn runs, refetched on every event otherwise). Text only: no reply is set as HTML.
 */
function Chat({ itemKey, now, picked, setPicked, finished }: { itemKey: string; now: number; picked: string | null; setPicked: (agentSession: string) => void; finished: boolean }) {
  const { data, reload } = useView(() => fetchChat(itemKey), `chat:${itemKey}`);
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const id = useId();
  const live = data?.sessions.some((session) => session.turns.some((turn) => turn.live)) ?? false;
  useEffect(() => {
    if (!live) return;
    const poll = window.setInterval(reload, 1000);
    return () => window.clearInterval(poll);
  }, [live]);
  if (!data) return null;
  if (data.sessions.length === 0) return <EmptyPanel id={CHAT_PANEL} title="Talk to a session" text="no session runs now" />;
  const chosen = data.sessions.find((session) => session.agentSession === picked) ?? data.sessions[0]!;
  const blocked = data.blocked;
  const send = () => {
    if (!text.trim() || sending || blocked) return;
    setSending(true);
    setError(null);
    postChat(itemKey, chosen.agentSession, text).then(
      () => {
        setText("");
        setSending(false);
        reload();
      },
      (failed: unknown) => {
        setError(failed instanceof Error ? failed.message : String(failed));
        setSending(false);
        reload();
      },
    );
  };
  const roleWord = CHAT_ROLES[chosen.role] ?? chosen.role;
  return (
    <section class="panel chat" id={CHAT_PANEL}>
      <h3>Talk to a session</h3>
      <label for={`${id}-session`} class="muted">
        Session (newest first)
      </label>
      <select id={`${id}-session`} value={chosen.agentSession} onChange={(event) => setPicked((event.target as HTMLSelectElement).value)}>
        {data.sessions.map((session) => (
          <option key={session.agentSession} value={session.agentSession}>
            {`${CHAT_ROLES[session.role] ?? session.role}${session.model ? ` · ${session.model}` : ""} · started ${ago(session.startedAt, now)}${session.turns.length > 0 ? ` · ${session.turns.length} message${session.turns.length === 1 ? "" : "s"}` : ""}`}
          </option>
        ))}
      </select>
      {chosen.turns.length === 0 ? (
        <p class="empty">{finished ? "No messages to this session." : "No messages to this session yet. What you write becomes part of it, so its next step sees it."}</p>
      ) : (
        <ol class="chat-turns">
          {chosen.turns.map((turn) => (
            <li key={turn.id} class="chat-turn">
              <div class="chat-message chat-person">
                <p class="muted num">
                  You · <time dateTime={turn.at} title={turn.at}>{ago(turn.at, now)}</time>
                </p>
                <p class="chat-text">{turn.message}</p>
              </div>
              <div class="chat-message chat-reply">
                <p class="muted num">
                  {roleWord}
                  {turn.live ? " · writing…" : turn.finishedAt ? ` · ${ago(turn.finishedAt, now)}` : ""}
                </p>
                {turn.reply ? <p class="chat-text">{turn.reply}</p> : turn.live ? <p class="empty">{turn.lastAction ? `Now: ${turn.lastAction}` : "Starting…"}</p> : !turn.failed && <p class="empty">No reply.</p>}
                {turn.live && turn.reply && turn.lastAction && <p class="reason">Now: {turn.lastAction}</p>}
                {turn.failed && <p class="reason">Ended: {turn.failed}</p>}
              </div>
            </li>
          ))}
        </ol>
      )}
      {/* The box only while a session can be talked to: a finished Item, or a blocked chat, shows the past turns and why. */}
      {finished ? (
        <p class="reason chat-blocked">The {itemNoun(false, true)} is finished, so its sessions take no more messages.</p>
      ) : blocked ? (
        <p class="reason chat-blocked">{blocked}</p>
      ) : (
      <>
      <div class="answer">
        <label for={`${id}-text`}>Your message to the {roleWord.toLowerCase()}. It gets it word for word (Ctrl+Enter sends).</label>
        <textarea
          id={`${id}-text`}
          rows={3}
          value={text}
          disabled={sending}
          onInput={(event) => setText((event.target as HTMLTextAreaElement).value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) send();
          }}
        />
      </div>
      {error && <p class="notice notice-bad">{error}</p>}
      <div>
        <button type="button" onClick={send} disabled={sending || !text.trim()}>
          {sending ? "Sending…" : "Send"}
        </button>
      </div>
      </>
      )}
    </section>
  );
}

const PARKED_TITLES: Record<NonNullable<ItemPage["parked"]>["as"], string> = {
  "needs-decision": "Your decision",
  "not-ready": "Not ready to start",
  escalated: "The agents need you",
  queued: "Handed to the merge queue",
  "handed-over": "Waiting for you to merge",
};

/**
 * One open question as the panel shows it. `id` keys its held answer in this browser; `entry` names it in `POST
 * /api/answers`. `answered` is the answer it has already (shown, not asked again).
 */
interface PanelQuestion {
  id: string;
  question: string;
  context?: string;
  options: DecisionOption[];
  recommendation?: string;
  multiSelect?: boolean;
  asked?: string;
  answered?: string;
  entry: { to?: string; question?: number };
}

/**
 * One question as Claude Code's question dialog shows it: each option a button (label, with what it means in lighter text
 * under it), the recommended one first and marked so, and "Other" last with a box for a person's own words. A multi-select
 * question takes several. Without canAnswer the options are only shown. Text only: nothing in it is set as HTML. The counter
 * and the arrows to the other questions are the Stepper's around it.
 */
function QuestionCard({ question, held, canAnswer, busy, onChange }: { question: PanelQuestion; held: Held | undefined; canAnswer: boolean; busy: boolean; onChange: (held: Held) => void }) {
  const rows = optionRows(question.options, question.recommendation);
  const unmatched = unmatchedRecommendation(rows, question.recommendation);
  const multi = question.multiSelect === true;
  const otherOn = held?.other !== null && held?.other !== undefined;
  const id = useId();
  return (
    <div class="parked-question">
      <p class="question">{question.question}</p>
      {question.context && <p class="choice-why">{question.context}</p>}
      {question.asked && <p class="muted">{question.asked}</p>}
      {multi && question.answered === undefined && <p class="muted">Pick one or more.</p>}
      {question.answered !== undefined ? (
        <p>Your answer: {question.answered}</p>
      ) : rows.length === 0 ? (
        canAnswer && (
          <div class="answer">
            <label for={id}>Your answer. The agents get it word for word.</label>
            <textarea id={id} rows={3} value={held?.other ?? ""} onInput={(event) => onChange(pickOther(held, (event.target as HTMLTextAreaElement).value, false))} disabled={busy} />
          </div>
        )
      ) : (
        <div class="choices" role={multi ? "group" : "radiogroup"}>
          {unmatched && <p class="choice-why">Recommended: {unmatched}</p>}
          {rows.map((row) => {
            const picked = held?.picked.includes(row.label) ?? false;
            return (
              <button type="button" key={row.label} class={picked ? "choice choice-picked" : "choice"} role={multi ? "checkbox" : "radio"} aria-checked={picked} disabled={!canAnswer || busy} onClick={() => onChange(pick(held, row.label, multi))}>
                <span class="choice-mark" aria-hidden="true">{multi ? (picked ? "☑" : "☐") : picked ? "●" : "○"}</span>
                <span class="choice-text">
                  <span class="choice-label">{row.label}{row.recommended ? " (Recommended)" : ""}</span>
                  {row.description && <span class="choice-why">{row.description}</span>}
                </span>
              </button>
            );
          })}
          {canAnswer && (
            <div class={otherOn ? "choice choice-picked" : "choice"}>
              <button type="button" class="choice-mark" role={multi ? "checkbox" : "radio"} aria-checked={otherOn} aria-label="Other" disabled={busy} onClick={() => onChange(otherOn ? dropOther(held) : pickOther(held, held?.other ?? "", multi))}>
                {multi ? (otherOn ? "☑" : "☐") : otherOn ? "●" : "○"}
              </button>
              <span class="choice-text">
                <span class="choice-label">Other</span>
                <textarea rows={2} placeholder="Your answer in your own words" value={held?.other ?? ""} onFocus={() => !otherOn && onChange(pickOther(held, "", multi))} onInput={(event) => onChange(pickOther(held, (event.target as HTMLTextAreaElement).value, multi))} disabled={busy} />
              </span>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/** The options of a question as `answerText` sends them: the label alone (a draft's), or the label with its description. */
const sendOf = (question: Pick<PanelQuestion, "options" | "recommendation">, send: "answer" | "label") =>
  optionRows(question.options, question.recommendation).map((row) => ({ label: row.label, send: send === "label" ? row.label : row.answer }));

/** Which of `questions` have an answer: one given already, or one held here that would send something. */
const answeredOf = (questions: readonly PanelQuestion[], held: Record<string, Held>, send: "answer" | "label"): boolean[] =>
  questions.map((question) => question.answered !== undefined || answerText(held[question.id], sendOf(question, send)).trim() !== "");

/** Questions one at a time, each answered as in QuestionCard. */
function QuestionSteps({ questions, held, send, canAnswer, busy, change }: { questions: readonly PanelQuestion[]; held: Record<string, Held>; send: "answer" | "label"; canAnswer: boolean; busy: boolean; change: (id: string, held: Held) => void }) {
  return (
    <Stepper noun="Question" answered={answeredOf(questions, held, send)}>
      {(index) => {
        const question = questions[index]!;
        return <QuestionCard key={question.id} question={question} held={held[question.id]} canAnswer={canAnswer} busy={busy} onChange={(next) => change(question.id, next)} />;
      }}
    </Stepper>
  );
}

/** The held answers of `ids` on an Item, kept in this browser on every change. */
function useHeld(itemKey: string, ids: readonly string[], start: () => Record<string, Held> = () => ({})): [Record<string, Held>, (id: string, held: Held) => void, (sent: readonly string[]) => void] {
  const [held, setHeld] = useState<Record<string, Held>>(() => ({ ...start(), ...loadHeld(browserStorage(), itemKey, ids) }));
  const change = (id: string, next: Held) => {
    const all = { ...held, [id]: next };
    setHeld(all);
    saveHeld(browserStorage(), itemKey, all);
  };
  const sent = (gone: readonly string[]) => {
    clearHeld(browserStorage(), itemKey, gone);
    setHeld((all) => Object.fromEntries(Object.entries(all).filter(([id]) => !gone.includes(id))));
  };
  return [held, change, sent];
}

/**
 * Every open question of the item in one panel, answered like a dialog: the picks stay in this browser until Send, and
 * Send posts all of them at once (one write on the host); the item is picked up once, after them. Questions left unanswered
 * stay open. With a parked Item, the panel shows its title, why it is parked, and Start over.
 */
function QuestionsPanel({ page, questions, now, reload, primary }: { page: ItemPage; questions: PanelQuestion[]; now: number; reload: () => void; primary: boolean }) {
  const parked = page.parked && !page.parked.refine && !page.proposal ? page.parked : undefined;
  const canAnswer = parked ? parked.canAnswer : true;
  const ids = questions.map((question) => question.id);
  const [held, change, sent] = useHeld(page.item.key, ids);
  const { busy, error, send } = useSend();
  const open = questions.filter((question) => question.answered === undefined);
  const ready = open.flatMap((question) => {
    const text = answerText(held[question.id], sendOf(question, "answer"));
    return text ? [{ id: question.id, entry: { answer: text, ...question.entry } }] : [];
  });
  const several = parked?.questions && parked.questions.length > 0;
  const sendAll = () =>
    send(() => postAnswers(page.item.key, ready.map((each) => each.entry), parked?.at).then(() => {
      sent(ready.map((each) => each.id));
      reload();
    }));
  return (
    <section class={parked?.as === "queued" ? "panel" : "panel panel-yours"}>
      <h3>{parked ? (parked.as === "queued" && page.item.state === "done" ? "Merged" : PARKED_TITLES[parked.as]) : questions.length > 1 ? "Questions" : "Question"}</h3>
      {parked && (several ? (
        <p class="question">{parked.questions!.length} questions wait for your answers. The {itemNoun()} is picked up once all are answered.</p>
      ) : !parked.decision && open.length === 0 ? (
        <p class="question">{parked.reason}</p>
      ) : null)}
      {parked && <p class="muted">{asks(parked) ? "Asked" : "Since"} {ago(parked.at, now)}.</p>}
      {questions.length > 0 && <QuestionSteps questions={questions} held={held} send="answer" canAnswer={canAnswer} busy={busy} change={change} />}
      {canAnswer && open.length > 0 && (
        <div class="answer">
          <p class="muted num">
            {ready.length} of {open.length} answered.{" "}
            {ready.length < open.length ? "Send what you have; the rest stay open. " : ""}
            Your picks are kept in this browser until you send them.
          </p>
          <button type="button" class={primary ? "primary" : undefined} onClick={sendAll} disabled={busy || ready.length === 0}>
            {busy ? "Sending…" : ready.length > 1 ? `Send ${ready.length} answers` : "Send"}
          </button>
          {error && <p class="error">{error}</p>}
        </div>
      )}
      {parked?.canStartOver && (
        <div class="answer">
          <p class="muted">Answering goes on with the step that asked. Start over drops the work so far and begins at triage.</p>
          <button type="button" disabled={busy} onClick={() => send(() => postStartOver(page.item.key))}>
            Start over
          </button>
        </div>
      )}
    </section>
  );
}

/** The parked state asks the person something (a decision, questions, or why it waits for an answer), so it says when it asked. */
const asks = (parked: NonNullable<ItemPage["parked"]>): boolean => parked.canAnswer || !!parked.decision || (parked.questions?.length ?? 0) > 0;

/**
 * The item's open questions for the panel, in order: the parked state's (its several questions, its one decision, or why it waits
 * when a person may answer), then the questions in the item's log that are not the parked state's own.
 */
function panelQuestions(page: ItemPage, now: number): PanelQuestion[] {
  const parked = page.parked && !page.parked.refine && !page.proposal ? page.parked : undefined;
  const out: PanelQuestion[] = [];
  const own = (text: string) => page.questions.find((question) => !question.proposal && question.question === text);
  if (parked?.questions && parked.questions.length > 0) {
    parked.questions.forEach((question, index) => out.push({
      id: `parked:${parked.at}:${index}`, question: question.question, options: question.options, recommendation: question.recommendation,
      ...(question.context ? { context: question.context } : {}), ...(question.multiSelect ? { multiSelect: true } : {}),
      ...(question.answer !== undefined ? { answered: question.answer } : {}), entry: { question: index },
    }));
  } else if (parked?.decision) {
    // The log line park wrote for the decision is named, so it is the one the answer closes.
    const line = own(parked.decision.question);
    out.push({
      id: `parked:${parked.at}`, question: parked.decision.question, options: parked.decision.options, recommendation: parked.decision.recommendation,
      ...(parked.decision.context ? { context: parked.decision.context } : {}), ...(parked.decision.multiSelect ? { multiSelect: true } : {}),
      entry: line ? { to: line.at } : {},
    });
  } else if (parked?.canAnswer) {
    const line = own(parked.reason);
    out.push({ id: `parked:${parked.at}`, question: parked.reason, options: [], entry: line ? { to: line.at } : {} });
  }
  for (const question of page.questions) {
    if (question.proposal || question.question === page.parked?.decision?.question || question.question === page.parked?.reason) continue;
    if ((page.parked?.refine?.questions ?? []).some((each) => each.question === question.question)) continue;
    if ((page.parked?.questions ?? []).some((each) => each.question === question.question)) continue;
    out.push({
      id: `q:${question.id ?? question.at}`, question: question.question, options: question.options,
      ...(question.recommendation ? { recommendation: question.recommendation } : {}), ...(question.context ? { context: question.context } : {}),
      ...(question.multiSelect ? { multiSelect: true } : {}),
      asked: `Asked by ${question.by.who}${question.by.agent ? " (agent)" : ""}${question.by.machine ? ` on ${question.by.machine}` : ""} ${ago(question.at, now)}.`,
      entry: { to: question.at },
    });
  }
  return out;
}

/** Runs a write, keeps the box busy meanwhile, and shows what went wrong. */
function useSend(): { busy: boolean; error: string | null; send: (write: () => Promise<unknown>) => void } {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const send = (write: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    write().then(
      () => setBusy(false),
      (problem: unknown) => {
        setError(problem instanceof Error ? problem.message : String(problem));
        setBusy(false);
      },
    );
  };
  return { busy, error, send };
}

/**
 * Triage found the item too large and proposes its parts: each part's text, and Accept, Edit and Reject. Where the host can be
 * written here, accepting creates the parts as sub-items; otherwise the parts are text for a person to create by hand.
 */
function SplitProposal({ page, proposal, parts, now, reload, primary }: { page: ItemPage; proposal: NonNullable<ItemPage["proposal"]>; parts: ProposedPart[]; now: number; reload: () => void; primary: boolean }) {
  const main = primary ? "primary" : undefined;
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<ProposedPart[]>(parts);
  const { busy, error, send } = useSend();
  const created = proposal.created ?? [];
  const decide = (action: "accept" | "edit" | "reject") =>
    send(() => postProposal(page.item.key, action, { ...(action === "edit" ? { parts: draft } : {}), ...(proposal.at ? { to: proposal.at } : {}) }).then(reload));
  const change = (index: number, field: keyof ProposedPart, value: string) => setDraft(draft.map((part, at) => (at === index ? { ...part, [field]: value } : part)));
  return (
    <section class="panel panel-yours">
      <h3>Proposed split into {parts.length} parts</h3>
      <p class="question">{proposal.reason}</p>
      {proposal.at && <p class="muted">Proposed {ago(proposal.at, now)}.</p>}
      {created.length > 0 && (
        <p class="muted">
          Already created: {created.map((child, index) => <span key={child.key}>{index > 0 ? ", " : ""}<a href={itemHref(child.key)}>{child.label}</a></span>)}. Accept again to create the rest.
        </p>
      )}
      {!editing &&
        parts.map((part, index) => (
          <div class="version" key={index}>
            <p class="num">{index + 1}. {part.title}</p>
            {part.description ? <Markdown text={part.description} /> : <p class="empty">No description.</p>}
            <p class="muted">Verification: {part.verification || "none given"}</p>
          </div>
        ))}
      {proposal.carried && (
        <div class="version">
          <p class="muted num">Decisions carried over into each part</p>
          <pre class="diff-text">{proposal.carried}</pre>
        </div>
      )}
      {editing && (
        <div class="answer">
          {draft.map((part, index) => (
            <div key={index}>
              <label for={`part-title-${index}`}>Part {index + 1}: title</label>
              <input id={`part-title-${index}`} value={part.title} onInput={(event) => change(index, "title", (event.target as HTMLInputElement).value)} disabled={busy} />
              <label for={`part-description-${index}`}>Description</label>
              <textarea id={`part-description-${index}`} rows={5} value={part.description} onInput={(event) => change(index, "description", (event.target as HTMLTextAreaElement).value)} disabled={busy} />
              <label for={`part-verification-${index}`}>Verification</label>
              <textarea id={`part-verification-${index}`} rows={2} value={part.verification} onInput={(event) => change(index, "verification", (event.target as HTMLTextAreaElement).value)} disabled={busy} />
            </div>
          ))}
          <button type="button" class={main} onClick={() => decide("edit")} disabled={busy || draft.some((part) => !part.title.trim())}>
            {busy ? "Saving…" : "Accept my version"}
          </button>{" "}
          <button type="button" onClick={() => setEditing(false)} disabled={busy}>
            Cancel
          </button>
        </div>
      )}
      {!editing && (
        <p>
          <button type="button" class={main} onClick={() => decide("accept")} disabled={busy}>
            {busy ? "Working…" : "Accept"}
          </button>{" "}
          {created.length === 0 && (
            <button type="button" onClick={() => setEditing(true)} disabled={busy}>
              Edit
            </button>
          )}{" "}
          {created.length === 0 && (
            <button type="button" onClick={() => decide("reject")} disabled={busy}>
              Reject
            </button>
          )}
        </p>
      )}
      <p class="muted">
        {proposal.canCreate
          ? "Accept creates the parts as sub-items of this item, in order, with the decisions above carried over. This item then becomes an umbrella: the work happens in the parts."
          : "Scope Soup cannot create items on this host. Accept records your decision; create the parts by hand as sub-items of this item, from the text above."}{" "}
        {created.length === 0 ? "Reject starts the item over at triage, and triage is told not to propose this split again." : "Some parts exist already, so the split can only be finished, not rejected."}
      </p>
      {error && <p class="error">{error}</p>}
    </section>
  );
}

/** Label changes as the board shows them, `+bug, −question`. */
const labelChangeText = (change: { add: string[]; remove: string[] } | undefined): string =>
  change ? [...change.add.map((name) => `+${name}`), ...change.remove.map((name) => `−${name}`)].join(", ") : "";

/** A person's `+bug, −question` (a hyphen works as the minus too) read back; a name without a sign is an add. */
function parseLabelChange(text: string): { add: string[]; remove: string[] } {
  const change = { add: [] as string[], remove: [] as string[] };
  for (const part of text.split(",").map((each) => each.trim()).filter(Boolean)) {
    if (/^[−-]/.test(part)) change.remove.push(part.slice(1).trim());
    else change.add.push(part.replace(/^\+/, "").trim());
  }
  return { add: change.add.filter(Boolean), remove: change.remove.filter(Boolean) };
}

/** One line of the draft's diff: "+" or "−" in the margin, the changed words marked when the line has a partner. */
function DiffLine({ row }: { row: DiffRow }) {
  const mark = row.kind === "add" ? "+" : row.kind === "del" ? "−" : " ";
  return (
    <div class={`dl dl-${row.kind}`}>
      <span class="dl-mark" aria-hidden="true">{mark}</span>
      <span class="dl-text">
        {row.parts ? row.parts.map((part, index) => (part.changed ? <mark key={index}>{part.text}</mark> : part.text)) : row.text || " "}
      </span>
    </div>
  );
}

/** The description turned into the draft, as one unified diff; long unchanged runs fold into a line that opens on a click. */
function DraftDiff({ before, after }: { before: string; after: string }) {
  const [opened, setOpened] = useState<Record<number, boolean>>({});
  const rows = diffLines(before, after);
  if (!hasChanges(rows)) return <p class="muted">The draft keeps the description as it is.</p>;
  return (
    <div class="diff-unified" role="group" aria-label="Description changed to the draft">
      {collapse(rows).map((entry, index) =>
        "row" in entry ? <DiffLine key={index} row={entry.row} /> : opened[index]
          ? entry.skipped.map((row, at) => <DiffLine key={`${index}.${at}`} row={row} />)
          : <button key={index} type="button" class="dl-fold" onClick={() => setOpened({ ...opened, [index]: true })}>… {entry.skipped.length} unchanged lines</button>,
      )}
    </div>
  );
}

/**
 * The triage's draft of the description, next to the description as it stands, with its questions (each
 * recommendation picked to begin with). Keeping every recommendation, one press accepts the draft (or Edit, Reject); any
 * other answer sends the answers and the triage runs again with them, with no limit on the rounds. The questions
 * are answered as in the questions panel, the picks are kept in this browser until a button sends them, and each button
 * sends everything in one write (on GitHub one comment: the answers and, keeping the recommendations, the decision).
 */
function DraftPanel({ page, draft, reload, primary }: { page: ItemPage; draft: ParkedDraft; reload: () => void; primary: boolean }) {
  const main = primary ? "primary" : undefined;
  const parked = page.parked!;
  const questions: PanelQuestion[] = draft.questions.map((question, index) => ({
    id: `draft:${parked.at}:${index}`, question: question.question, options: question.options, recommendation: question.recommendation,
    ...(question.context ? { context: question.context } : {}), ...(question.multiSelect ? { multiSelect: true } : {}), entry: {},
  }));
  // The recommendation picked to begin with: its option, or (matching none) its words as Other.
  const start = () => Object.fromEntries(questions.map((question): [string, Held] => {
    const row = optionRows(question.options, question.recommendation).find((each) => each.recommended);
    return [question.id, row ? { picked: [row.label], other: null } : { picked: [], other: question.recommendation ?? "" }];
  }));
  const [held, change, sent] = useHeld(page.item.key, questions.map((question) => question.id), start);
  const recommended = questions.map((question) => answerText(start()[question.id], sendOf(question, "label")));
  const answers = questions.map((question) => answerText(held[question.id], sendOf(question, "label")));
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(draft.draft);
  const [labelText, setLabelText] = useState(labelChangeText(draft.labels));
  const { busy, error, send } = useSend();
  const keeps = answers.every((answer, index) => answer.trim() === recommended[index]!.trim());
  const filled = answers.every((answer) => answer.trim() !== "");
  // Someone edited the description since the draft was written; Accept is refused; Edit or Reject decides with it in view.
  const changed = (page.item.body ?? "").trim() !== draft.original.trim();
  const decide = (action: "accept" | "edit" | "reject") =>
    send(() => postDraft(page.item.key, parked.at, answers, action, action === "edit" ? text : undefined, action === "edit" ? parseLabelChange(labelText) : undefined).then(() => {
      sent(questions.map((question) => question.id));
      reload();
    }));
  return (
    <section class="panel panel-yours">
      <h3>Triage: draft of the description{draft.round > 1 ? ` (round ${draft.round})` : ""}</h3>
      {draft.questions.length > 0 && <p class="question">The draft is written as if you take every recommendation. Pick another answer and the triage runs again with it.</p>}
      {questions.length > 0 && <QuestionSteps questions={questions} held={held} send="label" canAnswer={true} busy={busy} change={change} />}
      <div class="draft-compare">
        <div class="version">
          <p class="muted num">Change to the description (before, then the draft)</p>
          <DraftDiff before={draft.original} after={draft.draft} />
        </div>
        {changed && (
          <div class="version">
            <p class="muted num">Now (changed since the draft was written)</p>
            <pre class="version-text">{page.item.body?.trim() || "(no description)"}</pre>
          </div>
        )}
      </div>
      {draft.labels && <p class="draft-labels">Labels: <span class="num">{labelChangeText(draft.labels)}</span></p>}
      {draft.droppedLabels && draft.droppedLabels.length > 0 && <p class="muted">Dropped, because the repository has no such label: {draft.droppedLabels.join(", ")}.</p>}
      {editing && keeps && (
        <div class="answer">
          <label for="draft-text">Your version of the description</label>
          <textarea id="draft-text" rows={10} value={text} onInput={(event) => setText((event.target as HTMLTextAreaElement).value)} disabled={busy} />
          <label for="draft-labels">Label changes (for example +bug, −question; empty for none)</label>
          <input id="draft-labels" type="text" value={labelText} onInput={(event) => setLabelText((event.target as HTMLInputElement).value)} disabled={busy} />
          <button type="button" class={main} onClick={() => decide("edit")} disabled={busy || text.trim() === ""}>
            {busy ? "Saving…" : "Accept my version"}
          </button>{" "}
          <button type="button" onClick={() => setEditing(false)} disabled={busy}>Cancel</button>
        </div>
      )}
      {!editing && keeps && (
        <p>
          <button type="button" class={main} onClick={() => decide("accept")} disabled={busy || !filled}>{busy ? "Working…" : "Accept the draft"}</button>{" "}
          <button type="button" onClick={() => setEditing(true)} disabled={busy}>Edit</button>{" "}
          <button type="button" onClick={() => decide("reject")} disabled={busy || !filled}>Reject</button>
        </p>
      )}
      {!keeps && (
        <p>
          <button type="button" class={main} onClick={() => decide("accept")} disabled={busy || !filled}>{busy ? "Sending…" : "Send my answers"}</button>
        </p>
      )}
      <p class="muted">
        {keeps
          ? `${page.canEdit ? "Accept writes the draft as the item's description; the old text stays in the item's history." : "This host's items are edited on the host: accepting gives the draft to the agents in place of the host's text."}${draft.labels ? " The label changes go with it; a label someone changed since stays as they set it." : ""} Reject keeps the description${draft.labels ? " and the labels" : ""} as they are. Either way the work can then start.`
          : "Your answers go to a new triage, which writes a new draft. Nothing starts until you accept or reject a draft."}
      </p>
      {error && <p class="error">{error}</p>}
    </section>
  );
}

const LINK_WORDS: Record<string, string> = { blockedBy: "Blocked by", blocks: "Blocks", duplicateOf: "Duplicate of", conflictsWith: "Conflicts with", related: "Related" };

/** The triage's links to other Items, in the Item section. Only "blocked by" acted on anything; the rest is for reading. */
function Links({ links }: { links: NonNullable<ItemPage["links"]> }) {
  return (
    <div>
      <p>
        <b>Other {itemNoun(true, true)}, as the triage sees them</b>
      </p>
      <ul class="rows">
        {links.map((link, index) => (
          <li class="row" key={index}>
            <span class="tag">{LINK_WORDS[link.type] ?? link.type}</span>{" "}
            {"key" in link.item ? <a href={itemHref(link.item.key)}>{link.item.label} {link.item.title}</a> : <span class="num">{link.item.label}</span>}
            {link.reason && <span class="muted"> {link.reason}</span>}
          </li>
        ))}
      </ul>
    </div>
  );
}

/** The item's text was changed on two machines: both versions, and a box for the result. */
function Conflict({ itemKey, conflict, reload, primary }: { itemKey: string; conflict: ConflictVersions; reload: () => void; primary: boolean }) {
  const [text, setText] = useState("");
  const { busy, error, send } = useSend();
  const settle = (result: string) => send(() => postResolve(itemKey, result, conflict.aside.map((version) => version.id)).then(reload));
  const versions = [...(conflict.current !== null ? [{ name: "item.md (as it stands)", text: conflict.current }] : []), ...conflict.aside.map((version) => ({ name: version.name, text: version.text }))];
  return (
    <section class="panel panel-yours">
      <h3>Conflict</h3>
      <p>The {itemNoun()}'s text was changed on two machines. Keep one version, or write the result.</p>
      {versions.map((version) => (
        <div class="version">
          <p class="muted num">{version.name}</p>
          <pre class="version-text">{version.text}</pre>
          <button type="button" onClick={() => settle(version.text)} disabled={busy}>
            Keep this
          </button>{" "}
          <button type="button" onClick={() => setText(version.text)} disabled={busy}>
            Start from this
          </button>
        </div>
      ))}
      <div class="answer">
        <label for="conflict-result">The result, as the whole item.md.</label>
        <textarea id="conflict-result" rows={8} value={text} onInput={(event) => setText((event.target as HTMLTextAreaElement).value)} disabled={busy} />
        <button type="button" class={primary ? "primary" : undefined} onClick={() => settle(text)} disabled={busy || text.trim() === ""}>
          {busy ? "Saving…" : "Save the result"}
        </button>
        {error && <p class="error">{error}</p>}
      </div>
    </section>
  );
}

/** A command to copy, with a button that copies it. */
function Command({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  const copy = () => {
    navigator.clipboard?.writeText(text).then(
      () => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      },
      () => setCopied(false),
    );
  };
  return (
    <div class="hold-cmd">
      <code>{text}</code>
      <button type="button" onClick={copy} title="Copy the command">
        {copied ? "Copied" : "Copy"}
      </button>
    </div>
  );
}

/**
 * Claim, hand back and release the Item as the board's person, by the item commands' rules (the server says which buttons
 * apply, and why one cannot be pressed). The holder sees the Item's branch and the commands to work on it; Hand back is one
 * button: Scope Soup reads the branch from the remote and records its newest commit, or says why it cannot.
 */
function Hold({ page, reload, claimPrimary }: { page: ItemPage; reload: () => void; claimPrimary: boolean }) {
  const { item } = page;
  const hold = page.hold ?? {};
  const branch = hold.branch;
  const person = usePerson();
  const [busy, setBusy] = useState(false);
  const [said, setSaid] = useState<{ ok: boolean; text: string } | null>(null);
  const [note, setNote] = useState("");
  // Whether the branch is on the remote: undefined while asking, null when the remote could not be asked.
  const [onRemote, setOnRemote] = useState<boolean | null | undefined>(undefined);
  const [asked, setAsked] = useState(0);
  const [handing, setHanding] = useState(false);
  useEffect(() => {
    if (!branch) return;
    let live = true;
    setOnRemote(undefined);
    fetchItemBranch(item.ref.id).then(
      (state) => live && setOnRemote(state.onRemote ?? null),
      () => live && setOnRemote(null),
    );
    return () => {
      live = false;
    };
  }, [item.ref.id, branch?.name, asked]);
  const run = (doing: Promise<{ message?: string }>, after?: () => void) => {
    setBusy(true);
    doing
      .then(
        (done) => {
          setSaid({ ok: true, text: done.message ?? "Done." });
          after?.();
        },
        (problem: unknown) => setSaid({ ok: false, text: problem instanceof Error ? problem.message : String(problem) }),
      )
      .finally(() => {
        setBusy(false);
        setHanding(false);
        setAsked((count) => count + 1);
        reload();
      });
  };
  const handBack = () => {
    setSaid(null);
    setHanding(true);
    const text = note.trim();
    run(postHandBack(item.ref.id, text ? { note: text } : {}), () => setNote(""));
  };
  const button = (words: string, action: { why?: string } | undefined, title: string, onClick: () => void, primary = false) =>
    action && (
      <button type="button" class={primary ? "primary" : undefined} disabled={busy || action.why !== undefined} title={action.why ?? title} onClick={onClick}>
        {words}
      </button>
    );
  const why = [...new Set([hold.claim, hold.handBack, hold.release].map((action) => action?.why).filter((text): text is string => text !== undefined))];
  const where = !branch ? "" : onRemote === undefined ? `Looking for it on ${branch.remote}…` : onRemote ? `It is on ${branch.remote}: switch to it.` : onRemote === false ? `It is not on ${branch.remote} yet: start it from ${branch.mainBranch}.` : `${branch.remote} could not be asked whether it has it.`;
  return (
    <div class="hold">
      {branch && (
        <div class="hold-branch">
          <p>
            Work on the branch <code>{branch.name}</code>. <span class="muted">{where}</span>
          </p>
          <Command text={onRemote === true ? branch.resume : branch.start} />
          {onRemote === null && (
            <>
              <p class="muted">When the branch is on {branch.remote} already:</p>
              <Command text={branch.resume} />
            </>
          )}
          <p>Commit the work on it and push it with</p>
          <Command text={branch.push} />
          <p>then press Hand back: Scope Soup fetches the branch and hands back its newest commit.</p>
        </div>
      )}
      {hold.handBack && hold.handBack.why === undefined && (
        <label class="hold-note">
          Note for the reviewer (optional)
          <textarea rows={2} value={note} placeholder="What the reviewer should know" onInput={(event) => setNote((event.target as HTMLTextAreaElement).value)} disabled={busy} />
        </label>
      )}
      <div class="hold-buttons">
        {button("Claim", hold.claim, `Claim the ${itemNoun(false, true)} as ${person}: Scope Soup leaves it alone until you hand it back or release it.`, () => run(postClaim(item.ref.id)), claimPrimary)}
        {button(handing ? "Reading the branch…" : "Hand back", hold.handBack, branch ? `Scope Soup fetches ${branch.name} from ${branch.remote} and hands back its newest commit; it reviews it next, then checks and merges it.` : "Hand the work back on its branch.", handBack)}
        {button("Release", hold.release, `Release the hold as ${person}: Scope Soup may then start the ${itemNoun(false, true)}. The log says who released whose.`, () => run(postRelease(item.ref.id)))}
      </div>
      {why.map((text) => (
        <p class="muted" key={text}>
          {text}
        </p>
      ))}
      {said && (
        <p class={said.ok ? "muted" : "error"} role={said.ok ? "status" : "alert"}>
          {said.text}
        </p>
      )}
    </div>
  );
}

/** The limited resources this Item waits for a unit of, from the board's resources (the waiting entry names the Item's id). */
function waitingForUnit(id: string, resources: BoardView["resources"]): { name: string; since: string }[] {
  return (resources?.resources ?? []).flatMap((resource) =>
    resource.waiting.filter((wait) => wait.who.endsWith(` for ${id}`) || wait.who.endsWith(` on ${id}`)).map((wait) => ({ name: resource.name, since: wait.since })),
  );
}

/** A section with nothing in it yet: its heading and one line ("Change: none yet"). */
function EmptyPanel({ title, text, id }: { title: string; text: string; id?: string }) {
  return (
    <section class="panel panel-empty" {...(id ? { id } : {})}>
      <h3>{title}:</h3>
      <p class="empty">{text}</p>
    </section>
  );
}

/** The header's one status line: the card's short text ("held by @mira", "2 questions"), or the wait for a resource unit. */
function Status({ page, waits, now }: { page: ItemPage; waits: { name: string; since: string }[]; now: number }) {
  const viewer = usePerson();
  const status = statusText(page, viewer, waits);
  if (status.kind === "wait")
    return (
      <p class="reason reason-big">
        Waits for a unit of <b>{status.resource}</b> <span class="muted num">since {ago(status.since, now)}</span>; all of them are in use. <a href="#/queue">Merge queue</a>
      </p>
    );
  if (status.kind === "held")
    return (
      <p class="reason reason-big">
        held by <Mention name={status.name} mine={status.mine} />
      </p>
    );
  return status.kind === "text" ? <p class="reason reason-big">{status.text}</p> : null;
}

/** The backlog place in one line, with the score's why and Vote up / Vote down as ▲ ▼. */
function Place({ page }: { page: ItemPage }) {
  const { place, why } = placeText(page.why!);
  return (
    <div class="place">
      <p>
        <b>Place in backlog:</b> {place ? <span class="num">{place}</span> : null}
        {place && why ? " — " : ""}
        {why}
      </p>
      {page.canVote && <VoteButtons itemKey={page.item.key} off={page.voteOff} small />}
      {page.canVote && (page.voteOff?.up || page.voteOff?.down) && <span class="vote-off">{[page.voteOff.up, page.voteOff.down].filter(Boolean).join(" ")}</span>}
    </div>
  );
}

/** "held by mira; Scope Soup leaves it alone until …": the explanation after the short text the header shows. */
const holdWhy = (page: ItemPage): string | undefined => (page.heldBy && page.reason.startsWith("held by ") && page.reason.includes("; ") ? page.reason.slice(page.reason.indexOf("; ") + 2) : undefined);

function Body({ page, reload, resources }: { page: ItemPage; reload: () => void; resources?: BoardView["resources"] }) {
  const now = useNow();
  const { item } = page;
  const [editing, setEditing] = useState(false);
  const [chatWith, setChatWith] = useState<string | null>(null);
  const headerState = item.hostState.split(";")[0] ?? "";
  const facts = stateFacts(page.lane, item.hostState, hostDiffers(page.lane, item.hostState));
  const waits = waitingForUnit(item.ref.id, resources);

  // What waits for the person, in page order; the first panel that has a button for it holds the page's one primary button.
  const questions = panelQuestions(page, now);
  const showQuestions = (page.parked && !page.proposal && !page.parked.refine) || questions.length > 0;
  const questionsAsk = showQuestions && (page.parked ? page.parked.canAnswer : true) && questions.some((question) => question.answered === undefined);
  const openDecisions = page.assumptions.some((decision) => !decision.settled) && page.canSettle === true;
  const asking = [
    page.parked?.refine ? "draft" : "",
    questionsAsk ? "questions" : "",
    openDecisions ? "decisions" : "",
    page.proposal ? "split" : "",
    page.conflict ? "conflict" : "",
  ].filter(Boolean);
  const primary = asking[0];
  const holdWords = holdWhy(page);
  const finished = item.state === "done" || item.state === "abandoned";

  return (
    <article class="item">
      <header class={`item-head tone-${page.tone}`}>
        <p class="crumbs">
          <a href="#/">{words().startPage}</a> / <span class="num">{item.label}</span>
        </p>
        <h2>
          <span class="ref num">{item.label}</span> {item.title}
        </h2>
        <Status page={page} waits={waits} now={now} />
        <div class="tags">
          {page.lane && <span class="tag">{laneWord(page.lane)}</span>}
          {actorWords(page) && <span class={`tag ${actorClass(page)}`}>{actorWords(page)}</span>}
          {item.priority && item.priority !== "major" && <span class={`tag tag-priority-${item.priority}`}>{item.priority}</span>}
          {page.unblocks > 0 && <span class="tag tag-unblocks">unblocks {page.unblocks}</span>}
          {item.labels.map((label) => (
            <span class="tag" key={label}>{label}</span>
          ))}
          {item.url && item.openWords && (
            <a class="tag tag-link" href={item.url} rel="noreferrer">
              {item.openWords}
            </a>
          )}
        </div>
      </header>

      {/* The Item: what it is, what it waits behind, its place, and who holds it. */}
      {editing && (
        <section class="panel">
          <h3>Edit the {itemNoun()}</h3>
          <ItemForm
            start={{
              title: item.title,
              body: item.body ?? "",
              verification: item.verification ?? "",
              labels: item.labels.join(", "),
              priority: item.priority ?? "",
              blockedBy: page.blockedBy.map((other) => other.key.split(":").slice(2).join(":")).join(", "),
              state: (page.states ?? ["todo", "doing", "waiting", "done", "abandoned"]).includes(headerState) ? headerState : item.state,
            }}
            withState
            {...(page.states ? { states: page.states } : {})}
            submitWords="Save"
            onSubmit={(fields) =>
              postEdit(item.key, fields).then(() => {
                setEditing(false);
                reload();
              })
            }
            onCancel={() => setEditing(false)}
          />
        </section>
      )}

      <section class="panel" hidden={editing}>
        <div class="panel-head">
          <h3>{itemNoun(false, true)}</h3>
          {page.canEdit && (
            <button type="button" onClick={() => setEditing(true)}>
              Edit
            </button>
          )}
        </div>
        {item.body ? <Markdown text={item.body} /> : <p class="empty">No description.</p>}
        {item.verification && (
          <p class="verification">
            <b>Verification:</b> {item.verification}
          </p>
        )}
        {(page.blockedBy.length > 0 || page.blocks.length > 0) && (
          <div class="links">
            {page.blockedBy.length > 0 && (
              <p>
                <b>Blocked by</b>{" "}
                {page.blockedBy.map((other) => (
                  <a key={other.key} class={`chip${other.open ? " chip-open" : " chip-done"}`} href={itemHref(other.key)}>
                    <span class="ref num">{other.label}</span> {other.title}
                    {!other.open && " (done)"}
                  </a>
                ))}
              </p>
            )}
            {page.blocks.length > 0 && (
              <p>
                <b>Waiting behind this</b>{" "}
                {page.blocks.map((other) => (
                  <a key={other.key} class="chip" href={itemHref(other.key)}>
                    <span class="ref num">{other.label}</span> {other.title}
                  </a>
                ))}
              </p>
            )}
          </div>
        )}
        {page.links && page.links.length > 0 && <Links links={page.links} />}
        {page.why && <Place page={page} />}
        <dl class="facts">
          <dt>State</dt>
          <dd>{facts.state}</dd>
          {facts.host !== null && (
            <>
              <dt>On the host</dt>
              <dd>{facts.host}</dd>
            </>
          )}
          {item.openChildren > 0 && (
            <>
              <dt>Sub-{itemNoun(true)}</dt>
              <dd>{item.openChildren} open</dd>
            </>
          )}
          <dt>Updated</dt>
          <dd class="num">{ago(item.updatedAt, now)}</dd>
          {item.holder && (
            <>
              <dt>Held by</dt>
              <dd>
                {item.holder.actor.name}
                {item.holder.actor.bot ? " (an agent)" : ""}
                {item.holder.since ? `, since ${ago(item.holder.since, now)}` : ""}
                {item.holder.from ? ` (${fromWords(item.holder.from)})` : ""}
                {item.holder.quiet && <span class="tag tag-blocked">quiet for a while: ask, or release it</span>}
                {item.holder.actor.bot && item.holder.until && Date.parse(item.holder.until) <= now && <span class="tag tag-blocked">claim ran out</span>}
              </dd>
            </>
          )}
        </dl>
        {holdWords && <p class="muted">{holdWords}.</p>}
        {page.hold && <Hold page={page} reload={reload} claimPrimary={primary === undefined} />}
      </section>

      {/* What waits for you, each with the orange border while it is open. */}
      {page.parked?.refine && <DraftPanel key={page.parked.at} page={page} draft={page.parked.refine} reload={reload} primary={primary === "draft"} />}

      {showQuestions && <QuestionsPanel key={`${page.parked?.at ?? ""}:${questions.map((question) => question.id).join(",")}`} page={page} questions={questions} now={now} reload={reload} primary={primary === "questions"} />}

      {page.assumptions.length > 0 && (
        <section class={`panel${page.assumptions.some((decision) => !decision.settled) ? " panel-yours" : ""}`}>
          <h3>Decided by the implementor</h3>
          <p class="muted">Cheap to change later, so the work went on. Pick Accept, or Overturn with your decision, for each (the arrows go to the others); nothing is recorded until you press Send.</p>
          <Assumptions list={page.assumptions} now={now} canSettle={() => page.canSettle === true} onDone={reload} primary={primary === "decisions"} />
        </section>
      )}

      {page.decision.needed && !page.parked && page.questions.length === 0 && !page.conflict && (
        <section class="panel panel-yours">
          <h3>Decision needed</h3>
          <p>{page.decision.words}</p>
          {item.url && (
            <p>
              <a href={item.url} rel="noreferrer">
                Open the discussion
              </a>
            </p>
          )}
        </section>
      )}

      {page.proposal && <SplitProposal key={page.proposal.at ?? "split"} page={page} proposal={page.proposal} parts={page.proposal.parts} now={now} reload={reload} primary={primary === "split"} />}

      {page.conflict && <Conflict itemKey={item.key} conflict={page.conflict} reload={reload} primary={primary === "conflict"} />}

      {/* The work: the rounds of agents, the change, and talking to a session. */}
      {page.rounds.length === 0 ? (
        <EmptyPanel title="Rounds" text="no agent has worked on this yet" />
      ) : (
        <section class="panel">
          <h3>Rounds</h3>
          <Rounds
            rows={page.rounds}
            now={now}
            onTalk={(agentSession) => {
              setChatWith(agentSession);
              document.getElementById(CHAT_PANEL)?.scrollIntoView({ behavior: "smooth", block: "start" });
            }}
          />
        </section>
      )}

      {page.changes.length === 0 ? (
        <EmptyPanel title="Change" text="none yet" />
      ) : (
        <section class="panel">
          <h3>Change</h3>
          <ul class="rows">
            {page.changes.map((change) => (
              <li class="row" key={change.label}>
                <div class="row-head">
                  <span class="row-title">{change.title}</span>
                  <span class="tag">{change.draft ? "draft" : change.state}</span>
                  {change.url ? (
                    <a class="tag tag-link" href={change.url} rel="noreferrer">
                      diff {change.label}
                    </a>
                  ) : (
                    <span class="tag num">{change.label}</span>
                  )}
                </div>
                <div class="tags">
                  {change.verdicts.length === 0 && <span class="muted">No verdicts yet.</span>}
                  {change.verdicts.map((verdict, index) => (
                    <span key={index} class={`tag verdict verdict-${verdict.value}${verdict.stale ? " verdict-stale" : ""}`}>
                      {verdict.dimension}: {verdict.value}
                      {verdict.by ? ` · ${verdict.by.name}` : ""}
                      {verdict.stale ? " · older revision" : ""}
                    </span>
                  ))}
                </div>
                <p class="muted num">
                  into {change.target} · {change.revisions} revision{change.revisions === 1 ? "" : "s"} · {change.sha.slice(0, 9)} · by {change.author.name}
                </p>
                {change.blockers.length > 0 && <p class="reason">Cannot merge: {change.blockers.join("; ")}</p>}
              </li>
            ))}
          </ul>
        </section>
      )}

      <Diff itemKey={item.key} version={`${item.updatedAt}:${page.changes.map((change) => change.sha).join(",")}`} />

      {page.batches.length > 0 && (
        <section class="panel">
          <h3>Batch</h3>
          {page.batches.map(({ batch, position }) => (
            <div key={batch.key}>
              <p class="muted">
                Number {position} of {batch.members.length} in {batch.name}.
              </p>
              <BatchBox batch={batch} />
            </div>
          ))}
        </section>
      )}

      {page.runs.length === 0 ? (
        <EmptyPanel title="Runs" text="no CI run yet" />
      ) : (
        <section class="panel">
          <h3>Runs</h3>
          <ul class="rows">
            {page.runs.map((run) => (
              <li class="row" key={run.ref.id}>
                <div class="row-head">
                  <span class="row-title">{run.pipeline}</span>
                  <span class={`tag run-${run.status}`}>{run.status}</span>
                  <span class="muted num">
                    {run.sha.slice(0, 9)}
                    {run.runner ? ` · ${run.runner}` : ""}
                    {run.startedAt ? ` · started ${ago(run.startedAt, now)}` : ""}
                  </span>
                </div>
                {run.progress.state === "finished" ? <p class="muted num">{run.progress.words}</p> : <ProgressBar progress={run.progress} />}
              </li>
            ))}
          </ul>
        </section>
      )}

      <Chat itemKey={item.key} now={now} picked={chatWith} setPicked={setChatWith} finished={finished} />

      {/* History: what you answered, and the Item's log. */}
      {page.answers.length > 0 && (
        <section class="panel">
          <h3>Your answers</h3>
          <ul class="rows">
            {page.answers.map((answer) => (
              <li class="row">
                {answer.question && <p class="muted">{answer.question}</p>}
                <p>{answer.answer}</p>
                <p class="muted num">{ago(answer.at, now)}</p>
              </li>
            ))}
          </ul>
        </section>
      )}

      {page.history.length === 0 ? (
        <EmptyPanel title="Log" text="nothing yet" />
      ) : (
        <section class="panel">
          <h3>Log</h3>
          <ol class="rows history">
            {page.history.map((line, index) => (
              <li class="row" key={index}>
                <p class="muted num">
                  {line.by.name}
                  {line.by.bot ? " (agent)" : ""} · <time dateTime={line.at} title={line.at}>{ago(line.at, now)}</time>
                </p>
                <p class="history-text">{line.text}</p>
              </li>
            ))}
          </ol>
        </section>
      )}
    </article>
  );
}

export function Item({ refKey, resources }: { refKey: string; resources?: BoardView["resources"] }) {
  const { data, error, reload } = useView(() => fetchItem(refKey), refKey);
  useEffect(() => rememberViewed(refKey), [refKey]);
  if (!data) return <p class={error ? "notice notice-bad" : "empty"}>{error ?? "Loading…"}</p>;
  return <Body page={data} reload={reload} resources={resources} />;
}
