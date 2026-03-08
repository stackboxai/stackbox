// ── Stackbox UI types ──────────────────────────────────────────

export type AgentId = 'claude' | 'gemini' | 'codex' | 'cursor' | 'kimi' | 'iflow';

export interface Agent {
  id:    AgentId;
  label: string;
  color: string;
  cmd:   string;
}

export type LineKind = 'out' | 'err' | 'sys' | 'sig' | 'in';

export interface TermLine {
  id:   string;
  kind: LineKind;
  text: string;
  ts:   number;
}

export type TermStatus = 'active' | 'done' | 'error' | 'killed';

export interface Term {
  sid:        string;
  agent:      AgentId;
  label:      string;
  status:     TermStatus;
  born:       number;
  lines:      TermLine[];
  files:      number;
  signals:    number;
  dur:        string;
  needsInput: boolean;
}

export interface Container {
  cid:       string;
  name:      string;
  agent:     AgentId;
  tabSids:   string[];
  activeTab: string;
  born:      number;
}

export type AgentState = "booting" | "working" | "completed" | "stalled" | "zombie";

export interface AgentSession {
  id:           string;
  pid:          number | null;
  agent:        string;
  agentName:    string;
  state:        AgentState;
  capability:   string;
  lastActivity: string | number;
}

export interface HealthCheck {
  agentName:          string;
  timestamp:          string;
  tmuxAlive:          boolean;
  pidAlive:           boolean | null;
  processAlive:       boolean;
  lastActivity:       string | number;
  action:             "none" | "terminate" | "escalate" | "investigate";
  state:              AgentState;
  reconciliationNote: string | null;
}
