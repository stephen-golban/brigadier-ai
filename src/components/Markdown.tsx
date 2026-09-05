import { useEffect, useState, lazy, Suspense } from "react";
import { CopyIcon, CheckIcon } from "@phosphor-icons/react";

export function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState(false);
  useEffect(() => {
    setCopied(false);
    setError(false);
  }, [text]);
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 2000);
    return () => clearTimeout(timer);
  }, [copied]);
  return (
    <button
      className="icon-button copy-button"
      aria-label={error ? "Copy failed; try again" : copied ? "Copied" : "Copy"}
      title={
        error
          ? "Copy failed; select the text to copy"
          : copied
            ? "Copied"
            : "Copy"
      }
      onClick={() => {
        void Promise.resolve()
          .then(() => navigator.clipboard.writeText(text))
          .then(
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
