import { File, FileCode, FileDocument, FileImage } from "@openai/apps-sdk-ui/components/Icon";
import type { ReactNode } from "react";

/** A file's icon by its extension, as ChatGPT shows a file-type icon by a file's name. */
export function FileTypeIcon({ name, className }: { name: string; className?: string }): ReactNode {
  const extension = name.includes(".") ? (name.split(".").pop()?.toLowerCase() ?? "") : "";
  if (/^(png|jpe?g|gif|webp|svg|heic|bmp|ico)$/.test(extension)) {
    return <FileImage aria-hidden className={className} />;
  }
  if (/^(md|mdx|txt|rst|pdf|docx?|rtf)$/.test(extension)) {
    return <FileDocument aria-hidden className={className} />;
  }
  if (!extension || /^(json|ya?ml|toml|lock|ini|env|csv|xml|plist|cfg|conf)$/.test(extension)) {
    return <File aria-hidden className={className} />;
  }
  return <FileCode aria-hidden className={className} />;
}
