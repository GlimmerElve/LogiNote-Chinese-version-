import type { S2Field } from '../../types/sceneS2';
import type { S2Json } from '../../types/sceneS2Plugin';
import { readS2Field, s2ControlDraft, s2SubmitControlDraft, type S2ControlDraft } from './sceneS2Controls';
import { assertS2StructuredValue, canonicalS2Json } from './sceneS2PluginProtocol';
import { throwS2ControlIssue } from './sceneS2ControlIssue';

/** A form is declarative UI, never an adapter or a replacement for the real port schema. */
export function readS2ParameterForm(raw: unknown, portId: string): S2Field {
  let remaining = 2048;
  const data = (value: unknown, depth = 0): void => {
    if (--remaining < 0 || depth > 12) throw new Error('参数表单声明过大');
    if (value === null || ['string', 'boolean'].includes(typeof value) || typeof value === 'number' && Number.isFinite(value)) return;
    if (!value || typeof value !== 'object' || (Array.isArray(value) ? Object.getPrototypeOf(value) !== Array.prototype
      : ![Object.prototype, null].includes(Object.getPrototypeOf(value)))) throw new Error('参数表单只能声明数据');
    if (Array.isArray(value) && (value.length > 2048 || Object.keys(value).length !== value.length)) throw new Error('参数表单数组无效');
    for (const key of Reflect.ownKeys(value)) {
      if (Array.isArray(value) && key === 'length') continue;
      const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
      if (typeof key !== 'string' || Array.isArray(value) && (!/^(0|[1-9]\d*)$/.test(key) || Number(key) >= value.length)
        || ['constructor', 'prototype', '__proto__'].includes(key) || !descriptor.enumerable || !('value' in descriptor)) throw new Error('参数表单不接受访问器或保留字段');
      data(descriptor.value, depth + 1);
    }
  };
  data(raw);
  const field = readS2Field(raw);
  if (field.id !== portId) throw new Error('参数表单必须映射到同名真实输入');
  return field;
}
export function submitS2ParameterForm(field: S2Field, draft: S2ControlDraft): S2Json {
  const raw = s2SubmitControlDraft(field, draft);
  // A blank optional scalar means "omitted" in block controls, but a parameter
  // commit always creates a literal. Never turn omission into an undeclared value.
  if (raw === '' && !['text', 'multiline', 'code'].includes(field.kind)) {
    throwS2ControlIssue(`${field.label}：请填写或选择一个值，空白不会作为已提交的值。`, []);
  }
  const value = ['text', 'multiline', 'code', 'enum'].includes(field.kind) ? raw : JSON.parse(raw);
  assertS2StructuredValue(value);
  return value;
}
/** No dropped unknown keys, injected defaults, or null/missing/false/zero coercion on load. */
export function s2ParameterFormDraft(field: S2Field, value: S2Json | undefined): S2ControlDraft {
  const raw = value === undefined ? '' : ['text', 'multiline', 'code', 'enum'].includes(field.kind)
    ? typeof value === 'string' ? value : JSON.stringify(value) : JSON.stringify(value);
  const draft = s2ControlDraft(field, raw);
  if (value !== undefined && canonicalS2Json(submitS2ParameterForm(field, draft)) !== canonicalS2Json(value)) throw new Error('当前材料不能由此表单完整表达');
  return draft;
}
