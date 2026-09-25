import { useAui, useAuiState } from "@assistant-ui/react";
import {
  Archive,
  BranchAlt,
  ChatCompose,
  Document,
  InfoCircle,
  Lightbulb,
  Pencil,
  Pin,
  SettingsSlider,
  Unpin,
} from "@openai/apps-sdk-ui/components/Icon";
import { type FC, useContext, useMemo, useState } from "react";

import { ForkPlaces } from "@/app/conversation/ForkMenu";
import { StatusCardContext } from "@/app/conversation/StatusCard";
import { useAction } from "@/app/conversation/useAction";
import { NameDialog } from "@/app/NameDialog";
import { ContextArc, contextShare } from "@/components/assistant-ui/context-ring";
import {
  type ComposerCommand,
  ComposerCommands,
} from "@/components/assistant-ui/elements/composer-commands";
import { DropdownMenu, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import type { Conversation } from "@/ipc/generated";
import { useCanCompact } from "@/lib/setup";
import {
  archive,
  compact,
  forkConversation,
  renameConversation,
  select,
  setPinned,
  updateSetup,
} from "@/state/actions";
import { useBoard } from "@/state/board";

/** What `/init` asks the orchestrator, as Codex's `/init` asks its agent. */
const INIT_PROMPT =
  "Create an AGENTS.md file at the repository root with instructions for the coding agents " +
  "that work in this repository: how the project is laid out, how to build, run and test it, " +
  "its coding conventions, and what an agent must not do. Have the repository scouted first, " +
  "and keep the file short and specific to this project.";

/** The id of the newest answer on the shown branch, which `/fork` forks from. */
export function useLatestAnswer(): string | null {
  return useAuiState((s) => {
    for (let index = s.thread.messages.length - 1; index >= 0; index--) {
      const custom = s.thread.messages[index]?.metadata.custom as {
        block?: { answerId: string | null };
      };
      if (custom.block?.answerId) return custom.block.answerId;
    }
    return null;
  });
}

/**
 * ChatGPT's `/` menu in the composer, with the commands that mean something in Brigadier:
 * Archive, Compact (Chats whose CLI compacts), Fork, Init (sessions), Model, New, Pin, Rename
 * and Status. A draft has only Model.
 */
export const SlashCommands: FC<{
  conversation: Conversation | null;
  onOpenModel: () => void;
}> = ({ conversation, onOpenModel }) => {
  const aui = useAui();
  const status = useContext(StatusCardContext);
  const compactable = useCanCompact(conversation?.setup);
  const share = useBoard((s) =>
    s.board && s.board.conversationId === conversation?.id ? contextShare(s.board.context) : null,
  );
  const answer = useLatestAnswer();
  const { run, error } = useAction();
  const [renaming, setRenaming] = useState(false);
  const [forking, setForking] = useState(false);

  const commands = useMemo<ComposerCommand[]>(() => {
    const model: ComposerCommand = {
      id: "model",
      label: "Model",
      icon: <SettingsSlider />,
      run: onOpenModel,
    };
    if (!conversation) return [model];
    const id = conversation.id;
    const noun = conversation.kind === "chat" ? "chat" : "session";
    const pinned = conversation.pinnedAtMs !== null;
    const list: ComposerCommand[] = [
      {
        id: "archive",
        label: "Archive",
        description: `Archive the current ${noun}`,
        icon: <Archive />,
        run: () => run(() => archive(id)),
      },
      model,
      {
        id: "new",
        label: `New ${noun}`,
        description:
          conversation.kind === "chat"
            ? "Start a blank chat"
            : "Start a blank session in the same project",
        icon: <ChatCompose />,
        run: () =>
          select(
            conversation.kind === "session" && conversation.projectId
              ? { type: "draft", kind: "session", projectId: conversation.projectId }
              : { type: "draft", kind: "chat" },
          ),
      },
      {
        id: "pin",
        label: pinned ? `Unpin ${noun}` : `Pin ${noun}`,
        icon: pinned ? <Unpin /> : <Pin />,
        run: () => run(() => setPinned(id, !pinned)),
      },
      {
        id: "rename",
        label: "Rename",
        description: `Rename this ${noun}`,
        icon: <Pencil />,
        run: () => setRenaming(true),
      },
      {
        id: "status",
        label: "Status",
        description: `Show ${noun} ID, context usage, and rate limits`,
        icon: <InfoCircle />,
        run: () => status.setOpen(true),
      },
    ];
    if (answer) {
      list.push({
        id: "fork",
        label: `Fork ${noun}`,
        description:
          conversation.kind === "chat"
            ? "Fork this chat from its latest answer"
            : "Fork this session in the current workspace or a new worktree",
        icon: <BranchAlt />,
        run: () =>
          conversation.kind === "chat"
            ? run(() => forkConversation(id, answer, "workspace"))
            : setForking(true),
      });
    }
    if (compactable && answer) {
      list.push({
        id: "compact",
        label: "Compact",
        description:
          share === null
            ? "Compact this chat's context"
            : `Compact this chat's context (${Math.round(share * 100)}% full)`,
        icon: <ContextArc share={share} className="size-icon-sm" />,
        run: () => run(() => compact(id)),
      });
    }
    const { setup } = conversation;
    if (setup?.type === "session") {
      list.push({
        id: "plan",
        label: "Plan mode",
        description: setup.planMode ? "Turn plan mode off" : "Turn plan mode on",
        icon: <Lightbulb />,
        run: () => run(() => updateSetup(id, { ...setup, planMode: !setup.planMode })),
      });
    }
    if (conversation.kind === "session") {
      list.push({
        id: "init",
        label: "Init",
        description: "Create an AGENTS.md file with instructions for workers",
        icon: <Document />,
        run: () => {
          const composer = aui.composer();
          composer.setText(INIT_PROMPT);
          composer.send();
        },
      });
    }
    return list.toSorted((a, b) => a.label.localeCompare(b.label));
  }, [conversation, answer, compactable, share, onOpenModel, status, run, aui]);

  return (
    <>
      <ComposerCommands commands={commands} />
      {error && (
        <p role="alert" className="text-destructive absolute bottom-full start-0 mb-2 text-xs">
          {error}
        </p>
      )}
      {conversation && answer && (
        <DropdownMenu open={forking} onOpenChange={setForking}>
          <DropdownMenuTrigger asChild>
            <span aria-hidden className="pointer-events-none absolute start-0 top-0" />
          </DropdownMenuTrigger>
          <ForkPlaces
            side="top"
            onPick={(place) =>
              run(() => forkConversation(conversation.id, answer, place))
            }
          />
        </DropdownMenu>
      )}
      {conversation && (
        <NameDialog
          open={renaming}
          onOpenChange={setRenaming}
          title={conversation.kind === "chat" ? "Rename chat" : "Rename session"}
          label="Title"
          initialValue={conversation.title}
          confirmLabel="Rename"
          onSubmit={(title) => renameConversation(conversation.id, title)}
        />
      )}
    </>
  );
};
