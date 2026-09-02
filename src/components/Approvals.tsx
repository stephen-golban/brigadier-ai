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
 */
import { useState } from "react";

import type { ApprovalItem } from "../feedStore";
import type { Decision, RequestId, SessionId } from "../wire";

const DEFAULT_DENY_REASON = "Denied by operator";

export interface ApprovalsProps {
  approvals: ApprovalItem[];
  onRespond: (sessionId: SessionId, requestId: RequestId, decision: Decision) => void;
  onDismiss: (requestId: RequestId) => void;
}

export function Approvals({ approvals, onRespond, onDismiss }: ApprovalsProps) {
  return (
    <section className="approvals">
      <header className="pane-head">
        <span>approvals</span>
        <span className="dim">{approvals.length} open</span>
      </header>
      <div className="approvals-body">
        {approvals.length === 0 ? <p className="empty">nothing waiting</p> : null}
        {approvals.map((a) => (
          <ApprovalCard
            key={a.requestId}
            approval={a}
            onRespond={onRespond}
            onDismiss={onDismiss}
          />
        ))}
      </div>
    </section>
  );
}

interface CardProps {
  approval: ApprovalItem;
  onRespond: (sessionId: SessionId, requestId: RequestId, decision: Decision) => void;
  onDismiss: (requestId: RequestId) => void;
}

function ApprovalCard({ approval, onRespond, onDismiss }: CardProps) {
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

  return (
    <article className={readOnly ? "approval expired" : "approval"}>
      <div className="approval-head">
        <strong>
          {kind === null
            ? "unreadable request"
            : kind.type === "tool-permission"
              ? kind.tool_name
              : "question"}
        </strong>
        <span className="dim">
          {approval.sessionId} · {new Date(approval.openedAtMs).toLocaleTimeString()}
        </span>
        {readOnly ? (
          <span className="badge">expired: no longer answerable (app restarted or session ended)</span>
        ) : null}
      </div>

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

      {readOnly ? (
        <div className="approval-actions">
          <button type="button" onClick={() => onDismiss(approval.requestId)}>
            dismiss
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
          <button type="button" className="danger" onClick={deny}>
            confirm deny
          </button>
          <button type="button" onClick={() => setDenying(false)}>
            cancel
          </button>
        </div>
      ) : (
        <div className="approval-actions">
          {kind === null ? null : (
            <button type="button" className="ok" onClick={allow}>
              allow
            </button>
          )}
          <button type="button" className="danger" onClick={() => setDenying(true)}>
            deny
          </button>
        </div>
      )}
    </article>
  );
}
