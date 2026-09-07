import { invoke } from "@tauri-apps/api/core";
import { desktop, type WorkspaceContext } from "./workspaceApi";
import { validateDisplayName } from "./name";
export { validateDisplayName } from "./name";
export interface Note {
  id: string;
  projectId: string | null;
  title: string;
  content: string;
  language: string;
  alwaysInclude: boolean;
  revision: number;
}
export interface CommitSettings {
  model: string;
  coAuthor: boolean;
  smartCommit: boolean;
  suggestSmartCommit: boolean;
  untracked: "mixed" | "separate" | "hidden";
}
export interface PeerSettings {
  createSessions: boolean;
  messages: boolean;
  manageChildren: boolean;
}
export const defaultPeerSettings: PeerSettings = {
  createSessions: true,
  messages: true,
  manageChildren: true,
};
export interface WorkbenchData {
  peers?: PeerSettings;
  projectPeers?: Record<string, PeerSettings>;
  notes: Note[];
  notesFolder?: string | null;
  notesError?: string | null;
  displayName?: string;
  nameConfirmed?: boolean;
  welcomeCompleted?: boolean;
  introSeen?: boolean;
  launchMusic?: boolean | null;
  projectNames?: Record<string,string>;
  global: CommitSettings;
  projects: Record<string, CommitSettings>;
}
export const defaultSettings: CommitSettings = {
  model: "auto",
  coAuthor: false,
  smartCommit: false,
  suggestSmartCommit: true,
  untracked: "mixed",
};
export interface SearchQuery {
  text: string;
  regex: boolean;
  caseSensitive: boolean;
  wholeWord: boolean;
  include: string;
  exclude: string;
  replacement: string | null;
}
export interface Replacement {
  path: string;
  before: string;
  after: string;
  count: number;
}
export interface SearchResults {
  hits: { path: string; line: number; column: number; text: string }[];
  replacements: Replacement[];
  truncated: boolean;
  files: number;
}
export interface GitAction {
  action: string;
  path?: string;
  message?: string;
  reference?: string;
  expectedDiff?: string;
  lines?: number[];
}
export interface GitDetails {
  branches: string[];
  remotes: string[];
  history: string;
  stashes: string[];
}
let sample: WorkbenchData = {
  notes: [],
  global: { ...defaultSettings },
  projects: {},
};
try {
  sample =
    JSON.parse(localStorage.getItem("brigadier:sample-notes") ?? "null") ??
    sample;
} catch {
  /* invalid sample state */
}
const saveSample = () => {
  localStorage.setItem("brigadier:sample-notes", JSON.stringify(sample));
  return structuredClone(sample);
};
const desktopOnly = () =>
  Promise.reject(
    new Error(
      "This action requires the desktop app. Browser data is a sample.",
    ),
  );
