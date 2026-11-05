/** Narrow syntax recovery for a complete JSON object followed ONLY by redundant
 * closing braces. Never repairs internal structure, values or truncated output.
 * Callers must reject a provider length stop BEFORE using this helper. */
export function recoverS2RedundantObjectClosers(output: string): Record<string, unknown> | undefined {
  if (output.length > 64000) return undefined;
  let prefix = output.trimEnd();
  for (let removed = 0; removed < 3 && prefix.endsWith('}'); removed++) {
    prefix = prefix.slice(0, -1).trimEnd();
    try {
      const value = JSON.parse(prefix);
      if (value && typeof value === 'object' && !Array.isArray(value)) return value;
    } catch { /* Only a strict, fully parsed object prefix is acceptable. */ }
  }
  return undefined;
}
