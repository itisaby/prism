// Workspaces: atomic, versioned ops. Every structural change is validated by executing it before it's saved.
import { randomUUID } from 'node:crypto';
import type { Op, Panel, Workspace } from '../../shared/types.ts';
import { activity, broadcast } from './bus.ts';
import { store } from './db.ts';
import { evaluate, publicWorkspace, schedule, unschedule, validatePanel } from './runtime.ts';
import { clearActivity } from './bus.ts';

export class Conflict extends Error {}
export class Invalid extends Error { constructor(public problems: string[]) { super(problems.join('\n')); } }

export function createWorkspace(owner: string, title = 'Untitled workspace'): Workspace {
  const w: Workspace = { id: `ws-${randomUUID().slice(0, 8)}`, owner, title, version: 0, panels: [], watchers: [], members: [] };
  return store.put('workspace', w, w.id);
}

export const getWorkspace = (id: string) => store.get<Workspace>('workspace', id);
export const canView = (w: Workspace, user: string) => w.owner === user || w.members.includes(user) || user === 'judge';
export const canEdit = (w: Workspace, user: string) => w.owner === user;
export const listWorkspaces = (user: string) =>
  store.list<Workspace>('workspace').filter(w => canView(w, user)).map(w => ({ id: w.id, title: w.title, owner: w.owner }));

/** Delete a workspace and everything it owns. Connections are per user, not per workspace, so they stay. */
export function deleteWorkspace(id: string, user: string) {
  const w = getWorkspace(id);
  if (!w) return false;
  if (!canEdit(w, user)) throw new Invalid(['only the owner can delete this workspace']);
  unschedule(id);
  for (const kind of ['incident', 'decision', 'playbook', 'agent-transcript', 'research'] as const) store.deleteForWorkspace(kind, id);
  store.delete('stats', id);
  store.delete('stats', `${id}:incidents`);
  store.delete('workspace', id);
  broadcast(id, { type: 'workspace-deleted', workspaceId: id });
  clearActivity(id);
  return true;
}

export function saveWorkspace(w: Workspace) {
  store.put('workspace', w, w.id);
  broadcast(w.id, { type: 'workspace', workspace: publicWorkspace(w) });
  return w;
}

