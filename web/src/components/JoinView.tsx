'use client';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import { Decor } from './Decor.tsx';
import { Icon, Logo } from './Icon.tsx';
import { PanelCard } from './PanelCard.tsx';
import { CustomizeBar, PersonalStrip } from './PersonalView.tsx';
import { Badge, LiveDot } from './ui.tsx';
import { api, fixtureMode, setUser } from '../lib/api.ts';
import { useConnectionNames } from '../lib/connections.ts';
import { cap, clock, timeAgo } from '../lib/format.ts';
import type { Decision } from '../lib/types.ts';
import { useNow, useWorkspaceSocket, useFixtureSuffix } from '../lib/useWorkspaceSocket.ts';

/** The judge's phone: join one workspace as an approver. */
export function JoinView({ wsId }: { wsId: string }) {
  const [user, setReadyUser] = useState<string | null>(null);
  useEffect(() => {
    const as = new URLSearchParams(window.location.search).get('as');
    const u = as || 'judge';
    setUser(u);
    setReadyUser(u);
  }, []);
  if (!user) return <div className="join-page"><Decor variant="phone" /><div className="empty-state"><span className="spinner" />Joining…</div></div>;
  return <JoinInner wsId={wsId} user={user} />;
}

function JoinInner({ wsId, user }: { wsId: string; user: string }) {
  const now = useNow(1000);
  const { state, mode, error, applyMessage } = useWorkspaceSocket(wsId);
  const [viewNote, setViewNote] = useState<{ text: string; ok: boolean }>();
  const router = useRouter();
  // Record actions on the phone: same as desktop — PRISM looks the record up, creates a decision, and you review it.
  const onRecordAction = async (panelId: string, actionId: string, record: Record<string, unknown>) => {
    try {
      const d = await api<{ id: string }>(`/workspaces/${wsId}/panels/${panelId}/actions`, { body: { actionId, record } });
      router.push(`/decide/${d.id}${q}`);
    } catch (e) {
      setViewNote({ text: `Couldn't start that action: ${(e as Error).message}`, ok: false });
    }
  };
  const { workspace, decisions, incidents, panelData } = state;
  const names = useConnectionNames();
  const [perm, setPerm] = useState<NotificationPermission | 'unsupported'>('default');
  const q = useFixtureSuffix(mode);

  useEffect(() => {
    setPerm(typeof Notification === 'undefined' ? 'unsupported' : Notification.permission);
  }, []);

  const pending = decisions.filter(d => d.status === 'pending').sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  const recent = decisions.filter(d => d.status !== 'pending').sort((a, b) => ((a.decidedAt ?? a.createdAt) < (b.decidedAt ?? b.createdAt) ? 1 : -1)).slice(0, 3);
  const investigating = incidents.filter(i => i.status !== 'resolved' && !pending.some(d => d.incidentId === i.id));

  // Alert on a newly arrived pending decision (not on the ones already there when the page opened).
  const seen = useRef<Set<string> | null>(null);
  useEffect(() => {
    if (mode === 'connecting') return;
    const ids = new Set(pending.map(d => d.id));
    if (seen.current === null) {
      // First batch: give the socket's hello a moment before treating anything as "new".
      const t = setTimeout(() => { seen.current = new Set(pending.map(d => d.id)); }, 1500);
      return () => clearTimeout(t);
    }
    for (const d of pending) {
      if (!seen.current.has(d.id)) alertNewDecision(d, `${window.location.origin}/decide/${d.id}${q}`);
    }
    seen.current = new Set([...seen.current, ...ids]);
  }, [pending, mode, q]);

  const enableAlerts = async () => {
    primeAudio();
    if (typeof Notification === 'undefined') return;
    try { setPerm(await Notification.requestPermission()); } catch { /* noop */ }
  };

  return (
    <div className="join-page">
      <Decor variant="phone" />
      <div className="join-shell">
        <header className="join-head">
          <Logo small />
          <span className="spacer" />
          <span className="me-chip"><span className="avatar sm">{user[0].toUpperCase()}</span>{cap(user)}</span>
        </header>
        <div className="join-title">
          <div className="mono eyebrow">Approver · one workspace</div>
          <h1>{workspace?.title ?? (error ? 'Workspace' : 'Joining…')}</h1>
          <LiveDot mode={mode} />
        </div>

        {perm !== 'granted' && perm !== 'unsupported' && (
          <button className="alert-optin" onClick={enableAlerts}><Icon name="bell" size={16} /><span>Turn on alerts for new approvals</span><Icon name="chevron-right" size={14} /></button>
        )}
        {perm === 'unsupported' && <button className="alert-optin" onClick={primeAudio}><Icon name="bell" size={16} /><span>Tap once to allow a sound for new approvals</span></button>}

        {error && !workspace && <div className="empty-state"><Icon name="circle-alert" size={20} /><b>Couldn&apos;t join</b><span>{error}</span></div>}

        {pending.map(d => {
          const inc = incidents.find(i => i.id === d.incidentId);
          return (
            <Link key={d.id} href={`/decide/${d.id}${q}`} className="approval-card">
              <div className="ap-top">
                <span className="pulse pulse-warn" />
                <span className="ap-kicker">Approval needed</span>
                <span className="spacer" />
                <span className="mono small muted">{timeAgo(d.createdAt, now)}</span>
              </div>
              <div className="ap-title">{d.title}</div>
              <p className="ap-sum">{d.summary}</p>
              <div className="ap-tags">
                {inc && <Badge tone="danger">Incident #{inc.number}</Badge>}
                {d.source === 'playbook' ? <Badge tone="success" icon="repeat">Playbook · 0 model calls</Badge> : d.source === 'agent' ? <Badge tone="accent" icon="sparkles">Found by the agent</Badge> : <Badge tone="muted">From a panel</Badge>}
              </div>
              <div className="ap-cta">Review and approve<Icon name="arrow-right" size={15} /></div>
            </Link>
          );
        })}

        {investigating.map(i => (
          <div key={i.id} className="approval-card is-quiet">
            <div className="ap-top"><span className="spinner" /><span className="ap-kicker">Incident #{i.number} · agent investigating</span></div>
            <div className="ap-title small-title">{i.resource} · {i.reason}</div>
            <p className="ap-sum">A decision will appear here in a few seconds. Nothing runs without your approval.</p>
          </div>
        ))}

        {workspace && pending.length === 0 && investigating.length === 0 && (
          <div className="all-clear">
            <span className="soft-ic s-ok"><Icon name="circle-check" size={18} /></span>
            <div><b>All clear</b><span>When something needs your approval, it shows up here{perm === 'granted' ? ' and as a notification' : ''}.</span></div>
          </div>
        )}

        {recent.length > 0 && (
          <div className="recent">
            <div className="mono eyebrow">Recent decisions</div>
            {recent.map(d => (
              <Link key={d.id} href={`/decide/${d.id}${q}`} className="recent-row">
                <Icon name={d.status === 'executed' ? 'circle-check' : d.status === 'rejected' ? 'undo' : d.status === 'failed' ? 'circle-x' : 'clock'} size={15} className={d.status === 'executed' ? 'c-ok' : d.status === 'failed' ? 'c-bad' : 'c-muted'} />
                <span className="ellipsis">{d.title}</span>
                <span className="spacer" />
                <span className="mono small muted">{d.decidedBy ? `${cap(d.decidedBy)} · ` : ''}{clock(d.decidedAt ?? d.createdAt)}</span>
              </Link>
            ))}
          </div>
        )}

        {workspace && (
          <div className="join-customize">
            <div className="mono eyebrow">Your view</div>
            {workspace.personal && <PersonalStrip workspace={workspace} compact onChanged={w => applyMessage({ type: 'workspace', workspace: w })} />}
            <CustomizeBar workspace={workspace} onDone={(text, ok) => setViewNote({ text, ok })} />
            {viewNote && <div className={`view-note ${viewNote.ok ? 'ok' : 'bad'}`}>{viewNote.text}</div>}
          </div>
        )}

        {workspace && workspace.panels.length > 0 && (
          <div className="join-panels">
            <div className="mono eyebrow">Live panels</div>
            {[...workspace.panels].sort((a, b) => a.layout.y - b.layout.y || a.layout.x - b.layout.x).map(p => (
              <div key={p.id} className="join-panel">
                <PanelCard panel={p} datum={panelData[p.id]} sourceName={names[p.binding.connectionId] ?? p.binding.connectionId} now={now} compact onRecordAction={onRecordAction} />
              </div>
            ))}
          </div>
        )}
        <div className="join-foot"><Icon name="key" size={12} />Approvals are signed for {cap(user)} and checked again at agentgateway.</div>
      </div>
    </div>
  );
}

let audioCtx: AudioContext | null = null;
function primeAudio() {
  try {
    const Ctx = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!audioCtx && Ctx) audioCtx = new Ctx();
    void audioCtx?.resume();
  } catch { /* noop */ }
}
function chime() {
  try {
    primeAudio();
    const ctx = audioCtx;
    if (!ctx) return;
    [880, 1320].forEach((f, i) => {
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      o.type = 'sine';
      o.frequency.value = f;
      const t = ctx.currentTime + i * 0.14;
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(0.18, t + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.35);
      o.connect(g).connect(ctx.destination);
      o.start(t);
      o.stop(t + 0.4);
    });
  } catch { /* noop */ }
}
function alertNewDecision(d: Decision, url: string) {
  chime();
  try { navigator.vibrate?.([120, 60, 120]); } catch { /* noop */ }
  try {
    if (typeof Notification !== 'undefined' && Notification.permission === 'granted') {
      const n = new Notification(`Approval needed: ${d.title}`, { body: d.summary, tag: d.id });
      n.onclick = () => { window.focus(); window.location.href = url; };
    }
  } catch { /* some mobile browsers only allow notifications from a service worker */ }
}
