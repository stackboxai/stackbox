import { useState, useEffect, useCallback, useRef } from "react";

const API  = "http://127.0.0.1:4322/api";
const WS   = "ws://127.0.0.1:4322";
const POLL = 3000;

// ─── Types ────────────────────────────────────────────────────────────────────

export interface Runbox {
  id:             string;
  name:           string;
  cwd:            string;
  createdAt:      number;
  activeSessions: number;
  totalSessions:  number;
}

export interface Agent {
  id:        string;
  name:      string;
  status:    "running" | "idle" | "error";
  role:      string;   // the agent type: claude, gemini, codex, etc.
  tasks:     number;   // total sessions (not phantom anymore)
  sessions:  number;
  uptime:    string;
  instances: Array<{
    id:       string;
    name:     string;
    stalled:  boolean;
    duration: string;
    host:     string | null;
    runboxId: string | null;
  }>;
}

export interface Signal {
  id:         number;
  type:       string;
  severity:   "critical" | "high" | "medium" | "low";
  agent:      string;
  time:       string;
  flagged:    boolean;  // ← was always undefined before; now populated by server
  detail:     string;
  session_id: string;
}

export interface Threat {
  id:         number;
  type:       string;
  severity:   "critical" | "high" | "medium" | "warning" | "low";
  agent:      string;
  time:       string;
  detail:     string;
  blocked:    boolean;
  session_id: string;
}

export interface Approval {
  id:         string;
  agentId:    string;
  sessionId:  string;
  tool:       string;
  params:     Record<string, unknown>;
  reason:     string;
  createdAt:  number;
  expiresAt:  number;
  decision?:  "approved" | "denied" | "timeout";
  decidedAt?: number;
  decidedBy?: string;
  note?:      string;
}

export interface Session {
  id:           string;
  agent:        string;
  instanceName: string;
  task:         string;
  cwd:          string;
  status:       "active" | "done" | "error" | "killed";
  duration:     string;
  runboxId:     string | null;
  isActive:     boolean;
  isStalled:    boolean;
  isRemote:     boolean;
  started_at:   number;
}

export interface SessionMetrics {
  totalSessions:      number;
  activeSessions:     number;
  activeInstances:    number;
  avgSessionDuration: string;
  successRate:        number;
  fileChanges:        number;
  messageCount:       number;
  threatCount:        number;
  blockedCount:       number;
}

export interface FileActivity {
  agent:      string;
  type:       "created" | "modified" | "deleted";
  path:       string;
  time:       string;
  ts:         number;
  session_id: string;
}

export interface LiveEvent {
  id:         string;
  session_id: string;
  agent:      string;
  type:       string;
  payload:    Record<string, unknown>;
  ts:         number;
}

export interface RecoveryStats {
  total:         number;
  running:       number;
  failed:        number;
  recovering:    number;
  dead:          number;
  totalRestarts: number;
}

export interface DashboardData {
  runboxes:       Runbox[];
  agents:         Agent[];
  signals:        Signal[];
  threats:        Threat[];
  approvals:      Approval[];
  sessions:       Session[];
  sessionMetrics: SessionMetrics;
  filesActivity:  FileActivity[];
  liveEvents:     LiveEvent[];
  recoveryStats:  RecoveryStats;
  timestamp:      number;
  dbConnected:    boolean;
  wsConnected:    boolean;
  apiAvailable:   boolean;
  loading:        boolean;
  error:          string | null;

  // Actions
  refresh:          () => void;
  resolveApproval:  (id: string, decision: "approved" | "denied") => Promise<void>;
  sendMessage:      (from: string, to: string, subject: string, body: string) => Promise<void>;
  createRunbox:     (name: string, cwd?: string) => Promise<Runbox>;
  renameRunbox:     (id: string, name: string) => Promise<void>;
  deleteRunbox:     (id: string) => Promise<void>;
}

// ─── Empty state ──────────────────────────────────────────────────────────────

const EMPTY_METRICS: SessionMetrics = {
  totalSessions: 0, activeSessions: 0, activeInstances: 0,
  avgSessionDuration: "–", successRate: 0,
  fileChanges: 0, messageCount: 0, threatCount: 0, blockedCount: 0,
};

const EMPTY_RECOVERY: RecoveryStats = {
  total: 0, running: 0, failed: 0, recovering: 0, dead: 0, totalRestarts: 0,
};

// ─── Hook ─────────────────────────────────────────────────────────────────────

