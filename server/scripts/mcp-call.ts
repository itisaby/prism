// Call PRISM's own MCP server like an external agent would: npx tsx scripts/mcp-call.ts <tool> '<json args>'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
const [tool, json = '{}'] = process.argv.slice(2);
const client = new Client({ name: 'probe', version: '0' }, { versionNegotiation: { mode: 'auto' } } as any);
await client.connect(new StreamableHTTPClientTransport(new URL(process.env.PRISM_MCP ?? 'http://localhost:7100/mcp'),
  { requestInit: { headers: { 'x-prism-user': 'arnab', 'x-prism-agent': 'Claude Code' } } }));
if (!tool) console.log((await client.listTools()).tools.map(t => t.name));
else { const r: any = await client.callTool({ name: tool, arguments: JSON.parse(json) }); console.log(r.isError ? 'ERROR' : 'OK', r.content?.[0]?.text?.slice(0, 1500)); }
await client.close();
