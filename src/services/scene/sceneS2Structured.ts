import type { S2Artifact, S2Json, S2PluginInvocation } from '../../types/sceneS2Plugin';
import { canonicalS2Json, readS2Artifact } from './sceneS2PluginProtocol';
import { s2BuiltinPluginRegistry } from './sceneS2PluginRegistry';

export type S2Table = { columns: string[]; rows: Array<Array<{ present: boolean; value: S2Json }>> };
const scalar = (value: S2Json) => value === null || ['string', 'number', 'boolean'].includes(typeof value);
type S2TableFailureReason = 'table-records-required' | 'table-row-limit' | 'table-column-limit' | 'table-column-name-limit' | 'table-nested-cell';
/** Categorize the original rejection at its check; keep the converter's error text and fail-closed behavior. */
class S2TableConversionError extends Error {
  constructor(public readonly reason: S2TableFailureReason, message: string) { super(message); }
}
export function recordsToS2Table(value: S2Json): S2Table {
  const recordsMessage = '转表格需要最多100行的记录数组；请先用 select 提取数组';
  if (!Array.isArray(value)) throw new S2TableConversionError('table-records-required', recordsMessage);
  if (value.length > 100) throw new S2TableConversionError('table-row-limit', recordsMessage);
  if (value.some(row => !row || typeof row !== 'object' || Array.isArray(row))) throw new S2TableConversionError('table-records-required', recordsMessage);
  const records = value as Record<string, S2Json>[], columns = [...new Set(records.flatMap(row => Object.keys(row)))];
  if (columns.length > 24) throw new S2TableConversionError('table-column-limit', '表格最多24列，列名最多120字');
  if (columns.some(key => key.length > 120)) throw new S2TableConversionError('table-column-name-limit', '表格最多24列，列名最多120字');
  return { columns, rows: records.map(row => columns.map(key => {
    const present = Object.hasOwn(row, key), cell = present ? row[key] : null;
    if (!scalar(cell)) throw new S2TableConversionError('table-nested-cell', `列 ${key} 包含嵌套值；请显式提取或转换，不能自动压平`);
    return { present, value: cell };
  })) };
}
export function s2TableToRecords(table: S2Table): S2Json {
  if (new Set(table.columns).size !== table.columns.length || table.columns.some(key => ['__proto__', 'constructor', 'prototype'].includes(key))
    || table.rows.some(row => row.length !== table.columns.length || row.some(cell => !scalar(cell.value) || !cell.present && cell.value !== null))) throw new Error('表格列、行宽、单元格或缺失值契约无效');
  return table.rows.map(row => Object.fromEntries(row.flatMap((cell, i) => cell.present ? [[table.columns[i], cell.value]] : [])));
}
/** Native pointer failure category for host diagnostics. Message/name and non-condition converter behavior remain unchanged. */
export class S2PointerAccessError extends Error {
  constructor(public readonly reason: 'missing' | 'inaccessible', public readonly pointer: string) {
    super(`JSON Pointer 路径不存在或不能访问：${pointer.slice(0, 200)}`);
  }
}
export class S2PointerSyntaxError extends Error {
  constructor() { super('需要标准 JSON Pointer，例如 /items/0；不支持表达式或猜测路径'); }
}
export function selectS2Pointer(value: S2Json, pointer: string): S2Json {
  if (pointer === '') return value;
  if (!pointer.startsWith('/') || /~(?![01])/u.test(pointer)) throw new S2PointerSyntaxError();
  let current = value;
  for (const encoded of pointer.slice(1).split('/')) {
    const key = encoded.replace(/~1/g, '/').replace(/~0/g, '~');
    const inaccessible = ['__proto__', 'constructor', 'prototype'].includes(key) || Array.isArray(current) && !/^(0|[1-9]\d*)$/.test(key);
    if (!current || typeof current !== 'object' || !Object.hasOwn(current, key) || inaccessible)
      throw new S2PointerAccessError(inaccessible ? 'inaccessible' : 'missing', pointer);
    current = (current as Record<string, S2Json>)[key];
  }
  return current;
}
export type S2StructuredFailureDiagnostic = { kind: 'structured-transform';
  reason: 'json-syntax' | 'pointer-syntax' | 'pointer-missing' | 'pointer-inaccessible' | S2TableFailureReason; inputPortIds: string[] };
const structuredFailures = new WeakMap<object, { call: string; inputs: string; outcome: string; diagnostic: S2StructuredFailureDiagnostic }>();
/** Hash inert complete snapshots without invoking getters/toJSON. Private records retain only digests, not material bodies.
 * A metadata limitation must never alter the converter's existing outcome or protocol validation behavior. */
