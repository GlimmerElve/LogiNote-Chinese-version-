/**
 * Unicode 文本清洗工具 — 清除孤立 UTF-16 代理项。
 *
 * 背景：JS 字符串按 UTF-16 编码，emoji 等增补平面字符由「高代理项 + 低代理项」配对表示。
 * 当文本在读取、语音转写或历史数据中发生截断/损坏时，可能只剩半个代理项（孤立代理项）。
 * JSON.stringify 会将其转义为 \udXXX，这在 JSON 语法上合法，但 DeepSeek 后端（Go 标准库
 * encoding/json）会拒绝解析并返回 400：`lone leading surrogate in hex escape`。
 *
 * 此函数在 JSON.stringify 之前对用户可见文本做兜底清洗：
 * - 合法的代理对（完整 emoji 等）保持不变；
 * - 孤立的高/低代理项替换为 U+FFFD（替换字符）。
 */

/** 清洗单个字符串中的孤立代理项 */
export function sanitizeUnicode(input: string): string {
  if (!input) return input;

  let out = '';
  for (let i = 0; i < input.length; i++) {
    const code = input.charCodeAt(i);

    if (code >= 0xd800 && code <= 0xdbff) {
      // 高代理项：尝试与下一个字符配对
      const next = input.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        out += input.charAt(i) + input.charAt(i + 1);
        i++; // 跳过已配对低代理项
      } else {
        out += '\uFFFD'; // 孤立高代理项
      }
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      out += '\uFFFD'; // 孤立低代理项
    } else {
      out += input.charAt(i);
    }
  }

  return out;
}

/** 清洗任意嵌套结构中的字符串（对象 / 数组 / 字符串），返回清洗后的新值 */
export function sanitizeUnicodeDeep<T>(value: T): T {
  if (typeof value === 'string') {
    return sanitizeUnicode(value) as unknown as T;
  }
  if (Array.isArray(value)) {
    return value.map((v) => sanitizeUnicodeDeep(v)) as unknown as T;
  }
  if (value && typeof value === 'object') {
    const result: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>)) {
      result[key] = sanitizeUnicodeDeep((value as Record<string, unknown>)[key]);
    }
    return result as unknown as T;
  }
  return value;
}