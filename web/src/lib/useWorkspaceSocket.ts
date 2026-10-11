'use client';
// Live workspace state: REST snapshot + WebSocket stream, with polling fallback when the socket
// can't connect (e.g. the phone reaches the app through an HTTPS tunnel that only exposes :3000).
import { useCallback, useEffect, useReducer, useRef, useState } from 'react';
import { api, ApiError, currentUser, enableFixtureMode, fixtureMode, wsBase } from './api.ts';
import { fixtureSubscribe } from './fixtures.ts';
import type { Activity, Decision, Incident, Playbook, Receipt, ServerMessage, Stats, Workspace } from './types.ts';

export interface PanelDatum { data: unknown; at: string; error?: string }
export interface LiveState {
  workspace?: Workspace;
  incidents: Incident[];
  decisions: Decision[];
  playbooks: Playbook[];
  stats?: Stats;
  panelData: Record<string, PanelDatum>;
  activity: Activity[];
  compose?: { state: 'started' | 'done' | 'failed'; summary?: string; receipt?: Receipt };
}
export type LiveMode = 'connecting' | 'live' | 'polling' | 'fixture';

export interface Snapshot { workspace: Workspace; incidents: Incident[]; decisions: Decision[]; playbooks: Playbook[]; stats: Stats; panelData?: Record<string, PanelDatum> }

type Action = { type: 'msg'; m: ServerMessage } | { type: 'snapshot'; s: Snapshot } | { type: 'reset' };

const EMPTY: LiveState = { incidents: [], decisions: [], playbooks: [], panelData: {}, activity: [] };

function upsert<T extends { id: string }>(list: T[], item: T): T[] {
  const i = list.findIndex(x => x.id === item.id);
  if (i < 0) return [...list, item];
  const next = list.slice();
  next[i] = item;
  return next;
}

function reduce(s: LiveState, a: Action): LiveState {
  if (a.type === 'reset') return EMPTY;
  if (a.type === 'snapshot') {
    const { workspace, incidents, decisions, playbooks, stats, panelData } = a.s;
    // Never let an older snapshot overwrite a newer workspace version from the socket.
    const ws = s.workspace && s.workspace.version > workspace.version ? s.workspace : workspace;
    // Latest cached panel data from the server (only fills in panels we have nothing newer for).
    const merged = { ...s.panelData };
    for (const [pid, d] of Object.entries(panelData ?? {})) {
      if (d && (!merged[pid] || merged[pid].at < d.at)) merged[pid] = d;
    }
    return { ...s, workspace: ws, incidents: incidents ?? [], decisions: decisions ?? [], playbooks: playbooks ?? [], stats: stats ?? s.stats, panelData: merged };
  }
  const m = a.m;
  switch (m.type) {
    case 'workspace': return { ...s, workspace: m.workspace };
    case 'panel-data': {
      const prev = s.panelData[m.panelId];
      // On error keep the last good data and mark it stale.
      const next: PanelDatum = m.error ? { data: prev?.data, at: prev?.at ?? m.at, error: m.error } : { data: m.data, at: m.at };
      return { ...s, panelData: { ...s.panelData, [m.panelId]: next } };
    }
    case 'activity':
      if (s.activity.some(x => x.id === m.item.id)) return s;
      return { ...s, activity: [m.item, ...s.activity].sort((x, y) => (x.at < y.at ? 1 : -1)).slice(0, 250) };
    case 'incident': return { ...s, incidents: upsert(s.incidents, m.incident) };
    case 'decision': return { ...s, decisions: upsert(s.decisions, m.decision) };
    case 'playbook': return { ...s, playbooks: upsert(s.playbooks, m.playbook) };
    case 'stats': return { ...s, stats: m.stats };
    case 'compose': return { ...s, compose: { state: m.state, summary: m.summary, receipt: m.receipt } };
    default: return s;
  }
}