export function useStackbox(): DashboardData {
  const [runboxes,       setRunboxes]       = useState<Runbox[]>([]);
  const [agents,         setAgents]         = useState<Agent[]>([]);
  const [signals,        setSignals]        = useState<Signal[]>([]);
  const [threats,        setThreats]        = useState<Threat[]>([]);
  const [approvals,      setApprovals]      = useState<Approval[]>([]);
  const [sessions,       setSessions]       = useState<Session[]>([]);
  const [sessionMetrics, setSessionMetrics] = useState<SessionMetrics>(EMPTY_METRICS);
  const [filesActivity,  setFilesActivity]  = useState<FileActivity[]>([]);
  const [liveEvents,     setLiveEvents]     = useState<LiveEvent[]>([]);
  const [recoveryStats,  setRecoveryStats]  = useState<RecoveryStats>(EMPTY_RECOVERY);
  const [timestamp,      setTimestamp]      = useState(0);
  const [dbConnected,    setDbConnected]    = useState(false);
  const [loading,        setLoading]        = useState(true);
  const [error,          setError]          = useState<string | null>(null);
  const [apiAvailable,   setApiAvailable]   = useState(false);
  const [wsConnected,    setWsConnected]    = useState(false);
  const wsRef = useRef<WebSocket | null>(null);

  // ── Poll /api/all ──
  const fetchAll = useCallback(async () => {
    try {
      const res = await fetch(`${API}/all`, { signal: AbortSignal.timeout(2500) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      setRunboxes(json.runboxes        ?? []);
      setAgents(json.agents            ?? []);
      setSignals(json.signals          ?? []);
      setThreats(json.threats          ?? []);
      setSessions(json.sessions        ?? []);
      setSessionMetrics(json.sessionMetrics ?? EMPTY_METRICS);
      setFilesActivity(json.filesActivity   ?? []);
      setRecoveryStats(json.recoveryStats   ?? EMPTY_RECOVERY);
      setTimestamp(json.timestamp      ?? 0);
      setDbConnected(json.dbConnected  ?? false);
      setApiAvailable(true);
      setError(null);
    } catch {
      setApiAvailable(false);
      setError("Stackbox server not running — start with: node dist/server.js");
    } finally {
      setLoading(false);
    }
  }, []);

  // ── Poll /api/approvals ──
  const fetchApprovals = useCallback(async () => {
    try {
      const res = await fetch(`${API}/approvals`, { signal: AbortSignal.timeout(2000) });
      if (!res.ok) return;
      setApprovals(await res.json() ?? []);
    } catch { /**/ }
  }, []);

  useEffect(() => {
    fetchAll(); fetchApprovals();
    const t1 = setInterval(fetchAll,      POLL);
    const t2 = setInterval(fetchApprovals, 2000);
    return () => { clearInterval(t1); clearInterval(t2); };
  }, [fetchAll, fetchApprovals]);

  // ── WebSocket live stream ──
  useEffect(() => {
    let ws: WebSocket;
    let retryTimer: ReturnType<typeof setTimeout>;

    const connect = () => {
      try {
        ws = new WebSocket(WS);
        wsRef.current = ws;
        ws.onopen  = () => setWsConnected(true);
        ws.onclose = () => { setWsConnected(false); retryTimer = setTimeout(connect, 3000); };
        ws.onerror = () => ws.close();
        ws.onmessage = (e) => {
          try {
            const event: LiveEvent = JSON.parse(e.data);
            setLiveEvents(prev => [event, ...prev].slice(0, 300));
            if (event.type === "session.started" || event.type === "session.ended") fetchAll();
            if (event.type === "signal.threat")  fetchAll();
            if (event.type === "gate.pending")   fetchApprovals();
            if (event.type === "gate.resolved")  fetchApprovals();
            if (event.type === "recovery.event") fetchAll();
          } catch { /**/ }
        };
      } catch { /**/ }
    };

    connect();
    return () => { clearTimeout(retryTimer); ws?.close(); };
  }, [fetchAll, fetchApprovals]);

  // ── Actions ──

  const resolveApproval = useCallback(async (id: string, decision: "approved" | "denied") => {
    await fetch(`${API}/approvals/${id}/${decision}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ decidedBy: "dashboard" }),
    });
    await fetchApprovals();
  }, [fetchApprovals]);

  const sendMessage = useCallback(async (from: string, to: string, subject: string, body: string) => {
    await fetch(`${API}/message`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ from, to, subject, body }),
    });
  }, []);

  const createRunbox = useCallback(async (name: string, cwd = "~/") => {
    const res = await fetch(`${API}/runboxes`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, cwd }),
    });
    if (!res.ok) throw new Error(await res.text());
    const runbox = await res.json() as Runbox;
    setRunboxes(prev => [...prev, runbox]);
    return runbox;
  }, []);

  const renameRunbox = useCallback(async (id: string, name: string) => {
    await fetch(`${API}/runboxes/${id}`, {
      method: "PATCH", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name }),
    });
    setRunboxes(prev => prev.map(r => r.id === id ? { ...r, name } : r));
  }, []);

  const deleteRunbox = useCallback(async (id: string) => {
    await fetch(`${API}/runboxes/${id}`, { method: "DELETE" });
    setRunboxes(prev => prev.filter(r => r.id !== id));
    await fetchAll();
  }, [fetchAll]);

  return {
    runboxes, agents, signals, threats, approvals,
    sessions, sessionMetrics, filesActivity, liveEvents,
    recoveryStats, timestamp, dbConnected, loading, error,
    apiAvailable, wsConnected,
    refresh: fetchAll,
    resolveApproval, sendMessage,
    createRunbox, renameRunbox, deleteRunbox,
  };
}
