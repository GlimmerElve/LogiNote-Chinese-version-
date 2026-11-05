/** 把调用方的短上下文转成显式输入；限制体积，避免整个笔记库被误塞进单次请求。 */
export function buildCallContext(context?: Record<string, string>): string {
  if (!context) return '';
  const entries = Object.entries(context)
    .filter(([, value]) => typeof value === 'string' && value.trim())
    .map(([key, value]) => `${key}：${value.trim().slice(0, 4000)}`);
  return entries.length > 0 ? `【调用上下文】\n${entries.join('\n').slice(0, 6000)}` : '';
}
