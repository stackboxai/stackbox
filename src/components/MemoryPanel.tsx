/**
 * MemoryPanel.tsx
 * Memories · Sessions · Files
 *
 * Files tab:
 *  - Click any file row  → Code Peek modal (full file + git-style diff)
 *  - "Open in Editor" btn in peek modal → VS Code / Cursor
 */

import { useState, useEffect, useCallback, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event"; // ← ADDED: needed for memory-added event

// ── Palette — matches RunboxManager charcoal tokens ───────────────────────────
const C = {
  bg0: "#0d1117", bg1: "#10161e", bg2: "#161b22",
  bg3: "#1c2230", bg4: "#21283a",
  border:   "rgba(255,255,255,.07)",
  borderMd: "rgba(255,255,255,.11)",
  borderHi: "rgba(255,255,255,.17)",
  t0: "#e6edf3", t1: "#8b949e", t2: "#484f58", t3: "#2d333b",
  teal:       "#3fb68b",
  tealDim:    "rgba(63,182,139,.11)",
  tealBorder: "rgba(63,182,139,.24)",
  tealText:   "#56d4a8",
  green:   "#3fb950",
  greenBg: "rgba(63,185,80,.12)",
  red:     "#f85149",
  redBg:   "rgba(248,81,73,.10)",
  amber:   "#d29922",
  blue:    "#58a6ff",
  blueDim: "rgba(88,166,255,.10)",
  purple:  "#bc8cff",
};

const MONO = "ui-monospace,'SF Mono',Consolas,'Cascadia Code',monospace";
const SANS = "-apple-system,'SF Pro Text',system-ui,sans-serif";

// ── Types ─────────────────────────────────────────────────────────────────────
export interface Memory {
  id:         string;
  runbox_id:  string;
  session_id: string;
  content:    string;
  pinned:     boolean;
  timestamp:  number;
  _scope?:    string;
}

export interface DbSession {
  id:         string;
  runbox_id:  string;
  pane_id:    string;
  agent:      string;
  cwd:        string;
  started_at: number;
  ended_at:   number | null;
  exit_code:  number | null;
  log_path:   string | null;
}

export interface FileChange {
  id:          number;
  session_id:  string;
  runbox_id:   string;
  file_path:   string;
  change_type: "created" | "modified" | "deleted";
  diff:        string | null;
  timestamp:   number;
}

type Tab   = "memories" | "sessions" | "files";
type Scope = "this" | "all" | "pick";

// ── Helpers ───────────────────────────────────────────────────────────────────
function reltime(ms: number): string {
  const d = Date.now() - ms;
  if (d < 60_000)    return "just now";
  if (d < 3600_000)  return `${Math.floor(d / 60_000)}m ago`;
  if (d < 86400_000) return `${Math.floor(d / 3600_000)}h ago`;
  return `${Math.floor(d / 86400_000)}d ago`;
}

const tbtn: React.CSSProperties = {
  background: "none", border: "none", color: C.t2, cursor: "pointer",
  padding: "2px 5px", borderRadius: 4, fontSize: 12,
  display: "flex", alignItems: "center", gap: 4,
};

// ── Git diff line classifier ──────────────────────────────────────────────────
type DiffLineKind = "add" | "remove" | "hunk" | "meta" | "context";

function classifyLine(line: string): DiffLineKind {
  if (line.startsWith("+++") || line.startsWith("---") ||
      line.startsWith("diff ") || line.startsWith("index ") ||
      line.startsWith("new file") || line.startsWith("deleted file")) return "meta";
  if (line.startsWith("@@")) return "hunk";
  if (line.startsWith("+"))  return "add";
  if (line.startsWith("-"))  return "remove";
  return "context";
}

const DIFF_LINE_STYLES: Record<DiffLineKind, React.CSSProperties> = {
  add:     { background: C.greenBg, color: C.green,  borderLeft: `3px solid ${C.green}`,  paddingLeft: 10 },
  remove:  { background: C.redBg,   color: C.red,    borderLeft: `3px solid ${C.red}`,    paddingLeft: 10 },
  hunk:    { background: C.blueDim, color: C.blue,   borderLeft: `3px solid ${C.blue}`,   paddingLeft: 10, fontStyle: "italic" },
  meta:    { color: C.t2,           paddingLeft: 13 },
  context: { color: C.t1,           paddingLeft: 13 },
};

// ── DiffView ──────────────────────────────────────────────────────────────────
function DiffView({ diff, maxHeight = 420 }: { diff: string; maxHeight?: number }) {
  const lines = diff.split("\n");
  let oldLine = 0, newLine = 0;
  const parsed = lines.map(line => {
    const kind = classifyLine(line);
    if (kind === "hunk") {
      const m = line.match(/@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
      if (m) { oldLine = parseInt(m[1]) - 1; newLine = parseInt(m[2]) - 1; }
      return { line, kind, oldN: null as number | null, newN: null as number | null };
    }
    if (kind === "add")     { newLine++; return { line, kind, oldN: null,    newN: newLine }; }
    if (kind === "remove")  { oldLine++; return { line, kind, oldN: oldLine, newN: null    }; }
    if (kind === "context") { oldLine++; newLine++; return { line, kind, oldN: oldLine, newN: newLine }; }
    return { line, kind, oldN: null, newN: null };
  });

  return (
    <div style={{ background: C.bg0, borderRadius: 8, overflow: "auto", maxHeight, border: `1px solid ${C.border}` }}>
      <table style={{ borderCollapse: "collapse", width: "100%", tableLayout: "fixed" }}>
        <colgroup>
          <col style={{ width: 38 }} />
          <col style={{ width: 38 }} />
          <col />
        </colgroup>
        <tbody>
          {parsed.map((row, i) => {
            const s = DIFF_LINE_STYLES[row.kind];
            const isMeta = row.kind === "meta" || row.kind === "hunk";
            return (
              <tr key={i} style={{ background: (s.background as string) ?? "transparent" }}>
                <td style={{ padding: "0 6px", textAlign: "right", fontSize: 10, color: row.kind === "remove" ? "rgba(248,81,73,.5)" : C.t3, userSelect: "none", fontFamily: MONO, verticalAlign: "top", paddingTop: 1 }}>
                  {isMeta ? "" : (row.oldN ?? "")}
                </td>
                <td style={{ padding: "0 6px", textAlign: "right", fontSize: 10, color: row.kind === "add" ? "rgba(63,185,80,.5)" : C.t3, userSelect: "none", fontFamily: MONO, verticalAlign: "top", paddingTop: 1, borderRight: `1px solid ${C.border}` }}>
                  {isMeta ? "" : (row.newN ?? "")}
                </td>
                <td style={{ ...s, background: "transparent", fontSize: 11.5, fontFamily: MONO, lineHeight: 1.55, padding: "0 10px", whiteSpace: "pre-wrap", wordBreak: "break-all", verticalAlign: "top" }}>
                  {row.line}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

// ── CodePeekModal ─────────────────────────────────────────────────────────────
function CodePeekModal({ fc, onClose }: { fc: FileChange; onClose: () => void }) {
  const [opening,      setOpening]      = useState(false);
  const [openedEditor, setOpenedEditor] = useState<string | null>(null);
  const [showEdMenu,   setShowEdMenu]   = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!showEdMenu) return;
    const h = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setShowEdMenu(false);
    };
    window.addEventListener("mousedown", h);
    return () => window.removeEventListener("mousedown", h);
  }, [showEdMenu]);

  useEffect(() => {
    const h = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [onClose]);

  const openIn = async (editor: "vscode" | "cursor") => {
    setOpening(true);
    setShowEdMenu(false);
    setOpenedEditor(editor === "vscode" ? "VS Code" : "Cursor");
    try { await invoke("open_in_editor", { path: fc.file_path, editor }); } catch {}
    setTimeout(() => { setOpening(false); setOpenedEditor(null); }, 1800);
  };

  const changeColor: Record<string, string> = { created: C.green, modified: C.amber, deleted: C.red };
  const cc = changeColor[fc.change_type] ?? C.t2;
  const fileName = fc.file_path.split(/[/\\]/).pop() ?? fc.file_path;
  const dirPart  = fc.file_path.slice(0, fc.file_path.length - fileName.length);

  return (
    <div
      onClick={onClose}
      style={{ position: "fixed", inset: 0, zIndex: 2000, background: "rgba(0,0,0,.72)", backdropFilter: "blur(4px)", display: "flex", alignItems: "center", justifyContent: "center" }}>
      <div
        onClick={e => e.stopPropagation()}
        style={{ width: "min(860px, 92vw)", maxHeight: "82vh", background: C.bg2, border: `1px solid ${C.borderMd}`, borderRadius: 14, boxShadow: "0 40px 100px rgba(0,0,0,.8), inset 0 1px 0 rgba(255,255,255,.05)", display: "flex", flexDirection: "column", overflow: "hidden", animation: "sbFadeUp .15s cubic-bezier(.2,1,.4,1)" }}>
        <div style={{ padding: "12px 16px", borderBottom: `1px solid ${C.border}`, display: "flex", alignItems: "center", gap: 10, flexShrink: 0 }}>
          <span style={{ fontSize: 9, fontWeight: 700, letterSpacing: ".07em", textTransform: "uppercase", color: cc, background: `${cc}18`, border: `1px solid ${cc}33`, borderRadius: 4, padding: "2px 7px", fontFamily: SANS, flexShrink: 0 }}>
            {fc.change_type}
          </span>
          <div style={{ flex: 1, fontFamily: MONO, fontSize: 12, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            <span style={{ color: C.t2 }}>{dirPart}</span>
            <span style={{ color: C.t0, fontWeight: 600 }}>{fileName}</span>
          </div>
          <span style={{ fontSize: 10, color: C.t2, fontFamily: SANS, flexShrink: 0 }}>{reltime(fc.timestamp)}</span>
          <div ref={menuRef} style={{ position: "relative", flexShrink: 0 }}>
            <button
              onClick={() => setShowEdMenu(v => !v)}
              style={{ display: "flex", alignItems: "center", gap: 6, padding: "5px 10px", background: showEdMenu ? C.bg4 : C.bg3, border: `1px solid ${showEdMenu ? C.borderHi : C.border}`, borderRadius: 7, cursor: "pointer", color: opening ? C.tealText : C.t1, fontSize: 11, fontFamily: SANS, fontWeight: 500, transition: "all .12s", whiteSpace: "nowrap" }}
              onMouseEnter={e => { const el = e.currentTarget as HTMLElement; el.style.background = C.bg4; el.style.color = C.t0; el.style.borderColor = C.borderMd; }}
              onMouseLeave={e => { const el = e.currentTarget as HTMLElement; el.style.background = showEdMenu ? C.bg4 : C.bg3; el.style.color = opening ? C.tealText : C.t1; el.style.borderColor = showEdMenu ? C.borderHi : C.border; }}>
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>
                <polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/>
              </svg>
              {opening ? `Opening in ${openedEditor}…` : "Open in Editor"}
              <svg width="7" height="7" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="6 9 12 15 18 9"/>
              </svg>
            </button>
            {showEdMenu && (
              <div style={{ position: "absolute", top: "calc(100% + 4px)", right: 0, background: C.bg2, border: `1px solid ${C.borderMd}`, borderRadius: 9, overflow: "hidden", boxShadow: "0 8px 28px rgba(0,0,0,.55)", minWidth: 160, zIndex: 100, animation: "sbFadeUp .1s cubic-bezier(.2,1,.4,1)" }}>
                {([
                  { id: "vscode" as const, label: "VS Code", hint: "code" },
                  { id: "cursor" as const, label: "Cursor",  hint: "cursor" },
                ]).map(opt => (
                  <button key={opt.id}
                    onClick={() => openIn(opt.id)}
                    style={{ display: "flex", alignItems: "center", gap: 10, width: "100%", padding: "9px 13px", background: "none", border: "none", cursor: "pointer", color: C.t1, fontSize: 12, fontFamily: SANS, textAlign: "left", transition: "background .1s" }}
                    onMouseEnter={e => { const el = e.currentTarget as HTMLElement; el.style.background = C.bg3; el.style.color = C.t0; }}
                    onMouseLeave={e => { const el = e.currentTarget as HTMLElement; el.style.background = "none"; el.style.color = C.t1; }}>
                    <span style={{ flex: 1 }}>{opt.label}</span>
                    <span style={{ fontSize: 10, color: C.t2, fontFamily: MONO }}>{opt.hint}</span>
                  </button>
                ))}
              </div>
            )}
          </div>
          <button onClick={onClose}
            style={{ ...tbtn, fontSize: 18, marginLeft: 4 }}
            onMouseEnter={e => (e.currentTarget as HTMLElement).style.color = C.t0}
            onMouseLeave={e => (e.currentTarget as HTMLElement).style.color = C.t2}>×</button>
        </div>
        <div style={{ flex: 1, overflowY: "auto", padding: "14px 16px" }}>
          {fc.diff ? (
            <>
              <DiffStats diff={fc.diff} />
              <div style={{ marginTop: 10 }}>
                <DiffView diff={fc.diff} maxHeight={9999} />
              </div>
            </>
          ) : fc.change_type === "deleted" ? (
            <div style={{ padding: "48px 0", textAlign: "center", color: C.t2, fontSize: 12, fontFamily: SANS }}>
              <div style={{ fontSize: 28, opacity: 0.06, marginBottom: 12 }}>🗑</div>
              File was deleted — no content to show.
            </div>
          ) : (
            <div style={{ padding: "48px 0", textAlign: "center", color: C.t2, fontSize: 12, fontFamily: SANS }}>
              <div style={{ fontSize: 28, opacity: 0.06, marginBottom: 12 }}>📄</div>
              No diff captured for this change.<br />
              Open the file in your editor to inspect it.
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ── DiffStats ─────────────────────────────────────────────────────────────────
function DiffStats({ diff }: { diff: string }) {
  let added = 0, removed = 0;
  diff.split("\n").forEach(line => {
    if (line.startsWith("+") && !line.startsWith("+++")) added++;
    if (line.startsWith("-") && !line.startsWith("---")) removed++;
  });
  const total  = added + removed;
  const greenN = total === 0 ? 0 : Math.round((added   / total) * 5);
  const redN   = total === 0 ? 0 : Math.round((removed / total) * 5);
  const greyN  = 5 - greenN - redN;

  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4 }}>
      <span style={{ fontSize: 12, fontWeight: 600, color: C.green,  fontFamily: MONO }}>+{added}</span>
      <span style={{ fontSize: 12, fontWeight: 600, color: C.red,    fontFamily: MONO }}>−{removed}</span>
      <div style={{ display: "flex", gap: 2 }}>
        {Array.from({ length: greenN }).map((_, i) => <span key={`g${i}`} style={{ display: "block", width: 9, height: 9, borderRadius: 2, background: C.green }} />)}
        {Array.from({ length: redN   }).map((_, i) => <span key={`r${i}`} style={{ display: "block", width: 9, height: 9, borderRadius: 2, background: C.red   }} />)}
        {Array.from({ length: greyN  }).map((_, i) => <span key={`n${i}`} style={{ display: "block", width: 9, height: 9, borderRadius: 2, background: C.t3   }} />)}
      </div>
    </div>
  );
}

// ── FileChangeList ────────────────────────────────────────────────────────────
function FileChangeList({ runboxId }: { runboxId: string }) {
  const [changes,  setChanges]  = useState<FileChange[]>([]);
  const [loading,  setLoading]  = useState(true);
  const [peeking,  setPeeking]  = useState<FileChange | null>(null);

  useEffect(() => {
    setLoading(true);
    invoke<FileChange[]>("db_file_changes_for_runbox", { runboxId })
      .then(setChanges)
      .catch(e => console.error("[db] file_changes:", e))
      .finally(() => setLoading(false));
  }, [runboxId]);

  if (loading)          return <Spinner />;
  if (!changes.length)  return <Empty text="No file changes recorded yet." />;

  const byPath = new Map<string, FileChange[]>();
  changes.forEach(fc => {
    if (!byPath.has(fc.file_path)) byPath.set(fc.file_path, []);
    byPath.get(fc.file_path)!.push(fc);
  });
  const groups = [...byPath.entries()]
    .sort((a, b) => Math.max(...b[1].map(x => x.timestamp)) - Math.max(...a[1].map(x => x.timestamp)));

  const typeColor: Record<string, string> = { created: C.green, modified: C.amber, deleted: C.red };

  return (
    <>
      {peeking && <CodePeekModal fc={peeking} onClose={() => setPeeking(null)} />}
      <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "0 2px 8px", borderBottom: `1px solid ${C.border}`, marginBottom: 4 }}>
          {(["created", "modified", "deleted"] as const).map(t => (
            <div key={t} style={{ display: "flex", alignItems: "center", gap: 4 }}>
              <span style={{ width: 7, height: 7, borderRadius: 2, background: typeColor[t], display: "block", flexShrink: 0 }} />
              <span style={{ fontSize: 10, color: C.t2, fontFamily: SANS, textTransform: "capitalize" }}>{t}</span>
            </div>
          ))}
          <span style={{ flex: 1 }} />
          <span style={{ fontSize: 10, color: C.t2, fontFamily: SANS }}>{groups.length} file{groups.length !== 1 ? "s" : ""}</span>
        </div>
        {groups.map(([filePath, fcs]) => {
          const latest   = fcs.sort((a, b) => b.timestamp - a.timestamp)[0];
          const cc       = typeColor[latest.change_type] ?? C.t2;
          const fileName = filePath.split(/[/\\]/).pop() ?? filePath;
          const dirPart  = filePath.slice(0, filePath.length - fileName.length);
          const hasDiff  = !!latest.diff;
          let added = 0, removed = 0;
          if (hasDiff) {
            latest.diff!.split("\n").forEach(l => {
              if (l.startsWith("+") && !l.startsWith("+++")) added++;
              if (l.startsWith("-") && !l.startsWith("---")) removed++;
            });
          }
          return (
            <div
              key={filePath}
              onClick={() => setPeeking(latest)}
              style={{ display: "flex", alignItems: "center", gap: 8, padding: "7px 10px", borderRadius: 8, cursor: "pointer", background: "transparent", border: `1px solid transparent`, transition: "all .12s", userSelect: "none" }}
              onMouseEnter={e => { const el = e.currentTarget as HTMLElement; el.style.background = C.bg3; el.style.borderColor = C.border; }}
              onMouseLeave={e => { const el = e.currentTarget as HTMLElement; el.style.background = "transparent"; el.style.borderColor = "transparent"; }}>
              <span style={{ width: 7, height: 7, borderRadius: 2, background: cc, flexShrink: 0 }} />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontFamily: MONO, fontSize: 12, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  <span style={{ color: C.t2, fontSize: 11 }}>{dirPart}</span>
                  <span style={{ color: C.t0, fontWeight: 500 }}>{fileName}</span>
                </div>
                <div style={{ display: "flex", alignItems: "center", gap: 6, marginTop: 2 }}>
                  <span style={{ fontSize: 10, color: C.t2, fontFamily: SANS }}>{reltime(latest.timestamp)}</span>
                  {fcs.length > 1 && <span style={{ fontSize: 10, color: C.t2, fontFamily: SANS }}>{fcs.length} changes</span>}
                </div>
              </div>
              {hasDiff && (
                <div style={{ display: "flex", alignItems: "center", gap: 5, flexShrink: 0 }}>
                  {added   > 0 && <span style={{ fontSize: 11, fontWeight: 600, color: C.green,  fontFamily: MONO }}>+{added}</span>}
                  {removed > 0 && <span style={{ fontSize: 11, fontWeight: 600, color: C.red,    fontFamily: MONO }}>−{removed}</span>}
                  <div style={{ display: "flex", gap: 1.5 }}>
                    {(() => {
                      const t = added + removed;
                      const g = t === 0 ? 0 : Math.round((added   / t) * 5);
                      const r = t === 0 ? 0 : Math.round((removed / t) * 5);
                      const n = 5 - g - r;
                      return [
                        ...Array.from({ length: g }).map((_, i) => <span key={`g${i}`} style={{ display: "block", width: 7, height: 7, borderRadius: 1.5, background: C.green  }} />),
                        ...Array.from({ length: r }).map((_, i) => <span key={`r${i}`} style={{ display: "block", width: 7, height: 7, borderRadius: 1.5, background: C.red    }} />),
                        ...Array.from({ length: n }).map((_, i) => <span key={`n${i}`} style={{ display: "block", width: 7, height: 7, borderRadius: 1.5, background: C.t3    }} />),
                      ];
                    })()}
                  </div>
                </div>
              )}
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke={C.t3} strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
                <polyline points="9 18 15 12 9 6"/>
              </svg>
            </div>
          );
        })}
      </div>
    </>
  );
}

// ── RunboxPickerModal ─────────────────────────────────────────────────────────
function RunboxPickerModal({ runboxes, currentId, picked, onConfirm, onClose }: {
  runboxes:  { id: string; name: string }[];
  currentId: string;
  picked:    string[];
  onConfirm: (ids: string[]) => void;
  onClose:   () => void;
}) {
  const [selected, setSelected] = useState<string[]>(picked);
  const toggle    = (id: string) => setSelected(p => p.includes(id) ? p.filter(x => x !== id) : [...p, id]);
  const selectAll = () => setSelected(runboxes.map(r => r.id));
  const clearAll  = () => setSelected([]);

  return (
    <div onClick={onClose} style={{ position: "fixed", inset: 0, zIndex: 3000, background: "rgba(0,0,0,.75)", backdropFilter: "blur(8px)", display: "flex", alignItems: "center", justifyContent: "center" }}>
      <div onClick={e => e.stopPropagation()} style={{ width: 340, background: C.bg2, border: `1px solid ${C.borderMd}`, borderRadius: 12, boxShadow: "0 32px 80px rgba(0,0,0,.9)", animation: "sbFadeUp .15s cubic-bezier(.2,1,.4,1)", overflow: "hidden", display: "flex", flexDirection: "column" }}>
        <div style={{ padding: "14px 16px 12px", borderBottom: `1px solid ${C.border}`, display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <span style={{ fontSize: 13, fontWeight: 600, color: C.t0, fontFamily: SANS }}>Select runboxes</span>
          <button onClick={onClose} style={{ ...tbtn, fontSize: 18 }}
            onMouseEnter={e => (e.currentTarget as HTMLElement).style.color = C.t0}
            onMouseLeave={e => (e.currentTarget as HTMLElement).style.color = C.t2}>×</button>
        </div>
        <div style={{ display: "flex", gap: 6, padding: "8px 14px", borderBottom: `1px solid ${C.border}` }}>
          <button onClick={selectAll} style={{ ...tbtn, fontSize: 11, color: C.blue, padding: "3px 8px", border: `1px solid rgba(88,166,255,.2)`, borderRadius: 5 }}>Select all</button>
          <button onClick={clearAll}  style={{ ...tbtn, fontSize: 11, color: C.t2,   padding: "3px 8px", border: `1px solid ${C.border}`,           borderRadius: 5 }}>Clear</button>
          <span style={{ flex: 1, textAlign: "right", fontSize: 11, color: C.t3, fontFamily: SANS, alignSelf: "center" }}>{selected.length} selected</span>
        </div>
        <div style={{ maxHeight: 260, overflowY: "auto", padding: "8px 10px", display: "flex", flexDirection: "column", gap: 4 }}>
          {runboxes.length === 0
            ? <div style={{ padding: "20px 0", textAlign: "center", fontSize: 12, color: C.t3, fontFamily: SANS }}>No other runboxes.</div>
            : runboxes.map(rb => {
              const checked   = selected.includes(rb.id);
              const isCurrent = rb.id === currentId;
              return (
                <div key={rb.id} onClick={() => toggle(rb.id)}
                  style={{ display: "flex", alignItems: "center", gap: 10, padding: "8px 10px", borderRadius: 7, cursor: "pointer", background: checked ? C.tealDim : "transparent", border: `1px solid ${checked ? C.tealBorder : C.border}`, transition: "all .12s" }}>
                  <div style={{ width: 15, height: 15, borderRadius: 4, flexShrink: 0, background: checked ? C.teal : "transparent", border: `1.5px solid ${checked ? C.teal : C.t2}`, display: "flex", alignItems: "center", justifyContent: "center", transition: "all .12s" }}>
                    {checked && <svg width="9" height="9" viewBox="0 0 10 10" fill="none"><polyline points="1.5,5 4,7.5 8.5,2.5" stroke={C.bg0} strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"/></svg>}
                  </div>
                  <span style={{ width: 6, height: 6, borderRadius: "50%", flexShrink: 0, background: C.green }} />
                  <span style={{ fontSize: 13, flex: 1, color: checked ? C.t0 : C.t1, fontFamily: SANS, fontWeight: checked ? 500 : 400 }}>{rb.name}</span>
                  {isCurrent && <span style={{ fontSize: 10, color: C.t3, fontFamily: SANS, background: C.bg3, borderRadius: 4, padding: "1px 6px" }}>current</span>}
                </div>
              );
            })}
        </div>
        <div style={{ padding: "10px 14px", borderTop: `1px solid ${C.border}`, display: "flex", gap: 8 }}>
          <button onClick={onClose} style={{ flex: 1, padding: "8px 0", background: "transparent", border: `1px solid ${C.border}`, borderRadius: 7, color: C.t2, fontSize: 12, cursor: "pointer", fontFamily: SANS }}>Cancel</button>
          <button onClick={() => { onConfirm(selected); onClose(); }} disabled={selected.length === 0}
            style={{ flex: 2, padding: "8px 0", background: selected.length === 0 ? C.bg4 : C.t0, border: "none", borderRadius: 7, color: selected.length === 0 ? C.t2 : C.bg0, fontSize: 12, fontWeight: 700, cursor: selected.length === 0 ? "default" : "pointer", fontFamily: SANS, transition: "background .12s" }}>
            {selected.length === 0 ? "Select runboxes" : `Confirm ${selected.length} runbox${selected.length !== 1 ? "es" : ""}`}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── MemoryCard ────────────────────────────────────────────────────────────────
function MemoryCard({ mem, onDelete, onPin }: {
  mem: Memory; onDelete: (id: string) => void; onPin: (id: string, pinned: boolean) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const short = mem.content.length > 160 && !expanded;
  const scopeColor: Record<string, string> = { "all runboxes": C.purple, "this runbox": C.t3 };

  return (
    <div style={{ background: mem.pinned ? C.tealDim : C.bg2, border: `1px solid ${mem.pinned ? C.tealBorder : C.border}`, borderRadius: 9, padding: "10px 12px", display: "flex", flexDirection: "column", gap: 6 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
        {mem._scope && (
          <span style={{ fontSize: 9, fontWeight: 700, letterSpacing: ".06em", color: scopeColor[mem._scope] ?? C.t3, background: `${scopeColor[mem._scope] ?? C.t3}18`, border: `1px solid ${scopeColor[mem._scope] ?? C.t3}33`, borderRadius: 3, padding: "1px 5px", fontFamily: SANS, textTransform: "uppercase", flexShrink: 0 }}>{mem._scope}</span>
        )}
        {mem.pinned && <span style={{ fontSize: 9, color: C.tealText, background: C.tealDim, border: `1px solid ${C.tealBorder}`, borderRadius: 3, padding: "1px 5px", letterSpacing: ".05em", fontFamily: SANS }}>PINNED</span>}
        <span style={{ flex: 1 }} />
        <span style={{ fontSize: 10, color: C.t3, fontFamily: SANS }}>{reltime(mem.timestamp)}</span>
      </div>
      <p style={{ margin: 0, fontSize: 12, color: C.t1, lineHeight: 1.65, fontFamily: MONO, whiteSpace: "pre-wrap", wordBreak: "break-word", maxHeight: short ? 80 : "none", overflow: "hidden" }}>
        {short ? mem.content.slice(0, 160) + "…" : mem.content}
      </p>
      {mem.content.length > 160 && (
        <button onClick={() => setExpanded(e => !e)} style={{ ...tbtn, color: C.tealText, fontSize: 11 }}>
          {expanded ? "Show less" : "Show more"}
        </button>
      )}
      <div style={{ display: "flex", gap: 4, marginTop: 2 }}>
        <button onClick={() => onPin(mem.id, !mem.pinned)} style={{ ...tbtn, color: mem.pinned ? C.tealText : C.t2 }}
          onMouseEnter={e => (e.currentTarget as HTMLElement).style.color = C.tealText}
          onMouseLeave={e => (e.currentTarget as HTMLElement).style.color = mem.pinned ? C.tealText : C.t2}>
          📌 {mem.pinned ? "Unpin" : "Pin"}
        </button>
        <span style={{ flex: 1 }} />
        <button onClick={() => onDelete(mem.id)} style={{ ...tbtn, color: C.t3 }}
          onMouseEnter={e => (e.currentTarget as HTMLElement).style.color = C.red}
          onMouseLeave={e => (e.currentTarget as HTMLElement).style.color = C.t3}>
          × Delete
        </button>
      </div>
    </div>
  );
}

// ── AddMemoryForm ─────────────────────────────────────────────────────────────
function AddMemoryForm({ runboxId, sessionId, runboxes, onAdded }: {
  runboxId: string; sessionId: string;
  runboxes: { id: string; name: string }[]; onAdded: () => void;
}) {
  const [open,       setOpen]       = useState(false);
  const [content,    setContent]    = useState("");
  const [scope,      setScope]      = useState<Scope>("this");
  const [pickedIds,  setPickedIds]  = useState<string[]>([]);
  const [showPicker, setShowPicker] = useState(false);
  const [loading,    setLoading]    = useState(false);
  const taRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => { if (open) setTimeout(() => taRef.current?.focus(), 30); }, [open]);

  const reset = () => { setOpen(false); setContent(""); setScope("this"); setPickedIds([]); };

  const submit = async () => {
    if (!content.trim() || (scope === "pick" && pickedIds.length === 0)) return;
    setLoading(true);
    try {
      const targets = scope === "all" ? ["__global__"] : scope === "pick" ? pickedIds : [runboxId];
      await Promise.all(targets.map(id => invoke("memory_add", { runboxId: id, sessionId, content: content.trim() })));
      reset(); onAdded();
    } catch (e) { console.error("[memory] add failed:", e); }
    finally { setLoading(false); }
  };

  if (!open) return (
    <button onClick={() => setOpen(true)}
      style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 7, width: "100%", padding: "9px 12px", background: C.tealDim, border: `1px solid ${C.tealBorder}`, borderRadius: 8, color: C.tealText, fontSize: 12, fontWeight: 600, cursor: "pointer", fontFamily: SANS, transition: "all .15s" }}
      onMouseEnter={e => { const el = e.currentTarget as HTMLElement; el.style.background = "rgba(63,182,139,.18)"; el.style.borderColor = "rgba(63,182,139,.4)"; }}
      onMouseLeave={e => { const el = e.currentTarget as HTMLElement; el.style.background = C.tealDim; el.style.borderColor = C.tealBorder; }}>
      <svg width="13" height="13" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
        <line x1="7" y1="1" x2="7" y2="13"/><line x1="1" y1="7" x2="13" y2="7"/>
      </svg>
      Add memory
    </button>
  );

  const scopeOpts: [Scope, string][] = [
    ["this", "This runbox"],
    ["all",  "All runboxes"],
    ["pick", pickedIds.length > 0 ? `${pickedIds.length} runbox${pickedIds.length !== 1 ? "es" : ""}` : "Select runboxes"],
  ];
  const disabled  = loading || !content.trim() || (scope === "pick" && pickedIds.length === 0);
  const saveLabel = loading ? "Saving…" : scope === "all" ? "Save to all runboxes" : scope === "pick" ? `Save to ${pickedIds.length} runbox${pickedIds.length !== 1 ? "es" : ""}` : "Save memory";

  return (
    <>
      {showPicker && (
        <RunboxPickerModal runboxes={runboxes} currentId={runboxId} picked={pickedIds}
          onConfirm={ids => { setPickedIds(ids); setScope("pick"); }}
          onClose={() => setShowPicker(false)} />
      )}
      <div style={{ background: C.bg2, border: `1px solid ${C.borderMd}`, borderRadius: 9, padding: 12, display: "flex", flexDirection: "column", gap: 10 }}>
        <textarea ref={taRef} value={content} onChange={e => setContent(e.target.value)}
          placeholder="What should be remembered…" rows={3}
          style={{ background: C.bg0, border: `1px solid ${C.border}`, borderRadius: 7, color: C.t0, fontSize: 12, padding: "8px 10px", resize: "vertical", fontFamily: MONO, outline: "none", lineHeight: 1.6, width: "100%", boxSizing: "border-box" }}
          onFocus={e => e.currentTarget.style.borderColor = C.borderHi}
          onBlur={e  => e.currentTarget.style.borderColor = C.border}
          onKeyDown={e => { if (e.key === "Escape") reset(); }} />
        <div>
          <div style={{ fontSize: 10, fontWeight: 600, color: C.t3, textTransform: "uppercase", letterSpacing: ".08em", marginBottom: 6, fontFamily: SANS }}>Save to</div>
          <div style={{ display: "flex", gap: 5 }}>
            {scopeOpts.map(([s, label]) => (
              <button key={s} onClick={() => { if (s === "pick") setShowPicker(true); else setScope(s); }}
                style={{ flex: 1, padding: "6px 4px", borderRadius: 6, fontSize: 11, cursor: "pointer", background: scope === s ? C.bg4 : "transparent", border: `1px solid ${scope === s ? C.borderHi : C.border}`, color: scope === s ? C.t0 : C.t2, fontFamily: SANS, fontWeight: scope === s ? 600 : 400, transition: "all .12s", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                {label}
              </button>
            ))}
          </div>
          {scope === "pick" && pickedIds.length > 0 && (
            <div style={{ display: "flex", flexWrap: "wrap", gap: 4, marginTop: 6 }}>
              {pickedIds.map(id => {
                const rb = runboxes.find(r => r.id === id); if (!rb) return null;
                return (
                  <span key={id} style={{ fontSize: 10, padding: "2px 7px", background: C.tealDim, border: `1px solid ${C.tealBorder}`, borderRadius: 20, color: C.tealText, fontFamily: SANS, display: "flex", alignItems: "center", gap: 4 }}>
                    {rb.name}
                    <span onClick={() => { const next = pickedIds.filter(x => x !== id); setPickedIds(next); if (next.length === 0) setScope("this"); }} style={{ cursor: "pointer", opacity: 0.6, fontSize: 12 }}>×</span>
                  </span>
                );
              })}
              <span onClick={() => setShowPicker(true)} style={{ fontSize: 10, padding: "2px 7px", border: `1px dashed ${C.border}`, borderRadius: 20, color: C.t2, cursor: "pointer", fontFamily: SANS }}>+ edit</span>
            </div>
          )}
        </div>
        <div style={{ display: "flex", gap: 6 }}>
          <button onClick={reset} style={{ ...tbtn, color: C.t2, padding: "6px 12px" }}>Cancel</button>
          <button onClick={submit} disabled={disabled}
            style={{ flex: 1, padding: "7px 0", background: disabled ? C.bg4 : C.t0, border: "none", borderRadius: 7, color: disabled ? C.t2 : C.bg0, fontSize: 12, fontWeight: 700, cursor: disabled ? "default" : "pointer", fontFamily: SANS, transition: "background .15s" }}>
            {saveLabel}
          </button>
        </div>
      </div>
    </>
  );
}

// ── SessionList ───────────────────────────────────────────────────────────────
function SessionList({ runboxId }: { runboxId: string }) {
  const [sessions, setSessions] = useState<DbSession[]>([]);
  const [loading,  setLoading]  = useState(true);

  useEffect(() => {
    setLoading(true);
    invoke<DbSession[]>("db_sessions_for_runbox", { runboxId })
      .then(setSessions)
      .catch(e => console.error("[db] sessions:", e))
      .finally(() => setLoading(false));
  }, [runboxId]);

  if (loading) return <Spinner />;
  if (!sessions.length) return <Empty text="No sessions recorded yet." />;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      {sessions.map(s => (
        <div key={s.id} style={{ background: C.bg2, border: `1px solid ${C.border}`, borderRadius: 9, padding: "9px 12px", display: "flex", flexDirection: "column", gap: 4 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <span style={{ width: 5, height: 5, borderRadius: "50%", flexShrink: 0, background: s.ended_at ? C.t3 : C.green, boxShadow: s.ended_at ? "none" : `0 0 4px ${C.green}` }} />
            <span style={{ fontSize: 10, color: C.t2, fontFamily: MONO, flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{s.pane_id} · {s.cwd}</span>
            <span style={{ fontSize: 10, color: C.t3, flexShrink: 0, fontFamily: SANS }}>{reltime(s.started_at)}</span>
          </div>
          {s.ended_at && <span style={{ fontSize: 10, color: C.t3, fontFamily: SANS }}>ended {reltime(s.ended_at)} · exit {s.exit_code ?? "?"}</span>}
        </div>
      ))}
    </div>
  );
}

// ── Atoms ─────────────────────────────────────────────────────────────────────
function Spinner() {
  return (
    <div style={{ padding: "28px 0", display: "flex", justifyContent: "center" }}>
      <div style={{ width: 18, height: 18, borderRadius: "50%", border: `2px solid ${C.border}`, borderTopColor: C.teal, animation: "spin .7s linear infinite" }} />
    </div>
  );
}
function Empty({ text }: { text: string }) {
  return <div style={{ padding: "28px 14px", textAlign: "center", fontSize: 12, color: C.t2, fontFamily: SANS }}>{text}</div>;
}

// ── MemoryPanel ───────────────────────────────────────────────────────────────
export default function MemoryPanel({ runboxId, runboxName, runboxes, onClose }: {
  runboxId:   string;
  runboxName: string;
  runboxes:   { id: string; name: string }[];
  onClose:    () => void;
}) {
  const [tab,      setTab]      = useState<Tab>("memories");
  const [memories, setMemories] = useState<Memory[]>([]);
  const [loading,  setLoading]  = useState(true);
  const [error,    setError]    = useState<string | null>(null);

  const manualSessionId = `manual-${runboxId}`;

  const loadMemories = useCallback(() => {
    setLoading(true); setError(null);
    Promise.all([
      invoke<Memory[]>("memory_list", { runboxId }),
      invoke<Memory[]>("memory_list", { runboxId: "__global__" }),
    ])
      .then(([mine, global]) => {
        const all: Memory[] = [
          ...global.map(m => ({ ...m, _scope: "all runboxes" })),
          ...mine.map(m => ({ ...m, _scope: "this runbox" })),
        ].sort((a, b) => { if (a.pinned !== b.pinned) return a.pinned ? -1 : 1; return b.timestamp - a.timestamp; });
        setMemories(all);
      })
      .catch(e => setError(String(e)))
      .finally(() => setLoading(false));
  }, [runboxId]);

  useEffect(() => { loadMemories(); }, [loadMemories]);

  // ── ADDED: auto-refresh when the pipeline saves a new memory ─────────────
  // memory_pipeline.rs emits "memory-added" after every Claude extraction.
  // No polling needed — this fires instantly when a new learning is saved.
  useEffect(() => {
    const unsub = listen<{ runbox_id: string }>("memory-added", ({ payload }) => {
      if (payload.runbox_id === runboxId || payload.runbox_id === "__global__") {
        loadMemories();
      }
    });
    return () => { unsub.then(f => f()); };
  }, [runboxId, loadMemories]);
  // ─────────────────────────────────────────────────────────────────────────

  const handleDelete = useCallback(async (id: string) => {
    try { await invoke("memory_delete", { id }); setMemories(p => p.filter(m => m.id !== id)); }
    catch (e) { console.error("[memory] delete:", e); }
  }, []);

  const handlePin = useCallback(async (id: string, pinned: boolean) => {
    try {
      await invoke("memory_pin", { id, pinned });
      setMemories(p => {
        const u = p.map(m => m.id === id ? { ...m, pinned } : m);
        return [...u].sort((a, b) => { if (a.pinned !== b.pinned) return a.pinned ? -1 : 1; return b.timestamp - a.timestamp; });
      });
    } catch (e) { console.error("[memory] pin:", e); }
  }, []);

  const tabStyle = (t: Tab): React.CSSProperties => ({
    flex: 1, padding: "7px 0", background: "none", border: "none",
    borderBottom: `2px solid ${tab === t ? C.teal : "transparent"}`,
    color: tab === t ? C.t0 : C.t2,
    fontSize: 11, fontWeight: tab === t ? 600 : 400,
    cursor: "pointer", fontFamily: SANS,
    letterSpacing: ".04em", textTransform: "uppercase", transition: "color .15s",
  });

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", background: C.bg1 }}>
      <div style={{ padding: "11px 14px 0", flexShrink: 0, borderBottom: `1px solid ${C.border}` }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 10 }}>
          <span style={{ fontSize: 13, fontWeight: 600, color: C.t0, flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontFamily: SANS }}>{runboxName}</span>
          <button onClick={onClose} style={{ ...tbtn, fontSize: 16 }}
            onMouseEnter={e => (e.currentTarget as HTMLElement).style.color = C.t0}
            onMouseLeave={e => (e.currentTarget as HTMLElement).style.color = C.t2}>×</button>
        </div>
        <div style={{ display: "flex" }}>
          <button style={tabStyle("memories")} onClick={() => setTab("memories")}>Memories</button>
          <button style={tabStyle("sessions")} onClick={() => setTab("sessions")}>Sessions</button>
          <button style={tabStyle("files")}    onClick={() => setTab("files")}>Files</button>
        </div>
      </div>
      <div style={{ flex: 1, overflowY: "auto", padding: "12px 12px 16px" }}>
        {tab === "memories" && (
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            <AddMemoryForm runboxId={runboxId} sessionId={manualSessionId} runboxes={runboxes} onAdded={loadMemories} />
            {loading && <Spinner />}
            {!loading && error && <div style={{ fontSize: 12, color: C.red, padding: "8px 0", fontFamily: SANS }}>{error}</div>}
            {!loading && !error && memories.length === 0 && <Empty text="No memories yet. Add one above." />}
            {!loading && memories.map(m => <MemoryCard key={m.id} mem={m} onDelete={handleDelete} onPin={handlePin} />)}
          </div>
        )}
        {tab === "sessions" && <SessionList runboxId={runboxId} />}
        {tab === "files"    && <FileChangeList runboxId={runboxId} />}
      </div>
      <style>{`
        @keyframes spin    { to { transform: rotate(360deg); } }
        @keyframes sbFadeUp { from{opacity:0;transform:translateY(6px) scale(.98)} to{opacity:1;transform:translateY(0) scale(1)} }
      `}</style>
    </div>
  );
}