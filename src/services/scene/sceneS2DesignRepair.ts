/** Builder-only declarative repair. No execution, runtime grants or direct UI mutation. */
export const S2_DESIGN_REPAIR_ROOTS = ['goal', 'instructions', 'blockTypes', 'initial', 'plugins', 'criteria', 'business'] as const;
export const S2_DESIGN_REPAIR_LIMIT = 12;
const reserved = new Set(['__proto__', 'prototype', 'constructor']);
const object = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('S2 定向修复字段必须为对象');
  return value as Record<string, unknown>;
};
function segments(path: unknown) {
  if (typeof path !== 'string' || path.length > 500 || !path.startsWith('/') || /~(?![01])/u.test(path)) throw new Error('S2 定向修复需要标准JSON Pointer，不能替换整个根对象');
  const parts = path.slice(1).split('/').map(key => key.replace(/~1/g, '/').replace(/~0/g, '~'));
  if (!S2_DESIGN_REPAIR_ROOTS.includes(parts[0] as typeof S2_DESIGN_REPAIR_ROOTS[number]) || parts.some(key => !key || reserved.has(key))) {
    throw new Error('S2 定向修复仅允许场景设计字段，不允许修改需求理解、协议版本或权限');
  }
  return parts;
}
function arrayIndex(key: string, length: number, insert = false) {
  if (insert && key === '-') return length;
  if (!/^(0|[1-9]\d*)$/.test(key)) throw new Error('S2 定向修复数组下标必须为非负规范整数；仅add支持-追加');
  const index = Number(key);
  if (!Number.isSafeInteger(index) || index >= length + (insert ? 1 : 0)) throw new Error('S2 定向修复数组下标不存在，不允许稀疏数组');
  return index;
}
/** Returns an uncommitted candidate. Caller MUST run the full local definition validator. */
export function applyS2DesignRepair(previous: unknown, output: unknown): Record<string, unknown> {
  const envelope = object(output);
  if (Object.keys(envelope).length !== 1 || !Object.hasOwn(envelope, 'repair')) throw new Error('S2 定向修复仅返回{repair:{operations:[]}}，不能混合完整场景或声明权限');
  const repair = object(envelope.repair);
  if (Object.keys(repair).length !== 1 || !Array.isArray(repair.operations) || !repair.operations.length || repair.operations.length > S2_DESIGN_REPAIR_LIMIT) throw new Error('S2 定向修复需要1–12项operations');
  const next = structuredClone(object(previous));
  for (const raw of repair.operations) {
    const op = object(raw);
    if (Object.keys(op).some(key => !['op', 'path', 'value'].includes(key)) || typeof op.op !== 'string' || !['add', 'replace', 'remove'].includes(op.op)
      || (op.op === 'remove' ? Object.hasOwn(op, 'value') : !Object.hasOwn(op, 'value') || op.value === undefined)) throw new Error('S2 定向修复仅支持add/replace（必须有value）和remove（无value）');
    const parts = segments(op.path), key = parts.pop()!;
    let parent: unknown = next;
    for (const part of parts) {
      if (Array.isArray(parent)) parent = parent[arrayIndex(part, parent.length)];
      else { const current = object(parent); if (!Object.hasOwn(current, part)) throw new Error(`S2 定向修复父路径不存在：${op.path}`); parent = current[part]; }
    }
    if (Array.isArray(parent)) {
      const index = arrayIndex(key, parent.length, op.op === 'add');
      if (op.op === 'remove') parent.splice(index, 1);
      else if (op.op === 'add') parent.splice(index, 0, structuredClone(op.value));
      else parent[index] = structuredClone(op.value);
    } else {
      const current = object(parent), exists = Object.hasOwn(current, key);
      // Object add and replace both explicitly supply the new value. Allowing add to an
      // existing member does not expand the allowed roots, permissions or validation bypasses.
      if (op.op !== 'add' && !exists) throw new Error(`S2 定向修复目标不存在：${op.path}`);
      if (op.op === 'remove') delete current[key]; else current[key] = structuredClone(op.value);
    }
  }
  return next;
}
export const S2_DESIGN_REPAIR_RULES = `再次装配时可选：①返回完整场景，重新选择必要组件；②仅返回{repair:{operations:[{op:"replace",path:"/instructions/planning",value:"修正后的策略"}]}}，对previousCandidate定向修复。不是固定要求使用补丁。
补丁最多12项，仅支持add/replace/remove和标准JSON Pointer；根字段只允许goal、instructions、blockTypes、initial、plugins、criteria、business，不能改designBrief或根version，也不能提交运行权限/执行请求。replace/remove必须指向已有字段；add对对象字段可新增或明确替换已有值，对数组下标则插入元素（-表示追加），不自动创建父路径，不运行表达式或代码。不更改的字段由宿主原样保留；修复整个候选后仍须完整本地校验。旧业务包内的reference仍只是私有参考，不应用到初始图或执行。根据repairContext中原文、缺口和协议事实决定最小必要改动；若选型本身不合适，可以重装配，不为保留初稿而牺牲目标。`;
