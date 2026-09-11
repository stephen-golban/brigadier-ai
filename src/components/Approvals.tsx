import { ApprovalCommandPreview, ApprovalRequest, type ApprovalRequestKind } from "./thread/ApprovalRequest";
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
import type { MouseEvent, ReactNode } from "react";

import type { ApprovalItem } from "../feedStore";
import type { Decision, ProjectId, RequestId, SessionId } from "../wire";

const DEFAULT_DENY_REASON = "Denied by operator";

/**
 * Owner review 2026-09-11, item 1: **a tool payload is code and is drawn as code.**
 *
 * It used to be a bare `<pre class="excerpt">` — no surface, no radius, no padding (measured
 * `rgba(0,0,0,0)` background, `0px` border, `0px` radius, `0px` padding before this change), so
 * a JSON body ran as loose monospace text straight against the card wall.
 *
 * This is not a new component. `ApprovalCommandPreview` is the approval card's own vendored code
 * block — the same surface the command subject in the card header already uses
 * (`src/components/thread/ApprovalRequest.tsx`, `.thread-approval-command__surface`): opaque
 * editor ground, `--thread-radius-sm`, `--thread-font-mono`, `white-space: pre-wrap` with
 * `overflow-wrap: anywhere`, and a 20rem scroll cap. It wraps and scrolls; it never clips.
 *
 * `defaultExpanded`: the clamp is a 3-line `-webkit-line-clamp`, and clipping the payload is the
 * defect. Opened, the surface scrolls instead, and the kit's own Collapse control stays for a
 * long one.
 */
