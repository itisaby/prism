'use client';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import { useFixtureSuffix } from '../lib/useWorkspaceSocket.ts';
import { Icon, Logo } from './Icon.tsx';
import { connectionIcon, loadConnections } from '../lib/connections.ts';
import { Badge, IdentitySwitch, Modal } from './ui.tsx';
import { api, fixtureMode } from '../lib/api.ts';
import type { ConnectionView, Playbook } from '../lib/types.ts';

interface RegistryEntry { name: string; title?: string; description?: string; url: string; tools?: number }

export function Rail({ activeId, activeTitle, user, playbooks, open, onClose, onConnected, mode }: {
  mode?: string; activeId?: string; activeTitle?: string; user: string; playbooks: Playbook[]; open?: boolean; onClose?: () => void; onConnected?: (c: ConnectionView) => void;
}) {
  const [workspaces, setWorkspaces] = useState<{ id: string; title: string; owner: string }[]>([]);
  const [connections, setConnections] = useState<ConnectionView[]>([]);
  const [adding, setAdding] = useState(false);
  const [deleting, setDeleting] = useState<{ id: string; title: string }>();
  const [delBusy, setDelBusy] = useState(false);
  const [delError, setDelError] = useState<string>();
  const router = useRouter();
  const q = useFixtureSuffix(mode as never);

  const load = useCallback(() => {
    api<{ id: string; title: string; owner: string }[]>('/workspaces').then(setWorkspaces).catch(() => {});
    loadConnections(true).then(setConnections);
  }, []);
  useEffect(() => { load(); }, [load, mode]);
  // Keep the workspace list fresh: new workspaces can come from another tab, the landing page, or an agent via PRISM MCP.
  useEffect(() => {
    if (mode === 'fixture') return;
    const refresh = () => { api<{ id: string; title: string; owner: string }[]>('/workspaces').then(setWorkspaces).catch(() => {}); };
    const t = setInterval(refresh, 8000);
    window.addEventListener('focus', refresh);
    return () => { clearInterval(t); window.removeEventListener('focus', refresh); };
  }, [mode]);

  const confirmDelete = async () => {
    if (!deleting) return;
    setDelBusy(true);
    setDelError(undefined);
    try {
      await api(`/workspaces/${deleting.id}`, { method: 'DELETE' });
      const rest = workspaces.filter(w => w.id !== deleting.id);
      setWorkspaces(rest);
      if (deleting.id === activeId) router.push(rest[0] ? `/w/${rest[0].id}${q}` : `/${q}`);
      setDeleting(undefined);
    } catch (e) {
      setDelError((e as Error).message);
    } finally {
      setDelBusy(false);
    }
  };

  return (
    <>
      <aside className={`rail ${open ? 'is-open' : ''}`}>
        <div className="rail-brand">
          <Link href={`/${q}`}><Logo /></Link>
          {onClose && <button className="icon-btn rail-close" onClick={onClose} aria-label="Close menu"><Icon name="x" /></button>}
        </div>
        <div className="rail-scroll">
          <div className="rail-label">Workspaces</div>
          {workspaces.map(w => (
            <div key={w.id} className="rail-ws">
              <Link href={`/w/${w.id}${q}`} className={`rail-item ${w.id === activeId ? 'on' : ''}`}>
                <Icon name="layers" size={15} />
                <span className="ellipsis">{w.id === activeId && activeTitle ? activeTitle : w.title}</span>
                {w.owner !== user && <span className="mono rail-meta">shared</span>}
              </Link>
              {w.owner === user && (
                <button className="icon-btn rail-ws-del" aria-label={`Delete ${w.title}`} title="Delete workspace"
                  onClick={() => { setDelError(undefined); setDeleting({ id: w.id, title: w.title }); }}>
                  <Icon name="trash" size={13} />
                </button>
              )}
            </div>
          ))}
          <Link href={`/${q}`} className="rail-item muted"><Icon name="plus" size={15} />New workspace</Link>

          <div className="rail-label">MCP servers</div>
          {connections.map(c => (
            <div key={c.id} className="rail-server" title={c.error ?? c.url}>
              <span className={`dot ${c.status === 'ok' ? 'd-ok' : 'd-bad'}`} />
              <Icon name={connectionIcon(c.id, c.name)} size={14} />
              <span className="ellipsis">{c.name}</span>
              <span className="spacer" />
              {c.viaGateway && <span className="gw" title="Routed through agentgateway"><Icon name="shield" size={11} /></span>}
              <span className="mono rail-meta">{c.status === 'ok' ? `${c.tools.length} tools` : 'error'}</span>
            </div>
          ))}
          <button className="rail-item muted" onClick={() => setAdding(true)}><Icon name="plus" size={15} />Add any MCP URL</button>

          {playbooks.length > 0 && (
            <>
              <div className="rail-label">Playbooks</div>
              {playbooks.map(p => (
                <div key={p.id} className="rail-playbook">
                  <div className="rail-pb-top"><Icon name="book" size={14} /><span className="ellipsis">{p.title}</span></div>
                  <div className="mono rail-meta">#{p.origin.incidentNumber} · used {p.uses}× · 0 model calls</div>
                </div>
              ))}
            </>
          )}
        </div>
        <IdentitySwitch user={user} />
      </aside>
      {open && <div className="rail-scrim" onClick={onClose} />}
      <Modal open={!!deleting} onClose={() => !delBusy && setDeleting(undefined)} title="Delete workspace?">
        <p className="small">
          <b>{deleting?.title}</b> will be deleted with its panels, watchers, incidents, decisions and saved playbooks.
          Its panels stop refreshing. MCP connections stay. This can&apos;t be undone.
        </p>
        {delError && <p className="small bad">{delError}</p>}
        <div className="modal-actions">
          <button className="btn btn-ghost btn-sm" onClick={() => setDeleting(undefined)} disabled={delBusy}>Cancel</button>
          <button className="btn btn-danger btn-sm" onClick={confirmDelete} disabled={delBusy}>{delBusy ? 'Deleting…' : 'Delete workspace'}</button>
        </div>
      </Modal>
      <AddConnectionDialog open={adding} onClose={() => setAdding(false)} onDone={c => { setAdding(false); load(); onConnected?.(c); }} />
    </>
  );
}

