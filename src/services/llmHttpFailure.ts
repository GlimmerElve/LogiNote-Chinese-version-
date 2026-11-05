/** Only allowlisted diagnostic categories cross IPC/UI; never echo a provider body. */
const DETAILS = {
  'json-mode-instruction': 'JSON 输出模式要求提示词明确包含 JSON 指令。',
  'response-format-unsupported': '模型服务不支持所请求的结构化输出格式。',
  'context-too-long': '请求上下文超过模型允许的长度。',
  'max-tokens-invalid': '模型服务拒绝了输出 token 上限参数。',
  'model-invalid': '模型服务不接受所选模型标识。',
  'parameter-invalid': '模型服务拒绝了请求中的参数。',
  'authentication': '模型服务拒绝了身份验证或访问权限。',
  'quota': '模型服务额度不足。',
  'rate-limit': '模型服务触发了请求频率限制。',
  'upstream-failure': '模型服务暂时无法处理请求。',
  'unknown': '模型服务拒绝了请求，但未识别到可安全展示的具体原因。',
} as const;
export type LlmHttpFailureReason = keyof typeof DETAILS;

export function safeLlmHttpError(status: number, raw: string): Error {
  let reason: LlmHttpFailureReason = 'unknown';
  // Raw text is inspected locally only; generated messages below contain fixed strings.
  if (status === 401 || status === 403) reason = 'authentication';
  else if (status === 402) reason = 'quota';
  else if (status === 429) reason = 'rate-limit';
  else if (status >= 500) reason = 'upstream-failure';
  else if (status === 400 || status === 422 || status === 404) {
    const message = raw.slice(0, 16000);
    if (/(?:messages?|prompts?)[\s\S]*(?:contain|include|mention)[\s\S]*json/iu.test(message)) reason = 'json-mode-instruction';
    else if (/response_format/iu.test(message) && /not supported|unsupported|must be|invalid/iu.test(message)) reason = 'response-format-unsupported';
    else if (/context_length_exceeded|context.*(?:length|limit)|too many tokens|input.*too long/iu.test(message)) reason = 'context-too-long';
    else if (/max_tokens|max_completion_tokens|max_output_tokens/iu.test(message)) reason = 'max-tokens-invalid';
    else if (/model_not_found|invalid_model|model[\s\S]*(?:not found|does not exist|invalid)|invalid[\s\S]*model/iu.test(message)) reason = 'model-invalid';
    else if (/invalid_parameter|invalid_request_error|unsupported_parameter/iu.test(message)) reason = 'parameter-invalid';
  }
  return new Error(`LLM_HTTP_ERROR (${status}) [llm:${reason}]: ${DETAILS[reason]}`);
}

/** Electron may discard custom Error fields; recognize only our fixed, safe marker. */
export function readSafeLlmHttpFailure(message: string): { reason: LlmHttpFailureReason; detail: string } | undefined {
  const match = /LLM_HTTP_ERROR \([45]\d\d\) \[llm:([a-z-]+)\]/u.exec(message);
  if (!match || !Object.prototype.hasOwnProperty.call(DETAILS, match[1])) return undefined;
  const reason = match[1] as LlmHttpFailureReason;
  return { reason, detail: DETAILS[reason] };
}
