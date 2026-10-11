'use client';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import ReactGridLayout, { useContainerWidth, type Layout as GridLayout } from 'react-grid-layout';
import { Decor } from './Decor.tsx';
import { Icon } from './Icon.tsx';
import { PanelCard } from './PanelCard.tsx';
import { Rail } from './Rail.tsx';
import { PersonalStrip } from './PersonalView.tsx';
import { Badge, LiveDot, QrModal, useToasts } from './ui.tsx';
import { api, ApiError, fixtureMode } from '../lib/api.ts';
import { calls, clock, receiptLine, usd } from '../lib/format.ts';
import type { Activity, ActivityKind, Decision, Incident, Layout, Receipt, Workspace } from '../lib/types.ts';
import { useNow, useUser, useWorkspaceSocket, useFixtureSuffix } from '../lib/useWorkspaceSocket.ts';
import { useConnectionNames } from '../lib/connections.ts';

// Server composer assumes a 12-column grid with rows of ~60px (h 2 for metric rows, 4–6 for tables/charts).
const GRID = { cols: 12, rowHeight: 64, margin: [14, 14] as const, containerPadding: [0, 0] as const };

export function WorkspaceView({ id }: { id: string }) {
  const router = useRouter();
  const user = useUser();
  const now = useNow(1000);
  const { state, mode, error, reload, applyMessage } = useWorkspaceSocket(id);
  const { workspace, incidents, decisions, playbooks, stats, panelData, activity } = state;
  const [inspector, setInspector] = useState(false);
  const [share, setShare] = useState(false);
  const [railOpen, setRailOpen] = useState(false);
  const [composing, setComposing] = useState<string | null>(null);
  const [connKey, setConnKey] = useState(0);
  const connections = useConnectionNames(connKey || undefined);
  const { push: toast, view: toastView } = useToasts();
  const q = useFixtureSuffix(mode);

  // ---- compose (from the landing page `?compose=` or the chat bar)
  const compose = useCallback(async (prompt: string) => {
    setComposing(prompt);
    try {
      const r = await api<{ summary: string; receipt: Receipt; workspace: Workspace }>(`/workspaces/${id}/compose`, { body: { prompt } });
      if (r.workspace) applyMessage({ type: 'workspace', workspace: r.workspace });
      toast({ text: r.summary, tone: 'ok', sub: r.receipt ? receiptLine(r.receipt) : undefined }, 9000);
    } catch (e) {
      toast({ text: (e as Error).message, tone: 'bad' }, 8000);
    } finally {
      setComposing(null);
    }
  }, [id, applyMessage, toast]);

  const composeStarted = useRef(false);
  useEffect(() => {
    if (composeStarted.current) return;
    const params = new URLSearchParams(window.location.search);
    const prompt = params.get('compose');
    if (!prompt) return;
    composeStarted.current = true;
    const key = `prism.composed.${id}.${prompt}`;
    params.delete('compose');
    const rest = params.toString();
    window.history.replaceState(null, '', `${window.location.pathname}${rest ? `?${rest}` : ''}`);
    try { if (sessionStorage.getItem(key)) return; sessionStorage.setItem(key, '1'); } catch { /* noop */ }
    void compose(prompt);
  }, [id, compose]);

  // ---- record actions → a pending decision → open the decision surface
  const onRecordAction = useCallback(async (panelId: string, actionId: string, record: Record<string, unknown>) => {
    try {
      const d = await api<Decision>(`/workspaces/${id}/panels/${panelId}/actions`, { body: { actionId, record } });
      router.push(`/decide/${d.id}${q}`);
    } catch (e) {
      toast({ text: (e as Error).message, tone: 'bad' });
    }
  }, [id, router, q, toast]);

  // ---- layout persistence
  const baseVersion = useRef(0);
  baseVersion.current = workspace?.version ?? 0;
  const saveTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const onLayoutChange = useCallback((layout: GridLayout) => {
    if (!workspace) return;
    const ops = layout
      .map(l => {
        const p = workspace.panels.find(x => x.id === l.i);
        if (!p) return null;
        const next: Layout = { x: l.x, y: l.y, w: l.w, h: l.h };
        const cur = p.layout;
        return cur.x === next.x && cur.y === next.y && cur.w === next.w && cur.h === next.h ? null : { op: 'move_resize' as const, panelId: p.id, layout: next };
      })
      .filter(Boolean);
    if (!ops.length) return;
    clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(async () => {
      try {
        const ws = await api<Workspace>(`/workspaces/${id}/ops`, { body: { baseVersion: baseVersion.current, ops } });
        applyMessage({ type: 'workspace', workspace: ws });
      } catch (e) {
        if (e instanceof ApiError && e.status === 409) void reload();
        else toast({ text: `Couldn't save the layout: ${(e as Error).message}`, tone: 'bad' });
      }
    }, 350);
  }, [workspace, id, applyMessage, reload, toast]);

  // ---- rename (owner): a rename_workspace op, atomic and versioned like every other edit
  const rename = useCallback(async (title: string) => {
    try {
      const ws = await api<Workspace>(`/workspaces/${id}/ops`, { body: { baseVersion: baseVersion.current, ops: [{ op: 'rename_workspace', title }] } });
      applyMessage({ type: 'workspace', workspace: ws });
    } catch (e) {
      if (e instanceof ApiError && e.status === 409) void reload();
      toast({ text: `Couldn't rename: ${(e as Error).message}`, tone: 'bad' });
    }
  }, [id, applyMessage, reload, toast]);

  const openIncidents = incidents.filter(i => i.status !== 'resolved');
  const investigate = useCallback(async (incidentId: string) => {
    try {
      toast({ text: 'Waking the investigate agent…', sub: 'It reads the systems, then sends you a decision. Usually 15–30 s.', tone: 'ok' }, 5000);
      const r = await api<{ status?: string; message?: string; title?: string }>(`/incidents/${incidentId}/investigate`, { method: 'POST' });
      if (r.title) toast({ text: `Decision ready: ${r.title}`, tone: 'ok' }, 8000);
      else if (r.message) toast({ text: r.message, tone: r.status === 'no-decision' ? 'bad' : 'ok' }, 7000);
    } catch (e) {
      toast({ text: (e as Error).message, tone: 'bad' });
    }
  }, [toast]);
  const firingByPanel = useMemo(() => {
    const out: Record<string, string> = {};
    for (const inc of openIncidents) {
      const w = workspace?.watchers.find(x => x.id === inc.watcherId);
      if (w) out[w.panelId] = w.title;
    }
    return out;
  }, [openIncidents, workspace]);
  const pending = decisions.filter(d => d.status === 'pending');

  const [shareUrl, setShareUrl] = useState('');
  useEffect(() => { setShareUrl(`${window.location.origin}/j/${id}${q}`); }, [id, q]);

  return (
    <div className="app">
      <Decor variant="app" />
      <Rail mode={mode} activeId={id} activeTitle={workspace?.title} user={user} playbooks={playbooks} open={railOpen} onClose={() => setRailOpen(false)}
        onConnected={c => { setConnKey(k => k + 1); toast({ text: `Connected ${c.name} · ${c.tools.length} tools`, tone: 'ok' }); }} />
      <main className="main">
        <header className="topbar">
          <button className="icon-btn only-mobile" onClick={() => setRailOpen(true)} aria-label="Menu"><Icon name="menu" /></button>
          <span className="mono crumb hide-mobile">Workspaces /</span>
          {workspace && workspace.owner === user
            ? <EditableTitle title={workspace.title} onSave={rename} />
            : <h1 className="ws-title ellipsis">{workspace?.title ?? (error ? 'Workspace' : 'Loading…')}</h1>}
          <LiveDot mode={composing ? 'connecting' : mode} />
          <span className="spacer" />
          <ReceiptChip workspace={workspace} refreshes={stats?.refreshes ?? 0} />
          <button className={`btn btn-ghost btn-sm hide-mobile ${inspector ? 'is-on' : ''}`} onClick={() => setInspector(v => !v)}>
            <Icon name="panel" size={14} />Inspector
          </button>
          <button className="btn btn-primary btn-sm" onClick={() => setShare(true)}><Icon name="share" size={14} />Share</button>
        </header>

        {workspace?.personal && <PersonalStrip workspace={workspace} onChanged={w => applyMessage({ type: 'workspace', workspace: w })} />}
        {openIncidents.length > 0 && <IncidentStack incidents={openIncidents} decisions={decisions} q={q} onInvestigate={investigate} />}
        {pending.filter(d => !d.incidentId).map(d => (
          <Link key={d.id} href={`/decide/${d.id}${q}`} className="banner banner-accent">
            <Icon name="key" size={15} /><b>Approval needed</b><span className="ellipsis">{d.title}</span><span className="spacer" /><span className="banner-cta">Review<Icon name="arrow-right" size={14} /></span>
          </Link>
        ))}

        <div className="canvas">
          {error && !workspace && <div className="empty-state"><Icon name="circle-alert" size={20} /><b>Couldn&apos;t open this workspace</b><span>{error}</span></div>}
          {composing && !workspace?.panels.length && <ComposingState prompt={composing} activity={activity} />}
          {workspace && (workspace.panels.length > 0 ? (
            <Grid workspace={workspace} panelData={panelData} connections={connections} firing={firingByPanel} now={now}
              onLayoutChange={onLayoutChange} onRecordAction={onRecordAction} />
          ) : !composing && (
            <div className="empty-state"><Icon name="sparkles" size={20} /><b>An empty workspace</b><span>Describe what you want to watch in the bar below.</span></div>
          ))}
        </div>

        <ChatBar busy={!!composing} onSend={compose} personal={!!workspace?.personal} />
      </main>
      {inspector && <Inspector activity={activity} stats={stats} onClose={() => setInspector(false)} />}
      <QrModal open={share} onClose={() => setShare(false)} url={shareUrl} title={workspace?.title ?? 'this workspace'} />
      {toastView}
    </div>
  );
}