function ApprovalCode({ className, label, text }: { className?: string; label: string; text: string }) {
  return (
    <ApprovalCommandPreview
      aria-label={label}
      className={["approval-code", className].filter(Boolean).join(" ")}
      collapsedLines={12}
      command={text}
      defaultExpanded
    />
  );
}

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
  // The tool input, parsed once. The card leads with what this request *concerns* — the command,
  // the file, the address — instead of the excerpt verbatim; the excerpt stays one disclosure
  // away, because the exact bytes are what an operator audits a grant against.
  const input = kind?.type === "tool-permission" ? parseInput(kind.input_excerpt) : null;
  const command = field(input, "command") ?? field(input, "cmd");
  const path = field(input, "file_path") ?? field(input, "path") ?? field(input, "notebook_path");
  const url = field(input, "url");
  const pattern = field(input, "pattern") ?? field(input, "query");
  const intent = field(input, "description") ?? field(input, "prompt");
  // The subject of the request, chosen by what the tool *is* rather than by which field the
  // excerpt happens to carry first: a `Write` whose input mentions a command is still about its
  // path. Falls through the others only when the tool's own field is absent.
  const subjectNode = kind?.type === "tool-permission" ? subject(requestIcon(kind), { command, path, url, pattern }) : undefined;
  // Nothing recognised: an unfamiliar tool shape is exactly where a summary must not be invented,
  // so the excerpt stays the default presentation, as it was before the summary existed.
  const summarised = subjectNode !== undefined || intent !== undefined;
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

  // Plan §3 row 12. The chrome is the vendored `ApprovalRequest`; the state machine above is
  // untouched and stays **non-optimistic**: `decision` is `"pending"` until the store drops the
  // row on `request-resolved`, `loading` means "sent, awaiting that", and there is no local
  // `submitted` flag anywhere. Do not adopt assistant-ui's `disabled={submitted}` tool-fallback
  // pattern here or anywhere else.
  //
  // `approval.expired` is the kit's brigadier-added fourth decision value: *open but no longer
  // answerable*, a Dismiss-only card. It is a different thing from a resolved history row whose
  // `decision` is null, which is `ApprovalResolution` below and is not an `ApprovalRequest` at
  // all (§1.4, landmine 5).
  //
  // `autoFocus={false}`: the kit focuses Approve on mount, which would pull focus out of the
  // composer the instant a request opens mid-typing. Enter/Escape still answer the card — the
  // kit's own handler ignores the keystroke when focus is inside `input, textarea,
  // [contenteditable]:not([contenteditable="false"]), [role="textbox"], …`
  // (`src/components/thread/ApprovalRequest.tsx`), and the Lexical composer is both
  // `contenteditable` and `role="textbox"` (`src/components/composer/RichPromptEditor.tsx`).
  return (
    <ApprovalRequest
      id={`approval-${approval.requestId}`}
      data-request-id={approval.requestId}
      style={{ scrollMarginBlock: "24px" }}
      className={`approval${readOnly ? " expired" : ""}${row.elsewhere ? " elsewhere" : ""}`}
      onClick={focus}
      kind={requestIcon(kind)}
      decision={readOnly ? "expired" : "pending"}
      loading={responding}
      autoFocus={false}
      showShortcutHints
      approveShortcutLabel="⏎"
      rejectShortcutLabel="esc"
      title={
        kind === null
          ? "unreadable request"
          : kind.type === "tool-permission"
            ? kind.tool_name
            : "question"
      }
      description={
        <span className="approval-head">
          {row.projectName ?? "project unknown"} ·{" "}
          {shortSessionId(approval.sessionId)} ·{" "}
          {new Date(approval.openedAtMs).toLocaleTimeString()}
          {row.elsewhere ? <span className="chip">other project</span> : null}
          {readOnly ? (
            <span className="chip plain">
              expired: no longer answerable (app restarted or session ended)
            </span>
          ) : null}
        </span>
      }
      approveLabel="Allow"
      rejectLabel={denying ? "Cancel" : "Deny"}
      approveDisabled={denying}
      onApprove={kind === null ? undefined : allow}
      onReject={() => setDenying(!denying)}
      onDismiss={readOnly ? () => onDismiss(approval.requestId) : undefined}
      dismissLabel="Dismiss"
      details={mcp ? undefined : subjectNode}
    >
      {/*
        R2, 2026-09-05. **The detail scrolls; the decision does not.**
        `docs/STATUS.md` §5 defect 3 predicted that Allow and Deny fall below the fold and could
        not confirm it against a mock with no open approval; the owner confirmed it in a real
        window on 2026-09-04 — `Waiting on you · 1 open` with both buttons needing a scroll inside
        the dock to reach, which he said he mostly did not notice.
        The kit's card keeps its header and its action row as fixed children; only this body
        yields. A card squeezed to the window's 800x500 minimum loses excerpt, never the decision.
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
              {mcp.arguments !== undefined && <ApprovalCode label="Tool arguments" text={JSON.stringify(mcp.arguments, null, 2)} />}
            </> : intent !== undefined ? (
              <p className="approval-intent mb-2 text-text-secondary">{intent}</p>
            ) : input === null || !summarised ? (
              // Either not JSON — the excerpt is bounded to 8 KiB by the adapter and can arrive
              // truncated mid-token — or a shape with no field this app recognises. Both leave
              // the bytes as the whole story, so they stay the default presentation.
              <ApprovalCode label="Tool input" text={kind.input_excerpt} />
            ) : null}
            {kind.suggestions.length > 0 ? (
              <ul className="suggestions">
                {kind.suggestions.map((s, i) => (
                  <li key={i}>
                    <Checkbox
                      checked={applied.has(i)}
                      disabled={readOnly || responding}
                      onCheckedChange={() => toggle(i)}
                    >
                      {/* The sentence is presentation only. What `allow` echoes back is the
                          suggestion object verbatim, unchanged and uninterpreted; the exact
                          bytes of every rule are under "Show the full request" below. */}
                      <span title={JSON.stringify(s)}>{scopeSummary(s)}</span>
                    </Checkbox>
                  </li>
                ))}
              </ul>
            ) : null}
            {!mcp && input !== null && summarised ? (
              <details className="approval-raw mt-2 text-xs text-text-tertiary">
                <summary className="cursor-pointer">Show the full request</summary>
                <ApprovalCode className="mt-2" label="Tool input" text={kind.input_excerpt} />
                {kind.suggestions.map((s, i) => (
                  <ApprovalCode className="mt-1" label="Permission rule" key={i} text={JSON.stringify(s)} />
                ))}
              </details>
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
      {denying && (
        <div className="approval-deny mt-3 flex flex-wrap items-center justify-end gap-2">
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
        </div>
      )}
    </ApprovalRequest>
  );
}

