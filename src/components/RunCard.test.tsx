/**
 * Behavioural tests for `src/components/RunCard.tsx`.
 *
 * Same rule as `Feed.test.tsx` and `Sidebar.test.tsx`: **assert on text and roles, never on class
 * names.** A test bound to this markup dies with it and proves only that this markup once
 * existed.
 *
 * What is pinned here is the set of things a plausible-looking plan card gets silently wrong.
 * Each one is a decision in `docs/plans/ipc-contract.md` §"The run", and each failure mode is a
 * card that reads fine and is lying:
 *
 *   - **A phase with no verify command is marked as having none.** It cannot go green through a
 *     gate, and drawing it as a fifth ordinary row waiting its turn tells the owner to wait for
 *     something that will never happen. No placeholder command is ever printed in the hole.
 *   - **The exit code is drawn and a log tail is not.** The verify command's output goes to a
 *     file and to a worker's window, never into the thread (`docs/vision.md` §4 step 7.5), so the
 *     card clamps `last_evidence` to one line rather than trusting the field.
 *   - **A work order at `state: "unknown"` is drawn as blocked, not as in progress.** Something
 *     moved in that worktree and the harness cannot tell what, so the phase is blocked and the
 *     order will not be repeated.
 *   - **An unrecognised intent `kind` renders as itself.** The slug is a pass-through, not a
 *     closed set; a build that adds a kind must not break an older webview.
 *   - **No dollar figure anywhere.** The owner runs on his own subscription and is never billed
 *     per token, so a dollar figure would be a lie in his favour.
 *
 * Mechanics match `Feed.test.tsx`: `globals: false`, so every helper is imported from "vitest",
 * and `cleanup()` is called by hand because auto-cleanup needs a global `afterEach` that
 * `globals: false` denies it.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen, within, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { RunCard } from "./RunCard";
import type { IntentView, PhaseView, RunView, WorkOrderView } from "../wire";

afterEach(() => {
  cleanup();
});

/* -------------------------------------------------------------- fixtures */

function order(over: Partial<WorkOrderView> = {}): WorkOrderView {
  return {
    order_id: "or-1",
    title: "Write the schema",
    owned_paths: ["crates/store/src/schema.rs"],
    state: "reported",
    session_id: "s-1",
    branch: "brigadier/aaaa1111",
    worktree_path: "/repos/x/.brigadier/worktrees/aaaa1111",
    report: null,
    ...over,
  };
}

function phase(over: Partial<PhaseView> = {}): PhaseView {
  return {
    phase_id: "ph-1",
    ordinal: 1,
    title: "Pin the intent tables",
    definition_of_done: "The tables exist and the round-trip test passes.",
    verify_command: "cargo test -p brigadier-store",
    state: "green",
    attempts: 1,
    base_sha: "0d4e11b",
    commit_sha: "a1c9f04",
    last_exit_code: 0,
    last_evidence: "41 passed, 0 failed",
    orders: [],
    ...over,
  };
}

function run(over: Partial<RunView> = {}): RunView {
  return {
    plan_id: "pl-1",
    project_id: "p-1",
    goal: "Make the store durable across a crash",
    status: "approved",
    revision: 2,
    created_at_ms: 1_700_000_000_000,
    approved_at_ms: 1_700_000_001_200,
    phases: [phase()],
    unknowns: [],
    ...over,
  };
}

function intent(over: Partial<IntentView> = {}): IntentView {
  return {
    intent_id: "in-1",
    kind: "work_order",
    state: "unknown",
    session_id: "s-1",
    project_id: "p-1",
    opened_at_ms: 1_700_000_005_600,
    subject: "/repos/x/.brigadier/worktrees/bbbb2222",
    evidence: "1 commit and 3 dirty files above the dispatch baseline",
    ...over,
  };
}

/** The card's whole rendered text, for the assertions that are about what is *absent*. */
function cardText(): string {
  return screen.getByRole("region", { name: "the run" }).textContent ?? "";
}

/* ------------------------------------------------------------------ tests */

