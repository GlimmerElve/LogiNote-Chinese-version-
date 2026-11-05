import { ARGUMENT_ROLE_LABELS, type ArgumentRole } from '../argumentDoc/types';

/** A legacy functional label never proves a current semantic role or factual truth. */
export function cognitionRoleLabel(node: { role?: ArgumentRole; mainType?: string }): string {
  return node.role ? ARGUMENT_ROLE_LABELS[node.role] : '未标注角色';
}
