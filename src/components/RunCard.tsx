import { invoke } from "@tauri-apps/api/core";
import { ApprovalCard } from "./assistant-ui/elements/approval-card";
import { AgentPlan } from "./assistant-ui/elements/agent-plan";
import { Button } from "./controls/button";
/**
 * The pinned plan card.
 *
 * `docs/vision.md` §9: *"The plan sits pinned above the thread as a live card, collapsible to one
 * line, expandable to the full checklist, updating in place as phases complete. Nothing the owner
 * steers with ever scrolls away."* Pinned is structural, not decorative: this section is a flex
 * child of `.thread`, a sibling of the feed and **outside its scroller**, so no amount of feed
 * scrolling can move it. `src/App.tsx` is where that placement lives; `src/index.css`'s
 * `.run-card` is what stops it growing without bound.
 *
 * Four things here are decisions taken in `docs/plans/ipc-contract.md` §"The run", not styling
 * choices, and each one is a way a plausible-looking card would lie:
 *
 *   1. **A phase with `verify_command: null` has no gate and is drawn as having none.** It cannot
 *      go green through a gate, so it must not be drawn as a fifth ordinary row waiting its turn,
 *      and no placeholder command is ever printed in the hole. `gateLine` below is the whole of
 *      it.
 *   2. **`last_exit_code` is the gate's answer; there is no log tail on this wire and none is
 *      drawn.** The verify command's output goes to a file and to a worker's window
 *      (`docs/vision.md` §4 step 7.5). `last_evidence` is a bounded sentence and is rendered
 *      through `oneLine`, which collapses whitespace and clamps — so even a future writer that
 *      put a tail in that field cannot turn this card into a log viewer.
 *   3. **A work order at `state: "unknown"` is not a spinner.** Something moved in that worktree
 *      and the harness cannot tell what, so the phase is blocked and the order will not be
 *      repeated (`docs/research/intent-records.md` §5.1). It is drawn as blocked-needing-a-
 *      decision; drawing it as in-progress would tell the owner to wait for something that is
 *      never coming.
 *   4. **No dollar figure, here or anywhere on this surface.** The owner runs on his own
 *      subscription and is never billed per token (`docs/vision.md` §6), so a dollar figure would
 *      be a lie in his favour.
 *
 * The unsettled-intent list at the foot is **not the approvals dock and must not read like one.**
 * That dock is the safety boundary, where "allowed" and "denied" each mean exactly one thing. An
 * unsettled intent is the opposite question — the harness asking the owner whether something it
 * cannot observe actually happened — so its two actions are *mark done* and *mark not done*, and
 * neither authorizes anything.
 *
 * `IntentView.kind` is a **pass-through slug, not a closed set** (contract §"The run"), so the
 * slug is printed verbatim and nothing here switches on it. A build that adds a kind must not
 * break an older webview, and a card that hid an unrecognised kind would hide exactly the row the
 * owner most needs to see.
 */
import { useEffect, useState } from "react";

import type {
  IntentSettlement,
  IntentView,
  PhaseView,
  RunView,
  WorkOrderView,
} from "../wire";

export interface RunCardProps {
  /** The newest plan for the selected project, or null when there has never been one. */
  run: RunView | null;
  /** `unsettled_intents`, oldest first. Not scoped to a project; the command is not either. */
  intents: IntentView[];
  onSettle: (intentId: string, state: IntentSettlement) => void;
}

/**
 * How much of `last_evidence` reaches the screen, in characters.
 *
 * The Rust side already bounds the field. This bounds it again, and the duplication is the point:
 * the rule that keeps a log tail out of the thread is worth enforcing at the one place that draws
 * it, rather than trusting every future writer of that column.
 */
const EVIDENCE_MAX = 120;

/** One line, whatever arrived: whitespace collapsed, clamped, ellipsized. Never a log tail. */
function oneLine(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > EVIDENCE_MAX ? `${flat.slice(0, EVIDENCE_MAX)}…` : flat;
}

