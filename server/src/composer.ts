// Composer: request → (sample read tools) → propose_ops → execute-to-validate → apply. ≤3 proposals.
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import type { Op, Receipt, Workspace } from '../../shared/types.ts';
import { ROOT } from './config.ts';
import { activity, broadcast } from './bus.ts';
import { AgentStopped, READ_TOOL, capabilitiesText, emptyReceipt, runReadTool, toolLoop } from './llm.ts';
import { CATALOG_GUIDE, COMPOSER_SYSTEM, VIEW_COMPOSER_SYSTEM } from './prompts.ts';
import { ViewInvalid, applyViewOps, effectiveWorkspace } from './views.ts';
import { latest } from './runtime.ts';
import { addModelCost } from './runtime.ts';
import { START_RESEARCH_DEF, startResearch } from './research.ts';
import { Conflict, Invalid, applyOps, getWorkspace, saveWorkspace } from './workspaces.ts';

const running = new Set<string>();

export async function compose(wsId: string, user: string, prompt: string): Promise<{ summary: string; receipt: Receipt; workspace?: Workspace; gap?: boolean }> {
  if (running.has(wsId)) throw new Error('A composition is already running for this workspace.');
  running.add(wsId);
  const receipt = emptyReceipt();
  broadcast(wsId, { type: 'compose', state: 'started' });
  activity(wsId, 'info', `Composing: “${prompt}”`);
  const start = getWorkspace(wsId)!;
  const firstBuild = start.panels.length === 0;
  let proposals = 0;
  try {
    const caps = await capabilitiesText(user);
    const result: any = await toolLoop({
      wsId, user, label: 'Composer', receipt, maxTurns: 10,
      system: COMPOSER_SYSTEM,
      stablePrefix: `${CATALOG_GUIDE}\n# Connected capabilities\n${caps}`,
      prompt: `Request: ${prompt}\n\nCurrent workspace (version ${start.version}):\n${JSON.stringify(summarize(start))}`,
      tools: [
        { def: READ_TOOL, run: input => runReadTool(wsId, user, input) },
        {
          def: START_RESEARCH_DEF,
          run: async input => {
            try {
              const r = await startResearch({ workspaceId: wsId, question: String(input.question ?? ''), effort: input.effort, requestedBy: 'Composer', user });
              return { researchId: r.id, status: r.status, bind: { connectionId: 'research', tool: 'research_report', args: { researchId: r.id }, transform: '$' },
                note: 'The run continues in the background; the panel shows progress, then the cited report. Use the Research component with data {"path":"/"}; panel refreshSec 10.' };
            } catch (e) { return { error: (e as Error).message }; }
          },
        },
        {
          def: {
            name: 'propose_ops',
            description: 'Apply workspace ops atomically. PRISM executes every binding, validates the A2UI views and watcher conditions, and returns problems if any.',
            input_schema: {
              type: 'object',
              properties: {
                summary: { type: 'string' },
                title: { type: 'string', description: 'Optional workspace title (set it on a first build)' },
                ops: { type: 'array', items: { type: 'object' }, description: 'add_panel{panel} | remove_panel{panelId} | move_resize{panelId,layout} | replace_view{panelId,components,title?} | update_binding{panelId,binding} | set_actions{panelId,actions} | watch{watcher} | unwatch{watcherId}' },
              },
              required: ['summary', 'ops'],
            },
          },
          run: async input => {
            proposals++;
            writeFileSync(path.join(ROOT, 'data', `last-proposal-${proposals}.json`), JSON.stringify(input, null, 2));
            const ops: Op[] = [...(input.ops ?? [])];
            if (input.title) ops.push({ op: 'rename_workspace', title: input.title });
            try {
              const w = await applyOps(wsId, user, undefined, ops);
              activity(wsId, 'validate', `Checked ${ops.length} ops by running them · applied as v${w.version}`);
              return { done: { summary: input.summary, workspace: w } };
            } catch (e) {
              if (e instanceof Invalid) {
                activity(wsId, 'validate', `Proposal ${proposals} rejected: ${e.problems.length} problem(s)`, e.problems);
                if (proposals >= 3) return { done: { failed: `Couldn't produce valid panels: ${e.problems.slice(0, 3).join('; ')}` } };
                return { error: 'Not applied. Fix these and call propose_ops again:\n- ' + e.problems.join('\n- ') };
              }
              if (e instanceof Conflict) return { error: e.message };
              throw e;
            }
          },
        },
        {
          def: {
            name: 'explain_gap',
            description: 'Use when the request cannot be met with the connected tools. Say plainly what is missing.',
            input_schema: { type: 'object', properties: { message: { type: 'string' } }, required: ['message'] },
          },
          run: async input => ({ done: { gap: input.message } }),
        },
      ],
    });
    const d = result?.done ?? {};
    addModelCost(wsId, receipt.modelCalls, receipt.costUsd);
    if (d.workspace) {
      if (firstBuild) { const w = getWorkspace(wsId)!; w.buildReceipt = receipt; saveWorkspace(w); }
      activity(wsId, 'info', `Done in ${(receipt.ms / 1000).toFixed(1)} s · ${receipt.modelCalls} model calls · $${receipt.costUsd.toFixed(3)} — from now on it refreshes with no model calls`);
      broadcast(wsId, { type: 'compose', state: 'done', summary: d.summary, receipt });
      return { summary: d.summary, receipt, workspace: getWorkspace(wsId) };
    }
    const summary = d.gap ?? d.failed ?? d.text ?? 'No changes.';
    broadcast(wsId, { type: 'compose', state: d.failed ? 'failed' : 'done', summary, receipt });
    return { summary, receipt, gap: !!d.gap };
  } catch (e) {
    addModelCost(wsId, receipt.modelCalls, receipt.costUsd);
    const msg = e instanceof AgentStopped ? e.message : `Composer error: ${(e as Error).message}`;
    activity(wsId, 'error', msg);
    broadcast(wsId, { type: 'compose', state: 'failed', summary: msg, receipt });
    return { summary: msg, receipt };
  } finally {
    running.delete(wsId);
  }
}

