import type { S2ChartView, S2Field, S2TableColumn } from '../../types/sceneS2';
import type { S2Json } from '../../types/sceneS2Plugin';
import { assertS2StructuredValue } from './sceneS2PluginProtocol';
import { throwS2ControlIssue, type S2ControlPath } from './sceneS2ControlIssue';

const forbidden = ['__proto__', 'constructor', 'prototype'];
function object(raw: unknown): Record<string, unknown> {
  if (!raw || typeof raw !== 'object' || Object.prototype.toString.call(raw) !== '[object Object]' || Reflect.ownKeys(raw).some(key => typeof key !== 'string' || forbidden.includes(key))) throw new Error('表格声明需要无保留键的对象');
  return raw as Record<string, unknown>;
}
function keys(obj: Record<string, unknown>, allowed: string[]) { if (Object.keys(obj).some(key => !allowed.includes(key))) throw new Error('表格声明含未知属性'); }
export function readS2TableColumns(raw: unknown): S2TableColumn[] {
  if (!Array.isArray(raw) || !raw.length || raw.length > 8) throw new Error('编辑表格需要 1–8 列');
  const result = raw.map(item => {
    const v = object(item); keys(v, ['id', 'label', 'type', 'required', 'nullable']);
    if (typeof v.id !== 'string' || !/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(v.id) || forbidden.includes(v.id)
      || typeof v.label !== 'string' || !v.label.trim() || v.label.length > 80 || typeof v.type !== 'string' || !['string', 'number', 'boolean'].includes(v.type)) throw new Error('表格列标识、标签或类型无效');
    for (const key of ['required', 'nullable']) if (v[key] !== undefined && typeof v[key] !== 'boolean') throw new Error('表格列约束需要布尔值');
    return { id: v.id, label: v.label, type: v.type, ...(v.required !== undefined ? { required: v.required } : {}), ...(v.nullable !== undefined ? { nullable: v.nullable } : {}) } as S2TableColumn;
  });
  if (new Set(result.map(c => c.id)).size !== result.length) throw new Error('表格列重复'); return result;
}
export function readS2ChartView(raw: unknown, columns: S2TableColumn[]): S2ChartView {
  const v = object(raw); keys(v, ['kind', 'xKey', 'yKey']);
  if (typeof v.kind !== 'string' || !['bar', 'line'].includes(v.kind) || !columns.some(c => c.id === v.xKey) || !columns.some(c => c.id === v.yKey && c.type === 'number')) throw new Error('图表需要已声明的横轴列和数值纵轴列');
  return { kind: v.kind as S2ChartView['kind'], xKey: v.xKey as string, yKey: v.yKey as string };
}
export function validateS2TableRows(field: S2Field, raw: unknown, path?: S2ControlPath): asserts raw is Array<Record<string, S2Json>> {
  assertS2StructuredValue(raw);
  if (!Array.isArray(raw) || raw.length < (field.minItems ?? 0) || raw.length > (field.maxItems ?? 32)) {
    throwS2ControlIssue('表格行数不满足范围', path && Array.isArray(raw) && raw.length < (field.minItems ?? 0) ? [...path, 'add'] : undefined);
  }
  for (const [i, item] of raw.entries()) {
    const row = object(item); keys(row, field.columns!.map(c => c.id));
    for (const col of field.columns!) {
      if (!Object.hasOwn(row, col.id)) { if (col.required) throwS2ControlIssue(`${col.label}：单元格不能缺失`, path && [...path, 'cells', i, col.id, 'state']); continue; }
      const value = row[col.id];
      if (value === null ? !col.nullable : typeof value !== col.type || typeof value === 'number' && !Number.isFinite(value)) throwS2ControlIssue(`${col.label}：单元格类型不符`, path && [...path, 'cells', i, col.id, value === null ? 'state' : 'text']);
      if (new TextEncoder().encode(JSON.stringify(value)).byteLength > 2000) throwS2ControlIssue(`${col.label}：单元格超过表格传输上限`, path && [...path, 'cells', i, col.id, 'text']);
    }
  }
}
export type S2TableCellDraft = { state: 'missing' | 'null' | 'value'; text: string };
export type S2TableDraft = Array<Record<string, S2TableCellDraft>>;
export function s2TableDraft(field: S2Field, rows: Array<Record<string, S2Json>>): S2TableDraft {
  return rows.map(row => Object.fromEntries(field.columns!.map(col => {
    const has = Object.hasOwn(row, col.id), value = row[col.id];
    return [col.id, { state: !has ? 'missing' : value === null ? 'null' : 'value', text: has && value !== null ? String(value) : '' }];
  })));
}
export function s2TableDraftValue(field: S2Field, draft: S2TableDraft, path?: S2ControlPath): Array<Record<string, S2Json>> {
  const rows = draft.map((row, i) => Object.fromEntries(field.columns!.flatMap(col => {
    const cell = row[col.id];
    if (!cell || !['missing', 'null', 'value'].includes(cell.state)) throw new Error('表格草稿状态无效');
    if (cell.state === 'missing') return [];
    if (cell.state === 'null') return [[col.id, null]];
    if (typeof cell.text !== 'string') throw new Error('单元格草稿必须是文本');
    let value: S2Json = cell.text;
    if (col.type !== 'string') { try { value = JSON.parse(cell.text); } catch { throwS2ControlIssue(`${col.label}：需要完整的${col.type === 'number' ? '数字' : '布尔值'}`, path && [...path, 'cells', i, col.id, 'text']); } }
    if (typeof value !== col.type) throwS2ControlIssue(`${col.label}：有值状态必须填写声明的${col.type}类型，null请显式选择`, path && [...path, 'cells', i, col.id, 'text']);
    return [[col.id, value]];
  })));
  validateS2TableRows(field, rows, path); return rows;
}
/** Chart coordinates preserve source row order; missing/null observations remain gaps. */
export function s2ChartPoints(field: S2Field, rows: Array<Record<string, S2Json>>) {
  validateS2TableRows(field, rows);
  if (!field.view) throw new Error('未声明图表');
  return s2ChartRecordPoints(rows, field.view);
}
/** Also supports complete immutable table artifacts (up to their 100-row contract). */
export function s2ChartRecordPoints(rows: Array<Record<string, S2Json>>, view: S2ChartView) {
  if (rows.length > 100 || forbidden.includes(view.xKey) || forbidden.includes(view.yKey)) throw new Error('图表数据或字段超出范围');
  const values = rows.map(row => Object.hasOwn(row, view.yKey) ? row[view.yKey] : undefined);
  if (values.some(value => value !== null && value !== undefined && (typeof value !== 'number' || !Number.isFinite(value)))) throw new Error('图表纵轴需要数值、null或缺失');
  const scale = Math.max(1, ...values.filter((v): v is number => typeof v === 'number').map(Math.abs));
  const normalized = values.map(v => typeof v === 'number' ? v / scale : null);
  const low = Math.min(0, ...normalized.filter((v): v is number => v !== null)), high = Math.max(0, ...normalized.filter((v): v is number => v !== null));
  const y = (v: number) => 150 - (v - low) / (high - low || 1) * 130;
  return { baseline: y(0), points: rows.map((row, i) => ({ x: 24 + (i + 0.5) * 352 / Math.max(1, rows.length),
    y: normalized[i] === null ? null : y(normalized[i]!), label: Object.hasOwn(row, view.xKey) ? JSON.stringify(row[view.xKey]) : '缺失', value: values[i] })) };
}
