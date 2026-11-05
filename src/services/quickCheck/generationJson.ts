/** Only repair a trailing comma outside strings. Never guess fields, quotes,
 * answers, evidence or missing closing brackets, and never evaluate model code. */
export function parseQuickCheckJson(raw: unknown): Record<string, unknown> {
  const object = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : {};
  if (typeof raw !== 'string') return object(raw);
  const source = raw.trim().replace(/^```(?:json)?\s*/iu, '').replace(/\s*```$/u, '');
  const fail = (cause?: unknown) => {
    const position = cause instanceof Error ? /position (\d+)/u.exec(cause.message)?.[1] : undefined;
    const location = position ? `（JSON位置${position}）` : '';
    return new Error(`模型返回的格式不完整${location}，本次未更新掌握状态；原作答保留，请重试，或稍后继续。`);
  };
  if (source.length > 100_000) throw fail();
  try { return object(JSON.parse(source)); } catch { /* Try the single non-semantic repair below. */ }
  let repaired = '', inString = false, escaped = false;
  for (let index = 0; index < source.length; index++) {
    const char = source[index];
    if (inString) {
      repaired += char;
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') inString = false;
    } else if (char === '"') { inString = true; repaired += char; }
    else if (char === ',') {
      let next = index + 1;
      while (/\s/u.test(source[next] || '') && next < source.length) next++;
      if (source[next] !== '}' && source[next] !== ']') repaired += char;
    } else repaired += char;
  }
  try { return object(JSON.parse(repaired)); } catch (error) { throw fail(error); }
}