const summarize = (w: Workspace) => ({
  title: w.title,
  panels: w.panels.map(p => ({ id: p.id, title: p.title, binding: p.binding, components: p.components, layout: p.layout, refreshSec: p.refreshSec, actions: p.actions })),
  watchers: w.watchers,
});

/** Personal composer: a non-owner reshapes their own view. One model loop, no data-source changes. */
export async function composeView(wsId: string, user: string, prompt: string): Promise<{ summary: string; receipt: Receipt; workspace?: Workspace }> {
  const key = `${wsId}|${user}`;
  if (running.has(key)) throw new Error('Your view is already being changed.');
  running.add(key);
  const receipt = emptyReceipt();
  activity(wsId, 'info', `${user} is customizing their view: “${prompt}”`);
  const w = getWorkspace(wsId)!;
  const mine = effectiveWorkspace(w, user);
  const panels = mine.panels.map(p => ({
    id: p.id, title: p.title, layout: p.layout,
    components: p.components.map(c => { const { recordActions, ...rest } = c as Record<string, unknown>; return rest; }),
    actionFields: (p.actions ?? []).map(a => ({ label: a.label, recordKey: a.recordKey, uses: Object.values(a.args).flatMap(v => ('record' in v ? [v.record] : [])) })),
    sharedDataSample: JSON.stringify(latest(wsId, p.id)?.data ?? null).slice(0, 2500),
  }));
  let proposals = 0;
  try {
    const result: any = await toolLoop({
      wsId, user, label: 'View composer', receipt, maxTurns: 6,
      system: VIEW_COMPOSER_SYSTEM, stablePrefix: CATALOG_GUIDE,
      prompt: `Person: ${user}\nRequest: ${prompt}\n\nTheir view now (hidden: ${JSON.stringify(mine.personal?.hiddenPanels ?? [])}):\n${JSON.stringify(panels)}`,
      tools: [{
        def: {
          name: 'propose_view_ops',
          description: 'Apply personal view ops for this person only. PRISM applies any filter to the live shared data and validates the A2UI view.',
          input_schema: { type: 'object', properties: { summary: { type: 'string' }, ops: { type: 'array', items: { type: 'object' } } }, required: ['summary', 'ops'] },
        },
        run: async input => {
          proposals++;
          try {
            const ws = await applyViewOps(getWorkspace(wsId)!, user, input.ops ?? []);
            return { done: { summary: input.summary, workspace: ws } };
          } catch (e) {
            if (e instanceof ViewInvalid) return proposals >= 3 ? { done: { failed: e.problems.slice(0, 3).join('; ') } } : { error: 'Not applied. Fix:\n- ' + e.problems.join('\n- ') };
            throw e;
          }
        },
      }],
    });
    const d = result?.done ?? {};
    addModelCost(wsId, receipt.modelCalls, receipt.costUsd);
    return { summary: d.summary ?? d.failed ?? d.text ?? 'No changes.', receipt, workspace: d.workspace };
  } finally {
    running.delete(key);
  }
}
