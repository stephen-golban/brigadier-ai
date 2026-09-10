import { MessageActions } from "./assistant-ui/elements/message-actions";
import { profiling, traceEvent } from "../perfDiagnostics";
import { useEffect, useState, lazy, Suspense } from "react";

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
  if (!text.trim()) return null;
  return (
    <MessageActions
      copied={copied}
      copyLabel={error ? "Copy failed; try again" : copied ? "Copied" : "Copy"}
      onCopy={() => {
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
    />
  );
}
/**
 * `./MarkdownContent` is a 286 KB built chunk; its fetch, parse and evaluation is a candidate for
 * the stall on the first transcript mount. The profiling build stamps the moment it resolves; the
 * ordinary build gets the bare loader it always had, with no extra `.then` on the import.
 */
const MarkdownContent = lazy(
  profiling
    ? () => import("./MarkdownContent").then(module => { traceEvent("markdown-module"); return module; })
    : () => import("./MarkdownContent"),
);
export function Markdown(props: {
  text: string;
  onFile?: (path: string) => void;
}) {
  return (
    <Suspense
      fallback={
        <div className="whitespace-pre-wrap text-sm leading-relaxed">
          {props.text}
        </div>
      }
    >
      <MarkdownContent {...props} />
    </Suspense>
  );
}
