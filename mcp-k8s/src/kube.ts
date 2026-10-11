// Tiny Kubernetes REST client for running inside the cluster.
// Auth: the pod's ServiceAccount token (re-read on every call because the kubelet rotates it).
// TLS: the cluster CA is trusted via NODE_EXTRA_CA_CERTS (set in the Deployment), so plain fetch() works.
import { readFile } from 'node:fs/promises';

const SA_DIR = process.env.K8S_SA_DIR ?? '/var/run/secrets/kubernetes.io/serviceaccount';
const API = (process.env.K8S_API_URL ?? 'https://kubernetes.default.svc').replace(/\/$/, '');

export class KubeError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly body?: { reason?: string; message?: string; details?: Record<string, unknown> },
  ) {
    super(message);
  }
}

async function bearer(): Promise<string> {
  if (process.env.K8S_TOKEN) return process.env.K8S_TOKEN; // local dev against a proxy
  return (await readFile(`${SA_DIR}/token`, 'utf8')).trim();
}

export interface KubeRequest {
  method?: 'GET' | 'PATCH' | 'PUT' | 'POST';
  /** Patch body. contentType picks the patch flavour. */
  body?: unknown;
  contentType?: 'application/strategic-merge-patch+json' | 'application/merge-patch+json' | 'application/json-patch+json' | 'application/json';
  query?: Record<string, string | number | boolean | undefined>;
  dryRun?: boolean;
  text?: boolean;
}

export async function k8s<T = any>(path: string, req: KubeRequest = {}): Promise<T> {
  const url = new URL(API + path);
  for (const [k, v] of Object.entries(req.query ?? {})) if (v !== undefined) url.searchParams.set(k, String(v));
  if (req.dryRun) url.searchParams.set('dryRun', 'All');
  const res = await fetch(url, {
    method: req.method ?? 'GET',
    headers: {
      authorization: `Bearer ${await bearer()}`,
      accept: req.text ? 'text/plain, */*' : 'application/json',
      ...(req.body !== undefined ? { 'content-type': req.contentType ?? 'application/json' } : {}),
    },
    body: req.body === undefined ? undefined : JSON.stringify(req.body),
    signal: AbortSignal.timeout(10_000),
  });
  const raw = await res.text();
  if (!res.ok) {
    let status: KubeError['body'];
    try { status = JSON.parse(raw); } catch { /* not a Status object */ }
    throw new KubeError(res.status, status?.message ?? (raw.slice(0, 300) || res.statusText), status);
  }
  return (req.text ? raw : raw ? JSON.parse(raw) : {}) as T;
}

/** "250m" → 250, "1" → 1000, "123456n" → 0.12 */
export function millicores(q?: string): number {
  if (!q) return 0;
  const n = parseFloat(q);
  if (q.endsWith('n')) return n / 1e6;
  if (q.endsWith('u')) return n / 1e3;
  if (q.endsWith('m')) return n;
  return n * 1000;
}

const BIN: Record<string, number> = { Ki: 2 ** 10, Mi: 2 ** 20, Gi: 2 ** 30, Ti: 2 ** 40, k: 1e3, K: 1e3, M: 1e6, G: 1e9, T: 1e12 };
/** "52348Ki" → 51.1 (MiB) */
export function mebibytes(q?: string): number {
  if (!q) return 0;
  const m = /^([0-9.]+)([A-Za-z]*)$/.exec(q);
  if (!m) return 0;
  return (parseFloat(m[1]) * (BIN[m[2]] ?? 1)) / 2 ** 20;
}
