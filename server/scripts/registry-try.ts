// Usage: npx tsx scripts/registry-try.ts [query]   (AGENT_REGISTRY_URL defaults to http://localhost:12121)
import { searchRegistry } from '../src/registry.ts';

const q = process.argv.slice(2).join(' ');
const t0 = Date.now();
const results = await searchRegistry(q);
console.log(`q=${JSON.stringify(q)} -> ${results.length} result(s) in ${Date.now() - t0} ms`);
for (const r of results) {
  console.log(`- ${r.title ?? r.name} [${r.name}] ${r.url}${r.tools ? `\n    tools: ${r.tools.join(', ')}` : ''}`);
}
