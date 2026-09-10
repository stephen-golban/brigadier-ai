import { ApprovalCard as ApprovalElement } from "./assistant-ui/elements/approval-card";
import { Checkbox } from "./controls/checkbox";
import { Input } from "./controls/input";
import { Button } from "@/components/ui/button";
/**
 * The approval prompts.
 *
 * One card per open `request-opened`. For a `tool-permission` the operator sees the tool name,
 * the bounded `input_excerpt`, and the provider's `suggestions` rendered as JSON, each with an
 * "apply" checkbox that puts that suggestion verbatim into `Decision.updated_permissions`.
 * There is no "always allow" button: "always allow" *is* an allow that echoes a suggestion
 * (`crates/core/src/session.rs:33-38`).
 *
 * `pending_approvals()` is read on mount. Rows whose `run_id` differs from this launch come
 * back `expired: true`; the provider process that parked them is gone, so they are read-only
 * and can only be dismissed from the list.
 *
 * `ApprovalView.kind` is nullable: the store replaces an oversized kind JSON with a placeholder
 * that does not decode. Such a row cannot be shown and must not be allowed blind, so it renders
 * read-only with Deny as the only answer.
 *
 * App places the selected session's requests inside its assistant-ui thread. Other sessions
 * retain their attention dots until their requests are answered.
 */
import { useState } from "react";
import type { ApprovalHistoryItem } from "./approvalHistory";
import type { MouseEvent } from "react";

import type { ApprovalItem } from "../feedStore";
import type { Decision, ProjectId, RequestId, SessionId } from "../wire";

const DEFAULT_DENY_REASON = "Denied by operator";

/** Same rule as `Feed.tsx`'s own `shortId`; session ids are UUIDs (`driver.rs:149`). */
function shortSessionId(id: SessionId): string {
  return id.length <= 6 ? id : id.slice(-6);
}

/** One approval plus the project context `App` resolved for it. */
export interface ApprovalRow {
  approval: ApprovalItem;
  conversationId?: string;
  subagentTitle?: string;
  /** Null when the store has never seen this approval's session. */
  projectId: ProjectId | null;
  /** Null when the project is unknown or not in `list_projects`; the card then shows the id. */
  projectName: string | null;
  /** The project is known and is not the selected one. */
  elsewhere: boolean;
}

export interface ApprovalsProps {
  approvals: ApprovalRow[];
  onRespond: (
    sessionId: SessionId,
    requestId: RequestId,
    decision: Decision,
  ) => Promise<void> | void;
  onDismiss: (requestId: RequestId) => void;
  /** Select the approval's session (and its project). Omitted, cards are not clickable. */
  onFocus?: (projectId: ProjectId | null, sessionId: SessionId) => void;
}

export function Approvals({
  approvals,
  onRespond,
  onDismiss,
  onFocus,
}: ApprovalsProps) {
  const elsewhere = approvals.filter((r) => r.elsewhere).length;
  return (
    <section className="approvals mx-auto my-3 w-full max-w-[780px]" hidden={approvals.length === 0}>
      <div className="approvals-head text-[13px] text-warn">
        <span>
          Waiting on you · {approvals.length} open
          {elsewhere > 0 ? ` · ${elsewhere} in other projects` : ""}
        </span>
      </div>
      <div className="approvals-body">
        {approvals.map((r) => (
          <ApprovalCard
            key={r.approval.requestId}
            row={r}
            onRespond={onRespond}
            onDismiss={onDismiss}
            onFocus={onFocus}
          />
        ))}
      </div>
    </section>
  );
}

interface CardProps {
  row: ApprovalRow;
  onRespond: (
    sessionId: SessionId,
    requestId: RequestId,
    decision: Decision,
  ) => Promise<void> | void;
  onDismiss: (requestId: RequestId) => void;
  onFocus?: (projectId: ProjectId | null, sessionId: SessionId) => void;
}

