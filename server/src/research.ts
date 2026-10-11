// Research runs: Nimble Web Search Agents tracked by PRISM. An agent (composer or investigator) starts one with a
// question; PRISM polls the run, fetches the cited result when it completes, stores it, and exposes it to panels
// through the built-in "research" source (tool `research_report`), so a research panel refreshes like any other
// panel, with zero model calls, from "running · 12 s" to the full report with claims and sources.
import { randomUUID } from 'node:crypto';
import type { DiscoveredTool } from '../../shared/types.ts';
import { activity } from './bus.ts';
import { store } from './db.ts';
import { callTool, getConnection } from './mcp.ts';
import { metric } from './telemetry.ts';

export const RESEARCH_CONNECTION = 'research';

export interface Research {
  id: string;
  workspaceId: string;
  question: string;
  effort: 'low' | 'medium' | 'high';
  requestedBy: string;          // "Composer", "Investigator", or a person
  runId?: string;
  agentId?: string;
  status: 'queued' | 'running' | 'completed' | 'failed';
  startedAt: string;
  completedAt?: string;
  error?: string;
  result?: { report: string; confidence?: string; confidenceReason?: string; claims: unknown[]; sources: unknown[] };
}

const CONTEXT = 'PRISM workspace research run: cited web findings shown to an operator as a live panel next to their systems.';
const HOURLY_CAP = Number(process.env.PRISM_RESEARCH_PER_HOUR ?? 8);
const started: number[] = [];

/** Built-in tool the panels bind to. Read-only: it only reads PRISM's copy of the run. */
export const RESEARCH_TOOL: DiscoveredTool = {
  name: 'research_report',
  description: 'Live status and cited result of a PRISM research run (Nimble Web Search Agent).',
  inputSchema: { type: 'object', properties: { researchId: { type: 'string' } }, required: ['researchId'] },
  annotations: { readOnlyHint: true },
};

export async function startResearch(input: { workspaceId: string; question: string; effort?: string; requestedBy: string; user: string }) {
  if (!getConnection('nimble', input.user)) throw new Error('Research needs the Nimble connection (NIMBLE_API_KEY).');
  const now = Date.now();
  while (started.length && now - started[0] > 3_600_000) started.shift();
  if (started.length >= HOURLY_CAP) throw new Error(`Research limit reached (${HOURLY_CAP} runs per hour).`);
  started.push(now);
  const effort = (['low', 'medium', 'high'].includes(String(input.effort)) ? input.effort : 'medium') as Research['effort'];
  const r: Research = {
    id: `rs-${randomUUID().slice(0, 8)}`, workspaceId: input.workspaceId, question: input.question.slice(0, 600), effort,
    requestedBy: input.requestedBy, status: 'queued', startedAt: new Date().toISOString(),
  };
  // Starting a run spends Nimble credits but changes nothing in the person's systems, so PRISM runs it without an approval.
  const res: any = await callTool('nimble', 'nimble_agents_run',
    { input: r.question, agent_name: 'prism-research', effort, context: CONTEXT }, { user: input.user, allowWrite: true });
  r.runId = res?.id; r.agentId = res?.agent_id ?? res?.web_search_agent_id; r.status = res?.status === 'running' ? 'running' : 'queued';
  if (!r.runId || !r.agentId) throw new Error('Nimble did not return a run id');
  store.put('research', r, r.workspaceId);
  activity(r.workspaceId, 'tool', `${r.requestedBy} started a Nimble research run (${effort} effort): “${r.question.slice(0, 120)}”`, { researchId: r.id });
  void poll(r.id, input.user);
  return r;
}

