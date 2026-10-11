// Fixture mode: an in-browser stand-in for the PRISM server with realistic Kubernetes data,
// so every screen can be built and checked before (or without) the real API.
import type {
  Activity, ActivityKind, ConnectionView, Decision, Incident, Panel, Playbook, Receipt, ServerMessage, Stats, Workspace,
} from './types.ts';

const ZERO: Receipt = { modelCalls: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, costUsd: 0, ms: 0 };
const iso = (agoMs = 0) => new Date(Date.now() - agoMs).toISOString();
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const clone = <T,>(v: T): T => JSON.parse(JSON.stringify(v)) as T;
let seq = 100;
const nextId = (p: string) => `${p}-${++seq}`;

const APPS = ['storefront', 'cart-api', 'checkout-worker', 'payments'] as const;

// ------------------------------------------------------------------ panels
function k8s(tool: string, args: Record<string, unknown> = {}, transform = '$') {
  return { connectionId: 'k8s', tool, args, transform };
}

const PANELS: Panel[] = [
  {
    id: 'p-overview', title: 'Cluster overview', refreshSec: 5, layout: { x: 0, y: 0, w: 12, h: 3 },
    binding: k8s('cluster_overview', {}, '{ "metrics": [...] }'),
    components: [{ id: 'root', component: 'MetricRow', items: { path: '/metrics' } }],
  },
  {
    id: 'p-deploys', title: 'Deployments in shop', refreshSec: 5, layout: { x: 0, y: 3, w: 5, h: 8 },
    binding: k8s('list_deployments', { namespace: 'shop' }),
    components: [{ id: 'root', component: 'StatusList', items: { path: '/deployments' },
      recordActions: [{ id: 'restart', label: 'Restart' }, { id: 'rollback', label: 'Roll back' }, { id: 'scale', label: 'Scale to 3' }] }],
    actions: [
      { id: 'restart', label: 'Restart', connectionId: 'k8s', tool: 'restart_deployment', recordKey: 'name', args: { namespace: { value: 'shop' }, name: { record: 'app' } } },
      { id: 'rollback', label: 'Roll back', connectionId: 'k8s', tool: 'rollback_deployment', recordKey: 'name', args: { namespace: { value: 'shop' }, name: { record: 'app' } } },
      { id: 'scale', label: 'Scale to 3', connectionId: 'k8s', tool: 'scale_deployment', recordKey: 'name', args: { namespace: { value: 'shop' }, name: { record: 'app' }, replicas: { value: 3 } } },
    ],
  },
  {
    id: 'p-pods', title: 'Problem pods', refreshSec: 5, layout: { x: 5, y: 3, w: 7, h: 8 },
    binding: k8s('list_pods', { namespace: 'shop', problemsOnly: true }),
    components: [{ id: 'root', component: 'DataTable', rows: { path: '/pods' }, toneKey: 'tone',
      columns: [{ key: 'name', label: 'Pod' }, { key: 'reason', label: 'Reason' }, { key: 'restarts', label: 'Restarts' }, { key: 'age', label: 'Age' }],
      recordActions: [{ id: 'rollback', label: 'Roll back' }] }],
    actions: [
      { id: 'rollback', label: 'Roll back', connectionId: 'k8s', tool: 'rollback_deployment', recordKey: 'name', args: { namespace: { value: 'shop' }, name: { record: 'deployment' } } },
    ],
  },
  {
    id: 'p-cpu', title: 'CPU per app', refreshSec: 10, layout: { x: 0, y: 11, w: 12, h: 7 },
    binding: k8s('get_usage', { namespace: 'shop' }),
    components: [{ id: 'root', component: 'TimeSeries', data: { path: '/rows' }, x: 't', kind: 'line',
      series: APPS.map(a => ({ key: a, label: a })) }],
  },
];

