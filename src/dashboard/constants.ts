import type { Agent } from '../types';

export const AGENTS: Agent[] = [
  { id: 'claude',  label: 'Claude',  color: '#93c5fd', cmd: 'claude' },
  { id: 'gemini',  label: 'Gemini',  color: '#86efac', cmd: 'gemini' },
  { id: 'codex',   label: 'Codex',   color: '#fca5a5', cmd: 'codex'  },
  { id: 'cursor',  label: 'Cursor',  color: '#c4b5fd', cmd: 'agent'  },
  { id: 'kimi',    label: 'Kimi',    color: '#fcd34d', cmd: 'kimi'   },
  { id: 'iflow',   label: 'iFlow',   color: '#6ee7b7', cmd: 'iflow'  },
];

export const uid = (): string => Math.random().toString(36).slice(2, 10);

export const age = (ms: number): string => {
  const s = Math.floor(ms / 1000);
  if (s < 60) return s + 's';
  const m = Math.floor(s / 60);
  return m < 60 ? m + 'm' : Math.floor(m / 60) + 'h' + (m % 60) + 'm';
};

export const timeAgo = (ts: number): string => {
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 60)   return s + 's ago';
  if (s < 3600) return Math.floor(s / 60) + 'm ago';
  return Math.floor(s / 3600) + 'h ago';
};

import type { LineKind, TermLine } from '../types';

export const mk = (kind: LineKind, text: string): TermLine => ({
  id: uid(),
  kind,
  text,
  ts: Date.now(),
});
