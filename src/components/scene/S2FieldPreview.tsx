import React from 'react';
import type { S2Field } from '../../types/sceneS2';
import type { S2Json } from '../../types/sceneS2Plugin';
import { validateS2FieldText } from '../../services/scene/sceneS2Controls';
import { s2ChartPoints } from '../../services/scene/sceneS2DataViews';
import { S2ChartPreview } from './S2ChartPreview';

/** Local views only. Text is escaped; chart points are calculated from the committed rows. */
export function S2FieldPreview({ field, value }: { field: S2Field; value: string }) {
  if (value === '') return <p>（待提交）</p>;
  try {
    validateS2FieldText(field, value, false);
    if (field.kind === 'code') return <section className="s2-field-preview"><small>代码文本 · {field.language ?? 'plain'} · 未执行</small><pre><code>{value}</code></pre></section>;
    if (field.kind === 'json') return <section className="s2-field-preview"><small>已提交 JSON · 结构预览</small><pre>{JSON.stringify(JSON.parse(value), null, 2)}</pre>
      <details><summary>原始 JSON</summary><pre>{value}</pre></details></section>;
    if (field.kind !== 'table') return <p>{value}</p>;
    const rows = JSON.parse(value) as Array<Record<string, S2Json>>, chart = field.view ? s2ChartPoints(field, rows) : undefined;
    return <section className="s2-field-preview" aria-label={`${field.label} 已提交数据`}>
      {chart && <S2ChartPreview chart={chart} view={field.view!} label={field.label} />}
      <div className="s2-data-table"><table><caption>已提交 · {rows.length} 行</caption><thead><tr>{field.columns!.map(col => <th key={col.id} scope="col">{col.label}</th>)}</tr></thead>
        <tbody>{rows.map((row, i) => <tr key={i}>{field.columns!.map(col => <td key={col.id}>{Object.hasOwn(row, col.id) ? <code>{JSON.stringify(row[col.id])}</code> : <em>缺失</em>}</td>)}</tr>)}</tbody></table></div>
    </section>;
  } catch (e) { return <p role="alert">无法展示已提交数据：{e instanceof Error ? e.message : '数据无效'}</p>; }
}
