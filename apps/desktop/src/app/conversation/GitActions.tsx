import {
  Branch,
  Check,
  Commit,
  DotsHorizontal,
  Spin,
  UploadDocuments,
} from "@openai/apps-sdk-ui/components/Icon";
import { type FC, type ReactNode, useEffect, useRef, useState } from "react";

import { TooltipIconButton } from "@/components/assistant-ui/tooltip-icon-button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Kbd } from "@/components/ui/kbd";
import { Popover, PopoverAnchor, PopoverContent } from "@/components/ui/popover";
import { request } from "@/ipc/client";
import type { GitState } from "@/ipc/generated";
import { cn } from "@/lib/utils";
import { toast } from "@/state/toasts";

/** Why a session's branch can't be created or switched from here (PLAN §4). */
const BRANCH_FIXED = "A session keeps the branch it started on";

function reason(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** The checkout's git state (or why it couldn't be read), read when `open` turns on. */
function useGitState(
  conversationId: string,
  open: boolean,
): { state: GitState | null; error: string | null } {
  const [read, setRead] = useState<{ state: GitState | null; error: string | null }>({
    state: null,
    error: null,
  });
  useEffect(() => {
    if (!open) return;
    let live = true;
    request({ method: "getGitState", conversationId })
      .then((response) => live && setRead({ state: response.state, error: null }))
      .catch((error: unknown) => live && setRead({ state: null, error: reason(error) }));
    return () => {
      live = false;
    };
  }, [conversationId, open]);
  return read;
}

function push(conversationId: string): void {
  request({ method: "pushChanges", conversationId })
    .then(({ branch }) => toast(`Pushed ${branch}`))
    .catch((error: unknown) => toast(`Failed to push: ${reason(error)}`, { tone: "error" }));
}

/**
 * The branch row's hover ⋯ "Git actions", as ChatGPT's pinned card has: Commit (the commit
 * popover), Push, Create branch and Switch branch. The last two stay off: a session's
 * branch is fixed when it starts.
 */
export const GitActions: FC<{ conversationId: string; children: ReactNode }> = ({
  conversationId,
  children,
}) => {
  const [menu, setMenu] = useState(false);
  const [committing, setCommitting] = useState(false);
  // Commit opens the popover once the menu has closed, so its focus return doesn't dismiss it.
  const commitNext = useRef(false);
  const { state, error } = useGitState(conversationId, menu || committing);
  return (
    <Popover open={committing} onOpenChange={setCommitting}>
      <PopoverAnchor asChild>
        <div className="group/git flex min-w-0 items-center gap-2">
          {children}
          <DropdownMenu open={menu} onOpenChange={setMenu}>
            <DropdownMenuTrigger asChild>
              <TooltipIconButton
                tooltip="Git actions"
                size="icon-xs"
                className={cn(
                  "opacity-0 transition-opacity group-hover/git:opacity-100 focus-visible:opacity-100",
                  menu && "opacity-100",
                )}
              >
                <DotsHorizontal />
              </TooltipIconButton>
            </DropdownMenuTrigger>
            <DropdownMenuContent
              align="end"
              className="min-w-36"
              onCloseAutoFocus={(event) => {
                if (!commitNext.current) return;
                commitNext.current = false;
                event.preventDefault();
                setCommitting(true);
              }}
            >
              <DropdownMenuItem onSelect={() => (commitNext.current = true)}>Commit</DropdownMenuItem>
              <DropdownMenuItem
                disabled={!state?.remote || state.ahead === 0}
                onSelect={() => push(conversationId)}
              >
                Push
              </DropdownMenuItem>
              <DropdownMenuItem disabled title={BRANCH_FIXED}>
                Create branch
              </DropdownMenuItem>
              <DropdownMenuItem disabled title={BRANCH_FIXED}>
                Switch branch
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </PopoverAnchor>
      <PopoverContent align="end" className="w-sm p-1">
        {committing && (
          <CommitForm
            conversationId={conversationId}
            state={state}
            error={error}
            onDone={() => setCommitting(false)}
          />
        )}
      </PopoverContent>
    </Popover>
  );
};

type Busy = null | "commit" | "commitAndPush" | "push";

