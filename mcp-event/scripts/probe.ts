// Probe the event MCP server like PRISM does: negotiate the protocol, list tools, optionally call one.
//   npx tsx scripts/probe.ts                                   -> list tools
//   npx tsx scripts/probe.ts list_help_requests '{"status":"open"}'
// Env: EVENT_MCP_URL (default http://127.0.0.1:7101/mcp); EVENT_MCP_TOKEN (optional bearer; never printed).
// Env: PROBE_LEGACY=1 skips version negotiation (2025-era initialize handshake). COMPACT=1 prints one-line JSON.
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';

const url = new URL(process.env.EVENT_MCP_URL ?? 'http://127.0.0.1:7101/mcp');
const token = process.env.EVENT_MCP_TOKEN;

const [tool, rawArgs] = process.argv.slice(2);
const client = new Client({ name: 'prism-probe', version: '0.1.0' }, process.env.PROBE_LEGACY ? {} : { versionNegotiation: { mode: 'auto' } });
const transport = new StreamableHTTPClientTransport(url, token ? { requestInit: { headers: { Authorization: `Bearer ${token}` } } } : {});

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
