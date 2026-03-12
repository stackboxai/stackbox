import { useState, useCallback, useRef, useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import RunPanel    from "./RunPanel";
import BrowserPane from "./BrowsePanel";
import MemoryPanel from "./MemoryPanel";

interface Runbox {
  id: string; name: string; cwd: string;
  worktreePath: string | null; branch: string | null;
}


const C = {
  bg0: "#0d1117", bg1: "#10161e", bg2: "#161b22",
  bg3: "#1c2230", bg4: "#21283a", bg5: "#262e40",
  border:   "rgba(255,255,255,.07)",
  borderMd: "rgba(255,255,255,.11)",
  borderHi: "rgba(255,255,255,.17)",
  t0: "#e6edf3", t1: "#8b949e", t2: "#484f58", t3: "#2d333b",
  teal:       "#3fb68b",
  tealBright: "#56d4a8",
  tealDim:    "rgba(63,182,139,.11)",
  tealBorder: "rgba(63,182,139,.24)",
  tealText:   "#56d4a8",
  green:   "#3fb950",
  greenDm: "rgba(63,185,80,.10)",
  greenBg: "rgba(63,185,80,.14)",
  red:     "#b05252",
  redBright: "#f85149",
  redBg:   "rgba(248,81,73,.10)",
  amber:   "#d29922",
  amberBg: "rgba(210,153,34,.12)",
  blue:    "#58a6ff",
  blueDim: "rgba(88,166,255,.10)",
};

const MONO = "ui-monospace,'SF Mono',Consolas,'Cascadia Code',monospace";
const SANS = "-apple-system,'SF Pro Text',system-ui,sans-serif";

const tbtn: React.CSSProperties = {
  background: "none", border: "none", color: C.t2, cursor: "pointer",
  padding: "2px 4px", display: "flex", alignItems: "center",
  justifyContent: "center", borderRadius: 5, lineHeight: 1,
};

function reltime(ms: number): string {
  const d = Date.now() - ms;
  if (d < 60_000)    return "just now";
  if (d < 3600_000)  return `${Math.floor(d / 60_000)}m ago`;
  if (d < 86400_000) return `${Math.floor(d / 3600_000)}h ago`;
  return `${Math.floor(d / 86400_000)}d ago`;
}

// ── Icons ─────────────────────────────────────────────────────────────────────
const IcoTerminal = ({ on }: { on?: boolean }) => (
  <svg width="13" height="13" viewBox="0 0 24 24" fill="none"
    stroke={on ? C.tealText : C.t2} strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
    <polyline points="4 17 10 11 4 5"/><line x1="12" y1="19" x2="20" y2="19"/>
  </svg>
);
const IcoGlobe = ({ on }: { on?: boolean }) => (
  <svg width="13" height="13" viewBox="0 0 24 24" fill="none"
    stroke={on ? C.tealText : C.t2} strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
    <circle cx="12" cy="12" r="10"/>
    <line x1="2" y1="12" x2="22" y2="12"/>
    <path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/>
  </svg>
);
const IcoBrain = ({ on }: { on?: boolean }) => (
  <svg width="13" height="13" viewBox="0 0 24 24" fill="none"
    stroke={on ? C.tealText : C.t2} strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
    <path d="M9.5 2A2.5 2.5 0 0 1 12 4.5v15a2.5 2.5 0 0 1-4.96-.44 2.5 2.5 0 0 1-2.96-3.08 3 3 0 0 1-.34-5.58 2.5 2.5 0 0 1 1.32-4.24 2.5 2.5 0 0 1 1.98-3A2.5 2.5 0 0 1 9.5 2Z"/>
    <path d="M14.5 2A2.5 2.5 0 0 0 12 4.5v15a2.5 2.5 0 0 0 4.96-.44 2.5 2.5 0 0 0 2.96-3.08 3 3 0 0 0 .34-5.58 2.5 2.5 0 0 0-1.32-4.24 2.5 2.5 0 0 0-1.98-3A2.5 2.5 0 0 0 14.5 2Z"/>
  </svg>
);
const IcoBranch = ({ on }: { on?: boolean }) => (
  <svg width="13" height="13" viewBox="0 0 24 24" fill="none"
    stroke={on ? C.tealText : C.t2} strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
    <line x1="6" y1="3" x2="6" y2="15"/>
    <circle cx="18" cy="6" r="3"/><circle cx="6" cy="18" r="3"/>
    <path d="M18 9a9 9 0 0 1-9 9"/>
  </svg>
);
const IcoSidebar = ({ on }: { on?: boolean }) => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none"
    stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <rect x="3" y="3" width="18" height="18" rx="2"/>
    <path d="M9 3v18"/>
    <path d="M3 3h6v18H3z" fill={on ? "currentColor" : "none"} stroke="none"/>
  </svg>
);



const IcoOpenEditor = () => (
  <svg width="12" height="12" viewBox="0 0 24 24" fill="none"
    stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
    <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>
    <polyline points="15 3 21 3 21 9"/>
    <line x1="10" y1="14" x2="21" y2="3"/>
  </svg>
);

// ─────────────────────────────────────────────────────────────────────────────
//  Pane tree types + helpers
// ─────────────────────────────────────────────────────────────────────────────
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
function worktreeDir(repoPath: string, runboxId: string) {
  const sep = repoPath.includes("\\") ? "\\" : "/";
  return `${repoPath}${sep}.worktrees${sep}${runboxId}`;
}

// ─────────────────────────────────────────────────────────────────────────────
//  Drag-resize hook
// ─────────────────────────────────────────────────────────────────────────────
function useDragResize(init: number, dir: "left" | "right" = "left", min = 180, max = 680) {
  const [w, setW] = useState(init);
  const ref = useRef<{ sx: number; sw: number } | null>(null);
  const onDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    ref.current = { sx: e.clientX, sw: w };
    const onMove = (ev: MouseEvent) => {
      if (!ref.current) return;
      const d = ev.clientX - ref.current.sx;
      setW(Math.max(min, Math.min(max, ref.current.sw + (dir === "right" ? d : -d))));
    };
    const onUp = () => {
      ref.current = null;
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  }, [w, dir, min, max]);
  return [w, onDown] as const;
}



// ─────────────────────────────────────────────────────────────────────────────
//  NewRunboxModal

// ─────────────────────────────────────────────────────────────────────────────
//  StatefulInput
// ─────────────────────────────────────────────────────────────────────────────
function StatefulInput({ inputRef, ...props }: React.InputHTMLAttributes<HTMLInputElement> & {
  inputRef?: React.RefObject<HTMLInputElement>;
}) {
  const [focused, setFocused] = useState(false);
  return (
    <input ref={inputRef} {...props}
      style={{ background: C.bg0, border: `1px solid ${focused ? C.borderHi : C.border}`, borderRadius: 8, color: C.t0, fontSize: 12, padding: "9px 11px", outline: "none", fontFamily: MONO, width: "100%", boxSizing: "border-box" as const, transition: "border-color .15s", ...(props.style ?? {}) }}
      onFocus={e => { setFocused(true); props.onFocus?.(e); }}
      onBlur={e  => { setFocused(false); props.onBlur?.(e); }} />
  );
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 7 }}>
        <span style={{ fontSize: 10, fontWeight: 600, letterSpacing: ".08em", textTransform: "uppercase", color: C.t2, fontFamily: SANS }}>{label}</span>
        {hint && <span style={{ fontSize: 10, color: C.t2, fontFamily: SANS }}>{hint}</span>}
      </div>
      {children}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
