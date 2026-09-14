/**
 * 论证结构 → JSON 导出（完整 ArgDoc 序列化，供备份/恢复）
 */
import type { ArgDoc } from '../../../services/argumentDoc/types';

export function exportJSON(doc: ArgDoc): string {
  return JSON.stringify(doc, null, 2);
}