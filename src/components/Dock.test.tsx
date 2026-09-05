/**
 * The dock's one question: **there is one text field, and something on screen says what it does.**
 *
 * R2, 2026-09-05. The owner drove the app and asked why there were two text fields. There were
 * two — a run strip and a composer — and nothing distinguished them. What is pinned here is the
 * shape of the answer rather than its styling:
 *
 *   - **one field at a time**, whichever mode is selected;
 *   - **the choice routes to the right command.** Run reaches `onStartRun`, Session reaches
 *     `onStartSession` with the model and permission mode beside it, Turn reaches `onSend` with
 *     the selected session. A chooser that looked right and started the wrong thing would be
 *     worse than the two fields it replaced.
 *   - **Turn is offered only when there is a session to send it to**, and selecting one lands on
 *     it without the operator having to ask.
 *
 * Same rule as `Sidebar.test.tsx` and `Feed.test.tsx`: text and roles, never class names.
 *
 * Mechanics: `globals: false`, so every helper is imported; `cleanup()` by hand because
 * auto-cleanup needs a global `afterEach` this config denies it.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { Dock } from "./Dock";
import type { DockProps } from "./Dock";
import { ZERO_USAGE } from "../wire";
import type { SessionRuntime } from "../feedStore";
import type { ProjectId, ProjectView, SessionId } from "../wire";

afterEach(() => {
  cleanup();
});

const P1 = "project-one" as ProjectId;
const S1 = "11111111-1111-4111-8111-1111111a1b2c" as SessionId;

const PROJECT: ProjectView = {
  id: P1,
  name: "job-portal",
  root_path: "/repos/job-portal",
  created_at_ms: 1_700_000_000_000,
};

function session(over: Partial<SessionRuntime> = {}): SessionRuntime {
  return {
    sessionId: S1,
    projectId: P1,
    status: "running",
    model: "claude-sonnet-4-5",
    cwd: "/repos/job-portal",
    providerSessionId: null,
    worktreePath: null,
    branch: null,
    worktreeRemoved: false,
    resumed: false,
    busy: false,
    lastTurnId: null,
    lastStop: null,
    costUsd: 0,
    usage: { ...ZERO_USAGE },
    rowsTotal: 0,
    rowsDropped: 0,
    startedAtMs: 1_700_000_000_000,
    endedAtMs: null,
    exitCode: null,
    lastMessage: null,
    lastEventSeq: 0,
    ...over,
  };
}

/** Every callback is a spy, so "which command did the choice reach" is a plain assertion. */
function mount(over: Partial<DockProps> = {}) {
  const spies = {
    onStartRun: vi.fn(),
    onStopRun: vi.fn(),
    onStartSession: vi.fn(),
    onSend: vi.fn(),
    onInterrupt: vi.fn(),
    onEnd: vi.fn(),
    onKill: vi.fn(),
    onResume: vi.fn(),
    onCleanup: vi.fn(async () => null),
  };
  const props: DockProps = {
    project: PROJECT,
    session: null,
    models: [{ id: "claude-sonnet-4-5", label: "Sonnet 4.5", default: true }],
    run: null,
    busy: false,
    blocked: false,
    ...spies,
    ...over,
  };
  const view = render(<Dock {...props} />);
  return { view, spies, props };
}

/** Every text field on the dock, whatever its label. The count is the whole point. */
function fields() {
  return screen.getAllByRole("textbox");
}

describe("one field, and a choice of what it does", () => {
  it("draws exactly one text field with no session selected", () => {
    mount();
    expect(fields()).toHaveLength(1);
    expect(
      screen.getByRole("textbox", { name: "the goal, in plain English" }),
    ).toBeInTheDocument();
  });

  it("still draws exactly one with a session selected", () => {
    mount({ session: session() });
    expect(fields()).toHaveLength(1);
  });

  it("draws exactly one in each mode the chooser offers", async () => {
    mount({ session: session() });
    for (const label of ["Run", "Session", "Turn"]) {
      await userEvent.click(screen.getByRole("button", { name: label }));
      expect(fields()).toHaveLength(1);
    }
  });
});

