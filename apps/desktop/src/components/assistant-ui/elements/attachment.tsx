import {
  AttachmentPrimitive,
  ComposerPrimitive,
  useAuiState,
} from "@assistant-ui/react";
import { Spin, Warning, X } from "@openai/apps-sdk-ui/components/Icon";
import type { FC } from "react";

import { AttachmentIcon } from "@/components/assistant-ui/elements/message-attachment";
import { field } from "@/components/assistant-ui/elements/surfaces";
import { TooltipIconButton } from "@/components/assistant-ui/tooltip-icon-button";
import { cn } from "@/lib/utils";

/**
 * One composer attachment (the assistant-ui Attachment element, on Brigadier's tokens): a
 * chip with the file name, its upload state and a remove button. Brigadier has no preview
 * of the stored file, so the element's preview dialog is left out.
 */
const ComposerAttachment: FC = () => {
  const mime = useAuiState((s) => s.attachment.contentType ?? "");
  const state = useAuiState((s) => {
    const status = s.attachment.status;
    if (status.type === "running") return "uploading";
    if (status.type === "incomplete" && status.reason === "error") return "error";
    return "ready";
  });
  return (
    <AttachmentPrimitive.Root
      data-slot="composer-attachment"
      data-state={state}
      className={cn(
        field,
        "rounded-control animate-in fade-in-0 zoom-in-95 flex max-w-xs items-center gap-2 py-1 ps-2.5 pe-1 duration-200 motion-reduce:animate-none",
        state === "error" && "text-destructive",
      )}
    >
      {state === "uploading" ? (
        <Spin aria-label="Uploading" className="text-muted-foreground size-icon-sm animate-spin" />
      ) : state === "error" ? (
        <Warning aria-label="Upload failed" className="size-icon-sm" />
      ) : (
        <AttachmentIcon mime={mime} className="text-muted-foreground" />
      )}
      <span className="min-w-0 truncate text-xs">
        <AttachmentPrimitive.Name />
      </span>
      <AttachmentPrimitive.Remove asChild>
        <TooltipIconButton tooltip="Remove file" side="top" size="icon-xs">
          <X />
        </TooltipIconButton>
      </AttachmentPrimitive.Remove>
    </AttachmentPrimitive.Root>
  );
};

export const ComposerAttachments: FC = () => (
  <div
    data-slot="composer-attachments"
    className="flex w-full flex-wrap items-center gap-1.5 px-1 empty:hidden"
  >
    <ComposerPrimitive.Attachments>{() => <ComposerAttachment />}</ComposerPrimitive.Attachments>
  </div>
);