function AddConnectionDialog({ open, onClose, onDone }: { open: boolean; onClose: () => void; onDone: (c: ConnectionView) => void }) {
  const [tab, setTab] = useState<'registry' | 'url'>('registry');
  const [name, setName] = useState('');
  const [url, setUrl] = useState('');
  const [token, setToken] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string>();
  const [query, setQuery] = useState('');
  const [entries, setEntries] = useState<RegistryEntry[] | null>(null);
  const [registryOk, setRegistryOk] = useState(true);

  useEffect(() => {
    if (!open || tab !== 'registry') return;
    const t = setTimeout(() => {
      api<RegistryEntry[]>(`/registry?q=${encodeURIComponent(query)}`).then(r => setEntries(Array.isArray(r) ? r : [])).catch(() => { setRegistryOk(false); setTab('url'); });
    }, 200);
    return () => clearTimeout(t);
  }, [open, tab, query]);

  const submit = async (body: { name: string; url: string; token?: string }) => {
    setBusy(true);
    setErr(undefined);
    try {
      const c = await api<ConnectionView>('/connections', { method: 'POST', body });
      setName(''); setUrl(''); setToken('');
      onDone(c);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal open={open} onClose={onClose} title="Add an MCP server" width={480}>
      <div className="tabs">
        {registryOk && <button className={tab === 'registry' ? 'on' : ''} onClick={() => setTab('registry')}><Icon name="search" size={14} />agentregistry</button>}
        <button className={tab === 'url' ? 'on' : ''} onClick={() => setTab('url')}><Icon name="link" size={14} />Custom MCP URL</button>
      </div>
      {tab === 'registry' ? (
        <div className="form">
          <input className="input" placeholder="Search servers (github, events, postgres…)" value={query} onChange={e => setQuery(e.target.value)} autoFocus />
          <div className="registry-list">
            {entries === null && <div className="muted small">Searching…</div>}
            {entries?.length === 0 && <div className="muted small">No matches. Paste a URL under “Custom MCP URL”.</div>}
            {entries?.map(e => (
              <button key={e.url} className="registry-item" disabled={busy} onClick={() => submit({ name: e.title ?? e.name, url: e.url })}>
                <span className="soft-ic"><Icon name={connectionIcon(e.name, e.title)} size={16} /></span>
                <span className="registry-main">
                  <b>{e.title ?? e.name}</b>
                  <span className="muted small">{e.description ?? e.url}</span>
                </span>
                {typeof e.tools === 'number' && <Badge tone="muted">{e.tools} tools</Badge>}
                <Icon name="plus" size={15} />
              </button>
            ))}
          </div>
          <p className="fine"><Icon name="shield" size={13} />Every server is reached through agentgateway. Writes always ask a person first.</p>
        </div>
      ) : (
        <form className="form" onSubmit={e => { e.preventDefault(); void submit({ name: name || url, url, token: token || undefined }); }}>
          <label>Name<input className="input" value={name} onChange={e => setName(e.target.value)} placeholder="GitHub" /></label>
          <label>Server URL<input className="input mono" value={url} onChange={e => setUrl(e.target.value)} placeholder="https://api.example.com/mcp" required /></label>
          <label>Token <span className="muted">(optional, stays on the server)</span><input className="input mono" type="password" value={token} onChange={e => setToken(e.target.value)} placeholder="••••••••" autoComplete="off" /></label>
          <p className="fine"><Icon name="shield" size={13} />HTTPS or an allowed local address. Tokens are encrypted at rest and never sent back to the browser.</p>
          <button className="btn btn-primary" disabled={busy || !url}>{busy ? 'Connecting…' : 'Connect'}<Icon name="arrow-right" size={15} /></button>
        </form>
      )}
      {err && <div className="form-err"><Icon name="circle-alert" size={14} />{err}</div>}
    </Modal>
  );
}
