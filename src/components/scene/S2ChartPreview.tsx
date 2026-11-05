import React from 'react';
import type { S2ChartView } from '../../types/sceneS2';
import type { s2ChartRecordPoints } from '../../services/scene/sceneS2DataViews';

export function S2ChartPreview({ chart, view, label }: { chart: ReturnType<typeof s2ChartRecordPoints>; view: S2ChartView; label: string }) {
  const segments: string[][] = []; let segment: string[] = [];
  for (const point of chart.points) {
    if (point.y === null) { if (segment.length) segments.push(segment); segment = []; } else segment.push(`${point.x},${point.y}`);
  }
  if (segment.length) segments.push(segment);
  return <figure className="s2-chart"><figcaption>{label} · {view.kind === 'bar' ? '柱状图' : '折线图'}</figcaption>
    <svg viewBox="0 0 400 190" role="img" aria-label={`${label}，横轴 ${view.xKey}（行顺序等距），纵轴 ${view.yKey}`}>
      <line x1="24" x2="376" y1={chart.baseline} y2={chart.baseline} stroke="currentColor" />
      {view.kind === 'line' && segments.map((points, i) => <polyline key={i} points={points.join(' ')} fill="none" stroke="currentColor" strokeWidth="2" />)}
      {chart.points.map((point, i) => <g key={i}><title>{`${point.label}：${point.value === undefined ? '缺失' : JSON.stringify(point.value)}`}</title>
        {point.y !== null && (view.kind === 'bar' ? <rect x={point.x - 100 / Math.max(1, chart.points.length)} y={Math.min(point.y, chart.baseline)}
          width={200 / Math.max(1, chart.points.length)} height={Math.abs(point.y - chart.baseline)} fill="currentColor" opacity="0.75" />
          : <circle cx={point.x} cy={point.y} r="3" fill="currentColor" />)}
        {(i === 0 || i === chart.points.length - 1 || chart.points.length <= 6) && <text x={point.x} y="177" textAnchor="middle" fontSize="9">{point.label.slice(0, 12)}</text>}
      </g>)}
    </svg><small>横轴按行顺序等距排列；缺失或 null 保留断点。图表使用全部 {chart.points.length} 行，完整数值见数据。</small></figure>;
}