/** Validate + apply ops atomically. Throws Conflict (stale version) or Invalid (problems to show the model/user). */
export async function applyOps(id: string, user: string, baseVersion: number | undefined, ops: Op[], actor = user) {
  const current = getWorkspace(id);
  if (!current) throw new Invalid([`workspace ${id} not found`]);
  if (baseVersion !== undefined && baseVersion !== current.version) throw new Conflict(`workspace is at version ${current.version}, not ${baseVersion}`);
  const next: Workspace = structuredClone(current);
  const problems: string[] = [];
  const touched = new Set<string>();
  const find = (pid: string) => next.panels.find(p => p.id === pid);

  for (const op of ops) {
    switch (op.op) {
      case 'add_panel': {
        const p = normalizePanel(op.panel, next);
        if (actor !== user) p.addedBy = actor;
        if (find(p.id)) { problems.push(`panel id "${p.id}" already exists`); break; }
        next.panels.push(p); touched.add(p.id); break;
      }
      case 'remove_panel':
        if (!find(op.panelId)) problems.push(`no panel "${op.panelId}"`);
        next.panels = next.panels.filter(p => p.id !== op.panelId);
        next.watchers = next.watchers.filter(w => w.panelId !== op.panelId);
        break;
      case 'move_resize': { const p = find(op.panelId); if (!p) problems.push(`no panel "${op.panelId}"`); else p.layout = clampLayout(op.layout); break; }
      case 'replace_view': {
        const p = find(op.panelId);
        if (!p) { problems.push(`no panel "${op.panelId}"`); break; }
        p.components = op.components ?? (op as any).view; if (op.title) p.title = op.title; touched.add(p.id); break;
      }
      case 'update_binding': {
        const p = find(op.panelId);
        if (!p) { problems.push(`no panel "${op.panelId}"`); break; }
        p.binding = op.binding; touched.add(p.id); break;
      }
      case 'set_actions': { const p = find(op.panelId); if (!p) problems.push(`no panel "${op.panelId}"`); else { p.actions = op.actions; touched.add(p.id); } break; }
      case 'watch': {
        const wt = { ...op.watcher, id: op.watcher.id || `wt-${randomUUID().slice(0, 6)}` };
        if (!find(wt.panelId)) { problems.push(`watcher ${wt.id}: no panel "${wt.panelId}"`); break; }
        next.watchers = next.watchers.filter(x => x.id !== wt.id).concat(wt);
        break;
      }
      case 'unwatch': next.watchers = next.watchers.filter(w => w.id !== op.watcherId); break;
      case 'rename_workspace': next.title = op.title; break;
      default: problems.push(`unknown op ${(op as any).op}`);
    }
  }

  // Execute-to-validate every panel whose binding or view changed.
  const raws = new Map<string, unknown>();
  for (const pid of touched) {
    const p = find(pid);
    if (!p) continue;
    const r = await validatePanel(p, next.owner);
    problems.push(...r.problems);
    raws.set(pid, r.raw);
  }
  // Watcher conditions must compile and return an array (or nothing) on the panel's current raw data.
  for (const wt of next.watchers) {
    const p = find(wt.panelId);
    if (!p) continue;
    try {
      const raw = raws.get(p.id) ?? (await import('./runtime.ts')).runBinding(p.binding, next.owner).then(r => r.raw);
      const out = await evaluate(wt.condition, await raw);
      if (out !== undefined && !Array.isArray(out) && typeof out !== 'object') problems.push(`watcher ${wt.id}: condition must return an array of {resource, reason}`);
    } catch (e) { problems.push(`watcher ${wt.id}: ${(e as Error).message}`); }
  }
  if (problems.length) throw new Invalid(problems);

  next.version = current.version + 1;
  saveWorkspace(next);
  if (touched.size || ops.some(o => o.op === 'remove_panel')) schedule(next);
  activity(id, 'info', `Workspace v${next.version}: ${describeOps(ops)}`);
  return next;
}

function normalizePanel(p: Panel, w: Workspace): Panel {
  // Models sometimes name the component list "view" (after the replace_view op); accept it.
  const anyP = p as Panel & { view?: unknown };
  if (!Array.isArray(p.components) && Array.isArray(anyP.view)) { p = { ...p, components: anyP.view as Panel['components'] }; delete (p as any).view; }
  const layout = clampLayout(p.layout ?? { x: 0, y: Infinity, w: 6, h: 4 });
  return { ...p, id: p.id || `p-${randomUUID().slice(0, 6)}`, refreshSec: Math.max(3, Math.min(300, p.refreshSec || 10)), layout,
    binding: { ...p.binding, args: p.binding?.args ?? {}, transform: p.binding?.transform || '$' } };
}

function clampLayout(l: Panel['layout']) {
  const w = Math.max(2, Math.min(12, Math.round(l.w || 6)));
  return { x: Math.max(0, Math.min(12 - w, Math.round(l.x || 0))), y: Number.isFinite(l.y) ? Math.max(0, Math.round(l.y)) : 99, w, h: Math.max(2, Math.min(12, Math.round(l.h || 4))) };
}

export function describeOps(ops: Op[]) {
  return ops.map(o => {
    switch (o.op) {
      case 'add_panel': return `added “${o.panel.title}”`;
      case 'remove_panel': return `removed ${o.panelId}`;
      case 'move_resize': return `moved ${o.panelId}`;
      case 'replace_view': return `changed the view of ${o.panelId}`;
      case 'update_binding': return `changed the data for ${o.panelId}`;
      case 'set_actions': return `set actions on ${o.panelId}`;
      case 'watch': return `watching “${o.watcher.title}”`;
      case 'unwatch': return `stopped watching ${o.watcherId}`;
      case 'rename_workspace': return `renamed to “${o.title}”`;
    }
  }).join(' · ');
}
