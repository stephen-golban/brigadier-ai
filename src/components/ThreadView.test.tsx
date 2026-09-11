import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import userEvent from "@testing-library/user-event";
import { peerApi } from "../peerApi";
import { ThreadView } from "./ThreadView";
import { workspaceApi, type ChatItem } from "../workspaceApi";
import { defaultSettings, workbenchApi } from "../workbenchApi";

const { state } = vi.hoisted(() => ({
  state: {
    sessions: {
      s: { busy: true },
      cancelled: { busy: false, lastStop: "interrupted" },
      failed: { busy: false, lastStop: '{"error":"Provider disconnected"}' },
    },
  },
}));
vi.mock("../feedStore", () => ({
  getState: () => state,
  subscribe: () => () => {},
}));
vi.mock("../desktopApi", async (original) => ({
  ...(await original<typeof import("../desktopApi")>()),
  useSessionChanges: () => ({ turns: [], files: [] }),
}));

beforeEach(() => {
  vi.spyOn(workspaceApi, "historyPage").mockImplementation(async (id, options) => {
    let items = await workspaceApi.chat(id, options?.after ?? 0);
    if (items.length === 20) items = [...items, ...await workspaceApi.chat(id, items[items.length - 1]!.seq)];
    return {items, nextAfter: Math.max(0,...items.map(i=>i.seq)), nextBefore: items[0]?.seq ?? null, hasMore:false};
  });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  localStorage.clear();
});

// Use the real assistant-ui runtime: isRunning adds its own optimistic assistant message.
it.each([false, true])(
  "renders a running session while saved user message exists = %s",
  async (saved) => {
    const page: ChatItem[] = saved
      ? [
          {
            session_id: "s",
            id: "user",
            seq: 1,
            at: 0,
            kind: { type: "user-text" },
            body: "Test message",
            parent_id: null,
          },
        ]
      : [];
    vi.spyOn(workspaceApi, "chat").mockResolvedValue(page);
    render(
      <ThreadView
        sessionId="s"
        projectId="p"
        projectName="Example"
        onFile={() => {}}
      />,
    );
    expect(
      await screen.findByText(
        saved ? "Test message" : "Waiting for the first response…",
      ),
    ).toBeVisible();
    expect(screen.getByText("Working…")).toBeVisible();
  },
);

