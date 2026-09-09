import { THEME_CHANGED_EVENT } from "../providers/ThemeProvider";
import { readArchive } from "../sessionArchive";
import { themeColor } from "../lib/theme";
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
  shell,
  cwd,
  focused = false,
  focusRequest = 0,
}: {
  context: WorkspaceContext;
  visible: boolean;
  tabId?: string;
  shell?: string;
  cwd?: string;
  focused?: boolean;
  focusRequest?: number;
  onReady?: (id: string | null) => void;
}) {
  const terminalRef = useRef<Terminal | null>(null);
  const visibleRef = useRef(visible);
  visibleRef.current = visible;
  const focusedRef = useRef(focused);
  focusedRef.current = focused;
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
    const readTheme = () => {
    const light = document.documentElement.classList.contains("light");
    const foreground = themeColor("text");
    const secondary = themeColor("text-secondary");
    return {
      background: themeColor("canvas"),
      foreground,
      cursor: foreground,
      cursorAccent: themeColor("canvas"),
      selectionBackground: themeColor("selected"),
      black: light ? "#30302e" : "#242424",
      red: light ? "#a83440" : "#e06c75",
      green: light ? "#397128" : "#98c379",
      yellow: light ? "#876b1d" : "#e5c07b",
      blue: light ? "#2367a6" : "#61afef",
      magenta: light ? "#8c429e" : "#c678dd",
      cyan: light ? "#207879" : "#56b6c2",
      white: light ? "#3a3a37" : "#dcdfe4",
      brightBlack: secondary,
      brightRed: light ? "#ba3f49" : "#f08080",
      brightGreen: light ? "#4a7b32" : "#b5d99c",
      brightYellow: light ? "#947324" : "#f5d491",
      brightBlue: light ? "#3974ab" : "#85c1ff",
      brightMagenta: light ? "#a052b0" : "#d8a1ee",
      brightCyan: light ? "#32828b" : "#80d4de",
      brightWhite: light ? "#242424" : "#ffffff",
    };
    };
    const terminal = new Terminal({
      fontSize: 12,
      fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
      cursorBlink: false,
      screenReaderMode: true,
      scrollback: 3000,
      theme: readTheme(),
    });
    terminalRef.current = terminal;
    const refreshTheme = () => { terminal.options.theme = readTheme(); terminal.refresh(0, terminal.rows - 1); };
    window.addEventListener(THEME_CHANGED_EVENT, refreshTheme);
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
      if (context.sessionId && readArchive().deleted.includes(context.sessionId)) return;
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
      .openTerminal(
        context,
        terminal.cols,
        terminal.rows,
        snapshot.cwd ?? cwd,
        shell,
      )
      .then(
        (created) => {
          if (disposed) {
            void workspaceApi.closeTerminal(created);
            return;
          }
          id = created;
          ready.current?.(created);
          resize();
          if (visibleRef.current && focusedRef.current) terminal.focus();
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
      window.removeEventListener(THEME_CHANGED_EVENT, refreshTheme);
      terminal.dispose();
      terminalRef.current = null;
      ready.current?.(null);
      if (id) void workspaceApi.closeTerminal(id).catch(() => {});
    };
  }, [context.projectId, context.sessionId, tabId]);
  useEffect(() => {
    if (visible) {
      fitRef.current();
      const terminal = terminalRef.current;
      if (terminal) terminal.refresh(0, terminal.rows - 1);
    }
  }, [visible]);
  useEffect(() => {
    if (focused) terminalRef.current?.focus();
  }, [focused, focusRequest]);
  return (
    <>
      {error ? (
        <p className="inline-error my-2 text-[13px] text-error" role="alert">
          {error}
        </p>
      ) : null}
      <div ref={host} className="terminal-host" />
    </>
  );
}
