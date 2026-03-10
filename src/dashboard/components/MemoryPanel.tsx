/**
 * MemoryPanel.tsx
 */

import { useState, useEffect, useCallback, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";

const C = {
  bg0: "#0d0d0d", bg1: "#141414", bg2: "#1a1a1a",
  bg3: "#222222", bg4: "#2a2a2a",
  border: "rgba(255,255,255,.07)", borderHi: "rgba(255,255,255,.14)",
  text0: "#f0f0f0", text1: "#b0b0b0", text2: "#555555", text3: "#333333",
  green: "#3fb950", red: "#e05252", blue: "#79b8ff", yellow: "#fbbf24",
  purple: "#c084fc",
};

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
  change_type: string;
  diff:        string | null;
  timestamp:   number;
}

type Tab   = "memories" | "sessions" | "files";
type Scope = "this" | "all" | "pick";

// ── Helpers ───────────────────────────────────────────────────────────────────
function reltime(ms: number): string {
  const diff = Date.now() - ms;
  if (diff < 60_000)    return "just now";
  if (diff < 3600_000)  return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86400_000) return `${Math.floor(diff / 3600_000)}h ago`;
  return `${Math.floor(diff / 86400_000)}d ago`;
}

const tbtn: React.CSSProperties = {
  background: "none", border: "none", color: C.text2, cursor: "pointer",
  padding: "2px 5px", borderRadius: 4, fontSize: 12,
  display: "flex", alignItems: "center", gap: 4,
};

