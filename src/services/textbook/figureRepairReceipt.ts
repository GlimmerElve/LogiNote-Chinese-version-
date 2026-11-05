export const FIGURE_REPAIR_WARNINGS = ['gear-contact','prediction-consistency','budget-readout','axis-scale','chart-overflow'] as const;
export type FigureRepairWarning = typeof FIGURE_REPAIR_WARNINGS[number];
export type FigureRepairReason = 'no-issue'|'verified'|'unsupported'|'diagnostic-unavailable'|'model-unavailable'|'truncated'|'invalid-output'|'no-change'|'invalid-patch'|'runtime-failed'|'verification-failed';
/** Internal bounded receipt; it records an attempt, never learning outcomes. */
export interface FigureRepairReceipt {
  version: 1;
  status: 'clean'|'repaired'|'unresolved'|'unavailable';
  reason: FigureRepairReason;
  warnings: FigureRepairWarning[];
  requested: boolean;
}
export function validateFigureRepairReceipt(value: unknown): FigureRepairReceipt {
  const item=value as FigureRepairReceipt | null;
  if(!item || item.version!==1 || !['clean','repaired','unresolved','unavailable'].includes(item.status)
    || !['no-issue','verified','unsupported','diagnostic-unavailable','model-unavailable','truncated','invalid-output','no-change','invalid-patch','runtime-failed','verification-failed'].includes(item.reason)
    || typeof item.requested!=='boolean' || !Array.isArray(item.warnings) || item.warnings.length>5
    || new Set(item.warnings).size!==item.warnings.length || item.warnings.some(w=>!FIGURE_REPAIR_WARNINGS.includes(w))) throw Error('交互图修复记录无效');
  return {version:1,status:item.status,reason:item.reason,warnings:[...item.warnings],requested:item.requested};
}
