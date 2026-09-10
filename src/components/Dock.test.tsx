import { pasteComposer } from "../test/composer";
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
import { cleanup, render, screen, waitFor, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { Dock } from "./Dock";
import * as providerCatalog from "../providerCatalog";
import type { DockProps } from "./Dock";
import { ZERO_USAGE } from "../wire";
import type { SessionRuntime } from "../feedStore";
import type { ProjectId, ProjectView, SessionId } from "../wire";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
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

describe("chat composer", () => {
  it("starts a chat directly without offering Run/Session/Turn modes", async () => {
    const { spies } = mount();
    expect(fields()).toHaveLength(1);
    for (const name of ["Run", "Session", "Turn"]) expect(screen.queryByRole("button", { name })).not.toBeInTheDocument();
    await waitFor(() => expect(fields()[0]).toHaveAttribute("contenteditable", "true"));
    await pasteComposer(fields()[0]!, "hello");
    await userEvent.click(screen.getByRole("button", { name: "Send" }));
    expect(spies.onStartSession).toHaveBeenCalledWith(expect.objectContaining({ projectId: P1, prompt: "hello" }));
    expect(spies.onStartRun).not.toHaveBeenCalled();
  });
  it("sends to the selected session and returns to new chat when deselected", async () => {
    const { spies, props, view } = mount({ session: session() });
    await waitFor(() => expect(fields()[0]).toHaveAttribute("contenteditable", "true"));
    await pasteComposer(fields()[0]!, "next step");
    fireEvent.keyDown(fields()[0]!, { key: "Enter" });
    await waitFor(() => expect(spies.onSend).toHaveBeenCalled());
    expect(spies.onSend).toHaveBeenCalledWith(S1, "next step");
    view.rerender(<Dock {...props} session={null} />);
    expect(screen.getByRole("button", { name: "Send" })).toBeInTheDocument();
    expect(fields()).toHaveLength(1);
  });
  it("keeps chat available while an automation exists", () => {
    mount();
    expect(screen.getByRole("button", { name: "Send" })).toBeInTheDocument();
  });
  it("disables starting when the provider is unavailable", () => {
    mount({ blocked: true });
    expect(fields()[0]).toHaveAttribute("contenteditable", "false");
  });
});

it("allows a connected Codex task when Claude is unavailable", async () => {
  vi.spyOn(providerCatalog, "useProviderCatalog").mockReturnValue({providers: [{id: "codex", label: "Codex", instanceId: "codex:default", version: null, models: [{id: "exact-codex", label: "Exact Codex", efforts: ["high"]}], efforts: ["high"], modelCatalogKnown: true}], error: "", loaded: true});
  const {spies} = mount({blocked: true});
  await waitFor(() => expect(fields()[0]).toHaveAttribute("contenteditable", "true"));
  await pasteComposer(fields()[0]!, "use available provider");
  fireEvent.click(screen.getByRole("button", {name: "Send"}));
  await waitFor(() => expect(spies.onStartSession).toHaveBeenCalledWith(expect.objectContaining({composerMode: "auto", prompt: "use available provider"})));
});
