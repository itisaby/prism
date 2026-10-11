// PRISM A2UI catalog — component APIs only (zod schemas, no React).
// Shared by the browser renderer (react.tsx) and the server's headless validator (validate.ts),
// so the agent can only emit components that both sides understand.
import { z } from 'zod';
import { Catalog, CommonSchemas, type ComponentApi } from '@a2ui/web_core/v0_9';
import { BASIC_COMPONENTS } from '@a2ui/web_core/v0_9/basic_catalog';

export const PRISM_CATALOG_ID = 'https://prism.dev/catalogs/prism/v0.1.json';

const weight = z.number().optional().describe('Flex weight when placed inside a Row or Column');
const title = CommonSchemas.DynamicString.optional().describe('Heading shown above the component');
const tone = z.enum(['ok', 'warn', 'bad']);

/** Injected by PRISM from `panel.actions`; the agent never writes this prop. */
const recordActions = z
  .array(
    z
      .object({
        id: z.string(),
        label: z.string(),
        when: z.object({ key: z.string(), equals: z.union([z.string(), z.number(), z.boolean()]) }).strict().optional(),
      })
      .strict(),
  )
  .optional()
  .describe('Per-record buttons. Injected by PRISM; do not write.');

export const MetricRowApi = {
  name: 'MetricRow',
  schema: z
    .object({
      items: CommonSchemas.DynamicValue.describe('Array of {label, value, hint?, tone?: "ok"|"warn"|"bad"}, usually {"path":"/metrics"}'),
      weight,
    })
    .strict(),
} satisfies ComponentApi;

export const TimeSeriesApi = {
  name: 'TimeSeries',
  schema: z
    .object({
      title,
      data: CommonSchemas.DynamicValue.describe('Array of row objects, usually {"path":"/rows"}'),
      x: z.string().describe('Row key for the x axis'),
      series: z
        .array(z.object({ key: z.string(), label: z.string().optional() }).strict())
        .min(1)
        .describe('Numeric row keys to plot'),
      kind: z.enum(['line', 'bar', 'stacked-bar']).optional(),
      weight,
    })
    .strict(),
} satisfies ComponentApi;

export const DataTableApi = {
  name: 'DataTable',
  schema: z
    .object({
      title,
      rows: CommonSchemas.DynamicValue.describe('Array of row objects'),
      columns: z.array(z.object({ key: z.string(), label: z.string() }).strict()).min(1),
      toneKey: z.string().optional().describe('Row field holding "ok" | "warn" | "bad"'),
      recordActions,
      weight,
    })
    .strict(),
} satisfies ComponentApi;

export const CardListApi = {
  name: 'CardList',
  schema: z
    .object({
      title,
      items: CommonSchemas.DynamicValue.describe('Array of objects'),
      titleKey: z.string(),
      subtitleKey: z.string().optional(),
      badgeKey: z.string().optional(),
      toneKey: z.string().optional(),
      recordActions,
      weight,
    })
    .strict(),
} satisfies ComponentApi;

export const StatusListApi = {
  name: 'StatusList',
  schema: z
    .object({
      title,
      items: CommonSchemas.DynamicValue.describe('Array of {name, status, detail?, tone?: "ok"|"warn"|"bad"}'),
      recordActions,
      weight,
    })
    .strict(),
} satisfies ComponentApi;

export const ResearchApi = {
  name: 'Research',
  schema: z
    .object({
      title,
      data: CommonSchemas.DynamicValue.describe('A research_report object, usually {"path":"/"}: status, question, effort, elapsedSec, confidence, report (markdown), claims, sources, counts'),
      weight,
    })
    .strict(),
} satisfies ComponentApi;

export const TONES = tone.options;
export const PRISM_APIS: ComponentApi[] = [MetricRowApi, TimeSeriesApi, DataTableApi, CardListApi, StatusListApi, ResearchApi];
export const PRISM_COMPONENT_NAMES = PRISM_APIS.map(a => a.name);

/** Schema-only catalog (A2UI basic components + PRISM components) for headless validation and prompts. */
export function prismApiCatalog(): Catalog<ComponentApi> {
  return new Catalog<ComponentApi>(PRISM_CATALOG_ID, 'v0.9', [...BASIC_COMPONENTS, ...PRISM_APIS]);
}
