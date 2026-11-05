/**
 * 跨供应商的结构化输出声明。
 *
 * 当前传输层把非空 outputSchema 解释为“必须返回一个 JSON 对象”。
 * 这里提供唯一常量，避免各工作流继续用 `{}`（Electron 端会把空对象
 * 当作未启用结构化输出）。具体字段仍由工作流提示词和运行时解析器校验。
 */
export const JSON_OBJECT_OUTPUT = Object.freeze({ type: 'object' as const });

export function requestsJsonObject(schema?: object): boolean {
  return Boolean(schema && Object.keys(schema).length > 0);
}

/** JSON mode is an API contract, not just a response parser preference. */
export function ensureJsonObjectPrompt(systemPrompt: string, schema?: object): string {
  if (!requestsJsonObject(schema) || /\bjson\b/iu.test(systemPrompt)) return systemPrompt;
  return `${systemPrompt}\nReturn exactly one valid JSON object. Do not include Markdown fences or explanatory text.`;
}
