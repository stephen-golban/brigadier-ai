// SPDX-License-Identifier: Apache-2.0
/**
 * The competence table itself, compiled into the binary.
 *
 * Ruling 68 and ruling 26 together. Ruling 26 delivers a bare binary — a
 * Homebrew tap, a `curl | sh`, a plugin directory — and **a table that lives in
 * a repository the reader does not have is not auditable by them**. So the table
 * ships inside the artifact and `brigadier competence` prints it.
 *
 * Read the numbers below for what they are. **Not one row says `measured`, and
 * that is the honest state of this repository rather than an omission**: every
 * measurement here is of a capability, a latency or a payload shape, and none of
 * them is a measurement of how well an agent writes code. Decision 10 keeps this
 * table hand-maintained on purpose and ruling 66 made the seam mechanical — a
 * cost prediction is falsifiable by measurement, a competence score is
 * editorial, and the two may not import each other in either direction. **A
 * version of this table that looked mostly `measured` would be the warning
 * sign**, not the goal.
 *
 * Several rows are judgement resting on something this repository did measure.
 * Those declare BOTH inputs and render as `editorial`, because a row may not mix
 * classes and the weakest input governs — the same rule ruling 52 applies to
 * blocking outcomes.
 *
 * The tickets cited below (#3, #41, #42, #46, #47) were MEASURED against the
 * fleet `src/agent/profiles.ts` records — claude-agent-acp 0.69.0 (claude
 * 2.1.233), codex-acp 1.4.0 (codex-cli 0.147.0), copilot 1.0.80, qwen-code
 * 0.21.13, OpenCode 1.18.18 and gemini-cli 0.55.1 — on 2026-08-17, macOS 26.5.2
 * arm64. The ticket is the citation because it is the stable identity; the
 * version it was measured against lives in the launch profile, which is the one
 * place that can be re-measured and updated together.
 *
 * The model column says `default` on five of six agents, and that is measured
 * rather than lazy: #2 found that only Codex returns a model list at
 * `session/new`. On the others brigadier never learns which model answered, so
 * the routable unit is the agent and `default` means "whatever the operator
 * configured". Codex's own ids are deliberately absent — they are read from
 * `availableModels` and never constructed, so every one of them arrives
 * unranked, which is exactly the case ruling 68 says must stay eligible.
 */

import type { AgentId } from "../agent/profiles.ts";
import {
  citationProblems,
  governingClass,
  rank,
  renderRanked,
  type CompetenceRow,
  type EvidenceClass,
} from "./competence.ts";

/** The two roles a run routes for. Ruling 32 makes them differ by vendor. */
export type Role = "builder" | "reviewer";

export const ROLES: readonly Role[] = ["builder", "reviewer"];

export interface TableEntry {
  agent: AgentId;
  model: string;
  role: Role;
  /**
   * Absent means UNRANKED — eligible, sorted last, named, never excluded.
   *
   * Ruling 68's fail-open half, and it points the opposite way to ruling 53 ON
   * PURPOSE: **a capability is a permission and fails closed; a ranking is a
   * preference and fails open.** Refusing an unmeasured capability protects the
   * operator. Refusing an unranked model protects nobody and freezes the fleet
   * at whatever the table last heard of — v1's finding 87 is a model scored 85
   * silently excluded from every `hard` item. A refactor that "unified" the two
   * rules would break one of them.
   */
  score?: number;
  /** Every input to the score. `governingClass` reduces them to what renders. */
  inputs: readonly EvidenceClass[];
  /** A stable identity or, for `editorial`, a reason. Never a location. */
  citation: string;
}

