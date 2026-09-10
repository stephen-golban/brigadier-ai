import {
  initialize,
  getService,
  IViewsService,
  IFileService,
  IEditorService,
} from "@codingame/monaco-vscode-api/services";
import views, {
  renderSidebarPart,
  renderEditorPart,
} from "@codingame/monaco-vscode-views-service-override";
import search from "@codingame/monaco-vscode-search-service-override";
import theme from "@codingame/monaco-vscode-theme-service-override";
import configuration, {
  initUserConfiguration,
  reinitializeWorkspace,
} from "@codingame/monaco-vscode-configuration-service-override";
import models from "@codingame/monaco-vscode-model-service-override";
import languages from "@codingame/monaco-vscode-languages-service-override";
import dialogs from "@codingame/monaco-vscode-dialogs-service-override";
import "@codingame/monaco-vscode-theme-defaults-default-extension";
import "@codingame/monaco-vscode-theme-seti-default-extension";
import { ISearchService } from "@codingame/monaco-vscode-api/vscode/vs/workbench/services/search/common/search.service";
import { SearchProviderType } from "@codingame/monaco-vscode-api/vscode/vs/workbench/services/search/common/search";
import { SearchEditorInputTypeId } from "@codingame/monaco-vscode-api/vscode/vs/workbench/contrib/searchEditor/browser/constants";
import { registerServiceInitializePreParticipant } from "@codingame/monaco-vscode-api/lifecycle";
import { IDecorationsService } from "@codingame/monaco-vscode-api/vscode/vs/workbench/services/decorations/common/decorations.service";
import { Event } from "@codingame/monaco-vscode-api/vscode/vs/base/common/event";
import { QueryBuilder } from "@codingame/monaco-vscode-api/vscode/vs/workbench/services/search/common/queryBuilder";
import { ISCMService } from "@codingame/monaco-vscode-api/vscode/vs/workbench/contrib/scm/common/scm.service";
import { ChangedFilesIndex } from "./changedFiles";
import type { SearchView } from "@codingame/monaco-vscode-api/vscode/vs/workbench/contrib/search/browser/searchView";
import {
  WorkspaceFiles,
  rootUri,
  relativePath,
  searchProvider,
} from "./workspace";
import { bindingKey, type PanelBinding } from "./types";
import "./panels.css";

// VS Code services are process-wide singletons and cannot be initialized twice by HMR.
if (import.meta.hot) import.meta.hot.accept(() => window.location.reload());

let startup: Promise<void> | undefined;
let workspaceKey: string | undefined;
let attachment: { dispose(): void } | undefined;
let owner: HTMLElement | undefined;
let generation = 0;
let switchQueue = Promise.resolve();
const files = new WorkspaceFiles();
const changedFiles = new ChangedFilesIndex();
let runtimeRoot: HTMLDivElement;

