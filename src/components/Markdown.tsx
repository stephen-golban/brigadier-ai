import { useState, lazy, Suspense } from "react";
import { CopyIcon, CheckIcon } from "@phosphor-icons/react";

export function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState(false);
  return (
    <button
      className="icon-button copy-button"
      aria-label={copied ? "Copied" : "Copy"}
      title={
        error
          ? "Copy failed; select the text to copy"
          : copied
            ? "Copied"
            : "Copy"
      }
      onClick={() => {
        void navigator.clipboard.writeText(text).then(
          () => {
            setCopied(true);
            setError(false);
          },
          () => setError(true),
        );
      }}
    >
      {copied ? <CheckIcon size={15} /> : <CopyIcon size={15} />}
    </button>
  );
}
const MarkdownContent = lazy(() => import("./MarkdownContent"));
export function Markdown(props: {
  text: string;
  onFile?: (path: string) => void;
}) {
  return (
    <Suspense fallback={<div className="markdown">{props.text}</div>}>
      <MarkdownContent {...props} />
    </Suspense>
  );
}
