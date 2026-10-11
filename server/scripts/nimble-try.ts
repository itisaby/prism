// Try a Nimble tool directly: npx tsx scripts/nimble-try.ts <tool> '<json>'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
process.loadEnvFile('../.env');
const [tool, json = '{}'] = process.argv.slice(2);
const c = new Client({ name: 'nimble-try', version: '0' }, { versionNegotiation: { mode: 'auto' } } as any);
await c.connect(new StreamableHTTPClientTransport(new URL('https://mcp.nimbleway.com/mcp'), { requestInit: { headers: { Authorization: `Bearer ${process.env.NIMBLE_API_KEY}` } } }));
const t0 = Date.now();
const r: any = await c.callTool({ name: tool, arguments: JSON.parse(json) }, { timeout: 60000 } as any);
console.log(r.isError ? 'ERROR' : 'OK', `${Date.now() - t0}ms`, 'structured:', !!r.structuredContent);
const out = JSON.stringify(r.structuredContent ?? r.content?.[0]?.text);
if (process.env.FULL) (await import('node:fs')).writeFileSync(process.env.FULL, out);
console.log(out.slice(0, 1800));
await c.close();