// ── RunboxPickerModal ─────────────────────────────────────────────────────────
function RunboxPickerModal({ runboxes, currentId, picked, onConfirm, onClose }: {
  runboxes:  { id: string; name: string }[];
  currentId: string;
  picked:    string[];
  onConfirm: (ids: string[]) => void;
  onClose:   () => void;
}) {
  const [selected, setSelected] = useState<string[]>(picked);

  const toggle = (id: string) =>
    setSelected(prev =>
      prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id]
    );

  const selectAll = () => setSelected(runboxes.map(r => r.id));
  const clearAll  = () => setSelected([]);

  return (
    <div
      onClick={onClose}
      style={{
        position: "fixed", inset: 0, zIndex: 2000,
        background: "rgba(0,0,0,.75)", backdropFilter: "blur(8px)",
        display: "flex", alignItems: "center", justifyContent: "center",
      }}>
      <div
        onClick={e => e.stopPropagation()}
        style={{
          width: 340, background: C.bg2,
          border: `1px solid ${C.borderHi}`,
          borderRadius: 12,
          boxShadow: "0 32px 80px rgba(0,0,0,.9)",
          animation: "modalIn .15s cubic-bezier(.2,1,.4,1)",
          overflow: "hidden",
          display: "flex", flexDirection: "column",
        }}>
        {/* Header */}
        <div style={{
          padding: "14px 16px 12px",
          borderBottom: `1px solid ${C.border}`,
          display: "flex", alignItems: "center", justifyContent: "space-between",
        }}>
          <span style={{
            fontSize: 13, fontWeight: 600, color: C.text0,
            fontFamily: "-apple-system,system-ui,sans-serif",
          }}>Select runboxes</span>
          <button
            onClick={onClose}
            style={{ ...tbtn, fontSize: 18, color: C.text2 }}
            onMouseEnter={e => (e.currentTarget as HTMLElement).style.color = C.text0}
            onMouseLeave={e => (e.currentTarget as HTMLElement).style.color = C.text2}>
            ×
          </button>
        </div>

        {/* Select all / clear */}
        <div style={{
          display: "flex", gap: 6, padding: "8px 14px",
          borderBottom: `1px solid ${C.border}`,
        }}>
          <button
            onClick={selectAll}
            style={{
              ...tbtn, fontSize: 11, color: C.blue, padding: "3px 8px",
              border: `1px solid rgba(121,184,255,.2)`, borderRadius: 5,
            }}>Select all</button>
          <button
            onClick={clearAll}
            style={{
              ...tbtn, fontSize: 11, color: C.text2, padding: "3px 8px",
              border: `1px solid ${C.border}`, borderRadius: 5,
            }}>Clear</button>
          <span style={{
            flex: 1, textAlign: "right", fontSize: 11, color: C.text3,
            fontFamily: "-apple-system,system-ui,sans-serif",
            alignSelf: "center",
          }}>
            {selected.length} selected
          </span>
        </div>

        {/* List */}
        <div style={{
          maxHeight: 260, overflowY: "auto",
          padding: "8px 10px",
          display: "flex", flexDirection: "column", gap: 4,
        }}>
          {runboxes.length === 0 ? (
            <div style={{
              padding: "20px 0", textAlign: "center",
              fontSize: 12, color: C.text3,
              fontFamily: "-apple-system,system-ui,sans-serif",
            }}>No other runboxes.</div>
          ) : runboxes.map(rb => {
            const checked = selected.includes(rb.id);
            const isCurrent = rb.id === currentId;
            return (
              <div
                key={rb.id}
                onClick={() => toggle(rb.id)}
                style={{
                  display: "flex", alignItems: "center", gap: 10,
                  padding: "8px 10px", borderRadius: 7, cursor: "pointer",
                  background: checked ? "rgba(121,184,255,.07)" : "transparent",
                  border: `1px solid ${checked ? "rgba(121,184,255,.22)" : C.border}`,
                  transition: "all .12s",
                }}>
                {/* Checkbox */}
                <div style={{
                  width: 15, height: 15, borderRadius: 4, flexShrink: 0,
                  background: checked ? C.blue : "transparent",
                  border: `1.5px solid ${checked ? C.blue : C.text2}`,
                  display: "flex", alignItems: "center", justifyContent: "center",
                  transition: "all .12s",
                }}>
                  {checked && (
                    <svg width="9" height="9" viewBox="0 0 10 10" fill="none">
                      <polyline points="1.5,5 4,7.5 8.5,2.5" stroke="#000" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"/>
                    </svg>
                  )}
                </div>
                {/* Dot */}
                <span style={{
                  width: 6, height: 6, borderRadius: "50%", flexShrink: 0,
                  background: C.green, boxShadow: `0 0 4px ${C.green}`,
                }} />
                <span style={{
                  fontSize: 13, flex: 1,
                  color: checked ? C.text0 : C.text1,
                  fontFamily: "-apple-system,system-ui,sans-serif",
                  fontWeight: checked ? 500 : 400,
                }}>{rb.name}</span>
                {isCurrent && (
                  <span style={{
                    fontSize: 10, color: C.text3,
                    fontFamily: "-apple-system,system-ui,sans-serif",
                    background: C.bg3, borderRadius: 4, padding: "1px 6px",
                  }}>current</span>
                )}
              </div>
            );
          })}
        </div>

        {/* Footer */}
        <div style={{
          padding: "10px 14px",
          borderTop: `1px solid ${C.border}`,
          display: "flex", gap: 8,
        }}>
          <button
            onClick={onClose}
            style={{
              flex: 1, padding: "8px 0",
              background: "transparent",
              border: `1px solid ${C.border}`,
              borderRadius: 7, color: C.text2,
              fontSize: 12, cursor: "pointer",
              fontFamily: "-apple-system,system-ui,sans-serif",
            }}>Cancel</button>
          <button
            onClick={() => { onConfirm(selected); onClose(); }}
            disabled={selected.length === 0}
            style={{
              flex: 2, padding: "8px 0",
              background: selected.length === 0 ? C.bg3 : C.text0,
              border: "none", borderRadius: 7,
              color: selected.length === 0 ? C.text2 : "#131313",
              fontSize: 12, fontWeight: 700, cursor: selected.length === 0 ? "default" : "pointer",
              fontFamily: "-apple-system,system-ui,sans-serif",
              transition: "background .12s",
            }}>
            {selected.length === 0
              ? "Select runboxes"
              : `Confirm ${selected.length} runbox${selected.length !== 1 ? "es" : ""}`}
          </button>
        </div>
      </div>
    </div>
  );
}