function Grid({ workspace, panelData, connections, firing, now, onLayoutChange, onRecordAction }: {
  workspace: Workspace;
  panelData: ReturnType<typeof useWorkspaceSocket>['state']['panelData'];
  connections: Record<string, string>;
  firing: Record<string, string>;
  now: number;
  onLayoutChange: (l: GridLayout) => void;
  onRecordAction: (panelId: string, actionId: string, record: Record<string, unknown>) => void;
}) {
  const { width, containerRef, mounted } = useContainerWidth({ measureBeforeMount: true });
  const layout = useMemo(() => workspace.panels.map(p => ({ i: p.id, ...p.layout, minW: 3, minH: 2 })), [workspace.panels]);
  const name = (cid: string) => connections[cid] ?? cid;
  const narrow = mounted && width < 760;
  return (
    <div ref={containerRef} className="grid-host">
      {mounted && (narrow ? (
        <div className="stack">
          {[...workspace.panels].sort((a, b) => a.layout.y - b.layout.y || a.layout.x - b.layout.x).map(p => (
            <div key={p.id} style={{ minHeight: Math.max(150, p.layout.h * 66) }} className="stack-item">
              <PanelCard panel={p} datum={panelData[p.id]} sourceName={name(p.binding.connectionId)} firing={firing[p.id]} now={now} onRecordAction={onRecordAction} />
            </div>
          ))}
        </div>
      ) : (
        <ReactGridLayout layout={layout} width={width} gridConfig={GRID} dragConfig={{ handle: '.drag-handle' }} onLayoutChange={onLayoutChange}>
          {workspace.panels.map(p => (
            <div key={p.id}>
              <PanelCard panel={p} datum={panelData[p.id]} sourceName={name(p.binding.connectionId)} firing={firing[p.id]} now={now} onRecordAction={onRecordAction} draggable />
            </div>
          ))}
        </ReactGridLayout>
      ))}
    </div>
  );
}

