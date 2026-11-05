import type { S2Field } from '../../types/sceneS2';

/** Read-only descriptions of existing validation/UI bounds, never new business rules. */
export function s2FieldRequirement(field: S2Field): string {
  if (field.kind === 'number') {
    const type = field.integer ? '填写整数' : '填写数字';
    if (field.min !== undefined && field.max !== undefined) return field.min === field.max
      ? `${type}，只能为 ${field.min}。` : `${type}，范围 ${field.min}～${field.max}（含边界）。`;
    if (field.min !== undefined) return `${type}，不小于 ${field.min}。`;
    if (field.max !== undefined) return `${type}，不大于 ${field.max}。`;
    return `${type}。`;
  }
  if (['text', 'multiline', 'code'].includes(field.kind)) return `${field.required ? '必填，不能只填空格；' : ''}最多 ${field.maxLength ?? 6000} 个字符（表情等可能占多个字符）。`;
  if (field.kind === 'list' || field.kind === 'table') {
    const min = field.minItems ?? 0, max = field.maxItems ?? 32, unit = field.kind === 'table' ? '行' : '项';
    return min === max ? `需要 ${min} ${unit}。` : min === 0 ? `可为 0 ${unit}，最多 ${max} ${unit}。` : `至少 ${min} ${unit}，最多 ${max} ${unit}。`;
  }
  if (field.kind === 'boolean') return '请选择“是”或“否”；“否”也是已填写的内容。';
  if (field.kind === 'enum') return '使用列表中已有的选项。';
  if (field.kind === 'json') return '填写完整 JSON，保留文字、数字、是／否和空值的区别；此输入框最多 6000 个字符。';
  return '';
}
