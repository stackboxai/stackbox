/**
 * TermPane.tsx — Real terminal pane using xterm.js
 *
 * INSTALL BEFORE USING:
 *   npm install @xterm/xterm @xterm/addon-fit @xterm/addon-web-links
 *
 * CHANGES FROM ORIGINAL:
 *  - Replaced plain HTML input with xterm.js Terminal instance
 *  - Full ANSI color support (Claude/Gemini output renders beautifully)
 *  - Real terminal cursor, blinking, scrollback
 *  - Ctrl+C sends \x03 raw byte (actually kills processes)
 *  - Ctrl+L clears screen
 *  - Terminal resize via ResizeObserver → /api/resize/:id
 *  - Command history (ArrowUp/Down) preserved
 *  - Clickable URLs via addon-web-links
 *  - Replays existing lines on mount (session restore works)
 */

import React, { useEffect, useRef, useCallback } from "react";
import { Terminal }     from "@xterm/xterm";
import { FitAddon }     from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import "@xterm/xterm/css/xterm.css";
import { AGENTS }       from "../constants";
import type { Term }    from "../../types";

interface Props {
  term:      Term;
  onInput:   (text: string) => void;
  onCtrlC?:  () => void;
  onUrl?:    (url: string) => void;
}

// ── Xterm theme matching Stackbox dark palette ─────────────────────────────

const XTERM_THEME = {
  background:      "#0d1117",
  foreground:      "#e6edf3",
  cursor:          "#79b8ff",
  cursorAccent:    "#0d1117",
  selectionBackground: "rgba(121,184,255,0.2)",
  black:           "#21262d",
  red:             "#f85149",
  green:           "#3fb950",
  yellow:          "#d29922",
  blue:            "#79b8ff",
  magenta:         "#b392f0",
  cyan:            "#56d364",
  white:           "#b1bac4",
  brightBlack:     "#484f58",
  brightRed:       "#ff7b72",
  brightGreen:     "#85e89d",
  brightYellow:    "#e3b341",
  brightBlue:      "#79b8ff",
  brightMagenta:   "#d2a8ff",
  brightCyan:      "#87deea",
  brightWhite:     "#e6edf3",
};

// ── Component ──────────────────────────────────────────────────────────────

export const TermPane: React.FC<Props> = ({ term, onInput, onCtrlC, onUrl }) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const xtermRef     = useRef<Terminal | null>(null);
  const fitRef       = useRef<FitAddon | null>(null);
  const prevLenRef   = useRef(0);
  const sidRef       = useRef(term.sid);

  const ag = AGENTS.find((a) => a.id === term.agent) ?? { label: term.agent, color: "#79b8ff" };

  // ── Init xterm on mount / when session changes ──────────────────────────
  useEffect(() => {
    if (!containerRef.current) return;

    // Dispose previous terminal if session_id changed
    if (xtermRef.current) {
      xtermRef.current.dispose();
      xtermRef.current = null;
      fitRef.current   = null;
    }

    sidRef.current = term.sid;

    const xterm = new Terminal({
      theme:           XTERM_THEME,
      fontFamily:      "'Cascadia Code', 'Fira Code', 'JetBrains Mono', ui-monospace, monospace",
      fontSize:        13,
      lineHeight:      1.6,
      letterSpacing:   0,
      cursorBlink:     true,
      cursorStyle:     "block",
      scrollback:      5000,
      convertEol:      true,   // \n → \r\n on Windows
      allowTransparency: false,
      macOptionIsMeta: true,
      rightClickSelectsWord: true,
    });

    const fit   = new FitAddon();
    const links = new WebLinksAddon((_, url) => {
      onUrl?.(url);
      window.open(url, "_blank");
    });

    xterm.loadAddon(fit);
    xterm.loadAddon(links);
    xterm.open(containerRef.current);

    // Fit once after open
    requestAnimationFrame(() => {
      try { fit.fit(); } catch { /**/ }
    });

    xtermRef.current = xterm;
    fitRef.current   = fit;

    // ── Keyboard input → backend ──────────────────────────────────────────
    xterm.onData((data) => {
      if (term.status !== "active") return;

      // Ctrl+C → send raw \x03 to pty (actually interrupts the process)
      if (data === "\x03") {
        onCtrlC?.();
        onInput("\x03");
        return;
      }

      // Ctrl+L → clear terminal visually (backend gets \x0c)
      if (data === "\x0c") {
        xterm.clear();
        onInput("\x0c");
        return;
      }

      onInput(data);
    });

    // ── Replay existing lines on mount (session restore) ──────────────────
    if (term.lines.length > 0) {
      for (const line of term.lines) {
        // Write raw — preserves all ANSI escape codes from Claude/Gemini
        xterm.write(line.text);
        // Add newline only for non-stdout lines (sys, sig, err)
        if (line.kind !== "out") xterm.write("\r\n");
      }
    }

    prevLenRef.current = term.lines.length;

    return () => {
      xterm.dispose();
      xtermRef.current = null;
      fitRef.current   = null;
    };
  // Only re-init when session ID changes (not on every render)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [term.sid]);

  // ── Write new lines as they arrive ─────────────────────────────────────
  useEffect(() => {
    const xterm = xtermRef.current;
    if (!xterm) return;
    const newLines = term.lines.slice(prevLenRef.current);
    prevLenRef.current = term.lines.length;
    for (const line of newLines) {
      xterm.write(line.text);
      if (line.kind !== "out") xterm.write("\r\n");
    }
  }, [term.lines.length]);

  // ── Resize observer → fit + notify backend ─────────────────────────────
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    const ro = new ResizeObserver(() => {
      const fit = fitRef.current;
      if (!fit) return;
      try {
        fit.fit();
        const xterm = xtermRef.current;
        if (xterm && term.status === "active") {
          // Notify backend of new size so pty resizes too
          fetch(`http://127.0.0.1:4322/api/resize/${term.sid}`, {
            method:  "POST",
            headers: { "Content-Type": "application/json" },
            body:    JSON.stringify({ cols: xterm.cols, rows: xterm.rows }),
          }).catch(() => {});
        }
      } catch { /**/ }
    });

    ro.observe(el);
    return () => ro.disconnect();
  }, [term.sid, term.status]);

  // ── Focus terminal when pane becomes active ─────────────────────────────
  useEffect(() => {
    xtermRef.current?.focus();
  }, [term.sid]);

  return (
    <div
      ref={containerRef}
      style={{
        height:     "100%",
        width:      "100%",
        background: XTERM_THEME.background,
        // Make xterm fill the container cleanly
        overflow:   "hidden",
      }}
      // Click anywhere to refocus terminal
      onClick={() => xtermRef.current?.focus()}
    />
  );
};

export default TermPane;
