// PRISM event-ops MCP server: stateless MCP (2026-07-28, with 2025 stateless fallback) over HTTP at /mcp.
// A fresh McpServer per request over shared in-memory state; a ticker keeps the data live.
import { timingSafeEqual } from 'node:crypto';
import { serve } from '@hono/node-server';
import { createMcpHandler, McpServer } from '@modelcontextprotocol/server';
import { Hono } from 'hono';
import { reset, spike, startSimulation, state, totalCheckedIn } from './data.js';
import { registerTools } from './tools.js';

const PORT = Number(process.env.PORT ?? 7101);
const TOKEN = process.env.MCP_TOKEN ?? '';

function buildServer(): McpServer {
  const server = new McpServer(
    { name: 'prism-event', title: 'Hackathon ops (AI Engineer NYC)', version: '0.1.0' },
    { instructions: 'Live ops data for today\'s hackathon: teams, mentors, help requests, check-ins, volunteer tasks, judging and schedule. Write tools (assign_mentor, resolve_help_request, claim_task, update_task_status, create_task) support dryRun and fail with a clear conflict message instead of overwriting.' },
  );
  registerTools(server);
  return server;
}

const mcp = createMcpHandler(buildServer, { onerror: e => console.error('[mcp]', e.message) });

const tokenBytes = Buffer.from(TOKEN);
function authorized(header: string | undefined): boolean {
  if (!TOKEN) return true; // auth is optional: no MCP_TOKEN means open
  const m = /^Bearer\s+(.+)$/i.exec(header ?? '');
  if (!m) return false;
  const got = Buffer.from(m[1].trim());
  return got.length === tokenBytes.length && timingSafeEqual(got, tokenBytes);
}
const deny = { error: 'unauthorized' };
const challenge = { 'WWW-Authenticate': 'Bearer realm="prism-event"' };

const app = new Hono();
app.get('/healthz', c => c.json({
  ok: true,
  checkedIn: totalCheckedIn(),
  openHelpRequests: state.help.filter(r => r.status === 'open').length,
  seededAt: new Date(state.seededAt).toISOString(),
}));
app.all('/mcp', async c => {
  if (!authorized(c.req.header('authorization'))) return c.json(deny, 401, challenge);
  return mcp.fetch(c.req.raw);
});
// Admin (not MCP; demo operator). Same bearer as /mcp when MCP_TOKEN is set.
app.post('/admin/reset', c => {
  if (!authorized(c.req.header('authorization'))) return c.json(deny, 401, challenge);
  reset();
  console.log('[admin] reset: reseeded');
  return c.json({ ok: true, seededAt: new Date(state.seededAt).toISOString() });
});
app.post('/admin/spike', c => {
  if (!authorized(c.req.header('authorization'))) return c.json(deny, 401, challenge);
  const created = spike();
  console.log(`[admin] spike: ${created.map(r => `#${r.id}`).join(', ')}`);
  return c.json({ ok: true, created: created.map(r => ({ id: r.id, teamId: r.teamId, topic: r.topic, skill: r.skill })) });
});
app.notFound(c => c.json({ error: 'not found' }, 404));

startSimulation();
serve({ fetch: app.fetch, port: PORT, hostname: '0.0.0.0' }, info => {
  console.log(`prism-event MCP listening on :${info.port}/mcp (bearer auth ${TOKEN ? 'on' : 'off: MCP_TOKEN unset'})`);
});

for (const sig of ['SIGTERM', 'SIGINT'] as const) process.on(sig, () => process.exit(0));
