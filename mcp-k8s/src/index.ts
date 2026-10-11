// PRISM Kubernetes MCP server: stateless MCP (2026-07-28, with 2025 stateless fallback) over HTTP at /mcp.
// A fresh McpServer is built for every request; the only long-lived state is the usage sampler.
import { timingSafeEqual } from 'node:crypto';
import { serve } from '@hono/node-server';
import { createMcpHandler, McpServer } from '@modelcontextprotocol/server';
import { Hono } from 'hono';
import { registerTools } from './tools.js';
import { sampleCount, startSampler } from './usage.js';

const PORT = Number(process.env.PORT ?? 8080);
const TOKEN = process.env.MCP_TOKEN ?? '';

function buildServer(): McpServer {
  const server = new McpServer(
    { name: 'prism-k8s', title: 'Kubernetes (minikube prism)', version: '0.1.0' },
    { instructions: 'Read tools describe the cluster. Write tools (set_image, rollback_deployment, restart_deployment, scale_deployment) change deployments, support dryRun, and are limited by Kubernetes RBAC to namespace "shop".' },
  );
  registerTools(server);
  return server;
}

const mcp = createMcpHandler(buildServer, { onerror: e => console.error('[mcp]', e.message) });

const tokenBytes = Buffer.from(TOKEN);
function authorized(header: string | undefined): boolean {
  const m = /^Bearer\s+(.+)$/i.exec(header ?? '');
  if (!m || !TOKEN) return false;
  const got = Buffer.from(m[1].trim());
  return got.length === tokenBytes.length && timingSafeEqual(got, tokenBytes);
}

const app = new Hono();
app.get('/healthz', c => c.json({ ok: true, samples: sampleCount() }));
app.all('/mcp', async c => {
  if (!TOKEN) return c.json({ error: 'server misconfigured: MCP_TOKEN is not set' }, 503);
  if (!authorized(c.req.header('authorization'))) {
    return c.json({ error: 'unauthorized' }, 401, { 'WWW-Authenticate': 'Bearer realm="prism-k8s"' });
  }
  return mcp.fetch(c.req.raw);
});
app.notFound(c => c.json({ error: 'not found' }, 404));

startSampler();
serve({ fetch: app.fetch, port: PORT, hostname: '0.0.0.0' }, info => {
  console.log(`prism-k8s MCP listening on :${info.port}/mcp (bearer auth ${TOKEN ? 'on' : 'MISSING: all MCP calls refused'})`);
});

for (const sig of ['SIGTERM', 'SIGINT'] as const) process.on(sig, () => process.exit(0));
