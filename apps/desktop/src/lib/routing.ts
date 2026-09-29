import type { ModelGroup } from "@/components/assistant-ui/elements/model-selector";
import type {
  Area,
  Attempt,
  Heat,
  LimitHit,
  ModelChoice,
  OverrideEffect,
  OverrideRule,
  OverrideTarget,
  Project,
  ProviderKind,
  ProviderOverview,
  QualityTier,
  QuotaWindow,
  TaskCategory,
} from "@/ipc/generated";
import { formatTime } from "@/lib/format";
import { modelName } from "@/lib/setup";

/**
 * Routing in words: the names the Usage page, worker cards, Settings → Routing and the
 * Inspector's preview share, and the sentences they build (hand-offs, rules, reset times).
 */

/** Vendors as sentences name them ("Claude opus hit its 5-hour limit"). */
export const VENDOR_LABELS: Record<ProviderKind, string> = {
  claude: "Claude",
  codex: "Codex",
};

export const PROVIDERS: readonly ProviderKind[] = ["claude", "codex"];

export const CATEGORIES: readonly TaskCategory[] = [
  "scout",
  "research",
  "implement",
  "review",
  "merge",
  "verify",
  "chat",
  "orchestrate",
];

/** What a category is, as "for …" reads it ("never use X for implementation"). */
export const CATEGORY_LABELS: Record<TaskCategory, string> = {
  scout: "scouting",
  research: "research",
  implement: "implementation",
  review: "review",
  merge: "merging",
  verify: "verification",
  chat: "chat",
  orchestrate: "orchestration",
};

export const AREAS: readonly Area[] = ["frontend", "backend", "infra", "docs", "tests"];

export const AREA_LABELS: Record<Area, string> = {
  frontend: "frontend",
  backend: "backend",
  infra: "infra",
  docs: "docs",
  tests: "tests",
};

export const TIER_LABELS: Record<QualityTier, string> = {
  unrated: "Unrated",
  light: "Light",
  standard: "Standard",
  strong: "Strong",
  frontier: "Frontier",
};

export const HEAT_LABELS: Record<Heat, string> = {
  cool: "Cool",
  warm: "Warm",
  hot: "Hot",
  limited: "Limit reached",
};

/** Text and fill tones for a heat: status colors, always beside a label. */
export const HEAT_TONES: Record<Heat, { text: string; fill: string; stroke: string }> = {
  cool: { text: "text-muted-foreground", fill: "bg-muted-foreground/60", stroke: "stroke-muted-foreground" },
  warm: { text: "text-foreground", fill: "bg-foreground/70", stroke: "stroke-foreground" },
  hot: { text: "text-warning", fill: "bg-warning", stroke: "stroke-warning" },
  limited: { text: "text-destructive", fill: "bg-destructive", stroke: "stroke-destructive" },
};

/** "Claude Opus 5.5": a model with its vendor, from the live lists (the raw id when unknown). */
export function choiceName(groups: readonly ModelGroup[], choice: ModelChoice): string {
  return `${VENDOR_LABELS[choice.provider]} ${modelName(groups, choice)}`;
}

/** A window's usual names, for ids the quota snapshot in hand doesn't list. */
const WINDOW_NAMES: Record<string, string> = {
  five_hour: "5-hour",
  seven_day: "weekly",
};

/**
 * What a window is called in a sentence ("5-hour", "weekly"): its label in the provider's last
 * snapshot, else a known id's name, else the id.
 */
export function windowName(
  providers: readonly ProviderOverview[] | undefined,
  provider: ProviderKind,
  windowId: string,
): string {
  const overview = providers?.find((entry) => entry.provider === provider);
  const window =
    overview?.usage?.windows.find((state) => state.window.id === windowId)?.window ??
    overview?.quota?.windows.find((entry) => entry.id === windowId);
  const label = window?.label ?? WINDOW_NAMES[windowId] ?? windowId.replaceAll("_", " ");
  return label === "Weekly" ? "weekly" : label;
}

/** What a window is scoped to, if anything ("Opus only", "gpt-reserve bucket"). */
export function windowScope(window: QuotaWindow): string | null {
  const parts = [
    window.model ? `${window.model} only` : null,
    window.bucket ? `${window.bucket} bucket` : null,
  ].filter((part) => part !== null);
  return parts.length > 0 ? parts.join(" · ") : null;
}

/** Shortest window first; windows of unknown length last. */
export function byLength(a: QuotaWindow, b: QuotaWindow): number {
  return (
    (a.windowMinutes ?? Number.MAX_SAFE_INTEGER) - (b.windowMinutes ?? Number.MAX_SAFE_INTEGER)
  );
}

const weekdayTime = new Intl.DateTimeFormat(undefined, {
  weekday: "short",
  hour: "numeric",
  minute: "2-digit",
});
const dateTime = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" });

