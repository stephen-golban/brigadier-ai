vi.mock("../vscode-panels/runtime", () => ({ mountPanels: vi.fn().mockResolvedValue(undefined), updatePanels: vi.fn(), unmountPanels: vi.fn() }));
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { WorkspaceTools } from "./WorkspaceTools";
import { workspaceApi, type FileEntry } from "../workspaceApi";
import { defaultSettings, workbenchApi } from "../workbenchApi";

// The filename endpoint is being added independently; retain all other real APIs.
vi.mock("../workspaceApi", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../workspaceApi")>();
  return {
    ...actual,
    workspaceApi: { ...actual.workspaceApi, findFiles: vi.fn() },
  };
});

const context = { projectId: "project", sessionId: null };
const file = (path: string, directory = false): FileEntry => ({
  path,
  name: path.split("/").pop()!,
  directory,
});
const listings: Record<string, FileEntry[]> = {
  "": [
    file("node_modules", true),
    file("src", true),
    file("README.md"),
    file("package.json"),
  ],
  src: [
    file("src/components", true),
    file("src/App.tsx"),
    file("src/main.ts"),
    file("src/app.css"),
  ],
  "src/components": [file("src/components/Panel.tsx")],
};
const props = {
  context,
  root: "/projects/example",
  mode: "files" as const,
  status: {
    branch: "feature/files",
    changes: [{ path: "README.md", index: " ", worktree: "M" }],
  },
  revision: 0,
  refresh: vi.fn(),
  onOpen: vi.fn(),
  onNote: vi.fn(),
  onData: vi.fn(),
  data: { notes: [], projects: {}, global: { ...defaultSettings } },
  models: [],
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(workspaceApi.findFiles)
    .mockReset()
    .mockResolvedValue({ paths: [], truncated: false });
  vi.spyOn(workspaceApi, "entries").mockImplementation(
    async (_, path) => listings[path] ?? [],
  );
  vi.spyOn(workbenchApi, "gitDetails").mockResolvedValue({
    branches: ["main"],
    remotes: [],
    stashes: [],
    history: "",
  });
  vi.spyOn(workbenchApi, "gitAction").mockResolvedValue("");
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("WorkspaceTools Files", () => {
  it("shows only the filter and flat file rows, with one directory chevron and controlled selection", async () => {
    const user = userEvent.setup();
    const view = render(<WorkspaceTools {...props} selectedPath="README.md" />);
    const files = screen.getByRole("region", { name: "Files" });
    expect(within(files).getByPlaceholderText("Filter files…")).toBeVisible();
    expect(within(files).getByLabelText("Filter files")).toHaveClass(
      "rounded-[var(--radius-control)]",
    );
    expect(view.container.querySelector(".workspace-tool-body")).toHaveClass(
      "bg-canvas",
    );
    expect(screen.queryByText("Explorer")).not.toBeInTheDocument();
    expect(screen.queryByTitle(props.root)).not.toBeInTheDocument();
    expect(screen.queryByText(props.status.branch)).not.toBeInTheDocument();
    expect(view.container.querySelector(".workspace-mode-bar")).toBeNull();
    const src = await screen.findByRole("button", { name: "src" });
    expect(src.querySelectorAll("svg")).toHaveLength(1);
    expect(src.querySelector("svg")).toHaveClass(
      "transition-transform",
      "duration-200",
      "motion-reduce:transition-none",
    );
    expect(src).toHaveAttribute("aria-expanded", "false");
    const readme = screen.getByRole("button", { name: "README.md" });
    expect(readme).toHaveAttribute("aria-current", "page");
    expect(readme).toHaveClass("rounded-[var(--radius-row)]", "bg-selected");
    expect(readme.querySelector("svg")?.style.color).not.toBe(
      screen.getByRole("button", { name: "package.json" }).querySelector("svg")
        ?.style.color,
    );
    await user.click(readme);
    expect(props.onOpen).toHaveBeenCalledWith("README.md", "file");
    view.rerender(<WorkspaceTools {...props} selectedPath="package.json" />);
    expect(readme).not.toHaveAttribute("aria-current");
    expect(
      screen.getByRole("button", { name: "package.json" }),
    ).toHaveAttribute("aria-current", "page");
  });

  it("filters loaded filenames through collapsed ancestors without crawling, and restores expansion on Escape", async () => {
    const user = userEvent.setup();
    render(
      <WorkspaceTools {...props} selectedPath="src/components/Panel.tsx" />,
    );
    await user.click(await screen.findByRole("button", { name: "src" }));
    await user.click(await screen.findByRole("button", { name: "components" }));
    await screen.findByRole("button", { name: "Panel.tsx" });
    await user.click(screen.getByRole("button", { name: "src" }));
    const calls = vi.mocked(workspaceApi.entries).mock.calls.length;
    const filter = screen.getByRole("textbox", { name: "Filter files" });
    await user.type(filter, "  PANEL.TSX  ");
    expect(
      await screen.findByRole("button", { name: "Panel.tsx" }),
    ).toHaveAttribute("aria-current", "page");
    expect(screen.getByRole("button", { name: "src" })).toHaveAttribute(
      "aria-expanded",
      "true",
    );
    expect(
      screen.queryByRole("button", { name: "README.md" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "node_modules" }),
    ).not.toBeInTheDocument();
    expect(workspaceApi.entries).toHaveBeenCalledTimes(calls);
    expect(workspaceApi.entries).not.toHaveBeenCalledWith(
      context,
      "node_modules",
    );
    expect(workbenchApi.gitDetails).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "components" }));
    expect(
      screen.queryByRole("button", { name: "Panel.tsx" }),
    ).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "components" }));
    await user.click(screen.getByRole("button", { name: "Panel.tsx" }));
    expect(props.onOpen).toHaveBeenCalledWith(
      "src/components/Panel.tsx",
      "file",
    );
    await user.click(filter);
    await user.keyboard("{Escape}");
    expect(filter).toHaveValue("");
    expect(screen.getByRole("button", { name: "src" })).toHaveAttribute(
      "aria-expanded",
      "false",
    );
    expect(screen.getByRole("button", { name: "README.md" })).toBeVisible();
  });

  it("shows search progress, then an empty result, and restores browsing for whitespace", async () => {
    render(<WorkspaceTools {...props} />);
    await screen.findByRole("button", { name: "src" });
    fireEvent.change(screen.getByLabelText("Filter files"), {
      target: { value: "App.tsx" },
    });
    expect(screen.getByRole("status")).toHaveTextContent("Searching files…");
    expect(await screen.findByText("No matching files")).toBeVisible();
    expect(
      screen.queryByText(/Includes folders you’ve opened/),
    ).not.toBeInTheDocument();
    expect(workspaceApi.entries).toHaveBeenCalledTimes(1);
    fireEvent.change(screen.getByLabelText("Filter files"), {
      target: { value: "   " },
    });
    expect(screen.getByRole("button", { name: "src" })).toBeVisible();
  });

  it("refreshes visited folders while preserving expansion and removes stale filter results", async () => {
    const user = userEvent.setup();
    const view = render(<WorkspaceTools {...props} />);
    await user.click(await screen.findByRole("button", { name: "src" }));
    await screen.findByRole("button", { name: "App.tsx" });
    fireEvent.change(screen.getByLabelText("Filter files"), {
      target: { value: "App.tsx" },
    });
    vi.mocked(workspaceApi.entries).mockImplementation(async (_, path) =>
      path === "src" ? [file("src/Updated.tsx")] : (listings[path] ?? []),
    );
    view.rerender(<WorkspaceTools {...props} revision={1} />);
    await screen.findByText("No matching files");
    fireEvent.change(screen.getByLabelText("Filter files"), {
      target: { value: "" },
    });
    expect(screen.getByRole("button", { name: "src" })).toHaveAttribute(
      "aria-expanded",
      "true",
    );
    expect(screen.getByRole("button", { name: "Updated.tsx" })).toBeVisible();
    expect(
      screen.queryByRole("button", { name: "App.tsx" }),
    ).not.toBeInTheDocument();
  });

  it("finds unopened nested files by path, constructs ancestors, and highlights the selected result without listing folders", async () => {
    const user = userEvent.setup();
    vi.mocked(workspaceApi.findFiles).mockResolvedValue({
      paths: [
        "lib/deep/Widget.tsx",
        "lib/deep/Widget.tsx",
        "lib/deep/utils.ts",
      ],
      truncated: false,
    });
    render(<WorkspaceTools {...props} selectedPath="lib/deep/Widget.tsx" />);
    await screen.findByRole("button", { name: "src" });
    fireEvent.change(screen.getByLabelText("Filter files"), {
      target: { value: " LIB/DEEP " },
    });
    const result = await screen.findByRole("button", { name: "Widget.tsx" });
    expect(workspaceApi.findFiles).toHaveBeenCalledWith(context, "lib/deep");
    expect(screen.getByRole("button", { name: "lib" })).toHaveAttribute(
      "aria-expanded",
      "true",
    );
    expect(screen.getByRole("button", { name: "deep" })).toHaveAttribute(
      "aria-expanded",
      "true",
    );
    expect(screen.getAllByRole("button", { name: "Widget.tsx" })).toHaveLength(
      1,
    );
    expect(result).toHaveAttribute("aria-current", "page");
    expect(result).toHaveClass("bg-selected");
    await user.click(result);
    expect(props.onOpen).toHaveBeenCalledWith("lib/deep/Widget.tsx", "file");
    await user.click(screen.getByRole("button", { name: "deep" }));
    await user.click(screen.getByRole("button", { name: "deep" }));
    expect(workspaceApi.entries).toHaveBeenCalledTimes(1);
    fireEvent.keyDown(screen.getByLabelText("Filter files"), { key: "Escape" });
    expect(
      screen.queryByRole("button", { name: "lib" }),
    ).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "src" })).toHaveAttribute(
      "aria-expanded",
      "false",
    );
  });

  it("merges known ignored files by path and deduplicates API matches", async () => {
    const user = userEvent.setup();
    render(<WorkspaceTools {...props} />);
    await user.click(await screen.findByRole("button", { name: "src" }));
    await screen.findByRole("button", { name: "App.tsx" });
    vi.mocked(workspaceApi.findFiles).mockResolvedValue({
      paths: ["src/App.tsx"],
      truncated: false,
    });
    fireEvent.change(screen.getByLabelText("Filter files"), {
      target: { value: "SRC/" },
    });
    await screen.findByRole("button", { name: "main.ts" });
    expect(screen.getAllByRole("button", { name: "App.tsx" })).toHaveLength(1);
    expect(workspaceApi.entries).toHaveBeenCalledTimes(2);
    fireEvent.keyDown(screen.getByLabelText("Filter files"), { key: "Escape" });
    expect(screen.getByRole("button", { name: "src" })).toHaveAttribute(
      "aria-expanded",
      "true",
    );
  });

  it("debounces edits for 180ms and ignores an obsolete response during the next debounce", async () => {
    vi.useFakeTimers();
    let resolveOld!: (value: { paths: string[]; truncated: boolean }) => void;
    vi.mocked(workspaceApi.findFiles).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveOld = resolve;
        }),
    );
    render(<WorkspaceTools {...props} />);
    await act(async () => {});
    const filter = screen.getByLabelText("Filter files");
    fireEvent.change(filter, { target: { value: "o" } });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(100);
    });
    fireEvent.change(filter, { target: { value: "old" } });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(179);
    });
    expect(workspaceApi.findFiles).not.toHaveBeenCalled();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(workspaceApi.findFiles).toHaveBeenCalledExactlyOnceWith(
      context,
      "old",
    );
    fireEvent.change(filter, { target: { value: "new" } });
    await act(async () => {
      resolveOld({ paths: ["old.ts"], truncated: true });
    });
    expect(screen.getByRole("status")).toHaveTextContent("Searching files…");
    expect(
      screen.queryByRole("button", { name: "old.ts" }),
    ).not.toBeInTheDocument();
    vi.mocked(workspaceApi.findFiles).mockResolvedValue({
      paths: ["new.ts"],
      truncated: false,
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(180);
    });
    expect(screen.getByRole("button", { name: "new.ts" })).toBeVisible();
    expect(screen.queryByText(/Result limit reached/)).not.toBeInTheDocument();
    expect(workspaceApi.findFiles).toHaveBeenCalledTimes(2);
    fireEvent.change(filter, { target: { value: "cancel-before-request" } });
    fireEvent.keyDown(filter, { key: "Escape" });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(180);
    });
    expect(workspaceApi.findFiles).toHaveBeenCalledTimes(2);
  });

  it("ignores late success and failure after clearing the filter or changing context", async () => {
    vi.useFakeTimers();
    let resolveOld!: (value: { paths: string[]; truncated: boolean }) => void;
    let rejectOld!: (reason: Error) => void;
    vi.mocked(workspaceApi.findFiles)
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveOld = resolve;
          }),
      )
      .mockImplementationOnce(
        () =>
          new Promise((_, reject) => {
            rejectOld = reject;
          }),
      );
    const view = render(<WorkspaceTools {...props} />);
    await act(async () => {});
    fireEvent.change(screen.getByLabelText("Filter files"), {
      target: { value: "old" },
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(180);
    });
    fireEvent.keyDown(screen.getByLabelText("Filter files"), { key: "Escape" });
    await act(async () => {
      resolveOld({ paths: ["old.ts"], truncated: true });
    });
    expect(screen.getByRole("button", { name: "README.md" })).toBeVisible();
    expect(
      screen.queryByRole("button", { name: "old.ts" }),
    ).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Filter files"), {
      target: { value: "old" },
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(180);
    });
    const nextContext = { ...context, sessionId: "next" };
    view.rerender(<WorkspaceTools {...props} context={nextContext} />);
    await act(async () => {});
    fireEvent.change(screen.getByLabelText("Filter files"), {
      target: { value: "current" },
    });
    vi.mocked(workspaceApi.findFiles).mockResolvedValue({
      paths: ["current.ts"],
      truncated: false,
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(180);
    });
    await act(async () => {
      rejectOld(new Error("obsolete failure"));
    });
    expect(screen.getByRole("button", { name: "current.ts" })).toBeVisible();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(workspaceApi.findFiles).toHaveBeenLastCalledWith(
      nextContext,
      "current",
    );
  });

  it("shows capped results and reports search errors without claiming there are no matches", async () => {
    vi.mocked(workspaceApi.findFiles).mockResolvedValueOnce({
      paths: ["lib/result.ts"],
      truncated: true,
    });
    render(<WorkspaceTools {...props} />);
    fireEvent.change(screen.getByLabelText("Filter files"), {
      target: { value: "result" },
    });
    await screen.findByRole("button", { name: "result.ts" });
    expect(screen.getByRole("status")).toHaveTextContent(
      "Result limit reached. Refine your filter.",
    );
    vi.mocked(workspaceApi.findFiles).mockRejectedValueOnce(
      new Error("Search unavailable"),
    );
    fireEvent.change(screen.getByLabelText("Filter files"), {
      target: { value: "other" },
    });
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Search unavailable",
    );
    expect(screen.queryByText("No matching files")).not.toBeInTheDocument();
    expect(screen.queryByText(/Result limit reached/)).not.toBeInTheDocument();
  });

  it("keeps same-query results mounted and focused during revision refresh and response replacement", async () => {
    vi.useFakeTimers();
    vi.mocked(workspaceApi.findFiles).mockResolvedValueOnce({
      paths: ["src/App.tsx"],
      truncated: false,
    });
    const view = render(
      <WorkspaceTools {...props} selectedPath="src/App.tsx" />,
    );
    await act(async () => {});
    fireEvent.change(screen.getByLabelText("Filter files"), {
      target: { value: "app" },
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(180);
    });
    const row = screen.getByRole("button", { name: "App.tsx" });
    row.focus();

    let resolveRefresh!: (value: {
      paths: string[];
      truncated: boolean;
    }) => void;
    vi.mocked(workspaceApi.findFiles).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveRefresh = resolve;
        }),
    );
    view.rerender(
      <WorkspaceTools {...props} revision={1} selectedPath="src/App.tsx" />,
    );
    expect(screen.getByRole("button", { name: "App.tsx" })).toBe(row);
    expect(row).toHaveFocus();
    expect(screen.queryByText("Searching files…")).not.toBeInTheDocument();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(180);
    });
    expect(workspaceApi.findFiles).toHaveBeenCalledTimes(2);
    expect(screen.getByRole("button", { name: "App.tsx" })).toBe(row);
    expect(row).toHaveFocus();
    expect(row).toHaveAttribute("aria-current", "page");
    expect(screen.queryByText("Searching files…")).not.toBeInTheDocument();

    await act(async () => {
      resolveRefresh({
        paths: ["src/App.tsx", "src/Application.tsx"],
        truncated: false,
      });
    });
    expect(screen.getByRole("button", { name: "App.tsx" })).toBe(row);
    expect(row).toHaveFocus();
    expect(
      screen.getByRole("button", { name: "Application.tsx" }),
    ).toBeVisible();
  });

  it("keeps existing rows and focus while a revision refresh is pending", async () => {
    const user = userEvent.setup();
    const view = render(
      <WorkspaceTools {...props} selectedPath="src/App.tsx" />,
    );
    await user.click(await screen.findByRole("button", { name: "src" }));
    const row = await screen.findByRole("button", { name: "App.tsx" });
    row.focus();
    const pending: (() => void)[] = [];
    vi.mocked(workspaceApi.entries).mockImplementation(
      (_, path) =>
        new Promise((resolve) => {
          pending.push(() => resolve(listings[path] ?? []));
        }),
    );
    view.rerender(
      <WorkspaceTools {...props} revision={1} selectedPath="src/App.tsx" />,
    );
    expect(screen.getByRole("button", { name: "App.tsx" })).toBe(row);
    expect(row).toHaveFocus();
    expect(row).toHaveAttribute("aria-current", "page");
    expect(screen.queryByText("Loading files…")).not.toBeInTheDocument();
    await act(async () => {
      pending.forEach((resolve) => resolve());
    });
    expect(screen.getByRole("button", { name: "App.tsx" })).toBe(row);
    expect(row).toHaveFocus();
  });

  it("isolates filter, expansion, and pending listings when the workspace changes", async () => {
    let resolveOld!: (entries: FileEntry[]) => void;
    vi.mocked(workspaceApi.entries).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveOld = resolve;
        }),
    );
    const view = render(<WorkspaceTools {...props} />);
    expect(screen.getByRole("status")).toHaveTextContent("Loading files");
    fireEvent.change(screen.getByLabelText("Filter files"), {
      target: { value: "old" },
    });
    view.rerender(
      <WorkspaceTools
        {...props}
        context={{ ...context, sessionId: "new-session" }}
      />,
    );
    expect(screen.getByLabelText("Filter files")).toHaveValue("");
    await screen.findByRole("button", { name: "README.md" });
    await act(async () => {
      resolveOld([file("old.txt")]);
    });
    expect(
      screen.queryByRole("button", { name: "old.txt" }),
    ).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "src" })).toHaveAttribute(
      "aria-expanded",
      "false",
    );
  });

  it("reports load failures and recovers on refresh, including empty folders", async () => {
    vi.mocked(workspaceApi.entries).mockRejectedValueOnce(
      new Error("Cannot read folder"),
    );
    const view = render(<WorkspaceTools {...props} />);
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Cannot read folder",
    );
    expect(screen.queryByText("This folder is empty.")).not.toBeInTheDocument();
    vi.mocked(workspaceApi.entries).mockResolvedValue([]);
    view.rerender(<WorkspaceTools {...props} revision={1} />);
    expect(await screen.findByText("This folder is empty.")).toHaveAttribute(
      "role",
      "status",
    );
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });
});

