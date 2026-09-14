/**
 * 论证结构 → Markdown 导出（语义重组 + 顶部 mermaid 结构图）
 */
import type { ArgDoc, ArgNode, ArgEdge } from '../../../services/argumentDoc/types';

const PRIORITY: Record<string, number> = { 定义: 1, 命名: 2, 对比: 3, 事实陈述: 4, 假设: 5, 举例: 6, 推理: 7, 反例削弱: 8, 建议对策: 9 };
type Segment = '概念' | '主张' | '推理' | '结论';
const SEGMENT_TITLE: Record<Segment, string> = { 概念: '## 概念', 主张: '## 主张', 推理: '## 推理', 结论: '## 结论' };
const TYPE_SEGMENT: Record<string, Segment> = { 定义: '概念', 命名: '概念', 对比: '概念', 事实陈述: '主张', 假设: '主张', 举例: '主张', 推理: '推理', 建议对策: '结论' };
const PREFIX: Record<string, string> = { 对比: '> ', 事实陈述: '> 事实上，', 假设: '**假设**：', 举例: '**比如**：', 反例削弱: '> **但是**，', 建议对策: '**所以**，' };

function isIsolated(node: ArgNode, edges: ArgEdge[]): boolean { return !edges.some((e) => e.source === node.id || e.target === node.id); }

function attachCounterExamples(nodes: ArgNode[], edges: ArgEdge[]): Map<string, ArgNode[]> {
  const map = new Map<string, ArgNode[]>();
  const validIds = new Set(nodes.map((n) => n.id));
  for (const n of nodes) {
    if (n.mainType !== '反例削弱') continue;
    const targets = edges.filter((e) => e.source === n.id && e.relation === 'oppose' && validIds.has(e.target)).map((e) => e.target);
    for (const t of targets) { if (!map.has(t)) map.set(t, []); map.get(t)!.push(n); }
  }
  return map;
}

function sortChain(nodes: ArgNode[]): ArgNode[] { return [...nodes].sort((a, b) => (PRIORITY[a.mainType] ?? 99) - (PRIORITY[b.mainType] ?? 99) || a.id.localeCompare(b.id)); }

function buildMermaid(doc: ArgDoc): string {
  const lines: string[] = ['```mermaid', 'flowchart TB'];
  for (const n of doc.nodes) lines.push(`  ${n.id}["${`${n.mainType}：${n.text}`.replace(/"/g, "'")}"]`);
  for (const e of doc.edges) lines.push(e.relation === 'support' ? `  ${e.source} -->|支持| ${e.target}` : `  ${e.source} -.->|反对| ${e.target}`);
  lines.push('```');
  return lines.join('\n');
}

function renderNode(node: ArgNode, counterExamples: ArgNode[]): string {
  const out: string[] = [];
  const prefix = PREFIX[node.mainType] ?? '';
  let body = node.text.trim();
  if (node.status === 'to_delete') body = `~~${body}~~`;
  out.push(`${prefix}${body}`);
  if (node.status !== 'edited' && node.issue) out.push(`> 【问题】${node.issue}（严重程度 ${node.severity ?? ''}/5）`);
  if (node.status === 'suggested' && node.suggestion) out.push(`> 【建议】${node.suggestion}`);
  for (const ce of counterExamples) out.push(`${PREFIX['反例削弱'] ?? '> **但是**，'}${ce.text.trim()}`);
  return out.join('\n\n');
}

export function exportMarkdown(doc: ArgDoc): string {
  const { title, summary, nodes, edges } = doc;
  const lines: string[] = [];
  lines.push(`# ${title}`);
  lines.push('');
  if (summary) { lines.push(`> 分析总结：${summary}`); lines.push(''); }
  lines.push('## 论证结构图');
  lines.push('');
  lines.push(buildMermaid(doc));
  lines.push('');
  const counterMap = attachCounterExamples(nodes, edges);
  const isolated = nodes.filter((n) => isIsolated(n, edges));
  const attachedIds = new Set<string>();
  for (const list of counterMap.values()) for (const n of list) attachedIds.add(n.id);
  const groups: Record<Segment, ArgNode[]> = { 概念: [], 主张: [], 推理: [], 结论: [] };
  for (const n of nodes) {
    if (isIsolated(n, edges)) continue;
    if (attachedIds.has(n.id)) continue;
    if (n.mainType === '反例削弱') { groups.推理.push(n); continue; }
    const seg = TYPE_SEGMENT[n.mainType];
    if (seg) groups[seg].push(n);
  }
  for (const seg of ['概念', '主张', '推理', '结论'] as Segment[]) {
    const segNodes = sortChain(groups[seg]);
    if (segNodes.length === 0) continue;
    lines.push(SEGMENT_TITLE[seg]);
    lines.push('');
    for (const n of segNodes) { lines.push(renderNode(n, counterMap.get(n.id) ?? [])); lines.push(''); }
  }
  if (isolated.length > 0) {
    lines.push('## 未连接');
    lines.push('');
    for (const n of sortChain(isolated)) lines.push(renderNode(n, []));
    lines.push('');
  }
  return lines.join('\n').trimEnd() + '\n';
}