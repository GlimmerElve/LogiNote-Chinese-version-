import type { ArgDoc, ArgNode, ArgumentRole, RelationType } from './types';
import { wouldCreateCycle } from '../../modules/argumentCanvas/utils/cycle';

/** Legacy field is compatibility storage, not a second semantic classification. */
export const LEGACY_TYPE_FOR_ROLE: Record<ArgumentRole, ArgNode['mainType']> = {
  claim: '推理', premise: '事实陈述', background: '定义', method: '事实陈述',
};

export const RELATION_HELP: Record<RelationType, string> = {
  support: '依据 → 被支持的主张。不是仅同主题，也不是方法 → 结果。',
  oppose: '反证 → 被质疑的主张。注意实际结果与预期的方向。',
  context: '背景/前提 → 被直接定义、引入或解释的对象。不表示证明。',
  method_for: '方法/情景 → 直接结果或被检验的主张。不表示证明。',
  relates: '明确的回指、对应、命名或部分整体。不能代替支持/反对。',
};

export function recommendedRelation(from?: ArgNode, to?: ArgNode): RelationType {
  if (from?.role === 'method') return 'method_for';
  if (from?.role === 'background') return 'context';
  if ((from?.role === 'premise' || from?.role === 'claim') && to?.role === 'claim') return 'support';
  return 'relates';
}

/** Semantic hints, never automatic role changes or blanket role-based rejection. */
export function relationHint(from: ArgNode, to: ArgNode, kind: RelationType): string | null {
  if ((kind === 'support' || kind === 'oppose') && (from.role === 'method' || from.role === 'background')) return '起点是方法/背景：请确认它确实是依据，不要把来源关系当作证明。';
  if ((kind === 'support' || kind === 'oppose') && to.role && to.role !== 'claim') return '终点不是主张：请核对关系方向和角色；不会自动修改角色。';
  if (kind === 'context' && from.role && from.role !== 'background' && from.role !== 'premise') return '请核对起点是否实际承担定义、引入或解释功能。';
  if (kind === 'method_for' && ((from.role && from.role !== 'method' && from.role !== 'background') || to.role === 'method' || to.role === 'background')) return '请核对起点是否描述方法、终点是否为直接结果或被检验主张。';
  return null;
}

export function edgeEditError(doc: ArgDoc, from: string, to: string, kind: RelationType, editingId?: string): string | null {
  if (from === to) return '不能连接节点自身。';
  if (!doc.nodes.some(n => n.id === from) || !doc.nodes.some(n => n.id === to)) return '节点已不存在，请重新选择。';
  const others = doc.edges.filter(e => e.id !== editingId);
  if (others.some(e => e.source === from && e.target === to && e.relation === kind)) return '相同方向和类型的关系已存在。';
  if (kind === 'support' && wouldCreateCycle(from, to, others)) return '这条支持边会形成循环论证，请核对方向或关系。';
  return null;
}
