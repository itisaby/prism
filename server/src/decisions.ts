// Decisions: what an agent (or a playbook, or a person's click) asks a human to approve.
// Approve → re-check (dry run) → signed approval → agentgateway → tools/call → result.
import { randomUUID } from 'node:crypto';
import type { Decision, Incident, Panel, Playbook, ProposedAction, RecordAction, Workspace } from '../../shared/types.ts';
import { signApproval } from './approval.ts';
import { activity, broadcast } from './bus.ts';
import { config } from './config.ts';
import { store } from './db.ts';
import { callTool, isWriteTool, toolInfo, discover, getConnection } from './mcp.ts';
import { emptyReceipt } from './llm.ts';
import { latest, validatePanel } from './runtime.ts';
import { metric, span, toolSpan } from './telemetry.ts';
import { canEdit, canView, getWorkspace } from './workspaces.ts';

export class Forbidden extends Error {}
export class BadRequest extends Error {}

export const getDecision = (id: string) => store.get<Decision>('decision', id);
export function saveDecision(d: Decision) {
  store.put('decision', d, d.workspaceId);
  broadcast(d.workspaceId, { type: 'decision', decision: d });
  return d;
}
export function saveIncident(i: Incident) {
  store.put('incident', i, i.workspaceId);
  broadcast(i.workspaceId, { type: 'incident', incident: i });
  return i;
}

// ---------------------------------------------------------------- argument checks
/** Minimal JSON-Schema check: required keys, no unknown keys when additionalProperties is false, primitive types. */
export function checkArgs(schema: any, args: Record<string, unknown>): string[] {
  const problems: string[] = [];
  if (!schema || schema.type !== 'object') return problems;
  const props = schema.properties ?? {};
  for (const r of schema.required ?? []) if (args[r] === undefined) problems.push(`missing required argument "${r}"`);
  for (const [k, v] of Object.entries(args)) {
    const p = props[k];
    if (!p) { if (schema.additionalProperties === false) problems.push(`unknown argument "${k}"`); continue; }
    const t = p.type;
    const actual = Array.isArray(v) ? 'array' : v === null ? 'null' : typeof v;
    const ok = !t || t === actual || (t === 'integer' && Number.isInteger(v)) || (Array.isArray(t) && t.includes(actual));
    if (!ok) problems.push(`argument "${k}" should be ${JSON.stringify(t)}, got ${actual}`);
    if (p.enum && !p.enum.includes(v)) problems.push(`argument "${k}" must be one of ${JSON.stringify(p.enum)}`);
  }
  return problems;
}

export async function validateAction(a: ProposedAction, user: string): Promise<string[]> {
  const conn = getConnection(a.connectionId, user);
  if (!conn) return [`unknown connectionId "${a.connectionId}"`];
  await discover(conn, user);
  const t = toolInfo(conn.id, a.tool);
  if (!t) return [`tool "${a.tool}" does not exist on ${conn.name}`];
  if (!isWriteTool(t)) return [`"${a.tool}" is read-only; a decision must propose a write`];
  const args = { ...a.args };
  delete args.dryRun;
  return checkArgs(t.inputSchema, args);
}

// ---------------------------------------------------------------- dry run
const supportsDryRun = (a: ProposedAction) => !!(toolInfo(a.connectionId, a.tool)?.inputSchema as any)?.properties?.dryRun;

/** Runs the write with dryRun:true. Kubernetes evaluates it server-side (dryRun=All) and nothing changes. */
export async function dryRun(a: ProposedAction, user: string): Promise<Decision['dryRun']> {
  if (!supportsDryRun(a)) return undefined;
  const args = { ...a.args, dryRun: true };
  try {
    // The token covers the exact dry-run arguments (dryRun:true), so it can't be replayed for the real write.
    const token = await signApproval({ user: 'prism:dry-run', decisionId: `dry-${randomUUID()}`, tool: a.tool, args });
    const res: any = await callTool(a.connectionId, a.tool, args, { user, allowWrite: true, approvalToken: token });
    const lines: string[] = Array.isArray(res?.changes) ? res.changes.map(String) : [typeof res?.text === 'string' ? res.text : JSON.stringify(res)];
    return { ok: true, lines: lines.length ? lines : ['No changes'] };
  } catch (e) {
    return { ok: false, lines: [(e as Error).message] };
  }
}