/** The tool input as an object, or `null` when the excerpt is not a JSON object — it is bounded
 *  to 8 KiB by `crates/core/src/event.rs` and can arrive truncated mid-token. */
function parseInput(excerpt: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(excerpt);
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/** One non-empty string field of the tool input, or `undefined`. Never guesses a shape. */
function field(input: Record<string, unknown> | null, name: string): string | undefined {
  const value = input?.[name];
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

/** What this request is *about*, drawn the way its tool kind wants to be read. */
function subject(
  icon: ApprovalRequestKind,
  fields: { command?: string; path?: string; url?: string; pattern?: string },
): ReactNode {
  const { command, path, url, pattern } = fields;
  const preferred =
    icon === "command" ? command
    : icon === "file" ? path
    : icon === "network" ? url
    : undefined;
  const chosen = preferred ?? command ?? path ?? url ?? pattern;
  if (chosen === undefined) return undefined;
  if (chosen === command) return <ApprovalCommandPreview command={chosen} />;
  if (chosen === path) return <FilePath path={chosen} />;
  return <span className="approval-subject">{chosen}</span>;
}

/** The path a request concerns, split so the eye lands on the file rather than the prefix. */
function FilePath({ path }: { path: string }) {
  const cut = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return (
    <span className="approval-subject" title={path}>
      {cut >= 0 ? <span className="text-text-tertiary">{path.slice(0, cut + 1)}</span> : null}
      {path.slice(cut + 1)}
    </span>
  );
}

/**
 * What checking this box would grant, in a sentence. **Presentation only** — `allow` echoes the
 * suggestion object back verbatim (`updated_permissions`), and an unrecognised shape falls back
 * to its own JSON rather than to a reassuring guess. The raw object is always reachable: it is
 * the checkbox's `title` and it is printed under "Show the full request".
 */
function scopeSummary(suggestion: unknown): string {
  const raw = JSON.stringify(suggestion);
  if (typeof suggestion !== "object" || suggestion === null) return raw;
  const s = suggestion as Record<string, unknown>;
  if (s.type === "addRules" && Array.isArray(s.rules)) {
    const verb = s.behavior === "deny" ? "Always deny" : s.behavior === "allow" ? "Always allow" : `Add a ${String(s.behavior ?? "permission")} rule for`;
    const rules = s.rules
      .map((rule) => {
        if (typeof rule !== "object" || rule === null) return null;
        const entry = rule as Record<string, unknown>;
        const tool = typeof entry.toolName === "string" ? entry.toolName : null;
        const content = typeof entry.ruleContent === "string" ? entry.ruleContent : null;
        if (tool === null) return null;
        return content === null ? tool : `${tool} · ${content}`;
      })
      .filter((r): r is string => r !== null);
    if (rules.length > 0) return `${verb} ${rules.join(", ")}, for the rest of this session`;
  }
  if (s.type === "setMode" && typeof s.mode === "string") {
    const modes: Record<string, string> = {
      acceptEdits: "accept edits without asking",
      bypassPermissions: "bypass permission prompts",
      default: "ask for every permission",
      plan: "plan only, without acting",
    };
    return `Switch this session to ${modes[s.mode] ?? s.mode}`;
  }
  return raw;
}

/** Which identity glyph the card wears. Presentation only; it never widens a permission. */
function requestIcon(kind: ApprovalItem["kind"]): ApprovalRequestKind {
  if (kind === null || kind.type !== "tool-permission") return "generic";
  const name = kind.tool_name.toLowerCase();
  if (name.startsWith("mcp · ") || name.startsWith("mcp__")) return "mcp";
  if (["bash", "shell", "exec_command", "write_stdin"].includes(name)) return "command";
  if (["edit", "write", "multiedit", "apply_patch", "notebookedit"].includes(name)) return "file";
  if (["webfetch", "websearch"].includes(name)) return "network";
  return "permission";
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
