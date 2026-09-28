import {
  ArrowRight,
  Check,
  CheckCircleFilled,
  ExclamationMarkCircle,
  FolderPlus,
  Reload,
} from "@openai/apps-sdk-ui/components/Icon";
import { Checkbox as CheckboxPrimitive } from "radix-ui";
import {
  lazy,
  type ReactNode,
  Suspense,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";

import { useAction } from "@/app/conversation/useAction";
import { errorText } from "@/app/dialogs/fields";
import { PROVIDER_LABELS } from "@/app/inspector/providers/shared";
import { BrigadierGlyph } from "@/components/glyphs/brand-glyph";
import { ProviderGlyph } from "@/components/glyphs/provider-glyphs";
import { Spinner } from "@/components/glyphs/spinner";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { pickFolder } from "@/ipc/client";
import type { ProjectCandidate, ProviderKind, ProviderOverview } from "@/ipc/generated";
import { formatAgo } from "@/lib/format";
import { cn } from "@/lib/utils";
import {
  createProject,
  getRepoInfo,
  loadProviders,
  refreshProviders,
  select,
} from "@/state/actions";
import {
  closeSetupTerminal,
  findProjects,
  finishOnboarding,
  openSetupTerminal,
  useOnboarding,
} from "@/state/onboarding";
import { useApp } from "@/state/store";

// The terminal (xterm) loads only when an agent needs installing or signing in.
const TerminalView = lazy(() =>
  import("@/app/conversation/TerminalTab").then((module) => ({ default: module.TerminalView })),
);

const PROVIDERS: readonly ProviderKind[] = ["claude", "codex"];

/** Suggested (preselected) projects: worked in at least this often within the last month. */
const SUGGESTED_SESSIONS = 3;
const SUGGESTED_WITHIN_MS = 30 * 86_400_000;

/** How often an agent is checked again while its install or sign-in terminal is open. */
const RECHECK_MS = 3000;

type Step = "agents" | "projects";

/**
 * The first-run setup: the coding agents Brigadier works through, then the projects to start
 * with, found in those agents' own session history. Shown until finished or skipped once;
 * Settings can open it again.
 */
export function OnboardingDialog() {
  const catalogLoaded = useApp((s) => s.catalogLoaded);
  const onboarded = useApp((s) => s.settings.onboarded);
  const smoke = useApp((s) => s.info?.smoke ?? false);
  const reopened = useOnboarding((s) => s.reopened);
  const open = catalogLoaded && !smoke && (!onboarded || reopened);
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) void finishOnboarding().catch((error: unknown) => console.error(error));
      }}
    >
      <DialogContent
        showCloseButton={false}
        className="max-w-setup max-h-full grid-cols-1 gap-0 overflow-hidden p-0"
        onInteractOutside={(event) => event.preventDefault()}
      >
        {open && <Onboarding />}
      </DialogContent>
    </Dialog>
  );
}

function Onboarding() {
  const [step, setStep] = useState<Step>("agents");
  const [reached, setReached] = useState<Step>("agents");
  const go = (next: Step) => {
    setStep(next);
    if (next === "projects") setReached("projects");
  };
  return (
    <div className="flex max-h-full min-h-0 min-w-0 flex-col">
      <header className="flex flex-col gap-4 border-b px-6 pt-6 pb-4">
        <div className="flex items-center gap-2">
          <BrigadierGlyph className="text-foreground size-icon-lg" />
          <span className="font-display text-base font-semibold">Brigadier</span>
        </div>
        <Stepper step={step} reached={reached} onStep={go} />
      </header>
      {step === "agents" ? (
        <AgentsStep onContinue={() => go("projects")} />
      ) : (
        <ProjectsStep />
      )}
    </div>
  );
}

const STEPS: readonly { step: Step; label: string }[] = [
  { step: "agents", label: "Agents" },
  { step: "projects", label: "Projects" },
];