const EVIDENCE: Panel[] = [
  {
    id: 'ev-pods', title: 'Failing pods', refreshSec: 5, layout: { x: 0, y: 0, w: 6, h: 5 },
    binding: k8s('list_pods', { namespace: 'shop', problemsOnly: true }),
    components: [{ id: 'root', component: 'StatusList', items: { path: '/pods' } }],
  },
  {
    id: 'ev-diff', title: 'What changed', refreshSec: 10, layout: { x: 6, y: 0, w: 6, h: 5 },
    binding: k8s('describe_deployment', { namespace: 'shop', name: 'checkout-worker' }),
    components: [{ id: 'root', component: 'DataTable', rows: { path: '/revisions' }, toneKey: 'tone',
      columns: [{ key: 'revision', label: 'Rev' }, { key: 'image', label: 'Image' }, { key: 'when', label: 'When' }] }],
  },
  {
    id: 'ev-events', title: 'Recent warnings', refreshSec: 5, layout: { x: 0, y: 5, w: 12, h: 4 },
    binding: k8s('list_events', { namespace: 'shop', type: 'Warning', limit: 5 }),
    components: [{ id: 'root', component: 'CardList', items: { path: '/events' }, titleKey: 'message', subtitleKey: 'object', badgeKey: 'count', toneKey: 'tone' }],
  },
];

// ------------------------------------------------------------------ world state
interface World {
  broken: boolean;
  workspace: Workspace;
  incidents: Incident[];
  decisions: Decision[];
  playbooks: Playbook[];
  stats: Stats;
  activity: Activity[];
  connections: ConnectionView[];
  cpu: Record<string, number | string>[];
}

const PLAYBOOK: Playbook = {
  id: 'pb-1', workspaceId: 'demo', title: 'Roll back a bad image',
  match: { watcherId: 'w-pods', resource: 'shop/checkout-worker', reason: 'ImagePullBackOff' },
  evidenceTemplate: EVIDENCE,
  actionTemplate: {
    connectionId: 'k8s', tool: 'rollback_deployment', args: { namespace: 'shop', name: 'checkout-worker' },
    label: 'Roll back checkout-worker to the last working image', consequences: [],
  },
  rationale: 'New pods cannot pull the image; the previous revision ran cleanly.',
  origin: { incidentId: 'inc-1', incidentNumber: 1, savedBy: 'arnab', approvedBy: 'judge', at: iso(26 * 60_000),
    receipt: { modelCalls: 3, inputTokens: 18_400, outputTokens: 2_100, cacheReadTokens: 9_800, costUsd: 0.11, ms: 21_400 } },
  uses: 2,
};

function proposed() {
  return {
    connectionId: 'k8s', tool: 'rollback_deployment', args: { namespace: 'shop', name: 'checkout-worker', toRevision: 4 },
    label: 'Roll back checkout-worker to v1',
    consequences: ['Image goes back from checkout:v2-bad to checkout:v1', '2 failing pods get replaced', 'Runs in namespace shop as the PRISM operator account'],
  };
}

