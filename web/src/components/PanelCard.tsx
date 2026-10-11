'use client';
import dynamic from 'next/dynamic';
import { Icon } from './Icon.tsx';
import type { Panel } from '../lib/types.ts';
import type { PanelDatum } from '../lib/useWorkspaceSocket.ts';
import { timeAgo } from '../lib/format.ts';
import { connectionIcon } from '../lib/connections.ts';

// The A2UI renderer registers custom elements, so it only runs in the browser.
const PanelSurface = dynamic(() => import('./PanelSurface.tsx'), { ssr: false, loading: () => <div className="skeleton" /> });


export function PanelCard({
  panel, datum, sourceName, firing, now, onRecordAction, draggable, compact,
}: {
  panel: Panel;
  datum?: PanelDatum;
  sourceName: string;
  firing?: string;
  now: number;
  onRecordAction?: (panelId: string, actionId: string, record: Record<string, unknown>) => void;
  draggable?: boolean;
  compact?: boolean;
}) {
  const state = !datum ? 'loading' : datum.error ? (datum.data !== undefined ? 'stale' : 'error') : 'ok';
  const fresh = state === 'loading' ? 'Loading…' : state === 'error' ? "Couldn't load" : state === 'stale' ? `Last updated ${timeAgo(datum?.at, now)}` : `Updated ${timeAgo(datum?.at, now)}`;
  return (
    <section className={`panel ${firing ? 'is-firing' : ''} ${state === 'stale' ? 'is-stale' : ''} ${state === 'error' ? 'is-error' : ''} ${compact ? 'is-compact' : ''}`}>
      {panel.addedBy && (
        <div className="agent-strip">
          <Icon name="zap" size={13} />
          <span>Added by {panel.addedBy}</span>
        </div>
      )}
      <header className={`panel-head ${draggable ? 'drag-handle' : ''}`}>
        {draggable && <span className="grip"><Icon name="grip" size={14} /></span>}
        <h3>{panel.title}</h3>
        {firing && <span className="firing-pill"><span className="pulse" />{firing}</span>}
        <span className="spacer" />
        <span className={`source s-${state}`}>
          <Icon name={connectionIcon(panel.binding.connectionId, sourceName)} size={12} />
          {sourceName} · {fresh}
          {state === 'stale' && <Icon name="clock" size={12} />}
          {state === 'error' && <Icon name="circle-alert" size={12} />}
        </span>
      </header>
      {state === 'stale' && <div className="stale-banner"><Icon name="clock" size={13} />Couldn&apos;t refresh: {datum?.error}. Showing the last data.</div>}
      <div className="panel-body">
        {state === 'error' ? (
          <div className="panel-problem"><Icon name="circle-alert" size={18} /><b>Couldn&apos;t load this panel</b><span>{datum?.error}</span></div>
        ) : (
          <PanelSurface
            surfaceId={panel.id}
            components={panel.components}
            recordActions={panel.actions?.map(a => ({ id: a.id, label: a.label, when: a.when }))}
            data={datum?.data}
            onRecordAction={onRecordAction ? (actionId, record) => onRecordAction(panel.id, actionId, record) : undefined}
          />
        )}
      </div>
    </section>
  );
}
