import { FileDocument, FileImage, Paperclip } from "@openai/apps-sdk-ui/components/Icon";
import type { ComponentProps } from "react";

import { field, mono } from "@/components/assistant-ui/elements/surfaces";
import type { AttachmentRef } from "@/ipc/generated";
import { formatBytes } from "@/lib/format";
import { cn } from "@/lib/utils";

function AttachmentIcon({ mime, className }: { mime: string; className?: string }) {
  const Icon = mime.startsWith("image/")
    ? FileImage
    : mime.startsWith("text/") || mime === "application/pdf"
      ? FileDocument
      : Paperclip;
  return <Icon aria-hidden className={cn("size-icon-sm shrink-0", className)} />;
}

/** The Message attachment element (assistant-ui), on Brigadier's tokens: one chip per file. */
export function MessageAttachments({
  attachments,
  className,
  ...props
}: Omit<ComponentProps<"ul">, "children"> & { attachments: readonly AttachmentRef[] }) {
  if (attachments.length === 0) return null;
  return (
    <ul
      data-slot="message-attachments"
      aria-label="Attachments"
      className={cn("flex flex-wrap gap-1.5", className)}
      {...props}
    >
      {attachments.map((attachment) => (
        <li
          key={attachment.id}
          title={attachment.name}
          className={cn(field, "rounded-control flex max-w-xs items-center gap-2 px-2.5 py-1.5")}
        >
          <AttachmentIcon mime={attachment.mime} className="text-muted-foreground" />
          <span className="min-w-0 truncate text-xs">{attachment.name}</span>
          <span className={cn(mono, "text-muted-foreground shrink-0")}>
            {formatBytes(attachment.bytes)}
          </span>
        </li>
      ))}
    </ul>
  );
}

/** "2 files · 1.2 MB": a one-line summary, for queued messages. */
export function attachmentSummary(attachments: readonly AttachmentRef[]): string | null {
  if (attachments.length === 0) return null;
  const bytes = attachments.reduce((sum, attachment) => sum + attachment.bytes, 0);
  const noun = attachments.length === 1 ? attachments[0]?.name ?? "1 file" : `${attachments.length} files`;
  return `${noun} · ${formatBytes(bytes)}`;
}

export { AttachmentIcon };