// ── MemoryCard ────────────────────────────────────────────────────────────────
function MemoryCard({ mem, onDelete, onPin }: {
  mem:      Memory;
  onDelete: (id: string) => void;
  onPin:    (id: string, pinned: boolean) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const short = mem.content.length > 160 && !expanded;

  const scopeColor: Record<string, string> = {
    "all runboxes": C.purple,
    "this runbox":  C.text3,
  };

  return (
    <div style={{
      background: mem.pinned ? "rgba(121,184,255,.05)" : C.bg2,
      border: `1px solid ${mem.pinned ? "rgba(121,184,255,.18)" : C.border}`,
      borderRadius: 8, padding: "10px 12px",
      display: "flex", flexDirection: "column", gap: 6,
    }}>
      <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
        {mem._scope && (
          <span style={{
            fontSize: 9, fontWeight: 700, letterSpacing: ".06em",
            color: scopeColor[mem._scope] ?? C.text3,
            background: `${scopeColor[mem._scope] ?? C.text3}18`,
            border: `1px solid ${scopeColor[mem._scope] ?? C.text3}33`,
            borderRadius: 3, padding: "1px 5px",
            fontFamily: "-apple-system,system-ui,sans-serif",
            textTransform: "uppercase", flexShrink: 0,
          }}>{mem._scope}</span>
        )}
        {mem.pinned && (
          <span style={{
            fontSize: 9, color: C.blue,
            background: "rgba(121,184,255,.12)",
            border: `1px solid rgba(121,184,255,.2)`,
            borderRadius: 3, padding: "1px 5px", letterSpacing: ".05em",
            fontFamily: "-apple-system,system-ui,sans-serif",
          }}>PINNED</span>
        )}
        <span style={{ flex: 1 }} />
        <span style={{ fontSize: 10, color: C.text3, fontFamily: "-apple-system,system-ui,sans-serif" }}>
          {reltime(mem.timestamp)}
        </span>
      </div>

      <p style={{
        margin: 0, fontSize: 12, color: C.text1, lineHeight: 1.65,
        fontFamily: "ui-monospace,'SF Mono',monospace",
        whiteSpace: "pre-wrap", wordBreak: "break-word",
        maxHeight: short ? 80 : "none", overflow: "hidden",
      }}>
        {short ? mem.content.slice(0, 160) + "…" : mem.content}
      </p>
      {mem.content.length > 160 && (
        <button onClick={() => setExpanded(e => !e)}
          style={{ ...tbtn, color: C.blue, fontSize: 11 }}>
          {expanded ? "Show less" : "Show more"}
        </button>
      )}

      <div style={{ display: "flex", gap: 4, marginTop: 2 }}>
        <button
          onClick={() => onPin(mem.id, !mem.pinned)}
          style={{ ...tbtn, color: mem.pinned ? C.blue : C.text2 }}
          onMouseEnter={e => (e.currentTarget as HTMLElement).style.color = C.blue}
          onMouseLeave={e => (e.currentTarget as HTMLElement).style.color = mem.pinned ? C.blue : C.text2}>
          {mem.pinned ? "📌 Unpin" : "📌 Pin"}
        </button>
        <span style={{ flex: 1 }} />
        <button
          onClick={() => onDelete(mem.id)}
          style={{ ...tbtn, color: C.text3 }}
          onMouseEnter={e => (e.currentTarget as HTMLElement).style.color = C.red}
          onMouseLeave={e => (e.currentTarget as HTMLElement).style.color = C.text3}>
          × Delete
        </button>
      </div>
    </div>
  );
}

// ── AddMemoryForm ─────────────────────────────────────────────────────────────
function AddMemoryForm({ runboxId, sessionId, runboxes, onAdded }: {
  runboxId:  string;
  sessionId: string;
  runboxes:  { id: string; name: string }[];
  onAdded:   () => void;
}) {
  const [open,       setOpen]       = useState(false);
  const [content,    setContent]    = useState("");
  const [scope,      setScope]      = useState<Scope>("this");
  const [pickedIds,  setPickedIds]  = useState<string[]>([]);
  const [showPicker, setShowPicker] = useState(false);
  const [loading,    setLoading]    = useState(false);
  const taRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (open) setTimeout(() => taRef.current?.focus(), 30);
  }, [open]);

  const reset = () => {
    setOpen(false); setContent("");
    setScope("this"); setPickedIds([]);
  };

  const submit = async () => {
    if (!content.trim()) return;
    if (scope === "pick" && pickedIds.length === 0) return;
    setLoading(true);
    try {
      const targets =
        scope === "all"  ? ["__global__"] :
        scope === "pick" ? pickedIds :
        [runboxId];
      await Promise.all(
        targets.map(id =>
          invoke("memory_add", { runboxId: id, sessionId, content: content.trim() })
        )
      );
      reset(); onAdded();
    } catch (e) {
      console.error("[memory] add failed:", e);
    } finally { setLoading(false); }
  };

  if (!open) return (
    <button
      onClick={() => setOpen(true)}
      style={{
        display: "flex", alignItems: "center", justifyContent: "center", gap: 7,
        width: "100%", padding: "9px 12px",
        background: "rgba(121,184,255,.1)",
        border: `1px solid rgba(121,184,255,.25)`,
        borderRadius: 7, color: C.blue,
        fontSize: 12, fontWeight: 600, cursor: "pointer",
        fontFamily: "-apple-system,system-ui,sans-serif",
        transition: "all .15s",
      }}
      onMouseEnter={e => {
        (e.currentTarget as HTMLElement).style.background = "rgba(121,184,255,.18)";
        (e.currentTarget as HTMLElement).style.borderColor = "rgba(121,184,255,.45)";
      }}
      onMouseLeave={e => {
        (e.currentTarget as HTMLElement).style.background = "rgba(121,184,255,.1)";
        (e.currentTarget as HTMLElement).style.borderColor = "rgba(121,184,255,.25)";
      }}>
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

  const disabled = loading || !content.trim() || (scope === "pick" && pickedIds.length === 0);

  const saveLabel =
    loading          ? "Saving…" :
    scope === "all"  ? "Save to all runboxes" :
    scope === "pick" ? `Save to ${pickedIds.length} runbox${pickedIds.length !== 1 ? "es" : ""}` :
    "Save memory";

  return (
    <>
      {/* Runbox picker popup */}
      {showPicker && (
        <RunboxPickerModal
          runboxes={runboxes}
          currentId={runboxId}
          picked={pickedIds}
          onConfirm={ids => { setPickedIds(ids); setScope("pick"); }}
          onClose={() => setShowPicker(false)}
        />
      )}

      <div style={{
        background: C.bg2, border: `1px solid ${C.borderHi}`,
        borderRadius: 8, padding: 12,
        display: "flex", flexDirection: "column", gap: 10,
      }}>
        {/* Textarea */}
        <textarea
          ref={taRef}
          value={content}
          onChange={e => setContent(e.target.value)}
          placeholder="What should be remembered…"
          rows={3}
          style={{
            background: C.bg0, border: `1px solid ${C.border}`, borderRadius: 6,
            color: C.text0, fontSize: 12, padding: "8px 10px", resize: "vertical",
            fontFamily: "ui-monospace,'SF Mono',monospace", outline: "none",
            lineHeight: 1.6, width: "100%", boxSizing: "border-box",
          }}
          onFocus={e => e.currentTarget.style.borderColor = C.borderHi}
          onBlur={e  => e.currentTarget.style.borderColor = C.border}
          onKeyDown={e => { if (e.key === "Escape") reset(); }}
        />

        {/* Scope selector */}
        <div>
          <div style={{
            fontSize: 10, fontWeight: 600, color: C.text3,
            textTransform: "uppercase", letterSpacing: ".08em",
            marginBottom: 6, fontFamily: "-apple-system,system-ui,sans-serif",
          }}>Save to</div>
          <div style={{ display: "flex", gap: 5 }}>
            {scopeOpts.map(([s, label]) => (
              <button
                key={s}
                onClick={() => {
                  if (s === "pick") {
                    setShowPicker(true);
                  } else {
                    setScope(s);
                  }
                }}
                style={{
                  flex: 1, padding: "6px 4px", borderRadius: 6,
                  fontSize: 11, cursor: "pointer",
                  background: scope === s ? C.bg4 : "transparent",
                  border: `1px solid ${scope === s ? C.borderHi : C.border}`,
                  color: scope === s ? C.text0 : C.text2,
                  fontFamily: "-apple-system,system-ui,sans-serif",
                  fontWeight: scope === s ? 600 : 400,
                  transition: "all .12s",
                  whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis",
                }}>{label}</button>
            ))}
          </div>
          {/* Show selected runbox names as chips */}
          {scope === "pick" && pickedIds.length > 0 && (
            <div style={{ display: "flex", flexWrap: "wrap", gap: 4, marginTop: 6 }}>
              {pickedIds.map(id => {
                const rb = runboxes.find(r => r.id === id);
                if (!rb) return null;
                return (
                  <span key={id} style={{
                    fontSize: 10, padding: "2px 7px",
                    background: "rgba(121,184,255,.1)",
                    border: `1px solid rgba(121,184,255,.2)`,
                    borderRadius: 20, color: C.blue,
                    fontFamily: "-apple-system,system-ui,sans-serif",
                    display: "flex", alignItems: "center", gap: 4,
                  }}>
                    {rb.name}
                    <span
                      onClick={() => {
                        const next = pickedIds.filter(x => x !== id);
                        setPickedIds(next);
                        if (next.length === 0) setScope("this");
                      }}
                      style={{ cursor: "pointer", opacity: 0.6, fontSize: 12 }}>×</span>
                  </span>
                );
              })}
              <span
                onClick={() => setShowPicker(true)}
                style={{
                  fontSize: 10, padding: "2px 7px",
                  border: `1px dashed ${C.border}`,
                  borderRadius: 20, color: C.text2, cursor: "pointer",
                  fontFamily: "-apple-system,system-ui,sans-serif",
                }}>+ edit</span>
            </div>
          )}
        </div>

        {/* Buttons */}
        <div style={{ display: "flex", gap: 6 }}>
          <button onClick={reset} style={{ ...tbtn, color: C.text2, padding: "6px 12px" }}>
            Cancel
          </button>
          <button
            onClick={submit}
            disabled={disabled}
            style={{
              flex: 1, padding: "7px 0",
              background: disabled ? C.bg3 : C.text0,
              border: "none", borderRadius: 6,
              color: disabled ? C.text2 : "#131313",
              fontSize: 12, fontWeight: 700,
              cursor: disabled ? "default" : "pointer",
              fontFamily: "-apple-system,system-ui,sans-serif",
              transition: "background .15s",
            }}>
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
        <div key={s.id} style={{
          background: C.bg2, border: `1px solid ${C.border}`,
          borderRadius: 8, padding: "9px 12px",
          display: "flex", flexDirection: "column", gap: 4,
        }}>
          <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <span style={{
              width: 5, height: 5, borderRadius: "50%", flexShrink: 0,
              background: s.ended_at ? C.text3 : C.green,
              boxShadow: s.ended_at ? "none" : `0 0 4px ${C.green}`,
            }} />
            <span style={{
              fontSize: 10, color: C.text2,
              fontFamily: "ui-monospace,'SF Mono',monospace",
              flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
            }}>{s.pane_id} · {s.cwd}</span>
            <span style={{
              fontSize: 10, color: C.text3, flexShrink: 0,
              fontFamily: "-apple-system,system-ui,sans-serif",
            }}>{reltime(s.started_at)}</span>
          </div>
          {s.ended_at && (
            <span style={{ fontSize: 10, color: C.text3, fontFamily: "-apple-system,system-ui,sans-serif" }}>
              ended {reltime(s.ended_at)} · exit {s.exit_code ?? "?"}
            </span>
          )}
        </div>
      ))}
    </div>
  );
}

