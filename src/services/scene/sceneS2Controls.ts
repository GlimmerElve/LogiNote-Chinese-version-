import type { S2Field } from '../../types/sceneS2';
import type { S2Json } from '../../types/sceneS2Plugin';
import { assertS2StructuredValue } from './sceneS2PluginProtocol';
import { throwS2ControlIssue, type S2ControlPath } from './sceneS2ControlIssue';
import { readS2TableColumns, readS2ChartView, validateS2TableRows, s2TableDraft, s2TableDraftValue, type S2TableDraft } from './sceneS2DataViews';

export const S2_CONTROL_KINDS = ['text', 'multiline', 'number', 'enum', 'boolean', 'list', 'form', 'table', 'json', 'code'] as const;
const reserved = ['constructor', 'prototype', '__proto__'];
function object(raw: unknown): Record<string, unknown> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || ![Object.prototype, null].includes(Object.getPrototypeOf(raw))) throw new Error('控件声明/表单必须是普通对象');
  if (Reflect.ownKeys(raw).some(key => typeof key !== 'string' || reserved.includes(key))) throw new Error('控件含保留字段');
  return raw as Record<string, unknown>;
}
function text(raw: unknown, max: number) {
  if (typeof raw !== 'string' || !raw.trim() || raw.length > max) throw new Error('控件文本无效'); return raw;
}
/** Closed schema: 3 levels, 64 descriptors per root, 8 siblings and 32 list rows. */
export function readS2Field(raw: unknown, depth = 0, budget = { left: 64 }): S2Field {
  if (depth > 2 || --budget.left < 0) throw new Error('控件嵌套或字段总量超限');
  const v = object(raw), kind = v.kind as S2Field['kind'];
  if (!S2_CONTROL_KINDS.includes(kind)) throw new Error('未安装的 S2 控件');
  const extras: Record<S2Field['kind'], string[]> = { text: ['maxLength'], multiline: ['maxLength'], number: ['min', 'max', 'integer'],
    enum: ['options'], boolean: [], list: ['item', 'minItems', 'maxItems'], form: ['fields'],
    table: ['columns', 'view', 'minItems', 'maxItems'], json: [], code: ['language', 'maxLength'] };
  const allowed = ['id', 'label', 'kind', 'required', 'defaultValue', ...extras[kind]];
  if (Object.keys(v).some(key => !allowed.includes(key))) throw new Error('控件包含未支持字段或执行代码');
  const id = text(v.id, 64);
  if (!/^[A-Za-z][A-Za-z0-9_-]*$/.test(id) || reserved.includes(id)) throw new Error('控件标识符无效');
  const field: S2Field = { id, label: text(v.label, 80), kind };
  for (const key of ['required', 'integer'] as const) if (v[key] !== undefined) {
    if (typeof v[key] !== 'boolean') throw new Error('控件布尔声明无效'); field[key] = v[key];
  }
  for (const key of ['min', 'max', 'maxLength', 'minItems', 'maxItems'] as const) if (v[key] !== undefined) {
    if (typeof v[key] !== 'number' || !Number.isFinite(v[key])) throw new Error('控件数值边界无效'); field[key] = v[key];
  }
  if (field.min !== undefined && field.max !== undefined && field.min > field.max) throw new Error('数值下限不能大于上限');
  if (field.maxLength !== undefined && (!Number.isInteger(field.maxLength) || field.maxLength < 1 || field.maxLength > 6000)) throw new Error('文本长度上限为 6000');
  for (const key of ['minItems', 'maxItems'] as const) if (field[key] !== undefined && (!Number.isInteger(field[key]) || field[key]! < 0 || field[key]! > 32)) throw new Error('列表最多 32 项');
  if ((field.minItems ?? 0) > (field.maxItems ?? 32)) throw new Error('列表上下限无效');
  if (kind === 'enum') {
    if (!Array.isArray(v.options) || !v.options.length || v.options.length > 32) throw new Error('枚举需要 1–32 个选项');
    field.options = v.options.map(value => text(value, 120));
    if (new Set(field.options).size !== field.options.length) throw new Error('枚举选项重复');
  }
  if (kind === 'list') field.item = readS2Field(v.item, depth + 1, budget);
  if (kind === 'form') {
    if (!Array.isArray(v.fields) || !v.fields.length || v.fields.length > 8) throw new Error('组合表单需要 1–8 个字段');
    field.fields = v.fields.map(value => readS2Field(value, depth + 1, budget));
    if (new Set(field.fields.map(f => f.id)).size !== field.fields.length) throw new Error('表单字段重复');
  }
  if (kind === 'table') {
    field.columns = readS2TableColumns(v.columns);
    if (v.view !== undefined) field.view = readS2ChartView(v.view, field.columns);
  }
  if (v.language !== undefined) {
    if (typeof v.language !== 'string' || !['plain', 'javascript', 'typescript', 'python', 'sql', 'json'].includes(v.language)) throw new Error('未安装此代码展示语言');
    field.language = v.language as S2Field['language'];
  }
  if (Object.hasOwn(v, 'defaultValue')) {
    validateValue(field, v.defaultValue);
    if (JSON.stringify(v.defaultValue).length > 6000) throw new Error('默认值过长');
    field.defaultValue = structuredClone(v.defaultValue as S2Json);
  }
  return field;
}
function validateValue(field: S2Field, value: unknown, path?: S2ControlPath): void {
  const fail = (reason: string, target = path): never => throwS2ControlIssue(`${field.label}：${reason}`, target);
  if (value === undefined) { if (field.required) fail('请填写必填内容'); return; }
  switch (field.kind) {
    case 'text': case 'multiline': case 'code':
      if (typeof value !== 'string' || value.length > (field.maxLength ?? 6000) || (field.required && !value.trim())) fail('文本为空或超过长度限制'); break;
    case 'number':
      if (typeof value !== 'number' || !Number.isFinite(value) || (field.integer && !Number.isSafeInteger(value))
        || (field.min !== undefined && value < field.min) || (field.max !== undefined && value > field.max)) fail('数值不满足范围或整数要求'); break;
    case 'enum': if (typeof value !== 'string' || !field.options!.includes(value)) fail('请选择已声明的选项'); break;
    case 'boolean': if (typeof value !== 'boolean') fail('请选择是或否'); break;
    case 'json':
      try { assertS2StructuredValue(value); } catch (error) { throwS2ControlIssue(error instanceof Error ? error.message : 'JSON 内容无效', path); } break;
    case 'table': validateS2TableRows(field, value, path); break;
    case 'list':
      if (!Array.isArray(value) || value.length < (field.minItems ?? 0) || value.length > (field.maxItems ?? 32)) {
        const message = `${field.label}：列表数量不满足范围`;
        throwS2ControlIssue(message, path && Array.isArray(value) && value.length < (field.minItems ?? 0) ? [...path, 'add'] : undefined);
      }
      (value as unknown[]).forEach((item, i) => {
        const child = path && [...path, 'items', i];
        if (item === undefined) fail('列表项不能缺失', child);
        validateValue(field.item!, item, child);
      }); break;
    case 'form': {
      const obj = object(value);
      if (Object.keys(obj).some(key => !field.fields!.some(f => f.id === key))) fail('表单含未声明的字段');
      field.fields!.forEach(f => validateValue(f, Object.hasOwn(obj, f.id) ? obj[f.id] : undefined, path && [...path, 'fields', f.id])); break;
    }
  }
}
/** Empty whole fields may remain in an unfinished canvas. Submissions validate the entire value. */
export function validateS2FieldText(field: S2Field, raw: string, allowBlank = true): string {
  if (typeof raw !== 'string' || raw.length > 6000) throw new Error(`${field.label}：字段超过 6000 字`);
  if (raw === '' && (allowBlank || !field.required)) return raw;
  let value: unknown = raw;
  if (!['text', 'multiline', 'enum', 'code'].includes(field.kind)) {
    try { value = JSON.parse(raw); } catch { throw new Error(`${field.label}：需要完整的 ${field.kind} 值`); }
  }
  validateValue(field, value); return raw;
}
export function s2DefaultFieldText(field: S2Field): string {
  if (field.defaultValue === undefined) return '';
  return ['text', 'multiline', 'enum', 'code'].includes(field.kind) ? String(field.defaultValue) : JSON.stringify(field.defaultValue);
}
export type S2ControlDraft = undefined | string | S2ControlDraft[] | { [key: string]: S2ControlDraft };
export function s2ControlDraft(field: S2Field, value: string): S2ControlDraft {
  const convert = (f: S2Field, v: unknown): S2ControlDraft => {
    if (f.kind === 'table') return s2TableDraft(f, (v ?? []) as Array<Record<string, S2Json>>);
    if (f.kind === 'json') return v === undefined ? '' : JSON.stringify(v, null, 2);
    if (f.kind === 'form') return Object.fromEntries(f.fields!.map(child => [child.id, convert(child,
      v && typeof v === 'object' && Object.hasOwn(v, child.id) ? (v as Record<string, unknown>)[child.id] : child.defaultValue)]));
    if (f.kind === 'list') return Array.isArray(v) ? v.map(item => convert(f.item!, item)) : [];
    if (v === undefined && ['text', 'multiline', 'code'].includes(f.kind) && !f.required) return undefined;
    return v === undefined ? '' : String(v);
  };
  if (['text', 'multiline', 'code', 'json'].includes(field.kind)) return value; // Root text/JSON retains exact original spelling, including empty text.
  const raw = value === '' ? undefined : ['text', 'multiline', 'enum', 'code'].includes(field.kind) ? value : JSON.parse(value);
  return convert(field, raw);
}
export function s2SubmitControlDraft(field: S2Field, draft: S2ControlDraft): string {
  const convert = (f: S2Field, d: S2ControlDraft, path: S2ControlPath): S2Json | undefined => {
    if (d === undefined) return undefined;
    if (f.kind === 'table') return s2TableDraftValue(f, d as S2TableDraft, path);
    if (f.kind === 'form') return Object.fromEntries(f.fields!.flatMap(child => {
      const value = convert(child, Object.hasOwn(d as object, child.id) ? (d as Record<string, S2ControlDraft>)[child.id] : undefined, [...path, 'fields', child.id]);
      return value === undefined ? [] : [[child.id, value]];
    }));
    if (f.kind === 'list') return (d as S2ControlDraft[]).map((item, i) => {
      const child = [...path, 'items', i], value = convert(f.item!, item, child);
      if (value === undefined) throwS2ControlIssue('列表项不能为空', child); return value;
    });
    if (typeof d !== 'string') throw new Error('控件草稿类型无效');
    if (d === '' && !f.required && !['text', 'multiline', 'code'].includes(f.kind)) return undefined;
    if (['number', 'boolean', 'json'].includes(f.kind)) {
      try { return JSON.parse(d); } catch { throwS2ControlIssue(`${f.label}：请输入完整值`, path); }
    }
    return d;
  };
  const value = convert(field, draft, []);
  validateValue(field, value, []);
  if (value === undefined) return '';
  const raw = field.kind === 'json' ? draft as string : ['text', 'multiline', 'enum', 'code'].includes(field.kind) ? value as string : JSON.stringify(value);
  return validateS2FieldText(field, raw, false);
}
export interface S2FieldSubmission { version: 1; kind: 'field-submit'; nodeId: string; fieldId: string; previousValue: string; value: string }
export function readS2FieldSubmission(raw: unknown, nodeId: string, field: S2Field, currentValue: string): S2FieldSubmission {
  const event = object(raw);
  if (Object.keys(event).length !== 6 || Object.keys(event).some(key => !['version', 'kind', 'nodeId', 'fieldId', 'previousValue', 'value'].includes(key))
    || event.version !== 1 || event.kind !== 'field-submit' || event.nodeId !== nodeId || event.fieldId !== field.id) throw new Error('字段提交事件无效');
  if (event.previousValue !== currentValue) throw new Error('字段已变化，请载入当前值后重新编辑');
  return { version: 1, kind: 'field-submit', nodeId, fieldId: field.id, previousValue: currentValue,
    value: validateS2FieldText(field, event.value as string, false) };
}
export const S2_CONTROL_RULES = `控件kind:text|multiline|number|enum|boolean|list|form|table|json|code；公共{id,label,kind,required?,defaultValue?}。text/multiline/code:maxLength<=6000；number:min/max/integer可选；enum:options字符串数组；list:item字段，minItems/maxItems<=32；form:fields字段数组1–8项；table:columns:[{id,label,type:"string|number|boolean",required?,nullable?}]最多8列，行数同list，可加view:{kind:"bar|line",xKey:列id,yKey:数值列id}；json有界JSON；code:language可选plain/javascript/typescript/python/sql/json，仅文本。最多3层、每根64声明。values均字符串，text/multiline/enum/code原文，其余JSON文本。默认值须合法，未知留空。提交不自动执行/评价。`;
