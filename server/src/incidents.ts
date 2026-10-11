// Watchers → incidents → (playbook replay | investigate agent) → decision. Watchers run on every refresh with no model.
import { randomUUID } from 'node:crypto';
import type { Decision, Incident, Panel, Playbook, Watcher, Workspace } from '../../shared/types.ts';
import { activity, clearActivity } from './bus.ts';
import { store } from './db.ts';
import { createDecision, saveDecision, saveIncident, validateAction } from './decisions.ts';
import { AgentStopped, READ_TOOL, capabilitiesText, emptyReceipt, runReadTool, toolLoop } from './llm.ts';
import { CATALOG_GUIDE, INVESTIGATOR_SYSTEM } from './prompts.ts';
import { addModelCost, evaluate, resetStats, validatePanel } from './runtime.ts';
import { getWorkspace } from './workspaces.ts';
import { capture, span } from './telemetry.ts';

export let autoInvestigate = true;
const clearCounts = new Map<string, number>(); // incident id → consecutive healthy evaluations
const seenCounts = new Map<string, number>();  // `${wsId}|${watcherId}|${resource}` → consecutive failing evaluations
const investigating = new Set<string>();

const REASON_ALIASES: Record<string, string> = { ErrImagePull: 'ImagePullBackOff', InvalidImageName: 'ImagePullBackOff' };

const active = (wsId: string) => store.list<Incident>('incident', wsId).filter(i => i.status !== 'resolved');

function nextNumber(wsId: string) {
  const c = store.get<{ id: string; n: number }>('stats', `${wsId}:incidents`) ?? { id: `${wsId}:incidents`, n: 0 };
  c.n++;
  store.put('stats', c, null);
  return c.n;
}

/** Called by the runtime after every successful panel refresh. */
export async function onPanelRaw(w: Workspace, p: Panel, raw: unknown) {
  for (const wt of w.watchers.filter(x => x.panelId === p.id)) {
    let findings: { resource: string; reason: string; detail?: string }[] = [];
    try {
      const out = await evaluate(wt.condition, raw);
      const arr = out === undefined ? [] : Array.isArray(out) ? out : [out];
      const seen = new Set<string>();
      for (const f of arr as any[]) {
        if (!f?.resource) continue;
        const reason = REASON_ALIASES[String(f.reason)] ?? String(f.reason ?? 'Unhealthy');
        if (seen.has(f.resource)) continue;
        seen.add(f.resource);
        findings.push({ resource: String(f.resource), reason, detail: f.detail ? String(f.detail) : undefined });
      }
    } catch (e) {
      continue; // a broken condition never opens incidents
    }
    lastFindings.set(`${w.id}|${wt.id}`, new Map(findings.map(f => [f.resource, f.reason])));
    const all = active(w.id);
    const open = all.filter(i => i.watcherId === wt.id);
    const failing = new Set(findings.map(f => `${w.id}|${wt.id}|${f.resource}`));
    for (const k of [...seenCounts.keys()]) if (k.startsWith(`${w.id}|${wt.id}|`) && !failing.has(k)) seenCounts.delete(k);
    for (const f of findings) {
      const existing = open.find(i => i.resource === f.resource);
      if (existing) { clearCounts.delete(existing.id); continue; }
      // One incident per resource: a second watcher seeing the same cause (pods failing + deployment degraded) attaches to it.
      const related = all.find(i => i.resource === f.resource);
      if (related) { clearCounts.delete(related.id); continue; }
      // Debounce: the finding must hold for two consecutive refreshes, so transient states don't open incidents.
      const key = `${w.id}|${wt.id}|${f.resource}`;
      const n = (seenCounts.get(key) ?? 0) + 1;
      seenCounts.set(key, n);
      if (n < 2) continue;
      seenCounts.delete(key);
      openIncident(w, wt, f);
    }
    for (const i of open) {
      if (findings.some(f => f.resource === i.resource)) continue;
      // Still failing according to another watcher? Then it isn't healthy yet.
      if (i.status !== 'resolving' && stillFailingElsewhere(w.id, wt.id, i.resource)) continue;
      const n = (clearCounts.get(i.id) ?? 0) + 1;
      clearCounts.set(i.id, n);
      if (n >= 2) resolveIncident(i);
    }
  }
}