describe("the collapsed line", () => {
  it("carries the goal, the phase counts and what is happening now", () => {
    render(
      <RunCard
        run={run({
          phases: [
            phase({ phase_id: "a", ordinal: 1, state: "green" }),
            phase({ phase_id: "b", ordinal: 2, state: "green" }),
            phase({ phase_id: "c", ordinal: 3, state: "running", title: "Gate the run surface" }),
            phase({ phase_id: "d", ordinal: 4, state: "pending" }),
          ],
        })}
        intents={[]}
        onSettle={() => {}}
      />,
    );

    expect(screen.getByText("Make the store durable across a crash")).toBeInTheDocument();
    expect(screen.getByText("2 green · 1 running · 1 pending")).toBeInTheDocument();
    expect(screen.getByText("running · Gate the run surface")).toBeInTheDocument();
  });

  it("says a blocked run is blocked without being expanded", async () => {
    const user = userEvent.setup();
    render(
      <RunCard
        run={run({
          phases: [
            phase({ phase_id: "a", state: "green" }),
            phase({ phase_id: "b", state: "blocked", title: "Collect the worktrees" }),
          ],
        })}
        intents={[]}
        onSettle={() => {}}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Collapse" }));
    expect(screen.getByText("blocked · Collect the worktrees")).toBeInTheDocument();
  });

  it("collapses to one line and expands back to the checklist", async () => {
    const user = userEvent.setup();
    render(<RunCard run={run()} intents={[]} onSettle={() => {}} />);

    // Expanded by default: the checklist is the thing the owner walked away from.
    const toggle = screen.getByRole("button", { name: "Collapse" });
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByText("Pin the intent tables")).toBeInTheDocument();

    await user.click(toggle);

    const expand = screen.getByRole("button", { name: "Expand" });
    expect(expand).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByText("Pin the intent tables")).not.toBeInTheDocument();
    // The one line survives the collapse; that is the whole point of collapsing.
    expect(screen.getByText("Make the store durable across a crash")).toBeInTheDocument();

    await user.click(expand);
    expect(screen.getByText("Pin the intent tables")).toBeInTheDocument();
  });

  it("says a stopped run is stopped, whatever state its phases froze in", () => {
    // `stop_run` stops dispatching and kills nothing, so a phase that was running keeps saying
    // `running`. The line must not read that as work still going on.
    render(
      <RunCard
        run={run({
          status: "abandoned",
          phases: [phase({ state: "running", title: "Gate the run surface" })],
        })}
        intents={[]}
        onSettle={() => {}}
      />,
    );
    expect(screen.getByText("stopped · no further orders go out")).toBeInTheDocument();
  });

  it("draws nothing at all when there is no run and nothing unsettled", () => {
    render(<RunCard run={null} intents={[]} onSettle={() => {}} />);
    expect(screen.queryByRole("region", { name: "the run" })).not.toBeInTheDocument();
  });

  it("still draws the unsettled intents when there is no run in this project", () => {
    // `unsettled_intents` is not scoped to a project. An intent nobody can see is an intent that
    // stays unaccounted for.
    render(<RunCard run={null} intents={[intent()]} onSettle={() => {}} />);
    expect(screen.getByRole("button", { name: "Mark done" })).toBeInTheDocument();
  });
});

describe("a phase with no verify command", () => {
  it("is marked as having no gate, and no placeholder command is drawn", () => {
    const { container } = render(
      <RunCard
        run={run({
          phases: [
            phase({ phase_id: "a", ordinal: 1, verify_command: "npm test" }),
            phase({
              phase_id: "b",
              ordinal: 2,
              title: "Write the operator notes",
              verify_command: null,
              state: "pending",
              last_exit_code: null,
              last_evidence: null,
              commit_sha: null,
            }),
          ],
        })}
        intents={[]}
        onSettle={() => {}}
      />,
    );

    expect(screen.getByText(/no gate/)).toBeInTheDocument();
    expect(screen.getByText(/cannot go green through one/)).toBeInTheDocument();

    // Exactly one command is printed, for the one phase that has one. `code` is a semantic
    // element, not a class name: what is asserted is "no second command was invented".
    const commands = [...container.querySelectorAll("code")].map((c) => c.textContent);
    expect(commands).toEqual(["npm test"]);
  });
});

describe("a phase whose gate failed", () => {
  it("shows the exit code", () => {
    render(
      <RunCard
        run={run({
          phases: [
            phase({
              state: "blocked",
              attempts: 2,
              last_exit_code: 1,
              last_evidence: "2 failed, 146 passed",
              commit_sha: null,
            }),
          ],
        })}
        intents={[]}
        onSettle={() => {}}
      />,
    );

    expect(screen.getByText("exit 1")).toBeInTheDocument();
    expect(screen.getByText("2 attempts")).toBeInTheDocument();
  });

  it("renders no log tail, even when one arrives in last_evidence", () => {
    // The wire carries no log tail and the Rust side bounds this field. The clamp here is the
    // second half of the same rule: the card cannot become a log viewer by accident.
    const tail = ["FAILED src/run.test.tsx > start", "  expected 1 to be 0", "  at line 42"].join(
      "\n",
    );
    render(
      <RunCard
        run={run({ phases: [phase({ state: "blocked", last_exit_code: 1, last_evidence: tail })] })}
        intents={[]}
        onSettle={() => {}}
      />,
    );

    const text = cardText();
    expect(text).toContain("exit 1");
    // Collapsed to one line: no newline from the field survives into the card.
    expect(text).not.toContain("\n  at line 42");
    expect(screen.getByText(/FAILED src\/run\.test\.tsx > start/)).toBeInTheDocument();
    // …and a long one is clamped rather than printed whole.
    const long = "x".repeat(400);
    cleanup();
    render(
      <RunCard
        run={run({ phases: [phase({ state: "blocked", last_exit_code: 1, last_evidence: long })] })}
        intents={[]}
        onSettle={() => {}}
      />,
    );
    expect(cardText()).not.toContain(long);
    expect(screen.getByText(/^x+…$/)).toBeInTheDocument();
  });
});

