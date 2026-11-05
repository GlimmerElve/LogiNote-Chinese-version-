import type { CognitionEditMeaning, CognitionGraph, CognitionOperation } from './types';

const fail = (message: string): never => { throw new Error(message); };
/** HTML textareas normalize CRLF/CR to LF. No other whitespace or words are folded. */
export const cognitionLineEndings = (value: string) => value.replace(/\r\n?/gu, '\n');
export const cognitionTextIncludes = (body: string, fragment: string) => cognitionLineEndings(body).includes(cognitionLineEndings(fragment));
function row(raw: unknown): Record<string, unknown> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return fail('变更语义格式无效');
  return raw as Record<string, unknown>;
}
function phrase(raw: unknown) {
  if (typeof raw !== 'string' || !raw.trim() || raw !== raw.trim() || raw.length > 2000) return fail('语义说明或条件为空、未去除首尾空白或过长');
  return raw;
}
export function cognitionPhrases(raw: unknown): string[] {
  if (!Array.isArray(raw) || raw.length > 40) return fail('条件或保留片段列表无效');
  const values = raw.map(phrase);
  if (new Set(values).size !== values.length) return fail('条件或保留片段重复');
  return values;
}
export function parseCognitionMeaning(raw: unknown): CognitionEditMeaning {
  const input = row(raw);
  const meaning: CognitionEditMeaning = { interpretation: phrase(input.interpretation), preserved: cognitionPhrases(input.preserved) };
  if (input.conditions !== undefined) {
    const conditions = row(input.conditions);
    if (!Array.isArray(conditions.changes) || !conditions.changes.length || conditions.changes.length > 40) return fail('必须逐项说明新增、移除或替换哪些条件');
    meaning.conditions = { before: cognitionPhrases(conditions.before), changes: conditions.changes.map(raw => {
      const change = row(raw);
      if (change.kind === 'add' && change.before === undefined) return { kind: 'add', after: phrase(change.after) };
      if (change.kind === 'remove' && change.after === undefined) return { kind: 'remove', before: phrase(change.before) };
      if (change.kind === 'replace') return { kind: 'replace', before: phrase(change.before), after: phrase(change.after) };
      return fail('条件操作无效：新增不能夹带删除，移除不能夹带新增');
    }) };
  }
  return meaning;
}

/** Literal consistency guard only; does not claim to judge natural-language truth/entailment. */
export function resolveCognitionConditions(old: CognitionGraph['nodes'][number], text: string, operation: CognitionOperation, meaning?: CognitionEditMeaning) {
  for (const kept of meaning?.preserved || []) if (!cognitionTextIncludes(old.text, kept) || !cognitionTextIncludes(text, kept)) fail('声明保留的原文片段未同时出现在修改前后，请重新核对');
  const delta = meaning?.conditions;
  if (!delta) {
    if (['add_conditions', 'remove_conditions', 'replace_conditions'].includes(operation)) return fail('条件操作缺少逐项变更说明');
    if ((old.conditions || []).some(condition => !cognitionTextIncludes(text, condition))) return fail('不能静默移除或改写已记录条件，请明确使用条件移除或替换操作');
    return old.conditions;
  }
  if (!['qualify', 'add_conditions', 'remove_conditions', 'replace_conditions'].includes(operation)) return fail('条件变更必须选择明确的条件操作，不能伪装成普通修订或确定程度调整');
  if (old.conditions !== undefined ? JSON.stringify(delta.before) !== JSON.stringify(old.conditions) : delta.before.some(condition => !cognitionTextIncludes(old.text, condition))) return fail('原条件与当前节点不符；旧数据的原条件必须逐字来自原文');
  const operationKinds: Partial<Record<CognitionOperation, 'add' | 'remove' | 'replace'>> = { add_conditions: 'add', remove_conditions: 'remove', replace_conditions: 'replace' };
  const requiredKind = operationKinds[operation];
  if (requiredKind && delta.changes.some(change => change.kind !== requiredKind)) return fail('条件操作与逐项变更不一致，不允许把替换或删除藏在新增中');
  const replacements = new Map<string, string | undefined>(), added: string[] = [];
  for (const change of delta.changes) {
    if (change.kind !== 'add') {
      if (!delta.before.includes(change.before) || replacements.has(change.before)) return fail('移除或替换的原条件不存在或被重复处理');
      replacements.set(change.before, change.kind === 'replace' ? change.after : undefined);
      if (change.kind === 'replace' && change.before === change.after) return fail('替换前后条件相同');
    } else added.push(change.after);
  }
  const after = cognitionPhrases([...delta.before.flatMap(condition => replacements.has(condition) ? replacements.get(condition) ? [replacements.get(condition)!] : [] : [condition]), ...added]);
  if (after.some(condition => !cognitionTextIncludes(text, condition))) return fail('修改后正文遗漏了新增、替换或应保留的条件');
  // A replacement may legitimately contain the old words (e.g. "压力适中" → "压力适中或偏高").
  // Reject only standalone old occurrences, not occurrences inside a declared resulting condition.
  const body = cognitionLineEndings(text);
  const coveredUntil = new Array<number>(body.length).fill(-1);
  for (const remaining of after.map(cognitionLineEndings)) for (let start = body.indexOf(remaining); start !== -1; start = body.indexOf(remaining, start + 1)) {
    coveredUntil[start] = Math.max(coveredUntil[start], start + remaining.length);
  }
  for (let i = 1; i < coveredUntil.length; i++) coveredUntil[i] = Math.max(coveredUntil[i], coveredUntil[i - 1]);
  for (const condition of [...replacements.keys()].map(cognitionLineEndings)) {
    for (let at = body.indexOf(condition); at !== -1; at = body.indexOf(condition, at + 1)) {
      if (coveredUntil[at] < at + condition.length) return fail('已移除或被替换的原条件仍单独出现在正文中，请明确改写后再确认');
    }
  }
  return after;
}
