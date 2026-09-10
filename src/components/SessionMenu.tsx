import { useEffect, useState } from "react";
import {
  Archive,
  BranchAlt,
  Branch,
  Desktop,
  DotsHorizontal,
  Edit,
  Pin,
  PinFilled,
} from "../icons";
import { Button } from "@/components/ui/button";
import { iconButton } from "@/lib/surfaces";
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
  canForkWorktree = true,
  onFork,
  onArchive,
}: {
  sessionId: string;
  title: string;
  canFork: boolean;
  canForkWorktree?: boolean;
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
        <Button variant="ghost" size="icon" className={iconButton} aria-label="Session actions" disabled={busy}>
          <DotsHorizontal className="size-4" />
        </Button>
        <DropdownContent className="w-56">
          <Dropdown.Item
            aria-label="Rename"
            textValue="Rename"
            nativeIcon={<Edit className="size-3.5" />}
            accelerator="CmdOrCtrl+Alt+R"
            onAction={rename}
          >
            <Edit className="size-3.5" />
            Rename<Kbd className="ml-auto">{mac ? "⌥⌘R" : "Ctrl Alt R"}</Kbd>
          </Dropdown.Item>
          <Dropdown.Item
            aria-label={pinned ? "Unpin" : "Pin"}
            textValue={pinned ? "Unpin" : "Pin"}
            nativeIcon={pinned ? <PinFilled className="size-4" /> : <Pin className="size-4" />}
            accelerator="CmdOrCtrl+Alt+P"
            onAction={pin}
          >
            {pinned ? <PinFilled className="size-4" /> : <Pin className="size-4" />}
            {pinned ? "Unpin" : "Pin"}
            <Kbd className="ml-auto">{mac ? "⌥⌘P" : "Ctrl Alt P"}</Kbd>
          </Dropdown.Item>
          <Dropdown.Item
            aria-label={archived ? "Unarchive" : "Archive"}
            textValue={archived ? "Unarchive" : "Archive"}
            nativeIcon={<Archive className="size-4" />}
            accelerator="CmdOrCtrl+Shift+A"
            onAction={archive}
          >
            <Archive className="size-4" />
            {archived ? "Unarchive" : "Archive"}
            <Kbd className="ml-auto">{mac ? "⇧⌘A" : "Ctrl Shift A"}</Kbd>
          </Dropdown.Item>
          <Separator />
          <Dropdown.SubmenuTrigger>
            <Dropdown.Item
              textValue="Fork"
              nativeIcon={<Branch />}
              disabled={!canFork || !onFork}
            >
              <Branch />
              Fork
            </Dropdown.Item>
            <DropdownContent side="right">
              <Dropdown.Item
                nativeIcon={<Desktop />}
                onAction={() => void run(() => onFork?.(false))}
              >
                <Desktop />
                Fork session
              </Dropdown.Item>
              {canForkWorktree && <Dropdown.Item
                nativeIcon={<BranchAlt />}
                onAction={() => void run(() => onFork?.(true))}
              >
                <BranchAlt />
                Fork session in new worktree
              </Dropdown.Item>}
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
              <Button variant="ghost" size="sm" onClick={() => setName(null)}>Cancel</Button>
              <Button
                type="submit"
                variant="ghost"
                size="sm"
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
