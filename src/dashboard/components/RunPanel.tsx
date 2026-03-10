/**
 * RunPanel.tsx
 * - No "connecting to server" / "spawning" banner — silent startup
 * - Terminal never remounts or loses data when panes split
 * - Restart only on explicit user request
 */

import { useEffect, useRef, useCallback } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { invoke } from "@tauri-apps/api/core";
import { listen, UnlistenFn } from "@tauri-apps/api/event";
import "@xterm/xterm/css/xterm.css";

const THEME = {
  background:          "#0d0d0d",
  foreground:          "#eeeeee",
  cursor:              "#ffffff",
  cursorAccent:        "#0d0d0d",
  selectionBackground: "rgba(255,255,255,0.2)",
  selectionForeground: "#ffffff",
  black:   "#1a1e26", brightBlack:   "#6b7280",
  red:     "#f87171", brightRed:     "#fca5a5",
  green:   "#4ade80", brightGreen:   "#86efac",
  yellow:  "#fbbf24", brightYellow:  "#fde68a",
  blue:    "#79b8ff", brightBlue:    "#93c5fd",
  magenta: "#c084fc", brightMagenta: "#d8b4fe",
  cyan:    "#22d3ee", brightCyan:    "#67e8f9",
  white:   "#eeeeee", brightWhite:   "#ffffff",
};

const CSS = `
  @import url('https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;500&display=swap');
  .sbx-wrap {
    width: 100%; height: 100%;
    background: #0d0d0d;
    display: flex; flex-direction: column;
    overflow: hidden; position: relative;
    transition: opacity .2s;
  }
  .sbx-term {
    flex: 1; min-height: 0; min-width: 0;
    overflow: hidden; cursor: text;
    padding: 4px 0 4px 4px; box-sizing: border-box;
  }
  .sbx-term .xterm,
  .sbx-term .xterm-viewport,
  .sbx-term .xterm-screen { background: transparent !important; }
  .sbx-term .xterm-viewport::-webkit-scrollbar { width: 3px; }
  .sbx-term .xterm-viewport::-webkit-scrollbar-thumb { background: rgba(255,255,255,.1); border-radius: 2px; }
`;

function parseOsc7(data: string): string | null {
  const m = data.match(/\x1b]7;file:\/\/[^/]*([^\x07\x1b]+)[\x07\x1b]/);
  if (!m) return null;
  try {
    let p = decodeURIComponent(m[1]);
    p = p.replace(/^\/[A-Za-z]:\/Users\/[^/]+(\/|$)/, "~/");
    p = p.replace(/^\/Users\/[^/]+(\/|$)/, "~/");
    p = p.replace(/^\/home\/[^/]+(\/|$)/, "~/");
    p = p.replace(/^~\/\//, "~/");
    if (p !== "~/") p = p.replace(/\/$/, "");
    return p || "~/";
  } catch { return null; }
}

