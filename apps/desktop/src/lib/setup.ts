import { useEffect, useMemo } from "react";

import { PROVIDER_LABELS } from "@/app/inspector/providers/shared";
import type { ModelGroup } from "@/components/assistant-ui/elements/model-selector";
import type {
  Environment,
  ModelChoice,
  PermissionLevel,
  Project,
  ProviderOverview,
  Settings,
} from "@/ipc/generated";
import { loadProviders } from "@/state/actions";
import { useApp } from "@/state/store";

export const PERMISSION_LEVELS: readonly PermissionLevel[] = [
  "askForApproval",
  "approveForMe",
  "fullAccess",
];

export const PERMISSION_LABELS: Record<PermissionLevel, string> = {
  askForApproval: "Ask for approval",
  approveForMe: "Approve for me",
  fullAccess: "Full access",
};

export const PERMISSION_DETAILS: Record<PermissionLevel, string> = {
  askForApproval: "You approve every plan and every change. Sandboxed.",
  approveForMe:
    "Brigadier approves on your behalf and stops only for questions only you can answer. Sandboxed.",
  fullAccess: "Approve for me without the OS sandbox.",
};

/** Outward actions (push, deploy, publish, credentials) ask at every level. */
export const ALWAYS_ASK_NOTE = "Pushes, deploys and other outward actions always ask.";

function unavailable(overview: ProviderOverview): string | null {
  const status = overview.status;
  if (!status) return null;
  if (!status.path) return "not installed";
  if (!status.loggedIn) return "not logged in";
  return null;
}

function groupsOf(providers: readonly ProviderOverview[]): ModelGroup[] {
  return providers.map((overview) => ({
    provider: overview.provider,
    label: PROVIDER_LABELS[overview.provider],
    models: overview.models?.models ?? [],
    unavailable: unavailable(overview),
  }));
}

const NO_GROUPS: ModelGroup[] = [];

/** The live model lists of the installed CLIs, loaded on first use. */
export function useModelGroups(): ModelGroup[] {
  const providers = useApp((s) => s.providers.view?.providers);
  const connected = useApp((s) => s.connection.status === "connected");
  useEffect(() => {
    if (providers || !connected) return;
    void loadProviders().catch((error: unknown) => console.error("loading providers failed", error));
  }, [providers, connected]);
  return useMemo(() => (providers ? groupsOf(providers) : NO_GROUPS), [providers]);
}

/** The first ready provider's default model: the last step of the resolution order. */
export function builtInDefault(groups: readonly ModelGroup[]): ModelChoice {
  const ready = groups.find((group) => group.unavailable === null && group.models.length > 0);
  const model = ready?.models.find((entry) => entry.isDefault) ?? ready?.models[0];
  if (!ready || !model) return { provider: "claude", model: null, effort: null };
  return { provider: ready.provider, model: model.id, effort: model.defaultEffort };
}

/**
 * The model a new conversation starts with: the session choice, then the project's remembered
 * choice, then the global default in Settings (a Chat's own default first), then the first
 * ready provider's default.
 */
export function resolveModel(
  explicit: ModelChoice | null,
  kind: "session" | "chat",
  project: Project | null,
  settings: Settings,
  groups: readonly ModelGroup[],
): ModelChoice {
  return (
    explicit ??
    (kind === "session" ? project?.prefs.orchestrator : settings.defaultChatModel) ??
    settings.defaultOrchestrator ??
    builtInDefault(groups)
  );
}

/** The permission level: the session choice, the project's remembered one, the default. */
export function resolvePermission(
  explicit: PermissionLevel | null,
  project: Project | null,
  settings: Settings,
): PermissionLevel {
  return explicit ?? project?.prefs.permission ?? settings.defaultPermission;
}

/** "Local checkout · main" or "New worktree · brigadier/x from main". */
export function environmentLabel(environment: Environment): string {
  return environment.type === "localCheckout"
    ? `Local checkout · ${environment.branch}`
    : `New worktree · ${environment.branch} from ${environment.base}`;
}

/** "Opus 5.5" for a choice, from the live lists (the raw id when unknown). */
export function modelName(groups: readonly ModelGroup[], choice: ModelChoice): string {
  const group = groups.find((entry) => entry.provider === choice.provider);
  const model = group?.models.find((entry) =>
    choice.model === null ? entry.isDefault : entry.id === choice.model,
  );
  return model?.displayName ?? choice.model ?? `${PROVIDER_LABELS[choice.provider]} default`;
}

export function sameModel(a: ModelChoice, b: ModelChoice): boolean {
  return a.provider === b.provider && a.model === b.model;
}
