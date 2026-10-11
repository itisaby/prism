// PRISM API + WebSocket server (:7100).
import { serve } from '@hono/node-server';
import { Hono, type Context } from 'hono';
import { WebSocketServer } from 'ws';
import type { Decision, Incident, Playbook } from '../../shared/types.ts';
import { initApprovalKeys } from './approval.ts';
import { recentActivity, subscribe } from './bus.ts';
import { compose } from './composer.ts';
import { config } from './config.ts';
import { store } from './db.ts';
import { BadRequest, Forbidden, approve, decisionFromRecordAction, getDecision, refreshEvidence, reject, savePlaybook } from './decisions.ts';
import { investigate, onPanelRaw, resetWorkspace, setAutoInvestigate } from './incidents.ts';
import { prismMcp } from './prism-mcp.ts';
import { capture } from './telemetry.ts';
import { searchRegistry } from './registry.ts';
import { addConnection, discover, listConnections, loadConnections, removeConnection, view } from './mcp.ts';
import { getStats, latest, loadValidator, publicWorkspace, refreshPanel, scheduleAll, setRawListener } from './runtime.ts';
import { Conflict, Invalid, applyOps, canEdit, canView, createWorkspace, getWorkspace, listWorkspaces, saveWorkspace } from './workspaces.ts';

const app = new Hono();
const userOf = (c: Context) => (c.req.header('x-prism-user') || c.req.query('as') || 'arnab').toLowerCase().replace(/[^a-z0-9_-]/g, '').slice(0, 32) || 'arnab';

app.onError((e, c) => {
  if (e instanceof Conflict) return c.json({ error: e.message }, 409);
  if (e instanceof Invalid) return c.json({ error: 'invalid', problems: e.problems }, 400);
  if (e instanceof BadRequest) return c.json({ error: e.message }, 400);
  if (e instanceof Forbidden) return c.json({ error: e.message }, 403);
  console.error(e);
  capture(e, { path: c.req.path });
  return c.json({ error: (e as Error).message }, 500);
});

app.get('/healthz', c => c.json({ ok: true }));
// PRISM's own MCP server (agents add panels / send decisions). Localhost only today; production adds OAuth.
app.all('/mcp', c => prismMcp.fetch(c.req.raw));
app.get('/api/me', c => c.json({ user: userOf(c) }));

// ---------------------------------------------------------------- connections
app.get('/api/connections', async c => {
  const user = userOf(c);
  const list = listConnections(user);
  await Promise.all(list.map(x => discover(x, user)));
  return c.json(list.map(view));
});
app.post('/api/connections', async c => {
  const body = await c.req.json();
  try { return c.json(view(await addConnection(userOf(c), body))); }
  catch (e) { return c.json({ error: (e as Error).message }, 400); }
});
app.delete('/api/connections/:id', c => c.json({ ok: removeConnection(userOf(c), c.req.param('id')) }));

// ---------------------------------------------------------------- workspaces
const wsOr404 = (c: Context) => {
  const w = getWorkspace(c.req.param('id')!);
  if (!w || !canView(w, userOf(c))) throw new BadRequest('workspace not found');
  return w;
};

app.get('/api/workspaces', c => c.json(listWorkspaces(userOf(c))));
app.post('/api/workspaces', async c => {
  const body = await c.req.json().catch(() => ({}));
  const w = createWorkspace(userOf(c), body.title);
  return c.json(publicWorkspace(w));
});
app.get('/api/workspaces/:id', c => {
  const w = wsOr404(c);
  return c.json({
    workspace: publicWorkspace(w),
    incidents: store.list<Incident>('incident', w.id),
    decisions: store.list<Decision>('decision', w.id),
    playbooks: store.list<Playbook>('playbook', w.id),
    stats: getStats(w.id),
    panelData: Object.fromEntries(w.panels.map(p => [p.id, latest(w.id, p.id)]).filter(([, v]) => v)),
  });
});
app.post('/api/workspaces/:id/compose', async c => {
  const w = wsOr404(c);
  if (!canEdit(w, userOf(c))) throw new Forbidden('only the owner can change this workspace');
  const { prompt } = await c.req.json();
  if (!prompt?.trim()) throw new BadRequest('prompt is required');
  const r = await compose(w.id, userOf(c), String(prompt).slice(0, 2000));
  return c.json({ ...r, workspace: r.workspace ? publicWorkspace(r.workspace) : undefined });
});
app.post('/api/workspaces/:id/ops', async c => {
  const w = wsOr404(c);
  if (!canEdit(w, userOf(c))) throw new Forbidden('only the owner can change this workspace');
  const { baseVersion, ops } = await c.req.json();
  return c.json(publicWorkspace(await applyOps(w.id, userOf(c), baseVersion, ops)));
});
app.post('/api/workspaces/:id/members', async c => {
  const w = wsOr404(c);
  if (!canEdit(w, userOf(c))) throw new Forbidden('only the owner can add members');
  const { user } = await c.req.json();
  if (user && !w.members.includes(user)) w.members.push(String(user));
  return c.json(publicWorkspace(saveWorkspace(w)));
});
app.post('/api/workspaces/:id/panels/:pid/refresh', async c => {
  const w = wsOr404(c);
  const pid = c.req.param('pid');
  if (w.panels.some(p => p.id === pid)) return c.json(await refreshPanel(w.id, pid) ?? latest(w.id, pid) ?? {});
  const ev = await refreshEvidence(w.id, pid);
  if (!ev) throw new BadRequest('unknown panel');
  return c.json({ data: ev.data, at: new Date().toISOString(), error: ev.error });
});
app.post('/api/workspaces/:id/panels/:pid/actions', async c => {
  const w = wsOr404(c);
  const { actionId, record } = await c.req.json();
  return c.json(await decisionFromRecordAction(w, userOf(c), c.req.param('pid'), actionId, record));
});