const lastFindings = new Map<string, Map<string, string>>(); // `${wsId}|${watcherId}` → resource → reason at last evaluation
function stillFailingElsewhere(wsId: string, watcherId: string, resource: string) {
  for (const [k, m] of lastFindings) if (k.startsWith(wsId + '|') && k !== `${wsId}|${watcherId}` && m.has(resource)) return true;
  return false;
}

function openIncident(w: Workspace, wt: Watcher, f: { resource: string; reason: string; detail?: string }) {
  const i: Incident = {
    id: `inc-${randomUUID().slice(0, 8)}`, number: nextNumber(w.id), workspaceId: w.id, watcherId: wt.id,
    resource: f.resource, reason: f.reason, detail: f.detail, signature: `${wt.id}|${f.resource}|${f.reason}`,
    status: 'open', openedAt: new Date().toISOString(), receipt: emptyReceipt(),
  };
  saveIncident(i);
  activity(w.id, 'incident', `Incident #${i.number}: ${wt.title} · ${i.resource} · ${i.reason}`, { incidentId: i.id });
  const pb = findPlaybook(w.id, i);
  if (pb) return void replayPlaybook(i, pb);
  // Other watchers may report the same failure a refresh later (e.g. pods vs deployment). Give them one cycle
  // before paying for the model.
  setTimeout(() => {
    const fresh = store.get<Incident>('incident', i.id);
    if (!fresh || fresh.status !== 'open' || fresh.decisionId) return;
    const later = findPlaybook(w.id, fresh);
    if (later) void replayPlaybook(fresh, later);
    else if (autoInvestigate) void investigate(fresh.id);
  }, 6000);
}

/** A playbook applies when the same resource shows the same failure, as reported by the incident or by any watcher right now. */
function findPlaybook(wsId: string, i: Incident) {
  return store.list<Playbook>('playbook', wsId).find(p => p.match.resource === i.resource && (
    (p.match.watcherId === i.watcherId && p.match.reason === i.reason) ||
    lastFindings.get(`${wsId}|${p.match.watcherId}`)?.get(i.resource) === p.match.reason));
}

function resolveIncident(i: Incident) {
  clearCounts.delete(i.id);
  const fresh = store.get<Incident>('incident', i.id) ?? i;
  saveIncident({ ...fresh, status: 'resolved', resolvedAt: new Date().toISOString() });
  activity(i.workspaceId, 'incident', `Incident #${i.number} resolved · ${i.resource} is healthy`);
  if (fresh.decisionId) {
    const d = store.get<Decision>('decision', fresh.decisionId);
    if (d?.status === 'pending') saveDecision({ ...d, status: 'rejected', note: 'Cleared before anyone approved' });
  }
}

// ---------------------------------------------------------------- playbook replay (0 model calls)
function replayPlaybook(i: Incident, pb: Playbook) {
  // A replay is deliberately model-free: in Sentry this span has no gen_ai children.
  return span('prism.playbook.replay', `replay playbook ${pb.title}`, {
    'prism.incident': i.number, 'prism.resource': i.resource, 'prism.playbook': pb.id, 'gen_ai.model_calls': 0,
  }, () => replayInner(i, pb));
}

