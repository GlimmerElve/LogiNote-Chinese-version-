import React, { useId, useMemo } from 'react';
import { parseScienceDiagram, type ScienceElement } from '../../services/textbook/scienceDiagram';
import type { TextbookManifest } from '../../services/textbook/types';
import { SourceReference, type SourceReferenceProps } from './SourceReference';
import { TextbookFormatFallback } from './CodeBlock';

const inks = ['default', 'accent', 'warm', 'cool'] as const;
function SymbolShape({ symbol }: { symbol: Extract<ScienceElement, { kind: 'symbol' }>['symbol'] }) {
  if (symbol === 'resistor') return <><path d="M-32 0 H-20 M20 0 H32" /><rect x="-20" y="-9" width="40" height="18" /></>;
  if (symbol === 'battery') return <><path d="M-32 0 H-5 M5 0 H32 M-5 -18 V18 M5 -10 V10" /></>;
  if (symbol === 'lamp') return <><path d="M-32 0 H-16 M16 0 H32 M-11 -11 L11 11 M-11 11 L11 -11" /><circle r="16" /></>;
  return <><path d={symbol === 'switch-open' ? 'M-32 0 H-16 M16 0 H32 M-16 0 L12 -16' : 'M-32 0 H32'} /><circle cx="-16" r="2" /><circle cx="16" r="2" /></>;
}
export function ScienceDiagramBlock({ code, manifest, ...sourceProps }: { code: string; manifest?: TextbookManifest } & Omit<SourceReferenceProps, 'sourceId' | 'manifest'>) {
  const marker = `science-${useId().replace(/[^\w-]/gu, '')}`;
  const parsed = useMemo(() => { try { return { value: parseScienceDiagram(code, manifest?.sources?.map(s => s.sourceId)) }; }
    catch (error) { return { error: error instanceof Error ? error.message : '参数无效' }; } }, [code, manifest]);
  if (!parsed.value) return <TextbookFormatFallback language="science-diagram" code={code} message={`示意图暂不可显示：${parsed.error}`} />;
  const plot = parsed.value;
  const label = (text: string | undefined, x: number, y: number) => text ? <text x={x} y={y} textAnchor="middle" className="textbook-science-label">{text}</text> : null;
  return <figure className="textbook-science" data-science-diagram="true">
    <figcaption><strong>{plot.title}</strong><span className="textbook-data-label">{plot.simulated ? '教学示意 · 非实测图' : '依据资料绘制 · 请核对来源'}</span></figcaption>
    <div className="textbook-science-scroll" tabIndex={0} role="region" aria-label={`${plot.title}，可横向滚动`}>
      <svg viewBox={`0 0 ${plot.width} ${plot.height}`} role="img" aria-labelledby={`${marker}-title ${marker}-desc`}>
        <title id={`${marker}-title`}>{plot.title}</title><desc id={`${marker}-desc`}>{plot.description}</desc>
        <defs>{inks.map(ink => <marker key={ink} id={`${marker}-${ink}`} viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0 0 L10 5 L0 10 Z" className={`textbook-science-arrow ink-${ink}`} /></marker>)}</defs>
        {plot.elements.map((e, i) => <g key={i} className={`textbook-science-element ink-${e.color || 'default'}`}>
          {e.kind === 'rect' && <><rect x={e.x} y={e.y} width={e.width} height={e.height} rx="3" />{label(e.label, e.x + e.width / 2, e.y + e.height / 2 + 5)}</>}
          {e.kind === 'circle' && <><circle cx={e.cx} cy={e.cy} r={e.r} />{label(e.label, e.cx, e.cy + 5)}</>}
          {(e.kind === 'line' || e.kind === 'arrow') && <><line x1={e.x1} y1={e.y1} x2={e.x2} y2={e.y2} strokeDasharray={e.dashed ? '6 5' : undefined} markerEnd={e.kind === 'arrow' ? `url(#${marker}-${e.color || 'default'})` : undefined} />{label(e.label, (e.x1 + e.x2) / 2 + (Math.abs(e.x2 - e.x1) < 30 ? 27 : 0), (e.y1 + e.y2) / 2 - 12)}</>}
          {e.kind === 'polyline' && <polyline points={e.points.map(p => p.join(',')).join(' ')} strokeDasharray={e.dashed ? '6 5' : undefined} />}
          {e.kind === 'polyline' && label(e.label, e.points[0][0], e.points[0][1] - 12)}
          {e.kind === 'label' && label(e.text, e.x, e.y)}
          {e.kind === 'symbol' && <><g transform={`translate(${e.x},${e.y}) rotate(${e.angle || 0})`}><SymbolShape symbol={e.symbol} /></g>{Math.abs(Math.sin((e.angle || 0) * Math.PI / 180)) > .7 ? label(e.label, e.x + 36, e.y + 5) : label(e.label, e.x, e.y + 34)}</>}
        </g>)}
      </svg>
    </div>
    <p className="textbook-science-description">{plot.description}</p>
    <small>示意图不自动验证物理规律；未声明比例时，长度与角度不作为定量依据。</small>
    {!!plot.sourceIds.length && <div>{plot.sourceIds.map(sourceId => <SourceReference key={sourceId} sourceId={sourceId} manifest={manifest} {...sourceProps} />)}</div>}
  </figure>;
}