function Stepper({
  step,
  reached,
  onStep,
}: {
  step: Step;
  reached: Step;
  onStep: (step: Step) => void;
}) {
  const current = STEPS.findIndex((entry) => entry.step === step);
  const furthest = STEPS.findIndex((entry) => entry.step === reached);
  return (
    <nav aria-label="Setup steps" className="bg-muted/40 rounded-capsule grid grid-cols-2 gap-1 p-1">
      {STEPS.map((entry, index) => {
        const active = index === current;
        const done = index < current;
        return (
          <button
            key={entry.step}
            type="button"
            aria-current={active ? "step" : undefined}
            disabled={index > furthest}
            onClick={() => onStep(entry.step)}
            className={cn(
              "rounded-capsule h-control-md flex items-center gap-2 px-3 text-sm transition-colors outline-none focus-visible:ring-1 focus-visible:ring-ring/50",
              active ? "bg-accent text-foreground" : "text-muted-foreground hover:text-foreground",
              "disabled:hover:text-muted-foreground disabled:cursor-default",
            )}
          >
            <span
              className={cn(
                "flex size-icon-lg shrink-0 items-center justify-center rounded-full text-xs",
                done ? "bg-primary text-primary-foreground" : "border",
                active && "border-foreground/40",
              )}
            >
              {done ? <Check className="size-icon-xs" /> : index + 1}
            </span>
            {entry.label}
          </button>
        );
      })}
    </nav>
  );
}