const saved = (
  id: string,
  kind: ChatItem["kind"],
  body: string,
  seq: number,
): ChatItem => ({
  session_id: "idle",
  id,
  seq,
  at: 0,
  kind,
  body,
  parent_id: null,
});
const transcript = [
  saved("user", { type: "user-text" }, "Inspect the changes", 1),
  saved("empty", { type: "thinking" }, "", 2),
  saved("before", { type: "assistant-text" }, "I’ll inspect the diff.", 3),
  saved("call", { type: "tool-call", name: "Bash" }, "git diff", 4),
  saved(
    "result",
    { type: "tool-result", tool_call_id: "call", is_error: true },
    "Command failed",
    5,
  ),
  saved(
    "after",
    { type: "assistant-text" },
    "The command failed. Open [README.md](README.md).",
    6,
  ),
];
it("folds intermediate prose, preserves final edit/file actions, and copies visible bodies", async () => {
  const user = userEvent.setup();
  const edit = vi.fn(),
    file = vi.fn();
  vi.spyOn(workspaceApi, "chat").mockImplementation(async (_id, after) =>
    transcript.filter((i) => i.seq > after),
  );
  const { container } = render(
    <ThreadView
      sessionId="idle"
      projectId="p"
      projectName="Example"
      onFile={file}
      onEdit={edit}
      requests={<button>Approve pending request</button>}
    />,
  );
  await screen.findByRole("button", { name: /Worked/ });
  expect(screen.queryByText("I’ll inspect the diff.")).toBeNull();
  expect(
    [...container.querySelectorAll("[data-message-id]")].map((el) =>
      el.getAttribute("data-message-id"),
    ),
  ).toEqual(["user", "work:user", "after"]);
  expect(screen.queryByText("Thinking")).toBeNull();
  expect(screen.getAllByRole("button", { name: "Copy" })).toHaveLength(2);
  await user.click(screen.getByRole("button", { name: /Worked/ }));
  expect(screen.getByText("I’ll inspect the diff.")).toBeVisible();
  await user.click(
    screen.getByRole("button", { name: /Ran git diff.*Failed/ }),
  );
  expect(screen.getByText("Command failed")).toBeVisible();
  await user.click(screen.getByRole("button", { name: "Edit message" }));
  expect(edit).toHaveBeenCalledWith(transcript[0]);
  await user.click(await screen.findByRole("button", { name: "README.md" }));
  expect(file).toHaveBeenCalledWith("README.md");
  expect(
    screen.getByRole("button", { name: "Approve pending request" }),
  ).toBeVisible();
});
it("restores expanded tools after switching sessions and reloading history", async () => {
  const user = userEvent.setup();
  vi.spyOn(workspaceApi, "chat").mockImplementation(async (id, after) =>
    id === "idle"
      ? transcript.filter((i) => i.seq > after)
      : [saved("other-user", { type: "user-text" }, "Other session", 1)],
  );
  const props = { projectId: "p", projectName: "Example", onFile: vi.fn() };
  const view = render(<ThreadView {...props} sessionId="idle" />);
  await user.click(await screen.findByRole("button", { name: /Worked/ }));
  await user.click(
    screen.getByRole("button", { name: /Ran git diff.*Failed/ }),
  );
  view.rerender(<ThreadView {...props} sessionId="other" />);
  await screen.findByText("Other session");
  expect(screen.queryByText("Command failed")).toBeNull();
  view.rerender(<ThreadView {...props} sessionId="idle" />);
  expect(await screen.findByText("Command failed")).toBeVisible();
  view.unmount();
  render(<ThreadView {...props} sessionId="idle" />);
  expect(await screen.findByText("Command failed")).toBeVisible();
});
it("keeps peer attribution short and navigable", async () => {
  const user = userEvent.setup(),
    select = vi.fn();
  const title =
    "A very long peer session title that contains an entire prompt and should not become a sentence above the bubble";
  vi.spyOn(workspaceApi, "chat").mockResolvedValue([{ ...transcript[0]!, provider_uuid: "peer-turn" }]);
  render(
    <ThreadView
      sessionId="idle"
      projectId="p"
      projectName="Example"
      onFile={() => {}}
      onSelectSession={select}
      peers={{
        origins: { idle: "peer" },
        titles: { peer: title },
        closed: [],
        messages: [{ id: "delivery", from: "peer", to: "idle", text: "Inspect the changes", work: true, delivered: true, error: null, turnId: "peer-turn" }],
        requests: [],
      }}
    />,
  );
  const attribution = await screen.findByRole("button", {
    name: /^Open source task: A very long/,
  });
  expect(screen.getByText("Sent by Brigadier from another task")).toBeVisible();
  expect(attribution).toHaveAttribute("title", title);
  await user.click(attribution);
  expect(select).toHaveBeenCalledWith("peer");
});
it("discards late history from a session that was switched away", async () => {
  let resolve!: (items: ChatItem[]) => void;
  vi.spyOn(workspaceApi, "chat").mockImplementation((id) =>
    id === "old"
      ? new Promise((r) => {
          resolve = r;
        })
      : Promise.resolve([
          saved("new-user", { type: "user-text" }, "New session", 1),
        ]),
  );
  const props = { projectId: "p", projectName: "Example", onFile: vi.fn() };
  const view = render(<ThreadView {...props} sessionId="old" />);
  view.rerender(<ThreadView {...props} sessionId="new" />);
  await screen.findByText("New session");
  resolve(transcript);
  await waitFor(() =>
    expect(screen.queryByText("Inspect the changes")).toBeNull(),
  );
});

it.each([
  ["cancelled", "interrupted"],
  ["failed", "Provider disconnected"],
])("retains partial output after %s", async (sessionId, label) => {
  vi.spyOn(workspaceApi, "chat").mockResolvedValue(transcript.slice(0, 4));
  render(
    <ThreadView
      sessionId={sessionId!}
      projectId="p"
      projectName="Example"
      onFile={() => {}}
    />,
  );
  expect(await screen.findByText("I’ll inspect the diff.")).toBeVisible();
  expect(
    screen.queryByRole("button", { name: /You stopped|Stopped/ }),
  ).toBeNull();
  expect(screen.getByText(label!)).toBeVisible();
  expect(screen.queryByText("Working…")).toBeNull();
});
it("renders the hydrated latest page", async () => {
  const page = Array.from({ length: 23 }, (_, i) =>
    saved(`history-${i}`, { type: "user-text" }, `Saved turn ${i}`, i + 1),
  );
  const chat = vi
    .spyOn(workspaceApi, "chat")
    .mockImplementation(async (_id, after) =>
      page.filter((i) => i.seq > after).slice(0, 20),
    );
  render(
    <ThreadView
      sessionId="idle"
      projectId="p"
      projectName="Example"
      onFile={() => {}}
    />,
  );
  expect(await screen.findByText("Saved turn 22")).toBeVisible();
  expect(chat).toHaveBeenCalledWith("idle", 20);
  expect(screen.getByText("Saved turn 0")).toBeVisible();
});

