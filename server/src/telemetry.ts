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

// ---------------------------------------------------------------- logs + metrics (Sentry Logs / Metrics)
type Attrs = Record<string, string | number | boolean>;

/** Every Inspector activity line also goes to Sentry Logs (refresh chatter excluded by the caller). */
export function log(level: 'info' | 'warn' | 'error', message: string, attributes: Attrs = {}) {
  if (!on()) return;
  Sentry.logger[level](message, attributes);
}

export const metric = {
  count(name: string, value = 1, attributes: Attrs = {}) { if (on()) Sentry.metrics.count(name, value, { attributes }); },
  distribution(name: string, value: number, unit: 'millisecond' | 'none' = 'none', attributes: Attrs = {}) {
    if (on()) Sentry.metrics.distribution(name, value, { unit, attributes } as any);
  },
};