function seedWorld(): World {
  const now = Date.now();
  const cpu = Array.from({ length: 24 }, (_, i) => cpuPoint(new Date(now - (23 - i) * 10_000), i));
  const workspace: Workspace = {
    id: 'demo', owner: 'arnab', title: 'Shop cluster', version: 7, members: ['judge'],
    panels: clone(PANELS),
    watchers: [{ id: 'w-pods', panelId: 'p-pods', title: 'Pods failing to start', severity: 'critical',
      condition: 'pods[status != "Running"].{ "resource": namespace & "/" & deployment, "reason": reason }' }],
    buildReceipt: { modelCalls: 4, inputTokens: 31_000, outputTokens: 3_900, cacheReadTokens: 12_000, costUsd: 0.18, ms: 27_300 },
  };
  const incident: Incident = {
    id: 'inc-2', number: 2, workspaceId: 'demo', watcherId: 'w-pods', resource: 'shop/checkout-worker', reason: 'ImagePullBackOff',
    detail: 'Back-off pulling image "checkout:v2-bad"', signature: 'w-pods|shop/checkout-worker|ImagePullBackOff',
    status: 'awaiting-approval', openedAt: iso(48_000), decisionId: 'demo', receipt: ZERO,
  };
  const replay: Decision = {
    id: 'demo', workspaceId: 'demo', incidentId: 'inc-2', title: 'Roll back checkout-worker to v1',
    summary: "The image was changed to checkout:v2-bad, which doesn't exist, so new pods can't start. This matches incident #1, so the saved playbook proposes the same rollback.",
    rationale: 'Revision 4 (checkout:v1) ran cleanly for 3 days; revision 5 introduced an image that cannot be pulled.',
    evidence: clone(EVIDENCE), proposedAction: proposed(),
    dryRun: { ok: true, lines: ['Image goes back from v2-bad to v1 (server-side dry run)', '2 failing pods get replaced', "You're allowed to do this in shop (RBAC)"] },
    source: 'playbook', playbookId: 'pb-1', status: 'pending', createdAt: iso(47_000), receipt: { ...ZERO, ms: 812 }, matchMs: 812,
  };
  const agent: Decision = {
    ...clone(replay), id: 'agent', incidentId: 'inc-1', source: 'agent', playbookId: undefined, matchMs: undefined,
    summary: "The image was changed to checkout:v2-bad, which doesn't exist, so new pods can't start. The previous revision (checkout:v1) was healthy.",
    receipt: { modelCalls: 3, inputTokens: 18_400, outputTokens: 2_100, cacheReadTokens: 9_800, costUsd: 0.11, ms: 38_200 },
  };
  const act = (kind: ActivityKind, text: string, ago: number): Activity => ({ id: nextId('a'), workspaceId: 'demo', at: iso(ago), kind, text });
  return {
    broken: true, workspace, cpu,
    incidents: [incident],
    decisions: [replay, agent],
    playbooks: [clone(PLAYBOOK)],
    stats: { refreshes: 1284, modelCalls: 7, costUsd: 0.29 },
    connections: [
      { id: 'k8s', name: 'Kubernetes', url: 'http://localhost:7300/mcp', status: 'ok', viaGateway: true, protocolVersion: '2026-07-28',
        tools: ['cluster_overview', 'list_deployments', 'list_pods', 'list_events', 'get_pod_logs', 'get_usage', 'describe_deployment',
          'restart_deployment', 'scale_deployment', 'set_image', 'rollback_deployment'].map(name => ({ name, inputSchema: {} })) },
    ],
    activity: [
      act('decision', 'Decision ready: Roll back checkout-worker to v1 · waiting for approval', 46_000),
      act('playbook', 'Playbook “Roll back a bad image” matched in 812 ms · 0 model calls', 47_000),
      act('incident', 'Incident #2 opened · shop/checkout-worker · ImagePullBackOff', 48_000),
      act('refresh', 'Refreshed 4 panels · 0 model calls', 50_000),
      act('gateway', 'agentgateway allowed rollback_deployment (signed by judge)', 26 * 60_000),
      act('validate', 'Validated 4 panels against the PRISM catalog', 60 * 60_000),
      act('tool', 'list_pods {"namespace":"shop"} → 16 pods', 61 * 60_000),
      act('model', 'claude-opus-5-5 composed the workspace · 4 calls · $0.18', 62 * 60_000),
    ],
  };
}

function cpuPoint(d: Date, i: number): Record<string, number | string> {
  const w = (base: number, amp: number) => Math.max(0, Math.round((base + Math.sin(i / 2.6 + base) * amp + (Math.random() - 0.5) * amp) * 10) / 10);
  return { t: d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', second: '2-digit' }).replace(/\s?[AP]M/, ''),
    storefront: w(210, 30), 'cart-api': w(140, 20), 'checkout-worker': w(world?.broken ? 4 : 120, world?.broken ? 3 : 18), payments: w(90, 14) };
}

