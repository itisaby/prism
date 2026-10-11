// Panel runtime: bindings → MCP → JSONata → A2UI data model, refreshed on a timer with zero model calls.
// Also validates proposed panels by executing them, and feeds raw results to watchers.
import jsonata from 'jsonata';
import type { Binding, Panel, Stats, Workspace } from '../../shared/types.ts';
import { activity, broadcast } from './bus.ts';
import { store } from './db.ts';
import { callTool, getConnection, isWriteTool, toolInfo, discover } from './mcp.ts';

// ---------------------------------------------------------------- A2UI validation (shared with the browser catalog)
type Validator = (components: unknown[], data: unknown) => string[];
let validateSurface: Validator | undefined;
export async function loadValidator() {
  try {
    const mod = await import('../../web/src/catalog/validate.ts');
    validateSurface = mod.validateSurface as Validator;
    console.log('A2UI validator loaded (prism catalog)');
  } catch (e) {
    console.warn('A2UI validator unavailable, using structural checks only:', (e as Error).message.split('\n')[0]);
  }
}

const ACTION_COMPONENTS = new Set(['DataTable', 'CardList', 'StatusList']);

/** Components as the browser sees them: PRISM injects each panel's record actions into the components that show records. */
export function renderComponents(panel: Panel) {
  if (!panel.actions?.length) return panel.components;
  const recordActions = panel.actions.map(a => ({ id: a.id, label: a.label, ...(a.when ? { when: a.when } : {}) }));
  return panel.components.map(c => (ACTION_COMPONENTS.has(String(c.component)) ? { ...c, recordActions } : c));
}

export const publicWorkspace = (w: Workspace): Workspace => ({ ...w, panels: w.panels.map(p => ({ ...p, components: renderComponents(p) })) });

// ---------------------------------------------------------------- executing bindings
export async function evaluate(expr: string, input: unknown, timeoutMs = 2000): Promise<unknown> {
  const compiled = jsonata(expr);
  return Promise.race([
    compiled.evaluate(input),
    new Promise((_, rej) => setTimeout(() => rej(new Error('JSONata transform took too long')), timeoutMs)),
  ]);
}

export async function runBinding(b: Binding, user: string) {
  const raw = await callTool(b.connectionId, b.tool, b.args ?? {}, { user });
  let data: unknown;
  try { data = await evaluate(b.transform || '$', raw); }
  catch (e) { throw new Error(`JSONata error in transform: ${(e as any).message ?? e}`); }
  return { raw, data: data ?? {} };
}

/** Validate a proposed panel by running it. Returns problems (empty = valid) and the data it produced. */
export async function validatePanel(p: Panel, user: string): Promise<{ problems: string[]; data?: unknown; raw?: unknown }> {
  const problems: string[] = [];
  if (!p.id || !p.title) problems.push('panel needs id and title');
  if (!Array.isArray(p.components) || !p.components.some(c => c?.id === 'root')) problems.push(`panel ${p.id}: one component must have id "root"`);
  const conn = getConnection(p.binding?.connectionId, user);
  if (!conn) return { problems: [...problems, `panel ${p.id}: unknown connectionId "${p.binding?.connectionId}"`] };
  await discover(conn, user);
  const tool = toolInfo(conn.id, p.binding.tool);
  if (!tool) return { problems: [...problems, `panel ${p.id}: tool "${p.binding.tool}" does not exist on ${conn.name}`] };
  if (isWriteTool(tool)) return { problems: [...problems, `panel ${p.id}: "${p.binding.tool}" is a write tool; panels may only bind read-only tools`] };
  for (const a of p.actions ?? []) {
    const t = toolInfo(a.connectionId, a.tool);
    if (!t) problems.push(`panel ${p.id}: action "${a.id}" uses unknown tool "${a.tool}"`);
    else if (!isWriteTool(t)) problems.push(`panel ${p.id}: action "${a.id}" uses read-only tool "${a.tool}"; actions are for write tools`);
  }
  let out: { raw: unknown; data: unknown };
  try { out = await runBinding(p.binding, user); }
  catch (e) { return { problems: [...problems, `panel ${p.id}: ${(e as Error).message}`] }; }
  if (out.data === null || typeof out.data !== 'object' || Array.isArray(out.data))
    problems.push(`panel ${p.id}: transform must return an object (the A2UI data model), got ${Array.isArray(out.data) ? 'an array' : typeof out.data}`);
  else if (validateSurface) problems.push(...validateSurface(renderComponents(p), out.data).map(s => `panel ${p.id}: ${s}`));
  return { problems, ...out };
}

