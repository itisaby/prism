'use client';
// Personal views: a non-owner reshapes their own view of a shared workspace (the data stays shared and live).
import { useState } from 'react';
import { Icon } from './Icon.tsx';
import { api } from '../lib/api.ts';
import type { Workspace } from '../lib/types.ts';

/** "Your view" strip: what this person changed, hidden panels to bring back, and a reset to the team view. */
export function PersonalStrip({ workspace, onChanged, compact }: { workspace: Workspace; onChanged?: (w: Workspace) => void; compact?: boolean }) {
  const [showHidden, setShowHidden] = useState(false);
  const [busy, setBusy] = useState(false);
  const p = workspace.personal;
  if (!p) return null;
  const changed = p.customizedPanels.length;
  const run = async (path: string, body?: unknown) => {
    setBusy(true);
    try { const w = await api<Workspace>(`/workspaces/${workspace.id}/${path}`, body ? { body } : { method: 'POST' }); onChanged?.(w); }
    finally { setBusy(false); }
  };
  return (
    <div className={`personal-strip ${compact ? 'is-compact' : ''}`}>
      <span className="soft-ic"><Icon name="user" size={13} /></span>
      <b>Your view</b>
      <span className="muted ellipsis">
        {changed ? `${changed} panel${changed === 1 ? '' : 's'} changed for you` : 'same as the team view'} · data stays shared and live
      </span>
      <span className="spacer" />
      {p.hiddenPanels.length > 0 && (
        <span className="ps-hidden">
          <button className="btn btn-ghost btn-sm" onClick={() => setShowHidden(v => !v)} disabled={busy}>
            {p.hiddenPanels.length} hidden<Icon name={showHidden ? 'chevron-up' : 'chevron-down'} size={13} />
          </button>
          {showHidden && (
            <span className="ps-menu">
              {p.hiddenPanels.map(h => (
                <button key={h.id} onClick={() => { setShowHidden(false); void run('ops', { ops: [{ op: 'show_panel', panelId: h.id }] }); }}>
                  <Icon name="plus" size={12} />Show {h.title}
                </button>
              ))}
            </span>
          )}
        </span>
      )}
      {changed > 0 && <button className="btn btn-ghost btn-sm" onClick={() => void run('view/reset')} disabled={busy}><Icon name="undo" size={13} />Reset to team view</button>}
    </div>
  );
}

/** Inline "customize my view" box for the phone, where there's no floating chat bar. */
export function CustomizeBar({ workspace, onDone }: { workspace: Workspace; onDone: (summary: string, ok: boolean) => void }) {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const send = async () => {
    if (!text.trim() || busy) return;
    setBusy(true);
    try {
      const r = await api<{ summary: string }>(`/workspaces/${workspace.id}/compose`, { body: { prompt: text.trim() } });
      setText('');
      onDone(r.summary, true);
    } catch (e) {
      onDone((e as Error).message, false);
    } finally {
      setBusy(false);
    }
  };
  return (
    <form className={`customize-bar ${busy ? 'is-busy' : ''}`} onSubmit={e => { e.preventDefault(); void send(); }}>
      <Icon name="sparkles" size={15} className="chat-ic" />
      <input value={text} onChange={e => setText(e.target.value)} disabled={busy}
        placeholder={busy ? 'Changing your view…' : 'Customize your view: “only open help requests, as cards”'} aria-label="Customize your view" />
      <button className="send" disabled={busy || !text.trim()} aria-label="Apply">{busy ? <span className="spinner spinner-dark" /> : <Icon name="arrow-up" size={14} strokeWidth={2.2} />}</button>
    </form>
  );
}
