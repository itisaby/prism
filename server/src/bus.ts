// Live fan-out to browsers (WebSocket) plus the activity feed the Inspector shows.
import { randomUUID } from 'node:crypto';
import type { WebSocket } from 'ws';
import type { Activity, ActivityKind, ServerMessage } from '../../shared/types.ts';
import { log } from './telemetry.ts';

const subscribers = new Map<string, Set<WebSocket>>();
const socketUser = new WeakMap<WebSocket, string>(); // who is on each socket (personal views differ per person)
const recent = new Map<string, Activity[]>(); // last activity per workspace, replayed to new subscribers

export function subscribe(workspaceId: string, socket: WebSocket, user = 'arnab') {
  socketUser.set(socket, user);
  let set = subscribers.get(workspaceId);
  if (!set) subscribers.set(workspaceId, (set = new Set()));
  set.add(socket);
  socket.on('close', () => set!.delete(socket));
}

export function broadcast(workspaceId: string, msg: ServerMessage) {
  const set = subscribers.get(workspaceId);
  if (!set?.size) return;
  const data = JSON.stringify(msg);
  for (const s of set) if (s.readyState === 1) s.send(data);
}

/** Send each subscriber its own message (e.g. their personal view of the workspace). `make` may skip a user by returning undefined. */
export async function broadcastEach(workspaceId: string, make: (user: string) => ServerMessage | undefined | Promise<ServerMessage | undefined>) {
  const set = subscribers.get(workspaceId);
  if (!set?.size) return;
  const cache = new Map<string, string | undefined>();
  for (const s of set) {
    if (s.readyState !== 1) continue;
    const user = socketUser.get(s) ?? 'arnab';
    if (!cache.has(user)) { const m = await make(user); cache.set(user, m ? JSON.stringify(m) : undefined); }
    const data = cache.get(user);
    if (data) s.send(data);
  }
}

export function activity(workspaceId: string, kind: ActivityKind, text: string, detail?: unknown): Activity {
  const item: Activity = { id: randomUUID(), workspaceId, at: new Date().toISOString(), kind, text, detail };
  const list = recent.get(workspaceId) ?? [];
  list.push(item);
  if (list.length > 200) list.splice(0, list.length - 200);
  recent.set(workspaceId, list);
  broadcast(workspaceId, { type: 'activity', item });
  if (kind !== 'refresh') {
    console.log(`[${workspaceId.slice(0, 8)}] ${kind}: ${text}`);
    log(kind === 'error' ? 'error' : 'info', text, { 'prism.workspace': workspaceId, 'prism.kind': kind });
  }
  return item;
}

export const recentActivity = (workspaceId: string) => recent.get(workspaceId) ?? [];
export const clearActivity = (workspaceId: string) => recent.delete(workspaceId);