// ---------------------------------------------------------------- incidents, decisions, playbooks
app.post('/api/incidents/:id/investigate', async c => {
  const i = store.get<Incident>('incident', c.req.param('id'));
  if (!i) throw new BadRequest('unknown incident');
  const d = await investigate(i.id);
  return c.json(d ?? { error: 'No decision was produced; see the Inspector.' });
});
app.get('/api/decisions/:id', c => {
  const d = getDecision(c.req.param('id'));
  if (!d) throw new BadRequest('unknown decision');
  const w = getWorkspace(d.workspaceId)!;
  if (!canView(w, userOf(c))) throw new Forbidden('not an approver');
  const incident = d.incidentId ? store.get<Incident>('incident', d.incidentId) : undefined;
  const playbooks = store.list<Playbook>('playbook', w.id);
  const playbook = d.playbookId ? playbooks.find(p => p.id === d.playbookId)
    : incident ? playbooks.find(p => p.match.watcherId === incident.watcherId && p.match.resource === incident.resource) : undefined;
  return c.json({ decision: d, incident, playbook, workspace: { id: w.id, title: w.title, owner: w.owner } });
});
app.post('/api/decisions/:id/approve', async c => c.json(await approve(c.req.param('id'), userOf(c))));
app.post('/api/decisions/:id/reject', async c => {
  const body = await c.req.json().catch(() => ({}));
  const user = userOf(c);
  const d = reject(c.req.param('id'), user, body.note);
  // Sent back with a note on an incident: wake the agent (resuming its saved conversation) to revise the fix.
  if (d.status === 'rejected' && d.decidedBy === user && body.note?.trim() && d.incidentId)
    void investigate(d.incidentId, { by: user, note: String(body.note).trim().slice(0, 500), rejectedId: d.id });
  return c.json(d);
});
app.post('/api/decisions/:id/playbook', c => c.json(savePlaybook(c.req.param('id'), userOf(c))));

// ---------------------------------------------------------------- demo controls
app.post('/api/admin/reset', async c => {
  const body = await c.req.json().catch(() => ({}));
  const ids = body.workspaceId ? [body.workspaceId] : store.list<{ id: string }>('workspace').map(w => w.id);
  for (const id of ids) resetWorkspace(id, body.keepPlaybooks !== false);
  return c.json({ ok: true, workspaces: ids.length });
});
app.post('/api/admin/auto-investigate', async c => {
  const { on } = await c.req.json();
  setAutoInvestigate(!!on);
  return c.json({ ok: true, on: !!on });
});

// agentregistry = discovery layer: the "Add MCP" dialog's registry tab searches it (display metadata only).
app.get('/api/registry', async c => {
  const found = await searchRegistry(c.req.query('q') ?? '');
  if (!found.length && !c.req.query('q')) return c.json({ error: 'registry unavailable' }, 404); // hides the tab
  return c.json(found.map(e => ({ ...e, tools: e.tools?.length, toolNames: e.tools })));
});

// ---------------------------------------------------------------- boot
process.on('unhandledRejection', e => { console.error('unhandled rejection (kept running):', e); capture(e); });
process.on('uncaughtException', e => { console.error('uncaught exception (kept running):', e); capture(e); });
await initApprovalKeys();
await loadValidator();
loadConnections();
setRawListener((w, p, raw) => { void onPanelRaw(w, p, raw); });
scheduleAll();

const server = serve({ fetch: app.fetch, port: config.port, hostname: '0.0.0.0' }, info =>
  console.log(`PRISM API on :${info.port} · model ${config.model} · ${config.gatewayUrl ? 'MCP via agentgateway' : 'MCP direct'}${config.llmGatewayUrl ? ' · Claude via agentgateway' : ''}`));

const wss = new WebSocketServer({ noServer: true });
(server as any).on('upgrade', (req: any, socket: any, head: any) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname !== '/ws') return socket.destroy();
  const wsId = url.searchParams.get('ws') ?? '';
  const user = (url.searchParams.get('as') || 'arnab').toLowerCase();
  const w = getWorkspace(wsId);
  if (!w || !canView(w, user)) return socket.destroy();
  wss.handleUpgrade(req, socket, head, sock => {
    subscribe(wsId, sock);
    const send = (m: unknown) => sock.send(JSON.stringify(m));
    send({ type: 'workspace', workspace: publicWorkspace(getWorkspace(wsId)!) });
    for (const p of w.panels) { const l = latest(wsId, p.id); if (l) send({ type: 'panel-data', panelId: p.id, ...l }); }
    for (const i of store.list<Incident>('incident', wsId)) send({ type: 'incident', incident: i });
    for (const d of store.list<Decision>('decision', wsId)) send({ type: 'decision', decision: d });
    for (const pb of store.list<Playbook>('playbook', wsId)) send({ type: 'playbook', playbook: pb });
    for (const a of recentActivity(wsId)) send({ type: 'activity', item: a });
    send({ type: 'stats', stats: getStats(wsId) });
  });
});
