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
  type TerminalFrame,
  type WorkspaceContext,
} from "../workspaceApi";
/**
 * How many snapshot deadlines every mounted terminal is holding between them.
 *
 * A test hook, and the proof of the one claim this file makes that nothing else can observe: an
 * idle PTY arms no timer at all. Output arms one 3 s deadline; the deadline persists whatever
 * changed and disarms itself. Nothing re-arms it on its own.
 */
let armed = 0;
export function terminalTimers() {
  return armed;
}
/** Snapshot deadline: the most output that may be lost to a crash. */
const SNAPSHOT_MS = 3000;
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
  const infoRef = useRef<() => void>(() => {});
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!host.current) return;
    let disposed = false,
      id: string | null = null,
      timer: ReturnType<typeof setTimeout> | undefined,
      stop: (() => void) | null = null;
    // The sixteen ANSI slots were hex literals here until 2026-09-11; they are `--ansi-*` on
    // `:root` now, so the terminal's palette is edited in `src/index.css` with everything else.
    // `undefined` rather than a literal fallback when a token is absent: xterm then keeps its own
    // default for that slot, and no stale copy of a colour survives in this file.
    const ansi = (name: string) =>
      getComputedStyle(document.documentElement)
        .getPropertyValue(`--ansi-${name}`)
        .trim() || undefined;
    const readTheme = () => {
    const foreground = themeColor("text");
    const secondary = themeColor("text-secondary");
    return {
      background: themeColor("canvas"),
      foreground,
      cursor: foreground,
      cursorAccent: themeColor("canvas"),
      selectionBackground: themeColor("selected"),
      black: ansi("black"),
      red: ansi("red"),
      green: ansi("green"),
      yellow: ansi("yellow"),
      blue: ansi("blue"),
      magenta: ansi("magenta"),
      cyan: ansi("cyan"),
      white: ansi("white"),
      brightBlack: secondary,
      brightRed: ansi("bright-red"),
      brightGreen: ansi("bright-green"),
      brightYellow: ansi("bright-yellow"),
      brightBlue: ansi("bright-blue"),
      brightMagenta: ansi("bright-magenta"),
      brightCyan: ansi("bright-cyan"),
      brightWhite: ansi("bright-white"),
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
    // Serializing 200 lines of scrollback is the expensive half of this component, so it happens
    // only when something changed, and at most once per deadline. `dirty` is what changed;
    // `sawOutput` and `submitted` are why a CWD check is worth a round trip.
    let dirty = false,
      sawOutput = false,
      submitted = false;
    const flushSnapshot = () => {
      if (!dirty) return;
      dirty = false;
      persist();
    };
    // CWD has no event source from an arbitrary shell (`docs/plans/ipc-contract.md`, terminal
    // section): this is a poll, bounded to the moments it can have changed.
    const readInfo = () => {
      if (!id || disposed) return;
      sawOutput = submitted = false;
      const terminalId = id;
      void workbenchApi
        .terminalInfo(terminalId)
        .then((info) => {
          if (disposed || info.cwd === snapshot.cwd) return;
          snapshot.cwd = info.cwd;
          dirty = true;
          arm();
        })
        .catch(() => {});
    };
    infoRef.current = readInfo;
    const arm = () => {
      if (timer !== undefined || disposed) return;
      armed++;
      timer = setTimeout(() => {
        timer = undefined;
        armed--;
        flushSnapshot();
        if (visibleRef.current && (sawOutput || submitted)) readInfo();
      }, SNAPSHOT_MS);
    };
    const disarm = () => {
      if (timer === undefined) return;
      clearTimeout(timer);
      timer = undefined;
      armed--;
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
      const { cols, rows } = terminal;
      fit.fit();
      // A reflow rewraps the scrollback, so what is on disk is stale even though no byte arrived.
      // Without this, resize-then-close persisted the pre-resize wrap: `flushSnapshot` returns on
      // `!dirty` and output is the only other thing that sets it.
      if (terminal.cols !== cols || terminal.rows !== rows) dirty = true;
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
      // Enter is the only keystroke that can move the shell somewhere else; it is what earns the
      // one CWD check on the next deadline.
      if (data.includes("\r") || data.includes("\n")) {
        submitted = true;
        arm();
      }
      writing = writing
        .then(async () => {
          if (id && !disposed) await workspaceApi.writeTerminal(id, data);
        })
        .catch((e) => setError(errorMessage(e)));
    });
    // Frames arrive in order and each carries at most 4096 bytes; xterm reassembles escape
    // sequences and UTF-8 across writes, which is why the split is safe to make here.
    const onFrame = (frame: TerminalFrame) => {
      if (disposed) return;
      if (frame.dropped_before)
        terminal.write(
          `\r\n[${frame.dropped_before} bytes skipped while output exceeded the buffer]\r\n`,
        );
      if (frame.bytes)
        terminal.write(
          Uint8Array.from(atob(frame.bytes), (c) => c.charCodeAt(0)),
        );
      // `exited` arrives on its own frame, after the last byte the shell wrote.
      if (frame.exited) terminal.write("\r\n[Process exited]\r\n");
      dirty = sawOutput = true;
      arm();
    };
    const onPageHide = () => flushSnapshot();
    window.addEventListener("pagehide", onPageHide);
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
          // Nothing is fetched before this resolves: the backlog is the ring Rust already holds,
          // and it is delivered on this channel, in order, ahead of anything that arrives next.
          return workspaceApi.subscribeTerminal(created, onFrame).then(
            (teardown) => {
              if (disposed) teardown();
              else stop = teardown;
            },
            (e) => {
              if (!disposed) setError(errorMessage(e));
            },
          );
        },
        (e) => {
          if (!disposed) setError(errorMessage(e));
        },
      );
    return () => {
      disposed = true;
      disarm();
      stop?.();
      observer.disconnect();
      input.dispose();
      flushSnapshot();
      window.removeEventListener("pagehide", onPageHide);
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
    if (!focused) return;
    terminalRef.current?.focus();
    // Taking focus is the other moment the CWD can be stale without any output to say so — the
    // user may have changed it in a different tab on the same shell.
    infoRef.current();
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