// ── FileChangeList ────────────────────────────────────────────────────────────
function FileChangeList({ runboxId }: { runboxId: string }) {
  const [changes, setChanges] = useState<FileChange[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setLoading(true);
    invoke<FileChange[]>("db_file_changes_for_runbox", { runboxId })
      .then(setChanges)
      .catch(e => console.error("[db] file_changes:", e))
      .finally(() => setLoading(false));
  }, [runboxId]);

  if (loading) return <Spinner />;
  if (!changes.length) return <Empty text="No file changes recorded yet." />;

  const typeColor: Record<string, string> = {
    created: C.green, modified: C.yellow, deleted: C.red,
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
      {changes.map(fc => (
        <div key={fc.id} style={{
          background: C.bg2, border: `1px solid ${C.border}`,
          borderRadius: 7, padding: "8px 12px",
          display: "flex", flexDirection: "column", gap: 3,
        }}>
          <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <span style={{
              fontSize: 9, fontWeight: 700, letterSpacing: ".07em",
              color: typeColor[fc.change_type] ?? C.text2,
              background: `${typeColor[fc.change_type] ?? C.text2}18`,
              border: `1px solid ${typeColor[fc.change_type] ?? C.text2}33`,
              borderRadius: 3, padding: "1px 5px", textTransform: "uppercase",
              fontFamily: "-apple-system,system-ui,sans-serif",
            }}>{fc.change_type}</span>
            <span style={{
              fontSize: 11, color: C.text1,
              fontFamily: "ui-monospace,'SF Mono',monospace",
              flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
            }}>{fc.file_path}</span>
            <span style={{
              fontSize: 10, color: C.text3, flexShrink: 0,
              fontFamily: "-apple-system,system-ui,sans-serif",
            }}>{reltime(fc.timestamp)}</span>
          </div>
          {fc.diff && (
            <pre style={{
              margin: 0, fontSize: 10, color: C.text2, lineHeight: 1.5,
              fontFamily: "ui-monospace,'SF Mono',monospace",
              background: C.bg0, borderRadius: 4, padding: "5px 8px",
              maxHeight: 80, overflow: "auto",
              whiteSpace: "pre-wrap", wordBreak: "break-all",
            }}>{fc.diff}</pre>
          )}
        </div>
      ))}
    </div>
  );
}

