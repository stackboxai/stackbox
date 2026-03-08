import { useEffect, useRef, useCallback, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

const C = {
  bg0: "#0d0d0d", bg1: "#141414", bg2: "#1a1a1a",
  border: "rgba(255,255,255,.07)", borderHi: "rgba(255,255,255,.18)",
  text0: "#f0f0f0", text2: "#555",
  red: "#e05252", blue: "#79b8ff",
};

export interface BrowserHandle {
  navigateTo: (url: string) => void;
  currentUrl: () => string;
}

interface BrowsePanelProps {
  paneId:       string;
  isActive:     boolean;
  onActivate:   () => void;
  onClose:      (id: string) => void;
  agentRef?:    React.MutableRefObject<BrowserHandle | null>;
  onUrlChange?: (url: string) => void;
}

function toUrl(raw: string): string {
  const t = raw.trim();
  if (/^https?:\/\//.test(t)) return t;
  if (/^[^\s]+\.[^\s]{2,}$/.test(t) && !t.includes(" ")) return `https://${t}`;
  return `https://www.google.com/search?q=${encodeURIComponent(t)}`;
}

export default function BrowsePanel({
  paneId, isActive, onActivate, onClose,
  agentRef, onUrlChange,
}: BrowsePanelProps) {
  const slotRef      = useRef<HTMLDivElement>(null);
  const urlRef       = useRef("https://google.com");
  const isActiveRef  = useRef(isActive); // always current, no stale closure
  const createdRef   = useRef(false);
  const [urlInput, setUrlInput] = useState("https://google.com");
  const [loading,  setLoading]  = useState(true);

  // Keep isActiveRef in sync so the creation callback can read current value
  useEffect(() => { isActiveRef.current = isActive; }, [isActive]);

  const getRect = useCallback(() => {
    const slot = slotRef.current;
    if (!slot) return null;
    const r = slot.getBoundingClientRect();
    return { x: r.left, y: r.top, width: r.width, height: r.height };
  }, []);

  // ── Create webview — retries until slot has real dimensions ────────────────
  useEffect(() => {
    let alive = true;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;

    const tryCreate = async () => {
      if (!alive || createdRef.current) return;

      await new Promise(r => requestAnimationFrame(r));
      if (!alive) return;

      const rect = getRect();
      if (!rect || rect.width < 1 || rect.height < 1) {
        retryTimer = setTimeout(tryCreate, 50);
        return;
      }

      try {
        await invoke("browser_create", { id: paneId, url: urlRef.current, ...rect });
        if (!alive) return;
        createdRef.current = true;
        setLoading(false);
        // ── Fix: immediately show or hide based on CURRENT isActive value ──
        // The show/hide effect may have already fired while createdRef was still
        // false (so it did nothing). We must call it here explicitly.
        invoke(isActiveRef.current ? "browser_show" : "browser_hide", { id: paneId }).catch(() => {});
      } catch (e) {
        console.error("[browser] create failed", e);
        if (alive) retryTimer = setTimeout(tryCreate, 200);
      }
    };

    tryCreate();

    return () => {
      alive = false;
      if (retryTimer) clearTimeout(retryTimer);
      if (createdRef.current) {
        invoke("browser_destroy", { id: paneId }).catch(() => {});
        createdRef.current = false;
      }
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [paneId]);

  // ── Reposition on resize ───────────────────────────────────────────────────
  useEffect(() => {
    const slot = slotRef.current;
    if (!slot) return;
    const obs = new ResizeObserver(() => {
      if (!createdRef.current) return;
      const rect = getRect();
      if (!rect || rect.width < 1) return;
      invoke("browser_set_bounds", { id: paneId, ...rect }).catch(() => {});
    });
    obs.observe(slot);
    return () => obs.disconnect();
  }, [paneId, getRect]);

  // ── Show / hide when tab switches ─────────────────────────────────────────
  useEffect(() => {
    if (!createdRef.current) return; // creation callback handles first show/hide
    invoke(isActive ? "browser_show" : "browser_hide", { id: paneId }).catch(() => {});
  }, [isActive, paneId]);

  // ── Navigate ───────────────────────────────────────────────────────────────
  const navigate = useCallback(async (raw: string) => {
    const url = toUrl(raw);
    urlRef.current = url;
    setUrlInput(url);
    onUrlChange?.(url);
    await invoke("browser_navigate", { id: paneId, url });
  }, [paneId, onUrlChange]);

  const goBack    = useCallback(() => invoke("browser_go_back",    { id: paneId }).catch(() => {}), [paneId]);
  const goForward = useCallback(() => invoke("browser_go_forward", { id: paneId }).catch(() => {}), [paneId]);
  const reload    = useCallback(() => invoke("browser_reload",     { id: paneId }).catch(() => {}), [paneId]);

  // ── Agent handle ───────────────────────────────────────────────────────────
  useEffect(() => {
    if (!agentRef) return;
    agentRef.current = { navigateTo: navigate, currentUrl: () => urlRef.current };
  }, [agentRef, navigate]);

  return (
    <div onClick={onActivate} style={{
      display: "flex", flexDirection: "column",
      width: "100%", height: "100%",
      outline: isActive ? `1px solid rgba(255,255,255,.15)` : "none",
      outlineOffset: -1,
    }}>
      {/* Toolbar */}
      <div style={{
        display: "flex", alignItems: "center", gap: 4,
        padding: "0 6px", height: 34, flexShrink: 0,
        background: C.bg1, borderBottom: `1px solid ${C.border}`,
        position: "relative", zIndex: 10,
      }}>
        <Btn title="Back"    onClick={e => { e.stopPropagation(); goBack(); }}>‹</Btn>
        <Btn title="Forward" onClick={e => { e.stopPropagation(); goForward(); }}>›</Btn>
        <Btn title="Reload"  onClick={e => { e.stopPropagation(); reload(); }}>↻</Btn>

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
      </div>

      {/* Loading bar */}
      {loading && (
        <div style={{ height: 2, background: C.bg2, flexShrink: 0, overflow: "hidden" }}>
          <div style={{ height: "100%", width: "35%", background: C.blue,
            animation: "bpSlide 1.1s ease-in-out infinite" }} />
        </div>
      )}

      {/* Slot — native webview sits over this */}
      <div ref={slotRef} style={{ flex: 1, minHeight: 0, minWidth: 0, background: "#111" }} />
      <style>{`@keyframes bpSlide{0%{transform:translateX(-100%)}100%{transform:translateX(400%)}}`}</style>
    </div>
  );
}

function Btn({ children, title, onClick, style }: {
  children: React.ReactNode; title?: string;
  onClick?: React.MouseEventHandler; style?: React.CSSProperties;
}) {
  const [hov, setHov] = useState(false);
  return (
    <button title={title} onClick={onClick}
      onMouseEnter={() => setHov(true)} onMouseLeave={() => setHov(false)}
      style={{
        background: "none", border: "none", cursor: "pointer",
        padding: "2px 7px", borderRadius: 4, fontSize: 16, lineHeight: 1,
        color: hov ? "#f0f0f0" : (style?.color ?? "#666"),
        display: "flex", alignItems: "center", justifyContent: "center",
        transition: "color .1s", ...style,
      }}>{children}</button>
  );
}