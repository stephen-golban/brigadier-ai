import { BranchAlt } from "@openai/apps-sdk-ui/components/Icon";
import type { FC } from "react";

import { useAction } from "@/app/conversation/useAction";
import { TooltipIconButton } from "@/components/assistant-ui/tooltip-icon-button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import type { ConversationKind, ForkPlace } from "@/ipc/generated";
import { forkConversation } from "@/state/actions";

const PLACES: readonly { place: ForkPlace; title: string; detail: string }[] = [
  {
    place: "workspace",
    title: "Fork in this workspace",
    detail: "Fork from this message in the current workspace",
  },
  {
    place: "newWorktree",
    title: "Fork in a new worktree",
    detail: "Fork from this message in a new worktree",
  },
];

/**
 * "Fork chat from here" under an answer, as ChatGPT has it. A session asks where the fork
 * works (its checkout or a new worktree, from the commit current at this answer); a Chat,
 * which works nowhere, forks at once.
 */
export const ForkMenu: FC<{ conversationId: string; kind: ConversationKind; messageId: string }> = ({
  conversationId,
  kind,
  messageId,
}) => {
  const action = useAction();
  const fork = (place: ForkPlace) =>
    action.run(() => forkConversation(conversationId, messageId, place));
  const button = (
    <TooltipIconButton
      tooltip="Fork chat from here"
      disabled={action.busy}
      onClick={kind === "chat" ? () => fork("workspace") : undefined}
    >
      <BranchAlt />
    </TooltipIconButton>
  );
  const error = action.error && (
    <span role="alert" className="text-destructive text-xs">
      {action.error}
    </span>
  );
  if (kind === "chat") {
    return (
      <>
        {button}
        {error}
      </>
    );
  }
  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>{button}</DropdownMenuTrigger>
        <DropdownMenuContent side="bottom" align="start" className="w-sm p-2">
          <DropdownMenuLabel className="text-foreground px-2 pt-1 pb-2 font-sans text-base font-semibold tracking-normal normal-case">
            Fork chat from here
          </DropdownMenuLabel>
          {PLACES.map(({ place, title, detail }) => (
            <DropdownMenuItem
              key={place}
              className="items-start gap-3 py-2"
              onSelect={() => fork(place)}
            >
              <BranchAlt className="mt-0.5" />
              <span className="flex flex-col gap-0.5">
                <span>{title}</span>
                <span className="text-muted-foreground text-xs">{detail}</span>
              </span>
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
      {error}
    </>
  );
};