//  NewRunboxModal
// ─────────────────────────────────────────────────────────────────────────────
function NewRunboxModal({ onSubmit, onClose }: {
  onSubmit: (name: string, cwd: string, branch: string) => void; onClose: () => void;
}) {
  const [name, setName] = useState("");
  const [cwd,  setCwd]  = useState("~/");
  const [branch, setBranch] = useState("");
  const [isGitRepo,   setIsGitRepo]   = useState<boolean | null>(null);
  const [checkingGit, setCheckingGit] = useState(false);
  const [creating,    setCreating]    = useState(false);
  const nameRef = useRef<HTMLInputElement>(null);

  useEffect(() => { setTimeout(() => nameRef.current?.focus(), 40); }, []);
  useEffect(() => {
    if (!cwd.trim() || cwd === "~/") { setIsGitRepo(null); return; }
    setCheckingGit(true);
    const t = setTimeout(async () => {
      try   { await invoke("check_git_repo", { path: cwd.trim() }); setIsGitRepo(true); }
      catch { setIsGitRepo(false); setBranch(""); }
      finally { setCheckingGit(false); }
    }, 500);
    return () => clearTimeout(t);
  }, [cwd]);

  const submit = async () => {
    if (creating) return; setCreating(true);
    try { onSubmit(name.trim() || "untitled", cwd.trim() || "~/", branch.trim()); }
    finally { setCreating(false); }
  };
  const kd = (e: React.KeyboardEvent) => { if (e.key === "Enter") submit(); if (e.key === "Escape") onClose(); };

  return (
    <div onClick={onClose} style={{ position: "fixed", inset: 0, zIndex: 1000, background: "rgba(0,0,0,.62)", backdropFilter: "blur(3px)", display: "flex", alignItems: "center", justifyContent: "center" }}>
      <div onClick={e => e.stopPropagation()}
        style={{ width: 420, background: C.bg2, border: `1px solid ${C.borderMd}`, borderRadius: 14, boxShadow: "0 32px 80px rgba(0,0,0,.7), inset 0 1px 0 rgba(255,255,255,.05)", animation: "sbFadeUp .16s cubic-bezier(.2,1,.4,1)", overflow: "hidden" }}>
        <div style={{ padding: "13px 16px", borderBottom: `1px solid ${C.border}`, display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <span style={{ fontSize: 13, fontWeight: 600, color: C.t0, fontFamily: SANS }}>New runbox</span>
          <button onClick={onClose} style={{ ...tbtn, fontSize: 17 }}
            onMouseEnter={e => (e.currentTarget as HTMLElement).style.color = C.t0}
            onMouseLeave={e => (e.currentTarget as HTMLElement).style.color = C.t2}>×</button>
        </div>
        <div style={{ padding: "16px", display: "flex", flexDirection: "column", gap: 14 }}>
          <Field label="Name">
            <StatefulInput inputRef={nameRef} value={name} onChange={e => setName(e.target.value)} onKeyDown={kd} placeholder="my-feature" />
          </Field>
          <Field label="Directory">
            <div style={{ display: "flex", gap: 6 }}>
              <StatefulInput value={cwd} onChange={e => setCwd(e.target.value)} onKeyDown={kd} placeholder="~/my-project" style={{ flex: 1 } as any} />
              <button type="button" title="Browse folder"
                onClick={async () => { try { const d = await invoke<string | null>("open_directory_dialog"); if (d) setCwd(d); } catch {} }}
                style={{ width: 36, height: 36, flexShrink: 0, background: C.bg3, border: `1px solid ${C.border}`, borderRadius: 8, cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", color: C.t2, transition: "all .15s" }}
                onMouseEnter={e => { const el = e.currentTarget as HTMLElement; el.style.borderColor = C.borderHi; el.style.color = C.t0; el.style.background = C.bg4; }}
                onMouseLeave={e => { const el = e.currentTarget as HTMLElement; el.style.borderColor = C.border; el.style.color = C.t2; el.style.background = C.bg3; }}>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>
                </svg>
              </button>
            </div>
            <div style={{ marginTop: 5, minHeight: 17, fontSize: 11, fontFamily: SANS }}>
              {checkingGit && <span style={{ color: C.t2 }}>checking git…</span>}
              {!checkingGit && isGitRepo === true  && <span style={{ color: C.green }}>✓ git repo detected — worktree available</span>}
              {!checkingGit && isGitRepo === false && <span style={{ color: C.t2 }}>not a git repo — stackbox will initialise one</span>}
            </div>
          </Field>
          {isGitRepo === true && (
            <Field label="Branch" hint="(optional — leave blank to skip worktree)">
              <StatefulInput value={branch} onChange={e => setBranch(e.target.value)} onKeyDown={kd} placeholder="feat/my-feature" />
              {branch.trim() && (
                <div style={{ marginTop: 5, fontSize: 11, color: C.t2, fontFamily: SANS }}>
                  Worktree at <span style={{ color: C.t1 }}>.worktrees/{"<id>"}</span> on <span style={{ color: C.tealText }}>{branch}</span>
                </div>
              )}
            </Field>
          )}
          <button onClick={submit} disabled={creating}
            style={{ marginTop: 4, padding: "10px 0", background: creating ? C.bg4 : C.t0, border: "none", borderRadius: 9, color: creating ? C.t2 : C.bg0, fontSize: 13, fontWeight: 700, cursor: creating ? "default" : "pointer", fontFamily: SANS, transition: "opacity .15s" }}
            onMouseEnter={e => { if (!creating) (e.currentTarget as HTMLElement).style.opacity = ".87"; }}
            onMouseLeave={e => { (e.currentTarget as HTMLElement).style.opacity = "1"; }}>
            {creating ? "Creating…" : "Launch →"}
          </button>
        </div>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
//  OpenInEditorBtn
// ─────────────────────────────────────────────────────────────────────────────
function OpenInEditorBtn({ path }: { path: string }) {
  const [opening,      setOpening]      = useState(false);
  const [showMenu,     setShowMenu]     = useState(false);
  const [openedEditor, setOpenedEditor] = useState<string | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!showMenu) return;
    const h = (e: MouseEvent) => { if (menuRef.current && !menuRef.current.contains(e.target as Node)) setShowMenu(false); };
    window.addEventListener("mousedown", h);
    return () => window.removeEventListener("mousedown", h);
  }, [showMenu]);

  const openIn = async (editor: "vscode" | "cursor") => {
    setOpening(true); setShowMenu(false); setOpenedEditor(editor === "vscode" ? "VS Code" : "Cursor");
    try { await invoke("open_in_editor", { path, editor }); } catch {}
    setTimeout(() => { setOpening(false); setOpenedEditor(null); }, 1800);
  };

  return (
    <div ref={menuRef} style={{ position: "relative" }}>
      <button onClick={e => { e.stopPropagation(); setShowMenu(v => !v); }} title="Open in external editor"
        style={{ display: "flex", alignItems: "center", gap: 5, padding: "4px 8px", background: C.bg3, border: `1px solid ${C.border}`, borderRadius: 6, cursor: "pointer", color: opening ? C.tealText : C.t1, fontSize: 11, fontFamily: SANS, fontWeight: 500, transition: "all .12s", whiteSpace: "nowrap" }}
        onMouseEnter={e => { const el = e.currentTarget as HTMLElement; el.style.borderColor = C.borderMd; el.style.color = C.t0; el.style.background = C.bg4; }}
        onMouseLeave={e => { const el = e.currentTarget as HTMLElement; el.style.borderColor = C.border; el.style.color = opening ? C.tealText : C.t1; el.style.background = C.bg3; }}>
        <IcoOpenEditor />
        {opening ? `Opening in ${openedEditor}…` : "Open in Editor"}
        <svg width="7" height="7" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
          <polyline points="6 9 12 15 18 9"/>
        </svg>
      </button>
      {showMenu && (
        <div style={{ position: "absolute", top: "calc(100% + 4px)", left: 0, background: C.bg2, border: `1px solid ${C.borderMd}`, borderRadius: 9, overflow: "hidden", boxShadow: "0 8px 28px rgba(0,0,0,.55)", minWidth: 170, zIndex: 300, animation: "sbFadeUp .12s cubic-bezier(.2,1,.4,1)" }}>
          <div style={{ padding: "8px 12px 6px", borderBottom: `1px solid ${C.border}` }}>
            <div style={{ fontSize: 9, fontWeight: 700, letterSpacing: ".07em", textTransform: "uppercase", color: C.t2, fontFamily: SANS, marginBottom: 3 }}>Folder</div>
            <div style={{ fontSize: 10, color: C.t1, fontFamily: MONO, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{path}</div>
          </div>
          {([{ id: "vscode" as const, label: "VS Code", hint: "code" }, { id: "cursor" as const, label: "Cursor", hint: "cursor" }]).map(opt => (
            <button key={opt.id} onClick={e => { e.stopPropagation(); openIn(opt.id); }}
              style={{ display: "flex", alignItems: "center", gap: 10, width: "100%", padding: "9px 12px", background: "none", border: "none", cursor: "pointer", color: C.t1, fontSize: 12, fontFamily: SANS, textAlign: "left", transition: "all .1s" }}
              onMouseEnter={e => { const el = e.currentTarget as HTMLElement; el.style.background = C.bg3; el.style.color = C.t0; }}
              onMouseLeave={e => { const el = e.currentTarget as HTMLElement; el.style.background = "none"; el.style.color = C.t1; }}>
              <span style={{ flex: 1 }}>{opt.label}</span>
              <span style={{ fontSize: 10, color: C.t2, fontFamily: MONO }}>{opt.hint}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
//  WorktreePanel
// ─────────────────────────────────────────────────────────────────────────────
function WorktreePanel({ runboxes, activeId, onSelect, onClose }: {
  runboxes: Runbox[]; activeId: string | null; onSelect: (id: string) => void; onClose: () => void;
}) {
  const wtRunboxes = runboxes.filter(r => r.worktreePath);
  const [width, onDragDown] = useDragResize(268, "left", 200, 520);

  return (
    <div style={{ width, flexShrink: 0, background: C.bg1, borderLeft: `1px solid ${C.border}`, display: "flex", flexDirection: "column", position: "relative", userSelect: "none" }}>
      <div onMouseDown={onDragDown}
        style={{ position: "absolute", left: 0, top: 0, bottom: 0, width: 4, cursor: "col-resize", zIndex: 10, transition: "background .15s" }}
        onMouseEnter={e => (e.currentTarget as HTMLElement).style.background = C.tealBorder}
        onMouseLeave={e => (e.currentTarget as HTMLElement).style.background = "transparent"} />
      <div style={{ padding: "11px 14px 11px 18px", borderBottom: `1px solid ${C.border}`, display: "flex", alignItems: "center", justifyContent: "space-between", flexShrink: 0 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <IcoBranch on />
          <span style={{ fontSize: 12, fontWeight: 600, color: C.t1, fontFamily: SANS }}>Worktrees</span>
          {wtRunboxes.length > 0 && (
            <span style={{ fontSize: 10, color: C.tealText, background: C.tealDim, border: `1px solid ${C.tealBorder}`, borderRadius: 20, padding: "1px 7px", fontFamily: SANS, fontWeight: 600 }}>{wtRunboxes.length}</span>
          )}
        </div>
        <button onClick={onClose} style={{ ...tbtn, fontSize: 16 }}
          onMouseEnter={e => (e.currentTarget as HTMLElement).style.color = C.t0}
          onMouseLeave={e => (e.currentTarget as HTMLElement).style.color = C.t2}>×</button>
      </div>
      <div style={{ flex: 1, overflowY: "auto", padding: "10px", display: "flex", flexDirection: "column", gap: 6 }}>
        {wtRunboxes.length === 0 ? (
          <div style={{ padding: "40px 12px", textAlign: "center" }}>
            <div style={{ fontSize: 30, opacity: 0.05, marginBottom: 12 }}>⎇</div>
            <div style={{ fontSize: 12, color: C.t2, lineHeight: 1.8, fontFamily: SANS }}>No worktrees yet.<br />Create a runbox with a branch name.</div>
          </div>
        ) : wtRunboxes.map(r => {
          const isActive = r.id === activeId;
          return (
            <div key={r.id} onClick={() => onSelect(r.id)}
              style={{ background: isActive ? C.tealDim : C.bg2, border: `1px solid ${isActive ? C.tealBorder : C.border}`, borderRadius: 10, padding: "11px 12px", cursor: "pointer", transition: "all .12s" }}
              onMouseEnter={e => { if (!isActive) { (e.currentTarget as HTMLElement).style.background = C.bg3; (e.currentTarget as HTMLElement).style.borderColor = C.borderMd; } }}
              onMouseLeave={e => { if (!isActive) { (e.currentTarget as HTMLElement).style.background = C.bg2; (e.currentTarget as HTMLElement).style.borderColor = C.border; } }}>
              <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 5 }}>
                <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke={isActive ? C.tealText : C.t2} strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                  <line x1="6" y1="3" x2="6" y2="15"/><circle cx="18" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><path d="M18 9a9 9 0 0 1-9 9"/>
                </svg>
                <span style={{ fontSize: 12, fontWeight: 600, color: isActive ? C.tealText : C.t0, fontFamily: MONO, flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{r.branch}</span>
                {isActive && <span style={{ fontSize: 9, color: C.tealText, background: C.tealDim, border: `1px solid ${C.tealBorder}`, borderRadius: 4, padding: "1px 6px", fontFamily: SANS, fontWeight: 700, letterSpacing: ".05em" }}>ACTIVE</span>}
              </div>
              <div style={{ fontSize: 11, color: C.t1, fontFamily: SANS, marginBottom: 5 }}>{r.name}</div>
              <div style={{ fontSize: 10, color: C.t2, fontFamily: MONO, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", marginBottom: 10 }}>{r.worktreePath}</div>
              <div onClick={e => e.stopPropagation()}>
                <OpenInEditorBtn path={r.worktreePath!} />
              </div>
            </div>
          );
        })}
      </div>
      <div style={{ padding: "8px 14px", borderTop: `1px solid ${C.border}`, fontSize: 10, color: C.t3, fontFamily: SANS }}>Drag left edge to resize</div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
//  Sidebar
// ─────────────────────────────────────────────────────────────────────────────
function Sidebar({ runboxes, activeId, cwdMap, collapsed, onToggle, onSelect, onCreate, onRename, onDelete }: {
  runboxes: Runbox[]; activeId: string | null; cwdMap: Record<string, string>;
  collapsed: boolean; onToggle: () => void;
  onSelect: (id: string) => void; onCreate: (name: string, cwd: string, branch: string) => void;
  onRename: (id: string, name: string) => void; onDelete: (id: string) => void;
}) {
  const [showModal, setShowModal] = useState(false);
  const [renaming,  setRenaming]  = useState<string | null>(null);
  const [renameVal, setRenameVal] = useState("");
  const renameRef = useRef<HTMLInputElement>(null);
  useEffect(() => { if (renaming) setTimeout(() => renameRef.current?.select(), 30); }, [renaming]);
  const submitRename = (id: string) => { if (renameVal.trim()) onRename(id, renameVal.trim()); setRenaming(null); };

  return (
    <>
      {showModal && (
        <NewRunboxModal
          onSubmit={(n, c, b) => { onCreate(n, c, b); setShowModal(false); }}
          onClose={() => setShowModal(false)} />
      )}
      <div style={{ width: collapsed ? 48 : 218, flexShrink: 0, background: C.bg1, borderRight: `1px solid ${C.border}`, display: "flex", flexDirection: "column", transition: "width .15s cubic-bezier(.4,0,.2,1)", overflow: "hidden" }}>
        <div style={{ padding: collapsed ? "12px 0" : "12px 12px 10px", borderBottom: `1px solid ${C.border}`, display: "flex", flexDirection: "column", alignItems: "center", flexShrink: 0 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 4, marginBottom: collapsed ? 0 : 10, width: "100%", padding: collapsed ? "0" : "0 4px", justifyContent: collapsed ? "center" : "flex-start" }}>
            {!collapsed && <span style={{ fontSize: 11, fontWeight: 700, color: C.t1, fontFamily: SANS, flex: 1, letterSpacing: ".07em", textTransform: "uppercase", paddingLeft: 4 }}>Stackbox</span>}
            <button onClick={onToggle} title={collapsed ? "Expand sidebar" : "Collapse sidebar"}
              style={{ ...tbtn, color: collapsed ? C.t0 : C.t2, padding: 6 }}
              onMouseEnter={e => (e.currentTarget as HTMLElement).style.color = C.t0}
              onMouseLeave={e => (e.currentTarget as HTMLElement).style.color = collapsed ? C.t0 : C.t2}>
              <IcoSidebar on={!collapsed} />
            </button>
          </div>
          {!collapsed && (
            <button onClick={() => setShowModal(true)}
              style={{ display: "flex", alignItems: "center", gap: 7, width: "100%", padding: "7px 10px", background: "transparent", border: `1px solid ${C.border}`, borderRadius: 8, color: C.t2, fontSize: 11, fontWeight: 500, fontFamily: SANS, cursor: "pointer", transition: "all .12s" }}
              onMouseEnter={e => { const el = e.currentTarget as HTMLElement; el.style.background = C.bg3; el.style.borderColor = C.borderMd; el.style.color = C.t1; }}
              onMouseLeave={e => { const el = e.currentTarget as HTMLElement; el.style.background = "transparent"; el.style.borderColor = C.border; el.style.color = C.t2; }}>
              <span style={{ fontSize: 16, lineHeight: 1, fontWeight: 200 }}>+</span>New runbox
            </button>
          )}
        </div>

        {collapsed && (
          <div style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", gap: 6, padding: "8px 0", overflowY: "auto" }}>
            <button onClick={() => setShowModal(true)} title="New runbox"
              style={{ width: 32, height: 32, borderRadius: 8, background: "transparent", border: `1px solid ${C.border}`, color: C.t2, fontSize: 18, fontWeight: 300, cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", marginBottom: 4, transition: "all .12s", flexShrink: 0 }}
              onMouseEnter={e => { const el = e.currentTarget as HTMLElement; el.style.background = C.bg3; el.style.borderColor = C.borderMd; el.style.color = C.t1; }}
              onMouseLeave={e => { const el = e.currentTarget as HTMLElement; el.style.background = "transparent"; el.style.borderColor = C.border; el.style.color = C.t2; }}>+</button>
            {runboxes.map(rb => {
              const isOn = activeId === rb.id;
              return (
                <div key={rb.id} title={rb.name} onClick={() => onSelect(rb.id)}
                  style={{ width: 32, height: 32, borderRadius: 8, flexShrink: 0, cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 12, fontWeight: 700, fontFamily: SANS, transition: "all .12s", background: isOn ? C.tealDim : C.bg2, border: `1px solid ${isOn ? C.tealBorder : C.border}`, color: isOn ? C.tealText : C.t1, position: "relative" }}
                  onMouseEnter={e => { if (!isOn) { const el = e.currentTarget as HTMLElement; el.style.background = C.bg3; el.style.borderColor = C.borderMd; } }}
                  onMouseLeave={e => { if (!isOn) { const el = e.currentTarget as HTMLElement; el.style.background = C.bg2; el.style.borderColor = C.border; } }}>
                  {rb.name.charAt(0).toUpperCase()}
                  <span style={{ position: "absolute", bottom: 2, right: 2, width: 5, height: 5, borderRadius: "50%", background: isOn ? C.teal : C.green, border: `1px solid ${C.bg1}` }} />
                </div>
              );
            })}
          </div>
        )}

        {!collapsed && (
          <>
            {runboxes.length > 0 && <div style={{ padding: "10px 14px 4px", fontSize: 9, fontWeight: 700, letterSpacing: ".1em", textTransform: "uppercase", color: C.t2, fontFamily: SANS }}>Runboxes</div>}
            <div style={{ flex: 1, overflowY: "auto", padding: "4px 8px 8px" }}>
              {runboxes.length === 0 && <div style={{ padding: "20px 8px", fontSize: 11, color: C.t2, fontFamily: SANS, lineHeight: 1.7 }}>No runboxes yet.</div>}
              {runboxes.map(rb => {
                const isOn = activeId === rb.id;
                const liveCwd = cwdMap[rb.id] || rb.worktreePath || rb.cwd;
                return (
                  <div key={rb.id} onClick={() => onSelect(rb.id)}
                    onDoubleClick={() => { setRenaming(rb.id); setRenameVal(rb.name); }}
                    style={{ display: "flex", alignItems: "center", gap: 8, padding: "7px 9px", marginBottom: 2, cursor: "pointer", background: isOn ? C.tealDim : "transparent", border: `1px solid ${isOn ? C.tealBorder : "transparent"}`, borderRadius: 9, transition: "all .12s" }}
                    onMouseEnter={e => { if (!isOn) { (e.currentTarget as HTMLElement).style.background = C.bg3; (e.currentTarget as HTMLElement).style.borderColor = C.border; } }}
                    onMouseLeave={e => { if (!isOn) { (e.currentTarget as HTMLElement).style.background = "transparent"; (e.currentTarget as HTMLElement).style.borderColor = "transparent"; } }}>
                    <span style={{ display: "block", width: 5, height: 5, borderRadius: "50%", background: isOn ? C.teal : C.green, flexShrink: 0, transition: "background .15s" }} />
                    <div style={{ flex: 1, minWidth: 0 }}>
                      {renaming === rb.id ? (
                        <input ref={renameRef} value={renameVal} onChange={e => setRenameVal(e.target.value)}
                          onBlur={() => submitRename(rb.id)}
                          onKeyDown={e => { if (e.key === "Enter") submitRename(rb.id); if (e.key === "Escape") setRenaming(null); }}
                          onClick={e => e.stopPropagation()}
                          style={{ background: C.bg4, border: `1px solid ${C.borderHi}`, borderRadius: 5, color: C.t0, fontSize: 12, padding: "2px 6px", width: "100%", outline: "none", fontFamily: MONO }} />
                      ) : (
                        <>
                          <div style={{ fontSize: 12, fontWeight: isOn ? 500 : 400, color: isOn ? C.tealText : C.t0, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", fontFamily: SANS, marginBottom: 1 }}>{rb.name}</div>
                          <div style={{ fontSize: 10, color: isOn ? "rgba(86,212,168,.4)" : C.t2, fontFamily: MONO, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{rb.branch ? `⎇ ${rb.branch}` : liveCwd}</div>
                        </>
                      )}
                    </div>
                    {isOn && (
                      <button onClick={e => { e.stopPropagation(); if (confirm(`Delete "${rb.name}"?`)) onDelete(rb.id); }}
                        style={{ ...tbtn, fontSize: 14, flexShrink: 0 }}
                        onMouseEnter={e => (e.currentTarget as HTMLElement).style.color = C.red}
                        onMouseLeave={e => (e.currentTarget as HTMLElement).style.color = C.t3}>×</button>
                    )}
                  </div>
                );
              })}
            </div>
            <div style={{ padding: "8px 14px", borderTop: `1px solid ${C.border}`, fontSize: 10, color: C.t3, fontFamily: SANS }}>Double-click to rename</div>
          </>
        )}
      </div>
    </>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
//  PaneLeaf + PaneTree
// ─────────────────────────────────────────────────────────────────────────────
function PaneLeaf({ node, activePane, onActivate, onClose, onSplitH, onSplitV, onSlotMount, onSlotUnmount }: {
  node: TermNode; activePane: string; onActivate: (id: string) => void; onClose: (id: string) => void;
  onSplitH: (id: string) => void; onSplitV: (id: string) => void;
  onSlotMount: (id: string, el: HTMLDivElement) => void; onSlotUnmount: (id: string) => void;
}) {
  const slotRef = useRef<HTMLDivElement>(null);
  const isActive = node.id === activePane;
  useEffect(() => { if (slotRef.current) onSlotMount(node.id, slotRef.current); return () => onSlotUnmount(node.id); }, [node.id]);
  return (
    <div onClick={() => onActivate(node.id)} style={{ flex: 1, display: "flex", flexDirection: "column", minHeight: 0, minWidth: 0, position: "relative", outline: isActive ? `1px solid rgba(63,182,139,.16)` : "none", outlineOffset: -1 }}>
      <div style={{ position: "absolute", top: 7, right: 9, zIndex: 20, background: C.bg2, border: `1px solid ${C.border}`, borderRadius: 8, padding: "3px 4px", display: "flex", gap: 2, opacity: isActive ? 1 : 0, transition: "opacity .15s", pointerEvents: isActive ? "auto" : "none" }}>
        <button title="Split right" onClick={e => { e.stopPropagation(); onSplitH(node.id); }} style={tbtn}
          onMouseEnter={e => (e.currentTarget as HTMLElement).style.color = C.tealText}
          onMouseLeave={e => (e.currentTarget as HTMLElement).style.color = C.t2}>
          <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"><rect x="1" y="2" width="14" height="12" rx="2"/><line x1="8" y1="2" x2="8" y2="14"/></svg>
        </button>
        <button title="Split down" onClick={e => { e.stopPropagation(); onSplitV(node.id); }} style={tbtn}
          onMouseEnter={e => (e.currentTarget as HTMLElement).style.color = C.tealText}
          onMouseLeave={e => (e.currentTarget as HTMLElement).style.color = C.t2}>
          <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"><rect x="1" y="2" width="14" height="12" rx="2"/><line x1="1" y1="8" x2="15" y2="8"/></svg>
        </button>
        <button title="Close pane" onClick={e => { e.stopPropagation(); onClose(node.id); }} style={tbtn}
          onMouseEnter={e => (e.currentTarget as HTMLElement).style.color = C.red}
          onMouseLeave={e => (e.currentTarget as HTMLElement).style.color = C.t2}>×</button>
      </div>
      <div ref={slotRef} style={{ flex: 1, minHeight: 0, minWidth: 0, opacity: isActive ? 1 : 0.3, transition: "opacity .2s" }} />
    </div>
  );
}
interface PaneTreeProps { node: PaneNode; activePane: string; onActivate: (id: string) => void; onClose: (id: string) => void; onSplitH: (id: string) => void; onSplitV: (id: string) => void; onSlotMount: (id: string, el: HTMLDivElement) => void; onSlotUnmount: (id: string) => void; }
function PaneTree(props: PaneTreeProps) {
  const { node, ...rest } = props;
  if (node.type === "split") {
    const isH = node.dir === "h";
    return (
      <div style={{ display: "flex", flexDirection: isH ? "row" : "column", flex: 1, minHeight: 0, minWidth: 0 }}>
        <div style={{ flex: 1, display: "flex", minHeight: 0, minWidth: 0, borderRight: isH ? `1px solid ${C.border}` : "none", borderBottom: !isH ? `1px solid ${C.border}` : "none" }}><PaneTree node={node.a} {...rest} /></div>
        <div style={{ flex: 1, display: "flex", minHeight: 0, minWidth: 0 }}><PaneTree node={node.b} {...rest} /></div>
      </div>
    );
  }
  return <PaneLeaf node={node} {...rest} />;
}

// ─────────────────────────────────────────────────────────────────────────────
//  TermTabBar
// ─────────────────────────────────────────────────────────────────────────────
function TermTabBar({ leafIds, activePane, paneCwds, runboxCwd, runboxBranch, onSelect, onNewTerm, onClose }: {
  leafIds: string[]; activePane: string; paneCwds: Record<string, string>; runboxCwd: string; runboxBranch: string | null;
  onSelect: (id: string) => void; onNewTerm: () => void; onClose: (id: string) => void;
}) {
  return (
    <div style={{ display: "flex", alignItems: "stretch", height: 35, flexShrink: 0, background: C.bg1, borderBottom: `1px solid ${C.border}`, overflowX: "auto", overflowY: "hidden" }}>
      {leafIds.map(id => {
        const isActive = id === activePane;
        const cwd = paneCwds[id] || runboxCwd;
        const label = cwd.split(/[/\\]/).filter(Boolean).pop() || cwd;
        return (
          <div key={id} onClick={() => onSelect(id)}
            style={{ display: "flex", alignItems: "center", gap: 6, padding: "0 10px 0 12px", minWidth: 90, maxWidth: 160, cursor: "pointer", flexShrink: 0, background: isActive ? C.bg0 : "transparent", borderRight: `1px solid ${C.border}`, borderBottom: isActive ? `2px solid ${C.teal}` : "2px solid transparent", transition: "background .1s" }}
            onMouseEnter={e => { if (!isActive) (e.currentTarget as HTMLElement).style.background = C.bg2; }}
            onMouseLeave={e => { if (!isActive) (e.currentTarget as HTMLElement).style.background = "transparent"; }}>
            <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke={isActive ? C.tealText : C.t2} strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}><polyline points="4 17 10 11 4 5"/><line x1="12" y1="19" x2="20" y2="19"/></svg>
            <span style={{ fontSize: 11, flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", color: isActive ? C.t0 : C.t2, fontFamily: MONO }}>{label}</span>
            {leafIds.length > 1 && (
              <button onClick={e => { e.stopPropagation(); onClose(id); }}
                style={{ ...tbtn, fontSize: 12, opacity: isActive ? 0.5 : 0, padding: "0 1px", flexShrink: 0 }}
                onMouseEnter={e => { (e.currentTarget as HTMLElement).style.opacity = "1"; (e.currentTarget as HTMLElement).style.color = C.red; }}
                onMouseLeave={e => { (e.currentTarget as HTMLElement).style.opacity = isActive ? "0.5" : "0"; (e.currentTarget as HTMLElement).style.color = C.t2; }}>×</button>
            )}
          </div>
        );
      })}
      <button onClick={onNewTerm} title="New terminal"
        style={{ ...tbtn, padding: "0 12px", fontSize: 17, fontWeight: 300, borderRight: `1px solid ${C.border}`, borderRadius: 0, flexShrink: 0 }}
        onMouseEnter={e => (e.currentTarget as HTMLElement).style.color = C.tealText}
        onMouseLeave={e => (e.currentTarget as HTMLElement).style.color = C.t2}>+</button>
      <div style={{ flex: 1 }} />
      {runboxBranch && (
        <div style={{ display: "flex", alignItems: "center", gap: 5, padding: "0 12px", borderLeft: `1px solid ${C.border}`, flexShrink: 0 }}>
          <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke={C.t2} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="6" y1="3" x2="6" y2="15"/><circle cx="18" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><path d="M18 9a9 9 0 0 1-9 9"/></svg>
          <span style={{ fontSize: 10, color: C.t2, fontFamily: MONO, maxWidth: 130, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{runboxBranch}</span>
        </div>
      )}
    </div>
  );
}

interface TermRect { left: number; top: number; width: number; height: number; }

// ─────────────────────────────────────────────────────────────────────────────
//  RunboxView
// ─────────────────────────────────────────────────────────────────────────────
function RunboxView({ runbox, onCwdChange }: { runbox: Runbox; onCwdChange: (cwd: string) => void }) {
  const firstLeaf = useRef(newLeaf());
  const [paneRoot,   setPaneRoot]   = useState<PaneNode>(() => firstLeaf.current);
  const [activePane, setActivePane] = useState<string>(() => firstLeaf.current.id);
  const [paneCwds,   setPaneCwds]   = useState<Record<string, string>>({});
  const slotMapRef = useRef<Record<string, HTMLDivElement>>({});
  const [termRects,  setTermRects]  = useState<Record<string, TermRect>>({});
  const wrapperRef = useRef<HTMLDivElement>(null);
  const leafIds = collectIds(paneRoot);

  const onSlotMount   = useCallback((id: string, el: HTMLDivElement) => { slotMapRef.current[id] = el; }, []);
  const onSlotUnmount = useCallback((id: string) => { delete slotMapRef.current[id]; }, []);

  useEffect(() => {
    const wrapper = wrapperRef.current; if (!wrapper) return;
    const compute = (el: HTMLDivElement): TermRect => {
      const s = el.getBoundingClientRect(), w = wrapper.getBoundingClientRect();
      return { left: s.left - w.left, top: s.top - w.top, width: s.width, height: s.height };
    };
    const obs: ResizeObserver[] = [];
    for (const [id, el] of Object.entries(slotMapRef.current)) {
      setTermRects(p => ({ ...p, [id]: compute(el) }));
      const o = new ResizeObserver(() => setTermRects(p => ({ ...p, [id]: compute(el) }))); o.observe(el); obs.push(o);
    }
    const wo = new ResizeObserver(() => { setTermRects(p => { const n = { ...p }; for (const [id, el] of Object.entries(slotMapRef.current)) n[id] = compute(el); return n; }); });
    wo.observe(wrapper); obs.push(wo);
    return () => obs.forEach(o => o.disconnect());
  }, [leafIds.join(",")]);

  useEffect(() => { const cwd = paneCwds[activePane]; if (cwd) onCwdChange(cwd); }, [paneCwds, activePane, onCwdChange]);

  const handleClose = useCallback((id: string) => {
    setPaneRoot(prev => {
      if (collectIds(prev).length === 1) return prev;
      const next = removeLeaf(prev, id); if (!next) return prev;
      setActivePane(ap => ap === id ? collectIds(next)[0] : ap);
      setTermRects(r => { const n = { ...r }; delete n[id]; return n; });
      return next;
    });
  }, []);

  const doSplit = useCallback((id: string, dir: SplitDir) => {
    setPaneRoot(prev => { const added = newLeaf(); setActivePane(added.id); return splitLeaf(prev, id, dir, added); });
  }, []);

  const effectiveCwd = runbox.worktreePath || runbox.cwd;

  return (
    <div style={{ display: "flex", flexDirection: "column", flex: 1, minHeight: 0 }}>
      <TermTabBar leafIds={leafIds} activePane={activePane} paneCwds={paneCwds}
        runboxCwd={effectiveCwd} runboxBranch={runbox.branch}
        onSelect={setActivePane} onNewTerm={() => doSplit(activePane, "h")} onClose={handleClose} />
      <div ref={wrapperRef} style={{ flex: 1, display: "flex", minHeight: 0, background: C.bg0, position: "relative" }}>
        <PaneTree node={paneRoot} activePane={activePane}
          onActivate={setActivePane} onClose={handleClose}
          onSplitH={id => doSplit(id, "h")} onSplitV={id => doSplit(id, "v")}
          onSlotMount={onSlotMount} onSlotUnmount={onSlotUnmount} />
        {leafIds.map(id => {
          const rect = termRects[id];
          return (
            <div key={id} style={{ position: "absolute", left: rect?.left ?? 0, top: rect?.top ?? 0, width: rect?.width ?? 0, height: rect?.height ?? 0, visibility: rect && rect.width > 0 ? "visible" : "hidden", zIndex: 1 }}>
              <RunPanel runboxCwd={effectiveCwd} runboxId={runbox.id}
                onCwdChange={cwd => setPaneCwds(p => ({ ...p, [id]: cwd }))}
                isActive={activePane === id} onActivate={() => setActivePane(id)} />
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
//  BrowserPanel — auto-open only (no toolbar toggle)
// ─────────────────────────────────────────────────────────────────────────────
let _bseq = 0;
interface BrowserTab { id: string; url: string; }
const mkBrowserTab = (url = "https://github.com"): BrowserTab => ({ id: `bp${++_bseq}`, url });

function BrowserPanel({ open, onClosePanel, pendingUrl, onPendingUrlConsumed }: {
  open: boolean; onClosePanel: () => void; pendingUrl: string | null; onPendingUrlConsumed: () => void;
}) {
  const [tabs,       setTabs]       = useState<BrowserTab[]>(() => [mkBrowserTab()]);
  const [activeTab,  setActiveTab]  = useState(() => tabs[0].id);
  const [mountedIds, setMountedIds] = useState<Set<string>>(() => new Set([tabs[0].id]));
  const [width,      onDragDown]    = useDragResize(480, "left", 220, 900);

  useEffect(() => {
    if (!pendingUrl) return;
    setTabs(p => p.map(t => t.id === activeTab ? { ...t, url: pendingUrl } : t));
    onPendingUrlConsumed();
  }, [pendingUrl]);

  useEffect(() => { setMountedIds(p => { if (p.has(activeTab)) return p; const n = new Set(p); n.add(activeTab); return n; }); }, [activeTab]);

  const addTab   = () => { const t = mkBrowserTab(); setTabs(p => [...p, t]); setActiveTab(t.id); };
  const closeTab = (id: string) => {
    setTabs(p => {
      if (p.length === 1) { onClosePanel(); return p; }
      const idx = p.findIndex(t => t.id === id);
      const n   = p.filter(t => t.id !== id);
      setActiveTab(a => a === id ? (n[Math.max(0, idx - 1)]?.id ?? n[0].id) : a);
      setMountedIds(m => { const s = new Set(m); s.delete(id); return s; });
      invoke("browser_destroy", { id }).catch(() => {});
      return n;
    });
  };

  if (!open) return null;
  return (
    <div style={{ width, flexShrink: 0, display: "flex", flexDirection: "column", background: C.bg1, borderLeft: `1px solid ${C.border}`, position: "relative" }}>
      <div onMouseDown={onDragDown}
        style={{ position: "absolute", left: 0, top: 0, bottom: 0, width: 4, cursor: "col-resize", zIndex: 9999, transition: "background .15s" }}
        onMouseEnter={e => (e.currentTarget as HTMLElement).style.background = C.tealBorder}
        onMouseLeave={e => (e.currentTarget as HTMLElement).style.background = "transparent"} />
      <div style={{ display: "flex", alignItems: "stretch", height: 35, flexShrink: 0, background: C.bg1, borderBottom: `1px solid ${C.border}`, overflowX: "auto", paddingLeft: 6 }}>
        {tabs.map(tab => {
          const isActive = tab.id === activeTab;
          const domain   = (() => { try { return new URL(tab.url).hostname.replace("www.", ""); } catch { return "new tab"; } })();
          return (
            <div key={tab.id} onClick={() => setActiveTab(tab.id)}
              style={{ display: "flex", alignItems: "center", gap: 5, padding: "0 7px 0 10px", minWidth: 76, maxWidth: 140, cursor: "pointer", flexShrink: 0, background: isActive ? C.bg0 : "transparent", borderRight: `1px solid ${C.border}`, borderBottom: isActive ? `2px solid ${C.teal}` : "2px solid transparent" }}
              onMouseEnter={e => { if (!isActive) (e.currentTarget as HTMLElement).style.background = C.bg2; }}
              onMouseLeave={e => { if (!isActive) (e.currentTarget as HTMLElement).style.background = "transparent"; }}>
              <IcoGlobe on={isActive} />
              <span style={{ fontSize: 11, flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", color: isActive ? C.t0 : C.t2, fontFamily: SANS }}>{domain}</span>
              <button onClick={e => { e.stopPropagation(); closeTab(tab.id); }}
                style={{ ...tbtn, fontSize: 12, opacity: isActive ? 0.5 : 0, flexShrink: 0 }}
                onMouseEnter={e => { (e.currentTarget as HTMLElement).style.opacity = "1"; (e.currentTarget as HTMLElement).style.color = C.red; }}
                onMouseLeave={e => { (e.currentTarget as HTMLElement).style.opacity = isActive ? "0.5" : "0"; (e.currentTarget as HTMLElement).style.color = C.t2; }}>×</button>
            </div>
          );
        })}
        <button onClick={addTab} style={{ ...tbtn, padding: "0 10px", fontSize: 16, fontWeight: 300, borderRadius: 0, flexShrink: 0 }}
          onMouseEnter={e => (e.currentTarget as HTMLElement).style.color = C.tealText}
          onMouseLeave={e => (e.currentTarget as HTMLElement).style.color = C.t2}>+</button>
        <div style={{ flex: 1 }} />
        <button onClick={onClosePanel} title="Close browser"
          style={{ ...tbtn, padding: "0 10px", borderRadius: 0, borderLeft: `1px solid ${C.border}`, flexShrink: 0 }}
          onMouseEnter={e => (e.currentTarget as HTMLElement).style.color = C.red}
          onMouseLeave={e => (e.currentTarget as HTMLElement).style.color = C.t2}>×</button>
      </div>
      <div style={{ flex: 1, position: "relative", minHeight: 0 }}>
        {tabs.map(tab => {
          if (!mountedIds.has(tab.id)) return null;
          return (
            <div key={tab.id} style={{ position: "absolute", inset: 0, visibility: tab.id === activeTab ? "visible" : "hidden", pointerEvents: tab.id === activeTab ? "auto" : "none" }}>
              <BrowserPane paneId={tab.id} isActive={tab.id === activeTab}
                onActivate={() => setActiveTab(tab.id)} onClose={closeTab}
                externalUrl={tab.id === activeTab ? pendingUrl : null}
                onExternalUrlConsumed={onPendingUrlConsumed}
                onUrlChange={url => setTabs(p => p.map(t => t.id === tab.id ? { ...t, url } : t))} />
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
//  Toolbar button
// ─────────────────────────────────────────────────────────────────────────────
function ToolBtn({ on, onClick, title, badge, children }: {
  on: boolean; onClick: () => void; title: string; badge?: number; children: React.ReactNode;
}) {
  return (
    <button onClick={onClick} title={title}
      style={{ width: 28, height: 28, display: "flex", alignItems: "center", justifyContent: "center", background: on ? C.bg4 : "none", border: `1px solid ${on ? C.borderMd : "transparent"}`, borderRadius: 7, cursor: "pointer", transition: "all .12s", position: "relative" }}
      onMouseEnter={e => { const el = e.currentTarget as HTMLElement; el.style.background = C.bg3; el.style.borderColor = C.border; }}
      onMouseLeave={e => { const el = e.currentTarget as HTMLElement; el.style.background = on ? C.bg4 : "none"; el.style.borderColor = on ? C.borderMd : "transparent"; }}>
      {children}
      {badge !== undefined && badge > 0 && (
        <span style={{ position: "absolute", top: -3, right: -3, minWidth: 14, height: 14, borderRadius: 7, background: C.teal, color: C.bg0, fontSize: 9, fontWeight: 800, fontFamily: SANS, display: "flex", alignItems: "center", justifyContent: "center", padding: "0 3px", border: `1.5px solid ${C.bg1}` }}>
          {badge > 99 ? "99+" : badge}
        </span>
      )}
    </button>
  );
}

function EmptyState({ onCreate }: { onCreate: () => void }) {
  return (
    <div style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 14, background: C.bg0 }}>
      <div style={{ width: 42, height: 42, borderRadius: 12, border: `1px solid ${C.border}`, display: "flex", alignItems: "center", justifyContent: "center", background: C.bg2 }}>
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke={C.t2} strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"><polyline points="4 17 10 11 4 5"/><line x1="12" y1="19" x2="20" y2="19"/></svg>
      </div>
      <div style={{ textAlign: "center" }}>
        <div style={{ fontSize: 13, fontWeight: 600, color: C.t0, marginBottom: 6, fontFamily: SANS }}>No runboxes</div>
        <div style={{ fontSize: 12, color: C.t1, marginBottom: 22, lineHeight: 1.8, fontFamily: SANS }}>Create a runbox to open a terminal session.</div>
        <button onClick={onCreate}
          style={{ padding: "9px 24px", background: C.t0, border: "none", borderRadius: 9, color: C.bg0, fontSize: 12, fontWeight: 700, cursor: "pointer", fontFamily: SANS, transition: "opacity .15s" }}
          onMouseEnter={e => (e.currentTarget as HTMLElement).style.opacity = ".86"}
          onMouseLeave={e => (e.currentTarget as HTMLElement).style.opacity = "1"}>
          New Runbox
        </button>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
//  Storage
// ─────────────────────────────────────────────────────────────────────────────
const STORAGE_KEY = "stackbox-runboxes-v2";
function loadRunboxes(): Runbox[] { try { return JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "[]"); } catch { return []; } }
function saveRunboxes(rbs: Runbox[]) { try { localStorage.setItem(STORAGE_KEY, JSON.stringify(rbs)); } catch {} }


export default function RunboxManager() {
  const [runboxes,         setRunboxes]         = useState<Runbox[]>(() => loadRunboxes());
  const [activeId,         setActiveId]         = useState<string | null>(() => loadRunboxes()[0]?.id ?? null);
  const [showModal,        setShowModal]        = useState(false);
  const [cwdMap,           setCwdMap]           = useState<Record<string, string>>({});
  const [browserOpen,      setBrowserOpen]      = useState(false);
  const [memoryOpen,       setMemoryOpen]       = useState(false);
  const [worktreeOpen,     setWorktreeOpen]     = useState(false);
  const [memWidth,         setMemWidth]         = useState(320);
  const [pendingUrl,       setPendingUrl]       = useState<string | null>(null);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);

  // Browser auto-opens when agent prints a URL — no toolbar button needed
  useEffect(() => {
    const unsub = listen<string>("browser-open-url", ({ payload: url }) => {
      setBrowserOpen(true);
      setPendingUrl(url);
    });
    return () => { unsub.then(f => f()); };
  }, []);


  useEffect(() => { saveRunboxes(runboxes); }, [runboxes]);

  // Only one right panel open at a time (except browser which is separate)
  const closeSidePanels = () => { setMemoryOpen(false); setWorktreeOpen(false); };

  const onCreate = useCallback(async (name: string, cwd: string, branch: string) => {
    const id = crypto.randomUUID();
    let worktreePath: string | null = null;
    if (branch.trim()) {
      const wtPath = worktreeDir(cwd, id);
      try {
        await invoke<string>("worktree_create", { repoPath: cwd, worktreePath: wtPath, branch: branch.trim() });
        worktreePath = wtPath;
        invoke("git_ignore_worktrees", { repoPath: cwd }).catch(() => {});
      } catch (err) {
        alert(`Worktree setup failed:\n${err}\n\nOpening in main project directory instead.`);
      }
    }
    const rb: Runbox = { id, name, cwd, worktreePath, branch: branch.trim() || null };
    // Silently ensure git repo exists (creates shadow repo if no .git so memory pipeline works)
    invoke("git_ensure", { cwd: worktreePath ?? cwd, runboxId: id }).catch(() => {});
    setRunboxes(p => [...p, rb]);
    setActiveId(id);
  }, []);

  const onRename = useCallback((id: string, name: string) =>
    setRunboxes(p => p.map(r => r.id === id ? { ...r, name } : r)), []);

  const onDelete = useCallback(async (id: string) => {
    const rb = runboxes.find(r => r.id === id);
    if (rb?.worktreePath) {
      try { await invoke("worktree_remove", { repoPath: rb.cwd, worktreePath: rb.worktreePath }); }
      catch (e) { console.warn("worktree remove:", e); }
    }
    invoke("memory_delete_for_runbox", { runboxId: id }).catch(() => {});
    setRunboxes(p => {
      const next = p.filter(r => r.id !== id);
      setActiveId(a => a === id ? (next[0]?.id ?? null) : a);
      return next;
    });
    if (id === activeId) { setMemoryOpen(false); }
  }, [runboxes, activeId]);

  const safeId       = runboxes.find(r => r.id === activeId)?.id ?? runboxes[0]?.id ?? null;
  const hasWorktrees = runboxes.some(r => r.worktreePath);
  const activeRb     = runboxes.find(r => r.id === safeId);

  // Memory panel drag resize
  const memDragRef = useRef<{ sx: number; sw: number } | null>(null);
  const onMemDragDown = (e: React.MouseEvent) => {
    e.preventDefault();
    memDragRef.current = { sx: e.clientX, sw: memWidth };
    const onMove = (ev: MouseEvent) => { if (!memDragRef.current) return; setMemWidth(Math.max(260, Math.min(680, memDragRef.current.sw - (ev.clientX - memDragRef.current.sx)))); };
    const onUp = () => { memDragRef.current = null; window.removeEventListener("mousemove", onMove); window.removeEventListener("mouseup", onUp); };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  };

  return (
    <div style={{ display: "flex", height: "100%", width: "100%", background: C.bg0, overflow: "hidden" }}>

      {/* ── Sidebar */}
      <Sidebar runboxes={runboxes} activeId={safeId} cwdMap={cwdMap}
        onSelect={id => setActiveId(id)} onCreate={onCreate}
        collapsed={sidebarCollapsed} onToggle={() => setSidebarCollapsed(v => !v)}
        onRename={onRename} onDelete={onDelete} />

      {/* ── Main */}
      <div style={{ flex: 1, display: "flex", flexDirection: "column", minWidth: 0, minHeight: 0, position: "relative" }}>

        {/* ── Toolbar — top right ──────────────────────────────────────────
            Order: [⎇ Worktree] [🧠 Memory]
            Browser has no button — it auto-opens from URL detection.
        ─────────────────────────────────────────────────────────────────── */}
        <div style={{ position: "absolute", top: 4, right: 10, zIndex: 100, display: "flex", alignItems: "center", gap: 4 }}>

          {/* Git Worktrees */}
          <ToolBtn on={worktreeOpen} title="Git worktrees"
            onClick={() => { const o = !worktreeOpen; closeSidePanels(); setWorktreeOpen(o); }}>
            <IcoBranch on={worktreeOpen} />
          </ToolBtn>

          {/* Separator */}
          <div style={{ width: 1, height: 14, background: C.border, margin: "0 1px" }} />

          {/* Memory */}
          <ToolBtn on={memoryOpen} title="Memory"
            onClick={() => { const o = !memoryOpen; closeSidePanels(); setMemoryOpen(o); }}>
            <IcoBrain on={memoryOpen} />
          </ToolBtn>
        </div>

        {/* Runboxes */}
        {runboxes.map(rb => (
          <div key={rb.id} style={{ display: safeId === rb.id ? "flex" : "none", flex: 1, flexDirection: "column", minHeight: 0 }}>
            <RunboxView runbox={rb} onCwdChange={cwd => setCwdMap(p => ({ ...p, [rb.id]: cwd }))} />
          </div>
        ))}

        {runboxes.length === 0 && <EmptyState onCreate={() => setShowModal(true)} />}

        {showModal && (
          <NewRunboxModal
            onSubmit={(n, c, b) => { onCreate(n, c, b); setShowModal(false); }}
            onClose={() => setShowModal(false)} />
        )}
      </div>

      {/* ── Right panels ─────────────────────────────────────────────────── */}

      {/* Browser — auto-opens from PTY URL detection, no toolbar toggle */}
      <BrowserPanel open={browserOpen} pendingUrl={pendingUrl}
        onPendingUrlConsumed={() => setPendingUrl(null)}
        onClosePanel={() => setBrowserOpen(false)} />

      {/* Worktrees */}
      {worktreeOpen && (
        <WorktreePanel runboxes={runboxes} activeId={safeId}
          onSelect={id => setActiveId(id)}
          onClose={() => setWorktreeOpen(false)} />
      )}


      {/* Memory */}
      {memoryOpen && activeRb && (
        <div style={{ width: memWidth, flexShrink: 0, display: "flex", flexDirection: "column", background: C.bg1, borderLeft: `1px solid ${C.border}`, position: "relative" }}>
          <div onMouseDown={onMemDragDown}
            style={{ position: "absolute", left: 0, top: 0, bottom: 0, width: 4, cursor: "col-resize", zIndex: 30, transition: "background .15s" }}
            onMouseEnter={e => (e.currentTarget as HTMLElement).style.background = C.tealBorder}
            onMouseLeave={e => (e.currentTarget as HTMLElement).style.background = "transparent"} />
          <MemoryPanel runboxId={activeRb.id} runboxName={activeRb.name}
            runboxes={runboxes.map(r => ({ id: r.id, name: r.name }))}
            onClose={() => setMemoryOpen(false)} />
        </div>
      )}

      <style>{`
        @keyframes sbFadeUp { from{opacity:0;transform:translateY(8px) scale(.98)} to{opacity:1;transform:translateY(0) scale(1)} }
        @keyframes spin     { to{transform:rotate(360deg)} }
        * { box-sizing: border-box; }
        ::-webkit-scrollbar { width: 5px; height: 5px; }
        ::-webkit-scrollbar-track { background: transparent; }
        ::-webkit-scrollbar-thumb { background: #2d333b; border-radius: 4px; }
        ::-webkit-scrollbar-thumb:hover { background: #3d4451; }
        ::selection { background: rgba(63,182,139,.22); color: #e6edf3; }
      `}</style>
    </div>
  );
}