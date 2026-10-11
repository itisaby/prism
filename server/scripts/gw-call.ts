// Call a tool through agentgateway directly (no PRISM): npx tsx scripts/gw-call.ts <route> <tool> '<json>'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
process.loadEnvFile('../.env');
const [route, tool, json = '{}'] = process.argv.slice(2);
const token = route.startsWith('/github') ? process.env.GITHUB_TOKEN : route.startsWith('/k8s') ? process.env.K8S_MCP_TOKEN : undefined;
const c = new Client({ name: 'gw-call', version: '0' }, { versionNegotiation: { mode: 'auto' } } as any);
await c.connect(new StreamableHTTPClientTransport(new URL('http://localhost:7200' + route), { requestInit: { headers: token ? { Authorization: `Bearer ${token}` } : {} } }));
try {
  const r: any = await c.callTool({ name: tool, arguments: JSON.parse(json) });
  console.log(r.isError ? 'TOOL ERROR' : 'OK', JSON.stringify(r.structuredContent ?? r.content?.[0]?.text).slice(0, 300));
} catch (e) { console.log('BLOCKED/FAILED:', (e as Error).message); }
await c.close();
