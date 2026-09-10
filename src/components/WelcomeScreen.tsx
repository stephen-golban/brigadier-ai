import { useState, type ReactNode, type SVGProps } from "react";
import { bridge } from "../bridge";
import { errorMessage } from "../workspaceApi";
import { BrandMark } from "./BrandMark";
import { Button } from "./controls/button";
import { FolderPlusAdd, Notepad } from "../icons";

/** Welcome actions are available with or without an imported project. */
export function WelcomeScreen() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
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
      <h1 className="mt-4 shrink-0">Chat with Brigadier</h1>
      <div className="welcome-actions shrink-0">
        <WelcomeAction
          Icon={FolderPlusAdd}
          title="New project"
          subtitle="Create one from a local folder"
          disabled={busy}
          onClick={() => void addProject()}
        />
        <WelcomeAction
          Icon={Notepad}
          title="Notepad"
          subtitle="Keep notes alongside your work"
          onClick={() =>
            window.dispatchEvent(new Event("brigadier-open-notes"))
          }
        />
        {error && (
          <p role="alert" className="col-span-full pt-2 text-[13px] text-error">
            {error}
          </p>
        )}
      </div>
      <div aria-hidden className="min-h-4 flex-[1.8_1_0]" />
    </div>
  );
}

function WelcomeAction({
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
    <Button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className="welcome-shortcut"
    >
      <Icon className="size-5 shrink-0 text-text-secondary" />
      <span className="flex min-w-0 flex-col gap-0.5">
        <span className="text-[14px] font-medium text-text">{title}</span>
        <span className="text-[12px] text-muted-foreground">{subtitle}</span>
      </span>
    </Button>
  );
}