/** When something lifts: "21:10" today, "Thu 09:00" within the week, a date beyond. */
export function formatResetAt(ms: number, nowMs: number): string {
  const day = new Date(ms).setHours(0, 0, 0, 0);
  const today = new Date(nowMs).setHours(0, 0, 0, 0);
  const days = Math.round((day - today) / 86_400_000);
  if (days === 0) return formatTime(ms);
  if (days > 0 && days < 7) return weekdayTime.format(ms);
  return dateTime.format(ms);
}

/** "hit its 5-hour limit (resets 21:10)", "hit its spend limit", "ran out of credits". */
export function limitPhrase(
  limit: LimitHit,
  provider: ProviderKind,
  providers: readonly ProviderOverview[] | undefined,
  nowMs: number,
): string {
  const resets = limit.resetsAtMs !== null ? ` (resets ${formatResetAt(limit.resetsAtMs, nowMs)})` : "";
  switch (limit.kind) {
    case "usageWindow":
      return limit.window
        ? `hit its ${windowName(providers, provider, limit.window)} limit${resets}`
        : `hit a usage limit${resets}`;
    case "spendControl":
      return `hit its spend limit${resets}`;
    case "credits":
      return `ran out of credits${resets}`;
  }
}

/**
 * One hand-off as the card says it: "Claude Opus 5.5 hit its 5-hour limit (resets 21:10) →
 * Codex gpt-6-sol". `next` is the attempt that took over.
 */
export function handoffLine(
  attempt: Attempt,
  next: Attempt,
  groups: readonly ModelGroup[],
  providers: readonly ProviderOverview[] | undefined,
  nowMs: number,
): string {
  const from = choiceName(groups, attempt.route.choice);
  const to = choiceName(groups, next.route.choice);
  const end = attempt.end;
  if (!end) return `${from} → ${to}`;
  const why =
    end.type === "limit"
      ? limitPhrase(end.limit, attempt.route.choice.provider, providers, nowMs)
      : `failed (${end.message})`;
  return `${from} ${why} → ${to}`;
}

/** The hand-offs of a task's attempts, oldest first. */
export function handoffs(attempts: readonly Attempt[]): Array<[Attempt, Attempt]> {
  return attempts.slice(1).map((next, index) => [attempts[index] as Attempt, next]);
}

// ----- rules -----------------------------------------------------------------------------

const EFFECT_WORDS: Record<OverrideEffect, string> = {
  never: "Never use",
  prefer: "Prefer",
  only: "Only use",
};

export const EFFECT_LABELS: Record<OverrideEffect, string> = {
  never: "Never",
  prefer: "Prefer",
  only: "Only",
};

/** "Codex", "Claude opus models", "Codex gpt-6-luna". */
export function targetName(target: OverrideTarget, groups: readonly ModelGroup[]): string {
  switch (target.type) {
    case "vendor":
      return VENDOR_LABELS[target.provider];
    case "family":
      return `${VENDOR_LABELS[target.provider]} ${target.family} models`;
    case "model":
      return choiceName(groups, { provider: target.provider, model: target.id, effort: null });
  }
}

/** "a, b and c". */
export function joinWords(words: readonly string[], last = "and"): string {
  if (words.length <= 1) return words.join("");
  return `${words.slice(0, -1).join(", ")} ${last} ${words.at(-1)}`;
}

/**
 * A rule as a sentence: "Never use Codex gpt-6-luna for frontend in brigadier-ai", "Prefer
 * Claude for review or merging", "Only use Codex for backend implementation".
 */
export function ruleSentence(
  rule: OverrideRule,
  groups: readonly ModelGroup[],
  projects: Record<string, Project>,
): string {
  const categories = rule.categories.map((category) => CATEGORY_LABELS[category]);
  const areas = rule.areas.map((area) => AREA_LABELS[area]);
  let scope = "";
  if (categories.length > 0 && areas.length > 0) {
    scope = ` for ${joinWords(areas, "or")} ${joinWords(categories, "or")}`;
  } else if (categories.length > 0) {
    scope = ` for ${joinWords(categories, "or")}`;
  } else if (areas.length > 0) {
    scope = ` for ${joinWords(areas, "or")}`;
  }
  const where = rule.projectId
    ? ` in ${projects[rule.projectId]?.name ?? "a removed project"}`
    : "";
  return `${EFFECT_WORDS[rule.effect]} ${targetName(rule.target, groups)}${scope}${where}`;
}

/** Whether two targets name the same thing. */
export function sameTarget(a: OverrideTarget, b: OverrideTarget): boolean {
  if (a.type !== b.type || a.provider !== b.provider) return false;
  if (a.type === "family" && b.type === "family") return a.family === b.family;
  if (a.type === "model" && b.type === "model") return a.id === b.id;
  return true;
}

/** A new rule's id. */
export function newRuleId(): string {
  return crypto.randomUUID();
}

/** "+1.5", "−2", "0": a score contribution with its sign. */
export function formatDelta(delta: number): string {
  const rounded = Math.round(delta * 10) / 10;
  if (rounded === 0) return "0";
  return rounded > 0 ? `+${rounded}` : `−${Math.abs(rounded)}`;
}

/** A score, to one decimal. */
export function formatScore(score: number): string {
  return (Math.round(score * 10) / 10).toString();
}