/** `2 green · 1 running · 1 blocked · 1 pending`, zeros omitted. */
function counts(phases: PhaseView[]): string {
  const order: PhaseView["state"][] = [
    "green",
    "running",
    "blocked",
    "pending",
  ];
  const parts = order
    .map((s) => [s, phases.filter((p) => p.state === s).length] as const)
    .filter(([, n]) => n > 0)
    .map(([s, n]) => `${n} ${s}`);
  return parts.length === 0 ? "no phases yet" : parts.join(" · ");
}

/**
 * What is happening now, in one clause — the third thing the collapsed line owes the owner after
 * the goal and the counts. A blocked run says so here rather than only inside the checklist,
 * because the collapsed line is the state the card spends most of its life in.
 */
function nowLine(run: RunView): string {
  if (run.status === "draft") return "planning";
  // Before any phase state, because a stopped run's phases keep the state they had: a frozen
  // `running` phase would otherwise read as work still going on after the owner stopped it.
  if (run.status === "abandoned") return "stopped · no further orders go out";
  const running = run.phases.find((p) => p.state === "running");
  if (running !== undefined) return `running · ${running.title}`;
  const blocked = run.phases.find((p) => p.state === "blocked");
  if (blocked !== undefined) return `blocked · ${blocked.title}`;
  if (run.phases.length > 0 && run.phases.every((p) => p.state === "green")) {
    return "every phase green";
  }
  return "waiting";
}

/**
 * The gate, or the absence of one.
 *
 * The null arm is the whole of rule 1 in the header. It says the phase has no gate **and** what
 * that costs — it cannot go green through one — because "no verify command" on its own reads like
 * a missing field rather than a phase the loop can never finish by itself.
 */
function gateLine(phase: PhaseView) {
  if (phase.verify_command === null) {
    return (
      <span className="run-nogate">
        no gate — this phase cannot go green through one
      </span>
    );
  }
  return <code className="run-verify">{phase.verify_command}</code>;
}

/**
 * One work order.
 *
 * The `unknown` arm is rule 3: blocked and needing a decision, never in progress. Every other
 * state prints itself; `unknown` prints itself **and** what it means, because the bare word reads
 * like "still finding out" and means the opposite.
 */
function orderRow(o: WorkOrderView) {
  const unknown = o.state === "unknown";
  return (
    <li className="run-order" key={o.order_id}>
      <span className={`run-state ${o.state}`}>
        {unknown ? "unknown · blocked" : o.state}
      </span>
      <span className="run-order-title">{o.title}</span>
      {o.branch !== null ? (
        <span className="run-order-ref mono">{o.branch}</span>
      ) : null}
      {o.owned_paths.length > 0 ? (
        <span className="run-paths mono" title={o.owned_paths.join("\n")}>
          {o.owned_paths.join(" ")}
        </span>
      ) : null}
      {unknown ? (
        <span className="run-order-why">
          something moved in this worktree and the harness cannot tell what, so
          the phase is blocked and this order will not be repeated — settle it
          below
        </span>
      ) : null}
      {o.report !== null ? (
        <span className="run-order-why">{oneLine(o.report)}</span>
      ) : null}
    </li>
  );
}

function phaseRow(phase: PhaseView, planId:string) {
  return (
    <div className="run-phase" key={phase.phase_id}>
      <div className="run-phase-head flex items-center gap-2">
        <span className="run-ord">{phase.ordinal}</span>
        <span className="run-title">{phase.title}</span>
        <span className={`run-state ${phase.state}`}>{phase.state}</span>
        {phase.attempts > 1 ? (
          <span className="run-attempts">{phase.attempts} attempts</span>
        ) : null}
      </div>
      <div className="run-gate">
        {gateLine(phase)}
        {/* The gate's answer, and the only number this card reads as a verdict. Never a tail. */}
        {phase.last_exit_code !== null ? (
          <span
            className={
              phase.last_exit_code === 0
                ? "run-exit ok-text"
                : "run-exit bad-text"
            }
          >
            exit {phase.last_exit_code}
          </span>
        ) : null}
        {phase.commit_sha !== null ? (
          <span className="run-sha mono">{phase.commit_sha}</span>
        ) : null}
      </div>
      <p className="run-dod">{phase.definition_of_done}</p>
      {phase.last_evidence !== null ? (
        <p className="run-evidence">{oneLine(phase.last_evidence)}</p>
      ) : null}
      {phase.last_evidence?.includes("Competing implementations require user approval") && <CompetingApproval planId={planId} phaseId={phase.phase_id} />}
      {phase.orders.length > 0 ? (
        <ul className="run-orders">{phase.orders.map(orderRow)}</ul>
      ) : null}
    </div>
  );
}

