import { useState } from "react";
import { GitBranch, History } from "lucide-react";
import { MoreIcon, PinIcon } from "./NavigationIcons";
import { EditIcon } from "./EditIcon";
import { ArchiveIcon } from "./ArchiveIcon";
import { Button } from "./controls/button";
import { Input } from "./controls/input";
import { Dropdown, Separator } from "./controls/overlay";
import { DropdownContent } from "./controls/menu";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
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
  onHistory,
}: {
  sessionId: string;
  title: string;
  canFork: boolean;
  onFork?: () => Promise<void>;
  onArchive: () => void;
  onHistory?: () => void;
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
  return (
    <>
      <Dropdown native>
        <Button size="icon" aria-label="Session actions" disabled={busy}>
          <MoreIcon />
        </Button>
        <DropdownContent className="w-56">
          <Dropdown.Item
            nativeIcon={<EditIcon />}
            onAction={() => {
              setError("");
              setName(title);
            }}
          >
            <EditIcon />
            Rename
          </Dropdown.Item>
          <Dropdown.Item
            nativeIcon={<PinIcon filled={pinned} />}
            onAction={() =>
              void run(() =>
                navigationApi.customize(
                  "pin",
                  sessionId,
                  pinned ? null : "pinned",
                ),
              )
            }
          >
            <PinIcon filled={pinned} />
            {pinned ? "Unpin" : "Pin"}
          </Dropdown.Item>
          <Dropdown.Item
            nativeIcon={<ArchiveIcon />}
            onAction={() =>
              void run(() => {
                if (archived) return setSessionArchived(sessionId, false);
                onArchive();
              })
            }
          >
            <ArchiveIcon />
            {archived ? "Unarchive" : "Archive"}
          </Dropdown.Item>
          <Separator />
          <Dropdown.Item
            nativeIcon={<GitBranch />}
            disabled={!canFork || !onFork}
            onAction={() => void run(() => onFork?.())}
          >
            <GitBranch />
            Fork
          </Dropdown.Item>
          {onHistory && (
            <>
              <Separator />
              <Dropdown.Item nativeIcon={<History />} onAction={onHistory}>
                <History />
                Session history
              </Dropdown.Item>
            </>
          )}
        </DropdownContent>
      </Dropdown>
      <Dialog
        open={name !== null}
        onOpenChange={(open) => {
          if (!open) setName(null);
        }}
      >
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>Rename session</DialogTitle>
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
                variant="secondary"
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
