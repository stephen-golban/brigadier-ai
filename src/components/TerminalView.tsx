import { useEffect, useRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
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
}: {
  context: WorkspaceContext;
  visible: boolean;
}) {
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
    const fit = new FitAddon();
    terminal.loadAddon(fit);
    terminal.open(host.current);
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
    void workspaceApi.openTerminal(context, terminal.cols, terminal.rows).then(
      (created) => {
        if (disposed) {
          void workspaceApi.closeTerminal(created);
          return;
        }
        id = created;
        resize();
        terminal.focus();
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
      terminal.dispose();
      if (id) void workspaceApi.closeTerminal(id).catch(() => {});
    };
  }, [context.projectId, context.sessionId]);
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
