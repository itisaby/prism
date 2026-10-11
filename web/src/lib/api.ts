// Fetch wrapper for the PRISM API: adds the identity header, routes to fixtures in demo mode.
import { fixtureRequest } from './fixtures.ts';

export const USERS = ['arnab', 'lead'] as const;
const USER_KEY = 'prism.user';
const DEFAULT_USER = 'arnab';

function safeGet(key: string): string | null {
  try { return window.localStorage.getItem(key); } catch { return null; }
}
function safeSet(key: string, value: string) {
  try { window.localStorage.setItem(key, value); } catch { /* private mode */ }
}

/** Current identity. `?as=<user>` in the URL wins and is remembered. */
export function currentUser(): string {
  if (typeof window === 'undefined') return DEFAULT_USER;
  const fromUrl = new URLSearchParams(window.location.search).get('as');
  if (fromUrl && /^[a-z0-9_-]{1,32}$/i.test(fromUrl)) {
    const u = legacy(fromUrl);
    safeSet(USER_KEY, u);
    return u;
  }
  return legacy(safeGet(USER_KEY) || DEFAULT_USER);
}

// "judge" was the old name of the approver identity.
const legacy = (u: string) => (u.toLowerCase() === 'judge' ? 'lead' : u);

export function setUser(user: string) {
  user = legacy(user);
  safeSet(USER_KEY, user);
  window.dispatchEvent(new CustomEvent('prism:user', { detail: user }));
}

let forcedFixture = false;
/** Demo data mode: `?fixture=1`, or switched on after the API proved unreachable on first load. */
export function fixtureMode(): boolean {
  if (typeof window === 'undefined') return false;
  return forcedFixture || new URLSearchParams(window.location.search).get('fixture') === '1';
}
export function enableFixtureMode() {
  forcedFixture = true;
}

export class ApiError extends Error {
  constructor(message: string, readonly status: number, readonly unreachable = false) {
    super(message);
  }
}

export async function api<T = unknown>(path: string, opts: { method?: string; body?: unknown } = {}): Promise<T> {
  const method = opts.method ?? (opts.body !== undefined ? 'POST' : 'GET');
  if (fixtureMode()) return fixtureRequest(method, path, opts.body, currentUser()) as Promise<T>;
  let res: Response;
  try {
    res = await fetch(`/api${path}`, {
      method,
      headers: { 'content-type': 'application/json', 'x-prism-user': currentUser() },
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
      cache: 'no-store',
    });
  } catch (e) {
    throw new ApiError(`Can't reach PRISM (${(e as Error).message})`, 0, true);
  }
  const raw = await res.text();
  let json: unknown = undefined;
  try { json = raw ? JSON.parse(raw) : undefined; } catch { /* not JSON */ }
  if (!res.ok) {
    const msg = (json as { error?: string } | undefined)?.error;
    // The Next proxy answers 500 with an HTML/text body when the API server is down.
    const unreachable = !msg && res.status >= 500;
    throw new ApiError(msg ?? (unreachable ? "PRISM server isn't reachable" : `Request failed (${res.status})`), res.status, unreachable);
  }
  return json as T;
}

/** WebSocket base URL. The phone (HTTPS tunnel) may not reach it; callers fall back to polling. */
export function wsBase(): string {
  const env = process.env.NEXT_PUBLIC_PRISM_WS;
  if (env) return env.replace(/\/$/, '');
  const { protocol, hostname, host, port } = window.location;
  if (port === '3000') return `ws://${hostname}:7100`;
  return `${protocol === 'https:' ? 'wss://' : 'ws://'}${host}`;
}
