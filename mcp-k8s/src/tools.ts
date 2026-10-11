// MCP tools for one Kubernetes cluster. Reads use a cluster-wide read-only ClusterRole; writes are limited by
// RBAC to namespace `shop` (see infra/k8s/mcp.yaml). Every tool returns structuredContent + the same JSON as text.
import type { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod';
import { k8s, KubeError, mebibytes, millicores } from './kube.js';
import { podUsage, round, usageHistory } from './usage.js';
import {
  age, clock, deploymentRow, eventRow, imagesOf, inScope, isProblem, ownedBy, podRow, revisionOf, type Tone,
} from './views.js';

// ---------------------------------------------------------------- plumbing
type Json = Record<string, unknown>;
type ToolResult = { content: { type: 'text'; text: string }[]; structuredContent?: Json; isError?: boolean };

const ok = (value: Json): ToolResult => ({ content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value });
const fail = (text: string): ToolResult => ({ content: [{ type: 'text', text }], isError: true });

/** What a call was trying to do, for error messages. */
interface Intent { verb: string; resource: string; namespace?: string; name?: string }

function explain(e: unknown, intent: Intent): ToolResult {
  if (e instanceof UserError) return fail(e.message);
  if (e instanceof KubeError) {
    if (e.status === 403) {
      // "... cannot patch resource "deployments/scale" in API group "apps" in the namespace "payments""
      const m = /cannot (\w+) resource "([^"]+)"(?: in API group "[^"]*")?(?: in the namespace "([^"]+)")?/.exec(e.message);
      const verb = m?.[1] ?? intent.verb;
      const resource = m?.[2] ?? intent.resource;
      const ns = m?.[3] ?? intent.namespace;
      return fail(`Kubernetes RBAC denied this: PRISM may not ${verb} ${resource} ${ns ? `in namespace ${ns}` : 'at cluster scope'}. Nothing was changed.`);
    }
    if (e.status === 404) {
      return fail(`Not found: ${intent.resource}${intent.name ? ` "${intent.name}"` : ''}${intent.namespace ? ` in namespace ${intent.namespace}` : ''}.`);
    }
    if (e.status === 503 && intent.resource.startsWith('metrics')) {
      return fail('Metrics are not available yet: metrics-server needs about a minute after the cluster starts. Try again shortly.');
    }
    return fail(`Kubernetes rejected the request (${e.status}): ${e.message}`);
  }
  return fail(`Kubernetes API error while trying to ${intent.verb} ${intent.resource}: ${(e as Error).message}`);
}

class UserError extends Error {}

const enc = encodeURIComponent;
const nsPath = (ns: string) => `/namespaces/${enc(ns)}`;

const READ = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } as const;
const WRITE = { readOnlyHint: false, destructiveHint: true, openWorldHint: false } as const;

const scopeArgs = {
  namespace: z.string().optional().describe('Only this namespace. Omit for all application namespaces.'),
  includeSystem: z.boolean().optional().describe('Also include system namespaces (kube-*, prism-system, local-path-storage). Default false.'),
};
const dryRunArg = z.boolean().optional().describe('Preview only: the API server validates the change (dryRun=All) and nothing is persisted. Default false.');

const tone = z.enum(['ok', 'warn', 'bad']);
const podRowSchema = z.looseObject({
  namespace: z.string(), name: z.string(), app: z.string(), phase: z.string(), ready: z.string(), restarts: z.number(),
  reason: z.string(), image: z.string(), node: z.string(), age: z.string(), tone,
});
const deploymentRowSchema = z.looseObject({
  namespace: z.string(), name: z.string(), ready: z.number(), desired: z.number(), available: z.number(), image: z.string(),
  revision: z.number(), status: z.enum(['Healthy', 'Degraded', 'Progressing']), tone,
});
const eventRowSchema = z.looseObject({
  time: z.string(), namespace: z.string(), type: z.string(), reason: z.string(), object: z.string(), message: z.string(), count: z.number(), tone,
});
const writeResultSchema = z.looseObject({
  ok: z.boolean(), dryRun: z.boolean(), namespace: z.string(), name: z.string(), action: z.string(),
  changes: z.array(z.string()), summary: z.string(),
});

