import { useState, useCallback, useRef, useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import RunPanel    from "./RunPanel";
import BrowserPane from "./BrowsePanel";

interface Runbox {
  id: string; name: string; cwd: string;
  worktreePath: string | null; branch: string | null;
}

const C = {
  bg0: "#0d0d0d", bg1: "#141414", bg2: "#1a1a1a",
  bg3: "#222222", bg4: "#2a2a2a",
  border: "rgba(255,255,255,.07)", borderHi: "rgba(255,255,255,.14)",
  text0: "#f0f0f0", text1: "#b0b0b0", text2: "#555555", text3: "#333333",
  green: "#3fb950", red: "#e05252", blue: "#79b8ff",
};

const tbtn: React.CSSProperties = {
  background: "none", border: "none", color: C.text2, cursor: "pointer",
  padding: "2px 4px", display: "flex", alignItems: "center",
  justifyContent: "center", borderRadius: 3, fontSize: 14, lineHeight: 1,
};

// ── Icons ──────────────────────────────────────────────────────────────────────
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
const IconGlobe = ({ active }: { active: boolean }) => (
  <svg width="15" height="15" viewBox="0 0 24 24" fill="none"
    stroke={active ? C.blue : "#555"} strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
    <circle cx="12" cy="12" r="10"/>
    <line x1="2" y1="12" x2="22" y2="12"/>
    <path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/>
  </svg>
);

// ── Pane tree (terminals only) ─────────────────────────────────────────────────
type SplitDir = "h" | "v";
interface TermNode  { type: "leaf";  id: string; }
interface SplitNode { type: "split"; dir: SplitDir; a: PaneNode; b: PaneNode; }
type PaneNode = TermNode | SplitNode;

let _seq = 0;
const newLeaf = (): TermNode => ({ type: "leaf", id: `t${++_seq}` });

function removeLeaf(node: PaneNode, id: string): PaneNode | null {
  if (node.type === "leaf") return node.id === id ? null : node;
  const a = removeLeaf(node.a, id), b = removeLeaf(node.b, id);
  if (!a && !b) return null; if (!a) return b!; if (!b) return a;
  return { ...node, a, b };
}
function splitLeaf(node: PaneNode, id: string, dir: SplitDir, added: TermNode): PaneNode {
  if (node.type === "leaf") return node.id !== id ? node : { type: "split", dir, a: node, b: added };
  return { ...node, a: splitLeaf(node.a, id, dir, added), b: splitLeaf(node.b, id, dir, added) };
}
function collectIds(node: PaneNode): string[] {
  if (node.type === "leaf") return [node.id];
  return [...collectIds(node.a), ...collectIds(node.b)];
}

function worktreeDir(repoPath: string, runboxId: string): string {
  const sep = repoPath.includes("\\") ? "\\" : "/";
  const parts = repoPath.split(sep).filter(Boolean);
  parts.pop();
  const base = (repoPath.startsWith("/") ? "/" : "") + parts.join(sep);
  return `${base}${sep}.stackbox-worktrees${sep}${runboxId}`;
}

// ── Modal ──────────────────────────────────────────────────────────────────────
const AGENTS = [
  { id: "claude", label: "Claude", color: "#79b8ff" },
  { id: "gemini", label: "Gemini", color: "#85e89d" },
  { id: "codex",  label: "Codex",  color: "#f97583" },
  { id: "cursor", label: "Cursor", color: "#b392f0" },
  { id: "kimi",   label: "Kimi",   color: "#ffdf5d" },
  { id: "iflow",  label: "iFlow",  color: "#56d364" },
  { id: "custom", label: "Custom", color: "#8b949e" },
];

function NewRunboxModal({ onSubmit, onClose }: {
  onSubmit: (name: string, cwd: string, agent: string, branch: string) => void;
  onClose: () => void;
}) {
  const [name, setName] = useState("");
  const [cwd, setCwd]   = useState("~/");
  const [agent, setAgent] = useState("claude");
  const [branch, setBranch] = useState("");
  const nameRef = useRef<HTMLInputElement>(null);
  useEffect(() => { setTimeout(() => nameRef.current?.focus(), 40); }, []);
  const submit = () => onSubmit(name.trim() || "untitled", cwd.trim() || "~/", agent, branch.trim());
  const inp: React.CSSProperties = {
    background: C.bg0, border: `1px solid ${C.border}`, borderRadius: 7,
    color: C.text0, fontSize: 13, padding: "10px 12px", outline: "none",
    fontFamily: "ui-monospace,'SF Mono',monospace", width: "100%", boxSizing: "border-box",
  };
  return (
    <div onClick={onClose} style={{ position: "fixed", inset: 0, zIndex: 1000, background: "rgba(0,0,0,.75)", backdropFilter: "blur(8px)", display: "flex", alignItems: "center", justifyContent: "center" }}>
      <div onClick={e => e.stopPropagation()} style={{ width: 430, background: C.bg2, border: `1px solid ${C.borderHi}`, borderRadius: 12, boxShadow: "0 48px 120px rgba(0,0,0,.9)", animation: "modalIn .16s cubic-bezier(.2,1,.4,1)", overflow: "hidden" }}>
        <div style={{ padding: "16px 20px", borderBottom: `1px solid ${C.border}`, display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <span style={{ fontSize: 14, fontWeight: 600, color: C.text0, fontFamily: "-apple-system,system-ui,sans-serif" }}>New Runbox</span>
          <button onClick={onClose} style={{ background: "none", border: "none", color: C.text2, fontSize: 18, cursor: "pointer" }}>×</button>
        </div>
        <div style={{ padding: "18px 20px 20px", display: "flex", flexDirection: "column", gap: 14 }}>
          <Field label="Name">
            <input ref={nameRef} value={name} onChange={e => setName(e.target.value)}
              onKeyDown={e => { if (e.key === "Enter") submit(); if (e.key === "Escape") onClose(); }}
              placeholder="my-feature" style={{ ...inp, fontSize: 14 }}
              onFocus={e => e.currentTarget.style.borderColor = C.borderHi}
              onBlur={e => e.currentTarget.style.borderColor = C.border} />
          </Field>
          <Field label="Project directory">
            <input value={cwd} onChange={e => setCwd(e.target.value)}
              onKeyDown={e => { if (e.key === "Enter") submit(); if (e.key === "Escape") onClose(); }}
              placeholder="~/my-project" style={inp}
              onFocus={e => e.currentTarget.style.borderColor = C.borderHi}
              onBlur={e => e.currentTarget.style.borderColor = C.border} />
          </Field>
          <Field label="Branch" hint="Leave blank to skip worktree">
            <input value={branch} onChange={e => setBranch(e.target.value)}
              onKeyDown={e => { if (e.key === "Enter") submit(); if (e.key === "Escape") onClose(); }}
              placeholder="feat/my-feature" style={inp}
              onFocus={e => e.currentTarget.style.borderColor = C.borderHi}
              onBlur={e => e.currentTarget.style.borderColor = C.border} />
          </Field>
          <Field label="Agent">
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
          </Field>
          <button onClick={submit} style={{ padding: "11px 0", marginTop: 2, background: C.text0, border: "none", borderRadius: 8, color: "#131313", fontSize: 13, fontWeight: 700, cursor: "pointer", fontFamily: "-apple-system,system-ui,sans-serif" }}>Launch →</button>
        </div>
      </div>
    </div>
  );
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      <div style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
        <label style={{ fontSize: 11, fontWeight: 600, color: C.text2, textTransform: "uppercase", letterSpacing: ".09em", fontFamily: "-apple-system,system-ui,sans-serif" }}>{label}</label>
        {hint && <span style={{ fontSize: 11, color: C.text3, fontFamily: "-apple-system,system-ui,sans-serif" }}>{hint}</span>}
      </div>
      {children}
    </div>
  );
}

// ── Sidebar ────────────────────────────────────────────────────────────────────
function Sidebar({ runboxes, activeId, activeTab, cwdMap, onSelect, onCreate, onRename, onDelete, onTabChange }: {
  runboxes: Runbox[]; activeId: string | null; activeTab: "run" | "dashboard";
  cwdMap: Record<string, string>;
  onSelect: (id: string) => void;
  onCreate: (name: string, cwd: string, agent: string, branch: string) => void;
  onRename: (id: string, name: string) => void;
  onDelete: (id: string) => void;
  onTabChange: (t: "run" | "dashboard") => void;
}) {
  const [showModal, setShowModal] = useState(false);
  const [renaming, setRenaming]   = useState<string | null>(null);
  const [renameVal, setRenameVal] = useState("");
  const renameRef = useRef<HTMLInputElement>(null);
  useEffect(() => { if (renaming) setTimeout(() => renameRef.current?.select(), 30); }, [renaming]);
  const submitRename = (id: string) => { if (renameVal.trim()) onRename(id, renameVal.trim()); setRenaming(null); };

  return (
    <>
      {showModal && <NewRunboxModal onSubmit={(n, c, a, b) => { onCreate(n, c, a, b); setShowModal(false); }} onClose={() => setShowModal(false)} />}
      <div style={{ width: 220, flexShrink: 0, background: C.bg1, borderRight: `1px solid ${C.border}`, display: "flex", flexDirection: "column" }}>
        <div style={{ padding: "10px 12px", borderBottom: `1px solid ${C.border}` }}>
          <div style={{ display: "flex", alignItems: "center", gap: 3, marginBottom: 11 }}>
            <span style={{ fontSize: 13, fontWeight: 700, color: C.text0, fontFamily: "-apple-system,system-ui,sans-serif", flex: 1 }}>Stackbox</span>
            <button onClick={() => onTabChange("run")} style={{ width: 28, height: 28, display: "flex", alignItems: "center", justifyContent: "center", background: activeTab === "run" ? C.bg4 : "none", border: "none", borderRadius: 6, cursor: "pointer" }}><IconTerminal active={activeTab === "run"} /></button>
            <button onClick={() => onTabChange("dashboard")} style={{ width: 28, height: 28, display: "flex", alignItems: "center", justifyContent: "center", background: activeTab === "dashboard" ? C.bg4 : "none", border: "none", borderRadius: 6, cursor: "pointer" }}><IconGrid active={activeTab === "dashboard"} /></button>
          </div>
          <button onClick={() => setShowModal(true)} style={{ display: "flex", alignItems: "center", gap: 8, width: "100%", padding: "8px 11px", background: "transparent", border: `1px solid ${C.border}`, borderRadius: 7, color: C.text1, fontSize: 12, fontWeight: 500, fontFamily: "-apple-system,system-ui,sans-serif", cursor: "pointer" }}
            onMouseEnter={e => { (e.currentTarget as HTMLElement).style.background = C.bg2; (e.currentTarget as HTMLElement).style.borderColor = C.borderHi; (e.currentTarget as HTMLElement).style.color = C.text0; }}
            onMouseLeave={e => { (e.currentTarget as HTMLElement).style.background = "transparent"; (e.currentTarget as HTMLElement).style.borderColor = C.border; (e.currentTarget as HTMLElement).style.color = C.text1; }}>
            <span style={{ fontSize: 16, lineHeight: 1, fontWeight: 300, color: C.text2 }}>+</span>New Runbox
          </button>
        </div>
        <div style={{ flex: 1, overflowY: "auto", padding: "5px 0" }}>
          {runboxes.length === 0 && <div style={{ padding: "20px 14px", fontSize: 12, color: C.text2, fontFamily: "-apple-system,system-ui,sans-serif" }}>No runboxes yet.</div>}
          {runboxes.map(rb => {
            const isOn = activeId === rb.id;
            const liveCwd = cwdMap[rb.id] || rb.worktreePath || rb.cwd;
            return (
              <div key={rb.id} onClick={() => onSelect(rb.id)} onDoubleClick={() => { setRenaming(rb.id); setRenameVal(rb.name); }}
                style={{ display: "flex", alignItems: "flex-start", gap: 9, padding: "9px 12px 9px 11px", cursor: "pointer", background: isOn ? C.bg2 : "transparent", borderLeft: `2px solid ${isOn ? "rgba(255,255,255,.28)" : "transparent"}` }}
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
                      <div style={{ fontSize: 11, color: C.text2, fontFamily: "ui-monospace,'SF Mono',monospace", marginTop: 2, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{rb.branch ? `⎇ ${rb.branch}` : liveCwd}</div>
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

// ── PaneLeaf — pure measurement slot ──────────────────────────────────────────
function PaneLeaf({ node, activePane, onActivate, onClose, onSplitH, onSplitV, onSlotMount, onSlotUnmount }: {
  node: TermNode; activePane: string;
  onActivate: (id: string) => void; onClose: (id: string) => void;
  onSplitH: (id: string) => void; onSplitV: (id: string) => void;
  onSlotMount: (id: string, el: HTMLDivElement) => void;
  onSlotUnmount: (id: string) => void;
}) {
  const slotRef  = useRef<HTMLDivElement>(null);
  const isActive = node.id === activePane;
  useEffect(() => {
    if (slotRef.current) onSlotMount(node.id, slotRef.current);
    return () => onSlotUnmount(node.id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [node.id]);
  return (
    <div onClick={() => onActivate(node.id)} style={{ flex: 1, display: "flex", flexDirection: "column", minHeight: 0, minWidth: 0, position: "relative", outline: isActive ? `1px solid rgba(255,255,255,.13)` : "none", outlineOffset: -1 }}>
      <div style={{ position: "absolute", top: 6, right: 8, zIndex: 20, background: C.bg2, border: `1px solid ${C.border}`, borderRadius: 5, padding: "2px 3px", display: "flex", gap: 2, opacity: isActive ? 1 : 0, transition: "opacity .15s", pointerEvents: isActive ? "auto" : "none" }}>
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
      <div ref={slotRef} style={{ flex: 1, minHeight: 0, minWidth: 0 }} />
    </div>
  );
}

// ── PaneTree ───────────────────────────────────────────────────────────────────
interface PaneTreeProps {
  node: PaneNode; activePane: string;
  onActivate: (id: string) => void; onClose: (id: string) => void;
  onSplitH: (id: string) => void; onSplitV: (id: string) => void;
  onSlotMount: (id: string, el: HTMLDivElement) => void;
  onSlotUnmount: (id: string) => void;
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
  return <PaneLeaf node={node} {...rest} />;
}

// ── TermTabBar ─────────────────────────────────────────────────────────────────
function TermTabBar({ leafIds, activePane, paneCwds, runboxCwd, onSelect, onNewTerm, onClose }: {
  leafIds: string[]; activePane: string; paneCwds: Record<string, string>;
  runboxCwd: string; onSelect: (id: string) => void;
  onNewTerm: () => void; onClose: (id: string) => void;
}) {
  return (
    <div style={{ display: "flex", alignItems: "stretch", height: 34, flexShrink: 0, background: C.bg1, borderBottom: `1px solid ${C.border}`, overflowX: "auto", overflowY: "hidden" }}>
      {leafIds.map(id => {
        const isActive = id === activePane;
        const cwd = paneCwds[id] || runboxCwd;
        const label = cwd.split(/[/\\]/).filter(Boolean).pop() || cwd;
        return (
          <div key={id} onClick={() => onSelect(id)}
            style={{ display: "flex", alignItems: "center", gap: 6, padding: "0 10px 0 12px", minWidth: 100, maxWidth: 160, cursor: "pointer", flexShrink: 0, background: isActive ? C.bg0 : C.bg1, borderRight: `1px solid ${C.border}`, borderBottom: isActive ? `2px solid ${C.blue}` : "2px solid transparent" }}
            onMouseEnter={e => { if (!isActive) (e.currentTarget as HTMLElement).style.background = C.bg2; }}
            onMouseLeave={e => { if (!isActive) (e.currentTarget as HTMLElement).style.background = C.bg1; }}>
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke={isActive ? C.blue : C.text2} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
              <polyline points="4 17 10 11 4 5"/><line x1="12" y1="19" x2="20" y2="19"/>
            </svg>
            <span style={{ fontSize: 12, flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", color: isActive ? C.text0 : C.text2, fontFamily: "ui-monospace,'SF Mono',monospace" }}>{label}</span>
            {leafIds.length > 1 && (
              <button onClick={e => { e.stopPropagation(); onClose(id); }}
                style={{ ...tbtn, fontSize: 13, opacity: isActive ? 0.6 : 0, padding: "0 2px", flexShrink: 0 }}
                onMouseEnter={e => { (e.currentTarget as HTMLElement).style.opacity = "1"; (e.currentTarget as HTMLElement).style.color = C.red; }}
                onMouseLeave={e => { (e.currentTarget as HTMLElement).style.opacity = isActive ? "0.6" : "0"; (e.currentTarget as HTMLElement).style.color = C.text2; }}>×</button>
            )}
          </div>
        );
      })}
      <button onClick={onNewTerm} title="New terminal"
        style={{ ...tbtn, padding: "0 12px", fontSize: 18, fontWeight: 300, borderRight: `1px solid ${C.border}`, borderRadius: 0, flexShrink: 0 }}
        onMouseEnter={e => (e.currentTarget as HTMLElement).style.color = C.text0}
        onMouseLeave={e => (e.currentTarget as HTMLElement).style.color = C.text2}>+</button>
      <div style={{ flex: 1 }} />
    </div>
  );
}

interface TermRect { left: number; top: number; width: number; height: number; }

// ── RunboxView ─────────────────────────────────────────────────────────────────
function RunboxView({ runbox, onCwdChange }: { runbox: Runbox; onCwdChange: (cwd: string) => void }) {
  const firstLeaf  = useRef(newLeaf());
  const [paneRoot,   setPaneRoot]   = useState<PaneNode>(() => firstLeaf.current);
  const [activePane, setActivePane] = useState<string>(() => firstLeaf.current.id);
  const [paneCwds,   setPaneCwds]   = useState<Record<string, string>>({});
  const slotMapRef  = useRef<Record<string, HTMLDivElement>>({});
  const [termRects, setTermRects]   = useState<Record<string, TermRect>>({});
  const wrapperRef  = useRef<HTMLDivElement>(null);
  const leafIds = collectIds(paneRoot);

  const onSlotMount   = useCallback((id: string, el: HTMLDivElement) => { slotMapRef.current[id] = el; }, []);
  const onSlotUnmount = useCallback((id: string) => { delete slotMapRef.current[id]; }, []);

  useEffect(() => {
    const wrapper = wrapperRef.current;
    if (!wrapper) return;
    const computeRect = (el: HTMLDivElement): TermRect => {
      const s = el.getBoundingClientRect(), w = wrapper.getBoundingClientRect();
      return { left: s.left - w.left, top: s.top - w.top, width: s.width, height: s.height };
    };
    const obs: ResizeObserver[] = [];
    for (const [id, el] of Object.entries(slotMapRef.current)) {
      setTermRects(prev => ({ ...prev, [id]: computeRect(el) }));
      const o = new ResizeObserver(() => setTermRects(prev => ({ ...prev, [id]: computeRect(el) })));
      o.observe(el); obs.push(o);
    }
    const wo = new ResizeObserver(() => {
      setTermRects(prev => {
        const next = { ...prev };
        for (const [id, el] of Object.entries(slotMapRef.current)) next[id] = computeRect(el);
        return next;
      });
    });
    wo.observe(wrapper); obs.push(wo);
    return () => obs.forEach(o => o.disconnect());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [leafIds.join(",")]);

  useEffect(() => {
    const cwd = paneCwds[activePane];
    if (cwd) onCwdChange(cwd);
  }, [paneCwds, activePane, onCwdChange]);

  const handleClose = useCallback((id: string) => {
    setPaneRoot(prev => {
      if (collectIds(prev).length === 1) return prev;
      const next = removeLeaf(prev, id);
      if (!next) return prev;
      setActivePane(ap => ap === id ? collectIds(next)[0] : ap);
      setTermRects(r => { const n = { ...r }; delete n[id]; return n; });
      return next;
    });
  }, []);

  const doSplit = useCallback((id: string, dir: SplitDir) => {
    setPaneRoot(prev => {
      const added = newLeaf();
      const next  = splitLeaf(prev, id, dir, added);
      setActivePane(added.id);
      return next;
    });
  }, []);

  const effectiveCwd = runbox.worktreePath || runbox.cwd;

  return (
    <div style={{ display: "flex", flexDirection: "column", flex: 1, minHeight: 0 }}>
      <TermTabBar
        leafIds={leafIds} activePane={activePane} paneCwds={paneCwds}
        runboxCwd={effectiveCwd} onSelect={setActivePane}
        onNewTerm={() => doSplit(activePane, "h")} onClose={handleClose}
      />
      <div ref={wrapperRef} style={{ flex: 1, display: "flex", minHeight: 0, background: C.bg0, position: "relative" }}>
        <PaneTree
          node={paneRoot} activePane={activePane}
          onActivate={setActivePane} onClose={handleClose}
          onSplitH={id => doSplit(id, "h")} onSplitV={id => doSplit(id, "v")}
          onSlotMount={onSlotMount} onSlotUnmount={onSlotUnmount}
        />
        {leafIds.map(id => {
          const rect = termRects[id];
          return (
            <div key={id} style={{
              position: "absolute",
              left: rect ? rect.left : 0, top: rect ? rect.top : 0,
              width: rect ? rect.width : 0, height: rect ? rect.height : 0,
              visibility: rect && rect.width > 0 ? "visible" : "hidden",
              zIndex: 1,
            }}>
              <RunPanel
                runboxCwd={effectiveCwd} runboxId={runbox.id}
                onCwdChange={cwd => setPaneCwds(p => ({ ...p, [id]: cwd }))}
                isActive={activePane === id} onActivate={() => setActivePane(id)}
              />
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ── BrowserPanel ───────────────────────────────────────────────────────────────
let _bseq = 0;
interface BrowserTab { id: string; url: string; }
const mkBrowserTab = (url = "https://google.com"): BrowserTab => ({ id: `bp${++_bseq}`, url });

function BrowserPanel({ open, width, onWidthChange, onClosePanel }: {
  open: boolean; width: number;
  onWidthChange: (w: number) => void;
  onClosePanel: () => void;
}) {
  const [tabs,       setTabs]       = useState<BrowserTab[]>(() => [mkBrowserTab()]);
  const [activeTab,  setActiveTab]  = useState<string>(() => tabs[0].id);
  // ── KEY FIX: lazy mount — only render BrowserPane once its tab has been activated.
  // This prevents all N tabs from calling browser_create simultaneously on open.
  const [mountedIds, setMountedIds] = useState<Set<string>>(() => new Set([tabs[0].id]));

  const dragRef = useRef<{ startX: number; startW: number } | null>(null);

  // When active tab changes, mark it as mounted (lazy mount)
  useEffect(() => {
    setMountedIds(prev => {
      if (prev.has(activeTab)) return prev;
      const next = new Set(prev);
      next.add(activeTab);
      return next;
    });
  }, [activeTab]);

  const addTab = () => {
    const t = mkBrowserTab();
    setTabs(prev => [...prev, t]);
    setActiveTab(t.id); // switching to it will trigger lazy mount
  };

  const closeTab = (id: string) => {
    setTabs(prev => {
      if (prev.length === 1) {
        // Last tab — close the whole panel instead
        onClosePanel();
        return prev;
      }
      const idx  = prev.findIndex(t => t.id === id);
      const next = prev.filter(t => t.id !== id);
      // Switch to neighbour before unmounting
      setActiveTab(a => a === id ? (next[Math.max(0, idx - 1)]?.id ?? next[0].id) : a);
      // Clean up lazy-mount set
      setMountedIds(m => { const n = new Set(m); n.delete(id); return n; });
      // Destroy native webview
      invoke("browser_destroy", { id }).catch(() => {});
      return next;
    });
  };

  const onDragStart = (e: React.MouseEvent) => {
    e.preventDefault();
    dragRef.current = { startX: e.clientX, startW: width };
    const onMove = (ev: MouseEvent) => {
      if (!dragRef.current) return;
      const delta = dragRef.current.startX - ev.clientX;
      onWidthChange(Math.max(280, Math.min(900, dragRef.current.startW + delta)));
    };
    const onUp = () => {
      dragRef.current = null;
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  };

  if (!open) return null;

  return (
    <div style={{
      width, flexShrink: 0, display: "flex", flexDirection: "column",
      background: C.bg1, borderLeft: `1px solid ${C.border}`,
      position: "relative",
      // No CSS transition — panel snaps open so slot has real dims immediately
    }}>
      {/* Drag handle */}
      <div
        onMouseDown={onDragStart}
        style={{ position: "absolute", left: 0, top: 0, bottom: 0, width: 5, cursor: "col-resize", zIndex: 30 }}
        onMouseEnter={e => (e.currentTarget as HTMLElement).style.background = "rgba(121,184,255,.2)"}
        onMouseLeave={e => (e.currentTarget as HTMLElement).style.background = "transparent"}
      />

      {/* Tab bar */}
      <div style={{
        display: "flex", alignItems: "stretch", height: 34, flexShrink: 0,
        background: C.bg1, borderBottom: `1px solid ${C.border}`,
        overflowX: "auto", overflowY: "hidden", paddingLeft: 5,
      }}>
        {tabs.map(tab => {
          const isActive = tab.id === activeTab;
          const domain = (() => { try { return new URL(tab.url).hostname.replace("www.", ""); } catch { return "new tab"; } })();
          return (
            <div
              key={tab.id}
              onClick={() => setActiveTab(tab.id)}
              style={{
                display: "flex", alignItems: "center", gap: 5,
                padding: "0 6px 0 10px", minWidth: 80, maxWidth: 140,
                cursor: "pointer", flexShrink: 0,
                background: isActive ? C.bg0 : C.bg1,
                borderRight: `1px solid ${C.border}`,
                borderBottom: isActive ? `2px solid ${C.blue}` : "2px solid transparent",
              }}
              onMouseEnter={e => { if (!isActive) (e.currentTarget as HTMLElement).style.background = C.bg2; }}
              onMouseLeave={e => { if (!isActive) (e.currentTarget as HTMLElement).style.background = C.bg1; }}
            >
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke={isActive ? C.blue : C.text2} strokeWidth="1.8" style={{ flexShrink: 0 }}>
                <circle cx="12" cy="12" r="10"/>
                <line x1="2" y1="12" x2="22" y2="12"/>
                <path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/>
              </svg>
              <span style={{ fontSize: 11, flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", color: isActive ? C.text0 : C.text2, fontFamily: "-apple-system,system-ui,sans-serif" }}>{domain}</span>
              {/* Close tab button — always works, last tab closes panel */}
              <button
                onClick={e => { e.stopPropagation(); closeTab(tab.id); }}
                style={{ ...tbtn, fontSize: 13, opacity: isActive ? 0.5 : 0, padding: "0 2px", flexShrink: 0 }}
                onMouseEnter={e => { (e.currentTarget as HTMLElement).style.opacity = "1"; (e.currentTarget as HTMLElement).style.color = C.red; }}
                onMouseLeave={e => { (e.currentTarget as HTMLElement).style.opacity = isActive ? "0.5" : "0"; (e.currentTarget as HTMLElement).style.color = C.text2; }}>×</button>
            </div>
          );
        })}
        <button onClick={addTab} title="New browser tab"
          style={{ ...tbtn, padding: "0 10px", fontSize: 16, fontWeight: 300, borderRadius: 0, flexShrink: 0 }}
          onMouseEnter={e => (e.currentTarget as HTMLElement).style.color = C.text0}
          onMouseLeave={e => (e.currentTarget as HTMLElement).style.color = C.text2}>+</button>
        <div style={{ flex: 1 }} />
      </div>

      {/* Browser pane stack — LAZY MOUNTED, only active visible */}
      <div style={{ flex: 1, position: "relative", minHeight: 0 }}>
        {tabs.map(tab => {
          // ── Lazy mount: don't render until tab has been activated at least once.
          // This ensures only ONE browser_create fires at a time, never in parallel.
          if (!mountedIds.has(tab.id)) return null;

          return (
            <div
              key={tab.id}
              style={{
                position: "absolute", inset: 0,
                // visibility hidden keeps webview alive but off-screen
                visibility: tab.id === activeTab ? "visible" : "hidden",
                pointerEvents: tab.id === activeTab ? "auto" : "none",
              }}
            >
              <BrowserPane
                paneId={tab.id}
                isActive={tab.id === activeTab}
                onActivate={() => setActiveTab(tab.id)}
                onClose={closeTab}
                onUrlChange={url => setTabs(prev => prev.map(t => t.id === tab.id ? { ...t, url } : t))}
              />
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ── EmptyState ─────────────────────────────────────────────────────────────────
function EmptyState({ onCreate }: { onCreate: () => void }) {
  return (
    <div style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 16, background: C.bg0 }}>
      <div style={{ width: 40, height: 40, borderRadius: 10, border: `1px solid ${C.border}`, display: "flex", alignItems: "center", justifyContent: "center" }}>
        <span style={{ fontSize: 20, opacity: 0.12 }}>⬡</span>
      </div>
      <div style={{ textAlign: "center" }}>
        <div style={{ fontSize: 14, fontWeight: 600, color: C.text0, marginBottom: 7, fontFamily: "-apple-system,system-ui,sans-serif" }}>No runboxes</div>
        <div style={{ fontSize: 12, color: C.text2, marginBottom: 22, lineHeight: 1.8, fontFamily: "-apple-system,system-ui,sans-serif" }}>Create a runbox to start a terminal.</div>
        <button onClick={onCreate} style={{ padding: "9px 24px", background: C.text0, border: "none", borderRadius: 7, color: C.bg0, fontSize: 13, fontWeight: 700, cursor: "pointer", fontFamily: "-apple-system,system-ui,sans-serif" }}
          onMouseEnter={e => (e.currentTarget as HTMLElement).style.opacity = ".8"}
          onMouseLeave={e => (e.currentTarget as HTMLElement).style.opacity = "1"}>New Runbox</button>
      </div>
    </div>
  );
}

// ── Storage ────────────────────────────────────────────────────────────────────
const STORAGE_KEY = "stackbox-runboxes";
function loadRunboxes(): Runbox[] { try { return JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "[]"); } catch { return []; } }
function saveRunboxes(rbs: Runbox[]) { try { localStorage.setItem(STORAGE_KEY, JSON.stringify(rbs)); } catch {/**/} }

// ── Root ───────────────────────────────────────────────────────────────────────
export default function RunboxManager() {
  const [runboxes,     setRunboxes]     = useState<Runbox[]>(() => loadRunboxes());
  const [activeId,     setActiveId]     = useState<string | null>(() => loadRunboxes()[0]?.id ?? null);
  const [activeTab,    setActiveTab]    = useState<"run" | "dashboard">("run");
  const [showModal,    setShowModal]    = useState(false);
  const [cwdMap,       setCwdMap]       = useState<Record<string, string>>({});
  const [browserOpen,  setBrowserOpen]  = useState(false);
  const [browserWidth, setBrowserWidth] = useState(480);

  useEffect(() => { saveRunboxes(runboxes); }, [runboxes]);

  const onCreate = useCallback(async (name: string, cwd: string, _agent: string, branch: string) => {
    const id = crypto.randomUUID();
    let worktreePath: string | null = null;
    if (branch) {
      const wtPath = worktreeDir(cwd, id);
      try {
        await invoke<string>("worktree_create", { repoPath: cwd, worktreePath: wtPath, branch });
        worktreePath = wtPath;
      } catch (err) { console.warn("[worktree] failed:", err); }
    }
    const rb: Runbox = { id, name, cwd, worktreePath, branch: branch || null };
    setRunboxes(prev => [...prev, rb]);
    setActiveId(id);
    setActiveTab("run");
  }, []);

  const onRename = useCallback((id: string, name: string) =>
    setRunboxes(prev => prev.map(r => r.id === id ? { ...r, name } : r)), []);

  const onDelete = useCallback(async (id: string) => {
    const rb = runboxes.find(r => r.id === id);
    if (rb?.worktreePath) {
      try { await invoke("worktree_remove", { repoPath: rb.cwd, worktreePath: rb.worktreePath }); }
      catch (err) { console.warn("[worktree] remove failed:", err); }
    }
    setRunboxes(prev => {
      const next = prev.filter(r => r.id !== id);
      setActiveId(aid => aid === id ? (next[0]?.id ?? null) : aid);
      return next;
    });
  }, [runboxes]);

  const safeId = runboxes.find(r => r.id === activeId)?.id ?? runboxes[0]?.id ?? null;

  return (
    <div style={{ display: "flex", height: "100%", width: "100%", background: C.bg0, overflow: "hidden" }}>

      <Sidebar runboxes={runboxes} activeId={safeId} activeTab={activeTab} cwdMap={cwdMap}
        onSelect={setActiveId} onCreate={onCreate} onRename={onRename}
        onDelete={onDelete} onTabChange={setActiveTab} />

      <div style={{ flex: 1, display: "flex", flexDirection: "column", minWidth: 0, minHeight: 0, position: "relative" }}>
        {/* Globe toggle */}
        <button
          onClick={() => setBrowserOpen(o => !o)}
          title={browserOpen ? "Close browser" : "Open browser"}
          style={{
            position: "absolute", top: 3, right: 8, zIndex: 100,
            width: 28, height: 28, display: "flex", alignItems: "center", justifyContent: "center",
            background: browserOpen ? C.bg3 : "none",
            border: `1px solid ${browserOpen ? C.borderHi : "transparent"}`,
            borderRadius: 6, cursor: "pointer",
          }}
          onMouseEnter={e => { (e.currentTarget as HTMLElement).style.background = C.bg3; (e.currentTarget as HTMLElement).style.borderColor = C.borderHi; }}
          onMouseLeave={e => { (e.currentTarget as HTMLElement).style.background = browserOpen ? C.bg3 : "none"; (e.currentTarget as HTMLElement).style.borderColor = browserOpen ? C.borderHi : "transparent"; }}
        >
          <IconGlobe active={browserOpen} />
        </button>

        {runboxes.map(rb => (
          <div key={rb.id} style={{ display: activeTab === "run" && safeId === rb.id ? "flex" : "none", flex: 1, flexDirection: "column", minHeight: 0 }}>
            <RunboxView runbox={rb} onCwdChange={cwd => setCwdMap(p => ({ ...p, [rb.id]: cwd }))} />
          </div>
        ))}
        {activeTab === "run" && runboxes.length === 0 && <EmptyState onCreate={() => setShowModal(true)} />}
        {showModal && <NewRunboxModal onSubmit={(n, c, a, b) => { onCreate(n, c, a, b); setShowModal(false); }} onClose={() => setShowModal(false)} />}
      </div>

      <BrowserPanel
        open={browserOpen} width={browserWidth}
        onWidthChange={setBrowserWidth}
        onClosePanel={() => setBrowserOpen(false)}
      />

      <style>{`
        @keyframes modalIn { from{opacity:0;transform:scale(.96) translateY(8px)} to{opacity:1;transform:scale(1) translateY(0)} }
        * { box-sizing: border-box; }
      `}</style>
    </div>
  );
}