it("renders a recorded duration after history reload without hiding the final answer", async () => {
  vi.spyOn(workspaceApi, "chat").mockResolvedValue(transcript);
  vi.spyOn(workspaceApi, "chatTurns").mockResolvedValue([
    {
      id: "turn",
      start_seq: 1,
      end_seq: 7,
      started_at: 1000,
      ended_at: 135000,
      status: "completed",
    },
  ]);
  render(
    <ThreadView
      sessionId="idle"
      projectId="p"
      projectName="Example"
      onFile={() => {}}
    />,
  );
  expect(
    await screen.findByRole("button", {
      name: /Worked for 2m 14s.*1 failure/,
    }),
  ).toHaveAttribute("aria-expanded", "false");
  expect(screen.getByText(/The command failed/)).toBeVisible();
  expect(screen.queryByText("I’ll inspect the diff.")).toBeNull();
});

it("folds a full turn while preserving commentary boundaries and independent tool disclosures", async () => {
  const user = userEvent.setup();
  const progress = [
    "Inspecting the conversation.",
    "Implementing work blocks.",
    "Checking the result.",
  ];
  const page = [
    saved("user", { type: "user-text" }, "Add compact work blocks", 1),
  ];
  for (const [index, body] of progress.entries()) {
    page.push(
      saved(
        `progress-${index}`,
        { type: "assistant-text" },
        body,
        page.length + 1,
      ),
    );
    for (let command = 0; command < 2; command++) {
      const id = `command-${index}-${command}`;
      page.push(
        saved(
          id,
          { type: "tool-call", name: "Bash" },
          `check ${index}-${command}`,
          page.length + 1,
        ),
      );
      page.push(
        saved(
          `${id}-result`,
          { type: "tool-result", tool_call_id: id, is_error: false },
          `Output ${index}-${command}`,
          page.length + 1,
        ),
      );
    }
  }
  page.push(
    saved(
      "answer",
      { type: "assistant-text" },
      "Implemented compact work blocks.",
      page.length + 1,
    ),
  );
  vi.spyOn(workspaceApi, "chat").mockResolvedValue(page);
  vi.spyOn(workspaceApi, "chatTurns").mockResolvedValue([
    {
      id: "turn",
      start_seq: 1,
      end_seq: page.length + 1,
      started_at: 1000,
      ended_at: 954000,
      status: "completed",
    },
  ]);
  render(
    <ThreadView
      sessionId="idle"
      projectId="p"
      projectName="Example"
      onFile={() => {}}
    />,
  );

  // Phase 4 / plan §3 row 5 (D6): the turn header now always carries the completion time
  // (`· done 3:04 PM`) alongside the elapsed figure, so the accessible name is no longer the
  // duration on its own. The duration itself is still pinned — this turn ran 15m 53s, above
  // the 60 s floor below which the elapsed figure is not printed at all.
  const parent = await screen.findByRole("button", {
    name: /^Worked for 15m 53s · done /,
  });
  expect(parent).toHaveAttribute("aria-expanded", "false");
  expect(screen.getByText("Implemented compact work blocks.")).toBeVisible();
  for (const body of progress) expect(screen.queryByText(body)).toBeNull();
  expect(screen.queryByRole("button", { name: "Ran commands" })).toBeNull();

  await user.click(parent);
  for (const body of progress) expect(screen.getByText(body)).toBeVisible();
  const groups = screen.getAllByRole("button", { name: "Ran commands" });
  expect(groups).toHaveLength(3);
  await user.click(groups[1]!);
  await user.click(screen.getByRole("button", { name: "Ran check 1-0" }));
  expect(screen.getByText("Output 1-0")).toBeVisible();
  expect(screen.queryByText("Output 0-0")).toBeNull();
  expect(screen.queryByText("Output 2-0")).toBeNull();

  await user.click(parent);
  expect(screen.queryByText("Output 1-0")).toBeNull();
  expect(screen.getByText("Implemented compact work blocks.")).toBeVisible();
  await user.click(parent);
  expect(screen.getByText("Output 1-0")).toBeVisible();
});