describe("WorkspaceTools panel integration", () => {
  it("renders native Changes without loading VS Code, while Search still mounts its runtime", async () => {
    const runtime = await import("../vscode-panels/runtime");
    const view = render(<WorkspaceTools {...props} mode="changes" />);
    await act(async () => {});
    expect(runtime.mountPanels).not.toHaveBeenCalled();
    expect(screen.getByRole("textbox", { name: "Commit message" })).toBeInTheDocument();
    expect(screen.queryByText("Session changes")).not.toBeInTheDocument();
    expect(screen.queryByText("Apply to project")).not.toBeInTheDocument();
    expect(screen.queryByText("Review Working Changes")).not.toBeInTheDocument();
    view.rerender(<WorkspaceTools {...props} mode="search" visible={false} />);
    await act(async () => {});
    expect(runtime.mountPanels).not.toHaveBeenCalled();
    view.rerender(<WorkspaceTools {...props} mode="search" />);
    await act(async () => {});
    expect(runtime.mountPanels).toHaveBeenLastCalledWith(expect.any(HTMLElement), expect.objectContaining({ context, mode: "search" }));
    const binding = vi.mocked(runtime.mountPanels).mock.lastCall![1];
    binding.onOpen("src/App.tsx", "file", false, 3);
    expect(props.onOpen).toHaveBeenCalledWith("src/App.tsx", "file", false, 3);
    view.rerender(<WorkspaceTools {...props} mode="changes" />);
    expect(runtime.unmountPanels).toHaveBeenCalled();
  });
});
