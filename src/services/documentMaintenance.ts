import type { UploadedDocument } from '../types';
export const DOCUMENT_MAINTENANCE_TOOLS = ['update_document_categories', 'start_document_processing'] as const;

/** Shared by renderer approvals and main-process admission. Never accepts paths. */
export function documentMaintenanceIdentity(doc: UploadedDocument): string {
  return JSON.stringify([doc.id, doc.fileName, doc.extension, doc.size, doc.uploadAt,
    doc.category || '', doc.indexable, doc.status, doc.parseStatus || '', doc.parsedAt || '',
    doc.knowledgeGenerationId || '', doc.documentGraphProgress || null]);
}
export interface DocumentMaintenanceCommand {
  documentId: string;
  expectedContext: string;
  expectedIdentity: string;
  operation: 'category' | 'body-index';
  category?: string;
}
export function validateDocumentMaintenance(input: DocumentMaintenanceCommand, doc: UploadedDocument | undefined, context: string): void {
  if (!input || Object.keys(input).some(key => !['documentId', 'expectedContext', 'expectedIdentity', 'operation', 'category'].includes(key))
    || !['category', 'body-index'].includes(input.operation) || typeof input.documentId !== 'string'
    || typeof input.expectedContext !== 'string' || typeof input.expectedIdentity !== 'string') throw new Error('资料维护参数无效');
  if (context !== input.expectedContext || !doc || doc.id !== input.documentId
    || documentMaintenanceIdentity(doc) !== input.expectedIdentity) throw new Error('资料库、资料版本或分类已变化，请重新查询并确认；未执行维护');
  if (input.operation === 'category') {
    if (typeof input.category !== 'string' || input.category.length > 80 || input.category !== input.category.trim()
      || /[\u0000-\u001f\u007f]/u.test(input.category)) throw new Error('分类须为至多80字的名称，空字符串表示取消分类');
  } else if (input.category !== undefined || !doc.indexable || ['pending', 'processing'].includes(doc.status)
    || ['pending', 'processing'].includes(doc.parseStatus || '')) throw new Error('资料不可重建或正文已在处理，未重复入队');
}
