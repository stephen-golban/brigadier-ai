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
 * The panel is **never filtered by the selected project**. A webview reload resets the selection
 * to the first project, so filtering here hid a still-answerable prompt that belonged to another
 * project and made a live approval look like data loss (`docs/research/approvals.md` §7 gap 7).
 * Each card names its own project instead, an approval outside the current selection is marked,
 * and clicking one jumps the window to it.
 */
import { useState } from "react";
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
  /** Null when the store has never seen this approval's session. */
  projectId: ProjectId | null;
  /** Null when the project is unknown or not in `list_projects`; the card then shows the id. */
  projectName: string | null;
  /** The project is known and is not the selected one. */
  elsewhere: boolean;
}

export interface ApprovalsProps {
  approvals: ApprovalRow[];
  onRespond: (sessionId: SessionId, requestId: RequestId, decision: Decision) => void;
  onDismiss: (requestId: RequestId) => void;
  /** Select the approval's session (and its project). Omitted, cards are not clickable. */
  onFocus?: (projectId: ProjectId | null, sessionId: SessionId) => void;
}

export function Approvals({ approvals, onRespond, onDismiss, onFocus }: ApprovalsProps) {
  const elsewhere = approvals.filter((r) => r.elsewhere).length;
  return (
    <section className="approvals" hidden={approvals.length === 0}>
      <div className="approvals-head">
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
  onRespond: (sessionId: SessionId, requestId: RequestId, decision: Decision) => void;
  onDismiss: (requestId: RequestId) => void;
  onFocus?: (projectId: ProjectId | null, sessionId: SessionId) => void;
}

function ApprovalCard({ row, onRespond, onDismiss, onFocus }: CardProps) {
  const approval = row.approval;
  const [applied, setApplied] = useState<Set<number>>(new Set());
  const [denying, setDenying] = useState(false);
  const [reason, setReason] = useState(DEFAULT_DENY_REASON);

  const kind = approval.kind;
  const readOnly = approval.expired;

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
    onRespond(approval.sessionId, approval.requestId, {
      type: "allow",
      updated_input: null,
      // Echoed back verbatim; the harness never interprets a provider suggestion.
      updated_permissions: [...applied].sort((a, b) => a - b).map((i) => suggestions[i]),
    });
  };

  const deny = () => {
    const text = reason.trim() === "" ? DEFAULT_DENY_REASON : reason.trim();
    onRespond(approval.sessionId, approval.requestId, {
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
    if (t instanceof Element && t.closest("button, input, textarea, label") !== null) return;
    onFocus(row.projectId, approval.sessionId);
  };

  return (
    <article
      className={`approval${readOnly ? " expired" : ""}${row.elsewhere ? " elsewhere" : ""}`}
      onClick={focus}
    >
      <div className="approval-head">
        <strong>
          {kind === null
            ? "unreadable request"
            : kind.type === "tool-permission"
              ? kind.tool_name
              : "question"}
        </strong>
        <span className="dim">
          {row.projectName ?? "project unknown"} · {shortSessionId(approval.sessionId)} ·{" "}
          {new Date(approval.openedAtMs).toLocaleTimeString()}
        </span>
        {row.elsewhere ? <span className="chip">other project</span> : null}
        {readOnly ? (
          <span className="chip plain">expired: no longer answerable (app restarted or session ended)</span>
        ) : null}
      </div>

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
      <div className="approval-body">
        {kind === null ? (
          <p className="dim">
            request too large to display · deny is the only safe answer
          </p>
        ) : kind.type === "tool-permission" ? (
          <>
            <pre className="excerpt">{kind.input_excerpt}</pre>
            {kind.suggestions.length > 0 ? (
              <ul className="suggestions">
                {kind.suggestions.map((s, i) => (
                  <li key={i}>
                    <label>
                      <input
                        type="checkbox"
                        checked={applied.has(i)}
                        disabled={readOnly}
                        onChange={() => toggle(i)}
                      />
                      <span>apply</span>
                    </label>
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
              <p className="dim">options: {kind.options.join(" · ")}</p>
            ) : null}
            <p className="dim">
              free-text answers are not wired this phase; allow/deny is the only decision the
              contract carries.
            </p>
          </>
        )}
      </div>

      {readOnly ? (
        <div className="approval-actions">
          <button type="button" className="act" onClick={() => onDismiss(approval.requestId)}>
            Dismiss
          </button>
        </div>
      ) : denying ? (
        <div className="approval-actions">
          <input
            className="reason"
            value={reason}
            autoFocus
            onChange={(e) => setReason(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") deny();
              if (e.key === "Escape") setDenying(false);
            }}
          />
          <button type="button" className="act danger" onClick={deny}>
            Confirm deny
          </button>
          <button type="button" className="act" onClick={() => setDenying(false)}>
            Cancel
          </button>
        </div>
      ) : (
        <div className="approval-actions">
          {kind === null ? null : (
            <button type="button" className="send wide" onClick={allow}>
              Allow
            </button>
          )}
          <button type="button" className="act danger" onClick={() => setDenying(true)}>
            Deny
          </button>
        </div>
      )}
    </article>
  );
}
