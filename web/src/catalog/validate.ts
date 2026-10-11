// Headless A2UI surface validation (framework-free). The PRISM server imports this file directly
// (tsx, relative path) to check agent-authored panels before saving them.
import { MessageProcessor, STRICT_VALIDATION } from '@a2ui/web_core/v0_9';
import { PRISM_CATALOG_ID, prismApiCatalog } from './apis.ts';

type Msg = Record<string, unknown>;

/** The A2UI v0.9 messages that build one panel surface (optionally with its data model). */
export function surfaceMessages(surfaceId: string, components: unknown[], data?: unknown): Msg[] {
  const out: Msg[] = [
    { version: 'v0.9', createSurface: { surfaceId, catalogId: PRISM_CATALOG_ID } },
    { version: 'v0.9', updateComponents: { surfaceId, components } },
  ];
  if (data !== undefined) out.push({ version: 'v0.9', updateDataModel: { surfaceId, path: '/', value: data } });
  return out;
}

/** Returns human-readable problems (suitable as model feedback). Empty array = valid. */
export function validateSurface(components: unknown[], data: unknown): string[] {
  if (!Array.isArray(components) || components.length === 0) return ['components must be a non-empty array of A2UI components'];
  const problems: string[] = [];
  const ids = components.map(c => (c && typeof c === 'object' ? (c as Msg).id : undefined));
  if (!ids.includes('root')) problems.push('exactly one component must have id "root"');

  const processor = new MessageProcessor([prismApiCatalog()], undefined, { validationConfig: STRICT_VALIDATION });
  try {
    processor.processMessages(surfaceMessages('validate', components, data) as never);
  } catch (err) {
    const e = err as { name?: string; constructor?: { name?: string }; message?: string };
    problems.push(`${e?.constructor?.name ?? e?.name ?? 'Error'}: ${e?.message ?? String(err)}`);
  } finally {
    try { processor.dispose(); } catch { /* ignore */ }
  }

  const keys = data && typeof data === 'object' && !Array.isArray(data) ? Object.keys(data as object) : [];
  for (const pointer of collectAbsoluteBindings(components)) {
    if (resolvePointer(data, pointer) === undefined) {
      problems.push(
        `binding {"path":"${pointer}"} resolves to nothing; the data model's top-level keys are: ${keys.length ? keys.join(', ') : '(none)'}`,
      );
    }
  }
  return problems;
}

/** Every `{ "path": "/..." }` data binding (absolute JSON pointer) anywhere in the component tree. */
function collectAbsoluteBindings(node: unknown, found = new Set<string>()): Set<string> {
  if (Array.isArray(node)) {
    for (const n of node) collectAbsoluteBindings(n, found);
  } else if (node && typeof node === 'object') {
    const obj = node as Msg;
    const keys = Object.keys(obj);
    if (keys.length === 1 && keys[0] === 'path' && typeof obj.path === 'string' && obj.path.startsWith('/')) found.add(obj.path);
    else for (const v of Object.values(obj)) collectAbsoluteBindings(v, found);
  }
  return found;
}

function resolvePointer(data: unknown, pointer: string): unknown {
  if (pointer === '/' || pointer === '') return data;
  let cur: unknown = data;
  for (const raw of pointer.slice(1).split('/')) {
    const key = raw.replace(/~1/g, '/').replace(/~0/g, '~');
    if (cur === null || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[key];
  }
  return cur;
}
