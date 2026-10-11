// MCP connections: discovery and tool calls through the v2 client (stateless 2026-07-28, legacy fallback).
// Credentials stay on the server; the browser only ever sees ConnectionView.
import { lookup } from 'node:dns/promises';
import { BlockList, isIP } from 'node:net';
import { randomUUID } from 'node:crypto';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import type { ConnectionView, DiscoveredTool } from '../../shared/types.ts';
import { config } from './config.ts';
import { open, seal } from './crypto.ts';
import { store } from './db.ts';

interface Connection {
  id: string;
  name: string;
  url: string;            // where PRISM connects (a gateway route when governed)
  owner?: string;         // undefined = shared demo connection
  sealedAuth?: string;    // "Bearer …", sealed
  viaGateway: boolean;
  builtin?: boolean;
}

interface Discovery { tools: DiscoveredTool[]; protocolVersion?: string; error?: string; at: number }

const connections = new Map<string, Connection>();
const discovery = new Map<string, Discovery>();
const clients = new Map<string, Promise<Client>>();

export function loadConnections() {
  if (config.k8sToken) {
    const gw = config.gatewayUrl;
    connections.set('k8s', {
      id: 'k8s', name: 'Kubernetes', builtin: true, viaGateway: !!gw,
      url: gw ? `${gw}/k8s/mcp` : config.k8sMcpUrl, sealedAuth: seal(`Bearer ${config.k8sToken}`),
    });
  }
  for (const c of store.list<Connection>('connection')) connections.set(c.id, c);
}

const visible = (c: Connection, user: string) => !c.owner || c.owner === user;
export const getConnection = (id: string, user: string) => {
  const c = connections.get(id);
  return c && visible(c, user) ? c : undefined;
};
export const listConnections = (user: string) => [...connections.values()].filter(c => visible(c, user));

export function view(c: Connection): ConnectionView {
  const d = discovery.get(c.id);
  return {
    id: c.id, name: c.name, url: c.viaGateway ? 'via agentgateway' : c.url, viaGateway: c.viaGateway,
    status: d?.error ? 'error' : 'ok', error: d?.error, protocolVersion: d?.protocolVersion, tools: d?.tools ?? [],
  };
}

// ---------------------------------------------------------------- SSRF guard for user-added URLs
const privateRanges = new BlockList();
for (const [net, bits] of [['10.0.0.0', 8], ['172.16.0.0', 12], ['192.168.0.0', 16], ['127.0.0.0', 8], ['169.254.0.0', 16], ['0.0.0.0', 8], ['100.64.0.0', 10]] as const)
  privateRanges.addSubnet(net, bits, 'ipv4');
privateRanges.addSubnet('::1', 128, 'ipv6');
privateRanges.addSubnet('fc00::', 7, 'ipv6');
privateRanges.addSubnet('fe80::', 10, 'ipv6');

async function checkUrl(raw: string) {
  let u: URL;
  try { u = new URL(raw); } catch { throw new Error('That is not a valid URL.'); }
  if (config.allowLocalMcp) return u;
  if (u.protocol !== 'https:') throw new Error('MCP servers must use https.');
  const addrs = isIP(u.hostname) ? [{ address: u.hostname, family: isIP(u.hostname) }] : await lookup(u.hostname, { all: true });
  for (const a of addrs)
    if (privateRanges.check(a.address, a.family === 6 ? 'ipv6' : 'ipv4')) throw new Error('Private and loopback addresses are not allowed.');
  return u;
}

// ---------------------------------------------------------------- client
async function makeClient(c: Connection, user: string, extraHeaders: Record<string, string> = {}) {
  const headers: Record<string, string> = { 'x-prism-user': user, ...extraHeaders };
  if (c.sealedAuth) headers.Authorization = open(c.sealedAuth);
  const client = new Client({ name: 'prism', version: '0.1.0' }, { versionNegotiation: { mode: 'auto' } } as any);
  await client.connect(new StreamableHTTPClientTransport(new URL(c.url), { requestInit: { headers } }));
  return client;
}

function clientFor(c: Connection, user: string) {
  const key = `${c.id}|${user}`;
  let p = clients.get(key);
  if (!p) {
    p = makeClient(c, user);
    p.catch(() => clients.delete(key));
    clients.set(key, p);
  }
  return p;
}

const dropClients = (id: string) => { for (const k of clients.keys()) if (k.startsWith(id + '|')) clients.delete(k); };

