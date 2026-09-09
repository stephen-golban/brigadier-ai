import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { sessionApi } from "../sessionApi";
import { contextPercent, SessionContext } from "./SessionContext";
import { useState } from "react";
import { Dock } from "./Dock";
import type { SessionRuntime } from "../feedStore";
import { ZERO_USAGE } from "../wire";
import { CopyButton } from "./Markdown";
import { providerIdentity } from "./AgentsPanel";
import type { ChatItem } from "../workspaceApi";
const sendTurn = vi.fn();
vi.mock("../bridge", () => ({ bridge: () => ({ sendTurn }) }));
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  sendTurn.mockReset();
  localStorage.clear();
});
const message: ChatItem = {
  session_id: "s",
  id: "message",
  seq: 2,
  at: 0,
  body: "Original text",
  kind: { type: "user-text" },
  parent_id: null,
  provider_uuid: "uuid",
};
function preview() {
  return {
    ticket: "ticket",
    conversation: true,
    reason: null,
    files: [],
    filesAvailable: true,
    hasFileChanges: false,
    filesReason: "No file checkpoint found for this message.",
  };
}
const session: SessionRuntime = {
  sessionId: "s",
  projectId: "p",
  status: "running",
  model: null,
  cwd: null,
  providerSessionId: "provider",
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
  startedAtMs: 0,
  endedAtMs: null,
  exitCode: null,
  lastMessage: null,
  lastEventSeq: 0,
};
function EditHarness({
  onClose = () => {},
  onRewound = () => {},
}: {
  onClose?: () => void;
  onRewound?: () => void;
}) {
  const [editing, setEditing] = useState<ChatItem | null>(message);
  return (
    <Dock
      session={session}
      project={null}
      models={[]}
      busy={false}
      blocked={false}
      editing={editing}
      onCancelEdit={() => {
        setEditing(null);
        onClose();
      }}
      onRewound={onRewound}
      onSend={vi.fn()}
      onStartSession={vi.fn()}
      onInterrupt={vi.fn()}
      onEnd={vi.fn()}
      onKill={vi.fn()}
      onResume={vi.fn()}
      onCleanup={vi.fn()}
    />
  );
}
describe("session tools", () => {
  it("calculates only a current provider reading, including compaction and unknown", async () => {
    expect(contextPercent(null)).toBeNull();
    expect(contextPercent({ available: true, used: 1, limit: 0 })).toBeNull();
    expect(
      contextPercent({ available: true, used: NaN, limit: 200000 }),
    ).toBeNull();
    expect(
      contextPercent({ available: true, used: 220000, limit: 200000 }),
    ).toBe(110);
    const read = vi.spyOn(sessionApi, "context").mockResolvedValue({
      available: true,
      used: 120000,
      limit: 200000,
      model: "model",
      sampledAt: 1,
    });
    const view = render(
      <SessionContext sessionId="s" revision={0} busy={false} />,
    );
    await screen.findByLabelText("Context usage approximately 60%");
    read.mockResolvedValue({ available: true, used: 10000, limit: 200000 });
    view.rerender(<SessionContext sessionId="s" revision={1} busy={false} />);
    await screen.findByLabelText("Context usage approximately 5%");
    read.mockResolvedValue({ available: false, reason: "Unavailable" });
    view.rerender(<SessionContext sessionId="s" revision={2} busy={false} />);
    await screen.findByLabelText("Context usage unknown");
    expect(screen.queryByText("5%")).not.toBeInTheDocument();
  });
  it("edits in the only composer input and restores the unsent draft on cancellation", async () => {
    const user = userEvent.setup();
    localStorage.setItem("draft:turn:s", "Unsent next turn");
    const check = vi.spyOn(sessionApi, "preview").mockResolvedValue(preview());
    const rewind = vi.spyOn(sessionApi, "rewind");
    const close = vi.fn();
    render(<EditHarness onClose={close} />);
    expect(screen.getAllByRole("textbox", { hidden: true })).toHaveLength(1);
    expect(screen.getByRole("textbox")).toHaveValue("Original text");
    expect(screen.getByRole("textbox")).toHaveFocus();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(check).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Cancel edit" }));
    expect(screen.getByRole("textbox")).toHaveValue("Unsent next turn");
    expect(close).toHaveBeenCalledOnce();
    expect(rewind).not.toHaveBeenCalled();
    expect(sendTurn).not.toHaveBeenCalled();
  });
  it("rewinds and resends unchanged text without confirmation when the span has no edits", async () => {
    const user = userEvent.setup();
    vi.spyOn(sessionApi, "preview").mockResolvedValue(preview());
    const rewind = vi.spyOn(sessionApi, "rewind").mockResolvedValue({
      rewound: true,
      recoveryId: "saved",
      filesRestored: true,
      sent: true,
    });
    const close = vi.fn();
    render(<EditHarness onClose={close} />);
    await user.keyboard("{Enter}");
    await waitFor(() => expect(close).toHaveBeenCalledOnce());
    expect(rewind).toHaveBeenCalledWith(
      "ticket",
      "conversation-and-files",
      "Original text",
    );
    expect(sendTurn).not.toHaveBeenCalled();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });
  it("confirms only at Send when the affected span contains file edits", async () => {
    const user = userEvent.setup();
    vi.spyOn(sessionApi, "preview").mockResolvedValue({
      ...preview(),
      filesAvailable: false,
      hasFileChanges: true,
    });
    const rewind = vi.spyOn(sessionApi, "rewind").mockResolvedValue({
      rewound: true,
      recoveryId: "saved",
      filesRestored: false,
    });
    sendTurn.mockResolvedValue({ turn_id: "next" });
    const close = vi.fn();
    render(<EditHarness onClose={close} />);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    await user.click(
      screen.getByRole("button", { name: "Send edited message" }),
    );
    const dialog = await screen.findByRole("dialog");
    expect(dialog).toHaveTextContent("File changes will remain on disk");
    expect(screen.getAllByRole("textbox", { hidden: true })).toHaveLength(1);
    expect(rewind).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.getByRole("textbox")).toHaveValue("Original text");
    expect(rewind).not.toHaveBeenCalled();
    await user.click(
      screen.getByRole("button", { name: "Send edited message" }),
    );
    await user.click(
      await screen.findByRole("button", { name: "Rewind & send" }),
    );
    await waitFor(() => expect(close).toHaveBeenCalledOnce());
    expect(rewind).toHaveBeenCalledOnce();
    expect(sendTurn).toHaveBeenCalledOnce();
  });
  it("shows the exact current restore paths and sends once through the combined transaction", async () => {
    const user = userEvent.setup();
    vi.spyOn(sessionApi, "preview").mockResolvedValue({
      ...preview(),
      files: ["src/a.ts", "asset.bin"],
      hasFileChanges: true,
    });
    const rewind = vi
      .spyOn(sessionApi, "rewind")
      .mockResolvedValue({
        rewound: true,
        recoveryId: "saved",
        filesRestored: true,
        sent: true,
      });
    const close = vi.fn();
    render(<EditHarness onClose={close} />);
    await user.click(
      screen.getByRole("button", { name: "Send edited message" }),
    );
    const dialog = await screen.findByRole("dialog");
    expect(dialog).toHaveTextContent("Restore 2 files");
    expect(dialog).toHaveTextContent("src/a.ts");
    expect(dialog).toHaveTextContent("asset.bin");
    expect(rewind).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Rewind & send" }));
    await waitFor(() => expect(close).toHaveBeenCalledOnce());
    expect(rewind).toHaveBeenCalledWith(
      "ticket",
      "conversation-and-files",
      "Original text",
    );
    expect(sendTurn).not.toHaveBeenCalled();
  });
  it("requires explicit conversation-only confirmation for legacy coverage even without inferred edits", async () => {
    const user = userEvent.setup();
    vi.spyOn(sessionApi, "preview").mockResolvedValue({
      ...preview(),
      filesAvailable: false,
    });
    const rewind = vi.spyOn(sessionApi, "rewind");
    render(<EditHarness />);
    await user.click(
      screen.getByRole("button", { name: "Send edited message" }),
    );
    expect(await screen.findByRole("dialog")).toHaveTextContent(
      "No file checkpoint found",
    );
    expect(rewind).not.toHaveBeenCalled();
  });
  it("keeps the draft on refusal and never sends until native rewind succeeds", async () => {
    const user = userEvent.setup();
    vi.spyOn(sessionApi, "preview").mockResolvedValue(preview());
    vi.spyOn(sessionApi, "rewind").mockRejectedValue({
      code: "rewind_refused",
      message: "unseen later turn",
    });
    const changed = vi.fn();
    render(<EditHarness onClose={vi.fn()} onRewound={changed} />);
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Send edited message" }),
      ).toBeEnabled(),
    );
    await user.clear(screen.getByRole("textbox"));
    await user.type(screen.getByRole("textbox"), "Edited draft");
    await user.click(
      screen.getByRole("button", { name: "Send edited message" }),
    );
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "unseen later turn",
    );
    expect(screen.getByRole("textbox")).toHaveValue("Edited draft");
    expect(changed).not.toHaveBeenCalled();
    expect(sendTurn).not.toHaveBeenCalled();
  });
  it("does not rewind twice when sending the edited draft fails", async () => {
    const user = userEvent.setup();
    vi.spyOn(sessionApi, "preview").mockResolvedValue(preview());
    const rewind = vi.spyOn(sessionApi, "rewind").mockResolvedValue({
      rewound: true,
      recoveryId: "saved",
      filesRestored: false,
    });
    sendTurn
      .mockRejectedValueOnce(new Error("Send failed"))
      .mockResolvedValueOnce({ turn_id: "next" });
    const close = vi.fn();
    const changed = vi.fn();
    render(<EditHarness onClose={close} onRewound={changed} />);
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Send edited message" }),
      ).toBeEnabled(),
    );
    await user.click(
      screen.getByRole("button", { name: "Send edited message" }),
    );
    await screen.findByText("Send failed");
    await user.click(
      screen.getByRole("button", { name: "Send edited message" }),
    );
    await waitFor(() => expect(close).toHaveBeenCalledOnce());
    expect(rewind).toHaveBeenCalledOnce();
    expect(changed).toHaveBeenCalledOnce();
  });
  it("preserves the edit and blocks retries when the rewind outcome is unconfirmed", async () => {
    const user = userEvent.setup();
    vi.spyOn(sessionApi, "preview").mockResolvedValue(preview());
    const rewind = vi.spyOn(sessionApi, "rewind").mockRejectedValue({
      code: "rewind_unconfirmed",
      message: "Outcome requires reconciliation",
    });
    render(<EditHarness />);
    await user.click(
      screen.getByRole("button", { name: "Send edited message" }),
    );
    await screen.findByText("Outcome requires reconciliation");
    expect(screen.getByRole("textbox")).toHaveValue("Original text");
    expect(
      screen.getByRole("button", { name: "Send edited message" }),
    ).toBeDisabled();
    expect(rewind).toHaveBeenCalledOnce();
    expect(sendTurn).not.toHaveBeenCalled();
  });
  it("copies exact text and reports a clipboard failure accessibly", async () => {
    const user = userEvent.setup();
    const copy = vi
      .spyOn(navigator.clipboard, "writeText")
      .mockRejectedValueOnce(new Error("Denied"))
      .mockResolvedValueOnce();
    render(<CopyButton text={"Exact\nmessage"} />);
    await user.click(screen.getByRole("button", { name: "Copy" }));
    await user.click(
      await screen.findByRole("button", { name: "Copy failed; try again" }),
    );
    await screen.findByRole("button", { name: "Copied" });
    expect(copy).toHaveBeenLastCalledWith("Exact\nmessage");
  });
  it("keeps unknown and demo providers distinct from a running CLI", () => {
    expect(providerIdentity(null).name).toBe("Provider unknown");
    expect(providerIdentity("claude-mock").name).toBe("Demo");
    expect(providerIdentity("claude-code:work")).toEqual({
      name: "Claude Code",
      cli: "claude",
    });
    expect(providerIdentity("custom:work").cli).toBe("CLI unknown");
  });
});

it("passes retained attachments on an existing session turn and clears them only after acceptance", async () => {
  localStorage.setItem("draft:attachments:turn:s", JSON.stringify([{id:"file",projectId:"p",name:"Reference.png",mediaType:"image/png",size:3,createdAt:0}]));
  const send = vi.fn().mockResolvedValueOnce(false).mockResolvedValue(true);
  const user = userEvent.setup();
  render(<Dock session={session} project={null} models={[]} busy={false} blocked={false}
    onSend={send} onStartSession={vi.fn()} onInterrupt={vi.fn()} onEnd={vi.fn()} onKill={vi.fn()}
    onResume={vi.fn()} onCleanup={vi.fn()} />);
  await user.type(screen.getByRole("textbox"), "Share the reference with a peer");
  await user.keyboard("{Enter}");
  expect(send).toHaveBeenCalledWith("s", "Share the reference with a peer", ["file"]);
  expect(screen.getByRole("button", {name:"Remove attachment Reference.png"})).toBeVisible();
  await user.keyboard("{Enter}");
  expect(screen.queryByRole("button", {name:"Remove attachment Reference.png"})).toBeNull();
  expect(localStorage.getItem("draft:attachments:turn:s")).toBeNull();
});