it("loads latest history first, pages backward, and bounds mounted message rows", async () => {
  const all = Array.from({length:200},(_,i)=>saved(`v-${i}`,{type:'user-text'},`History ${i}`,i+1));
  const history = vi.spyOn(workspaceApi, 'historyPage').mockImplementation(async (_id, options) => {
    const matching=all.filter(i=>options?.before===undefined || i.seq<options.before);
    const items=matching.slice(-100);
    return {items,nextAfter:items[items.length-1]?.seq ?? 0,nextBefore:items[0]?.seq ?? null,hasMore:matching.length>100};
  });
  const {container} = render(<ThreadView sessionId="long" projectId="p" projectName="Example" onFile={()=>{}} />);
  const earlier = await screen.findByRole('button',{name:'Load earlier messages'});
  expect(history).toHaveBeenCalledWith('long',{});
  expect(container.querySelectorAll('[data-message-id]').length).toBeLessThan(40);
  await userEvent.click(earlier);
  expect(history).toHaveBeenCalledWith('long',{before:101});
  expect(await screen.findByRole('button',{name:'Return to latest messages'})).toBeVisible();
});

it("restores formatted file and note references in saved user history", async () => {
  vi.spyOn(workspaceApi, "chat").mockResolvedValue([saved("rich-user", {type:"user-text"}, "**Review** @[Source](brigadier-attachment:file-id) and @[Spec](brigadier-note:note-id)", 1)]);
  const source = vi.spyOn(peerApi,"attachment").mockResolvedValue({metadata:{id:"file-id",projectId:"p",name:"source.ts",mediaType:"text/plain",size:5,createdAt:0},base64:btoa("exact")});
  const onFile=vi.fn();
  const props={sessionId:"idle",projectId:"p",projectName:"Example",onFile};
  const view=render(<ThreadView {...props}/>);
  expect((await screen.findByText("Review")).tagName).toBe("STRONG");
  view.unmount();render(<ThreadView {...props}/>);
  await userEvent.click(await screen.findByRole("button",{name:"Spec"}));
  expect(onFile).toHaveBeenCalledWith("brigadier-note:note-id");
  await userEvent.click(screen.getByRole("button",{name:"Source"}));
  await screen.findByTitle("Preview attachment");
  expect(source).toHaveBeenCalledWith("p","file-id");
  await userEvent.click(screen.getByTitle("Preview attachment"));
  expect(await screen.findByText("exact",{selector:"pre"})).toBeVisible();
});

it("keeps a pending approval beside its exact requested tool action", async () => {
  const { Approvals } = await import('./Approvals');
  vi.spyOn(workspaceApi, "chat").mockResolvedValue([
    saved("user", {type:"user-text"}, "Inspect the workspace", 1),
    saved("matching-call", {type:"tool-call",name:"Bash"}, '{"command":"pwd"}', 2),
    saved("other-call", {type:"tool-call",name:"Read"}, '{"path":"README"}', 3),
  ]);
  const requests = <Approvals approvals={[{projectId:'p',projectName:'Example',elsewhere:false,approval:{requestId:'approval-1',sessionId:'s',openedAtMs:10,expired:false,kind:{type:'tool-permission',tool_name:'Bash',input_excerpt:'pwd',suggestions:[],tool_call_id:'matching-call'}}}]} onRespond={vi.fn()} onDismiss={vi.fn()} />;
  const view = render(<ThreadView sessionId="s" projectId="p" projectName="Example" onFile={vi.fn()} requests={requests} />);
  await screen.findByRole('button',{name:'Allow'});
  const card = document.getElementById('approval-approval-1');
  const call = view.container.querySelector('[data-trace-id="matching-call"]');
  expect(card?.closest('.approvals')?.previousElementSibling).toBe(call);
  expect(screen.getAllByRole('button',{name:'Allow'})).toHaveLength(1);
});

