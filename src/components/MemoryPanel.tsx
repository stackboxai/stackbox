/**
 * MemoryPanel.tsx
 * Memories · Events
 *
 * Changes from previous version:
 *  - Removed Files tab (now a standalone panel in RunboxManager toolbar)
 *  - Removed Sessions tab (Events already covers session_start/session_end)
 *  - Removed DbSession interface and SessionList component
 *  - Removed LiveDiffFile interface and FileChangeList import
 *  - Removed runboxCwd prop (no longer needed)
 *  - Tab type simplified to "memories" | "events"
 */

import { useState, useEffect, useCallback, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

// ── Palette ───────────────────────────────────────────────────────────────────
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

type Tab   = "memories" | "events";
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

// ── MemoryCard — with inline edit ─────────────────────────────────────────────
function MemoryCard({ mem, onDelete, onPin, onEdit }: {
  mem:      Memory;
  onDelete: (id: string) => void;
  onPin:    (id: string, pinned: boolean) => void;
  onEdit:   (id: string, content: string) => void;
}) {
  const [expanded,    setExpanded]    = useState(false);
  const [editing,     setEditing]     = useState(false);
  const [editContent, setEditContent] = useState(mem.content);
  const [saving,      setSaving]      = useState(false);
  const taRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => { setEditContent(mem.content); }, [mem.content]);
  useEffect(() => { if (editing) setTimeout(() => taRef.current?.focus(), 20); }, [editing]);

  const saveEdit = async () => {
    if (!editContent.trim()) return;
    if (editContent.trim() === mem.content) { setEditing(false); return; }
    setSaving(true);
    try {
      await onEdit(mem.id, editContent.trim());
      setEditing(false);
    } catch (e) { console.error("[memory] edit:", e); }
    finally { setSaving(false); }
  };

  const cancelEdit = () => { setEditing(false); setEditContent(mem.content); };

  const short = mem.content.length > 160 && !expanded && !editing;
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

      {editing ? (
        <textarea
          ref={taRef}
          value={editContent}
          onChange={e => setEditContent(e.target.value)}
          rows={Math.max(3, editContent.split("\n").length + 1)}
          onKeyDown={e => {
            if (e.key === "Escape") cancelEdit();
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) saveEdit();
          }}
          style={{ background: C.bg0, border: `1px solid ${C.borderHi}`, borderRadius: 6, color: C.t0, fontSize: 12, padding: "7px 9px", resize: "vertical", fontFamily: MONO, outline: "none", lineHeight: 1.6, width: "100%", boxSizing: "border-box" }}
        />
      ) : (
        <p style={{ margin: 0, fontSize: 12, color: C.t1, lineHeight: 1.65, fontFamily: MONO, whiteSpace: "pre-wrap", wordBreak: "break-word", maxHeight: short ? 80 : "none", overflow: "hidden" }}>
          {short ? mem.content.slice(0, 160) + "…" : mem.content}
        </p>
      )}

      {!editing && mem.content.length > 160 && (
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

        {editing ? (
          <>
            <button onClick={saveEdit} disabled={saving}
              style={{ ...tbtn, color: saving ? C.t3 : C.tealText }}
              onMouseEnter={e => { if (!saving) (e.currentTarget as HTMLElement).style.color = C.teal; }}
              onMouseLeave={e => { if (!saving) (e.currentTarget as HTMLElement).style.color = C.tealText; }}>
              {saving ? "Saving…" : "✓ Save"}
            </button>
            <button onClick={cancelEdit} style={{ ...tbtn, color: C.t2 }}>
              Cancel
            </button>
            <span style={{ fontSize: 10, color: C.t3, fontFamily: SANS, alignSelf: "center", marginLeft: 2 }}>⌘↵ to save</span>
          </>
        ) : (
          <button onClick={() => setEditing(true)} style={{ ...tbtn, color: C.t2 }}
            onMouseEnter={e => (e.currentTarget as HTMLElement).style.color = C.t0}
            onMouseLeave={e => (e.currentTarget as HTMLElement).style.color = C.t2}>
            ✎ Edit
          </button>
        )}

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

// ── EventLog — FTS5/BM25 event history from session_events ───────────────────
interface SessionEvent {
  id:         string;
  runbox_id:  string;
  session_id: string;
  event_type: string;
  summary:    string;
  detail:     string | null;
  timestamp:  number;
}

const EVENT_TYPE_COLOR: Record<string, string> = {
  session_start: C.teal,
  session_end:   C.t2,
  memory:        C.blue,
  file_change:   C.amber,
  git:           C.purple,
};

function EventTypeTag({ type: t }: { type: string }) {
  const color = EVENT_TYPE_COLOR[t] ?? C.t2;
  return (
    <span style={{
      fontSize: 9, fontWeight: 700, letterSpacing: ".07em",
      color, background: `${color}18`, border: `1px solid ${color}33`,
      borderRadius: 3, padding: "1px 5px", fontFamily: SANS,
      textTransform: "uppercase", flexShrink: 0,
    }}>{t.replace("_", " ")}</span>
  );
}

function EventLog({ runboxId }: { runboxId: string }) {
  const [events,   setEvents]   = useState<SessionEvent[]>([]);
  const [loading,  setLoading]  = useState(true);
  const [query,    setQuery]    = useState("");
  const [error,    setError]    = useState<string | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);

  const load = useCallback((q = query) => {
    setLoading(true); setError(null);
    invoke<SessionEvent[]>("db_events_for_runbox", {
      runboxId,
      query: q.trim() || null,
      limit: 50,
    })
      .then(setEvents)
      .catch(e => setError(String(e)))
      .finally(() => setLoading(false));
  }, [runboxId, query]);

  useEffect(() => { load(); }, [runboxId]);

  useEffect(() => {
    const unsub = listen<{ runbox_id: string }>("memory-added", ({ payload }) => {
      if (payload.runbox_id === runboxId) load();
    });
    return () => { unsub.then(f => f()); };
  }, [runboxId, load]);

  const handleSearch = (e: React.FormEvent) => {
    e.preventDefault();
    load(query);
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      {/* Search bar */}
      <form onSubmit={handleSearch} style={{ display: "flex", gap: 6 }}>
        <div style={{ position: "relative", flex: 1 }}>
          <input
            value={query}
            onChange={e => setQuery(e.target.value)}
            placeholder="BM25 search events… (Enter to search)"
            style={{ width: "100%", boxSizing: "border-box", background: C.bg0, border: `1px solid ${C.border}`, borderRadius: 7, color: C.t0, fontSize: 12, padding: "7px 28px 7px 30px", outline: "none", fontFamily: MONO }}
            onFocus={e => e.currentTarget.style.borderColor = C.borderHi}
            onBlur={e  => e.currentTarget.style.borderColor = C.border}
          />
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke={C.t2} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
            style={{ position: "absolute", left: 10, top: "50%", transform: "translateY(-50%)", pointerEvents: "none" }}>
            <circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>
          </svg>
          {query && (
            <button onClick={() => { setQuery(""); load(""); }}
              style={{ position: "absolute", right: 6, top: "50%", transform: "translateY(-50%)", background: "none", border: "none", cursor: "pointer", color: C.t2, fontSize: 14, lineHeight: 1, padding: "2px 4px" }}>×</button>
          )}
        </div>
        <button type="submit"
          style={{ padding: "6px 12px", background: C.bg3, border: `1px solid ${C.border}`, borderRadius: 7, color: C.t1, fontSize: 11, fontFamily: SANS, cursor: "pointer", fontWeight: 500, whiteSpace: "nowrap" }}
          onMouseEnter={e => { const el = e.currentTarget as HTMLElement; el.style.borderColor = C.borderHi; el.style.color = C.t0; }}
          onMouseLeave={e => { const el = e.currentTarget as HTMLElement; el.style.borderColor = C.border; el.style.color = C.t1; }}>
          Search
        </button>
      </form>

      {/* Legend */}
      <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
        {Object.entries(EVENT_TYPE_COLOR).map(([type, color]) => (
          <div key={type} style={{ display: "flex", alignItems: "center", gap: 4 }}>
            <span style={{ width: 6, height: 6, borderRadius: 1.5, background: color, display: "block" }} />
            <span style={{ fontSize: 10, color: C.t2, fontFamily: SANS }}>{type.replace("_", " ")}</span>
          </div>
        ))}
        <span style={{ flex: 1 }} />
        <button onClick={() => load()}
          style={{ ...tbtn, fontSize: 10 }}
          onMouseEnter={e => (e.currentTarget as HTMLElement).style.color = C.tealText}
          onMouseLeave={e => (e.currentTarget as HTMLElement).style.color = C.t2}>
          ↺ Refresh
        </button>
        {events.length > 0 && (
          <span style={{ fontSize: 10, color: C.t3, fontFamily: SANS }}>{events.length} event{events.length !== 1 ? "s" : ""}</span>
        )}
      </div>

      {loading && <Spinner />}
      {!loading && error && <div style={{ fontSize: 12, color: C.red, fontFamily: SANS }}>{error}</div>}

      {!loading && !error && events.length === 0 && (
        <Empty text={query ? `No events match "${query}"` : "No events recorded yet."} />
      )}

      {!loading && !error && events.map(ev => {
        const isExpanded = expanded === ev.id;
        const color = EVENT_TYPE_COLOR[ev.event_type] ?? C.t2;
        return (
          <div key={ev.id}
            style={{ background: C.bg2, border: `1px solid ${C.border}`, borderRadius: 8, padding: "9px 11px", display: "flex", flexDirection: "column", gap: 5, cursor: ev.detail ? "pointer" : "default" }}
            onClick={() => ev.detail && setExpanded(p => p === ev.id ? null : ev.id)}>
            <div style={{ display: "flex", alignItems: "center", gap: 7 }}>
              <span style={{ width: 6, height: 6, borderRadius: 1.5, background: color, flexShrink: 0 }} />
              <EventTypeTag type={ev.event_type} />
              <span style={{ flex: 1, fontSize: 12, color: C.t1, fontFamily: MONO, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: isExpanded ? "normal" : "nowrap" }}>
                {ev.summary}
              </span>
              <span style={{ fontSize: 10, color: C.t3, fontFamily: SANS, flexShrink: 0 }}>{reltime(ev.timestamp)}</span>
              {ev.detail && (
                <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke={C.t3} strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"
                  style={{ flexShrink: 0, transform: isExpanded ? "rotate(90deg)" : "rotate(0deg)", transition: "transform .15s" }}>
                  <polyline points="9 18 15 12 9 6"/>
                </svg>
              )}
            </div>
            {isExpanded && ev.detail && (
              <pre style={{ margin: 0, fontSize: 11, color: C.t1, fontFamily: MONO, background: C.bg0, borderRadius: 5, padding: "8px 10px", whiteSpace: "pre-wrap", wordBreak: "break-word", maxHeight: 240, overflow: "auto", border: `1px solid ${C.border}` }}>
                {ev.detail}
              </pre>
            )}
          </div>
        );
      })}
    </div>
  );
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
  const [search,   setSearch]   = useState("");

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

  useEffect(() => {
    const unsub = listen<{ runbox_id: string }>("memory-added", ({ payload }) => {
      if (payload.runbox_id === runboxId || payload.runbox_id === "__global__") {
        loadMemories();
      }
    });
    return () => { unsub.then(f => f()); };
  }, [runboxId, loadMemories]);

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

  const handleEdit = useCallback(async (id: string, content: string) => {
    await invoke("memory_update", { id, content });
    setMemories(p => p.map(m => m.id === id ? { ...m, content } : m));
  }, []);

  const filteredMemories = search.trim()
    ? memories.filter(m => m.content.toLowerCase().includes(search.toLowerCase()))
    : memories;

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
          <button style={tabStyle("events")}   onClick={() => setTab("events")}>Events</button>
        </div>
      </div>

      <div style={{ flex: 1, overflowY: "auto", padding: "12px 12px 16px" }}>
        {tab === "memories" && (
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            <AddMemoryForm runboxId={runboxId} sessionId={manualSessionId} runboxes={runboxes} onAdded={loadMemories} />

            {/* Search bar */}
            <div style={{ position: "relative" }}>
              <input
                value={search}
                onChange={e => setSearch(e.target.value)}
                placeholder="Filter memories…"
                style={{ width: "100%", boxSizing: "border-box", background: C.bg0, border: `1px solid ${C.border}`, borderRadius: 7, color: C.t0, fontSize: 12, padding: "7px 28px 7px 30px", outline: "none", fontFamily: MONO }}
                onFocus={e => e.currentTarget.style.borderColor = C.borderHi}
                onBlur={e  => e.currentTarget.style.borderColor = C.border}
              />
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke={C.t2} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
                style={{ position: "absolute", left: 10, top: "50%", transform: "translateY(-50%)", pointerEvents: "none" }}>
                <circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>
              </svg>
              {search && (
                <button onClick={() => setSearch("")}
                  style={{ position: "absolute", right: 6, top: "50%", transform: "translateY(-50%)", background: "none", border: "none", cursor: "pointer", color: C.t2, fontSize: 14, lineHeight: 1, padding: "2px 4px" }}>×</button>
              )}
            </div>

            {loading && <Spinner />}
            {!loading && error && <div style={{ fontSize: 12, color: C.red, padding: "8px 0", fontFamily: SANS }}>{error}</div>}
            {!loading && !error && filteredMemories.length === 0 && (
              <Empty text={search ? `No memories match "${search}"` : "No memories yet. Add one above."} />
            )}
            {!loading && filteredMemories.map(m => (
              <MemoryCard key={m.id} mem={m} onDelete={handleDelete} onPin={handlePin} onEdit={handleEdit} />
            ))}
          </div>
        )}
        {tab === "events" && <EventLog runboxId={runboxId} />}
      </div>

      <style>{`
        @keyframes spin    { to { transform: rotate(360deg); } }
        @keyframes sbFadeUp { from{opacity:0;transform:translateY(6px) scale(.98)} to{opacity:1;transform:translateY(0) scale(1)} }
      `}</style>
    </div>
  );
}