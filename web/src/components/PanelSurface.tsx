'use client';
// Renders one panel's A2UI surface. Structure (createSurface + updateComponents) is applied once per
// component change; every new data snapshot is only an updateDataModel. Client-only (load via next/dynamic).
import { A2uiSurface, type ReactCatalogComponent } from '@a2ui/react/v0_9';
import { MessageProcessor, type SurfaceModel } from '@a2ui/web_core/v0_9';
import { injectBasicCatalogStyles } from '@a2ui/web_core/v0_9/basic_catalog';
import { useEffect, useMemo, useRef, useState } from 'react';
import { browserCatalog } from '../catalog/react.tsx';
import { surfaceMessages } from '../catalog/validate.ts';

let stylesInjected = false;

export interface PanelSurfaceProps {
  surfaceId: string;
  components: Record<string, unknown>[];
  /** Injected into components that support record actions (from panel.actions). */
  recordActions?: { id: string; label: string; when?: { key: string; equals: string | number | boolean } }[];
  data: unknown;
  onRecordAction?: (actionId: string, record: Record<string, unknown>) => void;
}

const ACTIONABLE = new Set(['DataTable', 'CardList', 'StatusList']);

export default function PanelSurface({ surfaceId, components, recordActions, data, onRecordAction }: PanelSurfaceProps) {
  const onActionRef = useRef(onRecordAction);
  onActionRef.current = onRecordAction;
  const [surface, setSurface] = useState<SurfaceModel<ReactCatalogComponent>>();
  const [problem, setProblem] = useState<string>();

  // PRISM injects recordActions from panel.actions (the agent never writes them).
  const finalComponents = useMemo(() => {
    if (!recordActions?.length) return components;
    return components.map(c =>
      ACTIONABLE.has(String(c.component)) && !c.recordActions ? { ...c, recordActions: recordActions.map(({ id, label, when }) => (when ? { id, label, when } : { id, label })) } : c,
    );
  }, [components, recordActions]);
  const structureKey = useMemo(() => JSON.stringify(finalComponents), [finalComponents]);

  const dataRef = useRef(data);
  dataRef.current = data;
  const processorRef = useRef<MessageProcessor<ReactCatalogComponent> | null>(null);

  // A fresh processor per structure; created inside the effect so StrictMode's double-run stays clean.
  useEffect(() => {
    if (!stylesInjected) {
      try { injectBasicCatalogStyles(); } catch { /* styles optional */ }
      stylesInjected = true;
    }
    const processor = new MessageProcessor<ReactCatalogComponent>([browserCatalog()], action => {
      if (action.name !== 'record-action') return;
      const ctx = (action.context ?? {}) as { actionId?: string; record?: Record<string, unknown> };
      if (ctx.actionId) onActionRef.current?.(ctx.actionId, ctx.record ?? {});
    });
    processorRef.current = processor;
    setSurface(undefined);
    setProblem(undefined);
    const sub = processor.onSurfaceCreated(s => setSurface(s));
    try {
      processor.processMessages(surfaceMessages(surfaceId, JSON.parse(structureKey), dataRef.current ?? {}) as never);
    } catch (e) {
      setProblem((e as Error).message);
    }
    return () => {
      sub.unsubscribe();
      if (processorRef.current === processor) processorRef.current = null;
      try { processor.dispose(); } catch { /* noop */ }
    };
  }, [surfaceId, structureKey]);

  // Every new data snapshot: just the data model.
  useEffect(() => {
    const processor = processorRef.current;
    if (!processor || data === undefined) return;
    try {
      processor.processMessages([{ version: 'v0.9', updateDataModel: { surfaceId, path: '/', value: data } }] as never);
    } catch (e) {
      setProblem((e as Error).message);
    }
  }, [data, surfaceId]);

  if (problem) return <div className="panel-problem"><b>This view couldn&apos;t render.</b> <span>{problem}</span></div>;
  if (!surface) return <div className="skeleton" />;
  return <A2uiSurface surface={surface} />;
}