// ---------------------------------------------------------------- refresh loop
type RawListener = (workspace: Workspace, panel: Panel, raw: unknown) => void;
const timers = new Map<string, NodeJS.Timeout[]>();
const lastData = new Map<string, { data: unknown; at: string; error?: string }>(); // `${ws}|${panel}`
const statsCache = new Map<string, Stats>();
let onRaw: RawListener = () => {};
export const setRawListener = (fn: RawListener) => { onRaw = fn; };

export function getStats(wsId: string): Stats {
  let s = statsCache.get(wsId);
  if (!s) statsCache.set(wsId, (s = store.get<Stats & { id: string }>('stats', wsId) ?? { refreshes: 0, modelCalls: 0, costUsd: 0 }));
  return s;
}
let statsDirty = new Set<string>();
setInterval(() => { for (const id of statsDirty) store.put('stats', { id, ...getStats(id) }, id); statsDirty = new Set(); }, 5000).unref();

export function addModelCost(wsId: string, modelCalls: number, costUsd: number) {
  const s = getStats(wsId);
  s.modelCalls += modelCalls; s.costUsd += costUsd;
  statsDirty.add(wsId);
  broadcast(wsId, { type: 'stats', stats: s });
}
export function resetStats(wsId: string, keepBuild = true) {
  const s = getStats(wsId);
  s.refreshes = 0;
  if (!keepBuild) { s.modelCalls = 0; s.costUsd = 0; }
  statsDirty.add(wsId);
  broadcast(wsId, { type: 'stats', stats: s });
}

export const latest = (wsId: string, panelId: string) => lastData.get(`${wsId}|${panelId}`);

export async function refreshPanel(wsId: string, panelId: string) {
  const w = store.get<Workspace>('workspace', wsId);
  const p = w?.panels.find(x => x.id === panelId);
  if (!w || !p) return;
  const key = `${wsId}|${panelId}`;
  try {
    const { raw, data } = await runBinding(p.binding, w.owner);
    const entry = { data, at: new Date().toISOString() };
    lastData.set(key, entry);
    broadcast(wsId, { type: 'panel-data', panelId, ...entry });
    const s = getStats(wsId);
    s.refreshes++;
    statsDirty.add(wsId);
    broadcast(wsId, { type: 'stats', stats: s });
    onRaw(w, p, raw);
    return entry;
  } catch (e) {
    const prev = lastData.get(key);
    const entry = { data: prev?.data, at: prev?.at ?? new Date().toISOString(), error: (e as Error).message };
    lastData.set(key, entry);
    broadcast(wsId, { type: 'panel-data', panelId, data: entry.data, at: entry.at, error: entry.error });
  }
}

/** (Re)start refresh timers for every panel in a workspace. Call after any structural change. */
export function schedule(w: Workspace) {
  for (const t of timers.get(w.id) ?? []) clearInterval(t);
  const list: NodeJS.Timeout[] = [];
  for (const p of w.panels) {
    const every = Math.max(3, p.refreshSec || 10) * 1000;
    refreshPanel(w.id, p.id);
    list.push(setInterval(() => refreshPanel(w.id, p.id), every));
  }
  timers.set(w.id, list);
}

export function scheduleAll() {
  for (const w of store.list<Workspace>('workspace')) if (w.panels.length) schedule(w);
}

export function noteRefreshActivity(wsId: string, text: string) { activity(wsId, 'refresh', text); }
