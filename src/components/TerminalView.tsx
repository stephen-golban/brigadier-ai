import { useEffect, useRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
import { SerializeAddon } from "@xterm/addon-serialize";
import { workbenchApi } from "../workbenchApi";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import {
  workspaceApi,
  errorMessage,
  type WorkspaceContext,
} from "../workspaceApi";
export default function TerminalView({
  context,
  visible,
  tabId = "legacy",
  onReady,
}: {
  context: WorkspaceContext;
  visible: boolean;
  tabId?: string;
  onReady?: (id: string | null) => void;
}) {
  const visibleRef = useRef(visible);
  visibleRef.current = visible;
  const ready = useRef(onReady);
  ready.current = onReady;
  const host = useRef<HTMLDivElement>(null);
  const fitRef = useRef<() => void>(() => {});
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!host.current) return;
    let disposed = false,
      id: string | null = null,
      timer: ReturnType<typeof setTimeout>;
    const terminal = new Terminal({
      fontSize: 12,
      fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
      cursorBlink: true,
      scrollback: 3000,
      theme: { background: "#181818", foreground: "#dedede" },
    });
    const snapshotKey = `brigadier:terminal:${tabId}`;
    let snapshot: { output?: string; cwd?: string } = {};
    try {
      snapshot = JSON.parse(localStorage.getItem(snapshotKey) ?? "{}");
    } catch {
      /* fresh shell */
    }
    const serialize = new SerializeAddon();
    terminal.loadAddon(serialize);
    const persist = () => {
      try {
        localStorage.setItem(
          snapshotKey,
          JSON.stringify({
            ...snapshot,
            output: serialize.serialize({ scrollback: 200 }),
          }),
        );
      } catch {
        /* bounded recovery is best effort */
      }
    };
    const fit = new FitAddon();
    terminal.loadAddon(fit);
    terminal.open(host.current);
    if (snapshot.output)
      terminal.write(
        snapshot.output + "\r\n[Restored output. Starting a fresh shell.]\r\n",
      );
    const resize = () => {
      if (!host.current?.clientWidth) return;
      fit.fit();
      if (id)
        void workspaceApi
          .resizeTerminal(id, terminal.cols, terminal.rows)
          .catch((e) => setError(errorMessage(e)));
    };
    fitRef.current = resize;
    resize();
    const observer = new ResizeObserver(resize);
    observer.observe(host.current);
    // Serialize writes so keystrokes and pasted chunks preserve input order.
    let writing = Promise.resolve();
    const input = terminal.onData((data) => {
      writing = writing
        .then(async () => {
          if (id && !disposed) await workspaceApi.writeTerminal(id, data);
        })
        .catch((e) => setError(errorMessage(e)));
    });
    const read = async () => {
      if (!id || disposed) return;
      try {
        const output = await workspaceApi.readTerminal(id);
        if (disposed) return;
        if (output.dropped)
          terminal.write(
            `\r\n[${output.dropped} bytes skipped while output exceeded the buffer]\r\n`,
          );
        if (output.data.length) terminal.write(new Uint8Array(output.data));
        if (output.exited && !output.data.length) {
          terminal.write("\r\n[Process exited]\r\n");
          return;
        }
        timer = setTimeout(
          () => void read(),
          output.data.length === 8192 ? 0 : 50,
        );
      } catch (e) {
        if (!disposed) setError(errorMessage(e));
      }
    };
    const recovery = setInterval(() => {
      persist();
      if (id)
        void workbenchApi
          .terminalInfo(id)
          .then((info) => {
            snapshot.cwd = info.cwd;
          })
          .catch(() => {});
    }, 3000);
    window.addEventListener("pagehide", persist);
    void workspaceApi
      .openTerminal(context, terminal.cols, terminal.rows, snapshot.cwd)
      .then(
        (created) => {
          if (disposed) {
            void workspaceApi.closeTerminal(created);
            return;
          }
          id = created;
          ready.current?.(created);
          resize();
          if (visibleRef.current) terminal.focus();
          void read();
        },
        (e) => {
          if (!disposed) setError(errorMessage(e));
        },
      );
    return () => {
      disposed = true;
      clearTimeout(timer);
      observer.disconnect();
      input.dispose();
      persist();
      clearInterval(recovery);
      window.removeEventListener("pagehide", persist);
      terminal.dispose();
      ready.current?.(null);
      if (id) void workspaceApi.closeTerminal(id).catch(() => {});
    };
  }, [context.projectId, context.sessionId, tabId]);
  useEffect(() => {
    if (visible) fitRef.current();
  }, [visible]);
  return (
    <>
      {error ? (
        <p className="inline-error" role="alert">
          {error}
        </p>
      ) : null}
      <div ref={host} className="terminal-host" />
    </>
  );
}
