import { navigationApi } from "../navigationApi";
import { createPortal } from "react-dom";
import { useEffect, useRef, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { XIcon, FolderIcon, TrashIcon } from "@phosphor-icons/react";
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
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    dialog.current?.showModal();
    return () => previous?.focus();
  }, []);
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
  return createPortal(
    <dialog
      ref={dialog}
      aria-label="Settings"
      onCancel={(e) => {
        e.preventDefault();
        if (!confirm) onClose();
      }}
      className="settings-overlay"
      onKeyDown={(e) => {
        if (e.key === "Escape" && !confirm) onClose();
      }}
    >
      <section className="desktop-settings">
        <header>
          <h2>Settings</h2>
          <button
            className="icon-button"
            aria-label="Close settings"
            onClick={onClose}
          >
            <XIcon />
          </button>
        </header>
        <div className="settings-scroll">
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
            <button className="act" disabled={savingName || !name.trim()}>
              {savingName ? "Saving…" : "Save name"}
            </button>
          </form>
          <h3>Welcome</h3>
          <label className="settings-launch">
            <input
              type="checkbox"
              checked={data.launchMusic ?? true}
              disabled={savingMusic}
              onChange={(e) => {
                const enabled = e.target.checked;
                setSavingMusic(true);
                void launchApi
                  .music(enabled)
                  .then(() => workbenchApi.load())
                  .then(onData)
                  .catch((e) => setError(errorMessage(e)))
                  .finally(() => setSavingMusic(false));
              }}
            />
            Intro music
          </label>
          <button
            className="act"
            onClick={() => {
              onClose();
              launchApi.replay();
            }}
          >
            Replay welcome
          </button>
          <ResetOnboardingButton onReset={onClose} />
          <h3>Notes folder</h3>
          <p>
            Notes are Markdown files. Existing notes keep their references when
            you choose a different folder.
          </p>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void saveFolder(folder);
            }}
          >
            <label>
              Folder
              <input
                value={folder}
                placeholder="Default: app data / notes"
                onChange={(e) => setFolder(e.target.value)}
              />
            </label>
            <button
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
            </button>
            <button className="act" disabled={!folder.trim()}>
              Use folder
            </button>
          </form>
          {data.notesError && <p className="inline-error">{data.notesError}</p>}
          <h3>History and sessions</h3>
          <input
            aria-label="Find a session in settings"
            placeholder="Find a session…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          <div className="settings-sessions">
            {Object.values(sessions)
              .filter((s) =>
                (titles[s.sessionId] ?? s.sessionId)
                  .toLowerCase()
                  .includes(query.toLowerCase()),
              )
              .map((s) => (
                <div key={s.sessionId}>
                  <span>
                    {titles[s.sessionId] ?? `Session ${s.sessionId.slice(-6)}`}
                    <small>{s.busy ? "Working" : s.status}</small>
                  </span>
                  <button
                    className="icon-button"
                    aria-label={`Delete ${titles[s.sessionId] ?? s.sessionId}`}
                    onClick={() => dispose(s.sessionId)}
                  >
                    <TrashIcon />
                  </button>
                </div>
              ))}
          </div>
          <button
            className="act danger"
            disabled={!Object.keys(sessions).length}
            onClick={() => dispose()}
          >
            Clear all history and sessions
          </button>
          {jobs.length > 0 && (
            <>
              <h3>Session cleanup</h3>
              {jobs.map((job) => (
                <div className="cleanup-job" key={job.id}>
                  <span>{job.error ?? "Removing session files…"}</span>
                  {job.error && (
                    <button
                      onClick={() =>
                        void desktopApi
                          .retryCleanup(job.id)
                          .catch((e) => setError(errorMessage(e)))
                      }
                    >
                      Retry
                    </button>
                  )}
                </div>
              ))}
            </>
          )}
          {error && (
            <p role="alert" className="inline-error">
              {error}
            </p>
          )}
        </div>
      </section>
      {confirm && <ConfirmDialog {...confirm} />}
    </dialog>,
    document.body,
  );
}