describe("a work order the harness cannot account for", () => {
  it("is drawn as blocked and needing a decision, never as in progress", () => {
    render(
      <RunCard
        run={run({
          phases: [
            phase({
              state: "blocked",
              last_exit_code: null,
              last_evidence: null,
              commit_sha: null,
              orders: [order({ order_id: "or-x", state: "unknown", title: "Land the branches" })],
            }),
          ],
        })}
        intents={[]}
        onSettle={() => {}}
      />,
    );

    expect(screen.getByText("unknown · blocked")).toBeInTheDocument();
    expect(screen.getByText(/will not be repeated/)).toBeInTheDocument();

    // Nothing on this card says the order is still going. A spinner here would tell the owner to
    // wait for something that is never coming.
    const text = cardText();
    expect(text).not.toContain("dispatched");
    expect(text).not.toContain("in progress");
    expect(screen.queryByRole("progressbar")).not.toBeInTheDocument();
  });

  it("still draws an ordinary dispatched order as dispatched", () => {
    // The guard above must not be passing because the word is unreachable.
    render(
      <RunCard
        run={run({ phases: [phase({ orders: [order({ state: "dispatched" })] })] })}
        intents={[]}
        onSettle={() => {}}
      />,
    );
    expect(screen.getByText("dispatched")).toBeInTheDocument();
  });
});

describe("the unsettled intents", () => {
  it("offer both of the two answers settle_intent takes", async () => {
    const user = userEvent.setup();
    const settled: Array<[string, string]> = [];
    render(
      <RunCard
        run={null}
        intents={[intent({ intent_id: "in-7" })]}
        onSettle={(id, s) => settled.push([id, s])}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Mark done" }));
    await user.click(screen.getByRole("button", { name: "Mark not done" }));

    expect(settled).toEqual([
      ["in-7", "done"],
      ["in-7", "not_done"],
    ]);
  });

  it("is not the approvals dock: neither answer allows or denies anything", () => {
    render(<RunCard run={null} intents={[intent()]} onSettle={() => {}} />);

    expect(screen.queryByRole("button", { name: /allow/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /deny/i })).not.toBeInTheDocument();
    expect(screen.getByText(/not an approval/)).toBeInTheDocument();
  });

  it("renders an unrecognised kind as itself rather than crashing or hiding it", () => {
    // `kind` is a pass-through slug. `db_migrate` is the same example the Rust side's own pinning
    // test uses for a kind no build knows (`crates/store/src/intents.rs`).
    render(
      <RunCard
        run={null}
        intents={[intent({ intent_id: "in-9", kind: "db_migrate", subject: "0002_intents.sql" })]}
        onSettle={() => {}}
      />,
    );

    expect(screen.getByText("db_migrate")).toBeInTheDocument();
    expect(screen.getByText("0002_intents.sql")).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: /^Mark/ })).toHaveLength(2);
  });

  it("renders an intent with no subject and no evidence", () => {
    // Both fields are nullable on the wire; a null must not become the string "null".
    render(
      <RunCard
        run={null}
        intents={[intent({ subject: null, evidence: null })]}
        onSettle={() => {}}
      />,
    );
    expect(cardText()).not.toContain("null");
  });
});

describe("what the card never says", () => {
  it("carries no dollar figure anywhere", () => {
    render(
      <RunCard
        run={run({
          phases: [
            phase({ phase_id: "a", state: "green" }),
            phase({ phase_id: "b", state: "blocked", last_exit_code: 1, orders: [order()] }),
          ],
        })}
        intents={[intent()]}
        onSettle={() => {}}
      />,
    );

    // `docs/vision.md` §6: the owner runs on his own subscription and is never billed per token,
    // so a dollar figure would be a lie in his own favour. There is no such field on this wire
    // and this is what fails if one is ever added and drawn.
    expect(cardText()).not.toContain("$");
    expect(cardText()).not.toMatch(/USD|usd/);
  });

  it("does not blow up on a plan with no phases at all", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    render(<RunCard run={run({ phases: [], status: "draft" })} intents={[]} onSettle={() => {}} />);
    expect(screen.getByText("no phases yet")).toBeInTheDocument();
    expect(screen.getByText("planning")).toBeInTheDocument();
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });
});

describe("the checklist", () => {
  it("shows each phase's title, state and verify command", () => {
    render(
      <RunCard
        run={run({
          phases: [
            phase({ phase_id: "a", ordinal: 1, title: "First", verify_command: "cargo check" }),
            phase({
              phase_id: "b",
              ordinal: 2,
              title: "Second",
              state: "running",
              verify_command: "npm test",
              last_exit_code: null,
              commit_sha: null,
              last_evidence: null,
            }),
          ],
        })}
        intents={[]}
        onSettle={() => {}}
      />,
    );

    const items = screen.getAllByRole("listitem");
    const first = items.find((li) => within(li).queryByText("First"));
    expect(first).toBeDefined();
    expect(within(first!).getByText("green")).toBeInTheDocument();
    expect(within(first!).getByText("cargo check")).toBeInTheDocument();

    const second = items.find((li) => within(li).queryByText("Second"));
    expect(within(second!).getByText("running")).toBeInTheDocument();
    expect(within(second!).getByText("npm test")).toBeInTheDocument();
  });
});