let world: World | undefined;
function W(): World {
  if (!world) world = seedWorld();
  return world;
}

// ------------------------------------------------------------------ panel data (what the JSONata transforms would produce)
function panelData(panelId: string): unknown {
  const w = W();
  const broken = w.broken;
  switch (panelId) {
    case 'p-overview':
      return { metrics: [
        { label: 'Nodes ready', value: '3 / 3', hint: 'kind · v1.36', tone: 'ok' },
        { label: 'Pods running', value: broken ? '14 / 16' : '16 / 16', hint: broken ? '2 failing to start' : 'all healthy', tone: broken ? 'bad' : 'ok' },
        { label: 'Deployments', value: '5', hint: broken ? '1 degraded' : 'all available', tone: broken ? 'warn' : 'ok' },
        { label: 'Warnings · 10 min', value: broken ? String(6 + Math.floor(Math.random() * 3)) : '0', hint: broken ? 'image pull errors' : 'quiet', tone: broken ? 'warn' : 'ok' },
      ] };
    case 'p-deploys':
      return { deployments: [
        { name: 'storefront', app: 'storefront', status: '3/3 ready', detail: 'storefront:v4 · rev 7', tone: 'ok' },
        { name: 'cart-api', app: 'cart-api', status: '2/2 ready', detail: 'cart-api:v12 · rev 3', tone: 'ok' },
        broken
          ? { name: 'checkout-worker', app: 'checkout-worker', status: '0/2 ready', detail: 'checkout:v2-bad · rev 5', tone: 'bad' }
          : { name: 'checkout-worker', app: 'checkout-worker', status: '2/2 ready', detail: 'checkout:v1 · rev 6', tone: 'ok' },
        { name: 'payments', app: 'payments', status: '2/2 ready', detail: 'payments:v9 · rev 2', tone: 'ok' },
        { name: 'redis', app: 'redis', status: '1/1 ready', detail: 'redis:7.4 · rev 1', tone: 'ok' },
      ] };
    case 'p-pods':
    case 'ev-pods': {
      const pods = broken
        ? [
            { name: 'checkout-worker-7d9f-x2k', deployment: 'checkout-worker', reason: 'ImagePullBackOff', status: 'ImagePullBackOff', restarts: 0, age: '41s', detail: 'checkout:v2-bad not found', tone: 'bad' },
            { name: 'checkout-worker-7d9f-q8n', deployment: 'checkout-worker', reason: 'ErrImagePull', status: 'ErrImagePull', restarts: 0, age: '39s', detail: 'checkout:v2-bad not found', tone: 'bad' },
          ]
        : [];
      if (panelId === 'p-pods') return { pods };
      return { pods: broken ? pods : [{ name: 'checkout-worker-5c8b-m4t', status: 'Running', detail: 'checkout:v1 · ready', tone: 'ok' }, { name: 'checkout-worker-5c8b-p9z', status: 'Running', detail: 'checkout:v1 · ready', tone: 'ok' }] };
    }
    case 'p-cpu':
      return { rows: w.cpu };
    case 'ev-diff':
      return { revisions: [
        ...(broken ? [] : [{ revision: 6, image: 'checkout:v1', when: 'just now', tone: 'ok' }]),
        { revision: 5, image: 'checkout:v2-bad', when: '2 min ago · kubectl set image', tone: 'bad' },
        { revision: 4, image: 'checkout:v1', when: '3 days ago', tone: 'ok' },
      ] };
    case 'ev-events':
      return { events: broken
        ? [
            { message: 'Failed to pull image "checkout:v2-bad": not found', object: 'pod/checkout-worker-7d9f-x2k', count: '×6', tone: 'warn' },
            { message: 'Back-off pulling image "checkout:v2-bad"', object: 'pod/checkout-worker-7d9f-q8n', count: '×4', tone: 'warn' },
          ]
        : [{ message: 'Scaled up replica set checkout-worker-5c8b to 2', object: 'deployment/checkout-worker', count: '×1', tone: 'ok' }] };
    default:
      return { items: [] };
  }
}

