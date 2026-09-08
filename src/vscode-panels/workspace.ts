import {
  Event,
  Emitter,
} from "@codingame/monaco-vscode-api/vscode/vs/base/common/event";
import { URI } from "@codingame/monaco-vscode-api/vscode/vs/base/common/uri";
import { Disposable } from "@codingame/monaco-vscode-api/vscode/vs/base/common/lifecycle";
import {
  FileType,
  FileSystemProviderCapabilities,
  createFileSystemProviderError,
  FileSystemProviderErrorCode,
  FileChangeType,
  type IFileChange,
  type IFileSystemProviderWithFileReadWriteCapability,
} from "@codingame/monaco-vscode-api/vscode/vs/platform/files/common/files";
import {
  SearchRange,
  TextSearchMatch,
  type ISearchResultProvider,
  type IFileMatch,
} from "@codingame/monaco-vscode-api/vscode/vs/workbench/services/search/common/search";
import { workspaceApi } from "../workspaceApi";
import { workbenchApi } from "../workbenchApi";
import { bindingKey, type PanelBinding } from "./types";

/** A separate URI authority prevents buffers and late searches crossing session roots. */
export function rootUri(binding: PanelBinding) {
  return URI.from({
    scheme: "brigadier-workspace",
    authority: encodeURIComponent(bindingKey(binding)),
    path: "/",
  });
}
export function fileUri(binding: PanelBinding, path: string) {
  return URI.joinPath(rootUri(binding), path);
}
export const relativePath = (uri: URI) => uri.path.replace(/^\//, "");

export class WorkspaceFiles implements IFileSystemProviderWithFileReadWriteCapability {
  readonly capabilities =
    FileSystemProviderCapabilities.FileReadWrite |
    FileSystemProviderCapabilities.PathCaseSensitive;
  readonly onDidChangeCapabilities = Event.None;
  readonly changed = new Emitter<readonly IFileChange[]>();
  readonly onDidChangeFile = this.changed.event;
  readonly bindings = new Map<string, PanelBinding>();
  private readonly before = new Map<string, string>();
  private readonly versions = new Map<string, number>();
  register(binding: PanelBinding) {
    this.bindings.set(rootUri(binding).authority, binding);
  }
  binding(uri: URI) {
    const binding = this.bindings.get(uri.authority);
    if (!binding)
      throw createFileSystemProviderError(
        "Workspace is no longer open",
        FileSystemProviderErrorCode.Unavailable,
      );
    return binding;
  }
  watch() {
    return Disposable.None;
  }
  async stat(uri: URI) {
    const binding = this.binding(uri),
      path = relativePath(uri);
    const stat = await workspaceApi.stat(binding.context, path);
    return {
      type: stat.directory ? FileType.Directory : FileType.File,
      ctime: 0,
      mtime: stat.modified,
      size: stat.size,
    };
  }
  async readdir(uri: URI): Promise<[string, FileType][]> {
    const binding = this.binding(uri);
    return (await workspaceApi.entries(binding.context, relativePath(uri)))
      .filter((e) => e.name !== ".git" && e.name !== ".brigadier")
      .map((e) => [e.name, e.directory ? FileType.Directory : FileType.File]);
  }
  async readFile(uri: URI) {
    const binding = this.binding(uri);
    const file = await workspaceApi.file(binding.context, relativePath(uri));
    if (file.truncated)
      throw new Error("File exceeds the workspace editor limit");
    this.before.set(uri.toString(), file.content);
    return new TextEncoder().encode(file.content);
  }
  async writeFile(uri: URI, bytes: Uint8Array) {
    const binding = this.binding(uri),
      before = this.before.get(uri.toString());
    if (before === undefined)
      throw new Error("Reload the file before replacing its contents");
    const content = new TextDecoder().decode(bytes);
    await workbenchApi.save(
      binding.context,
      relativePath(uri),
      content,
      before,
    );
    this.before.set(uri.toString(), content);
    this.changed.fire([{ type: FileChangeType.UPDATED, resource: uri }]);
    binding.refresh();
  }
  async mkdir(): Promise<void> {
    throw new Error("Create folders from the file explorer");
  }
  async delete(): Promise<void> {
    throw new Error("Delete files from the file explorer");
  }
  async rename(): Promise<void> {
    throw new Error("Rename files from the file explorer");
  }
  refresh(binding: PanelBinding) {
    this.register(binding);
    const key = bindingKey(binding);
    if (this.versions.get(key) === binding.revision) return;
    this.versions.set(key, binding.revision);
    this.changed.fire(
      (binding.status?.changes ?? []).map((change) => ({
        type: FileChangeType.UPDATED,
        resource: fileUri(binding, change.path),
      })),
    );
  }
}

const globs = (expression: Record<string, unknown> | undefined) =>
  Object.entries(expression ?? {})
    .filter(([, enabled]) => enabled === true)
    .map(([pattern]) => pattern)
    .join(",");

export function searchProvider(files: WorkspaceFiles): ISearchResultProvider {
  return {
    async getAIName() {
      return undefined;
    },
    async clearCache() {},
    async fileSearch(query, token) {
      const results: IFileMatch[] = [];
      let limitHit = false;
      for (const folder of query.folderQueries) {
        const binding = files.binding(folder.folder);
        const found = await workspaceApi.findFiles(
          binding.context,
          query.filePattern ?? "",
        );
        if (token?.isCancellationRequested)
          return { results: [], messages: [] };
        limitHit ||= found.truncated;
        results.push(
          ...found.paths.map((path) => ({ resource: fileUri(binding, path) })),
        );
      }
      return { results, limitHit, messages: [] };
    },
    async textSearch(query, progress, token) {
      const results: IFileMatch[] = [];
      let limitHit = false;
      for (const folder of query.folderQueries) {
        const binding = files.binding(folder.folder);
        const pattern = query.contentPattern;
        const prefix = relativePath(folder.folder).replace(/\/$/, "");
        const scopedGlobs = (value: Record<string, unknown> | undefined) =>
          Object.entries(value ?? {})
            .filter(([, enabled]) => enabled === true)
            .map(([pattern]) => pattern)
            .map((pattern) => (prefix ? `${prefix}/${pattern}` : pattern))
            .join(",");
        const found = await workbenchApi.search(binding.context, {
          text: pattern.pattern,
          regex: !!pattern.isRegExp,
          caseSensitive: !!pattern.isCaseSensitive,
          wholeWord: !!pattern.isWordMatch,
          include: globs(query.includePattern),
          includeAll: [
            prefix ? `${prefix}/**` : "",
            scopedGlobs(folder.includePattern),
          ].filter(Boolean),
          exclude: [
            globs(query.excludePattern),
            ...(folder.excludePattern ?? []).map((e) => scopedGlobs(e.pattern)),
          ]
            .filter(Boolean)
            .join(","),
          replacement: null,
          useIgnoreFiles: !folder.disregardIgnoreFiles,
          paths: query.onlyOpenEditors ? binding.openPaths : undefined,
        });
        if (token?.isCancellationRequested)
          return { results: [], messages: [] };
        limitHit ||= found.truncated;
        const byFile = new Map<string, IFileMatch>();
        for (const hit of found.hits) {
          let file = byFile.get(hit.path);
          if (!file) {
            file = { resource: fileUri(binding, hit.path), results: [] };
            byFile.set(hit.path, file);
          }
          file.results!.push(
            new TextSearchMatch(
              hit.text,
              new SearchRange(
                hit.line - 1,
                hit.column - 1,
                (hit.endLine ?? hit.line) - 1,
                hit.endColumn ?? hit.column,
              ),
              query.previewOptions,
            ),
          );
        }
        for (const file of byFile.values()) {
          if (query.surroundingContext) {
            const preview = await workspaceApi.file(
              binding.context,
              relativePath(file.resource),
            );
            if (!preview.truncated) {
              const lines = preview.content.split(/\r?\n/);
              const matched = new Set<number>(),
                surrounding = new Set<number>();
              for (const hit of found.hits.filter(
                (hit) => hit.path === relativePath(file.resource),
              )) {
                for (
                  let line = hit.line - 1;
                  line < (hit.endLine ?? hit.line);
                  line++
                )
                  matched.add(line);
                const start = Math.max(
                  0,
                  hit.line - 1 - query.surroundingContext,
                );
                const end = Math.min(
                  lines.length,
                  (hit.endLine ?? hit.line) + query.surroundingContext,
                );
                for (let line = start; line < end; line++)
                  surrounding.add(line);
              }
              for (const line of [...surrounding].sort((a, b) => a - b)) {
                if (!matched.has(line))
                  file.results!.push({
                    text: lines[line],
                    lineNumber: line + 1,
                  });
              }
            }
          }
          if (token?.isCancellationRequested)
            return { results: [], messages: [] };
          results.push(file);
          progress?.(file);
        }
      }
      return { results, limitHit, messages: [] };
    },
  };
}
