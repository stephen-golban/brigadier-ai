import { invoke } from "@tauri-apps/api/core";
import { desktop, workspaceApi } from "./workspaceApi";
import { workbenchApi } from "./workbenchApi";

export interface ComposerWorktree {
  path: string;
  branch: string | null;
  activeTaskId: string | null;
  activeTaskTitle: string | null;
  available: boolean;
  reason: string | null;
}
export interface ComposerWorkspaceOptions {
  worktrees: ComposerWorktree[];
  branches: { name: string; remote: boolean }[];
  currentBranch: string | null;
  isGit: boolean;
}
export const composerWorkspaceApi = {
  options: async (projectId: string): Promise<ComposerWorkspaceOptions> => {
    if (desktop) return invoke("composer_workspace_options", { projectId });
    const scope = { projectId, sessionId: null };
    const [details, status] = await Promise.all([workbenchApi.gitDetails(scope), workspaceApi.git(scope)]);
    return {
      worktrees: [],
      branches: details.branches.map(name => ({ name, remote: !(details.localBranches ?? details.branches).includes(name) })),
      currentBranch: status.branch || null,
      isGit: !!status.branch,
    };
  },
};