function ReceiptChip({ workspace, refreshes }: { workspace?: Workspace; refreshes: number }) {
  const r = workspace?.buildReceipt;
  if (!workspace) return null;
  return (
    <span className="receipt-chip" title="What the model cost vs. what PRISM ran without it">
      <span className="rc-part">Built for <b>{usd(r?.costUsd)}</b> · {calls(r?.modelCalls)}</span>
      <span className="rc-sep" />
      <span className="rc-part rc-free"><b>{refreshes.toLocaleString()}</b> refreshes since · <b>0 model calls</b></span>
    </span>
  );
}

const STATUS_RANK: Record<string, number> = { 'awaiting-approval': 0, resolving: 1, investigating: 2, open: 3 };

/** One banner for the most urgent incident; the rest fold into a compact, expandable row so the dashboard stays visible. */
function IncidentStack({ incidents, decisions, q, onInvestigate }: {
  incidents: Incident[]; decisions: Decision[]; q: string; onInvestigate: (id: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const sorted = [...incidents].sort((a, b) => (STATUS_RANK[a.status] ?? 9) - (STATUS_RANK[b.status] ?? 9) || b.number - a.number);
  const [top, ...rest] = sorted;
  const byReason = rest.reduce<Record<string, number>>((m, i) => ({ ...m, [i.reason]: (m[i.reason] ?? 0) + 1 }), {});
  const find = (i: Incident) => decisions.find(d => d.id === i.decisionId);
  return (
    <div className="incident-stack">
      <IncidentBanner incident={top} decision={find(top)} q={q} onInvestigate={onInvestigate} />
      {rest.length > 0 && (
        <button className="incident-more" onClick={() => setOpen(v => !v)} aria-expanded={open}>
          <span className="pulse pulse-danger" />
          <b>+{rest.length} more incident{rest.length === 1 ? '' : 's'}</b>
          <span className="muted ellipsis">{Object.entries(byReason).map(([r, n]) => `${n} ${r}`).join(' · ')}</span>
          <span className="spacer" />
          <span className="banner-cta muted">{open ? 'Hide' : 'Show all'}<Icon name={open ? 'chevron-up' : 'chevron-down'} size={14} /></span>
        </button>
      )}
      {open && rest.length > 0 && (
        <div className="incident-list">
          {rest.map(inc => <IncidentBanner key={inc.id} incident={inc} decision={find(inc)} q={q} onInvestigate={onInvestigate} compact />)}
        </div>
      )}
    </div>
  );
}

function IncidentBanner({ incident, decision, q, onInvestigate, compact }: {
  incident: Incident; decision?: Decision; q: string; onInvestigate: (id: string) => void; compact?: boolean;
}) {
  const waiting = incident.status === 'awaiting-approval' || decision?.status === 'pending';
  const resolving = incident.status === 'resolving' || decision?.status === 'approved';
  const investigating = incident.status === 'investigating';
  const idle = !waiting && !resolving && !investigating && !decision; // open, no agent run (e.g. cooldown): a person can start one
  const state = waiting ? 'Decision waiting' : resolving ? 'Fix running…' : decision?.source === 'playbook' ? 'Replaying playbook…' : investigating ? 'Agent investigating…' : '';
  const body = (
    <>
      <span className="pulse pulse-danger" />
      <b>Incident #{incident.number}</b>
      <span className="mono hide-mobile ellipsis">{incident.resource}</span>
      <span className="banner-reason">{incident.reason}</span>
      <span className="spacer" />
      {decision?.source === 'playbook' && <Badge tone="success" icon="repeat">0 model calls</Badge>}
      {idle ? (
        <button className="btn btn-ghost btn-sm banner-btn" onClick={e => { e.preventDefault(); onInvestigate(incident.id); }}>
          <Icon name="sparkles" size={13} />Investigate
        </button>
      ) : (
        <span className={`banner-cta ${waiting ? '' : 'muted'}`}>
          {!waiting && <span className="spinner" />}
          {state}
          {waiting && <Icon name="arrow-right" size={14} />}
        </span>
      )}
    </>
  );
  const cls = `banner banner-danger ${compact ? 'banner-compact' : ''}`;
  return waiting && incident.decisionId ? <Link href={`/decide/${incident.decisionId}${q}`} className={cls}>{body}</Link> : <div className={cls}>{body}</div>;
}

function ChatBar({ busy, onSend, personal }: { busy: boolean; onSend: (p: string) => void; personal?: boolean }) {
  const [text, setText] = useState('');
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const on = (e: KeyboardEvent) => { if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); ref.current?.focus(); } };
    window.addEventListener('keydown', on);
    return () => window.removeEventListener('keydown', on);
  }, []);
  return (
    <form className={`chatbar ${busy ? 'is-busy' : ''}`} onSubmit={e => { e.preventDefault(); if (!text.trim() || busy) return; onSend(text.trim()); setText(''); }}>
      <Icon name="sparkles" size={16} className="chat-ic" />
      <input ref={ref} value={text} onChange={e => setText(e.target.value)} placeholder={busy ? 'Composing… the inspector shows each step' : personal ? 'Customize your view: “only my teams, as cards”, “hide the schedule”…' : 'Change this workspace: “add warning events”, “make CPU full width”…'} disabled={busy} />
      <span className="mono kbd hide-mobile">⌘K</span>
      <button className="send" disabled={busy || !text.trim()} aria-label="Send">{busy ? <span className="spinner spinner-dark" /> : <Icon name="arrow-up" size={15} strokeWidth={2.2} />}</button>
    </form>
  );
}

