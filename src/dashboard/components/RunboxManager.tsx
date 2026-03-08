/**
 * RunboxManager.tsx
 *
 * - Tab bar at top (like screenshot) showing all open terminal panes
 * - Terminals NEVER remount or lose data when splitting
 * - Portals keep RunPanel instances alive even when hidden
 * - No "connecting to server" or status banners
 */

import { useState, useCallback, useRef, useEffect } from "react";
import { createPortal } from "react-dom";
import RunPanel    from "./RunPanel";
import BrowserPane from "./BrowsePanel";

// ── Types ─────────────────────────────────────────────────────────────────────
interface Runbox { id: string; name: string; cwd: string; }

// ── Design tokens ─────────────────────────────────────────────────────────────
const C = {
  bg0: "#0d0d0d", bg1: "#141414", bg2: "#1a1a1a",
  bg3: "#222222", bg4: "#2a2a2a",
  border:   "rgba(255,255,255,.07)",
  borderHi: "rgba(255,255,255,.14)",
  text0: "#f0f0f0", text1: "#b0b0b0",
  text2: "#555555", text3: "#333333",
  green: "#3fb950", red: "#e05252", blue: "#79b8ff",
  tab: "#1e1e1e", tabActive: "#0d0d0d",
};

const tbtn: React.CSSProperties = {
  background: "none", border: "none", color: C.text2, cursor: "pointer",
  padding: "2px 4px", display: "flex", alignItems: "center",
  justifyContent: "center", borderRadius: 3, fontSize: 14, lineHeight: 1,
};

// ── Icons ─────────────────────────────────────────────────────────────────────
const IconTerminal = ({ active }: { active: boolean }) => (
  <svg width="15" height="15" viewBox="0 0 24 24" fill="none"
    stroke={active ? "#fff" : "#555"} strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
    <polyline points="4 17 10 11 4 5"/><line x1="12" y1="19" x2="20" y2="19"/>
  </svg>
);
const IconGrid = ({ active }: { active: boolean }) => (
  <svg width="15" height="15" viewBox="0 0 24 24" fill="none"
    stroke={active ? "#fff" : "#555"} strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
    <rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/>
    <rect x="3" y="14" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/>
  </svg>
);

// ── Pane tree ─────────────────────────────────────────────────────────────────
type SplitDir = "h" | "v";
interface TermNode    { type: "leaf";    id: string; }
interface BrowserNode { type: "browser"; id: string; }
interface SplitNode   { type: "split";   dir: SplitDir; a: PaneNode; b: PaneNode; }
type PaneNode = TermNode | BrowserNode | SplitNode;

let _seq = 0;
const newLeaf    = (): TermNode    => ({ type: "leaf",    id: `t${++_seq}` });
const newBrowser = (): BrowserNode => ({ type: "browser", id: `b${++_seq}` });

function removeLeaf(node: PaneNode, id: string): PaneNode | null {
  if (node.type === "leaf" || node.type === "browser") return node.id === id ? null : node;
  const a = removeLeaf(node.a, id), b = removeLeaf(node.b, id);
  if (!a && !b) return null; if (!a) return b!; if (!b) return a;
  return { ...node, a, b };
}
function splitLeaf(node: PaneNode, id: string, dir: SplitDir, added: TermNode | BrowserNode): PaneNode {
  if (node.type === "leaf" || node.type === "browser")
    return node.id !== id ? node : { type: "split", dir, a: node, b: added };
  return { ...node, a: splitLeaf(node.a, id, dir, added), b: splitLeaf(node.b, id, dir, added) };
}
function collectIds(node: PaneNode): string[] {
  if (node.type === "leaf" || node.type === "browser") return [node.id];
  return [...collectIds(node.a), ...collectIds(node.b)];
}
function collectLeafIds(node: PaneNode): string[] {
  if (node.type === "leaf") return [node.id];
  if (node.type === "browser") return [];
  return [...collectLeafIds(node.a), ...collectLeafIds(node.b)];
}

