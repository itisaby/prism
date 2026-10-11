// CPU/memory from metrics.k8s.io (metrics-server). metrics-server only knows "now", so a background sampler
// keeps one hour of per-app CPU in memory for get_usage_history.
import { k8s, mebibytes, millicores } from './kube.js';
import { appOf, clock } from './views.js';

export interface PodUsage { namespace: string; pod: string; app: string; cpuMillicores: number; memoryMiB: number }

export async function podUsage(): Promise<PodUsage[]> {
  const [metrics, pods] = await Promise.all([
    k8s('/apis/metrics.k8s.io/v1beta1/pods'),
    k8s('/api/v1/pods'),
  ]);
  const appByPod = new Map<string, string>();
  for (const p of pods.items) appByPod.set(`${p.metadata.namespace}/${p.metadata.name}`, appOf(p.metadata));
  return metrics.items.map((m: any) => ({
    namespace: m.metadata.namespace,
    pod: m.metadata.name,
    app: appByPod.get(`${m.metadata.namespace}/${m.metadata.name}`) ?? m.metadata.name,
    cpuMillicores: round(m.containers.reduce((n: number, c: any) => n + millicores(c.usage?.cpu), 0)),
    memoryMiB: round(m.containers.reduce((n: number, c: any) => n + mebibytes(c.usage?.memory), 0)),
  }));
}

export const round = (n: number, digits = 1) => Math.round(n * 10 ** digits) / 10 ** digits;

interface Sample { at: number; cpu: Map<string, { namespace: string; millicores: number }> }
const history: Sample[] = [];
const MAX_SAMPLES = 240; // 1 h at 15 s
export const SAMPLE_EVERY_MS = 15_000;
let lastError = '';

async function sample() {
  try {
    const cpu: Sample['cpu'] = new Map();
    for (const u of await podUsage()) {
      const key = `${u.namespace}/${u.app}`;
      const cur = cpu.get(key) ?? { namespace: u.namespace, millicores: 0 };
      cur.millicores += u.cpuMillicores;
      cpu.set(key, cur);
    }
    history.push({ at: Date.now(), cpu });
    if (history.length > MAX_SAMPLES) history.shift();
    lastError = '';
  } catch (e) {
    const msg = (e as Error).message;
    if (msg !== lastError) console.error(`[usage] sample failed: ${msg}`);
    lastError = msg;
  }
}

export function startSampler() {
  void sample();
  setInterval(sample, SAMPLE_EVERY_MS).unref();
}

export const sampleCount = () => history.length;

/** Rows `{ time: "HH:MM:SS", <app>: millicores }`, oldest first, plus the series keys for a TimeSeries. */
export function usageHistory(filter: (ns: string) => boolean, minutes = 30) {
  const since = Date.now() - minutes * 60_000;
  const window = history.filter(s => s.at >= since);
  // Use bare app names as keys unless two namespaces share one.
  const keys = new Set<string>();
  for (const s of window) for (const [k, v] of s.cpu) if (filter(v.namespace)) keys.add(k);
  const bare = new Map<string, number>();
  for (const k of keys) bare.set(k.split('/')[1], (bare.get(k.split('/')[1]) ?? 0) + 1);
  const label = (k: string) => (bare.get(k.split('/')[1])! > 1 ? k : k.split('/')[1]);
  const series = [...keys].sort().map(k => ({ key: label(k), label: label(k) }));
  const rows = window.map(s => {
    const row: Record<string, string | number> = { time: clock(s.at) };
    for (const k of keys) row[label(k)] = round(s.cpu.get(k)?.millicores ?? 0, 0);
    return row;
  });
  return { rows, series, sampleEverySec: SAMPLE_EVERY_MS / 1000, samples: rows.length };
}