describe("the choice reaches the command it names", () => {
  it("Run hands the goal to start_run, with the model and the permission mode beside it", async () => {
    const { spies } = mount();
    await userEvent.click(screen.getByRole("button", { name: "Run" }));
    await userEvent.type(
      screen.getByRole("textbox", { name: "the goal, in plain English" }),
      "Make the store durable",
    );
    await userEvent.click(screen.getByRole("button", { name: "Start run" }));

    // `null` for the model is the untouched picker: see the no-pick test below for why that is a
    // choice rather than an omission.
    expect(spies.onStartRun).toHaveBeenCalledWith("Make the store durable", null, "default");
    expect(spies.onStartSession).not.toHaveBeenCalled();
    expect(spies.onSend).not.toHaveBeenCalled();
  });

  it("Session hands the prompt to start_session, with the pickers beside it", async () => {
    const { spies } = mount();
    await userEvent.click(screen.getByRole("button", { name: "Session" }));

    expect(screen.getByRole("button", { name: /model/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /permissions/i })).toBeInTheDocument();

    await userEvent.type(fields()[0]!, "read the schema");
    await userEvent.click(screen.getByRole("button", { name: "Start" }));

    expect(spies.onStartSession).toHaveBeenCalledWith({
      projectId: P1,
      prompt: "read the schema",
      isolated: false,
      model: "claude-sonnet-4-5",
      permissionMode: "default",
    });
    expect(spies.onStartRun).not.toHaveBeenCalled();
  });

  it("Turn sends to the selected session and to nothing else", async () => {
    const { spies } = mount({ session: session() });
    await userEvent.click(screen.getByRole("button", { name: "Turn" }));
    await userEvent.type(fields()[0]!, "carry on");
    await userEvent.click(screen.getByRole("button", { name: "send this turn" }));

    expect(spies.onSend).toHaveBeenCalledWith(S1, "carry on");
    expect(spies.onStartRun).not.toHaveBeenCalled();
    expect(spies.onStartSession).not.toHaveBeenCalled();
  });

  /** `isSubmitKey` in `src/keys.ts`: the chooser's promise is about the Return key, so Return has
   *  to be what actually starts it. */
  it("Return starts the chosen thing, and Shift+Return does not", async () => {
    const { spies } = mount();
    const field = screen.getByRole("textbox", { name: "the goal, in plain English" });
    await userEvent.type(field, "a goal{Shift>}{Enter}{/Shift}");
    expect(spies.onStartRun).not.toHaveBeenCalled();

    await userEvent.type(field, "{Enter}");
    expect(spies.onStartRun).toHaveBeenCalledTimes(1);
  });
});

/*
 * R4.1. The owner picked "Haiku 4.5" in the dock, pressed Start, and the run used the CLI's
 * default: `start_run` took only a project and a goal, so the pickers reached nothing and his
 * first live run showed `claude-opus-5[1m]` in the session header. These pin the seam.
 */