/**
 * ChatGPT's commit popover: the branch, "Commit message (leave blank to generate)…",
 * "Include unstaged changes" with its +a −d, then Commit ⌘⏎, Commit and push, and Push.
 */
const CommitForm: FC<{
  conversationId: string;
  state: GitState | null;
  error: string | null;
  onDone: () => void;
}> = ({ conversationId, state, error, onDone }) => {
  const [message, setMessage] = useState("");
  const [unstaged, setUnstaged] = useState(true);
  const [busy, setBusy] = useState<Busy>(null);
  const counts = unstaged ? state?.uncommitted : state?.staged;
  const nothing = !counts || counts.files.length === 0;
  const commit = (andPush: boolean) => {
    if (nothing || busy) return;
    setBusy(andPush ? "commitAndPush" : "commit");
    request({
      method: "commitChanges",
      conversationId,
      message: message.trim() || null,
      includeUnstaged: unstaged,
      push: andPush,
    })
      .then(({ outcome }) => {
        toast(
          outcome.pushed
            ? `Committed and pushed to ${outcome.branch}`
            : `Committed to ${outcome.branch}`,
        );
        onDone();
      })
      .catch((failure: unknown) => {
        toast(`Failed to commit: ${reason(failure)}`, { tone: "error" });
        setBusy(null);
      });
  };
  const item =
    "hover:bg-muted rounded-control flex h-control-md w-full items-center gap-2 px-2 text-start text-sm disabled:pointer-events-none disabled:opacity-50";
  const glyph = (kind: Busy, icon: ReactNode) =>
    busy === kind ? <Spin className="size-icon-sm animate-spin motion-reduce:animate-none" /> : icon;
  return (
    <div data-slot="commit-popover" className="flex flex-col">
      <div className="text-muted-foreground flex h-control-md items-center gap-1.5 px-2 text-sm">
        <Branch className="size-icon-sm" />
        <span className="text-foreground truncate">{state?.branch ?? "…"}</span>
      </div>
      {error && <p className="text-destructive px-2 pb-1 text-xs">{error}</p>}
      <textarea
        autoFocus
        rows={3}
        value={message}
        disabled={busy !== null}
        placeholder="Commit message (leave blank to generate)…"
        onChange={(event) => setMessage(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
            event.preventDefault();
            commit(false);
          }
        }}
        className="placeholder:text-muted-foreground resize-none bg-transparent px-2 py-1 text-sm outline-none"
      />
      <label className="flex h-control-md cursor-pointer items-center gap-2 px-2 text-sm">
        <input
          type="checkbox"
          checked={unstaged}
          onChange={(event) => setUnstaged(event.target.checked)}
          className="peer sr-only"
        />
        <span
          aria-hidden
          className="border-border peer-checked:bg-foreground/10 peer-focus-visible:ring-ring/50 rounded-xs flex size-icon-sm items-center justify-center border peer-focus-visible:ring-1"
        >
          {unstaged && <Check className="size-icon-xs" />}
        </span>
        <span className="flex-1">Include unstaged changes</span>
        {state && (
          <span className="tabular-nums">
            <span className="text-success">+{state.uncommitted.insertions}</span>{" "}
            <span className="text-destructive">−{state.uncommitted.deletions}</span>
          </span>
        )}
      </label>
      <div className="border-border my-1 border-t" />
      <button
        type="button"
        disabled={nothing || busy !== null}
        onClick={() => commit(false)}
        className={item}
      >
        {glyph("commit", <Commit className="size-icon-sm" />)}
        <span className="flex-1">{busy === "commit" && !message.trim() ? "Writing message…" : "Commit"}</span>
        <Kbd>⌘⏎</Kbd>
      </button>
      <button
        type="button"
        disabled={nothing || !state?.remote || busy !== null}
        onClick={() => commit(true)}
        className={item}
      >
        {glyph("commitAndPush", <UploadDocuments className="size-icon-sm" />)}
        <span className="flex-1">Commit and push</span>
      </button>
      <button
        type="button"
        disabled={!state?.remote || state.ahead === 0 || busy !== null}
        onClick={() => {
          push(conversationId);
          onDone();
        }}
        className={item}
      >
        {glyph("push", <UploadDocuments className="size-icon-sm" />)}
        <span className="flex-1">Push</span>
      </button>
    </div>
  );
};
