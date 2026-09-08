import type { GitStatus, WorkspaceContext } from "../workspaceApi";

/** The VS Code workbench is shared; a binding always identifies one concrete workspace. */
export interface PanelBinding {
  context: WorkspaceContext;
  root: string;
  mode: "search";
  status: GitStatus | null;
  revision: number;
  openPaths: string[];
  refresh(): void;
  onOpen(
    path: string,
    kind: "file" | "diff",
    staged?: boolean,
    line?: number,
  ): void;
  onError(message: string): void;
}

export const bindingKey = (binding: Pick<PanelBinding, "context">) =>
  JSON.stringify([binding.context.projectId, binding.context.sessionId]);