export function useWorkspaceSocket(wsId: string | undefined) {
  const [state, dispatch] = useReducer(reduce, EMPTY);
  const [mode, setMode] = useState<LiveMode>('connecting');
  const [error, setError] = useState<string>();
  const stateRef = useRef(state);
  stateRef.current = state;
  const modeRef = useRef(mode);
  modeRef.current = mode;

  const loadSnapshot = useCallback(async () => {
    if (!wsId) return;
    const s = await api<Snapshot>(`/workspaces/${encodeURIComponent(wsId)}`);
    dispatch({ type: 'snapshot', s });
    setError(undefined);
  }, [wsId]);

  const applyMessage = useCallback((m: ServerMessage) => dispatch({ type: 'msg', m }), []);

  useEffect(() => {
    if (!wsId) return;
    let disposed = false;
    let socket: WebSocket | undefined;
    let retry = 0;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    let unsubscribeFixture: (() => void) | undefined;
    dispatch({ type: 'reset' });

    const startFixture = () => {
      setMode('fixture');
      unsubscribeFixture = fixtureSubscribe(wsId, m => !disposed && dispatch({ type: 'msg', m }));
    };

    const connect = () => {
      if (disposed) return;
      try {
        socket = new WebSocket(`${wsBase()}/ws?ws=${encodeURIComponent(wsId)}&as=${encodeURIComponent(currentUser())}`);
      } catch {
        scheduleReconnect();
        return;
      }
      socket.onopen = () => { retry = 0; setMode('live'); };
      socket.onmessage = ev => {
        try { dispatch({ type: 'msg', m: JSON.parse(String(ev.data)) as ServerMessage }); } catch { /* ignore malformed */ }
      };
      socket.onclose = () => { if (!disposed) { setMode('polling'); scheduleReconnect(); } };
      socket.onerror = () => { try { socket?.close(); } catch { /* noop */ } };
    };
    const scheduleReconnect = () => {
      if (disposed) return;
      clearTimeout(retryTimer);
      const delay = Math.min(15_000, 1000 * 2 ** Math.min(retry++, 4));
      retryTimer = setTimeout(connect, delay);
    };

    (async () => {
      if (fixtureMode()) { startFixture(); return; }
      try {
        await loadSnapshot();
      } catch (e) {
        if (e instanceof ApiError && e.unreachable) {
          // No server yet: show demo data rather than an empty screen (clearly labelled in the UI).
          enableFixtureMode();
          if (!disposed) startFixture();
          return;
        }
        setError((e as Error).message);
      }
      if (!disposed) { setMode('polling'); connect(); }
    })();

    return () => {
      disposed = true;
      clearTimeout(retryTimer);
      unsubscribeFixture?.();
      if (socket) { socket.onclose = null; try { socket.close(); } catch { /* noop */ } }
    };
  }, [wsId, loadSnapshot]);

  // Polling fallback: snapshot every 2 s, panel data at each panel's refresh interval.
  useEffect(() => {
    if (mode !== 'polling' || !wsId) return;
    const snap = setInterval(() => { loadSnapshot().catch(e => setError((e as Error).message)); }, 2000);
    const lastPoll: Record<string, number> = {};
    const panels = setInterval(() => {
      const ws = stateRef.current.workspace;
      if (!ws) return;
      const now = Date.now();
      for (const p of ws.panels) {
        const every = Math.max(5, p.refreshSec || 10) * 1000;
        if (now - (lastPoll[p.id] ?? 0) < every) continue;
        lastPoll[p.id] = now;
        refreshPanel(wsId, p.id).then(d => dispatch({ type: 'msg', m: { type: 'panel-data', panelId: p.id, data: d.data, at: d.at } }))
          .catch(e => dispatch({ type: 'msg', m: { type: 'panel-data', panelId: p.id, data: undefined, at: new Date().toISOString(), error: (e as Error).message } }));
      }
    }, 1000);
    return () => { clearInterval(snap); clearInterval(panels); };
  }, [mode, wsId, loadSnapshot]);

  return { state, mode, error, reload: loadSnapshot, applyMessage };
}

export function refreshPanel(wsId: string, panelId: string) {
  return api<{ data: unknown; at: string }>(`/workspaces/${encodeURIComponent(wsId)}/panels/${encodeURIComponent(panelId)}/refresh`, { method: 'POST' });
}

/** Re-render every `ms` (for "Updated 4s ago" labels). */
export function useNow(ms = 1000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(t);
  }, [ms]);
  return now;
}

/** Current identity, kept in sync with the switcher. */
export function useUser(): string {
  const [user, setUserState] = useState('arnab');
  useEffect(() => {
    setUserState(currentUser());
    const on = (e: Event) => setUserState((e as CustomEvent<string>).detail);
    window.addEventListener('prism:user', on);
    return () => window.removeEventListener('prism:user', on);
  }, []);
  return user;
}

/** "?fixture=1" when in demo-data mode. Empty during SSR/hydration so server and client markup match. */
export function useFixtureSuffix(mode?: LiveMode): string {
  const [q, setQ] = useState('');
  useEffect(() => { setQ(fixtureMode() ? '?fixture=1' : ''); }, [mode]);
  return q;
}
