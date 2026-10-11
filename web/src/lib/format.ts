import type { Receipt } from './types.ts';

export function timeAgo(iso?: string, now = Date.now()): string {
  if (!iso) return '—';
  const s = Math.max(0, Math.round((now - new Date(iso).getTime()) / 1000));
  if (s < 2) return 'just now';
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  return h < 24 ? `${h}h ago` : `${Math.round(h / 24)}d ago`;
}

export function clock(iso?: string): string {
  if (!iso) return '';
  return new Date(iso).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', second: '2-digit' });
}

export function usd(n?: number): string {
  const v = n ?? 0;
  if (v === 0) return '$0.00';
  return v < 0.01 ? `$${v.toFixed(3)}` : `$${v.toFixed(2)}`;
}

export function duration(ms?: number): string {
  const v = ms ?? 0;
  if (v < 1000) return `${Math.round(v)} ms`;
  if (v < 60_000) return `${(v / 1000).toFixed(v < 10_000 ? 1 : 0)} s`;
  return `${Math.floor(v / 60_000)}m ${Math.round((v % 60_000) / 1000)}s`;
}

export function calls(n?: number): string {
  const v = n ?? 0;
  return `${v} model call${v === 1 ? '' : 's'}`;
}

export function receiptLine(r?: Receipt): string {
  if (!r) return '';
  return `${calls(r.modelCalls)} · ${usd(r.costUsd)} · ${duration(r.ms)}`;
}

export const cap = (s: string) => (s ? s[0].toUpperCase() + s.slice(1) : s);
