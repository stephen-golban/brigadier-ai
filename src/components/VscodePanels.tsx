import { useEffect, useRef, useState } from "react";
import { Button } from "./controls/button";
import { errorMessage } from "../workspaceApi";
import type { PanelBinding } from "../vscode-panels/types";

type Runtime = typeof import("../vscode-panels/runtime");
type Props = Omit<PanelBinding, "onError"> & {
  active: boolean;
};
/** React owns the shell; the lazily loaded VS Code workbench owns the complete panel DOM. */
export function VscodePanels(props: Props) {
  const host = useRef<HTMLDivElement>(null);
  const runtime = useRef<Runtime | null>(null);
  const latest = useRef(props);
  latest.current = props;
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const binding = (): PanelBinding => ({
    ...latest.current,
    onError: setError,
  });
  useEffect(() => {
    const element = host.current;
    if (!props.active || !element) return;
    let live = true;
    setError("");
    void import("../vscode-panels/runtime")
      .then(async (module) => {
        if (!live) return;
        runtime.current = module;
        await module.mountPanels(element, binding());
        if (live) {
          module.updatePanels(element, binding());
          setLoading(false);
        }
      })
      .catch((error) => {
        if (live) {
          setError(errorMessage(error));
          setLoading(false);
        }
      });
    return () => {
      live = false;
      runtime.current?.unmountPanels(element);
    };
  }, [
    props.active,
    props.context.projectId,
    props.context.sessionId,
    props.mode,
  ]);
  useEffect(() => {
    if (host.current && runtime.current && props.active)
      runtime.current.updatePanels(host.current, binding());
  }, [props.status, props.revision, props.openPaths, props.active]);
  return (
    <section
      className="relative flex h-full min-h-0 flex-1 flex-col bg-canvas"
      aria-label={"Search"}
    >
      {loading && (
        <p className="px-3 py-2 text-xs text-text-secondary" role="status">
          Loading panel…
        </p>
      )}
      {error && (
        <div
          role="alert"
          className="flex items-start gap-2 px-3 py-2 text-xs text-error"
        >
          <span className="flex-1">{error}</span>
          <Button aria-label="Dismiss error" onClick={() => setError("")}>
            ×
          </Button>
        </div>
      )}
      <div
        ref={host}
        className="brigadier-vscode-panel monaco-workbench flex-1"
        tabIndex={-1}
      />
    </section>
  );
}