async function replayInner(i: Incident, pb: Playbook) {
  const t0 = Date.now();
  if (!store.get<Incident>('incident', i.id)) return;
  const w = getWorkspace(i.workspaceId)!;
  const suffix = randomUUID().slice(0, 4);
  const d = await createDecision({
    workspaceId: w.id, incidentId: i.id, title: pb.title,
    summary: `Same as incident #${pb.origin.incidentNumber}: ${i.resource} hit ${pb.match.reason} again. The saved playbook proposes the fix that worked last time.`,
    rationale: pb.rationale,
    evidence: pb.evidenceTemplate.map(p => ({ ...p, id: `${p.id}-${suffix}` })),
    proposedAction: pb.actionTemplate, source: 'playbook', playbookId: pb.id, receipt: emptyReceipt(),
  }, w.owner);
  d.matchMs = Date.now() - t0;
  saveDecision(d);
  store.put('playbook', { ...pb, uses: pb.uses + 1 }, w.id);
  saveIncident({ ...i, status: 'awaiting-approval', decisionId: d.id });
  activity(w.id, 'playbook', `Playbook matched in ${d.matchMs} ms · 0 model calls · decision ready`, { decisionId: d.id });
}

// ---------------------------------------------------------------- investigate agent (event-driven, bounded, ends by proposing)
export async function investigate(incidentId: string): Promise<Decision | undefined> {
  const i = store.get<Incident>('incident', incidentId);
  if (!i || i.status === 'resolved' || investigating.has(i.id)) return undefined;
  if (i.decisionId) return store.get<Decision>('decision', i.decisionId);
  investigating.add(i.id);
  const w = getWorkspace(i.workspaceId)!;
  const wt = w.watchers.find(x => x.id === i.watcherId);
  const user = w.owner;
  const receipt = i.receipt ?? emptyReceipt();
  saveIncident({ ...i, status: 'investigating' });
  activity(w.id, 'incident', `No playbook matches · waking the investigate agent for incident #${i.number}`);
  let decision: Decision | undefined;
  const transcript: any[] = [];
  try {
    const caps = await capabilitiesText(user);
    let proposals = 0;
    await toolLoop({
      wsId: w.id, user, label: 'Investigator', receipt, maxTurns: 10, transcript,
      system: INVESTIGATOR_SYSTEM,
      stablePrefix: `${CATALOG_GUIDE}\n# Connected capabilities\n${caps}`,
      prompt: `Incident #${i.number}: watcher "${wt?.title ?? i.watcherId}" fired.\nresource: ${i.resource}\nreason: ${i.reason}\n` +
        `${i.detail ? `detail: ${i.detail}\n` : ''}Workspace panels (for context):\n` +
        JSON.stringify(w.panels.map(p => ({ id: p.id, title: p.title, binding: p.binding }))),
      tools: [
        { def: READ_TOOL, run: input => runReadTool(w.id, user, input) },
        {
          def: {
            name: 'propose_decision',
            description: 'Send the person a decision surface: live evidence panels + one proposed write action. PRISM validates panels by running them, checks the action against the tool schema and dry-runs it.',
            input_schema: {
              type: 'object',
              properties: {
                title: { type: 'string', description: 'Imperative, e.g. "Roll back checkout-worker to v1"' },
                summary: { type: 'string', description: '1–2 plain sentences: what broke and why' },
                rationale: { type: 'string' },
                evidencePanels: { type: 'array', items: { type: 'object' }, description: 'Panels {id,title,binding,components,refreshSec}' },
                proposedAction: {
                  type: 'object',
                  properties: { connectionId: { type: 'string' }, tool: { type: 'string' }, args: { type: 'object' }, label: { type: 'string' }, consequences: { type: 'array', items: { type: 'string' } } },
                  required: ['connectionId', 'tool', 'args', 'label', 'consequences'],
                },
              },
              required: ['title', 'summary', 'rationale', 'evidencePanels', 'proposedAction'],
            },
          },
          run: async input => {
            proposals++;
            const problems: string[] = [];
            const evidence: Panel[] = (input.evidencePanels ?? []).slice(0, 4).map((p: any, n: number) => ({
              ...p, id: `ev-${i.number}-${n + 1}`, layout: { x: 0, y: n * 4, w: 12, h: 4 }, refreshSec: Math.max(5, p.refreshSec || 5),
              binding: { ...p.binding, args: p.binding?.args ?? {}, transform: p.binding?.transform || '$' },
            }));
            for (const p of evidence) problems.push(...(await validatePanel(p, user)).problems);
            problems.push(...(await validateAction(input.proposedAction, user)));
            if (problems.length) {
              activity(w.id, 'validate', `Decision proposal ${proposals} rejected: ${problems.length} problem(s)`, problems);
              return proposals >= 3 ? { done: { failed: problems.join('; ') } } : { error: 'Not sent. Fix:\n- ' + problems.join('\n- ') };
            }
            const action = { ...input.proposedAction, args: Object.fromEntries(Object.entries(input.proposedAction.args).filter(([k]) => k !== 'dryRun')) };
            decision = await createDecision({
              workspaceId: w.id, incidentId: i.id, title: input.title, summary: input.summary, rationale: input.rationale,
              evidence, proposedAction: action, source: 'agent', receipt,
            }, user);
            if (decision.dryRun && !decision.dryRun.ok && proposals < 3) {
              saveDecision({ ...decision, status: 'rejected', note: 'Dry run failed; agent revising' });
              const lines = decision.dryRun.lines.join('; ');
              decision = undefined;
              return { error: `The dry run of that action failed: ${lines}. Propose a different fix.` };
            }
            activity(w.id, 'validate', `Evidence panels ran · action matches ${action.tool}'s schema · dry run ${decision.dryRun?.ok ? 'passed' : 'n/a'}`);
            return { done: { decisionId: decision.id } };
          },
        },
        {
          def: { name: 'cannot_decide', description: 'Use when no safe fix exists with the connected tools.', input_schema: { type: 'object', properties: { findings: { type: 'string' } }, required: ['findings'] } },
          run: async input => { activity(w.id, 'incident', `Investigator: no safe fix — ${input.findings}`); return { done: {} }; },
        },
      ],
    });
  } catch (e) {
    if (!(e instanceof AgentStopped)) capture(e, { incident: i.id });
    activity(w.id, 'error', e instanceof AgentStopped ? e.message : `Investigator error: ${(e as Error).message}`);
  } finally {
    investigating.delete(i.id);
    store.put('agent-transcript', { id: i.id, transcript }, w.id);
    addModelCost(w.id, receipt.modelCalls, receipt.costUsd);
    const fresh = store.get<Incident>('incident', i.id);
    if (!fresh) {
      // The incident was cleared (demo reset) while the agent worked: drop its decision too.
      if (decision) store.delete('decision', decision.id);
      return undefined;
    }
    if (decision) {
      decision.receipt = receipt;
      saveDecision(decision);
      saveIncident({ ...fresh, receipt, status: fresh.status === 'resolved' ? 'resolved' : 'awaiting-approval', decisionId: decision.id });
      activity(w.id, 'info', `Investigation took ${(receipt.ms / 1000).toFixed(1)} s · ${receipt.modelCalls} model calls · $${receipt.costUsd.toFixed(3)} · agent finished; decision waits for a person`);
    } else {
      saveIncident({ ...fresh, receipt, status: fresh.status === 'resolved' ? 'resolved' : 'open' });
    }
  }
  return decision;
}

// ---------------------------------------------------------------- demo reset
export function resetWorkspace(wsId: string, keepPlaybooks: boolean) {
  for (const i of store.list<Incident>('incident', wsId)) clearCounts.delete(i.id);
  store.deleteForWorkspace('incident', wsId);
  store.deleteForWorkspace('decision', wsId);
  store.deleteForWorkspace('agent-transcript', wsId);
  if (!keepPlaybooks) { store.deleteForWorkspace('playbook', wsId); store.delete('stats', `${wsId}:incidents`); }
  resetStats(wsId, true);
  clearActivity(wsId);
}

export const setAutoInvestigate = (on: boolean) => { autoInvestigate = on; };
