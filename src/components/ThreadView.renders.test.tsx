/**
 * Render accounting for the transcript's rows.
 *
 * A passing suite says nothing about how much of the thread React re-ran, so this file counts it.
 * The two counters sit *below* the part renderers — `Markdown` for a prose row, `WorkTrace` for a
 * work row — so a row that bails out of rendering never reaches them; a count of 0 is the part
 * boundary holding, not a mock swallowing work. Both wrappers render the real component, so every
 * assertion below runs against the real thread.
 *
 * `docs/performance/rowscope-renders-2026-09-11.md` carries the before/after numbers this file
 * produced and the exact triggers.
 */
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ThreadView } from "./ThreadView";
import { workspaceApi, type ChatItem } from "../workspaceApi";

const { counts, state, listeners, cursor } = vi.hoisted(() => ({
  counts: { text: new Map<string, number>(), work: new Map<string, number>() },
  listeners: new Set<() => void>(),
  cursor: { value: "" },
  state: { sessions: { live: { busy: true } } },
}));
const bump = (map: Map<string, number>, key: string) =>
  map.set(key, (map.get(key) ?? 0) + 1);
/** Rows that ran a part renderer since the last `clear()`. */
const renderedRows = () =>
  [...counts.text.keys(), ...counts.work.keys()].length;
const clear = () => {
  counts.text.clear();
  counts.work.clear();
};

vi.mock("../feedStore", () => ({
  getState: () => state,
  getSessionCursor: () => cursor.value,
  subscribe: (listener: () => void) => {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
}));
vi.mock("../desktopApi", async (original) => ({
  ...(await original<typeof import("../desktopApi")>()),
  useSessionChanges: () => ({ turns: [], files: [] }),
}));
vi.mock("./Markdown", async (original) => {
  const [real, { createElement }, aui] = await Promise.all([
    original<typeof import("./Markdown")>(),
    import("react"),
    import("@assistant-ui/react"),
  ]);
  return {
    ...real,
    Markdown: (props: Parameters<typeof real.Markdown>[0]) => {
      // Counted per row, not per body: the message id is the row id (`rowMessage` sets it), and
      // reading it here keeps the fixture free to repeat a body. `optional` rather than `message`
      // because `Markdown` also renders outside a row — a peer card, a changed-files card.
      const id = aui.useAuiState((s) => s.optional.message?.id) ?? "outside-a-row";
      bump(counts.text, id);
      return createElement(real.Markdown, props);
    },
  };
});
vi.mock("./WorkTrace", async (original) => {
  const [real, { createElement }] = await Promise.all([
    original<typeof import("./WorkTrace")>(),
    import("react"),
  ]);
  return {
    ...real,
    WorkTrace: (props: Parameters<typeof real.WorkTrace>[0]) => {
      bump(counts.work, props.row.id);
      return createElement(real.WorkTrace, props);
    },
  };
});

const item = (
  id: string,
  seq: number,
  kind: ChatItem["kind"],
  body: string,
): ChatItem => ({
  session_id: "live",
  id,
  seq,
  at: 0,
  kind,
  body,
  parent_id: null,
});

/**
 * 40 rows of mixed parts: 12 finished turns (user row + work row + answer row), one lifecycle
 * notice, then an open turn whose answer is still streaming — 39 rows plus the notice. Under the
 * 60-row virtualisation threshold on purpose, so every row is mounted and countable.
 */
const TAIL = "a-live";
function feed(tail: string): ChatItem[] {
  const items: ChatItem[] = [];
  let seq = 0;
  for (let turn = 0; turn < 12; turn++) {
    items.push(item(`u${turn}`, ++seq, { type: "user-text" }, `Question ${turn}`));
    items.push(item(`c${turn}`, ++seq, { type: "tool-call", name: "Bash" }, `run ${turn}`));
    items.push(
      item(
        `r${turn}`,
        ++seq,
        { type: "tool-result", tool_call_id: `c${turn}`, is_error: false },
        `output ${turn}`,
      ),
    );
    items.push(item(`a${turn}`, ++seq, { type: "assistant-text" }, `Answer ${turn}`));
  }
  items.push(
    item("notice", ++seq, { type: "notice", level: "info", code: "compacted" }, "auto"),
  );
  items.push(item("u-live", ++seq, { type: "user-text" }, "Question live"));
  items.push(item(TAIL, ++seq, { type: "assistant-text" }, tail));
  return items;
}

let tail = "Live answer";
beforeEach(() => {
  tail = "Live answer";
  cursor.value = "";
  clear();
  vi.spyOn(workspaceApi, "chatTurns").mockResolvedValue([]);
  vi.spyOn(workspaceApi, "historyPage").mockImplementation(async (_id, options) => {
    const all = feed(tail);
    // A streaming body keeps its `seq`, so an update page carries the growing row back with the
    // rows above it unchanged — which is what `mergeHistory` preserves identity through.
    const items =
      options?.after === undefined
        ? all
        : all.filter((i) => i.seq > options.after! || i.id === TAIL);
    return {
      items,
      nextAfter: Math.max(0, ...all.map((i) => i.seq)),
      nextBefore: all[0]?.seq ?? null,
      hasMore: false,
    };
  });
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  listeners.clear();
  localStorage.clear();
});

const onFile = vi.fn();
const onEdit = vi.fn();
const props = {
  sessionId: "live",
  projectId: "p",
  projectName: "Example",
  onFile,
  onEdit,
};

/** Mount, hydrate, let the lazy markdown content settle, then start counting. */
async function mounted() {
  const view = render(<ThreadView {...props} requests={<button>Pending</button>} />);
  expect(await screen.findByText("Live answer")).toBeVisible();
  await act(async () => {});
  const mountedRows = renderedRows();
  clear();
  return { view, mountedRows };
}

it("re-renders no row when the transcript re-renders with every row unchanged", async () => {
  const { view, mountedRows } = await mounted();
  expect(mountedRows).toBe(39); // 26 prose rows + 13 work rows; the notice row has no counter.
  // A fresh `requests` element: `ThreadView`'s `memo` misses, `Transcript` renders, and not one
  // row's inputs changed.
  view.rerender(<ThreadView {...props} requests={<button>Pending</button>} />);
  await act(async () => {});
  expect(renderedRows()).toBe(0);
});

it("re-renders no row when a history poll delivers the same items", async () => {
  await mounted();
  // The live cursor moved, so the history hook re-reads and `setItems` a freshly merged array of
  // the same rows — what a running turn does every 100 ms.
  act(() => {
    cursor.value = "1";
    listeners.forEach((listener) => listener());
  });
  await waitFor(() =>
    expect(workspaceApi.historyPage).toHaveBeenCalledWith("live", { after: 51 }),
  );
  await act(async () => {});
  expect(renderedRows()).toBe(0);
});

it("re-renders only the streaming row when a delta extends the last answer", async () => {
  await mounted();
  tail = "Live answer with more tokens";
  act(() => {
    cursor.value = "2";
    listeners.forEach((listener) => listener());
  });
  expect(await screen.findByText("Live answer with more tokens")).toBeVisible();
  await act(async () => {});
  // One row, rendered twice: the runtime pushes its own update for the last message before the
  // new page commits, so that row's prose part runs once against the message the provider still
  // held and once against the new one. No work row and no other prose row ran at all — 38 of the
  // 39 counted rows sat the delta out.
  expect([...counts.work.keys()]).toEqual([]);
  expect([...counts.text.keys()]).toEqual([TAIL]);
  expect(counts.text.get(TAIL)).toBe(2);
  expect(renderedRows()).toBe(1);
});