async function start(binding: PanelBinding) {
  runtimeRoot = document.createElement("div");
  runtimeRoot.className = "brigadier-vscode-overlays";
  document.body.append(runtimeRoot);
  const style = getComputedStyle(document.documentElement);
  const color = (name: string, fallback: string) =>
    style.getPropertyValue(`--color-${name}`).trim() || fallback;
  await initUserConfiguration(
    JSON.stringify({
      "workbench.colorTheme": "Default Dark Modern",
      "workbench.iconTheme": "vs-seti",
      "workbench.startupEditor": "none",
      "workbench.tips.enabled": false,
      "workbench.activityBar.location": "hidden",
      "window.menuBarVisibility": "hidden",
      "workbench.statusBar.visible": false,
      "window.commandCenter": false,
      "search.searchOnType": true,
      "search.searchOnTypeDebouncePeriod": 250,
      "search.showLineNumbers": false,
      "search.smartCase": false,
      "editor.fontFamily": style.getPropertyValue("--font-mono").trim(),
      "editor.fontSize": 13,
      "workbench.colorCustomizations": {
        "sideBar.background": color("canvas", "#181818"),
        "sideBar.foreground": color("text", "#e3e3e3"),
        "sideBarTitle.foreground": color("text", "#e3e3e3"),
        "sideBarSectionHeader.background": color("canvas", "#181818"),
        "sideBarSectionHeader.foreground": color("text", "#e3e3e3"),
        "sideBarSectionHeader.border": "#00000000",
        "editor.background": color("canvas", "#181818"),
        "editor.foreground": color("text", "#e3e3e3"),
        "input.background": color("input", "#2a2a2a"),
        "input.foreground": color("text", "#e3e3e3"),
        "input.border": "#00000000",
        "input.placeholderForeground": color("text-tertiary", "#7f7f7f"),
        "button.background": color("attention", "#3b82f6"),
        "button.foreground": "#ffffff",
        "button.hoverBackground": "#5291f7",
        "badge.background": color("attention", "#3b82f6"),
        "badge.foreground": "#ffffff",
        // Owner decision, restated 2026-09-11: no visible focus indicator anywhere
        // (`src/focus-reset.css`). The workbench paints these from the theme, not from a
        // stylesheet the app can reach, so they are switched off here. `#00000000` is how a
        // VS Code colour customisation is disabled.
        // `input.border` above is a RESTING border and is already transparent for its own
        // reasons; `sideBarSectionHeader.border` likewise. Only focus ids are listed here.
        focusBorder: "#00000000",
        contrastBorder: "#00000000",
        contrastActiveBorder: "#00000000",
        "list.focusOutline": "#00000000",
        "list.focusAndSelectionOutline": "#00000000",
        "list.inactiveFocusOutline": "#00000000",
        "list.activeSelectionBackground": "#ffffff14",
        "list.inactiveSelectionBackground": "#ffffff14",
        "list.hoverBackground": "#ffffff0d",
        "list.activeSelectionForeground": color("text", "#e3e3e3"),
        "menu.background": color("sidebar", "#202020"),
        "menu.foreground": color("text", "#e3e3e3"),
        "menu.selectionBackground": color("attention", "#3b82f6"),
        "gitDecoration.modifiedResourceForeground": color(
          "attention",
          "#3b82f6",
        ),
        "gitDecoration.untrackedResourceForeground": color("ok", "#74b58a"),
      },
    }),
  );
  files.register(binding);
  changedFiles.update(binding);
  // The application owns file tabs. Preserve VS Code's parsed filters, then let our
  // search provider apply the application's open-file list instead of VS Code's empty editor group.
  const buildTextQuery = QueryBuilder.prototype.text;
  QueryBuilder.prototype.text = function (pattern, folders, options) {
    const query = buildTextQuery.call(
      this,
      pattern,
      folders,
      options?.onlyOpenEditors
        ? { ...options, onlyOpenEditors: false }
        : options,
    );
    if (options?.onlyOpenEditors) query.onlyOpenEditors = true;
    return query;
  };
  registerServiceInitializePreParticipant(async (accessor) => {
    accessor.get(IFileService).registerProvider("brigadier-workspace", files);
  });
  await initialize(
    {
      [ISCMService.toString()]: changedFiles,
      ...configuration(),
      ...models(),
      ...languages(),
      ...views(async (model, options) => {
        const uri = model.object.textEditorModel.uri;
        if (uri.scheme === "brigadier-workspace") {
          const target = files.binding(uri);
          const selection = (
            options as { selection?: { startLineNumber?: number } } | undefined
          )?.selection;
          target.onOpen(
            relativePath(uri),
            "file",
            false,
            selection?.startLineNumber,
          );
          model.dispose();
        }
        return undefined;
      }),
      ...search(),
      ...theme(),
      ...dialogs(),
    },
    runtimeRoot,
    {
      workspaceProvider: {
        workspace: { folderUri: rootUri(binding) },
        trusted: true,
        async open() {
          return false;
        },
      },
      developmentOptions: { logLevel: 4 },
    },
  );
  (await getService(IDecorationsService)).registerDecorationsProvider({
    label: "Git",
    onDidChange: Event.map(files.changed.event, (changes) =>
      changes.map((change) => change.resource),
    ),
    provideDecorations(uri) {
      if (uri.scheme !== "brigadier-workspace") return undefined;
      const change = files
        .binding(uri)
        .status?.changes.find((change) => change.path === relativePath(uri));
      if (!change) return undefined;
      const code =
        change.index === "?" ? "U" : change.worktree.trim() || change.index;
      return {
        letter: code,
        color:
          code === "U" || code === "A"
            ? "gitDecoration.untrackedResourceForeground"
            : "gitDecoration.modifiedResourceForeground",
        bubble: true,
      };
    },
  });
  const searchService = await getService(ISearchService);
  const provider = searchProvider(files);
  searchService.registerSearchResultProvider(
    "brigadier-workspace",
    SearchProviderType.text,
    provider,
  );
  searchService.registerSearchResultProvider(
    "brigadier-workspace",
    SearchProviderType.file,
    provider,
  );
  // Keep normal file navigation in the application, including links from the search editor.
  const editorService = await getService(IEditorService);
  const originalOpen = editorService.openEditor.bind(editorService);
  editorService.openEditor = ((
    input: Parameters<typeof editorService.openEditor>[0],
    ...args: unknown[]
  ) => {
    // Both the toolbar and result links can create a Search Editor through different commands.
    if (input && "typeId" in input && input.typeId === SearchEditorInputTypeId)
      openSearchEditor();
    const resource = input && "resource" in input ? input.resource : undefined;
    if (resource?.scheme === "brigadier-workspace") {
      const target = files.binding(resource);
      const options =
        "options" in input
          ? (input.options as { selection?: { startLineNumber: number } })
          : undefined;
      target.onOpen(
        relativePath(resource),
        "file",
        false,
        options?.selection?.startLineNumber,
      );
      return Promise.resolve(undefined);
    }
    return (originalOpen as (...args: unknown[]) => unknown)(input, ...args);
  }) as typeof editorService.openEditor;
}

