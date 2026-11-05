import React, { useMemo } from 'react';
import { parseChartBlock } from '../../services/textbook/contentSchema';
import type { TextbookManifest } from '../../services/textbook/types';
import { TextbookFormatFallback } from './CodeBlock';
import { SourceReference, type SourceReferenceProps } from './SourceReference';
import { BackgroundTextbookVisual } from './BackgroundTextbookVisual';
export function ChartBlock({ code, manifest, ...sourceProps }: { code: string; manifest?: TextbookManifest } & Omit<SourceReferenceProps, 'sourceId' | 'manifest'>) {
  const parsed = useMemo(() => {
    try { return { chart: parseChartBlock(code, { sourceIds: manifest?.sources?.map(item => item.sourceId) }) }; }
    catch (error) { return { error: error instanceof Error ? error.message : '图表格式无效' }; }
  }, [code, manifest]);
  if (!parsed.chart) return <TextbookFormatFallback language="chart" code={code} message={`图表无法渲染：${parsed.error}`} />;
  const chart = parsed.chart;
  return <figure className="textbook-chart">
    <figcaption><strong>{chart.title}</strong><span className="textbook-data-label">{chart.simulated ? '示意 / 模拟数据，不代表真实统计' : '资料数据；请核对原文与口径'}</span></figcaption>
    <div className="textbook-chart-canvas"><BackgroundTextbookVisual kind="chart" code={code} label={chart.title} /></div>
    <details><summary>查看可读数据表</summary><div className="textbook-table-scroll"><table><thead><tr><th scope="col">项目</th>{chart.series.map(item => <th scope="col" key={item.name}>{item.name}</th>)}</tr></thead><tbody>{chart.labels.map((label, index) => <tr key={`${index}:${label}`}><th scope="row">{label}</th>{chart.series.map((series, column) => <td key={column}>{series.data[index]}</td>)}</tr>)}</tbody></table></div></details>
    {!!chart.sourceIds.length && <div className="textbook-chart-sources">数据来源：{chart.sourceIds.map(sourceId => <SourceReference key={sourceId} sourceId={sourceId} manifest={manifest} {...sourceProps} />)}</div>}
  </figure>;
}
