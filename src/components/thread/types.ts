// Vendored from the Codex UI Kit (MIT); see src/components/thread/UPSTREAM.md.
export type AgentItemStatus =
  | "pending"
  | "running"
  | "completed"
  | "failed";

export type AgentMessageRole = "user" | "assistant" | "system";

export type ApprovalDecision = "pending" | "approved" | "rejected" | "expired";
// "expired" is a brigadier addition, not upstream: an approval that is still open but
// can no longer be answered because the run that parked it is gone (see
// src/components/thread/UPSTREAM.md, ApprovalRequest).

export interface AgentMessageItem {
  id: string;
  type: "message";
  role: AgentMessageRole;
  text: string;
  status?: AgentItemStatus;
}

export interface ToolCallItem {
  id: string;
  type: "tool-call";
  name: string;
  summary?: string;
  status: AgentItemStatus;
}

export type AgentItem = AgentMessageItem | ToolCallItem;

export type AgentActivityKind =
  | "command"
  | "file-change"
  | "reasoning"
  | "search"
  | "subagent"
  | "tool"
  | "generic";