let editorOverlay: HTMLDivElement | undefined;
function openSearchEditor() {
  if (editorOverlay) {
    editorOverlay.hidden = false;
    return;
  }
  editorOverlay = document.createElement("div");
  editorOverlay.className = "brigadier-search-editor monaco-workbench";
  editorOverlay.setAttribute("role", "dialog");
  editorOverlay.setAttribute("aria-label", "Search Editor");
  const close = document.createElement("button");
  close.className = "brigadier-search-editor-close";
  close.textContent = "Close Search Editor";
  close.onclick = () => {
    editorOverlay!.hidden = true;
    owner?.focus();
  };
  const content = document.createElement("div");
  content.className = "brigadier-search-editor-content";
  editorOverlay.append(close, content);
  document.body.append(editorOverlay);
  renderEditorPart(content);
  editorOverlay.addEventListener("keydown", (event) => {
    if (
      event.key === "Escape" &&
      !document.querySelector(
        ".quick-input-widget:not([style*='display: none'])",
      )
    )
      close.click();
  });
}

export function mountPanels(host: HTMLElement, binding: PanelBinding) {
  const turn = ++generation;
  owner = host;
  startup ??= start(binding);
  switchQueue = switchQueue
    .catch(() => {})
    .then(async () => {
      await startup;
      if (turn !== generation) return;
      const differentWorkspace = workspaceKey !== bindingKey(binding);
      const viewService = await getService(IViewsService);
      const searchView = viewService.getViewWithId<SearchView>(
        "workbench.view.search",
      );
      changedFiles.update(binding);
      files.refresh(binding);
      if (differentWorkspace) {
        searchView?.clearSearchResults(false);
        await reinitializeWorkspace({
          id: bindingKey(binding),
          uri: rootUri(binding),
        });
        workspaceKey = bindingKey(binding);
        if (turn !== generation) return;
      }
      attachment?.dispose();
      attachment = renderSidebarPart(host);
      await viewService.openView("workbench.view.search", false);
      if (differentWorkspace)
        searchView?.triggerQueryChange({ preserveFocus: true });
    });
  return switchQueue;
}

export function updatePanels(host: HTMLElement, binding: PanelBinding) {
  files.register(binding);
  if (owner === host) {
    changedFiles.update(binding);
    files.refresh(binding);
  }
}
export function unmountPanels(host: HTMLElement) {
  if (owner !== host) return;
  generation++;
  owner = undefined;
  attachment?.dispose();
  attachment = undefined;
  if (editorOverlay) editorOverlay.hidden = true;
}