async function failureFingerprint(raw: unknown): Promise<string> {
  let entries = 0;
  const visit = (value: unknown, depth: number): string => {
    if (++entries > 48000 || depth > 24) throw new Error('Diagnostic snapshot exceeds bounds');
    if (value === null || typeof value === 'string' || typeof value === 'boolean' || typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value);
    if (!value || typeof value !== 'object') throw new Error('Diagnostic snapshot requires inert JSON');
    const descriptors = Object.getOwnPropertyDescriptors(value), keys = Reflect.ownKeys(descriptors);
    if (Array.isArray(value)) {
      if (Object.getPrototypeOf(value) !== Array.prototype || value.length > 48000 || keys.length !== value.length + 1) throw new Error('Invalid diagnostic array');
      return `[${Array.from({ length: value.length }, (_, index) => {
        const property = descriptors[String(index)];
        if (!property?.enumerable || !('value' in property)) throw new Error('Invalid diagnostic array entry');
        return visit(property.value, depth + 1);
      }).join(',')}]`;
    }
    if (![Object.prototype, null].includes(Object.getPrototypeOf(value)) || keys.some(key => typeof key !== 'string')) throw new Error('Invalid diagnostic object');
    return `{${(keys as string[]).sort().map(key => {
      const property = descriptors[key];
      if (!property.enumerable || !('value' in property)) throw new Error('Invalid diagnostic property');
      return `${JSON.stringify(key)}:${visit(property.value, depth + 1)}`;
    }).join(',')}}`;
  };
  const bytes = new TextEncoder().encode(visit(raw, 0));
  if (bytes.byteLength > 786432) throw new Error('Diagnostic snapshot exceeds byte bounds');
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
}
/** Host-only evidence lookup after normal outcome validation, not an imported error-code classifier. */
export async function readS2StructuredFailureDiagnostic(call: S2PluginInvocation, inputs: Record<string, S2Json[]>, rawOutcome: unknown,
  validatedOutcome: unknown): Promise<S2StructuredFailureDiagnostic | null> {
  if (!rawOutcome || typeof rawOutcome !== 'object') return null;
  const stored = structuredFailures.get(rawOutcome); if (!stored) return null;
  try {
    const [callKey, inputsKey, rawKey, validatedKey] = await Promise.all([
      failureFingerprint(call), failureFingerprint(inputs), failureFingerprint(rawOutcome), failureFingerprint(validatedOutcome),
    ]);
    return callKey === stored.call && inputsKey === stored.inputs && rawKey === stored.outcome && validatedKey === stored.outcome
      ? structuredClone(stored.diagnostic) : null;
  } catch { return null; }
}
export async function executeS2Structured(call: S2PluginInvocation, inputs: Record<string, S2Json[]>) {
  if (call.pluginId !== 'structured-data' || call.pluginVersion !== '1.0.0') throw new Error('未安装此转换执行器');
  let value: S2Json, port: string, type: string;
  let diagnostic: S2StructuredFailureDiagnostic | undefined;
  try {
    switch (call.capabilityId) {
      case 'parse-json':
        try { value = JSON.parse(inputs.text[0] as string); }
        catch (error) {
          if (typeof inputs.text[0] === 'string' && error instanceof SyntaxError) diagnostic = { kind: 'structured-transform', reason: 'json-syntax', inputPortIds: ['text'] };
          throw error;
        }
        port = 'value'; type = 'structured-data.value'; break;
      case 'select':
        try { value = selectS2Pointer(inputs.value[0], inputs.pointer[0] as string); }
        catch (error) {
          if (error instanceof S2PointerSyntaxError) diagnostic = { kind: 'structured-transform', reason: 'pointer-syntax', inputPortIds: ['pointer'] };
          else if (error instanceof S2PointerAccessError) diagnostic = { kind: 'structured-transform', reason: error.reason === 'missing' ? 'pointer-missing' : 'pointer-inaccessible', inputPortIds: ['value', 'pointer'] };
          throw error;
        }
        port = 'value'; type = 'structured-data.value'; break;
      case 'stringify': value = canonicalS2Json(inputs.value[0]); port = 'text'; type = 'core.text'; break;
      case 'to-table':
        try { value = recordsToS2Table(inputs.value[0]) as unknown as S2Json; }
        catch (error) {
          if (error instanceof S2TableConversionError) diagnostic = { kind: 'structured-transform', reason: error.reason, inputPortIds: ['value'] };
          throw error;
        }
        port = 'table'; type = 'structured-data.table'; break;
      case 'table-to-json': value = s2TableToRecords(inputs.table[0] as unknown as S2Table); port = 'value'; type = 'structured-data.value'; break;
      default: throw new Error('未知转换能力');
    }
    const artifact: S2Artifact = { protocolVersion: 1, id: `artifact-${crypto.randomUUID()}`, type: { id: type, version: 1 }, complete: true,
      source: { sceneId: call.sceneId, runId: call.runId, nodeId: call.nodeId, revision: call.revision, kind: 'plugin', invocationId: call.id }, payload: { kind: 'inline', value } };
    readS2Artifact(s2BuiltinPluginRegistry(), artifact); // Semantic safety/size validation; never publish a partial conversion.
    return { status: 'succeeded', outputs: { [port]: [artifact] } };
  } catch (error) {
    const outcome = { status: 'failed', outputs: {}, error: { code: 'TRANSFORM_REJECTED', message: (error instanceof Error ? error.message : '转换失败').slice(0, 1000) } };
    if (diagnostic) {
      try {
        const [callKey, inputsKey, outcomeKey] = await Promise.all([failureFingerprint(call), failureFingerprint(inputs), failureFingerprint(outcome)]);
        structuredFailures.set(outcome, { call: callKey, inputs: inputsKey, outcome: outcomeKey, diagnostic });
      } catch { /* Optional metadata must not replace the native failure. */ }
    }
    return outcome;
  }
}