// ---------------------------------------------------------------- creating decisions
export async function createDecision(input: Omit<Decision, 'id' | 'status' | 'createdAt' | 'dryRun'> & { id?: string }, user: string) {
  const d: Decision = { ...input, id: input.id ?? `d-${randomUUID().slice(0, 8)}`, status: 'pending', createdAt: new Date().toISOString() };
  if (!d.needsInput?.length) d.dryRun = await dryRun(d.proposedAction, user); // with missing inputs the dry run waits for the person
  saveDecision(d);
  activity(d.workspaceId, 'decision', `Decision waiting: ${d.title}${d.dryRun ? ` · dry run ${d.dryRun.ok ? 'passed' : 'failed'}` : ''}`, { decisionId: d.id });
  return d;
}

/** A person clicked a record action ("Restart" on a row). The record is looked up in PRISM's own copy of the data. */
export async function decisionFromRecordAction(w: Workspace, user: string, panelId: string, actionId: string, record: Record<string, unknown>) {
  if (!canView(w, user)) throw new Forbidden('not your workspace');
  const panel = w.panels.find(p => p.id === panelId);
  const action = panel?.actions?.find(a => a.id === actionId);
  if (!panel || !action) throw new BadRequest('unknown panel or action');
  const key = record?.[action.recordKey];
  const serverRecord = findRecord(latest(w.id, panelId)?.data, action.recordKey, key);
  if (!serverRecord) throw new BadRequest(`record ${action.recordKey}=${String(key)} is not in this panel's current data`);
  const { args, needsInput } = resolveArgs(action, serverRecord, user);
  return createDecision({
    needsInput: needsInput.length ? needsInput : undefined,
    workspaceId: w.id, title: `${action.label} ${String(key)}`,
    summary: `${user} asked to run ${action.label.toLowerCase()} on ${String(key)}. It runs only after approval.`,
    rationale: 'Requested from a panel action.', evidence: [],
    proposedAction: { connectionId: action.connectionId, tool: action.tool, args, label: `${action.label} ${String(key)}`, consequences: [] },
    source: 'person', receipt: emptyReceipt(),
  }, w.owner);
}

function findRecord(data: unknown, key: string, value: unknown): Record<string, unknown> | undefined {
  if (Array.isArray(data)) {
    for (const x of data) {
      if (x && typeof x === 'object' && (x as any)[key] === value) return x as Record<string, unknown>;
      const inner = findRecord(x, key, value);
      if (inner) return inner;
    }
  } else if (data && typeof data === 'object') {
    for (const v of Object.values(data)) { const r = findRecord(v, key, value); if (r) return r; }
  }
  return undefined;
}

function resolveArgs(a: RecordAction, record: Record<string, unknown>, user: string) {
  const args: Record<string, unknown> = {};
  const needsInput: NonNullable<Decision['needsInput']> = [];
  for (const [k, src] of Object.entries(a.args)) {
    if ('record' in src) args[k] = record[src.record];
    else if ('value' in src) args[k] = src.value;
    else if ('user' in src) args[k] = user;
    else if ('ask' in src) {
      const raw = src.optionsFrom ? record[src.optionsFrom] : src.options;
      const options = Array.isArray(raw) ? raw.map(String) : typeof raw === 'string' ? raw.split(/[,;]\s*/).filter(Boolean) : undefined;
      needsInput.push({ arg: k, label: src.ask, ...(options?.length ? { options } : {}) });
    }
  }
  return { args, needsInput };
}