it("restores confirmed approval receipts beside action output after reload", async () => {
  const { approvalHistoryApi } = await import('./approvalHistory');
  vi.spyOn(approvalHistoryApi,'load').mockResolvedValue([{request_id:'resolved',session_id:'s',opened_at_ms:1,expired:false,resolved:true,decision:{type:'allow',updated_input:null,updated_permissions:[]},kind:{type:'tool-permission',tool_name:'Bash',input_excerpt:'exit 1',suggestions:[],tool_call_id:'approved-call'}}]);
  vi.spyOn(workspaceApi, "chat").mockResolvedValue([
    saved("user", {type:"user-text"}, "Run the check", 1),
    saved("approved-call", {type:"tool-call",name:"Bash"}, '{"command":"exit 1"}', 2),
    saved("failure", {type:"tool-result",tool_call_id:"approved-call",is_error:true}, 'Command exited with code 1', 3),
  ]);
  const view = render(<ThreadView sessionId="s" projectId="p" projectName="Example" onFile={vi.fn()} />);
  await screen.findByText('Approved · Bash');
  expect(document.getElementById('approval-resolved')?.previousElementSibling).toBe(view.container.querySelector('[data-trace-id="approved-call"]'));
  expect(screen.queryByRole('button',{name:'Allow'})).toBeNull();
});

it("opens a saved agent-session reference without treating it as a file", async () => {
  vi.spyOn(workspaceApi, "chat").mockResolvedValue([saved("user", {type:"user-text"}, "Read @[Research](brigadier-session:research-id)", 1)]);
  const onFile = vi.fn(), onSelectSession = vi.fn();
  render(<ThreadView sessionId="s" projectId="p" projectName="Example" onFile={onFile} onSelectSession={onSelectSession} />);
  await userEvent.click(await screen.findByRole('button',{name:'Research'}));
  expect(onSelectSession).toHaveBeenCalledWith('research-id');
  expect(onFile).not.toHaveBeenCalled();
});

it("expands a collapsed ancestor so a nested pending approval is reachable", async () => {
  const { Approvals } = await import('./Approvals');
  vi.spyOn(workspaceApi, "chat").mockResolvedValue([
    saved("user", {type:"user-text"}, "Delegate review", 1),
    saved("agent-call", {type:"tool-call",name:"Agent"}, '{"description":"Review"}', 2),
    {...saved("nested-call", {type:"tool-call",name:"Bash"}, '{"command":"pwd"}', 3),parent_id:'agent-call'},
  ]);
  const requests = <Approvals approvals={[{projectId:'p',projectName:'Example',elsewhere:false,approval:{requestId:'nested-approval',sessionId:'s',openedAtMs:10,expired:false,kind:{type:'tool-permission',tool_name:'Bash',input_excerpt:'pwd',suggestions:[],tool_call_id:'nested-call'}}}]} onRespond={vi.fn()} onDismiss={vi.fn()} />;
  render(<ThreadView sessionId="s" projectId="p" projectName="Example" onFile={vi.fn()} requests={requests} />);
  await waitFor(() => expect(screen.getByRole('button',{name:'Allow'})).toBeVisible());
  await waitFor(() => expect(document.querySelector('[data-trace-id="agent-call"] #approval-nested-approval')).toBeVisible());
});

// Phase 4 work item 8. `TranscriptRuntime` used to build the read-only message array with
// `m.content.filter(p => p.type === 'text')`, so every non-text part — which since phase 4 is
// every work row, every notice and every changed-files card — drew nothing in the nested
// `ThreadView` that `SubagentsPanel` mounts for a selected worker, and in every archived
// session. The turn header and the command row below are that dropped content.
it('renders the full worker transcript with read-only assistant-ui scope',async()=>{
 const user = userEvent.setup();
 vi.spyOn(workspaceApi,'chat').mockResolvedValue(transcript);
 const peers={origins:{idle:'root'},subagents:{idle:'root'},titles:{},closed:[],messages:[],requests:[]};
 const view=render(<ThreadView sessionId="idle" projectId="p" projectName="Example" peers={peers} onFile={()=>{}}/>);
 expect(await screen.findByText(/The command failed\. Open/)).toBeVisible();
 const turn = screen.getByRole('button',{name:/Worked/});
 await user.click(turn);
 expect(view.container.querySelector('[data-trace-id="call"]')).not.toBeNull();
 expect(screen.getByRole('button',{name:/Ran git diff/})).toBeVisible();
 expect(screen.queryByRole('button',{name:'Edit message'})).toBeNull();
});

it("shows the loading state until saved history arrives, then the transcript", async () => {
  let deliver!: (items: ChatItem[]) => void;
  vi.spyOn(workspaceApi, "chat").mockImplementation(
    () => new Promise<ChatItem[]>((resolve) => { deliver = resolve; }),
  );
  render(<ThreadView sessionId="idle" projectId="p" projectName="Example" onFile={() => {}} />);
  expect(await screen.findByText("Loading conversation…")).toBeVisible();
  deliver(transcript);
  expect(await screen.findByText(/The command failed/)).toBeVisible();
  expect(screen.queryByText("Loading conversation…")).toBeNull();
});