let callSeq = 0;
function register<S extends z.ZodObject>(
  server: McpServer,
  name: string,
  cfg: { title: string; description: string; input: S; output: z.ZodType; write?: boolean; idempotent?: boolean },
  intent: (args: z.infer<S>) => Intent,
  run: (args: z.infer<S>) => Promise<Json>,
) {
  server.registerTool(name, {
    title: cfg.title,
    description: cfg.description,
    inputSchema: cfg.input,
    outputSchema: cfg.output,
    annotations: cfg.write ? { ...WRITE, idempotentHint: !!cfg.idempotent, title: cfg.title } : { ...READ, title: cfg.title },
  } as any, (async (args: z.infer<S>) => {
    const id = ++callSeq;
    const t0 = Date.now();
    try {
      const out = ok(await run(args));
      console.log(`[tool #${id}] ${name} ${JSON.stringify(args)} ok ${Date.now() - t0}ms`);
      return out;
    } catch (e) {
      const out = explain(e, intent(args));
      console.log(`[tool #${id}] ${name} ${JSON.stringify(args)} error ${Date.now() - t0}ms: ${out.content[0].text}`);
      return out;
    }
  }) as any);
}

// ---------------------------------------------------------------- shared reads
async function getDeployment(namespace: string, name: string) {
  return k8s(`/apis/apps/v1${nsPath(namespace)}/deployments/${enc(name)}`);
}

/** ReplicaSets owned by a deployment, newest revision first. */
async function replicaSetsOf(d: any): Promise<any[]> {
  const rs = await k8s(`/apis/apps/v1${nsPath(d.metadata.namespace)}/replicasets`);
  return rs.items
    .filter((r: any) => (r.metadata.ownerReferences ?? []).some((o: any) => o.uid === d.metadata.uid))
    .sort((a: any, b: any) => revisionOf(b) - revisionOf(a));
}

const containerImages = (tpl: any): Map<string, string> =>
  new Map((tpl?.spec?.containers ?? []).map((c: any) => [c.name, c.image]));

/** Plain-language list of what differs between two versions of a deployment. */
function describeChanges(before: any, after: any, nextRevision: number): string[] {
  const changes: string[] = [];
  const a = containerImages(before.spec.template);
  const b = containerImages(after.spec.template);
  const multi = a.size > 1;
  for (const [c, img] of b) {
    if (a.get(c) !== img) changes.push(`image ${a.get(c) ?? '(none)'} → ${img}${multi ? ` (container ${c})` : ''}`);
  }
  if ((before.spec.replicas ?? 1) !== (after.spec.replicas ?? 1)) changes.push(`replicas ${before.spec.replicas ?? 1} → ${after.spec.replicas ?? 1}`);
  const ra = before.spec.template.metadata?.annotations?.['kubectl.kubernetes.io/restartedAt'];
  const rb = after.spec.template.metadata?.annotations?.['kubectl.kubernetes.io/restartedAt'];
  if (ra !== rb) changes.push(`restart: all ${after.spec.replicas ?? 1} pods are replaced one by one (restartedAt ${rb})`);
  const templateChanged = JSON.stringify(stripVolatile(before.spec.template)) !== JSON.stringify(stripVolatile(after.spec.template));
  if (templateChanged) changes.push(`revision ${revisionOf(before)} → ${nextRevision} (rolling update)`);
  return changes;
}
const stripVolatile = (tpl: any) => ({ ...tpl, metadata: { ...tpl.metadata, creationTimestamp: undefined } });

async function writeResult(action: string, namespace: string, name: string, dryRun: boolean, changes: string[], extra: Json = {}): Promise<Json> {
  const effective = changes.length ? changes : ['no change: the deployment already matches the requested state'];
  return {
    ok: true,
    dryRun,
    namespace,
    name,
    action,
    changes: effective,
    summary: `${dryRun ? 'Dry run (nothing changed): ' : ''}${namespace}/${name}: ${effective.join('; ')}`,
    ...extra,
  };
}