export const workbenchApi = {
  renameProject: async (id: string, name: string): Promise<void> => {
    if (desktop) { await invoke("navigation_customize", {kind: "name", id, value: name}); return; }
    sample.projectNames ??= {}; sample.projectNames[id] = name; saveSample();
  },
  saveDesktopSettings: (displayName: string, projectNames: Record<string,string>): Promise<WorkbenchData> =>
    Promise.resolve().then(() => {
      displayName = validateDisplayName(displayName);
      if (desktop) return invoke("desktop_settings_save", {displayName, projectNames});
      sample.displayName = displayName;
      sample.nameConfirmed = true;
      sample.projectNames = projectNames;
      return saveSample();
    }),
  saveLaunchPreferences: (patch: Partial<Pick<WorkbenchData, "displayName" | "nameConfirmed" | "welcomeCompleted" | "introSeen" | "launchMusic">>): WorkbenchData => {
    Object.assign(sample, patch);
    return saveSample();
  },
  setNotesFolder: (folder:string):Promise<WorkbenchData> => desktop ? invoke("notes_folder_save",{folder}) : Promise.resolve().then(()=>{sample.notesFolder=folder;return saveSample();}),
  load: (): Promise<WorkbenchData> =>
    desktop
      ? invoke("workbench_load")
      : Promise.resolve().then(() => {
          const data = structuredClone(sample);
          const trash = JSON.parse(localStorage.getItem("brigadier:navigation:v1") ?? "null")?.trash ?? [];
          data.notes = data.notes.filter(n => !trash.some((t: {kind: string; id: string}) => t.kind === "note" && t.id === n.id));
          return data;
        }),
  saveNote: (note: Note): Promise<Note> =>
    desktop
      ? invoke("note_save", { note })
      : Promise.resolve().then(() => {
          const old = sample.notes.find((n) => n.id === note.id);
          if (old && old.revision !== note.revision)
            throw Error("Note changed elsewhere");
          const saved = { ...note, revision: note.revision + 1 };
          sample.notes = [
            ...sample.notes.filter((n) => n.id !== note.id),
            saved,
          ];
          saveSample();
          return saved;
        }),
  deleteNote: (id: string): Promise<void> =>
    desktop
      ? invoke("note_delete", { id })
      : Promise.resolve().then(() => {
          sample.notes = sample.notes.filter((n) => n.id !== id);
          saveSample();
        }),
  saveSettings: (
    projectId: string | null,
    settings: CommitSettings | null,
  ): Promise<WorkbenchData> =>
    desktop
      ? invoke("commit_settings_save", { projectId, settings })
      : Promise.resolve().then(() => {
          if (projectId) {
            if (settings) sample.projects[projectId] = settings;
            else delete sample.projects[projectId];
          } else sample.global = settings ?? { ...defaultSettings };
          return saveSample();
        }),
  savePeerSettings: (
    projectId: string | null,
    settings: PeerSettings | null,
  ): Promise<WorkbenchData> =>
    desktop
      ? invoke("peer_settings_save", { projectId, settings })
      : Promise.resolve().then(() => {
          sample.projectPeers ??= {};
          if (projectId) {
            if (settings) sample.projectPeers[projectId] = settings;
            else delete sample.projectPeers[projectId];
          } else sample.peers = settings ?? { ...defaultPeerSettings };
          return saveSample();
        }),
  gitAction: (c: WorkspaceContext, request: GitAction): Promise<string> =>
    desktop ? invoke("workspace_git_action", { ...c, request }) : desktopOnly(),
  gitDetails: (c: WorkspaceContext): Promise<GitDetails> =>
    desktop
      ? invoke("workspace_git_details", { ...c })
      : Promise.resolve({
          branches: ["main"],
          remotes: [],
          history: "Sample history",
          stashes: [],
        }),
  search: (c: WorkspaceContext, query: SearchQuery): Promise<SearchResults> =>
    desktop
      ? invoke("workspace_search", { ...c, query })
      : Promise.resolve({
          hits: query.text
            ? [
                {
                  path: "README.md",
                  line: 1,
                  column: 3,
                  text: "# Brigadier (sample result)",
                },
              ]
            : [],
          replacements:
            query.replacement === null
              ? []
              : [
                  {
                    path: "README.md",
                    before: "# Brigadier\n",
                    after: `# ${query.replacement}\n`,
                    count: 1,
                  },
                ],
          files: 1,
          truncated: false,
        }),
  replace: (c: WorkspaceContext, changes: Replacement[]): Promise<number> =>
    desktop ? invoke("workspace_replace", { ...c, changes }) : desktopOnly(),
  save: (
    c: WorkspaceContext,
    path: string,
    content: string,
    before: string | null,
  ): Promise<void> =>
    desktop
      ? invoke("workspace_save", { ...c, path, content, before })
      : desktopOnly(),
  generate: (
    c: WorkspaceContext,
    model: string,
  ): Promise<{ message: string; model: string }> =>
    desktop
      ? invoke("generate_commit_message", { ...c, model })
      : desktopOnly(),
  terminalInfo: (id: string): Promise<{ busy: boolean; cwd: string }> =>
    invoke("terminal_info", { id }),
};
