import React, { useState } from 'react';
import type { S2ChartView } from '../../types/sceneS2';
import type { S2Json } from '../../types/sceneS2Plugin';
import type { S2Table } from '../../services/scene/sceneS2Structured';
import { s2TableToRecords } from '../../services/scene/sceneS2Structured';
import { s2ChartRecordPoints } from '../../services/scene/sceneS2DataViews';
import { S2ChartPreview } from './S2ChartPreview';
import type { S2ArtifactViewSelection } from '../../services/scene/sceneS2Events';

/** Presentation state only. It never edits, re-reads or re-runs the source artifact. */
export function S2ArtifactChart({ table, onViewChange }: { table: S2Table; onViewChange?: (view: S2ArtifactViewSelection) => void }) {
  const rows = s2TableToRecords(table) as Array<Record<string, S2Json>>;
  const numeric = table.columns.filter(key => rows.some(row => Object.hasOwn(row, key) && typeof row[key] === 'number')
    && rows.every(row => !Object.hasOwn(row, key) || row[key] === null || typeof row[key] === 'number'));
  const [kind, setKind] = useState<'none' | S2ChartView['kind']>('none');
  const [xKey, setX] = useState(table.columns[0] ?? ''), [yKey, setY] = useState(numeric[0] ?? '');
  if (!numeric.length) return <p>没有可作纵轴的数值列，保留原始表格。</p>;
  const selectedX = table.columns.includes(xKey) ? xKey : table.columns[0], selectedY = numeric.includes(yKey) ? yKey : numeric[0];
  const view: S2ChartView = { kind: kind === 'none' ? 'bar' : kind, xKey: selectedX, yKey: selectedY };
  const choose = (next: S2ArtifactViewSelection) => {
    if (!['none', 'bar', 'line'].includes(next.kind) || !table.columns.includes(next.xKey) || !numeric.includes(next.yKey)) return;
    setKind(next.kind); setX(next.xKey); setY(next.yKey); onViewChange?.(next);
  };
  return <details className="nodrag nowheel"><summary>本地图表预览</summary>
    <label>图表类型<select aria-label="产物图表类型" value={kind} onChange={event => choose({ kind: event.target.value as typeof kind, xKey: selectedX, yKey: selectedY })}>
      <option value="none">仅表格</option><option value="bar">柱状图</option><option value="line">折线图</option></select></label>
    <label>横轴列<select aria-label="产物横轴列" value={selectedX} onChange={event => choose({ kind, xKey: event.target.value, yKey: selectedY })}>{table.columns.map(key => <option key={key}>{key}</option>)}</select></label>
    <label>纵轴列<select aria-label="产物纵轴列" value={selectedY} onChange={event => choose({ kind, xKey: selectedX, yKey: event.target.value })}>{numeric.map(key => <option key={key}>{key}</option>)}</select></label>
    {kind !== 'none' && <S2ChartPreview chart={s2ChartRecordPoints(rows, view)} view={view} label="宿主表格产物" />}
    <small>只改变显示，不产生新产物、评分或插件调用。</small>
  </details>;
}
