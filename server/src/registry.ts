// agentregistry discovery: PRISM's catalog of MCP servers.
//
// Reads the registry's read-only MCP Registry v0.1 compatibility API
// (GET /v0.1/servers) and returns display metadata + the remote URL only.
// Headers, packages/env, namespaces, cursors and error details never leave
// this module. Key tool names are an optional enrichment read from the
// `prism.dev/tools` annotation (native API; the v0.1 shape has no field for
// it). Any failure -> [] so the web's registry tab simply hides itself.

export interface RegistryEntry {
  name: string;
  title?: string;
  description?: string;
  url: string;
  tools?: string[];
}

const TIMEOUT_MS = 3_000;
const MAX_PAGES = 5; // 100 per page; the catalog is small

function baseUrl() {
  return (process.env.AGENT_REGISTRY_URL || 'http://localhost:12121').replace(/\/+$/, '');
}

const str = (v: unknown, max = 500): string | undefined =>
  typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : undefined;

/** Pick the first http(s) remote, preferring streamable-http. Never returns headers. */
function remoteUrl(remotes: unknown): string | undefined {
  if (!Array.isArray(remotes)) return undefined;
  const sorted = [...remotes].sort((a, b) => Number(b?.type === 'streamable-http') - Number(a?.type === 'streamable-http'));
  for (const r of sorted) {
    const raw = str(r?.url, 2048);
    if (!raw) continue;
    try {
      const u = new URL(raw);
      if (u.protocol !== 'https:' && u.protocol !== 'http:') continue;
      if (u.username || u.password) continue; // never pass on credentials embedded in a URL
      return raw; // as registered (no normalisation, so it matches built-in URLs)
    } catch { /* skip malformed */ }
  }
  return undefined;
}

async function getJson(url: string, signal: AbortSignal): Promise<any> {
  const res = await fetch(url, { signal, headers: { accept: 'application/json' } });
  if (!res.ok) throw new Error(`registry ${res.status}`);
  return res.json();
}

async function listServers(signal: AbortSignal): Promise<Array<{ key: string } & RegistryEntry>> {
  const out: Array<{ key: string } & RegistryEntry> = [];
  const seen = new Set<string>();
  let cursor: string | undefined;
  for (let page = 0; page < MAX_PAGES; page++) {
    const qs = new URLSearchParams({ limit: '100' });
    if (cursor) qs.set('cursor', cursor);
    const body = await getJson(`${baseUrl()}/v0.1/servers?${qs}`, signal);
    for (const item of Array.isArray(body?.servers) ? body.servers : []) {
      const s = item?.server;
      const official = item?._meta?.['io.modelcontextprotocol.registry/official'];
      if (official?.status && official.status !== 'active') continue;
      if (official && official.isLatest === false) continue;
      const key = str(s?.name, 300);
      const url = remoteUrl(s?.remotes);
      if (!key || !url || seen.has(key)) continue;
      seen.add(key);
      out.push({
        key,
        name: key.split('/').pop()!, // drop the registry namespace
        title: str(s?.title, 120),
        description: str(s?.description),
        url,
      });
    }
    cursor = str(body?.metadata?.nextCursor, 4096);
    if (!cursor) break;
  }
  return out;
}

/** Best-effort: `namespace/name` -> tool names from the `prism.dev/tools` annotation. */
async function toolHints(signal: AbortSignal): Promise<Map<string, string[]>> {
  const hints = new Map<string, string[]>();
  try {
    const body = await getJson(`${baseUrl()}/v0/mcpservers?limit=100`, signal);
    for (const item of Array.isArray(body?.items) ? body.items : []) {
      const md = item?.metadata;
      const raw = str(md?.annotations?.['prism.dev/tools'], 2000);
      const name = str(md?.name, 300);
      if (!raw || !name) continue;
      const tools = raw.split(',').map(t => t.trim()).filter(t => /^[A-Za-z0-9_.-]{1,64}$/.test(t)).slice(0, 20);
      if (tools.length) hints.set(`${str(md?.namespace, 100) ?? 'default'}/${name}`, tools);
    }
  } catch { /* hints are optional */ }
  return hints;
}

export async function searchRegistry(q: string): Promise<RegistryEntry[]> {
  const signal = AbortSignal.timeout(TIMEOUT_MS);
  try {
    const [servers, hints] = await Promise.all([listServers(signal), toolHints(signal)]);
    const needle = (q ?? '').trim().toLowerCase();
    return servers
      .filter(s => !needle || [s.name, s.title, s.description].some(f => f?.toLowerCase().includes(needle)))
      .map(({ key, ...entry }) => {
        const tools = hints.get(key);
        return tools ? { ...entry, tools } : entry;
      });
  } catch {
    return [];
  }
}
