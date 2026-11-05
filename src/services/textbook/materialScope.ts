import type { MaterialErrorCode, MaterialScope } from './materialTypes.ts';

export class MaterialError extends Error {
  readonly code: MaterialErrorCode;
  constructor(code: MaterialErrorCode, message: string) { super(message); this.code = code; }
}
export function validMaterialDocId(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u.test(value);
}
/** 缺省范围绝不等于全库；共享于 scoped RAG 和直读后端，不能事后过滤全库命中。 */
export function materialDocIds(scope: MaterialScope): string[] {
  if (!scope || !Array.isArray(scope.allowedDocIds) || scope.allowedDocIds.length > 256
    || scope.allowedDocIds.some((id) => !validMaterialDocId(id))) {
    throw new MaterialError('INVALID_REQUEST', '物料读取需要明确且有效的允许文档范围');
  }
  return [...new Set(scope.allowedDocIds)];
}
export function assertMaterialDocument(scope: MaterialScope, docId: string): void {
  const ids = materialDocIds(scope);
  if (!validMaterialDocId(docId)) throw new MaterialError('INVALID_REQUEST', '无效的资料 ID');
  if (!ids.includes(docId)) throw new MaterialError('OUT_OF_SCOPE', '资料不在本次允许读取的范围内');
}
