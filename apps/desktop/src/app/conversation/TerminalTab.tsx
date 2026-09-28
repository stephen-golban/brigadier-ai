import "@xterm/xterm/css/xterm.css";

import { FitAddon } from "@xterm/addon-fit";
import { type ITheme, Terminal } from "@xterm/xterm";
import { useCallback, useEffect, useRef, useState } from "react";

import { request } from "@/ipc/client";
import type { TerminalInfo, TerminalOutput } from "@/ipc/generated";
import { cn } from "@/lib/utils";
import { useApp } from "@/state/store";
import { noteTerminal, onTerminalOutput } from "@/state/terminals";

/**
 * The Terminal tab (⌃`): the session's shell in its checkout. The shell runs in the
 * daemon and keeps running while the tab is hidden; closing the tab ends it.
 */

/** A token colour in hex, which the terminal's renderer understands (tokens are oklch). */
function tokenColor(name: `--${string}`): string {
  const canvas = document.createElement("canvas");
  canvas.width = 1;
  canvas.height = 1;
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) return "";
  context.fillStyle = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  context.fillRect(0, 0, 1, 1);
  const [red = 0, green = 0, blue = 0] = context.getImageData(0, 0, 1, 1).data;
  return `#${[red, green, blue].map((part) => part.toString(16).padStart(2, "0")).join("")}`;
}

function theme(): ITheme {
  return {
    background: tokenColor("--background"),
    foreground: tokenColor("--foreground"),
    cursor: tokenColor("--foreground"),
    cursorAccent: tokenColor("--background"),
    selectionBackground: tokenColor("--muted"),
  };
}

const DIM = "\u001b[2m";
const RESET = "\u001b[0m";

export function TerminalTab({ conversationId }: { conversationId: string }) {
  const density = useApp((s) => s.settings.density);
  // A new shell after the last one ended.
  const [generation, setGeneration] = useState(0);
  const restart = useCallback(() => setGeneration((current) => current + 1), []);
  const open = useCallback(
    async (cols: number, rows: number) => {
      const { terminal } = await request({ method: "openTerminal", conversationId, cols, rows });
      noteTerminal(conversationId, terminal.id);
      return terminal;
    },
    [conversationId],
  );
  // Its font size is a density token, so the terminal is laid out again when density changes.
  return <TerminalView key={`${density}:${generation}`} open={open} onRestart={restart} />;
}

/**
 * A shell the daemon runs, shown live: `open` starts it (or re-attaches to it) at the view's
 * size. When it ends, `onExit` hears its exit code; without one, the next key pressed calls
 * `onRestart` for a new shell.
 */
export function TerminalView({
  open,
  onRestart,
  onExit,
  focus = true,
  className,
}: {
  open: (cols: number, rows: number) => Promise<TerminalInfo>;
  onRestart?: () => void;
  onExit?: (code: number | null) => void;
  /** Takes the keyboard once it is open. */
  focus?: boolean;
  className?: string;
}) {
  const host = useRef<HTMLDivElement>(null);
  const connected = useApp((s) => s.connection.status === "connected");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const element = host.current;
    if (!connected || !element) return;
    const style = getComputedStyle(element);
    const terminal = new Terminal({
      fontFamily: style.fontFamily,
      fontSize: Number.parseFloat(style.fontSize),
      theme: theme(),
      cursorBlink: true,
      scrollback: 5000,
    });
    const fit = new FitAddon();
    terminal.loadAddon(fit);
    terminal.open(element);
    fit.fit();

    let id: string | null = null;
    let ended = false;
    // Output can arrive before `openTerminal` answers; it waits here until then.
    const early: TerminalOutput[] = [];
    const show = (output: TerminalOutput) => {
      if (output.type === "data") {
        terminal.write(output.data);
        return;
      }
      ended = true;
      const code = output.code === null ? "" : ` with code ${output.code}`;
      if (onExit) {
        terminal.write(`\r\n${DIM}[Process exited${code}.]${RESET}\r\n`);
        onExit(output.code);
        return;
      }
      terminal.write(`\r\n${DIM}[Process exited${code}. Press any key to start a new shell.]${RESET}\r\n`);
    };
    const stop = onTerminalOutput((output) => {
      if (id === null) early.push(output);
      else if (output.terminalId === id) show(output);
    });
    let live = true;
    open(terminal.cols, terminal.rows)
      .then((opened) => {
        if (!live) return;
        id = opened.id;
        setError(null);
        terminal.write(opened.scrollback);
        for (const output of early.splice(0)) if (output.terminalId === id) show(output);
        if (focus) terminal.focus();
      })
      .catch((cause: unknown) => {
        if (live) setError(cause instanceof Error ? cause.message : String(cause));
      });

    const input = terminal.onData((data) => {
      if (ended) {
        onRestart?.();
        return;
      }
      if (id) {
        request({ method: "writeTerminal", terminalId: id, data }).catch(() => {});
      }
    });
    const resize = terminal.onResize(({ cols, rows }) => {
      if (id && !ended) {
        request({ method: "resizeTerminal", terminalId: id, cols, rows }).catch(() => {});
      }
    });
    const observer = new ResizeObserver(() => fit.fit());
    observer.observe(element);
    return () => {
      live = false;
      observer.disconnect();
      input.dispose();
      resize.dispose();
      stop();
      terminal.dispose();
    };
  }, [open, connected, onRestart, onExit, focus]);

  return (
    <div className={cn("bg-background flex min-h-0 flex-1 flex-col", className)}>
      {error && (
        <p role="alert" className="text-destructive shrink-0 px-4 py-2 text-sm">
          {error}
        </p>
      )}
      <div
        ref={host}
        data-slot="terminal"
        className="min-h-0 flex-1 px-3 py-2 font-mono text-xs"
      />
    </div>
  );
}