// ------------------------------------------------------------------ live hub (stands in for the WebSocket)
type Listener = (m: ServerMessage) => void;
const listeners = new Set<Listener>();
let timer: ReturnType<typeof setInterval> | undefined;

function emit(m: ServerMessage) {
  for (const l of listeners) l(m);
}
function activity(kind: ActivityKind, text: string) {
  const item: Activity = { id: nextId('a'), workspaceId: 'demo', at: iso(), kind, text };
  W().activity.unshift(item);
  emit({ type: 'activity', item });
}

function tick() {
  const w = W();
  w.cpu = [...w.cpu.slice(1), cpuPoint(new Date(), w.cpu.length + Math.random() * 100)];
  for (const p of w.workspace.panels) emit({ type: 'panel-data', panelId: p.id, data: panelData(p.id), at: iso() });
  for (const d of w.decisions) for (const p of d.evidence) emit({ type: 'panel-data', panelId: p.id, data: panelData(p.id), at: iso() });
  w.stats = { ...w.stats, refreshes: w.stats.refreshes + w.workspace.panels.length };
  emit({ type: 'stats', stats: w.stats });
}

export function fixtureSubscribe(_wsId: string, listener: Listener): () => void {
  const w = W();
  listeners.add(listener);
  // Same "hello" the real server sends on connect.
  setTimeout(() => {
    listener({ type: 'workspace', workspace: clone(w.workspace) });
    for (const p of w.workspace.panels) listener({ type: 'panel-data', panelId: p.id, data: panelData(p.id), at: iso(1500) });
    for (const d of w.decisions) for (const p of d.evidence) listener({ type: 'panel-data', panelId: p.id, data: panelData(p.id), at: iso(1500) });
    for (const i of w.incidents) listener({ type: 'incident', incident: clone(i) });
    for (const d of w.decisions) listener({ type: 'decision', decision: clone(d) });
    for (const p of w.playbooks) listener({ type: 'playbook', playbook: clone(p) });
    listener({ type: 'stats', stats: w.stats });
    for (const a of [...w.activity].reverse()) listener({ type: 'activity', item: a });
  }, 120);
  if (!timer) timer = setInterval(tick, 5000);
  return () => {
    listeners.delete(listener);
    if (!listeners.size && timer) { clearInterval(timer); timer = undefined; }
  };
}

// ------------------------------------------------------------------ REST stand-in
class FixtureError extends Error {}

function snapshot() {
  const w = W();
  return { workspace: clone(w.workspace), incidents: clone(w.incidents), decisions: clone(w.decisions), playbooks: clone(w.playbooks), stats: w.stats };
}

async function execute(d: Decision, user: string): Promise<Decision> {
  const w = W();
  d.status = 'approved'; d.decidedBy = user; d.decidedAt = iso();
  emit({ type: 'decision', decision: clone(d) });
  activity('decision', `Approved by ${user}: ${d.proposedAction.label}`);
  await sleep(500);
  activity('gateway', `agentgateway verified the signed approval for ${d.proposedAction.tool} · allowed`);
  await sleep(500);
  activity('tool', `${d.proposedAction.tool} ${JSON.stringify(d.proposedAction.args)} → rolled back`);
  w.broken = false;
  d.status = 'executed';
  d.result = { ok: true, text: 'deployment.apps/checkout-worker rolled back to revision 4 (checkout:v1)', gateway: 'allowed · signature + exact arguments' };
  const inc = w.incidents.find(i => i.id === d.incidentId);
  if (inc) { inc.status = 'resolved'; inc.resolvedAt = iso(); emit({ type: 'incident', incident: clone(inc) }); }
  if (d.playbookId) {
    const pb = w.playbooks.find(p => p.id === d.playbookId);
    if (pb) { pb.uses += 1; emit({ type: 'playbook', playbook: clone(pb) }); }
  }
  emit({ type: 'decision', decision: clone(d) });
  activity('incident', 'Watcher cleared · checkout-worker 2/2 ready');
  tick();
  return clone(d);
}

