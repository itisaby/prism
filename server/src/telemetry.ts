// Thin Sentry helpers. Every call is a no-op passthrough when SENTRY_DSN isn't set.
import * as Sentry from '@sentry/node';

const on = () => !!process.env.SENTRY_DSN;

export function span<T>(op: string, name: string, attributes: Record<string, string | number | boolean>, fn: () => Promise<T>): Promise<T> {
  if (!on()) return fn();
  return Sentry.startSpan({ op, name, attributes }, fn);
}

/** An agent run (composer / investigator). The Anthropic integration nests its chat spans under it. */
export const agentSpan = <T>(agent: string, model: string, wsId: string, fn: () => Promise<T>) =>
  span('gen_ai.invoke_agent', `invoke_agent ${agent}`, {
    'gen_ai.operation.name': 'invoke_agent', 'gen_ai.agent.name': agent, 'gen_ai.request.model': model, 'prism.workspace': wsId,
  }, fn);

/** An MCP tool call made on behalf of an agent or an approved decision. */
export const toolSpan = <T>(tool: string, connection: string, fn: () => Promise<T>) =>
  span('gen_ai.execute_tool', `execute_tool ${tool}`, { 'gen_ai.operation.name': 'execute_tool', 'gen_ai.tool.name': tool, 'mcp.server': connection }, fn);

export function capture(e: unknown, context?: Record<string, unknown>) {
  if (on()) Sentry.captureException(e, context ? { extra: context } : undefined);
}
