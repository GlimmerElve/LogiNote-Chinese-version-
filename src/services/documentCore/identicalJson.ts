export interface IdenticalJsonCoalescence { path: string; key: string; position: number; action: 'coalesce_identical' }

/** Narrow JSON normalisation: identical duplicate values only, never last-value-wins. */
export function parseIdenticalCoreJson(raw: string): { value: any; coalesced: IdenticalJsonCoalescence[] } {
  if (typeof raw !== 'string' || raw.length > 100000) throw new Error('响应为空或超过预算');
  const original = JSON.parse(raw); // Syntax validation, not duplicate-key selection.
  let position = 0, nodes = 0;
  const coalesced: IdenticalJsonCoalescence[] = [];
  const whitespace = () => { while (/\s/u.test(raw[position] || '') && position < raw.length) position++; };
  const string = () => {
    const start = position++;
    while (position < raw.length) {
      if (raw[position] === '\\') position += 2;
      else if (raw[position++] === '"') return JSON.parse(raw.slice(start, position)) as string;
    }
    throw new Error('JSON字符串未结束');
  };
  function value(path: string, depth: number): string {
    if (depth > 128 || ++nodes > 20000) throw new Error('JSON嵌套或节点预算超限');
    whitespace(); const start = position;
    if (raw[position] === '{') {
      position++; whitespace(); const fields = new Map<string, string>();
      if (raw[position] !== '}') while (true) {
        whitespace(); const fieldPosition = position, key = string(); whitespace(); position++; // colon, checked by JSON.parse
        const fieldPath = `${path}[${JSON.stringify(key)}]`, child = value(fieldPath, depth + 1);
        if (fields.has(key)) {
          if (fields.get(key) !== child) throw new Error(`JSON重复字段值冲突，未选择任一值：${fieldPath}`);
          coalesced.push({ path: fieldPath, key, position: fieldPosition, action: 'coalesce_identical' });
        } else fields.set(key, child);
        whitespace(); if (raw[position] === '}') break;
        position++; // comma, checked by JSON.parse
      }
      position++;
      return `{${[...fields.keys()].sort().map(key => `${JSON.stringify(key)}:${fields.get(key)}`).join(',')}}`;
    }
    if (raw[position] === '[') {
      position++; whitespace(); const entries: string[] = [];
      if (raw[position] !== ']') while (true) {
        entries.push(value(`${path}[${entries.length}]`, depth + 1)); whitespace();
        if (raw[position] === ']') break; position++;
      }
      position++; return `[${entries.join(',')}]`;
    }
    if (raw[position] === '"') return JSON.stringify(string());
    while (position < raw.length && !/[\s,}\]]/u.test(raw[position])) position++;
    // Preserve number spelling so large integers that round to the same JS
    // number, -0 vs 0, etc. are not silently treated as identical values.
    return raw.slice(start, position);
  }
  const canonical = value('$', 0); whitespace();
  if (position !== raw.length) throw new Error('JSON尾部内容非法');
  return { value: coalesced.length ? JSON.parse(canonical) : original, coalesced };
}
