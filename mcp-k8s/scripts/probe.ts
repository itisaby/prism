// Probe the k8s MCP server like PRISM does: negotiate the protocol, list tools, optionally call one.
//   npx tsx scripts/probe.ts                         -> list tools
//   npx tsx scripts/probe.ts list_pods '{"problemsOnly":true}'
// Env: K8S_MCP_URL (default http://127.0.0.1:7300/mcp); K8S_MCP_TOKEN (read from ../.env if unset; never printed).
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';

function tokenFromEnvFile(): string | undefined {
  try {
    const envPath = fileURLToPath(new URL('../../.env', import.meta.url));
    const line = readFileSync(envPath, 'utf8').split('\n').find(l => l.startsWith('K8S_MCP_TOKEN='));
    return line?.slice('K8S_MCP_TOKEN='.length).trim().replace(/^["']|["']$/g, '') || undefined;
  } catch { return undefined; }
}

const url = new URL(process.env.K8S_MCP_URL ?? 'http://127.0.0.1:7300/mcp');
const token = process.env.K8S_MCP_TOKEN || tokenFromEnvFile();
if (!token) { console.error('K8S_MCP_TOKEN not set (env or .env)'); process.exit(1); }

const [tool, rawArgs] = process.argv.slice(2);
const client = new Client({ name: 'prism-probe', version: '0.1.0' }, { versionNegotiation: { mode: 'auto' } });
const transport = new StreamableHTTPClientTransport(url, { requestInit: { headers: { Authorization: `Bearer ${token}` } } });

const t0 = Date.now();
await client.connect(transport);
console.log(`connected to ${url} protocol=${client.getNegotiatedProtocolVersion()} server=${client.getServerVersion()?.name} (${Date.now() - t0}ms)`);

if (!tool) {
  const { tools } = await client.listTools();
  for (const t of tools) {
    const hint = t.annotations?.readOnlyHint ? 'read' : t.annotations?.destructiveHint ? 'WRITE' : '?';
    const args = Object.keys((t.inputSchema as any)?.properties ?? {}).join(', ');
    console.log(`  ${hint.padEnd(5)} ${t.name}(${args})${t.outputSchema ? ' -> outputSchema' : ''}`);
  }
  console.log(`${tools.length} tools`);
} else {
  const args = rawArgs ? JSON.parse(rawArgs) : {};
  const t1 = Date.now();
  const res = await client.callTool({ name: tool, arguments: args });
  console.log(`${tool} ${JSON.stringify(args)} -> ${res.isError ? 'ERROR' : 'ok'} (${Date.now() - t1}ms)`);
  if (res.structuredContent) console.log(JSON.stringify(res.structuredContent, null, process.env.COMPACT ? 0 : 2));
  else for (const c of res.content as any[]) if (c.type === 'text') console.log(c.text);
}
await client.close();