function StepBody({
  title,
  description,
  children,
  footer,
}: {
  title: string;
  description: string;
  children: ReactNode;
  footer: ReactNode;
}) {
  return (
    <>
      <div className="flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto px-6 pt-6 pb-2">
        <div className="flex flex-col gap-1.5">
          <DialogTitle className="text-xl leading-tight font-semibold">{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </div>
        {children}
      </div>
      <footer className="flex flex-wrap items-center justify-end gap-2 px-6 pt-4 pb-6">
        {footer}
      </footer>
    </>
  );
}

// ----- agents --------------------------------------------------------------------------

type AgentState = "checking" | "install" | "signIn" | "ready";

function agentState(overview: ProviderOverview | undefined): AgentState {
  const status = overview?.status;
  if (!status) return "checking";
  if (!status.path) return "install";
  return status.loggedIn ? "ready" : "signIn";
}

function agentDetail(overview: ProviderOverview | undefined): string {
  const status = overview?.status;
  if (!status) return "Checking…";
  if (!status.path) return "Not installed";
  if (!status.loggedIn) return "Not signed in";
  const method = status.authMethod ? `Signed in with ${status.authMethod}` : "Signed in";
  const plan = status.plan ? ` · ${status.plan.charAt(0).toUpperCase()}${status.plan.slice(1)} plan` : "";
  return method + plan;
}

/** Checks every agent again; results arrive as events. */
async function checkAgents(): Promise<void> {
  try {
    // Events for a check apply only once the providers' view is loaded.
    if (!useApp.getState().providers.view) await loadProviders();
    await refreshProviders();
  } catch (error) {
    console.error("checking the agents failed", error);
  }
}

function AgentsStep({ onContinue }: { onContinue: () => void }) {
  const providers = useApp((s) => s.providers.view?.providers);
  const connected = useApp((s) => s.connection.status === "connected");
  // The agent being installed or signed in, and its state when that began.
  const [setup, setSetup] = useState<{
    provider: ProviderKind;
    install: boolean;
    from: AgentState;
  } | null>(null);
  const recheck = useAction();

  useEffect(() => {
    if (connected) void checkAgents();
  }, [connected]);

  const overviews = PROVIDERS.map((provider) => ({
    provider,
    overview: providers?.find((entry) => entry.provider === provider),
  }));
  const states = overviews.map(({ overview }) => agentState(overview));
  const anyReady = states.includes("ready");
  // Its terminal closes by itself once the agent's state moves on (installed, signed in).
  const settingUp = setup && states[PROVIDERS.indexOf(setup.provider)] === setup.from ? setup : null;
  const allChecked = !states.includes("checking");

  return (
    <StepBody
      title="Your agents"
      description="Brigadier gets its work done through the coding agents on this computer, with your own subscriptions."
      footer={
        <>
          {!anyReady && allChecked && (
            <Button variant="ghost" disabled={recheck.busy} onClick={() => recheck.run(checkAgents)}>
              <Reload />
              Check again
            </Button>
          )}
          <Button autoFocus onClick={onContinue}>
            Continue
            <ArrowRight />
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <ul className="bg-muted/30 rounded-surface divide-y border">
          {overviews.map(({ provider, overview }, index) => (
            <AgentRow
              key={provider}
              provider={provider}
              state={states[index] ?? "checking"}
              detail={agentDetail(overview)}
              settingUp={settingUp?.provider === provider}
              onSetUp={(install) =>
                setSetup({ provider, install, from: install ? "install" : "signIn" })
              }
            />
          ))}
        </ul>
        {settingUp && (
          <SetupTerminal
            key={`${settingUp.provider}:${settingUp.install}`}
            provider={settingUp.provider}
            install={settingUp.install}
            onClose={() => {
              setSetup(null);
              void checkAgents();
            }}
          />
        )}
        {!anyReady && allChecked && !settingUp && (
          <p className="text-muted-foreground text-xs">
            Sessions need at least one agent that is signed in. You can also set this up later.
          </p>
        )}
      </div>
    </StepBody>
  );
}

function AgentRow({
  provider,
  state,
  detail,
  settingUp,
  onSetUp,
}: {
  provider: ProviderKind;
  state: AgentState;
  detail: string;
  settingUp: boolean;
  onSetUp: (install: boolean) => void;
}) {
  return (
    <li className="flex items-center gap-3 px-4 py-3">
      <ProviderGlyph provider={provider} className="size-icon-lg shrink-0" />
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium">{PROVIDER_LABELS[provider]}</p>
        <p className="text-muted-foreground truncate text-xs">{detail}</p>
      </div>
      {state === "ready" ? (
        <span className="text-success inline-flex items-center gap-1.5 text-xs font-medium">
          <CheckCircleFilled className="size-icon-sm" />
          Ready
        </span>
      ) : state === "checking" ? (
        <Spinner className="text-muted-foreground size-icon-sm animate-spin" />
      ) : (
        <Button
          size="sm"
          variant="outline"
          disabled={settingUp}
          onClick={() => onSetUp(state === "install")}
        >
          {state === "install" ? "Install" : "Sign in"}
        </Button>
      )}
    </li>
  );
}

/** After its command succeeds, how long an agent may take to show as set up before we say so. */
const SETTLE_MS = 10_000;

/**
 * Runs the agent's installer or sign-in. Its output stays folded away unless asked for, or
 * the command fails; the row closes by itself once the agent is set up.
 */
function SetupTerminal({
  provider,
  install,
  onClose,
}: {
  provider: ProviderKind;
  install: boolean;
  onClose: () => void;
}) {
  const terminalId = useRef<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  // Absent while the command runs; then its exit code.
  const [exit, setExit] = useState<{ code: number | null } | null>(null);
  const [stuck, setStuck] = useState(false);
  // Absent: the output shows only when the command failed.
  const [shown, setShown] = useState<boolean | null>(null);

  const open = useCallback(
    async (cols: number, rows: number) => {
      const terminal = await openSetupTerminal(provider, install, cols, rows);
      terminalId.current = terminal.id;
      return terminal;
    },
    [provider, install],
  );
  const onExit = useCallback(
    (code: number | null) => {
      terminalId.current = null;
      setExit({ code });
      void refreshProviders(provider).catch(() => {});
    },
    [provider],
  );

  // Notices the sign-in (or install) soon after it finishes.
  useEffect(() => {
    const timer = window.setInterval(() => {
      void refreshProviders(provider).catch(() => {});
    }, RECHECK_MS);
    return () => window.clearInterval(timer);
  }, [provider]);
  // Succeeded, but the agent still isn't set up a while later: the output may say why.
  useEffect(() => {
    if (exit?.code !== 0) return;
    const timer = window.setTimeout(() => setStuck(true), SETTLE_MS);
    return () => window.clearTimeout(timer);
  }, [exit]);
  // Leaving the step (or the dialog) stops the command.
  useEffect(
    () => () => {
      if (terminalId.current) closeSetupTerminal(terminalId.current);
    },
    [],
  );

  const label = PROVIDER_LABELS[provider];
  const failed = exit !== null && exit.code !== 0;
  const expanded = shown ?? (failed || stuck);
  const status =
    exit === null
      ? install
        ? `Installing ${label}…`
        : `Finish signing in to ${label} in your browser…`
      : failed
        ? `${install ? `${label} could not be installed` : `Signing in to ${label} failed`}${exit.code === null ? "" : ` (exit code ${exit.code})`}.`
        : stuck
          ? `${label} still isn't ready. The output may say why.`
          : `Checking ${label}…`;

  const cancel = () => {
    if (terminalId.current) closeSetupTerminal(terminalId.current);
    terminalId.current = null;
    onClose();
  };
  const retry = () => {
    setAttempt((current) => current + 1);
    setExit(null);
    setStuck(false);
    setShown(null);
  };

  return (
    <div className="rounded-surface min-w-0 overflow-hidden border">
      <div className="bg-muted/30 flex items-center gap-2 px-3 py-2">
        {failed || stuck ? (
          <ExclamationMarkCircle className="text-destructive size-icon-sm shrink-0" />
        ) : (
          <Spinner className="text-muted-foreground size-icon-sm shrink-0 animate-spin" />
        )}
        <span role="status" className="text-muted-foreground min-w-0 flex-1 truncate text-xs">
          {status}
        </span>
        <Button size="xs" variant="ghost" onClick={() => setShown(!expanded)}>
          {expanded ? "Hide output" : "Show output"}
        </Button>
        {(failed || stuck) && (
          <Button size="xs" variant="ghost" onClick={retry}>
            Try again
          </Button>
        )}
        <Button size="xs" variant="ghost" onClick={cancel}>
          {exit === null ? "Cancel" : "Close"}
        </Button>
      </div>
      {/* Folded, the terminal keeps its size (so the CLI's output wraps as it would) but no height. */}
      <div className={expanded ? "border-t" : "h-0 overflow-hidden"}>
        <Suspense fallback={null}>
          <TerminalView
            key={attempt}
            open={open}
            onExit={onExit}
            focus={false}
            className="h-64 flex-none"
          />
        </Suspense>
      </div>
    </div>
  );
}

// ----- projects ------------------------------------------------------------------------

function suggested(candidate: ProjectCandidate, nowMs: number): boolean {
  return (
    candidate.projectId === null &&
    candidate.sessions >= SUGGESTED_SESSIONS &&
    nowMs - candidate.lastActiveMs <= SUGGESTED_WITHIN_MS
  );
}

/** A home-relative path for display (`~/Development/app`). */
function shortPath(path: string): string {
  return path.replace(/^(\/Users|\/home)\/[^/]+(?=\/|$)/, "~");
}

function ProjectsStep() {
  const [candidates, setCandidates] = useState<ProjectCandidate[] | null>(null);
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [nowMs] = useState(Date.now);

  useEffect(() => {
    let live = true;
    findProjects()
      .then((found) => {
        if (!live) return;
        setCandidates(found);
        setSelected(new Set(found.filter((c) => suggested(c, nowMs)).map((c) => c.path)));
      })
      .catch((cause: unknown) => {
        if (!live) return;
        setCandidates([]);
        setError(errorText(cause));
      });
    return () => {
      live = false;
    };
  }, [nowMs]);

  const addable = (candidates ?? []).filter((candidate) => candidate.projectId === null);
  const chosen = addable.filter((candidate) => selected.has(candidate.path));

  const toggle = (path: string, on: boolean) =>
    setSelected((current) => {
      const next = new Set(current);
      if (on) next.add(path);
      else next.delete(path);
      return next;
    });

  const addFolder = async () => {
    setError(null);
    try {
      const picked = await pickFolder();
      if (!picked) return;
      const repo = await getRepoInfo(picked);
      const project = Object.values(useApp.getState().projects).find((entry) =>
        entry.repos.some((r) => r.path === repo.path),
      );
      setCandidates((current) => {
        const list = current ?? [];
        if (list.some((candidate) => candidate.path === repo.path)) return list;
        return [
          {
            path: repo.path,
            name: repo.name,
            providers: [],
            sessions: 0,
            lastActiveMs: 0,
            projectId: project?.id ?? null,
          },
          ...list,
        ];
      });
      if (!project) toggle(repo.path, true);
    } catch (cause) {
      setError(errorText(cause));
    }
  };

  const add = async () => {
    setBusy(true);
    setError(null);
    const failed: string[] = [];
    let first: string | null = null;
    for (const candidate of chosen) {
      try {
        const project = await createProject("", candidate.path);
        first ??= project.id;
        setCandidates((current) =>
          (current ?? []).map((entry) =>
            entry.path === candidate.path ? { ...entry, projectId: project.id } : entry,
          ),
        );
      } catch (cause) {
        failed.push(`${candidate.name}: ${errorText(cause)}`);
      }
    }
    setBusy(false);
    if (failed.length > 0) {
      setError(`Some projects could not be added.\n${failed.join("\n")}`);
      return;
    }
    if (first) select({ type: "draft", kind: "session", projectId: first });
    await finishOnboarding().catch((cause: unknown) => setError(errorText(cause)));
  };

  const count = chosen.length;
  return (
    <StepBody
      title="Choose your projects"
      description="These are the repositories you have worked in with Claude Code and Codex. Add the ones you want to use with Brigadier."
      footer={
        <>
          <Button
            variant="ghost"
            className="me-auto"
            disabled={busy}
            onClick={() => void addFolder()}
          >
            <FolderPlus />
            Add a folder…
          </Button>
          <Button
            variant="ghost"
            disabled={busy}
            onClick={() =>
              void finishOnboarding().catch((cause: unknown) => setError(errorText(cause)))
            }
          >
            Skip
          </Button>
          <Button autoFocus disabled={busy || count === 0} onClick={() => void add()}>
            {busy ? "Adding…" : `Add ${count} ${count === 1 ? "project" : "projects"}`}
          </Button>
        </>
      }
    >
      {candidates === null ? (
        <div className="text-muted-foreground flex flex-col items-center gap-3 py-10 text-sm">
          <Spinner className="size-icon-md animate-spin" />
          Looking for projects in your Claude Code and Codex history…
        </div>
      ) : candidates.length === 0 ? (
        <p className="text-muted-foreground bg-muted/30 rounded-surface border px-4 py-6 text-center text-sm">
          No repositories found in your Claude Code or Codex history. Add a folder to start
          with one.
        </p>
      ) : (
        <div className="flex min-h-0 flex-col gap-2">
          <div className="text-muted-foreground flex items-center gap-1 text-xs">
            <span role="status" className="flex-1">
              {count} of {addable.length} selected
            </span>
            <Button
              size="xs"
              variant="ghost"
              disabled={count === addable.length}
              onClick={() => setSelected(new Set(addable.map((c) => c.path)))}
            >
              Select all
            </Button>
            <Button
              size="xs"
              variant="ghost"
              disabled={count === 0}
              onClick={() => setSelected(new Set())}
            >
              Select none
            </Button>
          </div>
          <ul className="bg-muted/30 rounded-surface max-h-80 divide-y overflow-y-auto border">
            {candidates.map((candidate) => (
              <ProjectRow
                key={candidate.path}
                candidate={candidate}
                nowMs={nowMs}
                checked={candidate.projectId !== null || selected.has(candidate.path)}
                disabled={busy || candidate.projectId !== null}
                onCheckedChange={(on) => toggle(candidate.path, on)}
              />
            ))}
          </ul>
        </div>
      )}
      {error && (
        <p role="alert" className="text-destructive text-xs whitespace-pre-wrap">
          {error}
        </p>
      )}
    </StepBody>
  );
}

function ProjectRow({
  candidate,
  nowMs,
  checked,
  disabled,
  onCheckedChange,
}: {
  candidate: ProjectCandidate;
  nowMs: number;
  checked: boolean;
  disabled: boolean;
  onCheckedChange: (checked: boolean) => void;
}) {
  const id = `project-${candidate.path}`;
  const added = candidate.projectId !== null;
  const activity =
    candidate.sessions > 0
      ? `${candidate.sessions} ${candidate.sessions === 1 ? "session" : "sessions"} · ${formatAgo(candidate.lastActiveMs, nowMs)}`
      : null;
  return (
    <li>
      <label
        htmlFor={id}
        className={cn(
          "flex items-center gap-3 px-4 py-2.5",
          disabled ? "cursor-default" : "hover:bg-accent/40 cursor-pointer",
        )}
      >
        <CheckboxPrimitive.Root
          id={id}
          checked={checked}
          disabled={disabled}
          onCheckedChange={(state) => onCheckedChange(state === true)}
          className="border-input data-[state=checked]:bg-primary data-[state=checked]:border-primary data-[state=checked]:text-primary-foreground focus-visible:ring-ring/50 flex size-icon-md shrink-0 items-center justify-center rounded-xs border outline-none focus-visible:ring-1 disabled:opacity-60"
        >
          <CheckboxPrimitive.Indicator>
            <Check className="size-icon-xs" />
          </CheckboxPrimitive.Indicator>
        </CheckboxPrimitive.Root>
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium">{candidate.name}</p>
          <p className="text-muted-foreground truncate font-mono text-xs">
            {shortPath(candidate.path)}
          </p>
        </div>
        {candidate.providers.length > 0 && (
          <span className="flex shrink-0 items-center gap-1.5">
            {candidate.providers.map((provider) => (
              <span key={provider} title={PROVIDER_LABELS[provider]} className="flex">
                <ProviderGlyph provider={provider} className="size-icon-sm" />
                <span className="sr-only">{PROVIDER_LABELS[provider]}</span>
              </span>
            ))}
          </span>
        )}
        <span className="text-muted-foreground w-40 shrink-0 text-end text-xs whitespace-nowrap">
          {added ? "Added" : activity}
        </span>
      </label>
    </li>
  );
}
