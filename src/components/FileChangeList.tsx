import { useState, useEffect, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

const C = {
  bg:       "#0d1117",
  bgFile:   "#161b22",
  bgRem:    "rgba(255,63,63,.1)",
  bgAdd:    "rgba(63,185,80,.1)",
  bgRemNum: "rgba(255,63,63,.06)",
  bgAddNum: "rgba(63,185,80,.06)",
  border:   "rgba(255,255,255,.08)",
  numCol:   "#444c56",
  ctxText:  "#8b949e",
  remText:  "#ffa198",
  addText:  "#7ee787",
  green:    "#3fb950",
  red:      "#f85149",
  amber:    "#e3b341",
  blue:     "#58a6ff",
  t0:       "#e6edf3",
  t1:       "#8b949e",
  t2:       "#484f58",
  t3:       "#2d333b",
  teal:     "#39d353",
  hunk:     "rgba(88,166,255,.1)",
  hunkText: "#58a6ff",
};

const MONO = "'JetBrains Mono','Fira Code',ui-monospace,monospace";
const SANS = "-apple-system,'SF Pro Text',system-ui,sans-serif";

export interface FileChange {
  id:          number;
  session_id:  string;
  runbox_id:   string;
  file_path:   string;
  change_type: "created" | "modified" | "deleted";
  diff:        string | null;
  timestamp:   number;
}

function diffStats(diff: string) {
  let add = 0, rem = 0;
  for (const l of diff.split("\n")) {
    if (l.startsWith("+") && !l.startsWith("+++")) add++;
    if (l.startsWith("-") && !l.startsWith("---")) rem++;
  }
  return { add, rem };
}

type LineKind = "add" | "remove" | "hunk" | "meta" | "ctx";
interface DLine {
  text: string;
  kind: LineKind;
  oldN: number | null;
  newN: number | null;
}

function parseDiff(diff: string): DLine[] {
  let o = 0, n = 0;
  const out: DLine[] = [];
  for (const raw of diff.split("\n")) {
    if (
      raw.startsWith("+++") || raw.startsWith("---") ||
      raw.startsWith("diff ") || raw.startsWith("index ") ||
      raw.startsWith("new file") || raw.startsWith("deleted file")
    ) {
      out.push({ text: raw, kind: "meta", oldN: null, newN: null });
    } else if (raw.startsWith("@@")) {
      const m = raw.match(/@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
      if (m) { o = +m[1] - 1; n = +m[2] - 1; }
      out.push({ text: raw, kind: "hunk", oldN: null, newN: null });
    } else if (raw.startsWith("+")) {
      n++;
      out.push({ text: raw.slice(1), kind: "add", oldN: null, newN: n });
    } else if (raw.startsWith("-")) {
      o++;
      out.push({ text: raw.slice(1), kind: "remove", oldN: o, newN: null });
    } else {
      o++; n++;
      out.push({ text: raw.startsWith(" ") ? raw.slice(1) : raw, kind: "ctx", oldN: o, newN: n });
    }
  }
  return out;
}

function SplitDiff({ diff }: { diff: string }) {
  const lines = parseDiff(diff);

  type Pair =
    | { kind: "hunk";   text: string }
    | { kind: "change"; left: DLine; right: DLine }
    | { kind: "remove"; left: DLine; right: null }
    | { kind: "add";    left: null;  right: DLine }
    | { kind: "ctx";    left: DLine; right: DLine };

  const pairs: Pair[] = [];
  let i = 0;
  while (i < lines.length) {
    const row = lines[i];
    if (row.kind === "meta") { i++; continue; }
    if (row.kind === "hunk") {
      pairs.push({ kind: "hunk", text: row.text }); i++;
    } else if (row.kind === "remove") {
      const next = lines[i + 1];
      if (next?.kind === "add") {
        pairs.push({ kind: "change", left: row, right: next }); i += 2;
      } else {
        pairs.push({ kind: "remove", left: row, right: null }); i++;
      }
    } else if (row.kind === "add") {
      pairs.push({ kind: "add", left: null, right: row }); i++;
    } else {
      pairs.push({ kind: "ctx", left: row, right: row }); i++;
    }
  }

  const numTd = (n: number | null, active: boolean, side: "left" | "right") => (
    <td style={{
      textAlign:     "right",
      padding:       "0 10px 0 6px",
      width:         42,
      minWidth:      42,
      fontSize:      12,
      fontFamily:    MONO,
      userSelect:    "none",
      lineHeight:    "20px",
      verticalAlign: "top",
      color:
        active && side === "left"  ? "rgba(255,100,100,.5)" :
        active && side === "right" ? "rgba(63,185,80,.5)"   : C.numCol,
      background:
        active && side === "left"  ? C.bgRemNum :
        active && side === "right" ? C.bgAddNum : "transparent",
    }}>{n ?? ""}</td>
  );

  const codeTd = (text: string, active: boolean, side: "left" | "right") => (
    <td style={{
      paddingLeft:   12,
      paddingRight:  16,
      fontSize:      12.5,
      fontFamily:    MONO,
      whiteSpace:    "pre",
      verticalAlign: "top",
      lineHeight:    "20px",
      color:
        active && side === "left"  ? C.remText :
        active && side === "right" ? C.addText : C.ctxText,
      background:
        active && side === "left"  ? C.bgRem :
        active && side === "right" ? C.bgAdd : "transparent",
    }}>{text || " "}</td>
  );

  const hunkTd = (text: string, colSpan: number) => (
    <td colSpan={colSpan} style={{
      padding:    "2px 12px",
      background: C.hunk,
      color:      C.hunkText,
      fontSize:   11,
      fontFamily: MONO,
      fontStyle:  "italic",
      lineHeight: "20px",
    }}>{text}</td>
  );

  const emptyTd = (side: "left" | "right") => {
    const bg = side === "left"
      ? "rgba(63,185,80,.03)"
      : "rgba(255,63,63,.03)";
    return (
      <>
        <td style={{ background: bg, width: 42, minWidth: 42 }} />
        <td style={{ background: bg }} />
      </>
    );
  };

  return (
    <div style={{ display: "grid", gridTemplateColumns: "1fr 1px 1fr", borderTop: `1px solid ${C.border}` }}>
      <div style={{ overflowX: "auto", minWidth: 0 }}>
        <table style={{ borderCollapse: "collapse", width: "100%" }}>
          <colgroup><col style={{ width: 42 }} /><col /></colgroup>
          <tbody>
            {pairs.map((p, idx) => {
              if (p.kind === "hunk") return <tr key={idx}>{hunkTd(p.text, 2)}</tr>;
              const isRem = p.kind === "remove" || p.kind === "change";
              const row   = p.left;
              if (!row) return <tr key={idx}>{emptyTd("left")}</tr>;
              return <tr key={idx}>{numTd(row.oldN, isRem, "left")}{codeTd(row.text, isRem, "left")}</tr>;
            })}
          </tbody>
        </table>
      </div>

      <div style={{ background: C.border }} />

      <div style={{ overflowX: "auto", minWidth: 0 }}>
        <table style={{ borderCollapse: "collapse", width: "100%" }}>
          <colgroup><col style={{ width: 42 }} /><col /></colgroup>
          <tbody>
            {pairs.map((p, idx) => {
              if (p.kind === "hunk") return <tr key={idx}>{hunkTd(p.text, 2)}</tr>;
              const isAdd = p.kind === "add" || p.kind === "change";
              const row   = p.right;
              if (!row) return <tr key={idx}>{emptyTd("right")}</tr>;
              return <tr key={idx}>{numTd(row.newN, isAdd, "right")}{codeTd(row.text, isAdd, "right")}</tr>;
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function UnifiedDiff({ diff }: { diff: string }) {
  const lines = parseDiff(diff);
  return (
    <table style={{ borderCollapse: "collapse", width: "100%", fontFamily: MONO, fontSize: 12.5, lineHeight: "20px", borderTop: `1px solid ${C.border}` }}>
      <colgroup>
        <col style={{ width: 42 }} />
        <col style={{ width: 42 }} />
        <col />
      </colgroup>
      <tbody>
        {lines.map((row, i) => {
          if (row.kind === "meta") return null;
          if (row.kind === "hunk") return (
            <tr key={i}>
              <td colSpan={3} style={{ padding: "2px 12px", background: C.hunk, color: C.hunkText, fontSize: 11, fontStyle: "italic" }}>{row.text}</td>
            </tr>
          );
          const isAdd = row.kind === "add";
          const isRem = row.kind === "remove";
          return (
            <tr key={i}>
              <td style={{ textAlign: "right", padding: "0 10px 0 6px", color: isRem ? "rgba(255,100,100,.5)" : C.numCol, background: isRem ? C.bgRemNum : "transparent", fontSize: 12, userSelect: "none", verticalAlign: "top", lineHeight: "20px" }}>{row.oldN ?? ""}</td>
              <td style={{ textAlign: "right", padding: "0 10px 0 6px", color: isAdd ? "rgba(63,185,80,.5)"   : C.numCol, background: isAdd ? C.bgAddNum : "transparent", fontSize: 12, userSelect: "none", verticalAlign: "top", lineHeight: "20px" }}>{row.newN ?? ""}</td>
              <td style={{ paddingLeft: 12, paddingRight: 20, color: isAdd ? C.addText : isRem ? C.remText : C.ctxText, background: isAdd ? C.bgAdd : isRem ? C.bgRem : "transparent", whiteSpace: "pre", verticalAlign: "top", lineHeight: "20px" }}>{row.text || " "}</td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

function StatSquares({ diff }: { diff: string }) {
  const { add, rem } = diffStats(diff);
  const t = add + rem;
  const g = t === 0 ? 0 : Math.round((add / t) * 5);
  const r = t === 0 ? 0 : Math.round((rem / t) * 5);
  const e = 5 - g - r;
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 5, flexShrink: 0 }}>
      <span style={{ fontFamily: MONO, fontSize: 11, color: C.green }}>+{add}</span>
      <span style={{ fontFamily: MONO, fontSize: 11, color: C.red }}>−{rem}</span>
      <div style={{ display: "flex", gap: 2 }}>
        {Array.from({ length: g }).map((_, i) => <span key={`g${i}`} style={{ display: "block", width: 8, height: 8, borderRadius: 2, background: C.green }} />)}
        {Array.from({ length: r }).map((_, i) => <span key={`r${i}`} style={{ display: "block", width: 8, height: 8, borderRadius: 2, background: C.red }} />)}
        {Array.from({ length: e }).map((_, i) => <span key={`e${i}`} style={{ display: "block", width: 8, height: 8, borderRadius: 2, background: C.t3 }} />)}
      </div>
    </div>
  );
}

function FileBlock({ fc, splitView }: { fc: FileChange; splitView: boolean }) {
  const [open,   setOpen]   = useState(true);
  const [viewed, setViewed] = useState(false);

  const typeCol = fc.change_type === "created" ? C.green
                : fc.change_type === "deleted" ? C.red
                : C.amber;

  return (
    <div style={{ border: `1px solid ${C.border}`, borderRadius: 6, overflow: "hidden", marginBottom: 10 }}>
      <div
        onClick={() => setOpen(o => !o)}
        style={{ display: "flex", alignItems: "center", gap: 8, padding: "6px 12px", background: C.bgFile, cursor: "pointer", userSelect: "none", borderBottom: open ? `1px solid ${C.border}` : "none" }}
      >
        <svg width="12" height="12" viewBox="0 0 16 16" style={{ flexShrink: 0, transition: "transform .15s", transform: open ? "rotate(90deg)" : "rotate(0deg)" }}>
          <path d="M6 4l4 4-4 4" stroke={C.t2} strokeWidth="1.5" fill="none" strokeLinecap="round" strokeLinejoin="round" />
        </svg>

        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke={typeCol} strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
          <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
          <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" />
        </svg>

        <span style={{ fontFamily: MONO, fontSize: 12, color: C.t0, flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {fc.file_path}
        </span>

        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke={C.t2} strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
          <polyline points="23 4 23 10 17 10" /><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10" />
        </svg>

        {fc.diff && <StatSquares diff={fc.diff} />}

        <label onClick={e => e.stopPropagation()} style={{ display: "flex", alignItems: "center", gap: 5, cursor: "pointer", flexShrink: 0 }}>
          <input
            type="checkbox"
            checked={viewed}
            onChange={e => setViewed(e.target.checked)}
            style={{ accentColor: C.teal, width: 12, height: 12, cursor: "pointer" }}
          />
          <span style={{ fontFamily: SANS, fontSize: 11, color: C.t2, userSelect: "none" }}>Viewed</span>
        </label>
      </div>

      {open && fc.diff && (
        splitView
          ? <SplitDiff diff={fc.diff} />
          : <UnifiedDiff diff={fc.diff} />
      )}

      {open && !fc.diff && (
        <div style={{ padding: "20px 16px", textAlign: "center", color: C.t2, fontFamily: SANS, fontSize: 12 }}>
          {fc.change_type === "deleted" ? "File deleted — no content to show." : "No diff captured."}
        </div>
      )}
    </div>
  );
}

export function FileChangeList({ runboxId }: { runboxId: string }) {
  const [changes,   setChanges]   = useState<FileChange[]>([]);
  const [loading,   setLoading]   = useState(true);
  const [splitView, setSplitView] = useState(true);

  const load = useCallback(() => {
    invoke<FileChange[]>("db_file_changes_for_runbox", { runboxId })
      .then(rows => setChanges(rows.sort((a, b) => b.timestamp - a.timestamp)))
      .catch(e => console.error("[watcher]", e))
      .finally(() => setLoading(false));
  }, [runboxId]);

  useEffect(() => { setLoading(true); load(); }, [load]);

  useEffect(() => {
    const unsub = listen<{ runbox_id: string }>("file-changed", ({ payload }) => {
      if (payload.runbox_id === runboxId) load();
    });
    return () => { unsub.then(f => f()); };
  }, [runboxId, load]);

  const byPath = new Map<string, FileChange>();
  for (const fc of changes) {
    if (!byPath.has(fc.file_path)) byPath.set(fc.file_path, fc);
  }
  const deduped = [...byPath.values()];

  const totalAdd = deduped.reduce((s, f) => s + (f.diff ? diffStats(f.diff).add : 0), 0);
  const totalRem = deduped.reduce((s, f) => s + (f.diff ? diffStats(f.diff).rem : 0), 0);

  if (loading) return (
    <div style={{ display: "flex", alignItems: "center", justifyContent: "center", height: "100%", background: C.bg }}>
      <style>{`@keyframes spin{to{transform:rotate(360deg)}}`}</style>
      <div style={{ width: 16, height: 16, borderRadius: "50%", border: `2px solid ${C.border}`, borderTopColor: C.teal, animation: "spin .7s linear infinite" }} />
    </div>
  );

  if (deduped.length === 0) return (
    <div style={{ display: "flex", alignItems: "center", justifyContent: "center", height: "100%", background: C.bg }}>
      <span style={{ fontFamily: SANS, fontSize: 11, color: C.t2 }}>No file changes yet</span>
    </div>
  );

  return (
    <div style={{ height: "100%", background: C.bg, display: "flex", flexDirection: "column", overflow: "hidden" }}>
      <style>{`
        @keyframes spin { to { transform: rotate(360deg) } }
        * { box-sizing: border-box; }
        ::-webkit-scrollbar { width: 5px; height: 5px; }
        ::-webkit-scrollbar-track { background: transparent; }
        ::-webkit-scrollbar-thumb { background: #2d333b; border-radius: 4px; }
        ::-webkit-scrollbar-thumb:hover { background: #3d4451; }
      `}</style>

      <div style={{ height: 36, display: "flex", alignItems: "center", gap: 8, padding: "0 14px", borderBottom: `1px solid ${C.border}`, background: C.bgFile, flexShrink: 0 }}>
        <span style={{ fontFamily: SANS, fontSize: 12, color: C.t1 }}>
          <span style={{ color: C.t2 }}>0/</span>{deduped.length} viewed
        </span>
        <span style={{ color: C.t3 }}>·</span>
        <span style={{ fontFamily: SANS, fontSize: 12, color: C.t1 }}>{deduped.length} file{deduped.length !== 1 ? "s" : ""}</span>
        <span style={{ fontFamily: MONO, fontSize: 12, color: C.green, fontWeight: 600 }}>+{totalAdd}</span>
        <span style={{ fontFamily: MONO, fontSize: 12, color: C.red, fontWeight: 600 }}>−{totalRem}</span>

        <span style={{ flex: 1 }} />

        <button
          onClick={() => setSplitView(false)}
          title="Unified view"
          style={{ background: "none", border: "none", cursor: "pointer", padding: 4, display: "flex", alignItems: "center", opacity: !splitView ? 1 : 0.35, transition: "opacity .1s" }}
        >
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke={C.t1} strokeWidth="1.5" strokeLinecap="round">
            <rect x="2" y="2" width="12" height="12" rx="2" />
            <line x1="5" y1="5" x2="11" y2="5" />
            <line x1="5" y1="8" x2="11" y2="8" />
            <line x1="5" y1="11" x2="11" y2="11" />
          </svg>
        </button>

        <button
          onClick={() => setSplitView(true)}
          title="Split view"
          style={{ background: "none", border: "none", cursor: "pointer", padding: 4, display: "flex", alignItems: "center", opacity: splitView ? 1 : 0.35, transition: "opacity .1s" }}
        >
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke={C.t1} strokeWidth="1.5" strokeLinecap="round">
            <rect x="2" y="2" width="12" height="12" rx="2" />
            <line x1="8" y1="2" x2="8" y2="14" />
          </svg>
        </button>
      </div>

      <div style={{ flex: 1, overflowY: "auto", padding: "12px 0" }}>
        {deduped.map(fc => (
          <FileBlock key={fc.file_path} fc={fc} splitView={splitView} />
        ))}
      </div>
    </div>
  );
}

export default FileChangeList;