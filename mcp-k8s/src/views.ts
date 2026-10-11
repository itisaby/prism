// Flat, dashboard-friendly row shapes. Every row carries a `tone` (ok | warn | bad) so a DataTable can colour it.
const SYSTEM_NS = /^(kube-.*|prism-system|local-path-storage)$/;
const DISPLAY_TZ = process.env.DISPLAY_TZ ?? 'America/New_York';

export type Tone = 'ok' | 'warn' | 'bad';

export const isSystemNs = (ns: string) => SYSTEM_NS.test(ns);
/** Explicit namespace wins; otherwise hide system namespaces unless asked. */
export const inScope = (ns: string, namespace?: string, includeSystem?: boolean) =>
  namespace ? ns === namespace : includeSystem || !isSystemNs(ns);

export const appOf = (meta: any): string =>
  meta?.labels?.['app.kubernetes.io/name'] ?? meta?.labels?.app ?? meta?.labels?.['k8s-app'] ?? meta?.name ?? 'unknown';

export function age(ts?: string): string {
  if (!ts) return '';
  const s = Math.max(0, Math.floor((Date.now() - Date.parse(ts)) / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h${Math.floor((s % 3600) / 60) ? `${Math.floor((s % 3600) / 60)}m` : ''}`;
  return `${Math.floor(s / 86400)}d`;
}

export const clock = (d: Date | string | number) =>
  new Date(d).toLocaleTimeString('en-GB', { timeZone: DISPLAY_TZ, hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });

const HEALTHY_REASONS = new Set(['Running', 'Completed', 'Succeeded']);
const PENDING_REASONS = new Set(['ContainerCreating', 'PodInitializing', 'Pending', 'Terminating', 'NotReady']);

/** Most specific human reason for a pod's state, the way `kubectl get pods` STATUS reads. */
export function podReason(p: any): string {
  if (p.metadata?.deletionTimestamp) return 'Terminating';
  const statuses = [...(p.status?.initContainerStatuses ?? []), ...(p.status?.containerStatuses ?? [])];
  for (const c of statuses) if (c.state?.waiting?.reason) return c.state.waiting.reason;
  for (const c of statuses) if (c.state?.terminated?.reason && p.status?.phase !== 'Succeeded') return c.state.terminated.reason;
  const phase = p.status?.phase ?? 'Unknown';
  if (phase === 'Pending') {
    const unsched = p.status?.conditions?.find((c: any) => c.type === 'PodScheduled' && c.status === 'False');
    return unsched?.reason ?? 'Pending';
  }
  if (phase === 'Running' && (p.status?.containerStatuses ?? []).some((c: any) => !c.ready)) return 'NotReady';
  return phase;
}

export function podRow(p: any) {
  const cs: any[] = p.status?.containerStatuses ?? [];
  const reason = podReason(p);
  const tone: Tone = HEALTHY_REASONS.has(reason) ? 'ok' : PENDING_REASONS.has(reason) ? 'warn' : 'bad';
  return {
    namespace: p.metadata.namespace as string,
    name: p.metadata.name as string,
    app: appOf(p.metadata),
    phase: (p.status?.phase ?? 'Unknown') as string,
    ready: `${cs.filter(c => c.ready).length}/${p.spec?.containers?.length ?? cs.length}`,
    restarts: cs.reduce((n, c) => n + (c.restartCount ?? 0), 0),
    reason,
    image: (p.spec?.containers ?? []).map((c: any) => c.image).join(', '),
    node: (p.spec?.nodeName ?? '') as string,
    age: age(p.metadata.creationTimestamp),
    tone,
  };
}
export type PodRow = ReturnType<typeof podRow>;
export const isProblem = (r: PodRow) => r.tone !== 'ok' || r.restarts >= 3;

export const revisionOf = (o: any): number => Number(o?.metadata?.annotations?.['deployment.kubernetes.io/revision'] ?? 0);
export const imagesOf = (tpl: any): string => (tpl?.spec?.containers ?? []).map((c: any) => c.image).join(', ');

/** Pods belong to a deployment through ReplicaSet `<deployment>-<pod-template-hash>`. */
export const ownedBy = (pod: any, d: any) =>
  pod.metadata?.namespace === d.metadata.namespace
  && (pod.metadata?.ownerReferences ?? []).some((o: any) => o.kind === 'ReplicaSet' && o.name === `${d.metadata.name}-${pod.metadata?.labels?.['pod-template-hash']}`);

export function deploymentStatus(d: any, pods: PodRow[] = []): 'Healthy' | 'Degraded' | 'Progressing' {
  const desired = d.spec?.replicas ?? 1;
  const st = d.status ?? {};
  if (st.conditions?.some((c: any) => c.type === 'Progressing' && c.status === 'False')) return 'Degraded';
  if (pods.some(p => p.tone === 'bad')) return 'Degraded';
  const settled = (st.observedGeneration ?? 0) >= (d.metadata?.generation ?? 0)
    && (st.updatedReplicas ?? 0) >= desired && (st.replicas ?? 0) <= desired
    && (st.availableReplicas ?? 0) >= desired && (st.readyReplicas ?? 0) >= desired;
  return settled ? 'Healthy' : 'Progressing';
}

/** `pods` = raw pod objects in the same namespace (used to spot failing pods of an in-flight rollout). */
export function deploymentRow(d: any, pods: any[] = []) {
  const status = deploymentStatus(d, pods.filter(p => ownedBy(p, d)).map(podRow));
  return {
    namespace: d.metadata.namespace as string,
    name: d.metadata.name as string,
    ready: (d.status?.readyReplicas ?? 0) as number,
    desired: (d.spec?.replicas ?? 1) as number,
    available: (d.status?.availableReplicas ?? 0) as number,
    updated: (d.status?.updatedReplicas ?? 0) as number,
    image: imagesOf(d.spec?.template),
    revision: revisionOf(d),
    status,
    age: age(d.metadata.creationTimestamp),
    tone: (status === 'Healthy' ? 'ok' : status === 'Progressing' ? 'warn' : 'bad') as Tone,
  };
}
export type DeploymentRow = ReturnType<typeof deploymentRow>;

export function eventRow(e: any) {
  const when = e.lastTimestamp ?? e.eventTime ?? e.series?.lastObservedTime ?? e.firstTimestamp ?? e.metadata?.creationTimestamp;
  return {
    time: when ? clock(when) : '',
    age: age(when),
    at: when as string | undefined,
    namespace: e.metadata?.namespace as string,
    type: (e.type ?? 'Normal') as string,
    reason: (e.reason ?? '') as string,
    object: `${e.involvedObject?.kind ?? e.regarding?.kind ?? ''}/${e.involvedObject?.name ?? e.regarding?.name ?? ''}`,
    message: ((e.message ?? e.note ?? '') as string).trim(),
    count: (e.count ?? e.series?.count ?? 1) as number,
    tone: (e.type === 'Warning' ? 'bad' : 'ok') as Tone,
  };
}
