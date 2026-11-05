import type { S2Json } from '../../types/sceneS2Plugin';
import { assertS2StructuredValue } from './sceneS2PluginProtocol';
import { snapshotS2CompositeData } from './sceneS2Composite';

export type S2SimpleScalarKind = 'missing' | 'string' | 'number' | 'boolean' | 'null';
export interface S2SimpleScalarDraft { kind: S2SimpleScalarKind; text: string; number: string; boolean: '' | 'true' | 'false' }
export interface S2SimpleListDraft {
  items?: S2SimpleListItem[];
  nextItemId?: number;
}
export interface S2SimpleListItem extends Omit<S2SimpleScalarDraft, 'kind'> {
  id: string; kind: S2SimpleScalarKind | 'object'; rows?: S2SimpleValueRow[];
}
export interface S2SimpleValueRow extends Omit<S2SimpleScalarDraft, 'kind'>, S2SimpleListDraft {
  name: string; kind: S2SimpleScalarKind | 'object' | 'list'; rows?: S2SimpleValueRow[];
}
export interface S2SimpleValueDraft extends Omit<S2SimpleScalarDraft, 'kind'>, S2SimpleListDraft {
  kind: S2SimpleScalarKind | 'object' | 'records' | 'list'; rows: S2SimpleValueRow[];
  records?: Array<{ id: string; rows: S2SimpleValueRow[] }>;
  nextRecordId?: number;
}
export const S2_SIMPLE_VALUE_MAX_FIELDS = 32;
export const S2_SIMPLE_VALUE_MAX_RECORDS = 32;
export const S2_SIMPLE_VALUE_MAX_ITEMS = 32;
/** One optional named group inside an object/record; not an unbounded JSON tree editor. */
export const S2_SIMPLE_VALUE_MAX_GROUP_DEPTH = 1;
const scalarKinds = ['missing', 'string', 'number', 'boolean', 'null'];
const reserved = ['__proto__', 'constructor', 'prototype'];
const fail = (message: string): never => { throw new Error(message); };
export type S2SimpleControlPath = ReadonlyArray<string | number>;
export interface S2SimpleValueIssue { control: string; message: string }
const localIssues = new WeakMap<object, S2SimpleValueIssue>();
/** Only local validation can brand an issue; messages or model/host fields cannot forge a control path. */
function invalidControl(message: string, path: S2SimpleControlPath): never {
  const error = new Error(message); localIssues.set(error, { control: JSON.stringify(path), message }); throw error;
}
export function s2SimpleValueIssue(error: unknown): S2SimpleValueIssue | undefined {
  const issue = error && typeof error === 'object' ? localIssues.get(error) : undefined;
  return issue ? { ...issue } : undefined;
}
export const emptyS2SimpleScalar = (): S2SimpleScalarDraft => ({ kind: 'missing', text: '', number: '', boolean: '' });
function scalar(value: S2Json | undefined): S2SimpleScalarDraft {
  if (value === undefined) return emptyS2SimpleScalar();
  if (value === null) return { ...emptyS2SimpleScalar(), kind: 'null' };
  if (typeof value === 'string') return { ...emptyS2SimpleScalar(), kind: 'string', text: value };
  if (typeof value === 'number' && Number.isFinite(value)) return { ...emptyS2SimpleScalar(), kind: 'number', number: Object.is(value, -0) ? '-0' : String(value) };
  if (typeof value === 'boolean') return { ...emptyS2SimpleScalar(), kind: 'boolean', boolean: value ? 'true' : 'false' };
  return fail('此内容超出常用表单范围，请用高级 JSON 完整编辑；不会压平或截断。');
}
function arrayEntries(value: S2Json[], max: number): S2Json[] {
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Object.getPrototypeOf(value) !== Array.prototype || value.length > max
    || Reflect.ownKeys(descriptors).length !== value.length + 1) return fail('列表数量过多或不是完整列表，请使用高级 JSON 编辑；不会截断。');
  return Array.from({ length: value.length }, (_, index) => {
    const item = descriptors[String(index)];
    if (!item || !item.enumerable || !Object.hasOwn(item, 'value')) return fail('不接受列表空洞、隐藏项或访问器。');
    return item.value as S2Json;
  });
}
function listDraft(entries: S2Json[], budget: { entries: number }): Required<S2SimpleListDraft> {
  spendNative(budget, 1);
  return { items: entries.map((item, index) => {
    if (item !== null && typeof item === 'object') return { id: `item-${index + 1}`, ...emptyS2SimpleScalar(), kind: 'object' as const,
      rows: objectRows(item, S2_SIMPLE_VALUE_MAX_GROUP_DEPTH, budget, true) };
    spendNative(budget, 1); return { id: `item-${index + 1}`, ...scalar(item) };
  }), nextItemId: entries.length + 1 };
}
function spendNative(budget: { entries: number }, count: number) {
  // Check incrementally, before expansion multiplies native entries into much larger UI metadata.
  if ((budget.entries += count) > 2048) fail('结构化数据元素过多，请使用高级 JSON 编辑；不会截断。');
}
function objectRows(value: object, depth = 0, budget = { entries: 0 }, scalarOnly = false): S2SimpleValueDraft['rows'] {
  spendNative(budget, 1);
  if (Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return fail('此结构请使用高级 JSON 编辑，完整材料已保留。');
  const descriptors = Object.getOwnPropertyDescriptors(value), names = Reflect.ownKeys(descriptors);
  if (names.length > S2_SIMPLE_VALUE_MAX_FIELDS) return fail(`超过 ${S2_SIMPLE_VALUE_MAX_FIELDS} 个字段，请使用高级 JSON 编辑；不会截断。`);
  return names.map(name => {
    if (typeof name !== 'string' || reserved.includes(name) || name.length > 200) return fail('字段名不能由常用表单完整表达，请使用高级 JSON 编辑。');
    const descriptor = descriptors[name];
    if (!descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) return fail('不接受隐藏字段或访问器。');
    // Named lists may contain single-level objects, never another list or a nested object in an item.
    if (Array.isArray(descriptor.value)) {
      if (scalarOnly) return fail('列表中的多项内容仅支持普通字段；嵌套容器请用高级 JSON 完整编辑。');
      const entries = arrayEntries(descriptor.value, S2_SIMPLE_VALUE_MAX_ITEMS);
      return { name, ...emptyS2SimpleScalar(), kind: 'list', ...listDraft(entries, budget) };
    }
    if (descriptor.value !== null && typeof descriptor.value === 'object') {
      if (scalarOnly) return fail('列表中的多项内容仅支持普通字段；嵌套容器请用高级 JSON 完整编辑。');
      if (depth >= S2_SIMPLE_VALUE_MAX_GROUP_DEPTH) return fail('当前常用表单支持一层信息分组；更深内容请用高级 JSON 完整编辑。');
      return { name, ...emptyS2SimpleScalar(), kind: 'object', rows: objectRows(descriptor.value, depth + 1, budget) };
    }
    spendNative(budget, 1);
    return { name, ...scalar(descriptor.value) };
  });
}
function completeDraft(draft: S2SimpleValueDraft): S2SimpleValueDraft {
  // A valid native value can have a larger UI representation. Fall back whole, before choosing the form.
  snapshotS2CompositeData(draft); return draft;
}
/** No guessed columns, defaults, omitted-key filling or nested-data flattening. */
export function s2SimpleValueDraft(value: S2Json | undefined): S2SimpleValueDraft {
  if (value === undefined || value === null || typeof value !== 'object') {
    const draft = { ...scalar(value), rows: [] };
    if (value !== undefined) assertS2StructuredValue(value);
    return draft;
  }
  if (Array.isArray(value)) {
    const entries = arrayEntries(value, S2_SIMPLE_VALUE_MAX_RECORDS);
    // Empty arrays retain the existing record editor; users can explicitly choose an empty ordinary list.
    if (entries.length && !entries.every(item => item !== null && typeof item === 'object' && !Array.isArray(item))) {
      const draft = { ...emptyS2SimpleScalar(), kind: 'list' as const, rows: [], ...listDraft(entries, { entries: 0 }) };
      assertS2StructuredValue(value);
      return completeDraft(draft);
    }
    const budget = { entries: 1 };
    const records = entries.map((item, index) => {
      if (!item || typeof item !== 'object') return fail('记录项必须是普通对象；更深列表请使用高级 JSON 完整编辑。');
      return { id: `record-${index + 1}`, rows: objectRows(item, 0, budget) };
    });
    assertS2StructuredValue(value);
    return completeDraft({ ...emptyS2SimpleScalar(), kind: 'records', rows: [], records, nextRecordId: records.length + 1 });
  }
  const rows = objectRows(value);
  assertS2StructuredValue(value);
  return completeDraft({ ...emptyS2SimpleScalar(), kind: 'object', rows });
}
function readScalar(draft: S2SimpleScalarDraft, label: string, path: S2SimpleControlPath = []): S2Json {
  if (!scalarKinds.includes(draft.kind) || typeof draft.text !== 'string' || typeof draft.number !== 'string' || !['', 'true', 'false'].includes(draft.boolean)) return fail(`${label}：填写类型无效。`);
  if (draft.kind === 'missing') return invalidControl(`${label}：尚未填写；请选择内容类型，未填写不会转成空值。`, [...path, 'kind']);
  if (draft.kind === 'null') return null;
  if (draft.kind === 'string') return draft.text;
  if (draft.kind === 'boolean') {
    if (!draft.boolean) return invalidControl(`${label}：请选择“是”或“否”。`, [...path, 'boolean']);
    return draft.boolean === 'true';
  }
  const text = draft.number.trim();
  if (!/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/.test(text) || !Number.isFinite(Number(text))) return invalidControl(`${label}：请填写有效数字；空白不会变成 0。`, [...path, 'number']);
  return Number(text);
}
function readList(draft: S2SimpleListDraft, label: string, path: S2SimpleControlPath,
  readObject: (rows: S2SimpleValueRow[], label: string, path: S2SimpleControlPath) => S2Json): S2Json[] {
  if (!Array.isArray(draft.items) || draft.items.length > S2_SIMPLE_VALUE_MAX_ITEMS || !Number.isSafeInteger(draft.nextItemId)
    || draft.nextItemId! < 1 || draft.nextItemId! > 1000000) return fail(`${label}：普通列表草稿无效或项目过多；原草稿保留。`);
  const ids = new Set<string>();
  return draft.items.map((item, index) => {
    if (!item || typeof item !== 'object' || Array.isArray(item) || Object.keys(item).some(key => !['id', 'kind', 'text', 'number', 'boolean', 'rows'].includes(key))
      || typeof item.id !== 'string' || !/^item-[1-9]\d{0,5}$/.test(item.id) || Number(item.id.slice(5)) >= draft.nextItemId! || ids.has(item.id)) return fail(`${label}：列表项目标识无效或重复。`);
    ids.add(item.id);
    const itemPath = [...path, 'items', index], itemLabel = `${label}第 ${index + 1} 项`;
    if (item.kind === 'object') {
      if (typeof item.text !== 'string' || typeof item.number !== 'string' || !['', 'true', 'false'].includes(item.boolean)) return fail(`${itemLabel}：填写类型无效。`);
      return readObject(item.rows!, itemLabel, [...itemPath, 'rows']);
    }
    return readScalar({ ...item, kind: item.kind }, itemLabel, itemPath);
  });
}
export function submitS2SimpleValueDraft(raw: S2SimpleValueDraft): S2Json {
  const draft = snapshotS2CompositeData(raw);
  if (!draft || typeof draft !== 'object' || Array.isArray(draft) || Object.keys(draft).some(key => !['kind', 'text', 'number', 'boolean', 'rows', 'records', 'nextRecordId', 'items', 'nextItemId'].includes(key))
    || !Array.isArray(draft.rows) || draft.rows.length > S2_SIMPLE_VALUE_MAX_FIELDS) return fail('常用输入草稿结构无效或字段过多。');
  let value: S2Json;
  const readItems = (list: S2SimpleListDraft, label: string, path: S2SimpleControlPath = []) => readList(list, label, path,
    (rows, itemLabel, itemPath) => readRows(rows, itemLabel, S2_SIMPLE_VALUE_MAX_GROUP_DEPTH, itemPath, true));
  function readRows(rows: S2SimpleValueDraft['rows'], label: string, depth = 0, controlPath: S2SimpleControlPath = ['rows'], scalarOnly = false): S2Json {
    if (!Array.isArray(rows) || rows.length > S2_SIMPLE_VALUE_MAX_FIELDS) return fail(`${label}：字段过多或结构无效。`);
    const names = new Set<string>();
    return Object.fromEntries(rows.map((row, index) => {
      if (!row || typeof row !== 'object' || Array.isArray(row) || Object.keys(row).some(key => !['name', 'kind', 'text', 'number', 'boolean', 'rows', 'items', 'nextItemId'].includes(key))
        || typeof row.name !== 'string') return fail(`第 ${index + 1} 项：字段名称无效。`);
      const fieldPath = [...controlPath, index];
      if (row.name.length > 200 || reserved.includes(row.name)) return invalidControl(`${label}第 ${index + 1} 项：字段名称无效。`, [...fieldPath, 'name']);
      if (names.has(row.name)) return invalidControl(`${label}第 ${index + 1} 项：字段名称重复，请修改名称；不会覆盖前一项。`, [...fieldPath, 'name']);
      names.add(row.name);
      const path = `${label}第 ${index + 1} 项${row.name ? `「${row.name}」` : ''}`;
      if (scalarOnly && (row.kind === 'list' || row.kind === 'object')) return fail(`${path}：列表中的多项内容仅支持普通字段；嵌套容器请用高级 JSON 完整编辑。`);
      if (row.kind === 'list') return [row.name, readItems(row, path, fieldPath)] as const;
      if (row.kind === 'object') {
        if (depth >= S2_SIMPLE_VALUE_MAX_GROUP_DEPTH) return fail(`${path}：信息分组过深，请使用高级 JSON 完整编辑。`);
        return [row.name, readRows(row.rows!, path, depth + 1, [...fieldPath, 'rows'])] as const;
      }
      return [row.name, readScalar(row as S2SimpleScalarDraft, path, fieldPath)] as const;
    }));
  }
  if (draft.kind === 'list') {
    value = readItems(draft, '列表');
  } else if (draft.kind === 'records') {
    if (!Array.isArray(draft.records) || draft.records.length > S2_SIMPLE_VALUE_MAX_RECORDS || !Number.isSafeInteger(draft.nextRecordId)
      || draft.nextRecordId! < 1 || draft.nextRecordId! > 1000000) return fail('记录列表草稿无效或记录过多；原草稿保留。');
    const ids = new Set<string>();
    value = draft.records.map((record, index) => {
      if (!record || typeof record !== 'object' || Array.isArray(record) || Object.keys(record).some(key => !['id', 'rows'].includes(key))
        || typeof record.id !== 'string' || !/^record-[1-9]\d{0,5}$/.test(record.id) || Number(record.id.slice(7)) >= draft.nextRecordId! || ids.has(record.id)) return fail('记录标识无效或重复。');
      ids.add(record.id); return readRows(record.rows, `第 ${index + 1} 条记录`, 0, ['records', index, 'rows']);
    });
  } else if (draft.kind === 'object') value = readRows(draft.rows, '内容');
  else value = readScalar(draft as S2SimpleScalarDraft, '内容');
  assertS2StructuredValue(value);
  return value;
}