export async function fixtureRequest(method: string, path: string, body: unknown, user: string): Promise<unknown> {
  const w = W();
  await sleep(140);
  const b = (body ?? {}) as Record<string, unknown>;
  const seg = path.split('?')[0].split('/').filter(Boolean);
  const is = (m: string, ...parts: (string | null)[]) =>
    method === m && seg.length === parts.length && parts.every((p, i) => p === null || p === seg[i]);

  if (is('GET', 'me')) return { user };
  if (is('GET', 'connections')) return clone(w.connections);
  if (is('POST', 'connections')) {
    const url = String(b.url ?? '');
    if (!/^https?:\/\//.test(url)) throw new FixtureError('URL must start with https:// (or an allowed local http address)');
    await sleep(900);
    const c: ConnectionView = { id: nextId('c'), name: String(b.name || new URL(url).hostname), url, status: 'ok', viaGateway: true,
      protocolVersion: '2026-07-28', tools: ['search', 'list_items', 'get_item'].map(name => ({ name, inputSchema: {} })) };
    w.connections.push(c);
    activity('info', `Connected ${c.name} · ${c.tools.length} tools`);
    return c;
  }
  if (is('GET', 'workspaces')) return [{ id: 'demo', title: w.workspace.title, owner: 'arnab' }, { id: 'sdlc', title: 'SDLC health', owner: 'arnab' }];
  if (is('POST', 'workspaces')) return clone(w.workspace);
  if (is('GET', 'workspaces', null)) return snapshot();
  if (is('POST', 'workspaces', null, 'compose')) {
    emit({ type: 'compose', state: 'started' });
    activity('model', `claude-opus-5-5 · planning for “${String(b.prompt ?? '').slice(0, 60)}”`);
    await sleep(700);
    activity('tool', 'list_events {"namespace":"shop","type":"Warning"} → 8 events (sample)');
    await sleep(700);
    activity('validate', 'Panel “Warning events” validated: binding executed, A2UI surface OK');
    await sleep(500);
    const receipt: Receipt = { modelCalls: 2, inputTokens: 9_200, outputTokens: 880, cacheReadTokens: 6_100, costUsd: 0.04, ms: 1_900 };
    const summary = 'Your workspace is up to date: 4 panels refresh every 5–10 s with no model calls, and a watcher opens an incident when pods fail to start.';
    w.stats = { ...w.stats, modelCalls: w.stats.modelCalls + 2, costUsd: w.stats.costUsd + 0.04 };
    emit({ type: 'stats', stats: w.stats });
    emit({ type: 'compose', state: 'done', summary, receipt });
    return { summary, receipt, workspace: clone(w.workspace) };
  }
  if (is('POST', 'workspaces', null, 'ops')) {
    for (const op of (b.ops as { op: string; panelId?: string; layout?: Panel['layout'] }[]) ?? []) {
      if (op.op === 'move_resize') {
        const p = w.workspace.panels.find(x => x.id === op.panelId);
        if (p && op.layout) p.layout = op.layout;
      }
    }
    w.workspace.version += 1;
    return clone(w.workspace);
  }
  if (is('POST', 'workspaces', null, 'members')) {
    if (!w.workspace.members.includes(String(b.user))) w.workspace.members.push(String(b.user));
    return clone(w.workspace);
  }
  if (is('POST', 'workspaces', null, 'panels', null, 'refresh')) return { data: panelData(seg[3]), at: iso() };
  if (is('POST', 'workspaces', null, 'panels', null, 'actions')) {
    const panel = w.workspace.panels.find(p => p.id === seg[3]);
    const action = panel?.actions?.find(a => a.id === b.actionId);
    const record = (b.record ?? {}) as Record<string, unknown>;
    if (!panel || !action) throw new FixtureError('Unknown action');
    const name = String(record.deployment ?? record.app ?? record.name ?? 'checkout-worker');
    const args: Record<string, unknown> = { namespace: 'shop', name };
    if (action.tool === 'scale_deployment') args.replicas = 3;
    const d: Decision = {
      ...clone(w.decisions[0]), id: nextId('d'), incidentId: undefined, source: 'person', playbookId: undefined, matchMs: undefined,
      title: `${action.label} ${name}`, summary: `${user} asked to ${action.label.toLowerCase()} ${name} from the “${panel.title}” panel.`,
      rationale: 'Requested from a panel.', status: 'pending', createdAt: iso(), receipt: ZERO,
      proposedAction: { connectionId: 'k8s', tool: action.tool, args, label: `${action.label} ${name}`,
        consequences: [`Calls ${action.tool} on shop/${name}`, 'Kubernetes replaces pods gradually (rolling update)', 'Runs in namespace shop as the PRISM operator account'] },
      dryRun: { ok: true, lines: [`${action.tool} accepted by the API server (dry run)`, "You're allowed to do this in shop (RBAC)"] },
    };
    w.decisions.push(d);
    emit({ type: 'decision', decision: clone(d) });
    activity('decision', `${user} proposed: ${d.title} · waiting for approval`);
    return clone(d);
  }
  if (is('POST', 'incidents', null, 'investigate')) return clone(w.decisions.find(d => d.source === 'agent'));
  if (is('GET', 'decisions', null)) {
    const d = w.decisions.find(x => x.id === seg[1]) ?? w.decisions[0];
    return { decision: clone(d), incident: clone(w.incidents.find(i => i.id === d.incidentId)) ?? (d.source === 'agent'
      ? { ...clone(w.incidents[0]), id: 'inc-1', number: 1, decisionId: 'agent', receipt: d.receipt } : undefined),
    playbook: clone(w.playbooks.find(p => p.id === d.playbookId)) };
  }
  if (is('POST', 'decisions', null, 'approve')) {
    const d = w.decisions.find(x => x.id === seg[1]);
    if (!d) throw new FixtureError('Decision not found');
    if (d.status !== 'pending') throw new FixtureError('already-handled');
    return execute(d, user);
  }
  if (is('POST', 'decisions', null, 'reject')) {
    const d = w.decisions.find(x => x.id === seg[1]);
    if (!d) throw new FixtureError('Decision not found');
    d.status = 'rejected'; d.decidedBy = user; d.decidedAt = iso(); d.note = b.note ? String(b.note) : undefined;
    emit({ type: 'decision', decision: clone(d) });
    activity('decision', `Rejected by ${user}${d.note ? `: “${d.note}”` : ''}`);
    return clone(d);
  }
  if (is('POST', 'decisions', null, 'playbook')) {
    const d = w.decisions.find(x => x.id === seg[1]);
    if (!d) throw new FixtureError('Decision not found');
    const pb: Playbook = { ...clone(PLAYBOOK), id: nextId('pb'), uses: 0,
      origin: { ...PLAYBOOK.origin, incidentId: d.incidentId ?? 'inc-1', savedBy: user, approvedBy: d.decidedBy, at: iso(), receipt: d.receipt } };
    w.playbooks.push(pb);
    d.playbookId = pb.id;
    emit({ type: 'playbook', playbook: clone(pb) });
    emit({ type: 'decision', decision: clone(d) });
    activity('playbook', `Saved playbook “${pb.title}” · next time: 0 model calls`);
    return clone(pb);
  }
  if (is('POST', 'admin', 'reset')) { world = seedWorld(); return { ok: true }; }
  throw new FixtureError(`Fixture has no route for ${method} /api${path}`);
}

/** Demo world reset (used by the "Break again" dev affordance in fixture mode). */
export function fixtureBreak() {
  const w = W();
  w.broken = true;
  tick();
}