describe("the run's model and permission mode reach start_run", () => {
  it("draws both pickers in Run mode, not only in Session mode", async () => {
    mount();
    await userEvent.click(screen.getByRole("button", { name: "Run" }));

    expect(screen.getByRole("button", { name: /model/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /permissions/i })).toBeInTheDocument();
  });

  it("sends the chosen model and mode, and the model applies to every child of the run", async () => {
    const { spies } = mount({
      models: [
        { id: "claude-haiku-4-5", label: "Haiku 4.5", default: true },
        { id: "claude-opus-5", label: "Opus 5", default: false },
      ],
    });
    await userEvent.click(screen.getByRole("button", { name: "Run" }));
    await userEvent.click(screen.getByRole("button", { name: /model/i }));
    await userEvent.click(screen.getByRole("option", { name: /Haiku 4.5/i }));
    await userEvent.click(screen.getByRole("button", { name: /permissions/i }));
    await userEvent.click(screen.getByRole("option", { name: /bypass/i }));
    await userEvent.type(
      screen.getByRole("textbox", { name: "the goal, in plain English" }),
      "ship it",
    );
    await userEvent.click(screen.getByRole("button", { name: "Start run" }));

    expect(spies.onStartRun).toHaveBeenCalledWith("ship it", "claude-haiku-4-5", "bypass-permissions");
  });

  /**
   * **No pick is a real choice**, and the better default: it leaves the harness's role-based
   * routing in charge, so judgement takes the provider's strong default and a work order takes
   * its per-order tier. What must never happen is a sentinel string reaching `start_run` — its
   * `model` is an `Option<String>` and a placeholder would be handed straight to `--model`, which
   * the CLI refuses.
   */
  it("starts on no-pick, labels it, and sends null rather than a sentinel", async () => {
    const { spies } = mount({
      models: [{ id: "claude-haiku-4-5", label: "Haiku 4.5", default: true }],
    });
    await userEvent.click(screen.getByRole("button", { name: "Run" }));

    const model = screen.getByRole("button", { name: /model/i });
    expect(model).toHaveTextContent("Per role (no pick)");
    await userEvent.click(model);
    // Reachable *and* named: an unlabelled empty option reads as a field that failed to load.
    expect(within(screen.getByRole("listbox", { name: /model/i })).getByRole("option", { name: /no pick/i })).toBeInTheDocument();

    await userEvent.type(
      screen.getByRole("textbox", { name: "the goal, in plain English" }),
      "ship it",
    );
    await userEvent.click(screen.getByRole("button", { name: "Start run" }));

    expect(spies.onStartRun).toHaveBeenCalledWith("ship it", null, "default");
  });

  /**
   * `docs/research/permission-modes.md` §2: the CLI accepts seven values on 2.1.261 and the menu
   * offers all seven. `bypass-permissions` was left out with a note that it "silently disables the
   * approval path" — untrue of what brigadier does with it, because the `PreToolUse` hook runs
   * before the CLI consults the mode at all, and a judgement call in the owner's own checkout
   * keeps a write gate in every mode (§4–§5).
   */
  it("offers every permission mode the CLI accepts, bypass included", async () => {
    mount();
    await userEvent.click(screen.getByRole("button", { name: "Run" }));

    const modes = screen.getByRole("button", { name: /permissions/i });
    await userEvent.click(modes);
    const values = within(screen.getByRole("listbox", { name: /permissions/i }))
      .getAllByRole("option")
      .map((o) => (o as HTMLOptionElement).value);
    expect(values).toEqual([
      "default",
      "manual",
      "accept-edits",
      "plan",
      "auto",
      "dont-ask",
      "bypass-permissions",
    ]);
  });

  /** The same list, from the same constant, in the mode that always had a picker. */
  it("offers the same list in Session mode", async () => {
    mount();
    await userEvent.click(screen.getByRole("button", { name: "Session" }));

    const modes = screen.getByRole("button", { name: /permissions/i });
    await userEvent.click(modes);
    expect(within(screen.getByRole("listbox", { name: /permissions/i })).getAllByRole("option")).toHaveLength(7);
  });

  /** Session's picker has no empty entry: starting one session has always pre-selected a model,
   *  and the field says which. Only the run offers "no pick", where it means the per-role routing. */
  it("keeps the no-pick entry off the session picker", async () => {
    mount({ models: [{ id: "claude-haiku-4-5", label: "Haiku 4.5", default: true }] });
    await userEvent.click(screen.getByRole("button", { name: "Session" }));

    const model = screen.getByRole("button", { name: /model/i });
    expect(model).toHaveTextContent("Haiku 4.5");
    await userEvent.click(model);
    expect(within(screen.getByRole("listbox", { name: /model/i })).queryByRole("option", { name: /no pick/i })).not.toBeInTheDocument();
  });
});

describe("what the chooser offers", () => {
  it("does not offer Turn when there is no session to send one to", () => {
    mount();
    expect(screen.queryByRole("button", { name: "Turn" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Run" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Session" })).toBeInTheDocument();
  });

  it("lands on Turn when a session is selected, and on Run when none is", () => {
    const { view } = mount({ session: session() });
    expect(screen.getByRole("button", { name: "Turn", pressed: true })).toBeInTheDocument();

    view.unmount();
    mount();
    expect(screen.getByRole("button", { name: "Run", pressed: true })).toBeInTheDocument();
  });

  /**
   * A pinned mode must not outlive the thing it points at. Selecting a different session while
   * "Session" was pinned used to be impossible to get wrong because the modes did not exist; now
   * the derived default has to come back rather than stranding the operator on a mode they picked
   * for a session that is gone.
   */
  it("returns to the derived mode when the selection moves", async () => {
    const { view, props } = mount({ session: session() });
    await userEvent.click(screen.getByRole("button", { name: "Run" }));
    expect(screen.getByRole("button", { name: "Run", pressed: true })).toBeInTheDocument();

    view.rerender(<Dock {...props} session={session({ sessionId: "other" as SessionId })} />);
    expect(screen.getByRole("button", { name: "Turn", pressed: true })).toBeInTheDocument();
  });
});
