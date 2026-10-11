// One public origin for the HTTPS tunnel: web (Next, prod) + API + live WebSocket on a single port.
//   /ws          → API :7100 (WebSocket upgrade, so the phone gets live pushes, not polling)
//   /api/*       → API :7100
//   everything   → web :3001 (next start)
// Routes that must never be reachable from the internet are refused here:
//   /mcp (PRISM's own MCP server), /api/admin/* (demo reset), adding/removing MCP connections
//   (with PRISM_ALLOW_LOCAL_MCP=1 a public "add connection" would be an SSRF into this laptop).
// No dependencies: node:http + node:net only.
import http from 'node:http';
import net from 'node:net';

const PORT = Number(process.env.PUBLIC_PORT ?? 8090);
const API = { host: '127.0.0.1', port: 7100 };
const WEB = { host: '127.0.0.1', port: Number(process.env.WEB_PORT ?? 3001) };

function blocked(method, path) {
  if (path === '/mcp' || path.startsWith('/mcp/') || path.startsWith('/mcp?')) return 'PRISM MCP is local-only';
  if (path.startsWith('/api/admin')) return 'admin is local-only';
  if (path.startsWith('/api/connections') && method !== 'GET') return 'adding MCP servers is disabled on the public demo';
  if (method === 'DELETE' && path.startsWith('/api/workspaces/')) return 'deleting workspaces is disabled on the public demo';
  return null;
}

const target = path => (path.startsWith('/api/') || path === '/healthz' ? API : WEB);

const server = http.createServer((req, res) => {
  const path = req.url ?? '/';
  const why = blocked(req.method ?? 'GET', path);
  if (why) {
    res.writeHead(403, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ error: why }));
  }
  const t = target(path);
  const upstream = http.request({ ...t, method: req.method, path, headers: { ...req.headers, host: `${t.host}:${t.port}` } }, up => {
    res.writeHead(up.statusCode ?? 502, up.headers);
    up.pipe(res);
  });
  upstream.on('error', e => { if (!res.headersSent) res.writeHead(502); res.end(`upstream error: ${e.message}`); });
  req.pipe(upstream);
});

// WebSocket: only /ws, piped as raw TCP to the API after replaying the upgrade request.
server.on('upgrade', (req, socket, head) => {
  if (!(req.url ?? '').startsWith('/ws')) return socket.destroy();
  const up = net.connect(API.port, API.host, () => {
    const lines = [`${req.method} ${req.url} HTTP/1.1`];
    for (let i = 0; i < req.rawHeaders.length; i += 2) {
      const [k, v] = [req.rawHeaders[i], req.rawHeaders[i + 1]];
      lines.push(`${k}: ${k.toLowerCase() === 'host' ? `${API.host}:${API.port}` : v}`);
    }
    up.write(lines.join('\r\n') + '\r\n\r\n');
    if (head?.length) up.write(head);
    up.pipe(socket);
    socket.pipe(up);
  });
  const close = () => { up.destroy(); socket.destroy(); };
  up.on('error', close);
  socket.on('error', close);
});

server.listen(PORT, '127.0.0.1', () => console.log(`public proxy on http://127.0.0.1:${PORT} → web :${WEB.port}, api/ws :${API.port}`));
