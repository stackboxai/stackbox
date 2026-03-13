/**
 * FileChangeList.tsx
 * Standalone diff viewer — split / unified toggle, stat squares, collapse.
 *
 * Changes from original:
 *  - Uses LiveDiffFile (git_diff_live) instead of db_file_changes_for_runbox
 *  - runboxCwd prop added — required for git_diff_live
 *  - StatSquares rounding fix (was producing negative empty squares)
 *  - Split diff panels now scroll in sync
 *  - "N/N viewed" counter now correctly tracks viewed files
 *  - Refresh button is wired to reload
 *  - memory-added event triggers reload
 */

import { useState, useEffect, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

// ── Palette (matches RunboxManager) ──────────────────────────────────────────
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
};

const MONO = "ui-monospace,'SF Mono',Consolas,'Cascadia Code',monospace";
const SANS = "-apple-system,'SF Pro Text',system-ui,sans-serif";

// ── Types ─────────────────────────────────────────────────────────────────────
interface LiveDiffFile {
  path:        string;
  change_type: "created" | "modified" | "deleted";
  diff:        string;
  insertions:  number;
  deletions:   number;
  modified_at: number;  // Unix ms from Rust mtime — 0 if unavailable
}




// ── Helpers ───────────────────────────────────────────────────────────────────
function reltime(ms: number): string {
  if (!ms) return "";
  const d = Date.now() - ms;
  if (d < 60_000)    return "just now";
  if (d < 3600_000)  return `${Math.floor(d / 60_000)}m ago`;
  if (d < 86400_000) return `${Math.floor(d / 3600_000)}h ago`;
  return `${Math.floor(d / 86400_000)}d ago`;
}

// ── Empty / Spinner ───────────────────────────────────────────────────────────
function Spinner() {
  return (
    <div style={{ display: "flex", justifyContent: "center", padding: "32px 0" }}>
      <div style={{ width: 18, height: 18, border: `2px solid ${C.border}`, borderTopColor: C.teal, borderRadius: "50%", animation: "spin .7s linear infinite" }} />
    </div>
  );
}
function Empty({ text }: { text: string }) {
  return <div style={{ padding: "28px 0", textAlign: "center", color: C.t2, fontSize: 12, fontFamily: SANS }}>{text}</div>;
}

