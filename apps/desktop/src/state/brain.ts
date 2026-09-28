import { create } from "zustand";

import { exportConventions, request, revealPath } from "@/ipc/client";
import type {
  BrainAnswer,
  BrainGraph,
  BrainJob,
  BrainJobKind,
  BrainOverview,
  BrainQuery,
  EventEnvelope,
  Node,
  NodeFilter,
} from "@/ipc/generated";
import { toast } from "@/state/toasts";

/** The Personal Brain's key in the Brain tab's picker; a project's Brain uses the project id. */
export const PERSONAL = "personal";

/** The daemon's `projectId` for a picker key. */
export function projectOf(key: string): string | null {
  return key === PERSONAL ? null : key;
}

type BrainState = {
  /** The Brain the Inspector's Brain tab shows; `null` until the user picks one. */
  selected: string | null;
  /** Overviews read so far, by picker key, kept live by Brain job events. */
  overviews: Record<string, BrainOverview>;
};

export const useBrain = create<BrainState>()(() => ({ selected: null, overviews: {} }));

export function selectBrain(key: string): void {
  useBrain.setState({ selected: key });
}

export async function loadBrain(key: string): Promise<BrainOverview> {
  const { overview } = await request({ method: "getBrain", projectId: projectOf(key) });
  useBrain.setState((state) => ({ overviews: { ...state.overviews, [key]: overview } }));
  return overview;
}

function upsertJob(jobs: readonly BrainJob[], job: BrainJob): BrainJob[] {
  const others = jobs.filter((existing) => existing.id !== job.id);
  return [job, ...others].toSorted((a, b) => b.startedAtMs - a.startedAtMs);
}

/** Folds Brain job updates into the overviews read so far (one update per batch). */
export function applyBrainEvents(envelopes: readonly EventEnvelope[]): void {
  const jobs = envelopes.flatMap(({ event }) => (event.type === "brainJobUpdated" ? [event.job] : []));
  if (jobs.length === 0) return;
  useBrain.setState((state) => {
    let overviews = state.overviews;
    for (const job of jobs) {
      const overview = overviews[job.projectId];
      if (!overview) continue;
      overviews = { ...overviews, [job.projectId]: { ...overview, jobs: upsertJob(overview.jobs, job) } };
    }
    return overviews === state.overviews ? state : { overviews };
  });
}

export async function queryBrain(key: string, query: BrainQuery): Promise<BrainAnswer> {
  const { answer } = await request({ method: "queryBrain", projectId: projectOf(key), query });
  return answer;
}

export async function getBrainGraph(key: string, filter: NodeFilter): Promise<BrainGraph> {
  const { graph } = await request({ method: "getBrainGraph", projectId: projectOf(key), filter });
  return graph;
}

export async function runBrainJob(projectId: string, kind: BrainJobKind): Promise<string> {
  const { jobId } = await request({ method: "runBrainJob", projectId, kind });
  return jobId;
}

export async function rebuildIndex(projectId: string): Promise<void> {
  await request({ method: "rebuildIndex", projectId });
}

/** The Personal Brain's memories (preferences), newest first. */
export async function listMemories(): Promise<Node[]> {
  const { memories } = await request({ method: "listMemories" });
  return memories;
}

export async function forgetMemory(nodeId: string): Promise<void> {
  await request({ method: "forgetMemory", nodeId });
}

/**
 * "Export conventions to AGENTS.md…": the save panel starts in the project's repository; the
 * outcome (or the error) shows in a toast.
 */
export async function exportProjectConventions(
  projectId: string,
  repo: string | null,
): Promise<void> {
  try {
    const written = await exportConventions(projectId, repo);
    if (!written) return;
    const count = `${written.conventions} ${written.conventions === 1 ? "convention" : "conventions"}`;
    toast(`${written.created ? "Created" : "Updated"} ${written.path} with ${count}`, {
      actions: [{ label: "Show", run: () => void revealPath(written.path).catch(() => {}) }],
    });
  } catch (cause) {
    toast(`Couldn't export conventions: ${cause instanceof Error ? cause.message : String(cause)}`, {
      tone: "error",
    });
  }
}
