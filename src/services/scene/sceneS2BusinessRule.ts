import type { S2BusinessRule } from '../../types/sceneS2Business';
import type { S2Json } from '../../types/sceneS2Plugin';

// Builder, persistence and assessment share this contract. A saved rule must not
// acquire a different safety boundary only when the learner asks to evaluate it.
const reserved = new Set(['__proto__', 'prototype', 'constructor']);
function fail(message: string): never { throw new Error(`S2 本地评价规则：${message}`); }
function object(raw: unknown, allowed: string[]): Record<string, unknown> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(raw))) fail('只接受普通JSON对象');
  for (const key of Reflect.ownKeys(raw)) {
    if (typeof key !== 'string' || reserved.has(key)) fail('不能包含原型保留字段');
    if (!allowed.includes(key) || !Object.hasOwn(Object.getOwnPropertyDescriptor(raw, key)!, 'value')) fail('不接受未知或访问器字段');
  }
  return raw as Record<string, unknown>;
}
function text(raw: unknown, max: number): string {
  if (typeof raw !== 'string' || !raw.trim() || raw.length > max) fail(`文本必须为1–${max}字`);
  return raw;
}
/** RFC 6901 syntax. Its length is bounded; inspected current JSON has a separate depth limit. */
export function s2BusinessRulePointerSegments(raw: unknown): string[] {
  if (typeof raw !== 'string' || raw.length > 500 || raw !== '' && (!raw.startsWith('/') || /~(?![01])/u.test(raw))) fail('需要标准JSON Pointer');
  const segments = raw === '' ? [] : raw.slice(1).split('/').map(token => token.replace(/~1/g, '/').replace(/~0/g, '~'));
  if (segments.some(token => reserved.has(token))) fail('路径不能访问原型保留字段');
  return segments;
}
function expectedJson(raw: unknown): S2Json {
  let entries = 0;
  const visit = (value: unknown, depth: number): S2Json => {
    if (++entries > 256 || depth > 8) fail('预期JSON嵌套或元素数量超过上限');
    if (value === null || typeof value === 'boolean' || typeof value === 'string') return value as null | boolean | string;
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (Array.isArray(value)) {
      if (Object.getPrototypeOf(value) !== Array.prototype || Reflect.ownKeys(value).length !== value.length + 1) fail('JSON列表不接受空项或附加字段');
      return Array.from({ length: value.length }, (_, index) => {
        const descriptor = Object.getOwnPropertyDescriptor(value, index);
        if (!descriptor || !Object.hasOwn(descriptor, 'value')) fail('JSON列表不接受空项或访问器');
        return visit(descriptor.value, depth + 1);
      });
    }
    if (value && typeof value === 'object') {
      const source = object(value, Object.keys(value));
      return Object.fromEntries(Object.entries(source).map(([key, item]) => [key, visit(item, depth + 1)]));
    }
    return fail('只接受完整、有限JSON值');
  };
  const result = visit(raw, 0);
  if (new TextEncoder().encode(JSON.stringify(result)).byteLength > 4096) fail('预期JSON超过4096字节上限');
  return result;
}
/** Declarative rules only: never regex, expressions, code, paths or tool calls. */
export function readS2BusinessRule(raw: unknown): S2BusinessRule {
  const source = object(raw, ['kind', 'value', 'min', 'max', 'pointer']);
  if (source.kind === 'text-includes') {
    const item = object(source, ['kind', 'value']);
    return { kind: 'text-includes', value: text(item.value, 1000) };
  }
  if (source.kind === 'text-length') {
    const item = object(source, ['kind', 'min', 'max']);
    if (![item.min, item.max].every(value => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= 6000)
      || (item.min as number) > (item.max as number)) fail('文本长度上下界必须为0–6000整数且min≤max');
    return { kind: 'text-length', min: item.min as number, max: item.max as number };
  }
  if (source.kind === 'json-pointer-equals') {
    const item = object(source, ['kind', 'pointer', 'value']);
    s2BusinessRulePointerSegments(item.pointer);
    return { kind: 'json-pointer-equals', pointer: item.pointer as string, value: expectedJson(item.value) };
  }
  return fail('只允许固定文本包含、文本长度和JSON Pointer精确相等；不能执行表达式');
}