function ApprovalCard({ row, onRespond, onDismiss, onFocus }: CardProps) {
  const approval = row.approval;
  const [applied, setApplied] = useState<Set<number>>(new Set());
  const [denying, setDenying] = useState(false);
  const [reason, setReason] = useState(DEFAULT_DENY_REASON);
  const [responding, setResponding] = useState(false);
  const [responseError, setResponseError] = useState<string | null>(null);
  const respond = async (decision: Decision) => {
    if (responding) return;
    setResponding(true); setResponseError(null);
    try { await onRespond(approval.sessionId, approval.requestId, decision); window.dispatchEvent(new Event("brigadier-approval-response")); }
    catch (error) { setResponseError(error instanceof Error ? error.message : String(error)); setResponding(false); }
  };

  const kind = approval.kind;
  const readOnly = approval.expired;
  let mcp: {message: string; description?: string; arguments?: unknown} | null = null;
  if (kind?.type === "tool-permission" && kind.tool_name.startsWith("MCP · ")) {
    try {
      const details = JSON.parse(kind.input_excerpt);
      if (typeof details.message === "string") mcp = details;
    } catch { /* A truncated excerpt remains visible without guessing its structure. */ }
  }

  const toggle = (i: number) => {
    setApplied((prev) => {
      const next = new Set(prev);
      if (next.has(i)) next.delete(i);
      else next.add(i);
      return next;
    });
  };

  const allow = () => {
    if (kind === null) return;
    const suggestions = kind.type === "tool-permission" ? kind.suggestions : [];
    void respond({
      type: "allow",
      updated_input: null,
      // Echoed back verbatim; the harness never interprets a provider suggestion.
      updated_permissions: [...applied]
        .sort((a, b) => a - b)
        .map((i) => suggestions[i]),
    });
  };

  const deny = () => {
    const text = reason.trim() === "" ? DEFAULT_DENY_REASON : reason.trim();
    void respond({
      type: "deny",
      reason: text,
      interrupt: false,
    });
  };

  /**
   * Clicking the card body selects its session. The guard keeps allow / deny / dismiss, the
   * suggestion checkboxes and the deny-reason field from also yanking the window to another
   * project as a side effect of answering.
   */
  const focus = (e: MouseEvent<HTMLElement>) => {
    if (onFocus === undefined) return;
    const t = e.target;
    if (
      t instanceof Element &&
      t.closest("button, input, textarea, label") !== null
    )
      return;
    onFocus(row.projectId, row.conversationId ?? approval.sessionId);
  };

  return (
    <ApprovalElement
      id={`approval-${approval.requestId}`}
      data-request-id={approval.requestId}
      aria-busy={responding}
      style={{ scrollMarginBlock: "24px" }}
      className={`approval${readOnly ? " expired" : ""}${row.elsewhere ? " elsewhere" : ""}`}
      onClick={focus}
      heading={
        <div className="approval-head flex flex-wrap gap-2">
          <strong>
            {kind === null
              ? "unreadable request"
              : kind.type === "tool-permission"
                ? kind.tool_name
                : "question"}
          </strong>
          <span className="dim text-text-tertiary">
            {row.projectName ?? "project unknown"} ·{" "}
            {shortSessionId(approval.sessionId)} ·{" "}
            {new Date(approval.openedAtMs).toLocaleTimeString()}
          </span>
          {row.elsewhere ? <span className="chip">other project</span> : null}
          {readOnly ? (
            <span className="chip plain">
              expired: no longer answerable (app restarted or session ended)
            </span>
          ) : null}
        </div>
      }
    >
      {/*
        R2, 2026-09-05. **The detail scrolls; the decision does not.**
        `docs/STATUS.md` §5 defect 3 predicted that Allow and Deny fall below the fold and could
        not confirm it against a mock with no open approval; the owner confirmed it in a real
        window on 2026-09-04 — `Waiting on you · 1 open` with both buttons needing a scroll inside
        the dock to reach, which he said he mostly did not notice.
        This wrapper is the fix: the head and the action row are fixed children of the card, and
        the excerpt and the suggestions are the only thing that yields. A card squeezed to the
        window's 800x500 minimum therefore loses excerpt, never the decision.
      */}
      {row.subagentTitle && <p className="px-3 text-text-secondary">Subagent request · {row.subagentTitle}</p>}
      <div className="approval-body max-h-64 overflow-auto">
        {kind === null ? (
          <p className="dim text-text-tertiary">
            request too large to display · deny is the only safe answer
          </p>
        ) : kind.type === "tool-permission" ? (
          <>
            {mcp ? <>
              <p className="mb-2">{mcp.message}</p>
              {typeof mcp.description === "string" && <p className="mb-2 text-text-secondary">{mcp.description}</p>}
              {mcp.arguments !== undefined && <pre className="excerpt">{JSON.stringify(mcp.arguments, null, 2)}</pre>}
            </> : <pre className="excerpt">{kind.input_excerpt}</pre>}
            {kind.suggestions.length > 0 ? (
              <ul className="suggestions">
                {kind.suggestions.map((s, i) => (
                  <li key={i}>
                    <Checkbox
                      checked={applied.has(i)}
                      disabled={readOnly || responding}
                      onCheckedChange={() => toggle(i)}
                    >
                      <span>apply</span>
                    </Checkbox>
                    <pre className="suggestion">{JSON.stringify(s)}</pre>
                  </li>
                ))}
              </ul>
            ) : null}
          </>
        ) : (
          <>
            <pre className="excerpt">{kind.prompt}</pre>
            {kind.options.length > 0 ? (
              <p className="dim text-text-tertiary">options: {kind.options.join(" · ")}</p>
            ) : null}
          </>
        )}
      </div>

      {responseError && <p role="alert" className="text-error text-xs">{responseError} Your decision has not been confirmed; you can retry.</p>}
      {responding && <p role="status" className="text-xs text-text-secondary">Sending decision…</p>}
      {readOnly ? (
        <div className="approval-actions mt-3 flex flex-wrap items-center justify-end gap-2">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="act"
            onClick={() => onDismiss(approval.requestId)}
          >
            Dismiss
          </Button>
        </div>
      ) : denying ? (
        <div className="approval-actions mt-3 flex flex-wrap items-center justify-end gap-2">
          <Input
            className="reason"
            disabled={responding}
            value={reason}
            autoFocus
            onChange={(e) => setReason(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") deny();
              if (e.key === "Escape") setDenying(false);
            }}
          />
          <Button type="button" variant="ghost" size="sm" disabled={responding} className="act danger text-warn" onClick={deny}>
            Confirm deny
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="act"
            disabled={responding}
            onClick={() => setDenying(false)}
          >
            Cancel
          </Button>
        </div>
      ) : (
        <div className="approval-actions mt-3 flex flex-wrap items-center justify-end gap-2">
          {kind === null ? null : (
            <Button type="button" variant="ghost" size="sm" disabled={responding} className="send wide" onClick={allow}>
              Allow
            </Button>
          )}
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="act danger text-warn"
            disabled={responding}
            onClick={() => setDenying(true)}
          >
            Deny
          </Button>
        </div>
      )}
    </ApprovalElement>
  );
}

/** A confirmed decision is separate from the requested action's eventual execution result. */
export function ApprovalResolution({ approval }: { approval: ApprovalHistoryItem }) {
  if (!approval.resolved) return null;
  const allowed = approval.decision?.type === "allow";
  const expired = approval.decision === null;
  const name = approval.kind?.type === "tool-permission" ? approval.kind.tool_name : "Request";
  return <details id={`approval-${approval.request_id}`} data-slot="approval-resolution" className="my-2 text-xs text-text-secondary" style={{ scrollMarginBlock: "24px" }}>
    <summary className="cursor-pointer">{expired ? "Expired" : allowed ? "Approved" : "Denied"} · {name}</summary>
    <div className="mt-2 rounded-lg border border-hairline p-3">
      <p>{expired ? "This request is no longer answerable. No approval decision was recorded." : allowed ? "Permission granted. See the action above for its execution result." : approval.decision?.type === "deny" ? approval.decision.reason : "Request denied."}</p>
    </div>
  </details>;
}
