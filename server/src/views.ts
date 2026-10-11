// Personal views: everyone shares a workspace's data (one fetch per panel per refresh), but each person can change
// how it looks for them — swap a table for cards, filter to "my teams", hide or move panels — without touching
// anyone else's screen. The owner edits the shared workspace; everyone else edits their own copy-on-write view.
import type { Layout, Panel, PanelOverride, ServerMessage, ViewOp, Workspace } from '../../shared/types.ts';
import { activity, broadcastEach } from './bus.ts';
import { store } from './db.ts';
import { evaluate, latest, publicWorkspace, renderComponents, runBinding, validateView } from './runtime.ts';
import { canView, getWorkspace } from './workspaces.ts';

interface UserView { id: string; workspaceId: string; user: string; version: number; overrides: Record<string, PanelOverride>; updatedAt: string }

const viewId = (wsId: string, user: string) => `${wsId}|${user}`;
export const getView = (wsId: string, user: string) => store.get<UserView>('view', viewId(wsId, user));
const isOwner = (w: Workspace, user: string) => w.owner === user;

/** The workspace as `user` sees it: the shared workspace with their overrides applied. */
export function effectiveWorkspace(w: Workspace, user: string): Workspace {
  const base = publicWorkspace(w);
  if (isOwner(w, user)) return base;
  const v = getView(w.id, user);
  const o = v?.overrides ?? {};
  const panels: Panel[] = [];
  const hiddenPanels: { id: string; title: string }[] = [];
  for (const p of w.panels) {
    const ov = o[p.id];
    if (ov?.hidden) { hiddenPanels.push({ id: p.id, title: ov.title ?? p.title }); continue; }
    const merged: Panel = { ...p, title: ov?.title ?? p.title, layout: ov?.layout ?? p.layout, components: ov?.components ?? p.components };
    panels.push({ ...merged, components: renderComponents(merged) });
  }
  const customizedPanels = Object.entries(o).filter(([, ov]) => ov && Object.keys(ov).length).map(([id]) => id);
  return { ...base, panels, personal: { viewer: user, customizedPanels, hiddenPanels } };
}

/** Panel data as `user` sees it (their filter, if any, applied to the shared data). */
export async function dataFor(wsId: string, user: string, panelId: string, data: unknown): Promise<unknown> {
  const w = getWorkspace(wsId);
  if (!w || isOwner(w, user)) return data;
  const t = getView(wsId, user)?.overrides[panelId]?.viewTransform;
  if (!t || data === undefined) return data;
  try { return await evaluate(t, data); } catch { return data; }
}

/** Fan-out hooks installed into the runtime / workspace store. */
export function broadcastWorkspace(w: Workspace) {
  void broadcastEach(w.id, user => (canView(w, user) ? { type: 'workspace', workspace: effectiveWorkspace(w, user) } : undefined));
}
export function broadcastPanelData(wsId: string, msg: Extract<ServerMessage, { type: 'panel-data' }>) {
  void broadcastEach(wsId, async user => ({ ...msg, data: await dataFor(wsId, user, msg.panelId, msg.data) }));
}

export class ViewInvalid extends Error { constructor(public problems: string[]) { super(problems.join('\n')); } }

/** Apply view ops for a non-owner. Validated against the shared data (with the person's filter) before saving. */
export async function applyViewOps(w: Workspace, user: string, ops: ViewOp[]) {
  const v: UserView = getView(w.id, user) ?? { id: viewId(w.id, user), workspaceId: w.id, user, version: 0, overrides: {}, updatedAt: '' };
  const next: Record<string, PanelOverride> = structuredClone(v.overrides);
  const problems: string[] = [];
  const touched = new Set<string>();
  const panel = (id: string) => w.panels.find(p => p.id === id);
  for (const op of ops) {
    const p = panel(op.panelId);
    if (!p) { problems.push(`no panel "${op.panelId}"`); continue; }
    const ov = (next[p.id] ??= {});
    switch (op.op) {
      case 'replace_view': ov.components = op.components; if (op.title) ov.title = op.title; touched.add(p.id); break;
      case 'move_resize': ov.layout = clamp(op.layout); break;
      case 'hide_panel': ov.hidden = true; break;
      case 'show_panel': delete ov.hidden; break;
      case 'rename_panel': ov.title = op.title.slice(0, 80); break;
      case 'set_view_transform': if (op.transform) ov.viewTransform = op.transform; else delete ov.viewTransform; touched.add(p.id); break;
      default: problems.push(`unknown view op ${(op as { op: string }).op}`);
    }
  }
  for (const pid of touched) {
    const p = panel(pid)!;
    const ov = next[pid];
    let data = latest(w.id, pid)?.data;
    if (data === undefined) { try { data = (await runBinding(p.binding, w.owner)).data; } catch (e) { problems.push(`panel ${pid}: ${(e as Error).message}`); continue; } }
    if (ov.viewTransform) {
      try { data = await evaluate(ov.viewTransform, data); } catch (e) { problems.push(`panel ${pid}: view filter error: ${(e as Error).message}`); continue; }
    }
    problems.push(...validateView({ ...p, components: ov.components ?? p.components }, data).map(s => `panel ${pid}: ${s}`));
  }
  if (problems.length) throw new ViewInvalid(problems);
  const saved: UserView = { ...v, overrides: next, version: v.version + 1, updatedAt: new Date().toISOString() };
  store.put('view', saved, w.id);
  broadcastWorkspace(w);
  for (const pid of touched) { const l = latest(w.id, pid); if (l) broadcastPanelData(w.id, { type: 'panel-data', panelId: pid, ...l }); }
  activity(w.id, 'info', `${user} customized their view: ${ops.map(o => `${o.op.replace(/_/g, ' ')} ${o.panelId}`).join(' · ')}`);
  return effectiveWorkspace(w, user);
}

export function resetView(w: Workspace, user: string) {
  store.delete('view', viewId(w.id, user));
  broadcastWorkspace(w);
  for (const p of w.panels) { const l = latest(w.id, p.id); if (l) broadcastPanelData(w.id, { type: 'panel-data', panelId: p.id, ...l }); }
  activity(w.id, 'info', `${user} reset their view to the team view`);
  return effectiveWorkspace(w, user);
}

function clamp(l: Layout): Layout {
  const w = Math.max(2, Math.min(12, Math.round(l.w || 6)));
  return { x: Math.max(0, Math.min(12 - w, Math.round(l.x || 0))), y: Math.max(0, Math.round(l.y || 0)), w, h: Math.max(2, Math.min(12, Math.round(l.h || 4))) };
}