it("restores a saved scroll position once per keyed mount, not on every history revision", async () => {
  localStorage.setItem("brigadier:scroll:idle", JSON.stringify({ top: 120, following: false }));
  vi.spyOn(workspaceApi, "chat").mockImplementation(async (_id, after) =>
    transcript.filter((i) => i.seq > after),
  );
  const props = { projectId: "p", projectName: "Example", onFile: vi.fn() };
  const view = render(<ThreadView {...props} sessionId="idle" />);
  await screen.findByText(/The command failed/);
  const viewport = view.container.querySelector<HTMLElement>(".aui-viewport")!;
  expect(viewport.scrollTop).toBe(120);
  // A revision reload re-enters the loading state without a keyed remount; the reader's own
  // position must survive it.
  viewport.scrollTop = 300;
  view.rerender(<ThreadView {...props} sessionId="idle" revision={1} />);
  await waitFor(() => expect(screen.getByText(/The command failed/)).toBeVisible());
  expect(view.container.querySelector(".aui-viewport")).toBe(viewport);
  expect(viewport.scrollTop).toBe(300);
});

it("keeps a pending approval from expanding the work rows that did not request it", async () => {
  const { Approvals } = await import('./Approvals');
  vi.spyOn(workspaceApi, "chat").mockResolvedValue([
    ...transcript,
    saved("later-user", { type: "user-text" }, "Now print the directory", 7),
    saved("later-call", { type: "tool-call", name: "Bash" }, '{"command":"pwd"}', 8),
  ]);
  const requests = <Approvals approvals={[{projectId:'p',projectName:'Example',elsewhere:false,approval:{requestId:'later-approval',sessionId:'idle',openedAtMs:10,expired:false,kind:{type:'tool-permission',tool_name:'Bash',input_excerpt:'pwd',suggestions:[],tool_call_id:'later-call'}}}]} onRespond={vi.fn()} onDismiss={vi.fn()} />;
  const view = render(<ThreadView sessionId="idle" projectId="p" projectName="Example" onFile={vi.fn()} requests={requests} />);
  await screen.findByRole('button', { name: 'Allow' });
  expect(screen.getAllByRole('button', { name: 'Allow' })).toHaveLength(1);
  expect(view.container.querySelector('[data-message-id="work:user"]')?.contains(document.getElementById('approval-later-approval'))).toBe(false);
  expect(screen.getByRole('button', { name: /Worked/ })).toHaveAttribute('aria-expanded', 'false');
  expect(screen.queryByText("I’ll inspect the diff.")).toBeNull();
});

it("greets by display name only while no session is open", async () => {
  const load = vi.spyOn(workbenchApi, "load").mockResolvedValue({
    notes: [], global: defaultSettings, projects: {}, displayName: "Ada",
  });
  vi.spyOn(workspaceApi, "chat").mockResolvedValue(transcript);
  const props = { projectId: "p", projectName: null, onFile: vi.fn() };
  const view = render(<ThreadView {...props} sessionId="idle" />);
  await screen.findByText(/The command failed/);
  expect(screen.queryByRole("heading")).toBeNull();
  // An open transcript reads the workbench once, for the task policy panel. The greeting is not
  // a second reason to round-trip, nor to re-render every mounted row when the workbench changes.
  expect(load).toHaveBeenCalledTimes(1);
  view.rerender(<ThreadView {...props} sessionId={null} />);
  expect(await screen.findByRole("heading", { name: "What will you build, Ada?" })).toBeVisible();
});

it("swaps the greeting for the welcome screen when no project is selected", async () => {
  const props = { projectId: null, projectName: null, onFile: vi.fn() };
  render(<ThreadView {...props} sessionId={null} />);
  expect(screen.getByRole("img", { name: "Brigadier" })).toBeVisible();
  // `WelcomeScreen` dropped its "New chat" row and gained a heading on 2026-09-11 (projectless
  // chats): the global new chat is the sidebar button and ⌘N, and the welcome screen offers only
  // the two actions that are not a chat. Kept in step with `WelcomeScreen.test.tsx`.
  for (const title of ["New project", "Notepad"])
    expect(screen.getByRole("button", { name: new RegExp(title) })).toBeVisible();
  expect(screen.queryByRole("button", { name: /New chat/ })).toBeNull();
  expect(screen.getByRole("heading", { name: "Chat with Brigadier" })).toBeVisible();
});
