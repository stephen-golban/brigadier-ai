import { useEffect, useState } from "react";
import { GitBranch, Laptop, ArrowUpRight } from "lucide-react";
import { MoreIcon, PinIcon } from "./NavigationIcons";
import { EditIcon } from "./EditIcon";
import { ArchiveIcon } from "./ArchiveIcon";
import { Button } from "./controls/button";
import { Kbd } from "./controls/kbd";
import { Input } from "./controls/input";
import { Dropdown, Separator } from "./controls/overlay";
import { DropdownContent } from "./controls/menu";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "./controls/dialog";
import { useNavigationData, navigationApi } from "../navigationApi";
import {
  renameSession,
  setSessionArchived,
  useSessionNavigation,
} from "../sessionNavigation";
import { errorMessage } from "../workspaceApi";
import { notify } from "../desktopApi";

export function SessionMenu({
  sessionId,
  title,
  canFork,
  onFork,
  onArchive,
}: {
  sessionId: string;
  title: string;
  canFork: boolean;
  onFork?: (newWorktree: boolean) => Promise<void>;
  onArchive: () => void;
}) {
  const { data } = useNavigationData();
  const { archivedIds } = useSessionNavigation();
  const pinned = data.pinnedSessions.includes(sessionId);
  const archived = archivedIds.includes(sessionId);
  const [name, setName] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const run = async (action: () => void | Promise<unknown>) => {
    if (busy) return;
    setBusy(true);
    try {
      await action();
    } catch (e) {
      notify(errorMessage(e), true);
    } finally {
      setBusy(false);
    }
  };
  const rename = () => {
    setError("");
    setName(title);
  };
  const pin = () =>
    void run(() =>
      navigationApi.customize("pin", sessionId, pinned ? null : "pinned"),
    );
  const archive = () =>
    void run(() =>
      archived ? setSessionArchived(sessionId, false) : onArchive(),
    );
  useEffect(() => {
    const action = (name: string) => {
      if (
        document.querySelector(
          'dialog[open], [role="dialog"], .settings-overlay',
        )
      )
        return;
      if (name === "rename") rename();
      else if (name === "pin") pin();
      else if (name === "archive") archive();
    };
    const native = (event: Event) =>
      action((event as CustomEvent<string>).detail);
    const key = (event: KeyboardEvent) => {
      if (
        event.isComposing ||
        !(
          event.metaKey ||
          (!navigator.platform.startsWith("Mac") && event.ctrlKey)
        )
      )
        return;
      const name =
        event.altKey && !event.shiftKey
          ? ({ KeyR: "rename", KeyP: "pin" } as Record<string, string>)[
              event.code
            ]
          : event.shiftKey && !event.altKey && event.code === "KeyA"
            ? "archive"
            : undefined;
      if (
        name &&
        !document.querySelector(
          'dialog[open], [role="dialog"], .settings-overlay',
        )
      ) {
        event.preventDefault();
        event.stopImmediatePropagation();
        action(name);
      }
    };
    window.addEventListener("workbench-session-action", native);
    window.addEventListener("keydown", key, true);
    return () => {
      window.removeEventListener("workbench-session-action", native);
      window.removeEventListener("keydown", key, true);
    };
  }, [sessionId, title, pinned, archived, busy, onArchive]);
  const mac = navigator.platform.startsWith("Mac");
  return (
    <>
      <Dropdown native>
        <Button size="icon" aria-label="Session actions" disabled={busy}>
          <MoreIcon />
        </Button>
        <DropdownContent className="w-56">
          <Dropdown.Item
            aria-label="Rename"
            textValue="Rename"
            nativeIcon={<EditIcon />}
            accelerator="CmdOrCtrl+Alt+R"
            onAction={rename}
          >
            <EditIcon />
            Rename<Kbd className="ml-auto">{mac ? "⌥⌘R" : "Ctrl Alt R"}</Kbd>
          </Dropdown.Item>
          <Dropdown.Item
            aria-label={pinned ? "Unpin" : "Pin"}
            textValue={pinned ? "Unpin" : "Pin"}
            nativeIcon={<PinIcon filled={pinned} />}
            accelerator="CmdOrCtrl+Alt+P"
            onAction={pin}
          >
            <PinIcon filled={pinned} />
            {pinned ? "Unpin" : "Pin"}
            <Kbd className="ml-auto">{mac ? "⌥⌘P" : "Ctrl Alt P"}</Kbd>
          </Dropdown.Item>
          <Dropdown.Item
            aria-label={archived ? "Unarchive" : "Archive"}
            textValue={archived ? "Unarchive" : "Archive"}
            nativeIcon={<ArchiveIcon />}
            accelerator="CmdOrCtrl+Shift+A"
            onAction={archive}
          >
            <ArchiveIcon />
            {archived ? "Unarchive" : "Archive"}
            <Kbd className="ml-auto">{mac ? "⇧⌘A" : "Ctrl Shift A"}</Kbd>
          </Dropdown.Item>
          <Separator />
          <Dropdown.SubmenuTrigger>
            <Dropdown.Item
              textValue="Fork"
              nativeIcon={<GitBranch />}
              disabled={!canFork || !onFork}
            >
              <GitBranch />
              Fork
            </Dropdown.Item>
            <DropdownContent side="right">
              <Dropdown.Item
                nativeIcon={<Laptop />}
                onAction={() => void run(() => onFork?.(false))}
              >
                <Laptop />
                Fork session
              </Dropdown.Item>
              <Dropdown.Item
                nativeIcon={<ArrowUpRight />}
                onAction={() => void run(() => onFork?.(true))}
              >
                <ArrowUpRight />
                Fork session in new worktree
              </Dropdown.Item>
            </DropdownContent>
          </Dropdown.SubmenuTrigger>
        </DropdownContent>
      </Dropdown>
      <Dialog
        open={name !== null}
        onOpenChange={(open) => {
          if (!open) setName(null);
        }}
      >
        <DialogContent className="rename-session-dialog max-w-[500px]">
          <DialogHeader>
            <DialogTitle>Rename session</DialogTitle>
            <DialogDescription className="rename-description">
              Keep it short and recognizable
            </DialogDescription>
          </DialogHeader>
          <form
            className="space-y-4"
            onSubmit={(event) => {
              event.preventDefault();
              try {
                renameSession(sessionId, name ?? "");
                setName(null);
              } catch (e) {
                setError(errorMessage(e));
              }
            }}
          >
            <Input
              aria-label="Session name"
              value={name ?? ""}
              onChange={(event) => setName(event.target.value)}
              maxLength={200}
              onFocus={(event) => event.target.select()}
              autoFocus
            />
            {error && (
              <p role="alert" className="text-sm text-error">
                {error}
              </p>
            )}
            <div className="flex justify-end gap-2">
              <Button onClick={() => setName(null)}>Cancel</Button>
              <Button
                type="submit"
                className="rename-save"
                disabled={!name?.trim()}
              >
                Save
              </Button>
            </div>
          </form>
        </DialogContent>
      </Dialog>
    </>
  );
}
