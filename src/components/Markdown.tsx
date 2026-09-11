import { MessageActions } from "./assistant-ui/elements/message-actions";
import { profiling, traceEvent } from "../perfDiagnostics";
import { memo, useEffect, useState, lazy, Suspense } from "react";

export const CopyButton = memo(function CopyButton({ text }: { text: string }) {
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
});
/**
 * `./MarkdownContent` is a 286 KB built chunk. It was a **candidate** for the stall on the first
 * transcript mount and the traces exculpate it: `docs/performance/2026-09-11/cold-path-attribution.md`
 * §3 measures `markdown-module` resolving 15-21 ms *after* the last dropping frame in three of four
 * traced captures, inside a frame that drops zero vsyncs. What it still costs is one late 21-26 ms
 * frame. The profiling build stamps the moment it resolves; the ordinary build gets the bare loader
 * it always had, with no extra `.then` on the import.
 */
let contentModule: Promise<typeof import("./MarkdownContent")> | undefined;
function loadMarkdownContent() {
  if (!contentModule) {
    contentModule = profiling
      ? import("./MarkdownContent").then(module => { traceEvent("markdown-module"); return module; })
      : import("./MarkdownContent");
    // A preload that failed must not poison the render path with a cached rejection, and must not
    // surface as an unhandled rejection when nobody is awaiting it.
    contentModule.catch(() => { contentModule = undefined; });
  }
  return contentModule;
}
/**
 * Fetches, parses and evaluates the chunk ahead of the first transcript, sharing the one promise
 * `lazy` uses so it is never fetched twice. **No call site yet:** it belongs after the startup
 * `Promise.all` in `src/App.tsx` behind a zero-delay `setTimeout`, which is after first contentful
 * paint and so cannot spend the 295 ms budget. Not `requestIdleCallback`: unchecked in this WKWebView.
 */
export function preloadMarkdownContent(): Promise<void> {
  return loadMarkdownContent().then(() => {}, () => {});
}
const MarkdownContent = lazy(loadMarkdownContent);
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
