import { SHADOW_BEHAVIORS } from './rubric';
import { FLAT_BEHAVIOR_TRANSPORT, type ShadowWarning } from './types';

export type FlatBehaviorTransport = typeof FLAT_BEHAVIOR_TRANSPORT;
const strategies = SHADOW_BEHAVIORS.filter(b => b.dimension === 'strategy').map(b => b.code);
const ids = (value: unknown): value is string[] => Array.isArray(value) && value.length <= 20
  && value.every(id => typeof id === 'string' && id.length > 0 && id.length <= 200) && new Set(value).size === value.length;
const resolutions = ['single_pole', 'resolved', 'balanced', 'mixed', 'insufficient'];
const unknown = (code: string) => ({ code, state: 'uncertain', direction: null, evidenceIds: [],
  polarity: { negative: [], positive: [], resolution: 'insufficient' }, reason: '模型未完整声明该认知项；保留未知，不猜测方向。' });

/** Field assembly only. Never interpret reason text or invent polarity evidence/direction. */
export function restoreFlatBehaviorRows(rows: readonly unknown[]) {
  const warnings: ShadowWarning[] = [];
  const source = rows.map(row => row && typeof row === 'object' && !Array.isArray(row) ? row as Record<string, unknown> : row);
  const result: unknown[] = source.filter(row => !strategies.includes((row as { code?: any })?.code));
  for (const code of strategies) {
    const matches = source.filter(row => (row as { code?: unknown })?.code === code) as Record<string, unknown>[];
    if (matches.length !== 1) {
      warnings.push({ code: matches.length ? 'cognitive_transport_duplicate' : 'cognitive_transport_missing', target: code,
        message: '固定认知项缺失或重复，仅保留不确定项，不阻断图、不凑方向。' });
      result.push(unknown(code)); continue;
    }
    const row = matches[0];
    const flat = ['negativeEvidenceIds', 'positiveEvidenceIds', 'resolution'].some(key => Object.hasOwn(row, key));
    if (!flat && row.polarity && typeof row.polarity === 'object') {
      // Narrow backwards-compatible wire fallback; the existing audit still validates every ID/state.
      warnings.push({ code: 'cognitive_transport_legacy', target: code, message: '本次返回了旧嵌套格式，保留其显式声明并按同一证据契约核对；未推断字段。' });
      result.push({ ...row }); continue;
    }
    const valid = flat && ids(row.negativeEvidenceIds) && ids(row.positiveEvidenceIds) && resolutions.includes(String(row.resolution))
      && ['observed', 'not_observed', 'uncertain'].includes(String(row.state))
      && (row.contextEvidenceIds === undefined || ids(row.contextEvidenceIds))
      && (row.direction === null || [-2, -1, 0, 1, 2].includes(row.direction as number))
      && typeof row.reason === 'string' && row.reason.trim().length > 0 && row.reason.length <= 1000
      && (row.state === 'observed' || row.direction === null && row.resolution === 'insufficient')
      && (row.state !== 'not_observed' || (row.negativeEvidenceIds as string[]).length === 0 && (row.positiveEvidenceIds as string[]).length === 0);
    if (!valid) {
      warnings.push({ code: 'cognitive_transport_invalid', target: code, message: '认知扁平字段不完整或无效，仅保留未知；本地不从理由中猜两极。' });
      result.push(unknown(code)); continue;
    }
    const polarity = { negative: [...row.negativeEvidenceIds as string[]], positive: [...row.positiveEvidenceIds as string[]], resolution: row.resolution };
    const evidenceIds = [...new Set([...polarity.negative, ...polarity.positive, ...((row.contextEvidenceIds as string[] | undefined) || [])])];
    if (row.evidenceIds !== undefined && (!ids(row.evidenceIds) || JSON.stringify([...row.evidenceIds].sort()) !== JSON.stringify([...evidenceIds].sort()))) {
      warnings.push({ code: 'cognitive_transport_conflict', target: code, message: '重复填写的证据总表与两极/上下文证据不一致，仅保留未知。' });
      result.push(unknown(code)); continue;
    }
    const nested = row.polarity as { negative?: unknown; positive?: unknown; resolution?: unknown } | null | undefined;
    const sameIds = (a: unknown, b: string[]) => ids(a) && JSON.stringify([...a].sort()) === JSON.stringify([...b].sort());
    if (row.polarity !== undefined && (!nested || !sameIds(nested.negative, polarity.negative) || !sameIds(nested.positive, polarity.positive)
      || nested.resolution !== polarity.resolution)) {
      warnings.push({ code: 'cognitive_transport_conflict', target: code, message: '新旧两套认知字段冲突，仅暂缓该方向，不选择其中一套。' });
      result.push(unknown(code)); continue;
    }
    const { negativeEvidenceIds, positiveEvidenceIds, contextEvidenceIds, resolution, ...rest } = row;
    result.push({ ...rest, evidenceIds, polarity });
  }
  return { rows: result, warnings };
}