export async function discover(c: Connection, user: string, force = false): Promise<Discovery> {
  const cached = discovery.get(c.id);
  if (cached && !cached.error && !force && Date.now() - cached.at < 5 * 60_000) return cached;
  try {
    const client = await clientFor(c, user);
    const res = await client.listTools();
    const tools: DiscoveredTool[] = res.tools.map((t: any) => ({
      name: t.name, title: t.title, description: t.description, inputSchema: t.inputSchema,
      outputSchema: t.outputSchema, annotations: t.annotations,
    }));
    const d = { tools, protocolVersion: (client as any).getNegotiatedProtocolVersion?.() ?? (client as any).protocolVersion, at: Date.now() };
    discovery.set(c.id, d);
    return d;
  } catch (e) {
    dropClients(c.id);
    const d = { tools: [], error: friendlyError(e), at: Date.now() };
    discovery.set(c.id, d);
    return d;
  }
}

export async function addConnection(user: string, input: { name: string; url: string; token?: string }) {
  await checkUrl(input.url);
  const c: Connection = {
    id: `c-${randomUUID().slice(0, 8)}`, name: input.name || new URL(input.url).host, url: input.url, owner: user, viaGateway: false,
    sealedAuth: input.token ? seal(input.token.startsWith('Bearer ') ? input.token : `Bearer ${input.token}`) : undefined,
  };
  connections.set(c.id, c);
  const d = await discover(c, user, true);
  if (d.error) { connections.delete(c.id); discovery.delete(c.id); throw new Error(d.error); }
  store.put('connection', c);
  return c;
}

export function removeConnection(user: string, id: string) {
  const c = connections.get(id);
  if (!c || c.owner !== user) return false;
  connections.delete(id); discovery.delete(id); dropClients(id); store.delete('connection', id);
  return true;
}

export function toolInfo(connectionId: string, tool: string) {
  return discovery.get(connectionId)?.tools.find(t => t.name === tool);
}

export const isWriteTool = (t?: DiscoveredTool) => !t || t.annotations?.readOnlyHint !== true;

export class ToolError extends Error {}

/** Calls a tool as `user` and returns its JSON payload (structuredContent, else JSON parsed from text). */
export async function callTool(connectionId: string, tool: string, args: Record<string, unknown>,
  opts: { user: string; approvalToken?: string; allowWrite?: boolean }) {
  const c = connections.get(connectionId);
  if (!c || !visible(c, opts.user)) throw new ToolError(`Unknown connection ${connectionId}`);
  if (!toolInfo(connectionId, tool)) await discover(c, opts.user);
  const info = toolInfo(connectionId, tool);
  if (!info) throw new ToolError(`Tool "${tool}" does not exist on ${c.name}.`);
  if (isWriteTool(info) && !opts.allowWrite) throw new ToolError(`"${tool}" changes data; it can only run after a person approves it.`);
  let client: Client | undefined;
  let oneOff = false;
  try {
    if (opts.approvalToken) { client = await makeClient(c, opts.user, { 'x-prism-approval': opts.approvalToken }); oneOff = true; }
    else client = await clientFor(c, opts.user);
    const res: any = await client.callTool({ name: tool, arguments: args }, { timeout: 20_000 } as any);
    const payload = res.structuredContent ?? parseText(res.content);
    if (res.isError) throw new ToolError(typeof payload?.text === 'string' ? payload.text : JSON.stringify(payload));
    return payload;
  } catch (e) {
    if (!(e instanceof ToolError)) { if (!oneOff) dropClients(c.id); throw new ToolError(friendlyError(e)); }
    throw e;
  } finally {
    if (oneOff) client?.close().catch(() => {});
  }
}

function parseText(content: any[] = []) {
  const text = content.filter(p => p?.type === 'text').map(p => p.text).join('\n');
  try { return JSON.parse(text); } catch { return { text }; }
}

export function friendlyError(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e);
  if (/401|unauthori[sz]ed/i.test(msg)) return 'The server rejected the credentials (401).';
  if (/403|forbidden/i.test(msg) && !/RBAC/.test(msg)) return `Access denied (403). ${msg.slice(0, 200)}`;
  if (/ECONNREFUSED|fetch failed|ECONNRESET|socket hang up|ENOTFOUND/i.test(msg)) return `Can't reach the server (${msg.slice(0, 120)}).`;
  return msg.slice(0, 400);
}
