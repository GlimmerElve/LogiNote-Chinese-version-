import type { S2Document } from '../../types/sceneS2';

/** Runtime edit guard, deliberately separate from the format parser and new-scene authoring.
 * Compare the scene's original initial document with requirePresence:true to pin authored blocks.
 * Also compare the previous current document (default) to protect surviving copies while permitting
 * removal/undo of those derived blocks. Labels, positions, links and other nodes remain editable.
 */
export function assertS2ReadOnlyContent(before: Pick<S2Document, 'nodes'>, after: Pick<S2Document, 'nodes'>,
  options: { requirePresence?: boolean } = {}): void {
  const next = new Map<string, S2Document['nodes'][number]>();
  for (const node of after.nodes) {
    // Field readers use first-match lookup; duplicates must not make the guard inspect a different block.
    if (next.has(node.id)) throw new Error('S2 内容块标识符重复，不能以同 ID 节点绕过只读内容块检查');
    next.set(node.id, node);
  }
  for (const original of before.nodes) {
    if (original.readOnly !== true) continue;
    const current = next.get(original.id);
    if (!current) {
      if (options.requirePresence) throw new Error(`只读内容块“${original.label || original.id}”是场景固定内容，不能删除`);
      continue;
    }
    const names = Object.keys(original.values);
    if (current.readOnly !== true || current.type !== original.type
      || original.componentId !== undefined && current.componentId !== original.componentId || names.length !== Object.keys(current.values).length
      || names.some(name => !Object.prototype.hasOwnProperty.call(current.values, name) || current.values[name] !== original.values[name])) {
      throw new Error(`只读内容块“${original.label || original.id}”的内容、类型和只读状态不能修改`);
    }
  }
}
