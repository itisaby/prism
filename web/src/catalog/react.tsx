'use client';
// Browser implementations of the PRISM A2UI catalog. Schemas live in apis.ts (shared with the server).
import { createComponentImplementation, type ReactCatalogComponent } from '@a2ui/react/v0_9';
import { Catalog } from '@a2ui/web_core/v0_9';
import { basicCatalog } from '@a2ui/web_core/v0_9/basic_catalog';
import { useState, type ReactNode } from 'react';
import { Bar, BarChart, CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { CardListApi, DataTableApi, MetricRowApi, PRISM_CATALOG_ID, ResearchApi, StatusListApi, TimeSeriesApi } from './apis.ts';

type Rec = Record<string, unknown>;
type Tone = 'ok' | 'warn' | 'bad';
type ActionDef = { id: string; label: string; when?: { key: string; equals: unknown } };
type Dispatch = { dispatchAction: (a: Record<string, unknown>) => Promise<void> };

/** Categorical series order (fixed, never cycled by rank): PRISM spectrum. */
export const SERIES_COLORS = ['#8B6CFF', '#2EE6D6', '#FF4FA3', '#FFB547', '#4F8BFF'];

const asRows = (v: unknown): Rec[] => (Array.isArray(v) ? v.filter((x): x is Rec => !!x && typeof x === 'object' && !Array.isArray(x)) : []);
const text = (v: unknown): string => {
  if (v === null || v === undefined) return '';
  if (typeof v === 'number') return Number.isInteger(v) ? v.toLocaleString() : v.toLocaleString(undefined, { maximumFractionDigits: 2 });
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
};
const toTone = (v: unknown): Tone | undefined => {
  const s = typeof v === 'string' ? v.toLowerCase() : '';
  if (s === 'ok' || s === 'good' || s === 'success' || s === 'healthy') return 'ok';
  if (s === 'warn' || s === 'warning' || s === 'degraded') return 'warn';
  if (s === 'bad' || s === 'error' || s === 'danger' || s === 'critical' || s === 'failing') return 'bad';
  return undefined;
};
/** A2UI's prop typing may hand array items back as child refs ({id}); normalise to plain values. */
function plainList<T>(v: unknown): T[] {
  if (!Array.isArray(v)) return [];
  return v.map(item => (item && typeof item === 'object' && 'value' in (item as Rec) && Object.keys(item as Rec).length === 1 ? (item as Rec).value : item) as T);
}

function Heading({ children }: { children?: ReactNode }) {
  return children ? <div className="pc-title">{children}</div> : null;
}

function ToneDot({ tone }: { tone?: Tone }) {
  return <span className={`pc-dot ${tone ? `t-${tone}` : ''}`} aria-hidden />;
}

/** Record buttons: two inline at most, the rest in a "More" menu. Clicking dispatches an A2UI action event. */
function RecordActions({ actions, record, context }: { actions: ActionDef[]; record: Rec; context: Dispatch }) {
  const [busy, setBusy] = useState<string | null>(null);
  const shown = actions.filter(a => !a.when || record[a.when.key] === a.when.equals);
  if (!shown.length) return null;
  const run = async (actionId: string) => {
    setBusy(actionId);
    try {
      await context.dispatchAction({ event: { name: 'record-action', context: { actionId, record } } });
    } finally {
      setTimeout(() => setBusy(null), 600);
    }
  };
  const inline = shown.slice(0, 2);
  const rest = shown.slice(2);
  return (
    <div className="pc-actions" onClick={e => e.stopPropagation()}>
      {inline.map(a => (
        <button key={a.id} type="button" className="pc-action" disabled={busy !== null} onClick={() => run(a.id)}>
          {busy === a.id ? 'Preparing…' : a.label}
        </button>
      ))}
      {rest.length > 0 && (
        <select
          className="pc-action pc-more"
          aria-label="More actions"
          value=""
          onChange={e => {
            const id = e.target.value;
            if (id) void run(id);
          }}
        >
          <option value="">More…</option>
          {rest.map(a => (
            <option key={a.id} value={a.id}>
              {a.label}
            </option>
          ))}
        </select>
      )}
    </div>
  );
}

const MetricRow = createComponentImplementation(MetricRowApi, ({ props }) => (
  <div className="pc-metrics">
    {asRows(props.items).map((m, i) => {
      const tone = toTone(m.tone);
      return (
        <div key={i} className={`pc-metric ${tone ? `t-${tone}` : ''}`}>
          <div className="pc-metric-label">{text(m.label)}</div>
          <div className="pc-metric-value">{text(m.value)}</div>
          {m.hint !== undefined && m.hint !== null && <div className="pc-metric-hint">{text(m.hint)}</div>}
        </div>
      );
    })}
  </div>
));

function ChartTooltip({ active, payload, label }: { active?: boolean; payload?: ReadonlyArray<{ name?: unknown; value?: unknown; color?: string }>; label?: unknown }) {
  if (!active || !payload?.length) return null;
  return (
    <div className="pc-tip">
      <div className="pc-tip-x">{text(label)}</div>
      {payload.map((p, i) => (
        <div key={i} className="pc-tip-row">
          <span className="pc-swatch" style={{ background: p.color }} />
          <span>{text(p.name)}</span>
          <b>{text(p.value)}</b>
        </div>
      ))}
    </div>
  );
}

const TimeSeries = createComponentImplementation(TimeSeriesApi, ({ props }) => {
  const data = asRows(props.data);
  const series = plainList<{ key: string; label?: string }>(props.series).filter(s => s && typeof s.key === 'string');
  const axis = { fontSize: 11, fill: '#7D7D7D', fontFamily: 'var(--font-mono)' };
  const isLine = props.kind === 'line';
  return (
    <div className="pc-block pc-chart">
      <div className="pc-chart-head">
        <Heading>{props.title}</Heading>
        {series.length > 1 && (
          <div className="pc-legend">
            {series.map((s, i) => (
              <span key={s.key}>
                <i style={{ background: SERIES_COLORS[i % SERIES_COLORS.length] }} />
                {s.label ?? s.key}
              </span>
            ))}
          </div>
        )}
      </div>
      <div className="pc-chart-body">
        {data.length === 0 ? (
          <div className="pc-empty">No data yet</div>
        ) : (
          <ResponsiveContainer width="100%" height="100%" minHeight={120}>
            {isLine ? (
              <LineChart data={data} margin={{ top: 6, right: 8, left: -14, bottom: 0 }}>
                <CartesianGrid stroke="rgba(255,255,255,0.06)" vertical={false} />
                <XAxis dataKey={props.x} tick={axis} tickLine={false} axisLine={false} minTickGap={24} />
                <YAxis tick={axis} tickLine={false} axisLine={false} width={44} />
                <Tooltip content={<ChartTooltip />} cursor={{ stroke: 'rgba(255,255,255,0.18)' }} />
                {series.map((s, i) => (
                  <Line key={s.key} type="monotone" dataKey={s.key} name={s.label ?? s.key} stroke={SERIES_COLORS[i % SERIES_COLORS.length]}
                    strokeWidth={2} dot={false} activeDot={{ r: 4, strokeWidth: 2, stroke: '#000' }} isAnimationActive={false} />
                ))}
              </LineChart>
            ) : (
              <BarChart data={data} margin={{ top: 6, right: 8, left: -14, bottom: 0 }} barCategoryGap="28%">
                <CartesianGrid stroke="rgba(255,255,255,0.06)" vertical={false} />
                <XAxis dataKey={props.x} tick={axis} tickLine={false} axisLine={false} minTickGap={12} />
                <YAxis tick={axis} tickLine={false} axisLine={false} width={44} />
                <Tooltip content={<ChartTooltip />} cursor={{ fill: 'rgba(255,255,255,0.04)' }} />
                {series.map((s, i) => (
                  <Bar key={s.key} dataKey={s.key} name={s.label ?? s.key} fill={SERIES_COLORS[i % SERIES_COLORS.length]}
                    radius={props.kind === 'stacked-bar' && i < series.length - 1 ? 0 : [4, 4, 0, 0]}
                    stackId={props.kind === 'stacked-bar' ? 'stack' : undefined} isAnimationActive={false}
                    stroke="#0A0A0A" strokeWidth={props.kind === 'stacked-bar' ? 1 : 0} />
                ))}
              </BarChart>
            )}
          </ResponsiveContainer>
        )}
      </div>
    </div>
  );
});

const DataTable = createComponentImplementation(DataTableApi, ({ props, context }) => {
  const rows = asRows(props.rows);
  const columns = plainList<{ key: string; label: string }>(props.columns);
  const actions = plainList<ActionDef>(props.recordActions);
  return (
    <div className="pc-block">
      <Heading>{props.title}</Heading>
      <div className="pc-table-wrap">
        <table className="pc-table">
          <thead>
            <tr>
              {columns.map(c => (
                <th key={c.key}>{c.label}</th>
              ))}
              {actions.length > 0 && <th aria-label="Actions" />}
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 && (
              <tr>
                <td colSpan={columns.length + (actions.length ? 1 : 0)} className="pc-empty-cell">
                  Nothing to show — all clear
                </td>
              </tr>
            )}
            {rows.map((r, i) => {
              const tone = props.toneKey ? toTone(r[props.toneKey]) : undefined;
              return (
                <tr key={i} className={tone ? `t-${tone}` : undefined}>
                  {columns.map((c, ci) => (
                    <td key={c.key}>
                      {ci === 0 && props.toneKey ? <ToneDot tone={tone} /> : null}
                      {text(r[c.key])}
                    </td>
                  ))}
                  {actions.length > 0 && (
                    <td className="pc-td-actions">
                      <RecordActions actions={actions} record={r} context={context} />
                    </td>
                  )}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
});

const CardList = createComponentImplementation(CardListApi, ({ props, context }) => {
  const actions = plainList<ActionDef>(props.recordActions);
  const items = asRows(props.items);
  return (
    <div className="pc-block">
      <Heading>{props.title}</Heading>
      <div className="pc-cards">
        {items.length === 0 && <div className="pc-empty">Nothing to show</div>}
        {items.map((r, i) => {
          const tone = props.toneKey ? toTone(r[props.toneKey]) : undefined;
          return (
            <div key={i} className={`pc-card ${tone ? `t-${tone}` : ''}`}>
              <div className="pc-card-top">
                {props.toneKey && <ToneDot tone={tone} />}
                <span className="pc-card-title">{text(r[props.titleKey])}</span>
                {props.badgeKey && r[props.badgeKey] !== undefined && <span className={`pc-badge ${tone ? `t-${tone}` : ''}`}>{text(r[props.badgeKey])}</span>}
              </div>
              {props.subtitleKey && <div className="pc-card-sub">{text(r[props.subtitleKey])}</div>}
              {actions.length > 0 && <RecordActions actions={actions} record={r} context={context} />}
            </div>
          );
        })}
      </div>
    </div>
  );
});

const StatusList = createComponentImplementation(StatusListApi, ({ props, context }) => {
  const actions = plainList<ActionDef>(props.recordActions);
  const items = asRows(props.items);
  return (
    <div className="pc-block">
      <Heading>{props.title}</Heading>
      <div className="pc-status">
        {items.length === 0 && <div className="pc-empty">Nothing to show</div>}
        {items.map((r, i) => {
          const tone = toTone(r.tone) ?? toTone(r.status);
          return (
            <div key={i} className={`pc-status-row ${tone ? `t-${tone}` : ''}`}>
              <ToneDot tone={tone} />
              <div className="pc-status-main">
                <span className="pc-status-name">{text(r.name)}</span>
                {r.detail !== undefined && r.detail !== null && <span className="pc-status-detail">{text(r.detail)}</span>}
              </div>
              <span className={`pc-badge ${tone ? `t-${tone}` : ''}`}>{text(r.status)}</span>
              {actions.length > 0 && <RecordActions actions={actions} record={r} context={context} />}
            </div>
          );
        })}
      </div>
    </div>
  );
});

// ---------------------------------------------------------------- Research (Nimble Web Search Agent run, tracked by PRISM)
type Src = { title?: string; url?: string; type?: string };

// Tiny markdown: headings (#, ##, ###), bullet and numbered lists, paragraphs, bold, inline code, and [n] citations linked to sources.
function inline(t: string, sources: Src[], key: string): ReactNode[] {
  return t.split(/(\*\*[^*]+\*\*|`[^`]+`|\[\d+\])/g).filter(Boolean).map((part, i) => {
    const k = `${key}-${i}`;
    if (part.startsWith('**')) return <b key={k}>{part.slice(2, -2)}</b>;
    if (part.startsWith('`')) return <code key={k}>{part.slice(1, -1)}</code>;
    const m = part.match(/^\[(\d+)\]$/);
    if (m) { const s = sources[Number(m[1]) - 1]; return s?.url ? <a key={k} className="rs-cite" href={s.url} target="_blank" rel="noreferrer">{m[1]}</a> : <sup key={k}>{m[1]}</sup>; }
    return <span key={k}>{part}</span>;
  });
}
function Markdown({ text: md, sources }: { text: string; sources: Src[] }) {
  const out: ReactNode[] = [];
  let list: { ordered: boolean; items: string[] } | null = null;
  const flush = () => { if (list) { const L = list.ordered ? 'ol' : 'ul'; out.push(<L key={`l${out.length}`}>{list.items.map((it, i) => <li key={i}>{inline(it, sources, `li${out.length}-${i}`)}</li>)}</L>); list = null; } };
  md.split('\n').forEach((raw, n) => {
    const line = raw.trimEnd();
    const h = line.match(/^(#{1,3})\s+(.*)$/);
    const li = line.match(/^\s*(?:[-*]|(\d+)\.)\s+(.*)$/);
    if (h) { flush(); const H = (['h3', 'h4', 'h5'] as const)[h[1].length - 1]; out.push(<H key={n}>{inline(h[2], sources, `h${n}`)}</H>); }
    else if (li) { const ordered = !!li[1]; if (!list || list.ordered !== ordered) { flush(); list = { ordered, items: [] }; } list.items.push(li[2]); }
    else if (!line.trim()) flush();
    else { flush(); out.push(<p key={n}>{inline(line, sources, `p${n}`)}</p>); }
  });
  flush();
  return <div className="rs-md">{out}</div>;
}

const Research = createComponentImplementation(ResearchApi, ({ props }) => {
  const d = (props.data && typeof props.data === 'object' ? props.data : {}) as Rec;
  const status = text(d.status) || 'queued';
  const counts = (d.counts ?? {}) as Rec;
  const sources = asRows(d.sources) as Src[];
  const [showAll, setShowAll] = useState(false);
  const done = status === 'completed';
  return (
    <div className="pc-block rs">
      <Heading>{props.title}</Heading>
      <div className="rs-head">
        <span className={`pc-badge ${done ? 't-ok' : status === 'failed' ? 't-bad' : 't-warn'}`}>{done ? 'Researched' : status === 'failed' ? 'Failed' : status === 'running' ? 'Researching…' : 'Queued'}</span>
        <span className="rs-q">{text(d.question)}</span>
      </div>
      <div className="rs-meta mono">
        <span>Nimble Web Search Agent</span><span>effort {text(d.effort)}</span><span>{text(d.elapsedSec)} s</span>
        {d.requestedBy ? <span>started by {text(d.requestedBy)}</span> : null}
      </div>
      {!done && status !== 'failed' && <div className="rs-progress"><span className="spinner" />The agent is searching, reading and cross-checking sources. This panel updates by itself, with no model calls.</div>}
      {status === 'failed' && <div className="pc-empty">{text(d.error)}</div>}
      {done && (
        <>
          <div className="rs-stats">
            <div><b>{text(counts.claims)}</b><span>claims</span></div>
            <div><b>{text(counts.sources)}</b><span>sources</span></div>
            <div><b>{text(counts.primary)}</b><span>primary</span></div>
            <div><b>{text(counts.secondary)}</b><span>secondary</span></div>
            <div><b className={`rs-conf c-${text(d.confidence)}`}>{text(d.confidence) || 'n/a'}</b><span>confidence</span></div>
          </div>
          <Markdown text={text(d.report)} sources={sources} />
          <div className="rs-sources">
            <div className="rs-sources-h">Sources</div>
            {(showAll ? sources : sources.slice(0, 6)).map((s, i) => (
              <a key={i} href={s.url} target="_blank" rel="noreferrer" className="rs-src">
                <span className="rs-n mono">{i + 1}</span><span className="ellipsis">{s.title ?? s.url}</span>
                <span className={`pc-badge ${s.type === 'primary' ? 't-ok' : ''}`}>{s.type}</span>
              </a>
            ))}
            {sources.length > 6 && <button className="rs-more" onClick={() => setShowAll(v => !v)}>{showAll ? 'Show fewer' : `Show all ${sources.length}`}</button>}
          </div>
        </>
      )}
    </div>
  );
});

export const PRISM_REACT_COMPONENTS: ReactCatalogComponent[] = [MetricRow, TimeSeries, DataTable, CardList, StatusList, Research];

/** Browser catalog: A2UI basic components (web components) + PRISM React components. */
export function browserCatalog(): Catalog<ReactCatalogComponent> {
  const basics = Array.from(basicCatalog.components.values()) as unknown as ReactCatalogComponent[];
  const functions = Array.from(basicCatalog.functions.values());
  return new Catalog<ReactCatalogComponent>(PRISM_CATALOG_ID, 'v0.9', [...basics, ...PRISM_REACT_COMPONENTS], functions);
}