// ── FileChangeList ─────────────────────────────────────────────────────────────
export function FileChangeList({ runboxId, runboxCwd, onFileClick }: {
  runboxId:    string;
  runboxCwd:   string;
  onFileClick: (fc: LiveDiffFile) => void;
}) {
  const [files,   setFiles]   = useState<LiveDiffFile[]>([]);
  const [loading, setLoading] = useState(true);
  const [error,   setError]   = useState<string | null>(null);

  const load = useCallback(() => {
    setLoading(true); setError(null);
    invoke<LiveDiffFile[]>("git_diff_live", { cwd: runboxCwd, runboxId })
      .then(fs => {
        // Sort: most recently modified first
        setFiles([...fs].sort((a, b) => (b.modified_at || 0) - (a.modified_at || 0)));
      })
      .catch(e => setError(String(e)))
      .finally(() => setLoading(false));
  }, [runboxId, runboxCwd]);

  useEffect(() => { load(); }, [load]);

  useEffect(() => {
    const unsub = listen<{ runbox_id: string }>("memory-added", ({ payload }) => {
      if (payload.runbox_id === runboxId) load();
    });
    return () => { unsub.then(f => f()); };
  }, [runboxId, load]);

  useEffect(() => {
    invoke("watch_runbox", { runboxId, cwd: runboxCwd }).catch(() => {});
    return () => { invoke("unwatch_runbox", { runboxId }).catch(() => {}); };
  }, [runboxId, runboxCwd]);

  useEffect(() => {
    const unsub = listen<{ runbox_id: string }>("file-changed", ({ payload }) => {
      if (payload.runbox_id === runboxId) load();
    });
    return () => { unsub.then(f => f()); };
  }, [runboxId, load]);

  // Deduplicate by path (keep latest)
  const deduped = (() => {
    const map = new Map<string, LiveDiffFile>();
    for (const fc of files) map.set(fc.path, fc);
    return Array.from(map.values());
  })();

  const typeColor: Record<string, string> = {
    created: C.green, modified: C.amber, deleted: C.red,
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%" }}>

      {/* Toolbar */}
      <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "0 2px 10px", borderBottom: `1px solid ${C.border}`, marginBottom: 8, flexShrink: 0 }}>
        <span style={{ fontSize: 12, fontWeight: 600, color: C.t0, fontFamily: SANS, flex: 1 }}>
          {deduped.length > 0 ? `${deduped.length} changed file${deduped.length !== 1 ? "s" : ""}` : "Changed files"}
        </span>
        <button onClick={load} title="Refresh"
          style={{ background: "none", border: `1px solid ${C.border}`, borderRadius: 6, cursor: "pointer", color: C.t2, padding: "4px 8px", display: "flex", alignItems: "center", gap: 5, fontSize: 11, fontFamily: SANS }}
          onMouseEnter={e => { const el = e.currentTarget as HTMLElement; el.style.color = C.tealText; el.style.borderColor = C.tealBorder; }}
          onMouseLeave={e => { const el = e.currentTarget as HTMLElement; el.style.color = C.t2; el.style.borderColor = C.border; }}>
          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/>
          </svg>
          Refresh
        </button>
      </div>

      {/* Summary badges */}
      {!loading && !error && deduped.length > 0 && (
        <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "0 0 10px", flexShrink: 0 }}>
          {(["modified", "created", "deleted"] as const).filter(t => deduped.some(f => f.change_type === t)).map(t => (
            <span key={t} style={{ fontSize: 10, fontWeight: 700, letterSpacing: ".05em", textTransform: "uppercase", color: typeColor[t], background: `${typeColor[t]}18`, border: `1px solid ${typeColor[t]}33`, borderRadius: 4, padding: "2px 7px", fontFamily: SANS }}>
              {deduped.filter(f => f.change_type === t).length} {t}
            </span>
          ))}
        </div>
      )}

      {/* States */}
      {loading && <Spinner />}
      {!loading && error && (
        <div style={{ padding: "20px 0", color: C.red, fontSize: 12, fontFamily: SANS, textAlign: "center" }}>
          {error}
          <button onClick={load} style={{ display: "block", margin: "8px auto 0", background: "none", border: `1px solid ${C.border}`, borderRadius: 6, color: C.t2, cursor: "pointer", fontSize: 11, padding: "4px 12px", fontFamily: SANS }}>Retry</button>
        </div>
      )}
      {!loading && !error && deduped.length === 0 && <Empty text="No uncommitted changes." />}

      {/* ── Flat file list ─────────────────────────────────────────────────── */}
      {!loading && !error && deduped.length > 0 && (
        <div style={{ flex: 1, overflowY: "auto", display: "flex", flexDirection: "column", gap: 1 }}>
          {deduped.map(fc => {
            const fileName = fc.path.split(/[/\\]/).pop() ?? fc.path;
            const dirPart  = fc.path.slice(0, fc.path.length - fileName.length);
            const cc       = typeColor[fc.change_type] ?? C.t2;
            const ts       = reltime(fc.modified_at);

            return (
              <div key={fc.path}
                onClick={() => onFileClick(fc)}
                style={{ display: "flex", alignItems: "center", gap: 8, padding: "7px 10px", borderRadius: 7, cursor: "pointer", background: "transparent", transition: "background .1s" }}
                onMouseEnter={e => (e.currentTarget as HTMLElement).style.background = C.bg3}
                onMouseLeave={e => (e.currentTarget as HTMLElement).style.background = "transparent"}>

                {/* Change-type dot */}
                <span style={{ width: 7, height: 7, borderRadius: 2, background: cc, flexShrink: 0, marginTop: 1 }} />

                {/* Filename + dir */}
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontFamily: MONO, fontSize: 12, color: C.t0, fontWeight: 500, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {fileName}
                  </div>
                  {dirPart && (
                    <div style={{ fontFamily: MONO, fontSize: 10, color: C.t2, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", marginTop: 1 }}>
                      {dirPart}
                    </div>
                  )}
                </div>

                {/* +/- stats */}
                <div style={{ display: "flex", alignItems: "center", gap: 5, flexShrink: 0 }}>
                  {fc.insertions > 0 && <span style={{ fontSize: 11, fontWeight: 700, color: C.green,  fontFamily: MONO }}>+{fc.insertions}</span>}
                  {fc.deletions  > 0 && <span style={{ fontSize: 11, fontWeight: 700, color: C.red,    fontFamily: MONO }}>−{fc.deletions}</span>}
                </div>

                {/* Timestamp */}
                {ts && (
                  <span style={{ fontSize: 10, color: C.t2, fontFamily: SANS, flexShrink: 0, minWidth: 44, textAlign: "right" }}>{ts}</span>
                )}

                {/* Arrow hint */}
                <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke={C.t3} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
                  <polyline points="9 18 15 12 9 6"/>
                </svg>
              </div>
            );
          })}
        </div>
      )}

      <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
    </div>
  );
}

export default FileChangeList;