// ── Atoms ─────────────────────────────────────────────────────────────────────
function Spinner() {
  return (
    <div style={{ padding: "28px 0", display: "flex", justifyContent: "center" }}>
      <div style={{
        width: 18, height: 18, borderRadius: "50%",
        border: `2px solid ${C.border}`, borderTopColor: C.blue,
        animation: "spin .7s linear infinite",
      }} />
    </div>
  );
}

function Empty({ text }: { text: string }) {
  return (
    <div style={{
      padding: "28px 14px", textAlign: "center",
      fontSize: 12, color: C.text3,
      fontFamily: "-apple-system,system-ui,sans-serif",
    }}>{text}</div>
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

  const manualSessionId = `manual-${runboxId}`;

  const loadMemories = useCallback(() => {
    setLoading(true);
    setError(null);
    Promise.all([
      invoke<Memory[]>("memory_list", { runboxId }),
      invoke<Memory[]>("memory_list", { runboxId: "__global__" }),
    ])
      .then(([mine, global]) => {
        const all: Memory[] = [
          ...global.map(m => ({ ...m, _scope: "all runboxes" })),
          ...mine.map(m => ({ ...m, _scope: "this runbox" })),
        ].sort((a, b) => {
          if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
          return b.timestamp - a.timestamp;
        });
        setMemories(all);
      })
      .catch(e => setError(String(e)))
      .finally(() => setLoading(false));
  }, [runboxId]);

  useEffect(() => { loadMemories(); }, [loadMemories]);

  const handleDelete = useCallback(async (id: string) => {
    try {
      await invoke("memory_delete", { id });
      setMemories(prev => prev.filter(m => m.id !== id));
    } catch (e) { console.error("[memory] delete:", e); }
  }, []);

  const handlePin = useCallback(async (id: string, pinned: boolean) => {
    try {
      await invoke("memory_pin", { id, pinned });
      setMemories(prev => {
        const updated = prev.map(m => m.id === id ? { ...m, pinned } : m);
        return [...updated].sort((a, b) => {
          if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
          return b.timestamp - a.timestamp;
        });
      });
    } catch (e) { console.error("[memory] pin:", e); }
  }, []);

  const tabStyle = (t: Tab): React.CSSProperties => ({
    flex: 1, padding: "7px 0", background: "none", border: "none",
    borderBottom: `2px solid ${tab === t ? C.blue : "transparent"}`,
    color: tab === t ? C.text0 : C.text2,
    fontSize: 11, fontWeight: tab === t ? 600 : 400,
    cursor: "pointer", fontFamily: "-apple-system,system-ui,sans-serif",
    letterSpacing: ".04em", textTransform: "uppercase",
    transition: "color .15s",
  });

  return (
    <div style={{
      display: "flex", flexDirection: "column", height: "100%",
      background: C.bg1, borderLeft: `1px solid ${C.border}`,
    }}>
      {/* Header */}
      <div style={{
        padding: "11px 14px 0", flexShrink: 0,
        borderBottom: `1px solid ${C.border}`,
      }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 10 }}>
          <span style={{
            fontSize: 13, fontWeight: 600, color: C.text0, flex: 1,
            overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
            fontFamily: "-apple-system,system-ui,sans-serif",
          }}>{runboxName}</span>
          <button
            onClick={onClose}
            style={{ ...tbtn, fontSize: 16, color: C.text2 }}
            onMouseEnter={e => (e.currentTarget as HTMLElement).style.color = C.text0}
            onMouseLeave={e => (e.currentTarget as HTMLElement).style.color = C.text2}>
            ×
          </button>
        </div>
        <div style={{ display: "flex" }}>
          <button style={tabStyle("memories")} onClick={() => setTab("memories")}>Memories</button>
          <button style={tabStyle("sessions")} onClick={() => setTab("sessions")}>Sessions</button>
          <button style={tabStyle("files")}    onClick={() => setTab("files")}>Files</button>
        </div>
      </div>

      {/* Body */}
      <div style={{ flex: 1, overflowY: "auto", padding: "12px 12px 16px" }}>
        {tab === "memories" && (
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            <AddMemoryForm
              runboxId={runboxId}
              sessionId={manualSessionId}
              runboxes={runboxes}
              onAdded={loadMemories}
            />
            {loading && <Spinner />}
            {!loading && error && (
              <div style={{
                fontSize: 12, color: C.red, padding: "8px 0",
                fontFamily: "-apple-system,system-ui,sans-serif",
              }}>{error}</div>
            )}
            {!loading && !error && memories.length === 0 && (
              <Empty text="No memories yet. Add one above." />
            )}
            {!loading && memories.map(m => (
              <MemoryCard key={m.id} mem={m} onDelete={handleDelete} onPin={handlePin} />
            ))}
          </div>
        )}
        {tab === "sessions" && <SessionList runboxId={runboxId} />}
        {tab === "files"    && <FileChangeList runboxId={runboxId} />}
      </div>

      <style>{`
        @keyframes spin { to { transform: rotate(360deg); } }
        @keyframes modalIn { from{opacity:0;transform:scale(.96) translateY(6px)} to{opacity:1;transform:scale(1) translateY(0)} }
      `}</style>
    </div>
  );
}