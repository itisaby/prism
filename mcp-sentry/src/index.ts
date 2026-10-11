// Sentry MCP bridge: Sentry's official MCP server (@sentry/mcp-server, stdio, access-token auth) exposed as a
// stateless Streamable HTTP MCP endpoint, so PRISM can reach it through agentgateway like any other source.
// The hosted server (mcp.sentry.dev) only accepts OAuth; this keeps PRISM on bearer tokens for the hackathon.
//   SENTRY_ACCESS_TOKEN  Sentry user auth token (org:read, project:read, event:read[, event:write for update_issue])
//   SENTRY_ORG_SLUG      optional, scopes the server to one org
//   MCP_TOKEN            optional bearer required on /mcp
import { timingSafeEqual } from 'node:crypto';
import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { createMcpHandler, Server } from '@modelcontextprotocol/server';

const envFile = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../.env');
if (existsSync(envFile)) process.loadEnvFile(envFile);
const PORT = Number(process.env.PORT ?? 7102);
if (!process.env.SENTRY_ACCESS_TOKEN) { console.error('SENTRY_ACCESS_TOKEN is not set'); process.exit(1); }

// ---------------------------------------------------------------- upstream: Sentry's MCP server over stdio
const sentryBin = createRequire(import.meta.url).resolve('@sentry/mcp-server'); // exports '.' → dist/index.js (the sentry-mcp bin)
let upstream: Promise<Client> | undefined;

function connectUpstream() {
  upstream = (async () => {
    const args = [sentryBin];
    if (process.env.SENTRY_ORG_SLUG) args.push(`--organization-slug=${process.env.SENTRY_ORG_SLUG}`);
    const transport = new StdioClientTransport({
      command: process.execPath, args,
      env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', SENTRY_ACCESS_TOKEN: process.env.SENTRY_ACCESS_TOKEN! },
      stderr: 'pipe',
    });
    const client = new Client({ name: 'prism-sentry-bridge', version: '0.1.0' });
    transport.onclose = () => { console.warn('sentry-mcp exited; will reconnect on next request'); upstream = undefined; };
    await client.connect(transport);
    console.log('connected to @sentry/mcp-server (stdio)');
    return client;
  })();
  upstream.catch(e => { console.error('sentry-mcp failed to start:', e.message); upstream = undefined; });
  return upstream;
}
const sentry = () => upstream ?? connectUpstream();

// ---------------------------------------------------------------- downstream: one Server per request, passthrough handlers
function buildServer() {
  const server = new Server({ name: 'prism-sentry', version: '0.1.0' }, { capabilities: { tools: {} } });
  server.setRequestHandler('tools/list', async (req: any) => (await sentry()).listTools(req.params ?? {}) as any);
  server.setRequestHandler('tools/call', async (req: any) => (await sentry()).callTool(req.params, { timeout: 60_000 } as any) as any);
  return server;
}
const mcp = createMcpHandler(() => buildServer());

const app = new Hono();
app.get('/healthz', async c => {
  try { await sentry(); return c.json({ ok: true }); } catch (e) { return c.json({ ok: false, error: (e as Error).message }, 503); }
});
app.all('/mcp', async c => {
  const want = process.env.MCP_TOKEN;
  if (want) {
    const got = (c.req.header('authorization') ?? '').replace(/^Bearer /, '');
    const a = Buffer.from(got), b = Buffer.from(want);
    if (a.length !== b.length || !timingSafeEqual(a, b)) return c.json({ error: 'unauthorized' }, 401);
  }
  return mcp.fetch(c.req.raw);
});

serve({ fetch: app.fetch, port: PORT, hostname: '0.0.0.0' }, () => console.log(`Sentry MCP bridge on :${PORT}/mcp`));
void connectUpstream();