export function RunCard({ run, intents, onSettle }: RunCardProps) {
  /** Expanded by default: the checklist is the thing the owner walked away from. */
  const [open, setOpen] = useState(true);

  // Nothing to pin. The card does not draw an empty shell over a project that has never had a
  // run; the composer's "Start a run" control is what says the feature exists.
  if (run === null && intents.length === 0) return null;

  return (
    <section className="run-card mx-auto w-full max-w-[780px] rounded-md bg-elevated p-3" aria-label="the run">
      {run !== null ? (
        <>
          <div className="run-line">
            <Button
              type="button"
              className="run-toggle"
              aria-expanded={open}
              onClick={() => setOpen(!open)}
            >
              {open ? "Collapse" : "Expand"}
            </Button>
            <span className="run-goal" title={run.goal}>
              {run.goal}
            </span>
            <span className="run-counts">{counts(run.phases)}</span>
            <span className="run-now">{nowLine(run)}</span>
          </div>

          {open ? (
            <AgentPlan
              steps={run.phases.map((phase) => ({
                id: phase.phase_id,
                state: phase.state,
                content: phaseRow(phase,run.plan_id),
              }))}
            />
          ) : null}
        </>
      ) : null}

      {intents.length > 0 ? (
        <div className="run-intents">
          <p className="run-intents-head">
            {intents.length} unsettled. The harness cannot tell whether these
            happened. This is not an approval — neither answer allows or denies
            anything.
          </p>
          <ul className="run-intent-list">
            {intents.map((i) => (
              <li className="run-intent" key={i.intent_id}>
                {/* The slug verbatim. Nothing here switches on it: a build that adds a kind must
                    not break an older webview (contract §"The run"). */}
                <span className="run-intent-kind mono">{i.kind}</span>
                {i.subject !== null ? (
                  <span className="run-intent-subject mono" title={i.subject}>
                    {i.subject}
                  </span>
                ) : null}
                {i.evidence !== null ? (
                  <span className="run-intent-why">{oneLine(i.evidence)}</span>
                ) : null}
                <span className="run-intent-actions">
                  <Button
                    type="button"
                    className="act"
                    onClick={() => onSettle(i.intent_id, "done")}
                  >
                    Mark done
                  </Button>
                  <Button
                    type="button"
                    className="act"
                    onClick={() => onSettle(i.intent_id, "not_done")}
                  >
                    Mark not done
                  </Button>
                </span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </section>
  );
}

function CompetingApproval({planId,phaseId}:{planId:string;phaseId:string}){
 const [status,setStatus]=useState('');const [busy,setBusy]=useState(false);
 const [proposal,setProposal]=useState<{requestId:string;baseline:string;criteria:string}|null>(null);
 useEffect(()=>{let active=true;void invoke<{requestId:string;baseline:string;criteria:string}>('read_run_competing',{planId,phaseId}).then(p=>{if(active)setProposal(p);}).catch(e=>{if(active)setStatus(String(e));});return()=>{active=false;};},[planId,phaseId]);
 const decide=async(allow:boolean)=>{if(!proposal)return;setBusy(true);try{await invoke('decide_run_competing',{planId,phaseId,requestId:proposal.requestId,allow});setStatus(allow?'Approved. Explicitly continue the task when ready.':'Declined. Existing work is retained.');}catch(e){setStatus(String(e));}finally{setBusy(false);}};
 return <ApprovalCard heading="Try two isolated implementations from this baseline?">{proposal&&<p>{proposal.criteria} · Baseline {proposal.baseline.slice(0,12)}</p>}{status ? <p role="status">{status}</p>:<><Button disabled={busy||!proposal} onClick={()=>void decide(false)}>Decline</Button><Button disabled={busy||!proposal} onClick={()=>void decide(true)}>Allow competing implementations</Button></>}</ApprovalCard>;
}
