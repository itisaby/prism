'use client';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { Decor } from './Decor.tsx';
import { Icon, Logo } from './Icon.tsx';
import { api, ApiError, fixtureMode } from '../lib/api.ts';
import type { Workspace } from '../lib/types.ts';

const DOMAINS = [
  { id: 'devops', label: 'DevOps', title: 'Shop cluster', prompt: 'Cluster health for my shop app: failing pods, deployments I can roll back or restart, warning events, CPU per app' },
  { id: 'sdlc', label: 'SDLC', title: 'SDLC health', prompt: 'Open PRs by age next to failing CI runs, and issues nobody has touched in two weeks' },
  { id: 'events', label: 'Event ops', title: 'Event ops', prompt: "Today's hackathon: registrations vs capacity, check-ins per hour, and sessions that are overbooked" },
  { id: 'finance', label: 'Finance', title: 'Revenue', prompt: 'Failed payments this week by reason, refunds waiting for approval, and the MRR trend' },
];

export function Landing() {
  const router = useRouter();
  const [domain, setDomain] = useState(DOMAINS[0]);
  const [prompt, setPrompt] = useState(DOMAINS[0].prompt);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string>();
  const [existing, setExisting] = useState<{ id: string; title: string }[]>([]);
  const ta = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    api<{ id: string; title: string }[]>('/workspaces').then(setExisting).catch(() => {});
  }, []);
  useEffect(() => {
    const el = ta.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${el.scrollHeight}px`;
  }, [prompt]);

  const build = async () => {
    const text = prompt.trim();
    if (!text || busy) return;
    setBusy(true);
    setErr(undefined);
    try {
      const ws = await api<Workspace>('/workspaces', { body: { title: domain.title } });
      router.push(`/w/${ws.id}?compose=${encodeURIComponent(text)}${fixtureMode() ? '&fixture=1' : ''}`);
    } catch (e) {
      if (e instanceof ApiError && e.unreachable) {
        router.push(`/w/demo?fixture=1&compose=${encodeURIComponent(text)}`);
        return;
      }
      setErr((e as Error).message);
      setBusy(false);
    }
  };

  const q = fixtureMode() ? '?fixture=1' : '';
  return (
    <div className="landing">
      <Decor variant="hero" />
      <nav className="land-nav">
        <Logo />
        <span className="spacer" />
        <div className="land-links hide-mobile">
          <a href="#how">How it works</a>
          <a href="https://github.com" target="_blank" rel="noreferrer">GitHub</a>
        </div>
        {existing[0] ? (
          <Link href={`/w/${existing[0].id}${q}`} className="btn btn-ghost btn-sm">Open {existing[0].title}</Link>
        ) : (
          <Link href="/w/demo?fixture=1" className="btn btn-ghost btn-sm">See a demo</Link>
        )}
      </nav>

      <section className="hero">
        <div className="eyebrow-pill"><span className="spectrum-dot" />The agent harness for MCP</div>
        <h1 className="headline">The harness learns.<br />The model rests.</h1>
        <p className="subline">The first time, an agent figures it out. After that, PRISM runs it as a live app and a saved playbook, with zero model calls.</p>

        <form className="prompt-box" onSubmit={e => { e.preventDefault(); void build(); }}>
          <textarea
            ref={ta}
            value={prompt}
            rows={2}
            onChange={e => setPrompt(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey || !e.shiftKey)) { e.preventDefault(); void build(); } }}
            aria-label="Describe your workspace"
            placeholder="Describe what you want to watch and act on…"
          />
          <div className="prompt-row">
            <div className="chips">
              {DOMAINS.map(d => (
                <button type="button" key={d.id} className={`chip ${d.id === domain.id ? 'on' : ''}`} onClick={() => { setDomain(d); setPrompt(d.prompt); }}>
                  {d.label}
                </button>
              ))}
            </div>
            <span className="spacer" />
            <button className="btn btn-primary" disabled={busy || !prompt.trim()}>
              {busy ? <><span className="spinner spinner-dark" />Building…</> : <>Build my workspace<Icon name="arrow-right" size={15} strokeWidth={2.2} /></>}
            </button>
          </div>
        </form>
        {err && <div className="form-err"><Icon name="circle-alert" size={14} />{err}</div>}

        <div className="servers">
          <span className="mono servers-label">Works with any MCP server</span>
          {[
            { n: 'Kubernetes', i: 'container' }, { n: 'GitHub', i: 'git' }, { n: 'Event DB', i: 'database' }, { n: 'agentregistry', i: 'search' },
          ].map(s => (
            <span key={s.n} className="server-chip"><span className="dot d-ok" /><Icon name={s.i} size={13} />{s.n}</span>
          ))}
          <span className="server-chip"><span className="dot d-off" /><Icon name="link" size={13} />your own MCP URL</span>
        </div>
      </section>

      <section className="values" id="how">
        <Value icon="repeat" title="Learns once, then runs free" body="The first answer becomes a live panel and a saved playbook. Repeats run straight from your tools, with no model calls." />
        <Value icon="users" title="Yours, over shared data" body="Everyone arranges their own view. Approvals go to the right person's phone, signed for them." />
        <Value icon="bot" title="Agents can add to it" body="Claude Code or Cursor can add panels for you, and every write is checked at agentgateway first." />
      </section>
      <footer className="land-foot mono">Built at AI Engineer NYC · Oct 11 2026</footer>
    </div>
  );
}

function Value({ icon, title, body }: { icon: string; title: string; body: string }) {
  return (
    <div className="value">
      <span className="soft-ic"><Icon name={icon} size={16} /></span>
      <h3>{title}</h3>
      <p>{body}</p>
    </div>
  );
}