/** The person filled in the values an action asked for: complete the arguments, then validate and dry-run as usual. */
export async function provideInputs(id: string, user: string, values: Record<string, unknown>) {
  const d = getDecision(id);
  if (!d) throw new BadRequest('unknown decision');
  const w = getWorkspace(d.workspaceId)!;
  if (!canView(w, user)) throw new Forbidden('not an approver');
  if (d.status !== 'pending' || !d.needsInput?.length) return d;
  const schema: any = toolInfo(d.proposedAction.connectionId, d.proposedAction.tool)?.inputSchema ?? {};
  const args = { ...d.proposedAction.args };
  for (const n of d.needsInput) {
    let v = values?.[n.arg];
    if (v === undefined || v === '') throw new BadRequest(`${n.label} is required`);
    const t = schema.properties?.[n.arg]?.type;
    if ((t === 'number' || t === 'integer') && typeof v === 'string' && v.trim() !== '' && !Number.isNaN(Number(v))) v = Number(v);
    args[n.arg] = v;
  }
  const filled: Decision = { ...d, needsInput: undefined, proposedAction: { ...d.proposedAction, args, label: d.proposedAction.label } };
  const problems = await validateAction(filled.proposedAction, w.owner);
  if (problems.length) throw new BadRequest(problems.join('; '));
  filled.dryRun = await dryRun(filled.proposedAction, w.owner);
  activity(d.workspaceId, 'decision', `${user} filled in ${d.needsInput.map(n => n.label).join(', ')} · dry run ${filled.dryRun ? (filled.dryRun.ok ? 'passed' : 'failed') : 'n/a'}`);
  return saveDecision(filled);
}

// ---------------------------------------------------------------- approve / reject
const inFlight = new Set<string>();

export function approve(id: string, user: string) {
  return span('prism.approve', 'approve decision', { 'prism.decision': id, 'prism.approver': user }, () => approveInner(id, user));
}

async function approveInner(id: string, user: string) {
  const d = getDecision(id);
  if (!d) throw new BadRequest('unknown decision');
  const w = getWorkspace(d.workspaceId)!;
  if (!canView(w, user)) throw new Forbidden('you are not an approver on this workspace');
  if (d.status !== 'pending' || inFlight.has(id)) return d; // single use: PRISM enforces it even though the gateway token lives 30 s
  if (d.needsInput?.length) throw new BadRequest(`Fill in ${d.needsInput.map(n => n.label).join(', ')} first`);
  inFlight.add(id);
  try {
    d.status = 'approved'; d.decidedBy = user; d.decidedAt = new Date().toISOString();
    saveDecision(d);
    activity(d.workspaceId, 'decision', `Approved by ${user}: ${d.title}`);
    const incident = d.incidentId ? store.get<Incident>('incident', d.incidentId) : undefined;
    if (incident?.status === 'resolved') return fail(d, 'The incident cleared before the fix ran, so nothing was changed.');
    // Re-check that the proposal still applies right before running it.
    const problems = await validateAction(d.proposedAction, w.owner);
    if (problems.length) return fail(d, `Not run: ${problems.join('; ')}`);
    if (supportsDryRun(d.proposedAction)) {
      const check = await dryRun(d.proposedAction, w.owner);
      if (check && !check.ok) return fail(d, `Not run: the dry run failed just before execution (${check.lines.join('; ')})`);
    }
    const { tool, args, connectionId } = d.proposedAction;
    const token = await signApproval({ user, decisionId: d.id, tool, args });
    const t0 = Date.now();
    try {
      const res: any = await toolSpan(tool, connectionId, () => callTool(connectionId, tool, args, { user, allowWrite: true, approvalToken: token }));
      const changes: string[] = Array.isArray(res?.changes) ? res.changes : [];
      const gateway = config.gatewayUrl ? 'Checked at agentgateway: signature + exact arguments · allowed' : 'Direct (no gateway configured)';
      activity(d.workspaceId, 'gateway', `${tool} ran in ${Date.now() - t0} ms · ${gateway}`, { args });
      d.status = 'executed';
      metric.count('prism.decision.executed', 1, { tool, source: d.source });
      d.result = { ok: true, text: changes.join(' · ') || 'Done', gateway };
      if (incident) saveIncident({ ...incident, status: 'resolving' });
    } catch (e) {
      return fail(d, (e as Error).message);
    }
    return saveDecision(d);
  } finally {
    inFlight.delete(id);
  }
}

