'use client';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Decor } from './Decor.tsx';
import { Icon, Logo } from './Icon.tsx';
import { PanelCard } from './PanelCard.tsx';
import { Badge, HoldButton, IdentitySwitch, LiveDot, useToasts } from './ui.tsx';
import { api, fixtureMode } from '../lib/api.ts';
import { calls, cap, clock, duration, receiptLine, usd } from '../lib/format.ts';
import type { Decision, DecisionStatus, Incident, Panel, Playbook, Receipt, Workspace } from '../lib/types.ts';
import { useConnectionNames } from '../lib/connections.ts';
import { refreshPanel, useNow, useUser, useWorkspaceSocket, type PanelDatum, useFixtureSuffix } from '../lib/useWorkspaceSocket.ts';

interface Bundle { decision: Decision; incident?: Incident; playbook?: Playbook; workspace?: { id: string; title: string; owner: string } }
const RANK: Record<DecisionStatus, number> = { pending: 0, approved: 1, rejected: 2, executed: 3, failed: 3 };
const fresher = (a?: Decision, b?: Decision) => (!a ? b : !b ? a : RANK[b.status] > RANK[a.status] || (RANK[b.status] === RANK[a.status] && !!b.playbookId && !a.playbookId) ? b : a);

export function DecisionView({ id }: { id: string }) {
  const user = useUser();
  const now = useNow(1000);
  const names = useConnectionNames();
  const [bundle, setBundle] = useState<Bundle>();
  const [loadError, setLoadError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [rejecting, setRejecting] = useState(false);
  const [note, setNote] = useState('');
  const [showRequest, setShowRequest] = useState(false);
  const { push: toast, view: toastView } = useToasts();
  const router = useRouter();

  const load = useCallback(async () => {
    try {
      const b = await api<Bundle>(`/decisions/${encodeURIComponent(id)}`);
      setBundle(prev => (prev ? { ...b, decision: fresher(prev.decision, b.decision)! } : b));
      setLoadError(undefined);
    } catch (e) {
      setLoadError((e as Error).message);
    }
  }, [id]);
  useEffect(() => { void load(); }, [load]);

  const live = useWorkspaceSocket(bundle?.decision.workspaceId);
  const q = useFixtureSuffix(live.mode);
  const decision = fresher(bundle?.decision, live.state.decisions.find(d => d.id === id));
  const incident = live.state.incidents.find(i => i.id === decision?.incidentId) ?? bundle?.incident;
  const playbook = live.state.playbooks.find(p => p.id === decision?.playbookId) ?? bundle?.playbook;
  const workspace = live.state.workspace;
  const wsInfo = workspace ?? bundle?.workspace;

  // Poll the decision when the socket isn't live (phone through a tunnel), and while a fix is running.
  const revising = decision?.status === 'rejected' && !!decision.note && !!decision.incidentId && !decision.supersededBy;
  const inFlight = decision?.status === 'approved' || revising;
  useEffect(() => {
    if (!bundle || (live.mode === 'live' && !inFlight) || live.mode === 'fixture') return;
    const t = setInterval(() => { void load(); }, 2000);
    return () => clearInterval(t);
  }, [bundle, live.mode, inFlight, load]);

  // When the agent's revision arrives, follow it.
  useEffect(() => {
    if (decision?.status === 'rejected' && decision.supersededBy) router.replace(`/decide/${decision.supersededBy}${q}`);
  }, [decision?.status, decision?.supersededBy, q, router]);

  const evidence = useEvidence(decision?.workspaceId, decision?.evidence ?? [], live.state.panelData, live.mode);

  const approve = async () => {
    if (!decision) return;
    setBusy(true);
    try {
      const d = await api<Decision>(`/decisions/${decision.id}/approve`, { method: 'POST' });
      setBundle(b => (b ? { ...b, decision: fresher(b.decision, d)! } : b));
      void load();
    } catch (e) {
      toast({ text: (e as Error).message, tone: 'bad' }, 9000);
    } finally {
      setBusy(false);
    }
  };
  const reject = async () => {
    if (!decision) return;
    setBusy(true);
    try {
      const d = await api<Decision>(`/decisions/${decision.id}/reject`, { body: { note: note.trim() || undefined } });
      setBundle(b => (b ? { ...b, decision: fresher(b.decision, d)! } : b));
      setRejecting(false);
    } catch (e) {
      toast({ text: (e as Error).message, tone: 'bad' });
    } finally {
      setBusy(false);
    }
  };
  const savePlaybook = async () => {
    if (!decision) return;
    setBusy(true);
    try {
      const pb = await api<Playbook>(`/decisions/${decision.id}/playbook`, { method: 'POST' });
      setBundle(b => (b ? { ...b, playbook: pb, decision: { ...fresher(b.decision, decision)!, playbookId: pb.id } } : b));
      toast({ text: `Saved “${pb.title}”`, sub: 'Next time this happens, the fix shows up in about a second with 0 model calls.', tone: 'ok' }, 8000);
    } catch (e) {
      toast({ text: (e as Error).message, tone: 'bad' });
    } finally {
      setBusy(false);
    }
  };

  if (!decision) {
    return (
      <div className="decide-page">
        <Decor variant="stage" />
        <div className="decide-shell">
          <DecideNav q={q} user={user} />
          <div className="empty-state">{loadError ? <><Icon name="circle-alert" size={20} /><b>Couldn&apos;t open this decision</b><span>{loadError}</span></> : <><span className="spinner" /><span>Loading decision…</span></>}</div>
        </div>
      </div>
    );
  }

  const replay = decision.source === 'playbook';
  const done = decision.status === 'executed' || decision.status === 'failed';
  const owner = wsInfo ? wsInfo.owner === user : user === 'arnab';
  // A corrected fix can replace a playbook that came from the agent's own first idea.
  const canSave = decision.source === 'agent' && decision.status === 'executed' && owner &&
    (!playbook ? !decision.playbookId : !!decision.correction && !playbook.origin.correction);
  const eyebrow = replay ? 'Decision · playbook replay' : decision.source === 'agent' ? 'Decision · found by the agent' : decision.source === 'person' ? 'Decision · requested from a panel' : 'Decision';

  return (
    <div className="decide-page">
      <Decor variant={done && decision.status === 'executed' ? 'done' : 'stage'} />
      <div className="decide-shell">
        <DecideNav q={q} user={user} title={wsInfo?.title} wsId={decision.workspaceId} mode={live.mode} />
        <div className="eyebrow mono hide-mobile">{eyebrow}</div>

        <div className="decide-cols">
          <div className="decide-main">
            <div className="tags">
              {incident && <Badge tone="danger">Incident #{incident.number}</Badge>}
              {replay ? <Badge tone="accent" icon="repeat">Playbook replay</Badge> : decision.correction ? <Badge tone="accent" icon="user-check">Revised from {cap(decision.correction.by)}&apos;s note</Badge> : decision.source === 'agent' ? <Badge tone="accent" icon="sparkles">Found by the agent</Badge> : <Badge tone="muted">Requested by a person</Badge>}
              <StatusBadge status={decision.status} />
            </div>
            <h1 className="decide-title">{decision.title}</h1>
            <p className="decide-summary">{decision.summary}</p>

            {replay && (
              <div className="replay-banner">
                <span className="soft-ic"><Icon name="repeat" size={15} /></span>
                <b>Replayed from a saved playbook</b>
                <span className="muted">Matched in {decision.matchMs ?? decision.receipt.ms} ms</span>
                <span className="spacer" />
                <Badge tone="success">0 model calls</Badge>
              </div>
            )}

            {decision.correction && (
              <div className="replay-banner correction-banner">
                <span className="soft-ic"><Icon name="user-check" size={15} /></span>
                <b>Follows {cap(decision.correction.by)}&apos;s correction</b>
                <span className="muted">“{decision.correction.note}”</span>
                <span className="spacer" />
                <Badge tone="accent">same agent, resumed</Badge>
              </div>
            )}

            {done || decision.status === 'approved' ? (
              <DoneCard decision={decision} incident={incident} canSave={canSave} busy={busy} onSave={savePlaybook} playbook={playbook} />
            ) : decision.status === 'rejected' ? (
              <div className="card rejected">
                <div className="card-head"><span className="soft-ic s-muted"><Icon name="undo" size={16} /></span><div><b>Sent back</b><div className="muted small">{decision.decidedBy ? `by ${cap(decision.decidedBy)} · ${clock(decision.decidedAt)}` : ''}</div></div></div>
                {decision.note && <blockquote>“{decision.note}”</blockquote>}
                {revising && incident?.status !== 'resolved'
                  ? <p className="small revising"><span className="spinner" /> The agent is revising the fix with your note…</p>
                  : <p className="muted small">Nothing ran.</p>}
              </div>
            ) : null}

            <section className="evidence">
              <div className="section-head"><h2>Live evidence</h2><span className="muted small">refreshes from the tools, no model</span></div>
              <div className="evidence-grid">
                {decision.evidence.map(p => (
                  <div key={p.id} className={`ev-item ${decision.evidence.length === 1 || (p.layout && p.layout.w >= 12) ? 'ev-wide' : ''}`}>
                    <PanelCard panel={p} datum={evidence[p.id]} sourceName={names[p.binding.connectionId] ?? p.binding.connectionId} now={now} compact />
                  </div>
                ))}
                {decision.evidence.length === 0 && <div className="muted small">No evidence panels attached.</div>}
              </div>
            </section>

            {decision.status === 'pending' && (
              <section className="card action-card">
                <div className="card-head">
                  <span className="soft-ic"><Icon name={/roll\s?back|undo|revert/i.test(decision.proposedAction.label) ? 'undo' : 'zap'} size={16} /></span>
                  <div className="grow">
                    <b className="action-label">{decision.proposedAction.label}</b>
                    <div className="muted small">Runs through agentgateway with your signed approval</div>
                  </div>
                  {replay && <Badge tone="accent" icon="book">From playbook</Badge>}
                </div>
                <div className="will-happen">
                  <div className="wh-title">What will happen</div>
                  {decision.proposedAction.consequences.map((c, i) => (
                    <div key={i} className="check-line"><Icon name="circle-check" size={15} className="c-ok" />{c}</div>
                  ))}
                  {decision.dryRun && (
                    <>
                      <div className="wh-title wh-sub">{decision.dryRun.ok ? 'Dry run passed' : 'Dry run found a problem'}</div>
                      {decision.dryRun.lines.map((l, i) => (
                        <div key={i} className="check-line"><Icon name={decision.dryRun!.ok ? 'shield' : 'circle-alert'} size={15} className={decision.dryRun!.ok ? 'c-ok' : 'c-bad'} />{l}</div>
                      ))}
                    </>
                  )}
                </div>
                <button className="exact-toggle" onClick={() => setShowRequest(v => !v)} aria-expanded={showRequest}>
                  <Icon name={showRequest ? 'chevron-down' : 'chevron-right'} size={13} />Exact request<span className="spacer" /><span className="mono">{decision.proposedAction.tool}</span>
                </button>
                {showRequest && <ExactRequest tool={decision.proposedAction.tool} args={decision.proposedAction.args} />}
                <div className="action-bar">
                  {decision.needsInput?.length
                    ? <NeedsInputForm decision={decision} onFilled={d => setBundle(b => (b ? { ...b, decision: d } : b))} onError={m => toast({ text: m, tone: 'bad' }, 7000)} />
                    : <HoldButton onConfirm={approve} disabled={busy} />}
                  <div className="action-alt">
                    <button className="link-btn" onClick={() => setRejecting(v => !v)}>Ask for a different fix</button>
                    <span className="spacer" />
                    <span className="muted small signed"><Icon name="key" size={12} />Signed as {cap(user)}</span>
                  </div>
                  {rejecting && (
                    <div className="reject-box">
                      <textarea className="input" rows={3} value={note} onChange={e => setNote(e.target.value)} placeholder="What should the agent do instead? e.g. “scale up instead of rolling back”" autoFocus />
                      <div className="row-end">
                        <button className="btn btn-ghost btn-sm" onClick={() => setRejecting(false)}>Cancel</button>
                        <button className="btn btn-danger btn-sm" onClick={reject} disabled={busy}>Send back</button>
                      </div>
                    </div>
                  )}
                </div>
              </section>
            )}
          </div>

          <aside className="decide-side">
            {playbook && <ReceiptCompare playbook={playbook} decision={decision} incident={incident} />}
            {playbook && <PlaybookCard playbook={playbook} workspace={workspace} />}
            {!playbook && (
              <div className="card">
                <div className="card-head"><span className="soft-ic"><Icon name="activity" size={16} /></span><div><b>{decision.incidentId ? 'This incident so far' : 'This request'}</b><div className="muted small">{receiptLine(decision.receipt)}</div></div></div>
                <p className="muted small">{decision.source === 'agent'
                  ? 'The agent investigated with read-only tools and proposed one action. Once approved, it can be saved as a playbook so the next one costs nothing.'
                  : 'A person asked for this action from a panel. It runs only after an approver signs it.'}</p>
              </div>
            )}
            {decision.rationale && (
              <div className="card">
                <div className="wh-title">Why this fix</div>
                <p className="small ink2">{decision.rationale}</p>
              </div>
            )}
          </aside>
        </div>
      </div>
      {toastView}
    </div>
  );
}

function DecideNav({ q, user, title, wsId, mode }: { q: string; user: string; title?: string; wsId?: string; mode?: 'connecting' | 'live' | 'polling' | 'fixture' }) {
  const back = wsId ? (user === 'lead' ? `/j/${wsId}${q}` : `/w/${wsId}${q}`) : `/${q}`;
  return (
    <nav className="decide-nav">
      <Link href={back} className="back"><Icon name="chevron-left" size={18} /><span className="ellipsis">{title ?? 'Back'}</span></Link>
      <span className="spacer" />
      {mode && <span className="hide-mobile"><LiveDot mode={mode} /></span>}
      <span className="hide-mobile"><Logo small /></span>
      <span className="me-chip"><span className="avatar sm">{user[0]?.toUpperCase()}</span>{cap(user)}</span>
    </nav>
  );
}

function StatusBadge({ status }: { status: DecisionStatus }) {
  if (status === 'pending') return <Badge tone="warning" icon="clock">Waiting for approval</Badge>;
  if (status === 'approved') return <Badge tone="accent">Running…</Badge>;
  if (status === 'executed') return <Badge tone="success" icon="check">Done</Badge>;
  if (status === 'failed') return <Badge tone="danger" icon="circle-x">Failed</Badge>;
  return <Badge tone="muted">Sent back</Badge>;
}

function ExactRequest({ tool, args }: { tool: string; args: Record<string, unknown> }) {
  const json = JSON.stringify(args, null, 2);
  return (
    <pre className="code"><span className="c-fn">{tool}</span>(
      {json.split('\n').map((line, i) => <span key={i} className="code-line">{highlight(line)}{'\n'}</span>)}
    )</pre>
  );
}
function highlight(line: string) {
  const m = line.match(/^(\s*)("[^"]+")(:\s*)(.*)$/);
  if (!m) return line;
  return <>{m[1]}<span className="c-key">{m[2]}</span>{m[3]}<span className="c-val">{m[4]}</span></>;
}

function DoneCard({ decision, incident, canSave, busy, onSave, playbook }: { decision: Decision; incident?: Incident; canSave: boolean; busy: boolean; onSave: () => void; playbook?: Playbook }) {
  const running = decision.status === 'approved';
  const ok = decision.status === 'executed' && decision.result?.ok !== false;
  const healthy = incident ? incident.status === 'resolved' : ok;
  const verb = /roll\s?back/i.test(decision.proposedAction.label) ? 'Rolled back' : /restart/i.test(decision.proposedAction.label) ? 'Restarted' : /scale/i.test(decision.proposedAction.label) ? 'Scaled' : 'Done';
  const target = String(decision.proposedAction.args.name ?? decision.proposedAction.args.deployment ?? '');
  return (
    <section className={`card done-card ${ok ? 'is-ok' : running ? 'is-running' : 'is-bad'}`}>
      <div className="done-hero">
        <div className={`done-ball ${running ? 'running' : ok ? 'ok' : 'bad'}`}>{running ? <span className="spinner spinner-dark" /> : <Icon name={ok ? 'check' : 'x'} size={30} strokeWidth={2.6} />}</div>
        <div>
          <h2>{running ? 'Running the fix…' : ok ? verb : 'The fix failed'}</h2>
          <div className="muted small">{running ? 'Checked at the gateway, then sent to the tool' : ok ? (target ? `${target} ${healthy ? 'is healthy again' : 'is recovering'}` : 'Completed') : decision.result?.text}</div>
        </div>
      </div>
      <ol className="timeline">
        <TL icon="fingerprint" tone="accent" title={`Approved by ${cap(decision.decidedBy ?? 'you')}`} detail={`${clock(decision.decidedAt)} · signed approval`} done />
        <TL icon="shield" tone={running ? 'muted' : 'ok'} title="Checked at the gateway" detail={decision.result?.gateway ?? (running ? 'verifying signature + exact arguments…' : 'signature + exact arguments · allowed')} done={!running} />
        <TL icon="wrench" tone={running ? 'muted' : ok ? 'ok' : 'bad'} title={`Ran ${decision.proposedAction.tool}`} detail={decision.result?.text ?? (running ? 'waiting…' : '')} done={!running} />
        <TL icon="activity" tone={healthy && !running ? 'ok' : 'muted'} title={healthy && !running ? 'Healthy' : 'Waiting for the watcher to clear…'} detail={healthy && !running ? (incident?.resolvedAt ? `watcher cleared · ${clock(incident.resolvedAt)}` : 'live') : 'checking on every refresh, no model'} done={healthy && !running} last />
      </ol>
      {canSave && (
        <div className="learn">
          <div className="learn-text"><b><Icon name="book" size={14} />Save this fix as a playbook?</b><span>Next time it happens, the same fix shows up in about a second, with 0 model calls. A person still approves.</span></div>
          <button className="btn btn-primary btn-sm" onClick={onSave} disabled={busy}>Save as playbook</button>
        </div>
      )}
      {!canSave && decision.source === 'agent' && ok && !playbook && <div className="learn muted-learn"><Icon name="book" size={14} />The workspace owner can save this fix as a playbook.</div>}
      {playbook && decision.source === 'agent' && <div className="learn muted-learn"><Icon name="check" size={14} />Saved as playbook “{playbook.title}”.</div>}
      <div className="receipt-line"><span className="muted">This incident</span><span className="spacer" /><span className="mono">{decision.source === 'playbook' ? `0 model calls · $0.00 · ${duration(decision.matchMs ?? decision.receipt.ms)}` : receiptLine(decision.receipt)}</span></div>
    </section>
  );
}

function TL({ icon, tone, title, detail, done, last }: { icon: string; tone: 'accent' | 'ok' | 'bad' | 'muted'; title: string; detail?: string; done?: boolean; last?: boolean }) {
  return (
    <li className={`tl ${done ? 'is-done' : ''} ${last ? 'is-last' : ''}`}>
      <span className={`tl-dot t-${tone}`}><Icon name={icon} size={12} /></span>
      <div className="tl-text"><b>{title}</b>{detail && <span className="mono">{detail}</span>}</div>
    </li>
  );
}

function ReceiptCompare({ playbook, decision, incident }: { playbook: Playbook; decision: Decision; incident?: Incident }) {
  const a = playbook.origin.receipt;
  const isReplay = decision.source === 'playbook';
  const b: Receipt = isReplay ? { ...decision.receipt, modelCalls: decision.receipt.modelCalls, ms: decision.matchMs ?? decision.receipt.ms } : decision.receipt;
  const maxMs = Math.max(a.ms, b.ms, 1);
  const row = (title: string, sub: string, r: Receipt, cls: string) => (
    <div className="cmp-row">
      <div className="cmp-top"><b>{title}</b><span className="spacer" /><span className={`cmp-cost ${cls}`}>{usd(r.costUsd)}</span></div>
      <div className="muted small">{sub}</div>
      <div className="cmp-track"><span className={`cmp-bar ${cls}`} style={{ width: `${Math.max(3, (r.ms / maxMs) * 100)}%` }} /></div>
      <div className={`mono small ${cls}`}>{duration(r.ms)} · {calls(r.modelCalls)}</div>
    </div>
  );
  return (
    <div className="card">
      <h3 className="card-title">Same incident, twice</h3>
      {row(`Incident #${playbook.origin.incidentNumber}`, 'Agent investigated, a person approved, saved as a playbook', a, 'cmp-first')}
      {isReplay && row(`Incident #${incident?.number ?? '—'}`, decision.status === 'pending' ? 'Playbook replayed, waiting for approval' : 'Playbook replayed and approved', b, 'cmp-free')}
    </div>
  );
}

function PlaybookCard({ playbook, workspace }: { playbook: Playbook; workspace?: Workspace }) {
  const watcher = workspace?.watchers.find(w => w.id === playbook.match.watcherId);
  return (
    <div className="card">
      <div className="card-head">
        <span className="soft-ic"><Icon name="book" size={16} /></span>
        <div className="grow"><b>{playbook.title}</b><div className="muted small">Playbook · used {playbook.uses === 1 ? 'once' : playbook.uses === 2 ? 'twice' : `${playbook.uses} times`}</div></div>
      </div>
      <div className="pb-group">
      <div className="wh-title">Runs when</div>
      <div className="check-line"><Icon name="radar" size={14} className="c-acc" />“{watcher?.title ?? playbook.match.watcherId}” fires</div>
      <div className="check-line"><Icon name="box" size={14} className="c-acc" />on <span className="mono">{playbook.match.resource}</span></div>
      <div className="check-line"><Icon name="circle-alert" size={14} className="c-acc" />with reason <span className="mono">{playbook.match.reason}</span></div>
      </div>
      <div className="pb-group">
      <div className="wh-title">Then</div>
      <p className="small ink2">Shows this evidence and proposes: {playbook.actionTemplate.label.toLowerCase()}. A person always approves first.</p>
      </div>
      <div className="origin"><Icon name="history" size={13} />Learned from incident #{playbook.origin.incidentNumber} at {new Date(playbook.origin.at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}. Saved by {cap(playbook.origin.savedBy)}{playbook.origin.approvedBy ? `, approved by ${cap(playbook.origin.approvedBy)}` : ''}.</div>
      {playbook.origin.correction && (
        <div className="origin origin-correction"><Icon name="user-check" size={13} />The fix follows {cap(playbook.origin.correction.by)}&apos;s correction: “{playbook.origin.correction.note}”, not the agent&apos;s first idea.</div>
      )}
    </div>
  );
}

/** Evidence panel data: from the socket when the server pushes it, otherwise refreshed directly. */
function useEvidence(wsId: string | undefined, panels: Panel[], pushed: Record<string, PanelDatum>, mode: string): Record<string, PanelDatum> {
  const [own, setOwn] = useState<Record<string, PanelDatum>>({});
  const pushedRef = useRef(pushed);
  pushedRef.current = pushed;
  const key = panels.map(p => p.id).join(',');
  useEffect(() => {
    if (!wsId || !panels.length || mode === 'fixture') return;
    const last: Record<string, number> = {};
    const t = setInterval(() => {
      const now = Date.now();
      for (const p of panels) {
        const fromSocket = pushedRef.current[p.id];
        // Prefer socket pushes; fall back if none arrived within 3 s or they went quiet.
        if (fromSocket && now - new Date(fromSocket.at).getTime() < Math.max(5, p.refreshSec) * 2000) continue;
        if (now - (last[p.id] ?? 0) < Math.max(5, p.refreshSec || 10) * 1000) continue;
        last[p.id] = now;
        refreshPanel(wsId, p.id)
          .then(d => setOwn(o => ({ ...o, [p.id]: { data: d.data, at: d.at } })))
          .catch(e => setOwn(o => ({ ...o, [p.id]: { data: o[p.id]?.data, at: o[p.id]?.at ?? new Date().toISOString(), error: (e as Error).message } })));
      }
    }, 1000);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wsId, key, mode]);
  const out: Record<string, PanelDatum> = {};
  for (const p of panels) {
    const a = pushed[p.id];
    const b = own[p.id];
    out[p.id] = (!a ? b : !b ? a : a.at >= b.at ? a : b) as PanelDatum;
  }
  return out;
}

/** An action that asked for a value (e.g. which mentor): fill it in, then PRISM validates and dry-runs before you approve. */
function NeedsInputForm({ decision, onFilled, onError }: { decision: Decision; onFilled: (d: Decision) => void; onError: (m: string) => void }) {
  const fields = decision.needsInput ?? [];
  // Suggestions come from the row (e.g. its free mentors); you can type any value — the dry run checks it.
  const usable = (f: { options?: string[] }) => (f.options ?? []).filter(o => !/^(none|n\/a|-)\b/i.test(o.trim()));
  const [values, setValues] = useState<Record<string, string>>(() => Object.fromEntries(fields.map(f => [f.arg, usable(f)[0] ?? ''])));
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    setBusy(true);
    try { onFilled(await api<Decision>(`/decisions/${decision.id}/inputs`, { body: { values } })); }
    catch (e) { onError((e as Error).message); }
    finally { setBusy(false); }
  };
  return (
    <form className="needs-input" onSubmit={e => { e.preventDefault(); void submit(); }}>
      <div className="small muted">This action needs {fields.length === 1 ? 'one choice' : 'a few choices'} from you before PRISM checks it.</div>
      {fields.map(f => (
        <label key={f.arg} className="ni-field">
          <span>{f.label}</span>
          <input className="input" list={`ni-${f.arg}`} value={values[f.arg]} autoFocus
            onChange={e => setValues(v => ({ ...v, [f.arg]: e.target.value }))}
            placeholder={usable(f).length ? `e.g. ${usable(f).join(', ')}` : `Type a ${f.label.toLowerCase()}`} />
          <datalist id={`ni-${f.arg}`}>{usable(f).map(o => <option key={o} value={o} />)}</datalist>
          {f.options?.length && !usable(f).length ? <span className="small muted">Suggested: {f.options.join(', ')}</span> : null}
        </label>
      ))}
      <button className="btn btn-primary" disabled={busy || fields.some(f => !String(values[f.arg] ?? '').trim())}>{busy ? 'Checking…' : 'Continue · run the dry run'}</button>
    </form>
  );
}
