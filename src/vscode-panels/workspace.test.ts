import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CancellationTokenSource } from "@codingame/monaco-vscode-api/vscode/vs/base/common/cancellation";
import { URI } from "@codingame/monaco-vscode-api/vscode/vs/base/common/uri";
import {
  QueryType,
  type ITextQuery,
} from "@codingame/monaco-vscode-api/vscode/vs/workbench/services/search/common/search";
import { workspaceApi } from "../workspaceApi";
import { workbenchApi } from "../workbenchApi";
import { WorkspaceFiles, fileUri, rootUri, searchProvider } from "./workspace";
import type { PanelBinding } from "./types";
import { ChangedFilesIndex } from "./changedFiles";

const binding = (sessionId: string | null): PanelBinding => ({
  context: { projectId: "p", sessionId },
  root: "/repo",
  mode: "search",
  revision: 0,
  status: null,
  openPaths: ["src/open.ts"],
  refresh: vi.fn(),
  onOpen: vi.fn(),
  onError: vi.fn(),
});
beforeEach(() => {
  vi.spyOn(workspaceApi, "file").mockResolvedValue({
    path: "a.ts",
    content: "before",
    truncated: false,
  });
  vi.spyOn(workbenchApi, "save").mockResolvedValue(undefined);
  vi.spyOn(workbenchApi, "search").mockResolvedValue({
    hits: [
      {
        path: "src/open.ts",
        line: 2,
        column: 3,
        endColumn: 8,
        endLine: 2,
        text: "😀needle",
      },
    ],
    replacements: [],
    files: 1,
    truncated: false,
  });
});
afterEach(() => vi.restoreAllMocks());
describe("VS Code workspace adapter", () => {
  it("keeps Search's read-only changed-files index scoped to the active session", () => {
    const index = new ChangedFilesIndex(),
      first = binding("one"),
      second = binding("two");
    first.status = {
      branch: "main",
      changes: [{ path: "a.ts", index: " ", worktree: "M" }],
    };
    const updated = vi.fn();
    index.repositories[0].provider.onDidChangeResources(updated);
    index.update(first);
    expect(
      index.repositories[0].provider.groups[0].resources[0].sourceUri.toString(),
    ).toBe(fileUri(first, "a.ts").toString());
    index.update(first);
    expect(updated).toHaveBeenCalledTimes(1);
    index.update(second);
    expect(index.repositories[0].provider.groups[0].resources).toEqual([]);
    expect(updated).toHaveBeenCalledTimes(2);
  });
  it("provides surrounding lines for the Search Editor without duplicating matching lines", async () => {
    const files = new WorkspaceFiles(),
      target = binding(null);
    files.register(target);
    vi.mocked(workspaceApi.file).mockResolvedValue({
      path: "src/open.ts",
      content: "before\n😀needle\nafter",
      truncated: false,
    });
    const result = await searchProvider(files).textSearch({
      type: QueryType.Text,
      contentPattern: { pattern: "needle" },
      folderQueries: [{ folder: rootUri(target) }],
      surroundingContext: 1,
    });
    expect(result.results[0].results).toEqual(
      expect.arrayContaining([
        { text: "before", lineNumber: 1 },
        { text: "after", lineNumber: 3 },
      ]),
    );
    expect(result.results[0].results).toHaveLength(3);
  });
  it("keeps read/write operations bound to the originating session after another workspace opens", async () => {
    const files = new WorkspaceFiles(),
      first = binding("one"),
      second = binding("two");
    files.register(first);
    const uri = fileUri(first, "a.ts");
    await files.readFile(uri);
    files.register(second);
    await files.writeFile(uri, new TextEncoder().encode("after"));
    expect(workbenchApi.save).toHaveBeenCalledWith(
      first.context,
      "a.ts",
      "after",
      "before",
    );
    expect(second.refresh).not.toHaveBeenCalled();
    await expect(
      files.writeFile(
        fileUri(second, "a.ts"),
        new TextEncoder().encode("after"),
      ),
    ).rejects.toThrow("Reload");
  });
  it("refuses truncated files instead of treating the truncated content as a full before-image", async () => {
    const files = new WorkspaceFiles(),
      target = binding(null);
    files.register(target);
    vi.mocked(workspaceApi.file).mockResolvedValue({
      path: "a.ts",
      content: "partial",
      truncated: true,
    });
    await expect(files.readFile(fileUri(target, "a.ts"))).rejects.toThrow(
      "limit",
    );
    expect(workbenchApi.save).not.toHaveBeenCalled();
  });
  it("preserves filter intersections, open-file scope, ignore flags and UTF-16 result ranges", async () => {
    const files = new WorkspaceFiles(),
      target = binding(null);
    files.register(target);
    const query: ITextQuery = {
      type: QueryType.Text,
      contentPattern: { pattern: "needle", isCaseSensitive: true },
      folderQueries: [
        {
          folder: URI.joinPath(rootUri(target), "src"),
          includePattern: { "*.ts": true },
          disregardIgnoreFiles: true,
        },
      ],
      includePattern: { "**/*open*": true },
      onlyOpenEditors: true,
    };
    const results = await searchProvider(files).textSearch(query);
    expect(workbenchApi.search).toHaveBeenCalledWith(
      target.context,
      expect.objectContaining({
        text: "needle",
        caseSensitive: true,
        include: "**/*open*",
        includeAll: ["src/**", "src/*.ts"],
        paths: ["src/open.ts"],
        useIgnoreFiles: false,
      }),
    );
    const match = results.results[0].results![0];
    expect(match).toHaveProperty("rangeLocations.0.source", {
      startLineNumber: 1,
      startColumn: 2,
      endLineNumber: 1,
      endColumn: 8,
    });
  });
  it("suppresses progress and results from a cancelled search", async () => {
    const files = new WorkspaceFiles(),
      target = binding(null);
    files.register(target);
    const source = new CancellationTokenSource();
    source.cancel();
    const progress = vi.fn();
    const result = await searchProvider(files).textSearch(
      {
        type: QueryType.Text,
        contentPattern: { pattern: "needle" },
        folderQueries: [{ folder: rootUri(target) }],
      },
      progress,
      source.token,
    );
    expect(result.results).toEqual([]);
    expect(progress).not.toHaveBeenCalled();
    source.dispose();
  });
});
