'use client';
// Connection names/icons for source labels ("Event DB · Updated 4s ago"). Nothing here is domain-specific.
import { useEffect, useState } from 'react';
import { api } from './api.ts';
import type { ConnectionView } from './types.ts';

const ICON_BY_ID: Record<string, string> = { k8s: 'container', event: 'calendar', github: 'github', stripe: 'credit-card' };

export function connectionIcon(id: string, name = ''): string {
  if (ICON_BY_ID[id]) return ICON_BY_ID[id];
  const n = `${id} ${name}`.toLowerCase();
  if (n.includes('kube') || n.includes('k8s')) return 'container';
  if (n.includes('github')) return 'github';
  if (n.includes('stripe') || n.includes('pay')) return 'credit-card';
  if (n.includes('event')) return 'calendar';
  if (n.includes('postgres') || n.includes('sql') || n.includes('db')) return 'database';
  return 'plug';
}

let cache: Promise<ConnectionView[]> | null = null;
export function loadConnections(force = false): Promise<ConnectionView[]> {
  if (!cache || force) cache = api<ConnectionView[]>('/connections').catch(() => { cache = null; return []; });
  return cache;
}

/** id → display name. Falls back to the raw id until connections load. */
export function useConnectionNames(refreshKey?: unknown): Record<string, string> {
  const [names, setNames] = useState<Record<string, string>>({});
  useEffect(() => {
    let live = true;
    loadConnections(refreshKey !== undefined).then(cs => { if (live) setNames(Object.fromEntries(cs.map(c => [c.id, c.name]))); });
    return () => { live = false; };
  }, [refreshKey]);
  return names;
}
