import { useEffect, useState, type ReactNode, type SVGProps } from "react";
import { bridge } from "../bridge";
import { errorMessage } from "../workspaceApi";
import { BrandMark } from "./BrandMark";
import { FolderPlusAdd, Notepad, PlusCircle } from "../icons";

/**
 * The main pane with no project selected: a centred brand mark over a short column of actions,
 * ported from get-bb/bb's empty state. Rows are the hit target — no card, no border, no button
 * chrome; a `--radius-row` hover fill is the whole affordance.
 *
 * When it shows: `ThreadView` renders this instead of `NewConversation` while `projectId` is
 * `null`, which is now two states — no projects at all, and a global "New chat" that has not
 * picked one yet (`App`'s `projectUnpicked`, `src/App.tsx:229-250`). The row wiring assumes
 * neither: `listProjects()` is asked, so "New chat" is disabled on the answer rather than on the
 * inference.
 *
 * Every row calls a path that already exists:
 *  - New project: `pickDirectory()` then `addProject()`, the two calls `App`'s own `pickProject`
 *    makes (`src/App.tsx:772-781`), then the `brigadier-navigation-changed` event `App` and
 *    `navigationApi` both listen on, which reloads the project list and selects the new project.
 *  - New chat: the `brigadier-new-chat` event the sidebar's own "New chat" button and ⌘N
 *    dispatch (`src/components/Sidebar.tsx:438-456`). Pressed while already unpicked it opens the
 *    composer's project picker instead of doing nothing — `App` turns the second press into
 *    `brigadier-pick-project`, which `TaskSetupRail` listens for.
 *  - Notepad: the `brigadier-open-notes` event the sidebar listens for
 *    (`src/components/Sidebar.tsx:276-279`).
 * Nothing else is offered: there is no recent-repos importer and no tour to link to.
 */
export function WelcomeScreen() {
  const [hasProjects, setHasProjects] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    let live = true;
    const read = () => {
      void bridge()
        .listProjects()
        .then((list) => {
          if (live) setHasProjects(list.length > 0);
        })
        .catch(() => {});
    };
    read();
    window.addEventListener("brigadier-navigation-changed", read);
    return () => {
      live = false;
      window.removeEventListener("brigadier-navigation-changed", read);
    };
  }, []);

  const addProject = async () => {
    if (busy) return;
    setError("");
    // A browser (`npm run dev`) gets the mock bridge, whose `pickDirectory` resolves `null`
    // because there is no native picker. Saying so beats a click that silently does nothing;
    // the sidebar's typed-path field is the fallback there, exactly as `src/App.tsx:1082` gates it.
    if (bridge().isMock) {
      setError(
        "The folder picker needs the desktop window. Use Add project in the sidebar to type a path.",
      );
      return;
    }
    setBusy(true);
    try {
      const picked = await bridge().pickDirectory();
      // A cancelled picker resolves `null` and is not an error (`docs/research/tauri-dialog.md` §2).
      if (picked === null) return;
      await bridge().addProject(picked);
      window.dispatchEvent(new Event("brigadier-navigation-changed"));
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="welcome-screen flex min-h-0 flex-1 flex-col items-center overflow-y-auto px-6 py-8">
      <div aria-hidden className="min-h-4 flex-[1_1_0]" />
      <BrandMark className="brand-mark size-[120px] shrink-0 fill-current" />
      <div className="mt-[96px] flex w-full max-w-[420px] shrink-0 flex-col gap-1.5">
        <WelcomeRow
          Icon={FolderPlusAdd}
          title="New project"
          subtitle="Create one from a local folder"
          disabled={busy}
          onClick={() => void addProject()}
        />
        <WelcomeRow
          Icon={PlusCircle}
          title="New chat"
          subtitle={
            hasProjects ? "Start a conversation in a project" : "Add a project first"
          }
          disabled={!hasProjects}
          onClick={() =>
            window.dispatchEvent(new Event("brigadier-new-chat"))
          }
        />
        <WelcomeRow
          Icon={Notepad}
          title="Notepad"
          subtitle="Keep notes alongside your work"
          onClick={() =>
            window.dispatchEvent(new Event("brigadier-open-notes"))
          }
        />
        {error && (
          <p role="alert" className="px-4 pt-2 text-[13px] text-error">
            {error}
          </p>
        )}
      </div>
      <div aria-hidden className="min-h-4 flex-[1.8_1_0]" />
    </div>
  );
}

function WelcomeRow({
  Icon,
  title,
  subtitle,
  disabled = false,
  onClick,
}: {
  Icon: (props: SVGProps<SVGSVGElement>) => ReactNode;
  title: string;
  subtitle: string;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className="welcome-row flex w-full items-start gap-4 rounded-[var(--radius-row)] px-4 py-3 text-left transition-colors enabled:hover:bg-muted disabled:cursor-default disabled:opacity-50"
    >
      <Icon className="mt-px size-6 shrink-0 text-text-secondary" />
      <span className="flex min-w-0 flex-col gap-0.5">
        <span className="text-[15px] font-semibold text-text">{title}</span>
        <span className="text-[13px] text-muted-foreground">{subtitle}</span>
      </span>
    </button>
  );
}