// ── New Runbox Modal ──────────────────────────────────────────────────────────
const AGENTS = [
  { id: "claude",  label: "Claude",  color: "#79b8ff" },
  { id: "gemini",  label: "Gemini",  color: "#85e89d" },
  { id: "codex",   label: "Codex",   color: "#f97583" },
  { id: "cursor",  label: "Cursor",  color: "#b392f0" },
  { id: "kimi",    label: "Kimi",    color: "#ffdf5d" },
  { id: "iflow",   label: "iFlow",   color: "#56d364" },
  { id: "custom",  label: "Custom",  color: "#8b949e" },
];

function NewRunboxModal({ onSubmit, onClose }: {
  onSubmit: (name: string, cwd: string, agent: string) => void;
  onClose: () => void;
}) {
  const [name,  setName]  = useState("");
  const [cwd,   setCwd]   = useState("~/");
  const [agent, setAgent] = useState("claude");
  const nameRef = useRef<HTMLInputElement>(null);
  useEffect(() => { setTimeout(() => nameRef.current?.focus(), 40); }, []);
  const submit = () => onSubmit(name.trim() || "untitled", cwd.trim() || "~/", agent);

  return (
    <div onClick={onClose} style={{
      position: "fixed", inset: 0, zIndex: 1000,
      background: "rgba(0,0,0,.75)", backdropFilter: "blur(8px)",
      display: "flex", alignItems: "center", justifyContent: "center",
    }}>
      <div onClick={e => e.stopPropagation()} style={{
        width: 430, background: C.bg2,
        border: `1px solid ${C.borderHi}`, borderRadius: 12,
        boxShadow: "0 48px 120px rgba(0,0,0,.9)",
        animation: "modalIn .16s cubic-bezier(.2,1,.4,1)", overflow: "hidden",
      }}>
        <div style={{ padding: "16px 20px", borderBottom: `1px solid ${C.border}`, display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <span style={{ fontSize: 14, fontWeight: 600, color: C.text0, fontFamily: "-apple-system,system-ui,sans-serif" }}>New Runbox</span>
          <button onClick={onClose} style={{ background: "none", border: "none", color: C.text2, fontSize: 18, cursor: "pointer" }}>×</button>
        </div>
        <div style={{ padding: "18px 20px 20px", display: "flex", flexDirection: "column", gap: 16 }}>
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            <label style={{ fontSize: 11, fontWeight: 600, color: C.text2, textTransform: "uppercase", letterSpacing: ".09em", fontFamily: "-apple-system,system-ui,sans-serif" }}>Name</label>
            <input ref={nameRef} value={name} onChange={e => setName(e.target.value)}
              onKeyDown={e => { if (e.key === "Enter") submit(); if (e.key === "Escape") onClose(); }}
              placeholder="my-feature"
              style={{ background: C.bg0, border: `1px solid ${C.border}`, borderRadius: 7, color: C.text0, fontSize: 14, padding: "10px 12px", outline: "none", fontFamily: "ui-monospace,'SF Mono',monospace" }}
              onFocus={e => e.currentTarget.style.borderColor = C.borderHi}
              onBlur={e  => e.currentTarget.style.borderColor = C.border} />
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            <label style={{ fontSize: 11, fontWeight: 600, color: C.text2, textTransform: "uppercase", letterSpacing: ".09em", fontFamily: "-apple-system,system-ui,sans-serif" }}>Directory</label>
            <input value={cwd} onChange={e => setCwd(e.target.value)}
              onKeyDown={e => { if (e.key === "Enter") submit(); if (e.key === "Escape") onClose(); }}
              placeholder="~/my-project"
              style={{ width: "100%", background: C.bg0, border: `1px solid ${C.border}`, borderRadius: 7, color: C.text1, fontSize: 13, padding: "10px 12px", outline: "none", fontFamily: "ui-monospace,'SF Mono',monospace", boxSizing: "border-box" }}
              onFocus={e => e.currentTarget.style.borderColor = C.borderHi}
              onBlur={e  => e.currentTarget.style.borderColor = C.border} />
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            <label style={{ fontSize: 11, fontWeight: 600, color: C.text2, textTransform: "uppercase", letterSpacing: ".09em", fontFamily: "-apple-system,system-ui,sans-serif" }}>Agent</label>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(4,1fr)", gap: 6 }}>
              {AGENTS.map(a => (
                <button key={a.id} onClick={() => setAgent(a.id)} style={{
                  display: "flex", flexDirection: "column", alignItems: "center", gap: 6,
                  padding: "10px 4px", borderRadius: 8, cursor: "pointer",
                  background: agent === a.id ? C.bg3 : "transparent",
                  border: `1px solid ${agent === a.id ? C.borderHi : C.border}`,
                }}>
                  <span style={{ width: 7, height: 7, borderRadius: "50%", background: a.color, boxShadow: agent === a.id ? `0 0 7px ${a.color}66` : "none" }} />
                  <span style={{ fontSize: 11, fontWeight: agent === a.id ? 600 : 400, color: agent === a.id ? C.text0 : C.text2, fontFamily: "-apple-system,system-ui,sans-serif" }}>{a.label}</span>
                </button>
              ))}
            </div>
          </div>
          <button onClick={submit} style={{
            padding: "11px 0", marginTop: 2, background: C.text0,
            border: "none", borderRadius: 8, color: "#131313",
            fontSize: 13, fontWeight: 700, cursor: "pointer",
            fontFamily: "-apple-system,system-ui,sans-serif",
          }}>Launch →</button>
        </div>
      </div>
    </div>
  );
}

// ── Sidebar ───────────────────────────────────────────────────────────────────
function Sidebar({ runboxes, activeId, activeTab, cwdMap, onSelect, onCreate, onRename, onDelete, onTabChange }: {
  runboxes: Runbox[]; activeId: string | null;
  activeTab: "run" | "dashboard"; cwdMap: Record<string, string>;
  onSelect: (id: string) => void;
  onCreate: (name: string, cwd: string, agent: string) => void;
  onRename: (id: string, name: string) => void;
  onDelete: (id: string) => void;
  onTabChange: (t: "run" | "dashboard") => void;
}) {
  const [showModal, setShowModal] = useState(false);
  const [renaming,  setRenaming]  = useState<string | null>(null);
  const [renameVal, setRenameVal] = useState("");
  const renameRef = useRef<HTMLInputElement>(null);
  useEffect(() => { if (renaming) setTimeout(() => renameRef.current?.select(), 30); }, [renaming]);
  const submitRename = (id: string) => { if (renameVal.trim()) onRename(id, renameVal.trim()); setRenaming(null); };

  return (
    <>
      {showModal && <NewRunboxModal onSubmit={(n, c, a) => { onCreate(n, c, a); setShowModal(false); }} onClose={() => setShowModal(false)} />}
      <div style={{ width: 220, flexShrink: 0, background: C.bg1, borderRight: `1px solid ${C.border}`, display: "flex", flexDirection: "column" }}>
        <div style={{ padding: "10px 12px", borderBottom: `1px solid ${C.border}` }}>
          <div style={{ display: "flex", alignItems: "center", gap: 3, marginBottom: 11 }}>
            <span style={{ fontSize: 13, fontWeight: 700, color: C.text0, fontFamily: "-apple-system,system-ui,sans-serif", flex: 1 }}>Stackbox</span>
            <button onClick={() => onTabChange("run")} style={{ width: 28, height: 28, display: "flex", alignItems: "center", justifyContent: "center", background: activeTab === "run" ? C.bg4 : "none", border: "none", borderRadius: 6, cursor: "pointer" }}>
              <IconTerminal active={activeTab === "run"} />
            </button>
            <button onClick={() => onTabChange("dashboard")} style={{ width: 28, height: 28, display: "flex", alignItems: "center", justifyContent: "center", background: activeTab === "dashboard" ? C.bg4 : "none", border: "none", borderRadius: 6, cursor: "pointer" }}>
              <IconGrid active={activeTab === "dashboard"} />
            </button>
          </div>
          <button onClick={() => setShowModal(true)} style={{
            display: "flex", alignItems: "center", gap: 8, width: "100%", padding: "8px 11px",
            background: "transparent", border: `1px solid ${C.border}`, borderRadius: 7,
            color: C.text1, fontSize: 12, fontWeight: 500, fontFamily: "-apple-system,system-ui,sans-serif", cursor: "pointer",
          }}
            onMouseEnter={e => { (e.currentTarget as HTMLElement).style.background = C.bg2; (e.currentTarget as HTMLElement).style.borderColor = C.borderHi; (e.currentTarget as HTMLElement).style.color = C.text0; }}
            onMouseLeave={e => { (e.currentTarget as HTMLElement).style.background = "transparent"; (e.currentTarget as HTMLElement).style.borderColor = C.border; (e.currentTarget as HTMLElement).style.color = C.text1; }}>
            <span style={{ fontSize: 16, lineHeight: 1, fontWeight: 300, color: C.text2 }}>+</span>New Runbox
          </button>
        </div>
        <div style={{ flex: 1, overflowY: "auto", padding: "5px 0" }}>
          {runboxes.length === 0 && <div style={{ padding: "20px 14px", fontSize: 12, color: C.text2, fontFamily: "-apple-system,system-ui,sans-serif" }}>No runboxes yet.</div>}
          {runboxes.map(rb => {
            const isOn = activeId === rb.id;
            const liveCwd = cwdMap[rb.id] || rb.cwd;
            return (
              <div key={rb.id}
                onClick={() => onSelect(rb.id)}
                onDoubleClick={() => { setRenaming(rb.id); setRenameVal(rb.name); }}
                style={{
                  display: "flex", alignItems: "flex-start", gap: 9,
                  padding: "9px 12px 9px 11px", cursor: "pointer",
                  background: isOn ? C.bg2 : "transparent",
                  borderLeft: `2px solid ${isOn ? "rgba(255,255,255,.28)" : "transparent"}`,
                }}
                onMouseEnter={e => { if (!isOn) (e.currentTarget as HTMLElement).style.background = C.bg2; }}
                onMouseLeave={e => { if (!isOn) (e.currentTarget as HTMLElement).style.background = "transparent"; }}>
                <div style={{ paddingTop: 4, flexShrink: 0 }}>
                  <span style={{ display: "block", width: 6, height: 6, borderRadius: "50%", background: C.green, boxShadow: `0 0 4px ${C.green}` }} />
                </div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  {renaming === rb.id ? (
                    <input ref={renameRef} value={renameVal} onChange={e => setRenameVal(e.target.value)}
                      onBlur={() => submitRename(rb.id)}
                      onKeyDown={e => { if (e.key === "Enter") submitRename(rb.id); if (e.key === "Escape") setRenaming(null); }}
                      onClick={e => e.stopPropagation()}
                      style={{ background: C.bg3, border: `1px solid ${C.borderHi}`, borderRadius: 4, color: C.text0, fontSize: 13, padding: "2px 7px", width: "100%", outline: "none", fontFamily: "ui-monospace,'SF Mono',monospace" }} />
                  ) : (
                    <>
                      <div style={{ fontSize: 13, fontWeight: isOn ? 600 : 400, color: isOn ? C.text0 : C.text1, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", fontFamily: "-apple-system,system-ui,sans-serif" }}>{rb.name}</div>
                      <div style={{ fontSize: 11, color: C.text2, fontFamily: "ui-monospace,'SF Mono',monospace", marginTop: 2, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{liveCwd}</div>
                    </>
                  )}
                </div>
                {isOn && (
                  <button onClick={e => { e.stopPropagation(); if (confirm(`Delete "${rb.name}"?`)) onDelete(rb.id); }}
                    style={{ background: "none", border: "none", color: C.text3, fontSize: 15, cursor: "pointer", padding: "0 1px", flexShrink: 0, marginTop: 1 }}
                    onMouseEnter={e => (e.currentTarget as HTMLElement).style.color = C.red}
                    onMouseLeave={e => (e.currentTarget as HTMLElement).style.color = C.text3}>×</button>
                )}
              </div>
            );
          })}
        </div>
        <div style={{ padding: "9px 14px", borderTop: `1px solid ${C.border}`, fontSize: 10, color: C.text3, fontFamily: "-apple-system,system-ui,sans-serif" }}>Double-click to rename</div>
      </div>
    </>
  );
}

// ── PaneLeaf ──────────────────────────────────────────────────────────────────
function PaneLeaf({ node, activePane, onActivate, onClose, onSplitH, onSplitV, onMount, onUnmount }: {
  node: TermNode; activePane: string;
  onActivate: (id: string) => void; onClose: (id: string) => void;
  onSplitH: (id: string) => void;   onSplitV: (id: string) => void;
  onMount: (id: string, el: HTMLDivElement) => void; onUnmount: (id: string) => void;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const isActive = node.id === activePane;
  useEffect(() => {
    if (containerRef.current) onMount(node.id, containerRef.current);
    return () => onUnmount(node.id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [node.id]);
  return (
    <div onClick={() => onActivate(node.id)} style={{
      flex: 1, display: "flex", flexDirection: "column",
      minHeight: 0, minWidth: 0, position: "relative",
      outline: isActive ? `1px solid rgba(255,255,255,.13)` : "none", outlineOffset: -1,
    }}>
      {/* Split/close buttons — top right overlay */}
      <div style={{
        position: "absolute", top: 6, right: 8, zIndex: 20,
        background: C.bg2, border: `1px solid ${C.border}`,
        borderRadius: 5, padding: "2px 3px", display: "flex", gap: 2,
        opacity: isActive ? 1 : 0, transition: "opacity .15s",
        pointerEvents: isActive ? "auto" : "none",
      }}>
        <button title="Split right" onClick={e => { e.stopPropagation(); onSplitH(node.id); }} style={tbtn}
          onMouseEnter={e => (e.currentTarget as HTMLElement).style.color = C.text0}
          onMouseLeave={e => (e.currentTarget as HTMLElement).style.color = C.text2}>
          <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6"><rect x="1" y="2" width="14" height="12" rx="1.5"/><line x1="8" y1="2" x2="8" y2="14"/></svg>
        </button>
        <button title="Split down" onClick={e => { e.stopPropagation(); onSplitV(node.id); }} style={tbtn}
          onMouseEnter={e => (e.currentTarget as HTMLElement).style.color = C.text0}
          onMouseLeave={e => (e.currentTarget as HTMLElement).style.color = C.text2}>
          <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6"><rect x="1" y="2" width="14" height="12" rx="1.5"/><line x1="1" y1="8" x2="15" y2="8"/></svg>
        </button>
        <button title="Close" onClick={e => { e.stopPropagation(); onClose(node.id); }} style={{ ...tbtn, color: C.red }}>×</button>
      </div>
      {/* Container where RunPanel portal renders */}
      <div ref={containerRef} style={{ flex: 1, display: "flex", height: "100%", minHeight: 0, minWidth: 0, overflow: "hidden" }} />
    </div>
  );
}

// ── PaneTree ──────────────────────────────────────────────────────────────────
interface PaneTreeProps {
  node: PaneNode; activePane: string;
  onActivate: (id: string) => void; onClose: (id: string) => void;
  onSplitH: (id: string) => void;   onSplitV: (id: string) => void;
  onMount: (id: string, el: HTMLDivElement) => void; onUnmount: (id: string) => void;
}
function PaneTree(props: PaneTreeProps) {
  const { node, ...rest } = props;
  if (node.type === "split") {
    const isH = node.dir === "h";
    return (
      <div style={{ display: "flex", flexDirection: isH ? "row" : "column", flex: 1, minHeight: 0, minWidth: 0 }}>
        <div style={{ flex: 1, display: "flex", minHeight: 0, minWidth: 0, borderRight: isH ? `1px solid ${C.border}` : "none", borderBottom: !isH ? `1px solid ${C.border}` : "none" }}>
          <PaneTree node={node.a} {...rest} />
        </div>
        <div style={{ flex: 1, display: "flex", minHeight: 0, minWidth: 0 }}>
          <PaneTree node={node.b} {...rest} />
        </div>
      </div>
    );
  }
  if (node.type === "browser") {
    return (
      <BrowserPane
        paneId={node.id} isActive={node.id === props.activePane}
        onActivate={() => props.onActivate(node.id)}
        onClose={props.onClose} onSplitH={props.onSplitH} onSplitV={props.onSplitV}
      />
    );
  }
  return <PaneLeaf node={node} {...rest} />;
}

// ── Tab bar ───────────────────────────────────────────────────────────────────
// Shows a tab for each terminal pane (leaf), like the screenshot
function TabBar({ leafIds, activePane, paneCwds, runboxCwd, onSelect, onSplitH, onSplitBrowserH, onClose }: {
  leafIds:       string[];
  activePane:    string;
  paneCwds:      Record<string, string>;
  runboxCwd:     string;
  onSelect:      (id: string) => void;
  onSplitH:      () => void;
  onSplitBrowserH: () => void;
  onClose:       (id: string) => void;
}) {
  return (
    <div style={{
      display: "flex", alignItems: "stretch",
      height: 34, flexShrink: 0,
      background: C.bg1,
      borderBottom: `1px solid ${C.border}`,
      overflowX: "auto", overflowY: "hidden",
    }}>
      {leafIds.map((id, i) => {
        const isActive = id === activePane;
        const cwd = paneCwds[id] || runboxCwd;
        // Show short name: last path segment
        const label = cwd.split("/").filter(Boolean).pop() || cwd;
        return (
          <div
            key={id}
            onClick={() => onSelect(id)}
            style={{
              display: "flex", alignItems: "center", gap: 6,
              padding: "0 10px 0 12px",
              minWidth: 100, maxWidth: 160,
              cursor: "pointer", flexShrink: 0,
              background: isActive ? C.bg0 : C.bg1,
              borderRight: `1px solid ${C.border}`,
              borderBottom: isActive ? `2px solid ${C.blue}` : "2px solid transparent",
              position: "relative",
            }}
            onMouseEnter={e => { if (!isActive) (e.currentTarget as HTMLElement).style.background = C.bg2; }}
            onMouseLeave={e => { if (!isActive) (e.currentTarget as HTMLElement).style.background = C.bg1; }}
          >
            {/* Terminal icon */}
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none"
              stroke={isActive ? C.blue : C.text2} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
              <polyline points="4 17 10 11 4 5"/><line x1="12" y1="19" x2="20" y2="19"/>
            </svg>
            <span style={{
              fontSize: 12, flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
              color: isActive ? C.text0 : C.text2,
              fontFamily: "ui-monospace,'SF Mono',monospace",
            }}>
              {label}
            </span>
            {/* Close tab — only show on hover or active */}
            {leafIds.length > 1 && (
              <button
                onClick={e => { e.stopPropagation(); onClose(id); }}
                style={{ ...tbtn, fontSize: 13, opacity: isActive ? 0.6 : 0, padding: "0 2px", flexShrink: 0 }}
                onMouseEnter={e => { (e.currentTarget as HTMLElement).style.opacity = "1"; (e.currentTarget as HTMLElement).style.color = C.red; }}
                onMouseLeave={e => { (e.currentTarget as HTMLElement).style.opacity = isActive ? "0.6" : "0"; (e.currentTarget as HTMLElement).style.color = C.text2; }}
              >×</button>
            )}
          </div>
        );
      })}

      {/* New terminal tab button */}
      <button
        onClick={onSplitH}
        title="New terminal"
        style={{
          ...tbtn, padding: "0 12px", fontSize: 18, fontWeight: 300,
          borderRight: `1px solid ${C.border}`, borderRadius: 0, flexShrink: 0,
        }}
        onMouseEnter={e => (e.currentTarget as HTMLElement).style.color = C.text0}
        onMouseLeave={e => (e.currentTarget as HTMLElement).style.color = C.text2}
      >+</button>

      {/* New browser pane button */}
      <button
        onClick={onSplitBrowserH}
        title="New browser pane"
        style={{ ...tbtn, padding: "0 10px", borderRadius: 0, flexShrink: 0 }}
        onMouseEnter={e => (e.currentTarget as HTMLElement).style.color = C.text0}
        onMouseLeave={e => (e.currentTarget as HTMLElement).style.color = C.text2}
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
          <circle cx="12" cy="12" r="10"/><line x1="2" y1="12" x2="22" y2="12"/>
          <path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/>
        </svg>
      </button>

      <div style={{ flex: 1 }} />
    </div>
  );
}

// ── RunboxView ────────────────────────────────────────────────────────────────
function RunboxView({ runbox, onCwdChange }: { runbox: Runbox; onCwdChange: (cwd: string) => void }) {
  const firstLeaf = useRef(newLeaf());
  const [paneRoot,     setPaneRoot]     = useState<PaneNode>(() => firstLeaf.current);
  const [activePane,   setActivePane]   = useState<string>(() => firstLeaf.current.id);
  const [containerMap, setContainerMap] = useState<Record<string, HTMLDivElement>>({});
  const [paneCwds,     setPaneCwds]     = useState<Record<string, string>>({});

  // FIX: derive allIds directly from paneRoot — never separate state.
  // This means adding/removing panes never causes allIds to be out of sync
  // with paneRoot, which was causing portals to unmount and terminals to reset.
  const allIds = collectIds(paneRoot);

  const onMount   = useCallback((id: string, el: HTMLDivElement) => setContainerMap(p => ({ ...p, [id]: el })), []);
  const onUnmount = useCallback((id: string) => setContainerMap(p => { const n = { ...p }; delete n[id]; return n; }), []);
  const handlePaneCwd = useCallback((id: string, cwd: string) => setPaneCwds(p => ({ ...p, [id]: cwd })), []);

  useEffect(() => {
    const cwd = paneCwds[activePane];
    if (cwd) onCwdChange(cwd);
  }, [paneCwds, activePane, onCwdChange]);

  const handleClose = useCallback((id: string) => {
    setPaneRoot(prev => {
      if (collectIds(prev).length === 1) return prev;
      const next = removeLeaf(prev, id); if (!next) return prev;
      setActivePane(ap => ap === id ? collectIds(next)[0] : ap);
      return next;
    });
  }, []);

  const doSplit = useCallback((id: string, dir: SplitDir, makeNode: () => TermNode | BrowserNode) => {
    setPaneRoot(prev => {
      const added = makeNode();
      const next  = splitLeaf(prev, id, dir, added);
      setActivePane(added.id);
      return next;
    });
  }, []);

  const handleSplitH        = useCallback(() => doSplit(activePane, "h", newLeaf),    [doSplit, activePane]);
  const handleSplitV        = useCallback((id: string) => doSplit(id, "v", newLeaf),  [doSplit]);
  const handleSplitBrowserH = useCallback(() => doSplit(activePane, "h", newBrowser), [doSplit, activePane]);

  // Leaf IDs only (not browser panes) — shown as tabs
  const leafIds = collectLeafIds(paneRoot);

  return (
    <div style={{ display: "flex", flexDirection: "column", flex: 1, minHeight: 0 }}>

      {/* Tab bar — shows one tab per terminal pane */}
      <TabBar
        leafIds={leafIds}
        activePane={activePane}
        paneCwds={paneCwds}
        runboxCwd={runbox.cwd}
        onSelect={setActivePane}
        onSplitH={handleSplitH}
        onSplitBrowserH={handleSplitBrowserH}
        onClose={handleClose}
      />

      {/* Pane area */}
      <div style={{ flex: 1, display: "flex", minHeight: 0, background: C.bg0 }}>
        <PaneTree
          node={paneRoot} activePane={activePane}
          onActivate={setActivePane} onClose={handleClose}
          onSplitH={id => doSplit(id, "h", newLeaf)}
          onSplitV={handleSplitV}
          onMount={onMount} onUnmount={onUnmount}
        />
      </div>

      {/* KEY FIX: Portals are rendered for ALL allIds, not just visible ones.
          RunPanel is never unmounted when panes split — data is never lost.
          Using key={id} means each terminal has a stable identity. */}
      {allIds.map(id => {
        const container = containerMap[id];
        if (!container) return null;
        // Only render terminal panels (not browser nodes)
        function findNode(n: PaneNode): PaneNode | null {
          if ((n.type === "leaf" || n.type === "browser") && n.id === id) return n;
          if (n.type === "split") return findNode(n.a) || findNode(n.b);
          return null;
        }
        const found = findNode(paneRoot);
        if (!found || found.type !== "leaf") return null;
        return createPortal(
          <RunPanel
            key={id}                          // stable key = never remounts
            runboxCwd={runbox.cwd}
            runboxId={runbox.id}
            onCwdChange={cwd => handlePaneCwd(id, cwd)}
            isActive={activePane === id}
            onActivate={() => setActivePane(id)}
          />,
          container,
        );
      })}
    </div>
  );
}

// ── Empty state ───────────────────────────────────────────────────────────────
function EmptyState({ onCreate }: { onCreate: () => void }) {
  return (
    <div style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 16, background: C.bg0 }}>
      <div style={{ width: 40, height: 40, borderRadius: 10, border: `1px solid ${C.border}`, display: "flex", alignItems: "center", justifyContent: "center" }}>
        <span style={{ fontSize: 20, opacity: 0.12 }}>⬡</span>
      </div>
      <div style={{ textAlign: "center" }}>
        <div style={{ fontSize: 14, fontWeight: 600, color: C.text0, marginBottom: 7, fontFamily: "-apple-system,system-ui,sans-serif" }}>No runboxes</div>
        <div style={{ fontSize: 12, color: C.text2, marginBottom: 22, lineHeight: 1.8, fontFamily: "-apple-system,system-ui,sans-serif" }}>Create a runbox to start a terminal.</div>
        <button onClick={onCreate}
          style={{ padding: "9px 24px", background: C.text0, border: "none", borderRadius: 7, color: C.bg0, fontSize: 13, fontWeight: 700, cursor: "pointer", fontFamily: "-apple-system,system-ui,sans-serif" }}
          onMouseEnter={e => (e.currentTarget as HTMLElement).style.opacity = ".8"}
          onMouseLeave={e => (e.currentTarget as HTMLElement).style.opacity = "1"}>
          New Runbox
        </button>
      </div>
    </div>
  );
}

// ── Root ──────────────────────────────────────────────────────────────────────
const STORAGE_KEY = "stackbox-runboxes";
function loadRunboxes(): Runbox[] { try { return JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "[]"); } catch { return []; } }
function saveRunboxes(rbs: Runbox[]) { try { localStorage.setItem(STORAGE_KEY, JSON.stringify(rbs)); } catch {/**/} }

export default function RunboxManager() {
  const [runboxes,  setRunboxes]  = useState<Runbox[]>(() => loadRunboxes());
  const [activeId,  setActiveId]  = useState<string | null>(() => loadRunboxes()[0]?.id ?? null);
  const [activeTab, setActiveTab] = useState<"run" | "dashboard">("run");
  const [showModal, setShowModal] = useState(false);
  const [cwdMap,    setCwdMap]    = useState<Record<string, string>>({});

  useEffect(() => { saveRunboxes(runboxes); }, [runboxes]);

  const onCreate = useCallback((name: string, cwd: string) => {
    const rb: Runbox = { id: crypto.randomUUID(), name, cwd };
    setRunboxes(prev => [...prev, rb]); setActiveId(rb.id); setActiveTab("run");
  }, []);
  const onRename = useCallback((id: string, name: string) => setRunboxes(prev => prev.map(r => r.id === id ? { ...r, name } : r)), []);
  const onDelete = useCallback((id: string) => setRunboxes(prev => {
    const next = prev.filter(r => r.id !== id);
    setActiveId(aid => aid === id ? (next[0]?.id ?? null) : aid);
    return next;
  }), []);

  const safeId = runboxes.find(r => r.id === activeId)?.id ?? runboxes[0]?.id ?? null;

  return (
    <div style={{ display: "flex", height: "100%", width: "100%", background: C.bg0 }}>
      <Sidebar
        runboxes={runboxes} activeId={safeId} activeTab={activeTab} cwdMap={cwdMap}
        onSelect={setActiveId} onCreate={onCreate} onRename={onRename}
        onDelete={onDelete}   onTabChange={setActiveTab}
      />
      <div style={{ flex: 1, display: "flex", flexDirection: "column", minWidth: 0, minHeight: 0 }}>
        {runboxes.map(rb => (
          <div key={rb.id} style={{ display: activeTab === "run" && safeId === rb.id ? "flex" : "none", flex: 1, flexDirection: "column", minHeight: 0 }}>
            <RunboxView runbox={rb} onCwdChange={cwd => setCwdMap(p => ({ ...p, [rb.id]: cwd }))} />
          </div>
        ))}
        {activeTab === "run" && runboxes.length === 0 && <EmptyState onCreate={() => setShowModal(true)} />}
        {showModal && <NewRunboxModal onSubmit={(n, c) => { onCreate(n, c); setShowModal(false); }} onClose={() => setShowModal(false)} />}
      </div>
      <style>{`
        @keyframes modalIn { from{opacity:0;transform:scale(.96) translateY(8px)} to{opacity:1;transform:scale(1) translateY(0)} }
        * { box-sizing: border-box; }
      `}</style>
    </div>
  );
}