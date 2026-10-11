// PRISM as an MCP server: any agent (Claude Code, Cursor…) can read workspaces, add validated panels,
// and send a person a decision surface. Agents can propose; only people approve.
import { createMcpHandler, McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import type { Decision, Incident, Panel } from '../../shared/types.ts';
import { activity } from './bus.ts';
import { store } from './db.ts';
import { createDecision, validateAction } from './decisions.ts';
import { capabilitiesText, emptyReceipt } from './llm.ts';
import { validatePanel } from './runtime.ts';
import { Invalid, applyOps, canEdit, canView, getWorkspace, listWorkspaces } from './workspaces.ts';

const ok = (data: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }], structuredContent: data as Record<string, unknown> });
const err = (text: string) => ({ content: [{ type: 'text' as const, text }], isError: true });

function build(user: string, agent: string) {
  const server = new McpServer({ name: 'prism', version: '0.1.0' });

  server.registerTool('list_workspaces', { description: 'List PRISM workspaces you can see.', inputSchema: z.object({}), annotations: { readOnlyHint: true } },
    async () => ok({ workspaces: listWorkspaces(user) }));

  server.registerTool('get_workspace', {
    description: 'Panels (with bindings), watchers, open incidents and pending decisions of a workspace.',
    inputSchema: z.object({ workspaceId: z.string() }), annotations: { readOnlyHint: true },
  }, async ({ workspaceId }) => {
    const w = getWorkspace(workspaceId);
    if (!w || !canView(w, user)) return err('workspace not found');
    return ok({
      title: w.title, version: w.version,
      panels: w.panels.map(p => ({ id: p.id, title: p.title, binding: p.binding, components: p.components, layout: p.layout })),
      watchers: w.watchers,
      openIncidents: store.list<Incident>('incident', w.id).filter(i => i.status !== 'resolved'),
      pendingDecisions: store.list<Decision>('decision', w.id).filter(d => d.status === 'pending').map(d => ({ id: d.id, title: d.title })),
    });
  });

  server.registerTool('list_capabilities', {
    description: 'MCP tools PRISM can bind panels to (connection ids, tool names, input schemas) plus the A2UI catalog rules.',
    inputSchema: z.object({}), annotations: { readOnlyHint: true },
  }, async () => ({ content: [{ type: 'text' as const, text: (await import('./prompts.ts')).CATALOG_GUIDE + '\n# Connected capabilities\n' + (await capabilitiesText(user)) }] }));

  server.registerTool('add_panel', {
    description: 'Add a panel to a workspace for the person to see live. PRISM validates it by running the binding and the A2UI view; panels can only bind read tools.',
    inputSchema: z.object({
      workspaceId: z.string(),
      panel: z.object({
        id: z.string().optional(), title: z.string(),
        binding: z.object({ connectionId: z.string(), tool: z.string(), args: z.record(z.string(), z.unknown()).optional(), transform: z.string().optional() }),
        components: z.array(z.record(z.string(), z.unknown())),
        layout: z.object({ x: z.number(), y: z.number(), w: z.number(), h: z.number() }).optional(),
        refreshSec: z.number().optional(),
      }),
    }),
  }, async ({ workspaceId, panel }) => {
    const w = getWorkspace(workspaceId);
    if (!w || !canEdit(w, user)) return err('workspace not found or not yours');
    try {
      const next = await applyOps(w.id, user, undefined, [{ op: 'add_panel', panel: panel as Panel }], agent);
      return ok({ added: next.panels.at(-1)?.id, version: next.version });
    } catch (e) {
      return err(e instanceof Invalid ? 'Not added. Fix:\n- ' + e.problems.join('\n- ') : (e as Error).message);
    }
  });

  server.registerTool('request_decision', {
    description: 'Send the person a decision surface instead of a message: live evidence panels plus one proposed write. It runs only if they approve.',
    inputSchema: z.object({
      workspaceId: z.string(), title: z.string(), summary: z.string(), rationale: z.string().optional(),
      evidencePanels: z.array(z.record(z.string(), z.unknown())).optional(),
      proposedAction: z.object({ connectionId: z.string(), tool: z.string(), args: z.record(z.string(), z.unknown()), label: z.string(), consequences: z.array(z.string()) }),
    }),
  }, async input => {
    const w = getWorkspace(input.workspaceId);
    if (!w || !canEdit(w, user)) return err('workspace not found or not yours');
    const evidence = (Array.isArray(input.evidencePanels) ? input.evidencePanels : []).slice(0, 4).map((p: any, n) => ({ ...p, id: `ag-${Date.now().toString(36)}-${n}`, layout: { x: 0, y: n * 4, w: 12, h: 4 }, refreshSec: 5 })) as Panel[];
    const problems: string[] = [];
    for (const p of evidence) problems.push(...(await validatePanel(p, w.owner)).problems);
    problems.push(...(await validateAction(input.proposedAction, w.owner)));
    if (problems.length) return err('Not sent. Fix:\n- ' + problems.join('\n- '));
    const d = await createDecision({
      workspaceId: w.id, title: input.title, summary: input.summary, rationale: input.rationale ?? `Proposed by ${agent}`,
      evidence, proposedAction: input.proposedAction, source: 'agent', receipt: emptyReceipt(),
    }, w.owner);
    activity(w.id, 'decision', `${agent} sent a decision: ${d.title}`);
    return ok({ decisionId: d.id, status: d.status, dryRun: d.dryRun, link: `/decide/${d.id}` });
  });

  return server;
}

export const prismMcp = createMcpHandler(ctx => {
  const h = ctx.requestInfo?.headers;
  const user = (h?.get('x-prism-user') || 'arnab').toLowerCase();
  const agent = h?.get('x-prism-agent') || 'Claude Code';
  return build(user, agent);
});