export const TABLE: readonly TableEntry[] = [
  // ---- builder -----------------------------------------------------------
  {
    agent: "claude",
    model: "default",
    role: "builder",
    score: 80,
    inputs: ["editorial", "measured"],
    citation:
      "judgement, resting on #3's measurement that its bridge opens in bypassPermissions — a mixed row takes its weakest input, so this prints editorial rather than measured",
  },
  {
    agent: "codex",
    model: "default",
    role: "builder",
    score: 80,
    inputs: ["editorial", "measured"],
    citation:
      "judgement, resting on #41's measurement of a real OS sandbox in every mode — the sandbox is measured, the ranking is not, so the row is editorial",
  },
  {
    agent: "copilot",
    model: "default",
    role: "builder",
    score: 65,
    inputs: ["editorial"],
    citation:
      "judgement alone — no measurement of coding competence exists anywhere in this repository, and an editorial row cites a reason rather than a source",
  },
  {
    agent: "qwen",
    model: "default",
    role: "builder",
    score: 50,
    inputs: ["editorial", "measured"],
    citation:
      "judgement, resting on #47's measurement that compaction becomes a treadmill over threshold — about 15 percent recovered per turn while latency moves from 5.8 to 65.6 seconds",
  },
  {
    agent: "opencode",
    model: "default",
    role: "builder",
    inputs: ["editorial", "measured"],
    citation:
      "unranked on purpose — #42 measured it reaching a model with no credential at all through its own gateway, so which model answered is not knowable here and a score would be a score of nothing",
  },
  {
    agent: "gemini",
    model: "default",
    role: "builder",
    inputs: ["editorial", "measured"],
    citation:
      "unranked on purpose — #42 could not complete a session without an API key and could not establish a config root, so nothing here has ever driven it and decision 10 will not invent a number for a tool this repository has never run",
  },

  // ---- reviewer ----------------------------------------------------------
  {
    agent: "claude",
    model: "default",
    role: "reviewer",
    score: 80,
    inputs: ["editorial"],
    citation:
      "judgement alone — ruling 52 hands a reviewer an exact diff, and no measurement of what any agent does with one exists yet; item 5 of the bar is where that stops being judgement",
  },
  {
    agent: "codex",
    model: "default",
    role: "reviewer",
    score: 75,
    inputs: ["editorial"],
    citation:
      "judgement alone, against the same absence — v1's measured catch rate was 0 of 3, which is a fact about v1 and not about this ranking",
  },
  {
    agent: "copilot",
    model: "default",
    role: "reviewer",
    score: 60,
    inputs: ["editorial", "measured"],
    citation:
      "judgement, resting on #46's measured window of 128,000 tokens — that bounds how much diff it can be handed, which is a capacity fact rather than a competence one",
  },
  {
    agent: "qwen",
    model: "default",
    role: "reviewer",
    score: 45,
    inputs: ["editorial", "measured"],
    citation:
      "judgement, resting on #47's measurement that its usage counter plateaus while compacting — a reviewer whose context is quietly being dropped is reviewing something other than the diff it was handed",
  },
  {
    agent: "opencode",
    model: "default",
    role: "reviewer",
    inputs: ["editorial", "measured"],
    citation:
      "unranked for its builder row's reason (#42) — and note that ruling 32 needs the reviewer's VENDOR to differ, which being unranked does not prevent: it stays eligible and sorts last",
  },
  {
    agent: "gemini",
    model: "default",
    role: "reviewer",
    inputs: ["editorial", "measured"],
    citation: "unranked — never driven here (#42), so there is nothing to rank",
  },
];

/** `agent/model` for every entry carrying a score. Everything else is unranked. */
export const KNOWN: ReadonlySet<string> = new Set(
  TABLE.filter((entry) => entry.score !== undefined).map((entry) => `${entry.agent}/${entry.model}`),
);

/** A table entry as the thing that renders: the governing class, not the inputs. */
export function toRow(entry: TableEntry): CompetenceRow {
  return {
    agent: entry.agent,
    model: entry.model,
    role: entry.role,
    score: entry.score ?? 0,
    evidence: governingClass(entry.inputs),
    citation: entry.citation,
  };
}