export default function RunPanel({
  runboxCwd = "~/",
  runboxId  = "default",
  onCwdChange,
  isActive,
  onActivate,
}: {
  runboxCwd?:   string;
  runboxId?:    string;
  onCwdChange?: (cwd: string) => void;
  isActive?:    boolean;
  onActivate?:  () => void;
}) {
  const termElRef = useRef<HTMLDivElement>(null);
  const termRef   = useRef<Terminal | null>(null);
  const fitRef    = useRef<FitAddon | null>(null);
  // Stable session ID — never changes for the lifetime of this component
  const sidRef    = useRef<string>(`${runboxId}-${crypto.randomUUID()}`);
  const gone      = useRef(false);

  // Inject CSS once
  useEffect(() => {
    if (!document.getElementById("sbx-css")) {
      const s = document.createElement("style");
      s.id = "sbx-css"; s.textContent = CSS;
      document.head.appendChild(s);
    }
  }, []);

  // Focus when activated
  useEffect(() => {
    if (isActive) setTimeout(() => termRef.current?.focus(), 30);
  }, [isActive]);

  const sendInput = useCallback((text: string) => {
    invoke("pty_write", { sessionId: sidRef.current, data: text }).catch(() => {});
  }, []);

  // Mount terminal + spawn PTY — runs ONCE, never re-runs
  useEffect(() => {
    if (!termElRef.current) return;
    gone.current = false;

    const term = new Terminal({
      cursorBlink:           true,
      cursorStyle:           "bar",
      fontSize:              14,
      fontFamily:            "'JetBrains Mono','Cascadia Code','Fira Code','Consolas',monospace",
      lineHeight:            1.55,
      letterSpacing:         0.3,
      theme:                 THEME,
      convertEol:            true,
      scrollback:            5000,
      allowTransparency:     true,
      macOptionIsMeta:       true,
      rightClickSelectsWord: true,
      disableStdin:          false,
    });

    const fit   = new FitAddon();
    const links = new WebLinksAddon();
    term.loadAddon(fit);
    term.loadAddon(links);
    term.open(termElRef.current);
    termRef.current = term;
    fitRef.current  = fit;

    term.onData(text => sendInput(text));

    requestAnimationFrame(() => {
      try { fit.fit(); } catch { /**/ }
      term.focus();
    });

    // Resize observer — refit on any size change
    const ro = new ResizeObserver(() => {
      try {
        fit.fit();
        invoke("pty_resize", {
          sessionId: sidRef.current,
          cols: term.cols,
          rows: term.rows,
        }).catch(() => {});
      } catch { /**/ }
    });
    ro.observe(termElRef.current!);

    let unlistenOutput: UnlistenFn | null = null;
    let unlistenEnded:  UnlistenFn | null = null;
    const sid = sidRef.current;

    // Grace period: ignore stale "ended" events that fire right after spawn.
    // Without this, a leftover event from a previous session triggers
    // "session ended" immediately before the shell even starts.
    let spawnedAt = 0;
    const GRACE_MS = 2000;

    // Register listeners FIRST, then spawn — so no output is lost
    Promise.all([
      listen<string>(`pty://output/${sid}`, ({ payload }) => {
        if (gone.current) return;
        term.write(payload);
        const cwd = parseOsc7(payload);
        if (cwd && onCwdChange) onCwdChange(cwd);
      }),
      listen<void>(`pty://ended/${sid}`, () => {
        if (gone.current) return;
        // Ignore if fired too soon after spawn — it's a stale event
        if (Date.now() - spawnedAt < GRACE_MS) return;
        term.write("\r\n\x1b[2m[session ended — press any key to restart]\x1b[0m\r\n");
        const disposable = term.onData(() => {
          disposable.dispose();
          spawnedAt = Date.now();
          // pass runboxId on restart too
          invoke("pty_spawn", { sessionId: sid, runboxId, cwd: runboxCwd }).catch(() => {});
        });
      }),
    ]).then(([a, b]) => {
      unlistenOutput = a;
      unlistenEnded  = b;
      spawnedAt = Date.now();
      return invoke("pty_spawn", { sessionId: sid, runboxId, cwd: runboxCwd });
    }).catch(err => {
      if (!gone.current) {
        term.write(`\r\n\x1b[31m[error: ${err}]\x1b[0m\r\n`);
      }
    });

    return () => {
      gone.current = true;
      ro.disconnect();
      unlistenOutput?.();
      unlistenEnded?.();
      invoke("pty_kill", { sessionId: sid }).catch(() => {});
      term.dispose();
      termRef.current = null;
      fitRef.current  = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []); // ← empty deps: runs once, terminal is NEVER remounted

  const handleMouseDown = useCallback(() => {
    onActivate?.();
    setTimeout(() => {
      termRef.current?.focus();
      termRef.current?.scrollToBottom();
    }, 0);
  }, [onActivate]);

  const handlePaste = useCallback((e: React.ClipboardEvent) => {
    const text = e.clipboardData.getData("text");
    if (text) { e.preventDefault(); sendInput(text); }
  }, [sendInput]);

  return (
    <div
      className="sbx-wrap"
      onMouseDown={handleMouseDown}
      onPaste={handlePaste}
      style={{ opacity: isActive ? 1 : 0.4 }}
    >
      {/* No banner — silent startup, no "connecting to server" message */}
      <div className="sbx-term" ref={termElRef} />
    </div>
  );
}