async function poll(id: string, user: string) {
  for (let i = 0; i < 180; i++) { // up to ~15 min
    await new Promise(res => setTimeout(res, 5000));
    const r = store.get<Research>('research', id);
    if (!r || r.status === 'completed' || r.status === 'failed') return;
    try {
      const s: any = await callTool('nimble', 'nimble_agents_run_status', { run_id: r.runId, agent_id: r.agentId, context: CONTEXT }, { user });
      if (s?.status === 'completed') {
        const out: any = await callTool('nimble', 'nimble_agents_run_result', { run_id: r.runId, agent_id: r.agentId, context: CONTEXT }, { user });
        const trust = out?.output?.trust ?? {};
        r.result = {
          report: String(out?.output?.content ?? ''), confidence: trust.confidence, confidenceReason: trust.reasoning,
          claims: Array.isArray(trust.claims) ? trust.claims : [], sources: Array.isArray(trust.sources) ? trust.sources : [],
        };
        r.status = 'completed'; r.completedAt = new Date().toISOString();
        store.put('research', r, r.workspaceId);
        const secs = Math.round((Date.parse(r.completedAt) - Date.parse(r.startedAt)) / 1000);
        metric.count('prism.research.completed', 1, { effort: r.effort, requested_by: r.requestedBy });
        metric.distribution('prism.research.duration_ms', secs * 1000, 'millisecond', { effort: r.effort });
        activity(r.workspaceId, 'tool', `Research finished in ${secs} s · ${r.result.claims.length} claims · ${r.result.sources.length} sources · ${r.result.confidence ?? 'n/a'} confidence`, { researchId: r.id });
        return;
      }
      if (s?.status === 'failed' || s?.status === 'cancelled') throw new Error(`run ${s.status}`);
      if (s?.status === 'running' && r.status !== 'running') { r.status = 'running'; store.put('research', r, r.workspaceId); }
    } catch (e) {
      if (i > 3 || /failed|cancelled/.test((e as Error).message)) {
        r.status = 'failed'; r.error = (e as Error).message.slice(0, 300); store.put('research', r, r.workspaceId);
        activity(r.workspaceId, 'error', `Research failed: ${r.error}`);
        return;
      }
    }
  }
}

/** What a `research_report` binding returns: one object, shaped for the Research component. */
export function researchReport(args: Record<string, unknown>) {
  const r = store.get<Research>('research', String(args.researchId ?? ''));
  if (!r) throw new Error(`unknown researchId "${String(args.researchId)}"`);
  const end = r.completedAt ? Date.parse(r.completedAt) : Date.now();
  const sources = (r.result?.sources ?? []).map((s: any) => ({ title: s.title ?? s.url, url: s.url, type: s.type ?? 'source', category: s.source_category }));
  const claims = (r.result?.claims ?? []).map((c: any, n: number) => ({
    n: c.callout ?? n + 1, confidence: c.confidence, reasoning: c.reasoning, citations: (c.citations ?? []).length,
  }));
  return {
    id: r.id, question: r.question, effort: r.effort, requestedBy: r.requestedBy, status: r.status,
    elapsedSec: Math.round((end - Date.parse(r.startedAt)) / 1000), startedAt: r.startedAt, completedAt: r.completedAt ?? null,
    error: r.error ?? null, confidence: r.result?.confidence ?? null, confidenceReason: r.result?.confidenceReason ?? null,
    report: r.result?.report ?? '', claims, sources,
    counts: {
      claims: claims.length, sources: sources.length,
      primary: sources.filter(s => s.type === 'primary').length, secondary: sources.filter(s => s.type === 'secondary').length,
    },
  };
}

export const START_RESEARCH_DEF = {
  name: 'start_research',
  description: 'Start a deep web research run (Nimble Web Search Agent: searches, reads and cross-checks sources, returns a cited report with per-claim confidence). Takes ~15 s (low) to a few minutes (high). Returns a researchId; bind a panel to connection "research", tool "research_report", args {"researchId": …} and render it with the Research component (data: {"path":"/"}). Use for questions the connected systems cannot answer: vendor issues, error explanations, best practices, comparisons.',
  input_schema: {
    type: 'object' as const,
    properties: { question: { type: 'string' }, effort: { type: 'string', enum: ['low', 'medium', 'high'] } },
    required: ['question'],
  },
};