function ComposingState({ prompt, activity }: { prompt: string; activity: Activity[] }) {
  return (
    <div className="composing">
      <div className="composing-head"><span className="spinner" />Building your workspace</div>
      <div className="composing-prompt">“{prompt}”</div>
      <div className="composing-steps">
        {activity.slice(0, 6).map(a => (
          <div key={a.id} className={`act act-${a.kind}`}><ActIcon kind={a.kind} /><span>{a.text}</span></div>
        ))}
      </div>
    </div>
  );
}

const ACT_ICON: Record<ActivityKind, string> = {
  model: 'sparkles', tool: 'wrench', validate: 'circle-check', gateway: 'shield', refresh: 'refresh', incident: 'alert',
  decision: 'key', playbook: 'book', info: 'info', error: 'circle-alert',
};
export function ActIcon({ kind }: { kind: ActivityKind }) {
  return <span className={`act-ic k-${kind}`}><Icon name={ACT_ICON[kind] ?? 'dot'} size={13} /></span>;
}

function Inspector({ activity, stats, onClose }: { activity: Activity[]; stats?: { refreshes: number; modelCalls: number; costUsd: number }; onClose: () => void }) {
  const [hideRefresh, setHideRefresh] = useState(true);
  const items = hideRefresh ? activity.filter(a => a.kind !== 'refresh') : activity;
  return (
    <aside className="inspector">
      <div className="insp-head">
        <h3>Inspector</h3>
        <span className="spacer" />
        <button className="icon-btn" onClick={onClose} aria-label="Close inspector"><Icon name="x" /></button>
      </div>
      <div className="insp-stats">
        <div><span className="mono">MODEL CALLS</span><b>{stats?.modelCalls ?? 0}</b></div>
        <div><span className="mono">SPENT</span><b>{usd(stats?.costUsd)}</b></div>
        <div><span className="mono">FREE REFRESHES</span><b>{(stats?.refreshes ?? 0).toLocaleString()}</b></div>
      </div>
      <label className="insp-toggle"><input type="checkbox" checked={!hideRefresh} onChange={e => setHideRefresh(!e.target.checked)} />Show refreshes</label>
      <div className="insp-feed">
        {items.length === 0 && <div className="muted small">Activity appears here: model calls, tool calls, validation, gateway checks.</div>}
        {items.map(a => (
          <div key={a.id} className={`act act-${a.kind}`}>
            <ActIcon kind={a.kind} />
            <div className="act-main">
              <span className="act-text">{a.text}</span>
              <span className="mono act-time">{clock(a.at)} · {a.kind}</span>
            </div>
          </div>
        ))}
      </div>
    </aside>
  );
}

/** Click to rename; Enter saves, Escape cancels. */
function EditableTitle({ title, onSave }: { title: string; onSave: (t: string) => Promise<void> }) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(title);
  useEffect(() => { if (!editing) setValue(title); }, [title, editing]);
  const commit = async () => {
    const t = value.trim().slice(0, 80);
    setEditing(false);
    if (t && t !== title) await onSave(t);
  };
  if (!editing)
    return (
      <button className="ws-title ws-title-edit ellipsis" title="Rename workspace" onClick={() => setEditing(true)}>
        {title}<Icon name="pencil" size={13} />
      </button>
    );
  return (
    <input className="ws-title-input" value={value} autoFocus aria-label="Workspace name" maxLength={80}
      onChange={e => setValue(e.target.value)} onBlur={() => void commit()}
      onKeyDown={e => { if (e.key === 'Enter') void commit(); if (e.key === 'Escape') { setValue(title); setEditing(false); } }} />
  );
}
