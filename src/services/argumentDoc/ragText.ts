import type { ArgDoc } from './types.ts';
import { ARGUMENT_ROLE_LABELS, RELATION_LABELS } from './types.ts';

const compact = (text: string, max = 240): string => {
  const normalized = text.replace(/\s+/g, ' ').trim();
  return normalized.length > max ? `${normalized.slice(0, max)}…` : normalized;
};

/** 把最终论证图压缩成可检索文本；拖拽坐标、撤销栈等操作噪声不进入 RAG。 */
export function buildArgumentRagText(doc: ArgDoc): string {
  const published = doc.rag?.publishedSnapshot;
  if (!published) return '';
  const nodeById = new Map(published.nodes.map((node) => [node.id, node]));
  const scores = published.scores
    ? `评分：概念 ${published.scores.conceptScore}，判断 ${published.scores.judgmentScore}，逻辑 ${published.scores.logicScore}`
    : '';
  const nodes = published.nodes.slice(0, 30).map((node) => (
    `节点[${node.role ? ARGUMENT_ROLE_LABELS[node.role] : node.mainType}/${node.status}] ${compact(node.text)}${node.issue ? `；问题：${compact(node.issue, 120)}` : ''}`
  ));
  const edges = published.edges.slice(0, 40).map((edge) => {
    const source = compact(nodeById.get(edge.source)?.text || edge.source, 60);
    const target = compact(nodeById.get(edge.target)?.text || edge.target, 60);
    return `关系：${source} ${RELATION_LABELS[edge.relation]} ${target}`;
  });
  return [
    `论证结构「${compact(published.title, 100)}」`,
    `准入：${published.assessment.admission === 'full' ? '完整' : '受限'}；质量 ${published.assessment.score}/100；证据等级 ${published.assessment.evidenceGrade === 'ungraded' ? '未评级' : published.assessment.evidenceGrade}`,
    published.summary ? `总结：${compact(published.summary, 360)}` : '',
    scores,
    ...nodes,
    ...edges,
  ].filter(Boolean).join('\n');
}
