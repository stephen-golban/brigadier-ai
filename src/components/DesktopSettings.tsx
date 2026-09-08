import { FolderIcon } from "./NavigationIcons";
import { Checkbox } from "./controls/checkbox";
import { Input } from "./controls/input";
import { Button } from "./controls/button";
import { navigationApi } from "../navigationApi";
import { Modal } from "./controls/modal";
import { useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { XIcon, TrashIcon } from "@phosphor-icons/react";
import type { SessionRuntime } from "../feedStore";
import { workbenchApi, type WorkbenchData } from "../workbenchApi";
import { desktop, errorMessage } from "../workspaceApi";
import { desktopApi, type CleanupJob } from "../desktopApi";
import { ConfirmDialog, type Confirmation } from "./ConfirmDialog";
import { launchApi } from "../launchApi";
import { NameInput } from "./NameInput";
import { ResetOnboardingButton } from "./ResetOnboardingButton";
export function DesktopSettings({
  data,
  onData,
  sessions,
  titles,
  jobs,
  onClose,
}: {
  data: WorkbenchData;
  onData: (d: WorkbenchData) => void;
  sessions: Record<string, SessionRuntime>;
  titles: Record<string, string>;
  jobs: CleanupJob[];
  onClose: () => void;
}) {
  const [name, setName] = useState(data.displayName ?? "");
  const [folder, setFolder] = useState(data.notesFolder ?? "");
  const [confirm, setConfirm] = useState<Confirmation | null>(null);
  const [error, setError] = useState("");
  const [query, setQuery] = useState("");
  const [savingName, setSavingName] = useState(false);
  const [savingMusic, setSavingMusic] = useState(false);
  const saveFolder = async (value: string) => {
    try {
      onData(await workbenchApi.setNotesFolder(value));
      setFolder(value);
      window.dispatchEvent(new Event("workbench-data-changed"));
      setError("");
    } catch (e) {
      setError(errorMessage(e));
    }
  };
  const dispose = async (id?: string) => {
    try {
      const plans = await Promise.all(
        (id ? [id] : Object.keys(sessions)).map((id) =>
          navigationApi.preview("session", id),
        ),
      );
      const running = [...new Set(plans.flatMap((p) => p.running))];
      setConfirm({
        title: running.length ? "Stop and move to Trash?" : "Move to Trash?",
        body: (
          <>
            <p>
              The selected sessions and their child agents can be restored from
              Trash. Repository files and worktrees stay on disk.
            </p>
            {running.length > 0 && (
              <p>
                Running sessions to stop:{" "}
                {running.map((id) => titles[id] ?? id).join(", ")}
              </p>
            )}
          </>
        ),
        confirmLabel: "Move to Trash",
        onCancel: () => setConfirm(null),
        onConfirm: async () => {
          for (const plan of plans) await navigationApi.move(plan);
          setConfirm(null);
        },
      });
    } catch (e) {
      setError(errorMessage(e));
    }
  };
  return (
    <Modal.Backdrop
      isOpen
      isDismissable={false}
      onOpenChange={(open) => {
        if (!open && !confirm) onClose();
      }}
    >
      <Modal.Container size="lg" scroll="inside">
        <Modal.Dialog aria-label="Settings">
          <section className="desktop-settings flex min-h-0 flex-col gap-4 [&_header]:flex [&_header]:items-center [&_header]:justify-between">
            <header>
              <h2>Settings</h2>
              <Button
                isIconOnly
                className="icon-button size-8 p-0"
                aria-label="Close settings"
                onClick={onClose}
              >
                <XIcon />
              </Button>
            </header>
            <div className="settings-scroll flex min-h-0 flex-col gap-4 overflow-y-auto [&_h3]:text-text-secondary [&_form]:flex [&_form]:flex-col [&_form]:gap-2 [&_label]:flex [&_label]:flex-col [&_label]:gap-2">
              <h3>Appearance</h3>
              <div className="theme-switch flex items-center justify-between">
                <span>Theme</span>
                <span className="text-text-secondary">Dark</span>
              </div>
              <h3>Profile</h3>
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  if (savingName) return;
                  setSavingName(true);
                  void workbenchApi
                    .saveDesktopSettings(name, data.projectNames ?? {})
                    .then((next) => {
                      onData(next);
                      setName(next.displayName ?? "");
                      setError("");
                    })
                    .catch((e) => setError(errorMessage(e)))
                    .finally(() => setSavingName(false));
                }}
              >
                <label>
                  Display name
                  <NameInput
                    autoFocus
                    value={name}
                    onValueChange={setName}
                    maxLength={200}
                    required
                    disabled={savingName}
                  />
                </label>
                <Button
                  type="submit"
                  className="act"
                  disabled={savingName || !name.trim()}
                >
                  {savingName ? "Saving…" : "Save name"}
                </Button>
              </form>
              <h3>Welcome</h3>
              <Checkbox
                className="intro-music-setting"
                checked={data.launchMusic ?? true}
                disabled={savingMusic}
                onCheckedChange={(e) => {
                  const enabled = e;
                  setSavingMusic(true);
                  void launchApi
                    .music(enabled)
                    .then(() => workbenchApi.load())
                    .then(onData)
                    .catch((e) => setError(errorMessage(e)))
                    .finally(() => setSavingMusic(false));
                }}
              >
                Intro music
              </Checkbox>
              <Button
                className="act"
                onClick={() => {
                  onClose();
                  launchApi.replay();
                }}
              >
                Replay welcome
              </Button>
              <ResetOnboardingButton onReset={onClose} />
              <h3>Notes folder</h3>
              <p>
                Notes are Markdown files. Existing notes keep their references
                when you choose a different folder.
              </p>
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  void saveFolder(folder);
                }}
              >
                <label>
                  Folder
                  <Input
                    value={folder}
                    placeholder="Default: app data / notes"
                    onChange={(e) => setFolder(e.target.value)}
                  />
                </label>
                <Button
                  type="button"
                  className="act"
                  onClick={() => {
                    if (desktop)
                      void open({
                        directory: true,
                        multiple: false,
                        title: "Choose notes folder",
                      })
                        .then((path) => {
                          if (typeof path === "string") void saveFolder(path);
                        })
                        .catch((e) => setError(errorMessage(e)));
                  }}
                  disabled={!desktop}
                >
                  <FolderIcon />
                  Choose folder
                </Button>
                <Button type="submit" className="act" disabled={!folder.trim()}>
                  Use folder
                </Button>
              </form>
              {data.notesError && (
                <p className="inline-error my-2 text-[13px] text-error">
                  {data.notesError}
                </p>
              )}
              <h3>History and sessions</h3>
              <Input
                aria-label="Find a session in settings"
                placeholder="Find a session…"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
              <div className="settings-sessions max-h-64 overflow-auto [&>div]:flex [&>div]:items-center [&>div]:justify-between [&_small]:block [&_small]:text-text-tertiary">
                {Object.values(sessions)
                  .filter((s) =>
                    (titles[s.sessionId] ?? s.sessionId)
                      .toLowerCase()
                      .includes(query.toLowerCase()),
                  )
                  .map((s) => (
                    <div key={s.sessionId}>
                      <span>
                        {titles[s.sessionId] ??
                          `Session ${s.sessionId.slice(-6)}`}
                        <small>{s.busy ? "Working" : s.status}</small>
                      </span>
                      <Button
                        isIconOnly
                        className="icon-button size-8 p-0"
                        aria-label={`Delete ${titles[s.sessionId] ?? s.sessionId}`}
                        onClick={() => dispose(s.sessionId)}
                      >
                        <TrashIcon />
                      </Button>
                    </div>
                  ))}
              </div>
              <Button
                className="act danger text-warn"
                disabled={!Object.keys(sessions).length}
                onClick={() => dispose()}
              >
                Clear all history and sessions
              </Button>
              {jobs.length > 0 && (
                <>
                  <h3>Session cleanup</h3>
                  {jobs.map((job) => (
                    <div
                      className="cleanup-job flex justify-between gap-2"
                      key={job.id}
                    >
                      <span>{job.error ?? "Removing session files…"}</span>
                      {job.error && (
                        <Button
                          onClick={() =>
                            void desktopApi
                              .retryCleanup(job.id)
                              .catch((e) => setError(errorMessage(e)))
                          }
                        >
                          Retry
                        </Button>
                      )}
                    </div>
                  ))}
                </>
              )}
              {error && (
                <p
                  role="alert"
                  className="inline-error my-2 text-[13px] text-error"
                >
                  {error}
                </p>
              )}
            </div>
          </section>
          {confirm && <ConfirmDialog {...confirm} />}
        </Modal.Dialog>
      </Modal.Container>
    </Modal.Backdrop>
  );
}
