/**
 * BrowsePanel.tsx
 *
 * Uses a real native WebviewWindow overlaid exactly on the pane div.
 * No iframe, no proxy — full browser with CSS, JS, cookies, everything.
 *
 * How it works:
 *  1. A placeholder <div> sits in the React layout (for sizing/positioning)
 *  2. A ResizeObserver watches its screen position every frame
 *  3. We call browser_open / browser_move on the Rust side to keep
 *     a frameless native WebviewWindow perfectly aligned over that div
 *  4. When the pane is hidden/closed, we hide/close the native webview
 */

import { useEffect, useRef, useCallback, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

const C = {
  bg0: "#0d0d0d", bg1: "#141414", bg2: "#1a1a1a",
  border: "rgba(255,255,255,.07)", borderHi: "rgba(255,255,255,.14)",
  text0: "#f0f0f0", text1: "#b0b0b0", text2: "#555",
  red: "#e05252", blue: "#79b8ff",
};

const tbtn: React.CSSProperties = {
  background: "none", border: "none", color: C.text2,
  cursor: "pointer", padding: "3px 6px",
  display: "flex", alignItems: "center", justifyContent: "center",
  borderRadius: 4,
};

interface BrowsePanelProps {
  paneId:     string;
  isActive:   boolean;
  onActivate: () => void;
  onClose:    (id: string) => void;
  onSplitH?:  (id: string) => void;
  onSplitV?:  (id: string) => void;
}

export default function BrowsePanel({
  paneId, isActive, onActivate, onClose, onSplitH, onSplitV,
}: BrowsePanelProps) {
  const containerRef  = useRef<HTMLDivElement>(null);
  const label         = useRef(`browser-${paneId}`).current;
  const openedRef     = useRef(false);
  const rafRef        = useRef<number>(0);
  const lastRectRef   = useRef({ x: 0, y: 0, w: 0, h: 0 });

  const [urlInput,   setUrlInput]   = useState("https://google.com");
  const [committed,  setCommitted]  = useState("https://google.com");

  // ── Position sync ─────────────────────────────────────────────────────────
  const syncPosition = useCallback(() => {
    const el = containerRef.current;
    if (!el) return;
    const r   = el.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    const x = Math.round(r.left   * dpr);
    const y = Math.round(r.top    * dpr);
    const w = Math.round(r.width  * dpr);
    const h = Math.round(r.height * dpr);
    if (w < 10 || h < 10) return;

    const last = lastRectRef.current;
    if (x === last.x && y === last.y && w === last.w && h === last.h) return;
    lastRectRef.current = { x, y, w, h };

    if (!openedRef.current) {
      openedRef.current = true;
      invoke("browser_open", { label, url: committed, x, y, w, h })
        .catch(console.error);
    } else {
      invoke("browser_move", { label, x, y, w, h }).catch(() => {});
    }
  }, [label, committed]);

  const scheduledSync = useCallback(() => {
    cancelAnimationFrame(rafRef.current);
    rafRef.current = requestAnimationFrame(syncPosition);
  }, [syncPosition]);

  // Watch size + window events
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const ro = new ResizeObserver(scheduledSync);
    ro.observe(el);
    window.addEventListener("resize", scheduledSync, { passive: true });
    window.addEventListener("scroll", scheduledSync, { passive: true, capture: true });
    scheduledSync();
    return () => {
      ro.disconnect();
      window.removeEventListener("resize", scheduledSync);
      window.removeEventListener("scroll", scheduledSync, true);
      cancelAnimationFrame(rafRef.current);
    };
  }, [scheduledSync]);

  // ── Show / hide when active state changes ─────────────────────────────────
  useEffect(() => {
    if (!openedRef.current) return;
    invoke(isActive ? "browser_show" : "browser_hide", { label }).catch(() => {});
  }, [isActive, label]);

  // ── Close native webview when pane unmounts ───────────────────────────────
  useEffect(() => {
    return () => {
      cancelAnimationFrame(rafRef.current);
      invoke("browser_close", { label }).catch(() => {});
    };
  }, [label]);

  // ── Navigation helpers ────────────────────────────────────────────────────
  const navigate = useCallback((url: string) => {
    const full = url.startsWith("http://") || url.startsWith("https://")
      ? url : `https://${url}`;
    setCommitted(full);
    setUrlInput(full);
    if (openedRef.current) {
      invoke("browser_navigate", { label, url: full }).catch(console.error);
    }
  }, [label]);

  return (
    <div
      onClick={onActivate}
      style={{
        flex: 1, display: "flex", flexDirection: "column",
        minHeight: 0, minWidth: 0, position: "relative",
        outline: isActive ? `1px solid rgba(255,255,255,.13)` : "none",
        outlineOffset: -1,
      }}
    >
      {/* ── Toolbar ────────────────────────────────────────────────────────── */}
      <div style={{
        display: "flex", alignItems: "center", gap: 4,
        padding: "0 6px", height: 34, flexShrink: 0,
        background: C.bg1, borderBottom: `1px solid ${C.border}`,
        zIndex: 10,
      }}>
        <button style={tbtn} title="Back"
          onClick={e => { e.stopPropagation(); invoke("browser_back", { label }); }}
          onMouseEnter={e => (e.currentTarget as HTMLElement).style.color = C.text0}
          onMouseLeave={e => (e.currentTarget as HTMLElement).style.color = C.text2}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="15 18 9 12 15 6"/>
          </svg>
        </button>
        <button style={tbtn} title="Forward"
          onClick={e => { e.stopPropagation(); invoke("browser_forward", { label }); }}
          onMouseEnter={e => (e.currentTarget as HTMLElement).style.color = C.text0}
          onMouseLeave={e => (e.currentTarget as HTMLElement).style.color = C.text2}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="9 18 15 12 9 6"/>
          </svg>
        </button>
        <button style={tbtn} title="Reload"
          onClick={e => { e.stopPropagation(); invoke("browser_reload", { label }); }}
          onMouseEnter={e => (e.currentTarget as HTMLElement).style.color = C.text0}
          onMouseLeave={e => (e.currentTarget as HTMLElement).style.color = C.text2}>
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="23 4 23 10 17 10"/>
            <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/>
          </svg>
        </button>

        {/* URL bar */}
        <input
          value={urlInput}
          onChange={e => setUrlInput(e.target.value)}
          onKeyDown={e => { if (e.key === "Enter") navigate(urlInput); }}
          onClick={e => { e.stopPropagation(); (e.target as HTMLInputElement).select(); }}
          style={{
            flex: 1, background: C.bg2, border: `1px solid ${C.border}`,
            borderRadius: 5, color: C.text0, fontSize: 12,
            padding: "4px 10px", outline: "none",
            fontFamily: "ui-monospace,'SF Mono',monospace",
          }}
          onFocus={e => e.currentTarget.style.borderColor = C.borderHi}
          onBlur={e  => e.currentTarget.style.borderColor = C.border}
        />

        {onSplitH && (
          <button style={tbtn} title="Split right"
            onClick={e => { e.stopPropagation(); onSplitH(paneId); }}
            onMouseEnter={e => (e.currentTarget as HTMLElement).style.color = C.text0}
            onMouseLeave={e => (e.currentTarget as HTMLElement).style.color = C.text2}>
            <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6">
              <rect x="1" y="2" width="14" height="12" rx="1.5"/><line x1="8" y1="2" x2="8" y2="14"/>
            </svg>
          </button>
        )}
        {onSplitV && (
          <button style={tbtn} title="Split down"
            onClick={e => { e.stopPropagation(); onSplitV(paneId); }}
            onMouseEnter={e => (e.currentTarget as HTMLElement).style.color = C.text0}
            onMouseLeave={e => (e.currentTarget as HTMLElement).style.color = C.text2}>
            <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6">
              <rect x="1" y="2" width="14" height="12" rx="1.5"/><line x1="1" y1="8" x2="15" y2="8"/>
            </svg>
          </button>
        )}
        <button style={{ ...tbtn, color: C.red }} title="Close"
          onClick={e => { e.stopPropagation(); onClose(paneId); }}
          onMouseEnter={e => (e.currentTarget as HTMLElement).style.color = "#ff6b6b"}
          onMouseLeave={e => (e.currentTarget as HTMLElement).style.color = C.red}>
          ×
        </button>
      </div>

      {/* ── Placeholder — native webview renders exactly here ─────────────── */}
      {/* Background color shows briefly before webview appears              */}
      <div
        ref={containerRef}
        style={{ flex: 1, minHeight: 0, minWidth: 0, background: "#fff" }}
      />
    </div>
  );
}