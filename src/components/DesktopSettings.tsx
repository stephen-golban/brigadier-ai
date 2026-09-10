import { createPortal } from "react-dom";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Archive, ArrowDown, ArrowLeft, Folder, Search, Settings, Trash, User } from "../icons";
import { open } from "@tauri-apps/plugin-dialog";
import { SoftwareUpdates } from "./SoftwareUpdates";
import { ArchivedSessions } from "./ArchivedSessions";
import { Checkbox } from "./controls/checkbox";
import { Input } from "./controls/input";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { labelledButtonIcons } from "@/lib/surfaces";
import type { SessionRuntime } from "../feedStore";
import type { ProjectView } from "../wire";
import { workbenchApi, type WorkbenchData } from "../workbenchApi";
import { desktop, errorMessage } from "../workspaceApi";
import { desktopApi, type CleanupJob } from "../desktopApi";
import { launchApi } from "../launchApi";
import { NameInput } from "./NameInput";
import { ResetOnboardingButton } from "./ResetOnboardingButton";
import { useStoredState } from "../workbenchState";
import type { SettingsPage, SettingsRequest } from "../settingsNavigation";
import "./settings.css";

const pages = [
  {
    id: "general",
    label: "General",
    icon: Settings,
    search: "welcome music notes folder awake sleep lock power",
  },
  {
    id: "profile",
    label: "Profile",
    icon: User,
    search: "display name account",
  },
  { id: "updates", label: "Updates", icon: ArrowDown, search: "CLI providers versions releases software app" },
  {
    id: "archived",
    label: "Archived chats",
    icon: Archive,
    search: "sessions history restore unarchive delete retention auto delete",
  },
] as const;
interface DesktopSettingsProps {
  data: WorkbenchData;
  onData: (data: WorkbenchData) => void;
  sessions: Record<string, SessionRuntime>;
  titles: Record<string, string>;
  projects: ProjectView[];
  origins: Record<string, string>;
  jobs: CleanupJob[];
  onClose: () => void;
  onOpenTrash?: () => void;
  request?: SettingsRequest;
}
export function DesktopSettings({ data, onData, sessions, titles, projects, origins, jobs, onClose, onOpenTrash, request }: DesktopSettingsProps) {
  const [savedPage, setPage] = useStoredState<SettingsPage>(
    "brigadier:settings-page",
    "general",
  );
  const page = pages.some((item) => item.id === savedPage)
    ? savedPage
    : "general";
  const [search, setSearch] = useState("");
  const [name, setName] = useState(data.displayName ?? "");
  const [folder, setFolder] = useState(data.notesFolder ?? "");
  const [error, setError] = useState("");
  const [savingName, setSavingName] = useState(false);
  const [savingMusic, setSavingMusic] = useState(false);
  const [savingKeepAwake, setSavingKeepAwake] = useState(false);
  const back = useRef<HTMLButtonElement>(null);
  const settingsSearch = useRef<HTMLInputElement>(null);
  useLayoutEffect(() => {
    if (request?.page) setPage(request.page);
  }, [request, setPage]);
  useLayoutEffect(() => {
    // Keep the running workspace mounted, but remove it from layout and keyboard navigation.
    const shell = document.querySelector<HTMLElement>(".app-shell");
    const previous = document.activeElement as HTMLElement | null;
    const wasHidden = shell?.hidden ?? false;
    const wasInert = shell?.inert ?? false;
    if (shell) {
      shell.hidden = true;
      shell.inert = true;
    }
    back.current?.focus();
    return () => {
      if (shell) {
        shell.hidden = wasHidden;
        shell.inert = wasInert;
      }
      if (previous?.isConnected) previous.focus();
    };
  }, []);
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        settingsSearch.current?.focus();
      }
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, []);
  const saveFolder = async (value: string) => {
    try {
      onData(await workbenchApi.setNotesFolder(value));
      setFolder(value);
      window.dispatchEvent(new Event("workbench-data-changed"));
      setError("");
    } catch (error) {
      setError(errorMessage(error));
    }
  };
  const visiblePages = pages.filter((item) =>
    `${item.label} ${item.search}`
      .toLowerCase()
      .includes(search.toLowerCase().trim()),
  );
  return createPortal(
    <div className="desktop-settings settings-overlay" aria-label="Settings">
      <div
        className="settings-drag-region"
        data-tauri-drag-region="deep"
        aria-hidden="true"
      />
      <aside className="settings-sidebar">
        <Button
          ref={back}
          variant="ghost"
          size="sm"
          className={cn(labelledButtonIcons, "settings-back")}
          onClick={onClose}
        >
          <ArrowLeft />
          Back to app
        </Button>
        <label className="settings-search settings-nav-search">
          <Search width={16} height={16} />
          <Input
            ref={settingsSearch}
            aria-label="Search settings"
            placeholder="Search settings…"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
        </label>
        <nav aria-label="Settings pages">
          <span className="settings-section-label">Personal</span>
          {visiblePages
            .filter((item) => item.id !== "archived")
            .map(({ id, label, icon: Icon }) => (
              <Button
                key={id}
                variant="ghost"
                size="sm"
                className={cn(labelledButtonIcons, "settings-nav-item")}
                aria-current={page === id ? "page" : undefined}
                onClick={() => {
                  setPage(id);
                  setError("");
                }}
              >
                <Icon />
                {label}
              </Button>
            ))}
          {visiblePages.some((item) => item.id === "archived") && (
            <>
              <span className="settings-section-label settings-archived-label">
                Archived
              </span>
              <Button
                variant="ghost"
                size="sm"
                className={cn(labelledButtonIcons, "settings-nav-item")}
                aria-current={page === "archived" ? "page" : undefined}
                onClick={() => {
                  setPage("archived");
                  setError("");
                }}
              >
                <Archive />
                Archived chats
              </Button>
            </>
          )}
          {onOpenTrash && (!search || "trash".includes(search.toLowerCase().trim())) && <Button variant="ghost" size="sm" className={cn(labelledButtonIcons, "settings-nav-item")} onClick={onOpenTrash}><Trash />Trash</Button>}
          {!visiblePages.length && (
            <p className="settings-search-empty">No matching settings</p>
          )}
        </nav>
      </aside>
      <main
        className="settings-main"
        aria-label={pages.find((item) => item.id === page)?.label}
      >
        <div className="settings-content">
          {page === "archived" ? (
            <ArchivedSessions
              sessions={sessions}
              titles={titles}
              projects={projects}
              projectNames={data.projectNames ?? {}}
              origins={origins}
              highlightId={request?.sessionId}
            />
          ) : (
            <>
              <header className="settings-page-heading">
                <h1>{pages.find((item) => item.id === page)?.label}</h1>
              </header>
              <div className="settings-sections">
                {page === "updates" && <SoftwareUpdates />}
                {page === "general" && (
                  <>
                    <section className="settings-section">
                      <h2>Welcome</h2>
                      <Checkbox
                        checked={data.launchMusic ?? true}
                        disabled={savingMusic}
                        onCheckedChange={(enabled) => {
                          setSavingMusic(true);
                          void launchApi
                            .music(enabled)
                            .then(() => workbenchApi.load())
                            .then(onData)
                            .catch((error) => setError(errorMessage(error)))
                            .finally(() => setSavingMusic(false));
                        }}
                      >
                        Intro music
                      </Checkbox>
                      <div className="settings-actions">
                        <Button
                          variant="secondary"
                          size="sm"
                          onClick={() => {
                            onClose();
                            launchApi.replay();
                          }}
                        >
                          Replay welcome
                        </Button>
                        <ResetOnboardingButton onReset={onClose} />
                      </div>
                    </section>
                    <section className="settings-section">
                      <h2>Power</h2>
                      <Checkbox
                        role="switch"
                        checked={data.keepAwake ?? false}
                        disabled={!desktop || savingKeepAwake}
                        onCheckedChange={(enabled) => {
                          setSavingKeepAwake(true);
                          void workbenchApi.setKeepAwake(enabled)
                            .then((next) => {
                              onData(next);
                              setError("");
                              window.dispatchEvent(new Event("workbench-data-changed"));
                            })
                            .catch((error) => setError(errorMessage(error)))
                            .finally(() => setSavingKeepAwake(false));
                        }}
                      >
                        Keep machine awake while working
                      </Checkbox>
                      <p>
                        Prevent idle sleep and automatic screen locking while an agent
                        is working. Normal behavior resumes when work stops. macOS only.
                      </p>
                    </section>
                    <section className="settings-section">
                      <h2>Notes folder</h2>
                      <p>
                        Notes are Markdown files. Existing notes keep their
                        references when you choose a different folder.
                      </p>
                      <form
                        onSubmit={(event) => {
                          event.preventDefault();
                          void saveFolder(folder);
                        }}
                      >
                        <label>
                          Folder
                          <Input
                            value={folder}
                            placeholder="Default: app data / notes"
                            onChange={(event) => setFolder(event.target.value)}
                          />
                        </label>
                        <div className="settings-actions">
                          <Button
                            variant="secondary"
                            size="sm"
                            className={labelledButtonIcons}
                            disabled={!desktop}
                            onClick={() => {
                              void open({
                                directory: true,
                                multiple: false,
                                title: "Choose notes folder",
                              })
                                .then((path) => {
                                  if (typeof path === "string")
                                    void saveFolder(path);
                                })
                                .catch((error) =>
                                  setError(errorMessage(error)),
                                );
                            }}
                          >
                            <Folder />
                            Choose folder
                          </Button>
                          <Button
                            variant="secondary"
                            size="sm"
                            type="submit"
                            disabled={!folder.trim()}
                          >
                            Use folder
                          </Button>
                        </div>
                      </form>
                      {data.notesError && <p role="alert">{data.notesError}</p>}
                    </section>
                    {jobs.length > 0 && (
                      <section className="settings-section">
                        <h2>Session cleanup</h2>
                        {jobs.map((job) => (
                          <div className="settings-actions" key={job.id}>
                            <span>
                              {job.error ?? "Removing session files…"}
                            </span>
                            {job.error && (
                              <Button
                                variant="ghost"
                                size="sm"
                                onClick={() =>
                                  void desktopApi
                                    .retryCleanup(job.id)
                                    .catch((error) =>
                                      setError(errorMessage(error)),
                                    )
                                }
                              >
                                Retry
                              </Button>
                            )}
                          </div>
                        ))}
                      </section>
                    )}
                  </>
                )}
                {page === "profile" && (
                  <section className="settings-section">
                    <h2>Profile</h2>
                    <form
                      onSubmit={(event) => {
                        event.preventDefault();
                        if (savingName) return;
                        setSavingName(true);
                        void workbenchApi
                          .saveDesktopSettings(name, data.projectNames ?? {})
                          .then((next) => {
                            onData(next);
                            setName(next.displayName ?? "");
                            setError("");
                          })
                          .catch((error) => setError(errorMessage(error)))
                          .finally(() => setSavingName(false));
                      }}
                    >
                      <label>
                        Display name
                        <NameInput
                          value={name}
                          onValueChange={setName}
                          maxLength={200}
                          required
                          disabled={savingName}
                        />
                      </label>
                      <Button
                        variant="secondary"
                        size="sm"
                        type="submit"
                        disabled={savingName || !name.trim()}
                      >
                        {savingName ? "Saving…" : "Save name"}
                      </Button>
                    </form>
                  </section>
                )}
                {error && (
                  <p role="alert" className="text-error">
                    {error}
                  </p>
                )}
              </div>
            </>
          )}
        </div>
      </main>
    </div>,
    document.body,
  );
}