export function rows(table: readonly TableEntry[] = TABLE): CompetenceRow[] {
  return table.map(toRow);
}

/**
 * Every citation problem in a table. Wired into `brigadier competence`, which
 * refuses to print a table it cannot vouch for rather than printing it with a
 * warning nobody reads.
 */
export function tableProblems(table: readonly TableEntry[] = TABLE): string[] {
  return rows(table).flatMap(citationProblems);
}

/**
 * Ruling 68's maintenance trigger, which is mechanical rather than a calendar:
 * **a cadence nobody enforces is a request.**
 *
 * Detection already reads model ids back from `session/new`, so brigadier can
 * report every id it saw that this table does not list — which is the moment a
 * maintainer learns the table needs a row, without anyone remembering to look.
 */
export function unlistedModels(
  agent: string,
  seen: readonly string[],
  table: readonly TableEntry[] = TABLE,
): string[] {
  const listed = new Set(table.map((entry) => `${entry.agent}/${entry.model}`));
  return [...new Set(seen)].filter((model) => !listed.has(`${agent}/${model}`));
}

/**
 * The whole printed table.
 *
 * Comment lines start with `#` so that a reader — or a check — can tell prose
 * from a row without a parser. Every row carries score, class and citation on
 * one physical row, per ruling 68: `claude: 90` in isolation tells a reader
 * nothing about whether it was measured or invented, and a qualifier in a
 * footnote is a qualifier nobody reads.
 */
export function renderCompetence(table: readonly TableEntry[] = TABLE): string[] {
  const all = rows(table);
  const counts = new Map<EvidenceClass, number>();
  for (const row of all) counts.set(row.evidence, (counts.get(row.evidence) ?? 0) + 1);
  const tally = (["measured", "benchmark", "vendor", "editorial"] as EvidenceClass[])
    .map((c) => `${counts.get(c) ?? 0} ${c}`)
    .join(", ");

  const out: string[] = [
    "# brigadier competence — the routing table, printed from inside the binary (ruling 68).",
    "# Ruling 26 ships a bare binary, and a table in a repository the reader does not have is not",
    "# auditable by them. This is that table, compiled in.",
    "#",
    "# Every row carries its score, its evidence class and its citation together. A row may not mix",
    "# classes: part measured and part judgement is editorial, because the weakest input governs.",
    "# Citations are stable IDENTITIES — a ticket, a benchmark with its version and read date, a URL",
    "# with a read date, or, for editorial, a reason. Never a location: v1's METHODOLOGY.md carried 44",
    "# file-and-number anchors and one comment-only sweep invalidated 8 while 4 were already wrong.",
    "#",
    `# ${all.length} rows — ${tally}.`,
    "# Decision 10 keeps this table hand-maintained on purpose, so a table that looked mostly measured",
    "# would be the warning sign rather than the goal.",
    "#",
    "# The model column reads `default` on five of six agents because #2 measured that only Codex",
    "# returns a model list at session/new. Codex's own ids are absent on purpose — they are read from",
    "# availableModels and never constructed, so every one of them arrives unranked.",
  ];

  for (const role of ROLES) {
    const forRole = rank(
      all.filter((row) => row.role === role),
      KNOWN,
    );
    out.push("", `# ${role}`);
    for (const row of forRole) out.push(renderRanked(row, KNOWN));
  }

  out.push(
    "",
    "# An unranked model is ELIGIBLE, sorts LAST, and is NAMED — never silently excluded. Ruling 68",
    "# points the opposite way to ruling 53 on purpose: a capability is a permission and fails CLOSED,",
    "# a ranking is a preference and fails OPEN. v1's finding 87 is a model scored 85 dropped silently",
    "# from every hard item, and a router that refuses what it has not heard of freezes the fleet.",
    "#",
    "# Maintenance is a mechanical trigger, not a calendar: `brigadier detect` reports every model id",
    "# it saw at session/new that this table does not list.",
  );
  return out;
}
