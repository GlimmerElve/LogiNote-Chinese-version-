import React, { useRef, useState } from 'react';
import type { S2Artifact, S2Json } from '../../types/sceneS2Plugin';
import type { S2Table } from '../../services/scene/sceneS2Structured';
import { s2TableToRecords } from '../../services/scene/sceneS2Structured';
import { readS2Artifact } from '../../services/scene/sceneS2PluginProtocol';
import { s2BuiltinPluginRegistry } from '../../services/scene/sceneS2PluginRegistry';
import type { S2SimulationResult } from '../../services/scene/sceneS2Simulation';
import { S2ArtifactChart } from './S2ArtifactChart';
import type { S2ArtifactViewSelection, S2JsonTreeSelection } from '../../services/scene/sceneS2Events';

/** Record explicit activation only, never initial rendering or a programmatic details toggle. */
export function S2JsonTreeBranch({ label, initialOpen, children, onChange }: { label: string; initialOpen: boolean; children: React.ReactNode; onChange?: (open: boolean) => void }) {
  const [open, setOpen] = useState(initialOpen), current = useRef(initialOpen);
  return <details open={open}><summary aria-expanded={open} onClick={event => {
    event.preventDefault(); current.current = !current.current; setOpen(current.current); onChange?.(current.current);
  }}>{label}</summary>{children}</details>;
}

/** Render only escaped React text and native controls. View limits NEVER modify the stored artifact. */
export function S2ArtifactView({ artifact, presentation = 'typed', complete = false, onViewChange, onTreeToggle }: { artifact: S2Artifact; presentation?: 'raw' | 'typed' | 'reading'; complete?: boolean; onViewChange?: (artifactId: string, view: S2ArtifactViewSelection) => void; onTreeToggle?: (artifactId: string, view: S2JsonTreeSelection) => void }) {
  try {
    const checked = readS2Artifact(s2BuiltinPluginRegistry(), artifact);
    if (checked.payload.kind !== 'inline') return <p>完整数据位于宿主句柄；未将摘要作为完整结果展示。</p>;
    const value = checked.payload.value;
    // Text artifacts stay literal text, not JSON-quoted strings, Markdown, HTML or instructions.
    if (checked.type.id === 'core.text') return <pre className="s2-text-artifact nodrag nowheel" aria-label="原始文本产物">{value as string}</pre>;
    if (checked.type.id === 'core.image') return <p aria-label="本局图片材料">本局图片材料（原图发送前可预览）。这里不是识图结论；原图仅在本局允许范围内使用。</p>;
    // Human review needs readable full text, not JSON escape sequences. Keep the complete native
    // structure available; this display never changes types, artifacts, permissions or decisions.
    if (presentation === 'reading' && checked.type.id === 'structured-data.value') {
      const entries = value && typeof value === 'object' && !Array.isArray(value) ? Object.entries(value) : [];
      const texts = typeof value === 'string' ? [value] : entries.length > 0 && entries.length <= 32 && entries.every(([, item]) => typeof item === 'string')
        ? entries.map(([, item]) => item as string) : null;
      if (texts) return <div className="s2-reading-artifact nodrag nowheel">
        <p>以下按原顺序展示完整文字，未改写或运行；字段名称与原始结构可在下方查看。</p>
        {texts.map((text, index) => <section key={index} aria-label={`参考文字 ${index + 1}`}><strong>{texts.length === 1 ? '完整参考文字' : `文字材料 ${index + 1}`}</strong>
          <pre className="s2-text-artifact nodrag nowheel" aria-label={`完整参考文字 ${index + 1}`}>{text}</pre></section>)}
        <details><summary>原始数据（高级）</summary><pre>{JSON.stringify(value, null, 2)}</pre></details>
      </div>;
      return <pre className="nodrag nowheel">{JSON.stringify(value, null, 2)}</pre>;
    }
    if (checked.type.id === 'workflow-simulation.result') {
      const result = value as unknown as S2SimulationResult;
      return <section className="s2-simulation-result nodrag nowheel" aria-label="仅模拟结果，非真实业务执行"><strong>仅模拟 · 非真实业务执行</strong>
        <p>示例由用户或 Agent 预设，不是根据输入自动计算的业务结果，未验证业务效果。</p>
        <ol>{result.steps.map((step, index) => <li key={index}><strong>{step.purpose}</strong><p>假设：{step.assumptions}</p>
          <details open={index === result.steps.length - 1}><summary>试验输入与预设输出</summary><p>试验输入</p><pre>{JSON.stringify(step.input, null, 2)}</pre>
            <p>预设示例输出</p><pre>{JSON.stringify(step.output, null, 2)}</pre></details></li>)}</ol></section>;
    }
    if (presentation === 'raw') return <pre className="nodrag nowheel">{JSON.stringify(value, null, 2)}</pre>;
    if (checked.type.id === 'structured-data.table') {
      const table = value as unknown as S2Table; s2TableToRecords(table);
      return <div className="s2-data-table nodrag nowheel"><table><caption>记录表：{table.rows.length} 行，{table.columns.length} 列</caption><thead><tr>{table.columns.map(column => <th key={column} scope="col">{column}</th>)}</tr></thead>
        <tbody>{(complete ? table.rows : table.rows.slice(0, 20)).map((row, index) => <tr key={index}>{row.map((cell, i) => <td key={i}>{!cell.present ? <em>缺失</em> : <code>{JSON.stringify(cell.value)}</code>}</td>)}</tr>)}</tbody></table>
        {!complete && table.rows.length > 20 && <p>仅预览前20行，另有{table.rows.length - 20}行；下游使用完整数据。</p>}<S2ArtifactChart key={artifact.id} table={table} onViewChange={view => onViewChange?.(artifact.id, view)} /></div>;
    }
    if (checked.type.id === 'structured-data.value') {
      if (complete) return <pre className="nodrag nowheel" aria-label="完整结构化结果">{JSON.stringify(value, null, 2)}</pre>;
      let remaining = 200;
      function tree(value: S2Json, label: string, depth: number, pointer = ''): React.ReactNode {
        if (--remaining < 0) return null;
        if (!value || typeof value !== 'object') return <div className="s2-json-leaf"><strong>{label}</strong>: <code>{JSON.stringify(value)}</code></div>;
        const entries = Object.entries(value), visible = entries.slice(0, Math.max(0, remaining));
        return <S2JsonTreeBranch key={JSON.stringify([artifact.id, pointer])} label={`${label} · ${Array.isArray(value) ? '数组' : '对象'}（${entries.length}）`} initialOpen={depth === 0} onChange={open => onTreeToggle?.(artifact.id, { pointer, open })}>
          {visible.map(([key, item]) => <div className="s2-json-child" key={key}>{tree(item, key, depth + 1, `${pointer}/${key.replace(/~/g, '~0').replace(/\//g, '~1')}`)}</div>)}</S2JsonTreeBranch>;
      }
      const result = tree(value, 'JSON', 0);
      return <div className="s2-json-tree nodrag nowheel">{result}{remaining <= 0 && <p>树预览已达200项；完整产物未截断，下游仍可读取。</p>}</div>;
    }
    return <pre className="nodrag nowheel">{JSON.stringify(value, null, 2)}</pre>;
  } catch (error) { return <p role="alert">产物无法按声明类型展示：{error instanceof Error ? error.message : '数据无效'}；未执行内容或改写数据。</p>; }
}