// ---------------------------------------------------------------- tools
export function registerTools(server: McpServer) {
  register(server, 'cluster_overview', {
    title: 'Cluster overview',
    description: 'One-call health summary of application workloads: nodes, deployments (healthy/degraded), pods (running/failing), restarts, warning events in the last hour, and current CPU/memory. `items` is ready for a MetricRow.',
    input: z.object({ includeSystem: scopeArgs.includeSystem }),
    output: z.looseObject({
      nodes: z.number(), nodesReady: z.number(), namespaces: z.array(z.string()), deployments: z.number(), deploymentsHealthy: z.number(),
      degradedDeployments: z.array(z.string()), pods: z.number(), podsWithProblems: z.number(), restarts: z.number(), warningsLastHour: z.number(),
      cpuMillicores: z.number().nullable(), memoryMiB: z.number().nullable(),
      items: z.array(z.looseObject({ label: z.string(), value: z.union([z.string(), z.number()]), hint: z.string().optional(), tone: tone.optional() })),
    }),
  }, () => ({ verb: 'list', resource: 'pods' }), async ({ includeSystem }) => {
    const [nodes, deps, pods, events, usage] = await Promise.all([
      k8s('/api/v1/nodes'), k8s('/apis/apps/v1/deployments'), k8s('/api/v1/pods'), k8s('/api/v1/events'),
      podUsage().catch(() => null),
    ]);
    const vis = (ns: string) => inScope(ns, undefined, includeSystem);
    const rawPods = pods.items.filter((p: any) => vis(p.metadata.namespace));
    const podRows = rawPods.map(podRow);
    const depRows = deps.items.filter((d: any) => vis(d.metadata.namespace)).map((d: any) => deploymentRow(d, rawPods));
    const problems = podRows.filter(isProblem);
    const degraded = depRows.filter((d: any) => d.status !== 'Healthy');
    const hourAgo = Date.now() - 3_600_000;
    const warnings = events.items.filter((e: any) => e.type === 'Warning' && vis(e.metadata.namespace)
      && Date.parse(e.lastTimestamp ?? e.eventTime ?? e.metadata.creationTimestamp) > hourAgo).length;
    const appUsage = usage?.filter(u => vis(u.namespace)) ?? null;
    const cpu = appUsage ? round(appUsage.reduce((n, u) => n + u.cpuMillicores, 0), 0) : null;
    const mem = appUsage ? round(appUsage.reduce((n, u) => n + u.memoryMiB, 0), 0) : null;
    const restarts = podRows.reduce((n: number, p: any) => n + p.restarts, 0);
    const nodesReady = nodes.items.filter((n: any) => n.status?.conditions?.some((c: any) => c.type === 'Ready' && c.status === 'True')).length;
    const t = (bad: boolean, warn = false): Tone => (bad ? 'bad' : warn ? 'warn' : 'ok');
    return {
      nodes: nodes.items.length,
      nodesReady,
      namespaces: [...new Set<string>(depRows.map((d: any) => d.namespace))].sort(),
      deployments: depRows.length,
      deploymentsHealthy: depRows.length - degraded.length,
      degradedDeployments: degraded.map((d: any) => `${d.namespace}/${d.name}`),
      pods: podRows.length,
      podsRunning: podRows.filter((p: any) => p.reason === 'Running').length,
      podsWithProblems: problems.length,
      problemPods: problems.map((p: any) => ({ namespace: p.namespace, name: p.name, reason: p.reason })),
      restarts,
      warningsLastHour: warnings,
      cpuMillicores: cpu,
      memoryMiB: mem,
      items: [
        { label: 'Deployments', value: `${depRows.length - degraded.length}/${depRows.length} healthy`, ...(degraded.length ? { hint: degraded.map((d: any) => d.name).join(', ') } : {}), tone: t(degraded.some((d: any) => d.status === 'Degraded'), degraded.length > 0) },
        { label: 'Pods', value: `${podRows.length - problems.length}/${podRows.length} ok`, ...(problems.length ? { hint: [...new Set(problems.map((p: any) => p.reason))].join(', ') } : {}), tone: t(problems.some((p: any) => p.tone === 'bad'), problems.length > 0) },
        { label: 'Restarts', value: restarts, tone: t(false, restarts > 0) },
        { label: 'Warnings (1h)', value: warnings, tone: t(false, warnings > 0) },
        { label: 'CPU', value: cpu === null ? 'n/a' : `${cpu}m`, tone: 'ok' as Tone },
        { label: 'Memory', value: mem === null ? 'n/a' : `${mem} MiB`, tone: 'ok' as Tone },
        { label: 'Nodes', value: `${nodesReady}/${nodes.items.length} ready`, tone: t(nodesReady < nodes.items.length) },
      ],
    };
  });

  register(server, 'list_deployments', {
    title: 'List deployments',
    description: 'Deployments with ready/desired replicas, current image, revision and status (Healthy | Degraded | Progressing; Degraded when any of its pods is failing). Rows include `tone` for colouring.',
    input: z.object(scopeArgs),
    output: z.looseObject({ deployments: z.array(deploymentRowSchema), count: z.number(), healthy: z.number(), degraded: z.number() }),
  }, a => ({ verb: 'list', resource: 'deployments', namespace: a.namespace }), async ({ namespace, includeSystem }) => {
    const base = namespace ? `${nsPath(namespace)}` : '';
    const [deps, pods] = await Promise.all([k8s(`/apis/apps/v1${base}/deployments`), k8s(`/api/v1${base}/pods`)]);
    const rows = deps.items
      .filter((d: any) => inScope(d.metadata.namespace, namespace, includeSystem))
      .map((d: any) => deploymentRow(d, pods.items))
      .sort((a: any, b: any) => a.namespace.localeCompare(b.namespace) || a.name.localeCompare(b.name));
    return {
      deployments: rows,
      count: rows.length,
      healthy: rows.filter((r: any) => r.status === 'Healthy').length,
      degraded: rows.filter((r: any) => r.status === 'Degraded').length,
    };
  });

  register(server, 'list_pods', {
    title: 'List pods',
    description: 'Pods with phase, ready containers ("1/2"), restarts, reason (Running, ImagePullBackOff, CrashLoopBackOff, ErrImagePull, Pending, ...), image, node and age. problemsOnly=true returns only pods that are not healthy (or restarted 3+ times).',
    input: z.object({ ...scopeArgs, problemsOnly: z.boolean().optional().describe('Only pods that are failing, pending, not ready, or restarting. Default false.') }),
    output: z.looseObject({ pods: z.array(podRowSchema), count: z.number(), problems: z.number() }),
  }, a => ({ verb: 'list', resource: 'pods', namespace: a.namespace }), async ({ namespace, includeSystem, problemsOnly }) => {
    const pods = await k8s(`/api/v1${namespace ? nsPath(namespace) : ''}/pods`);
    const all = pods.items.filter((p: any) => inScope(p.metadata.namespace, namespace, includeSystem)).map(podRow);
    const problems = all.filter(isProblem);
    const rows = (problemsOnly ? problems : all)
      .sort((a: any, b: any) => a.namespace.localeCompare(b.namespace) || a.name.localeCompare(b.name));
    return { pods: rows, count: rows.length, problems: problems.length };
  });

  register(server, 'list_events', {
    title: 'List events',
    description: 'Recent Kubernetes events, newest first: time (HH:MM:SS), type (Normal | Warning), reason (e.g. Failed, BackOff, Pulling, ScalingReplicaSet), object ("Pod/x"), message and count.',
    input: z.object({
      ...scopeArgs,
      type: z.enum(['Normal', 'Warning']).optional().describe('Only this event type'),
      limit: z.number().int().min(1).max(200).optional().describe('Max rows (default 30)'),
    }),
    output: z.looseObject({ events: z.array(eventRowSchema), count: z.number() }),
  }, a => ({ verb: 'list', resource: 'events', namespace: a.namespace }), async ({ namespace, includeSystem, type, limit }) => {
    const events = await k8s(`/api/v1${namespace ? nsPath(namespace) : ''}/events`);
    const rows = events.items
      .filter((e: any) => inScope(e.metadata.namespace, namespace, includeSystem) && (!type || e.type === type))
      .map(eventRow)
      .sort((a: any, b: any) => Date.parse(b.at ?? 0) - Date.parse(a.at ?? 0))
      .slice(0, limit ?? 30)
      .map(({ at: _at, ...r }: any) => r);
    return { events: rows, count: rows.length };
  });

  register(server, 'get_pod_logs', {
    title: 'Get pod logs',
    description: 'Last log lines of a pod (newest last). `pod` may also be a deployment/app name; the most relevant pod of it is used. previous=true reads the previous (crashed) container. Pods that never started (e.g. ImagePullBackOff) have no logs; the reason is returned in `note`.',
    input: z.object({
      namespace: z.string(),
      pod: z.string().describe('Pod name, or a deployment/app name'),
      container: z.string().optional().describe('Container name (default: the first)'),
      previous: z.boolean().optional().describe('Logs of the previous terminated container (after a crash)'),
      tailLines: z.number().int().min(1).max(1000).optional().describe('Number of lines (default 100)'),
    }),
    output: z.looseObject({ namespace: z.string(), pod: z.string(), container: z.string(), lines: z.array(z.string()), lineCount: z.number(), note: z.string().optional() }),
  }, a => ({ verb: 'get', resource: 'pods/log', namespace: a.namespace, name: a.pod }), async ({ namespace, pod, container, previous, tailLines }) => {
    const p = await resolvePod(namespace, pod);
    const c = container ?? p.spec.containers[0].name;
    const status = (p.status?.containerStatuses ?? []).find((s: any) => s.name === c);
    const base = { namespace, pod: p.metadata.name as string, container: c, previous: !!previous, reason: podRow(p).reason };
    try {
      const text = await k8s<string>(`/api/v1${nsPath(namespace)}/pods/${enc(p.metadata.name)}/log`, {
        text: true, query: { container: c, previous: previous || undefined, tailLines: tailLines ?? 100, timestamps: false },
      });
      const lines = text.split('\n').filter(l => l.length > 0);
      return { ...base, lines, lineCount: lines.length };
    } catch (e) {
      if (e instanceof KubeError && e.status === 400) {
        const waiting = status?.state?.waiting;
        const note = waiting?.message ? `${waiting.reason}: ${waiting.message}` : e.message;
        return { ...base, lines: [], lineCount: 0, note };
      }
      throw e;
    }
  });

  register(server, 'get_usage', {
    title: 'Get CPU and memory usage',
    description: 'Current CPU (millicores) and memory (MiB) from metrics-server, per pod, per app and per node, with totals.',
    input: z.object(scopeArgs),
    output: z.looseObject({
      apps: z.array(z.looseObject({ namespace: z.string(), app: z.string(), pods: z.number(), cpuMillicores: z.number(), memoryMiB: z.number() })),
      pods: z.array(z.looseObject({ namespace: z.string(), pod: z.string(), app: z.string(), cpuMillicores: z.number(), memoryMiB: z.number() })),
      nodes: z.array(z.looseObject({ name: z.string(), cpuMillicores: z.number(), memoryMiB: z.number() })),
      totals: z.looseObject({ cpuMillicores: z.number(), memoryMiB: z.number() }),
    }),
  }, a => ({ verb: 'list', resource: 'metrics.k8s.io pods', namespace: a.namespace }), async ({ namespace, includeSystem }) => {
    const [pods, nodeMetrics, nodes] = await Promise.all([
      podUsage(), k8s('/apis/metrics.k8s.io/v1beta1/nodes'), k8s('/api/v1/nodes'),
    ]);
    const rows = pods.filter(u => inScope(u.namespace, namespace, includeSystem))
      .sort((a, b) => a.namespace.localeCompare(b.namespace) || a.pod.localeCompare(b.pod));
    const apps = new Map<string, { namespace: string; app: string; pods: number; cpuMillicores: number; memoryMiB: number }>();
    for (const u of rows) {
      const k = `${u.namespace}/${u.app}`;
      const cur = apps.get(k) ?? { namespace: u.namespace, app: u.app, pods: 0, cpuMillicores: 0, memoryMiB: 0 };
      cur.pods += 1; cur.cpuMillicores += u.cpuMillicores; cur.memoryMiB += u.memoryMiB;
      apps.set(k, cur);
    }
    const alloc = new Map<string, any>(nodes.items.map((n: any) => [n.metadata.name, n.status?.allocatable ?? {}]));
    const nodeRows = nodeMetrics.items.map((m: any) => {
      const cpu = millicores(m.usage?.cpu);
      const mem = mebibytes(m.usage?.memory);
      const a = alloc.get(m.metadata.name) ?? {};
      return {
        name: m.metadata.name,
        cpuMillicores: round(cpu, 0),
        memoryMiB: round(mem, 0),
        cpuPercent: a.cpu ? round((100 * cpu) / millicores(a.cpu)) : null,
        memoryPercent: a.memory ? round((100 * mem) / mebibytes(a.memory)) : null,
      };
    });
    const appRows = [...apps.values()].map(a => ({ ...a, cpuMillicores: round(a.cpuMillicores), memoryMiB: round(a.memoryMiB) }))
      .sort((a, b) => b.cpuMillicores - a.cpuMillicores);
    return {
      apps: appRows,
      pods: rows,
      nodes: nodeRows,
      totals: {
        cpuMillicores: round(rows.reduce((n, u) => n + u.cpuMillicores, 0), 0),
        memoryMiB: round(rows.reduce((n, u) => n + u.memoryMiB, 0), 0),
      },
    };
  });

  register(server, 'get_usage_history', {
    title: 'CPU usage history',
    description: 'CPU per app over time (sampled every 15 s, kept for 1 hour). rows = [{time:"HH:MM:SS", <app>: millicores, ...}] oldest first; `series` lists the app keys, ready for a TimeSeries with x="time".',
    input: z.object({ ...scopeArgs, minutes: z.number().int().min(1).max(60).optional().describe('Window in minutes (default 30)') }),
    output: z.looseObject({
      rows: z.array(z.record(z.string(), z.union([z.string(), z.number()]))),
      series: z.array(z.looseObject({ key: z.string(), label: z.string() })),
      sampleEverySec: z.number(), samples: z.number(),
    }),
  }, a => ({ verb: 'list', resource: 'metrics.k8s.io pods', namespace: a.namespace }), async ({ namespace, includeSystem, minutes }) =>
    usageHistory(ns => inScope(ns, namespace, includeSystem), minutes ?? 30));

  register(server, 'describe_deployment', {
    title: 'Describe deployment',
    description: 'One deployment in detail: current image and revision, replicas, status and conditions, revision history (each revision\'s image, from its ReplicaSet), its pods, and recent events. Use the revision history to pick a rollback target.',
    input: z.object({ namespace: z.string(), name: z.string().describe('Deployment name') }),
    output: z.looseObject({
      namespace: z.string(), name: z.string(), image: z.string(), revision: z.number(), status: z.string(),
      desired: z.number(), ready: z.number(), available: z.number(),
      revisions: z.array(z.looseObject({ revision: z.number(), image: z.string(), replicaSet: z.string(), replicas: z.number(), current: z.boolean() })),
      previousRevision: z.number().nullable(), previousImage: z.string().nullable(),
      pods: z.array(podRowSchema), events: z.array(eventRowSchema),
    }),
  }, a => ({ verb: 'get', resource: 'deployments', namespace: a.namespace, name: a.name }), async ({ namespace, name }) => {
    const d = await getDeployment(namespace, name);
    const [rss, pods, events] = await Promise.all([
      replicaSetsOf(d),
      k8s(`/api/v1${nsPath(namespace)}/pods`),
      k8s(`/api/v1${nsPath(namespace)}/events`),
    ]);
    const mine = pods.items.filter((p: any) => ownedBy(p, d));
    const row = deploymentRow(d, mine);
    const current = revisionOf(d);
    const revisions = rss.map((r: any) => ({
      revision: revisionOf(r),
      image: imagesOf(r.spec.template),
      replicaSet: r.metadata.name,
      replicas: r.status?.replicas ?? 0,
      ready: r.status?.readyReplicas ?? 0,
      current: revisionOf(r) === current,
      createdAt: clock(r.metadata.creationTimestamp),
      age: age(r.metadata.creationTimestamp),
      changeCause: r.metadata.annotations?.['kubernetes.io/change-cause'] ?? null,
    }));
    const previous = revisions.find((r: any) => r.revision < current) ?? null;
    const related = new Set<string>([name, ...rss.map((r: any) => r.metadata.name), ...mine.map((p: any) => p.metadata.name)]);
    const ev = events.items
      .filter((e: any) => related.has(e.involvedObject?.name))
      .map(eventRow)
      .sort((a: any, b: any) => Date.parse(b.at ?? 0) - Date.parse(a.at ?? 0))
      .slice(0, 15)
      .map(({ at: _at, ...r }: any) => r);
    return {
      namespace,
      name,
      image: row.image,
      containers: d.spec.template.spec.containers.map((c: any) => ({ name: c.name, image: c.image })),
      revision: current,
      status: row.status,
      tone: row.tone,
      desired: row.desired,
      ready: row.ready,
      available: row.available,
      updated: row.updated,
      strategy: d.spec.strategy?.type ?? 'RollingUpdate',
      conditions: (d.status?.conditions ?? []).map((c: any) => ({ type: c.type, status: c.status, reason: c.reason ?? '', message: c.message ?? '' })),
      revisions,
      previousRevision: previous?.revision ?? null,
      previousImage: previous?.image ?? null,
      pods: mine.map(podRow),
      events: ev,
    };
  });

  // ---------------------------------------------------------------- writes (RBAC: namespace shop only)
  register(server, 'set_image', {
    title: 'Set container image',
    description: 'Change the image of one container of a deployment (like `kubectl set image`), which starts a rolling update. container defaults to the first container. dryRun=true previews the change without applying it.',
    input: z.object({
      namespace: z.string(), name: z.string().describe('Deployment name'),
      container: z.string().optional().describe('Container name (default: the first container)'),
      image: z.string().min(1).describe('Full image reference, e.g. prism/checkout:v1'),
      dryRun: dryRunArg,
    }),
    output: writeResultSchema, write: true, idempotent: true,
  }, a => ({ verb: 'patch', resource: 'deployments', namespace: a.namespace, name: a.name }), async ({ namespace, name, container, image, dryRun }) => {
    const before = await getDeployment(namespace, name);
    const containers: any[] = before.spec.template.spec.containers;
    const target = container ?? containers[0].name;
    if (!containers.some(c => c.name === target)) {
      throw new UserError(`Deployment ${namespace}/${name} has no container "${target}". Containers: ${containers.map(c => c.name).join(', ')}.`);
    }
    const after = await k8s(`/apis/apps/v1${nsPath(namespace)}/deployments/${enc(name)}`, {
      method: 'PATCH', contentType: 'application/strategic-merge-patch+json', dryRun,
      body: { spec: { template: { spec: { containers: [{ name: target, image }] } } } },
    });
    const next = Math.max(revisionOf(before), ...(await replicaSetsOf(before)).map(revisionOf)) + 1;
    return writeResult('set_image', namespace, name, !!dryRun, describeChanges(before, after, next), { container: target, image });
  });

  register(server, 'rollback_deployment', {
    title: 'Roll back deployment',
    description: 'Roll a deployment back to its previous revision, or to toRevision (like `kubectl rollout undo`): restores that revision\'s pod template, including its image. Use describe_deployment to see the revision history. dryRun=true previews the change.',
    input: z.object({
      namespace: z.string(), name: z.string().describe('Deployment name'),
      toRevision: z.number().int().min(1).optional().describe('Revision to restore (default: the one before the current revision)'),
      dryRun: dryRunArg,
    }),
    output: writeResultSchema, write: true,
  }, a => ({ verb: 'patch', resource: 'deployments', namespace: a.namespace, name: a.name }), async ({ namespace, name, toRevision, dryRun }) => {
    const before = await getDeployment(namespace, name);
    const rss = await replicaSetsOf(before);
    const current = revisionOf(before);
    const target = toRevision !== undefined
      ? rss.find(r => revisionOf(r) === toRevision)
      : rss.find(r => revisionOf(r) < current);
    if (!target) {
      const known = rss.map(r => `${revisionOf(r)} (${imagesOf(r.spec.template)})`).join(', ') || 'none';
      throw new UserError(toRevision !== undefined
        ? `Deployment ${namespace}/${name} has no revision ${toRevision}. Known revisions: ${known}.`
        : `Deployment ${namespace}/${name} has no revision before ${current} to roll back to. Known revisions: ${known}.`);
    }
    if (revisionOf(target) === current) throw new UserError(`Deployment ${namespace}/${name} is already at revision ${current}.`);
    const template = structuredClone(target.spec.template);
    if (template.metadata?.labels) delete template.metadata.labels['pod-template-hash'];
    const after = await k8s(`/apis/apps/v1${nsPath(namespace)}/deployments/${enc(name)}`, {
      method: 'PATCH', contentType: 'application/json-patch+json', dryRun,
      body: [{ op: 'replace', path: '/spec/template', value: template }],
    });
    const next = Math.max(current, ...rss.map(revisionOf)) + 1;
    const changes = describeChanges(before, after, next);
    if (changes.length) changes.push(`restores the pod template of revision ${revisionOf(target)}`);
    return writeResult('rollback_deployment', namespace, name, !!dryRun, changes, {
      fromRevision: current, toRevision: revisionOf(target), image: imagesOf(target.spec.template),
    });
  });

  register(server, 'restart_deployment', {
    title: 'Restart deployment',
    description: 'Rolling restart of all pods of a deployment (like `kubectl rollout restart`). dryRun=true previews the change.',
    input: z.object({ namespace: z.string(), name: z.string().describe('Deployment name'), dryRun: dryRunArg }),
    output: writeResultSchema, write: true,
  }, a => ({ verb: 'patch', resource: 'deployments', namespace: a.namespace, name: a.name }), async ({ namespace, name, dryRun }) => {
    const before = await getDeployment(namespace, name);
    const restartedAt = new Date().toISOString();
    const after = await k8s(`/apis/apps/v1${nsPath(namespace)}/deployments/${enc(name)}`, {
      method: 'PATCH', contentType: 'application/strategic-merge-patch+json', dryRun,
      body: { spec: { template: { metadata: { annotations: { 'kubectl.kubernetes.io/restartedAt': restartedAt } } } } },
    });
    const next = Math.max(revisionOf(before), ...(await replicaSetsOf(before)).map(revisionOf)) + 1;
    return writeResult('restart_deployment', namespace, name, !!dryRun, describeChanges(before, after, next), { restartedAt });
  });

  register(server, 'scale_deployment', {
    title: 'Scale deployment',
    description: 'Set the number of replicas of a deployment (0–10), like `kubectl scale`. dryRun=true previews the change.',
    input: z.object({
      namespace: z.string(), name: z.string().describe('Deployment name'),
      replicas: z.number().int().min(0).max(10).describe('Desired replicas, 0–10'),
      dryRun: dryRunArg,
    }),
    output: writeResultSchema, write: true, idempotent: true,
  }, a => ({ verb: 'patch', resource: 'deployments/scale', namespace: a.namespace, name: a.name }), async ({ namespace, name, replicas, dryRun }) => {
    const before = await getDeployment(namespace, name);
    const scale = await k8s(`/apis/apps/v1${nsPath(namespace)}/deployments/${enc(name)}/scale`, {
      method: 'PATCH', contentType: 'application/merge-patch+json', dryRun, body: { spec: { replicas } },
    });
    const from = before.spec.replicas ?? 1;
    const to = scale.spec?.replicas ?? replicas;
    return writeResult('scale_deployment', namespace, name, !!dryRun, from === to ? [] : [`replicas ${from} → ${to}`], { fromReplicas: from, replicas: to });
  });
}

/** A pod by exact name, or the most useful pod of a deployment/app with that name. */
async function resolvePod(namespace: string, name: string): Promise<any> {
  try {
    return await k8s(`/api/v1${nsPath(namespace)}/pods/${enc(name)}`);
  } catch (e) {
    if (!(e instanceof KubeError && e.status === 404)) throw e;
  }
  const pods = await k8s(`/api/v1${nsPath(namespace)}/pods`);
  const candidates = pods.items.filter((p: any) => p.metadata.name.startsWith(`${name}-`) || p.metadata.labels?.app === name);
  if (!candidates.length) throw new UserError(`No pod named "${name}" (or belonging to an app/deployment "${name}") in namespace ${namespace}.`);
  // Prefer pods that have logs (a container started at some point), failing ones first.
  const started = (p: any) => (p.status?.containerStatuses ?? []).some((c: any) => c.state?.running || c.state?.terminated || c.restartCount > 0);
  const score = (p: any) => (started(p) ? 2 : 0) + (podRow(p).tone === 'bad' ? 1 : 0);
  return candidates.sort((a: any, b: any) => score(b) - score(a))[0];
}