function fail(d: Decision, text: string) {
  d.status = 'failed';
  metric.count('prism.decision.failed', 1, { tool: d.proposedAction.tool, source: d.source });
  d.result = { ok: false, text, gateway: /gateway|400|denied|unauthori/i.test(text) ? 'Blocked or rejected upstream' : undefined };
  activity(d.workspaceId, 'error', `${d.title}: ${text}`);
  return saveDecision(d);
}

export function reject(id: string, user: string, note?: string) {
  const d = getDecision(id);
  if (!d) throw new BadRequest('unknown decision');
  const w = getWorkspace(d.workspaceId)!;
  if (!canView(w, user)) throw new Forbidden('not an approver');
  if (d.status !== 'pending') return d;
  d.status = 'rejected'; d.decidedBy = user; d.decidedAt = new Date().toISOString(); d.note = note;
  activity(d.workspaceId, 'decision', `Rejected by ${user}${note ? `: “${note}”` : ''}`);
  return saveDecision(d);
}

// ---------------------------------------------------------------- playbooks
export function savePlaybook(decisionId: string, user: string): Playbook {
  const d = getDecision(decisionId);
  if (!d?.incidentId) throw new BadRequest('only incident decisions can become playbooks');
  const w = getWorkspace(d.workspaceId)!;
  if (!canEdit(w, user)) throw new Forbidden('only the workspace owner can save playbooks');
  if (d.status !== 'executed') throw new BadRequest('save a playbook after the fix has run');
  const incident = store.get<Incident>('incident', d.incidentId)!;
  const existing = store.list<Playbook>('playbook', w.id).find(p =>
    p.match.watcherId === incident.watcherId && p.match.resource === incident.resource && p.match.reason === incident.reason);
  if (existing && !d.correction) return existing;
  const pb: Playbook = {
    ...(existing ? { id: existing.id, uses: existing.uses } : {}),
    id: existing?.id ?? `pb-${randomUUID().slice(0, 6)}`, workspaceId: w.id, title: d.title,
    match: { watcherId: incident.watcherId, resource: incident.resource, reason: incident.reason },
    evidenceTemplate: d.evidence, actionTemplate: d.proposedAction, rationale: d.rationale,
    origin: { incidentId: incident.id, incidentNumber: incident.number, savedBy: user, approvedBy: d.decidedBy, at: new Date().toISOString(), receipt: incident.receipt,
      ...(d.correction ? { correction: d.correction } : {}) },
    uses: existing?.uses ?? 0,
  };
  store.put('playbook', pb, w.id);
  broadcast(w.id, { type: 'playbook', playbook: pb });
  activity(w.id, 'playbook', `Saved playbook “${pb.title}” · matches ${pb.match.resource} · ${pb.match.reason}${d.correction ? ` · learned from ${d.correction.by}'s correction` : ''}`);
  return pb;
}

/** Evidence panels refresh like normal panels while a decision waits. */
export async function refreshEvidence(wsId: string, panelId: string): Promise<{ panel: Panel; data?: unknown; error?: string } | undefined> {
  const d = store.list<Decision>('decision', wsId).reverse().find(x => x.evidence.some(p => p.id === panelId));
  const panel = d?.evidence.find(p => p.id === panelId);
  if (!panel) return undefined;
  const w = getWorkspace(wsId)!;
  const r = await validatePanel(panel, w.owner);
  return { panel, data: r.data, error: r.problems.length ? r.problems.join('; ') : undefined };
}
