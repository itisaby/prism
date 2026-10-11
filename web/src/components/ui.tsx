'use client';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import QRCode from 'qrcode';
import { Icon } from './Icon.tsx';
import { setUser, USERS } from '../lib/api.ts';

export function Badge({ tone = 'accent', children, icon }: { tone?: 'accent' | 'success' | 'warning' | 'danger' | 'muted'; children: ReactNode; icon?: string }) {
  return (
    <span className={`badge b-${tone}`}>
      {icon && <Icon name={icon} size={12} />}
      {children}
    </span>
  );
}

export function Modal({ open, onClose, title, children, width = 440 }: { open: boolean; onClose: () => void; title: ReactNode; children: ReactNode; width?: number }) {
  useEffect(() => {
    if (!open) return;
    const on = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', on);
    return () => window.removeEventListener('keydown', on);
  }, [open, onClose]);
  if (!open) return null;
  return (
    <div className="scrim" onMouseDown={onClose}>
      <div className="modal" style={{ maxWidth: width }} onMouseDown={e => e.stopPropagation()} role="dialog" aria-modal>
        <div className="modal-head">
          <h3>{title}</h3>
          <button className="icon-btn" onClick={onClose} aria-label="Close"><Icon name="x" /></button>
        </div>
        {children}
      </div>
    </div>
  );
}

export interface ToastMsg { id: number; text: ReactNode; tone?: 'ok' | 'bad' | 'info'; sub?: ReactNode }
export function useToasts() {
  const [toasts, setToasts] = useState<ToastMsg[]>([]);
  const push = (t: Omit<ToastMsg, 'id'>, ms = 6000) => {
    const id = Date.now() + Math.random();
    setToasts(x => [...x, { ...t, id }]);
    setTimeout(() => setToasts(x => x.filter(y => y.id !== id)), ms);
  };
  const view = (
    <div className="toasts">
      {toasts.map(t => (
        <div key={t.id} className={`toast t-${t.tone ?? 'info'}`}>
          <Icon name={t.tone === 'bad' ? 'circle-alert' : t.tone === 'ok' ? 'circle-check' : 'sparkles'} size={16} />
          <div>
            <div>{t.text}</div>
            {t.sub && <div className="toast-sub">{t.sub}</div>}
          </div>
        </div>
      ))}
    </div>
  );
  return { push, view };
}

/** Press-and-hold confirm (~900 ms) with a progress ring. Works with mouse, pen and touch. */
export function HoldButton({ onConfirm, label = 'Hold to approve', busyLabel = 'Approving…', disabled, holdMs = 900 }: { onConfirm: () => void; label?: string; busyLabel?: string; disabled?: boolean; holdMs?: number }) {
  const [progress, setProgress] = useState(0);
  const [done, setDone] = useState(false);
  const raf = useRef<number | null>(null);
  const start = useRef(0);

  const stop = () => {
    if (raf.current !== null) cancelAnimationFrame(raf.current);
    raf.current = null;
    if (!done) setProgress(0);
  };
  const begin = (e: React.PointerEvent) => {
    if (disabled || done) return;
    (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
    start.current = performance.now();
    const step = (t: number) => {
      const p = Math.min(1, (t - start.current) / holdMs);
      setProgress(p);
      if (p >= 1) {
        raf.current = null;
        setDone(true);
        try { navigator.vibrate?.(30); } catch { /* noop */ }
        onConfirm();
        return;
      }
      raf.current = requestAnimationFrame(step);
    };
    raf.current = requestAnimationFrame(step);
  };
  useEffect(() => () => { if (raf.current !== null) cancelAnimationFrame(raf.current); }, []);
  useEffect(() => { if (!disabled) { setDone(false); setProgress(0); } }, [disabled]);

  const r = 10;
  const circ = 2 * Math.PI * r;
  return (
    <button
      type="button"
      className={`hold ${progress > 0 && !done ? 'is-holding' : ''} ${done ? 'is-done' : ''}`}
      disabled={disabled}
      onPointerDown={begin}
      onPointerUp={stop}
      onPointerLeave={stop}
      onPointerCancel={stop}
      onContextMenu={e => e.preventDefault()}
      onKeyDown={e => { if ((e.key === 'Enter' || e.key === ' ') && !done && !disabled) { e.preventDefault(); setDone(true); onConfirm(); } }}
      style={{ '--p': progress } as React.CSSProperties}
    >
      <span className="hold-fill" />
      <svg width="24" height="24" viewBox="0 0 24 24" className="hold-ring" aria-hidden>
        <circle cx="12" cy="12" r={r} fill="none" stroke="rgba(0,0,0,.18)" strokeWidth="3" />
        <circle cx="12" cy="12" r={r} fill="none" stroke="#000" strokeWidth="3" strokeLinecap="round"
          strokeDasharray={circ} strokeDashoffset={circ * (1 - (done ? 1 : progress))} transform="rotate(-90 12 12)" />
      </svg>
      <span className="hold-label">{done ? busyLabel : label}</span>
    </button>
  );
}

export function QrModal({ open, onClose, url, title }: { open: boolean; onClose: () => void; url: string; title: string }) {
  const [svg, setSvg] = useState('');
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!open || !url) return;
    QRCode.toString(url, { type: 'svg', margin: 0, errorCorrectionLevel: 'M', color: { dark: '#000000', light: '#ffffff' } })
      .then(setSvg)
      .catch(() => setSvg(''));
  }, [open, url]);
  const copy = async () => {
    try { await navigator.clipboard.writeText(url); } catch { /* insecure context */ }
    setCopied(true);
    setTimeout(() => setCopied(false), 1600);
  };
  return (
    <Modal open={open} onClose={onClose} title="Scan to approve" width={400}>
      <div className="qr-body">
        <div className="qr-wrap" dangerouslySetInnerHTML={{ __html: svg }} />
        <div className="qr-url mono">{url.replace(/^https?:\/\//, '')}</div>
        <button className="btn btn-ghost btn-sm" onClick={copy}><Icon name={copied ? 'check' : 'copy'} size={14} />{copied ? 'Copied' : 'Copy link'}</button>
        <ul className="facts">
          <li><Icon name="phone" size={15} />Opens in the browser, nothing to install</li>
          <li><Icon name="user-check" size={15} />Joins as Judge, sees only {title}</li>
          <li><Icon name="key" size={15} />Each approval is signed for that person</li>
        </ul>
      </div>
    </Modal>
  );
}

export function IdentitySwitch({ user }: { user: string }) {
  return (
    <div className="identity">
      <span className="avatar">{user.slice(0, 1).toUpperCase()}</span>
      <div className="identity-who">
        <span className="identity-name">{user === 'arnab' ? 'Arnab' : user === 'judge' ? 'Judge' : user}</span>
        <span className="mono identity-role">{user === 'arnab' ? 'owner' : 'approver'}</span>
      </div>
      <div className="seg" role="group" aria-label="Switch identity">
        {USERS.map(u => (
          <button key={u} className={u === user ? 'on' : ''} onClick={() => { if (u !== user) { setUser(u); const url = new URL(window.location.href); url.searchParams.delete('as'); window.location.href = url.toString(); } }}>
            {u}
          </button>
        ))}
      </div>
    </div>
  );
}

export function LiveDot({ mode }: { mode: 'connecting' | 'live' | 'polling' | 'fixture' }) {
  const label = mode === 'live' ? 'Updates automatically' : mode === 'polling' ? 'Updates automatically · polling' : mode === 'fixture' ? 'Demo data' : 'Connecting…';
  return (
    <span className={`live live-${mode}`}>
      <span className="live-dot" />
      {label}
    </span>
  );
}
