import { parseIdenticalCoreJson, type IdenticalJsonCoalescence } from './identicalJson';

export interface CoreUnresolvedIsolation {
  state: 'quarantined'; raw: string; reason: string;
  representation: 'original-field-bytes' | 'decoded-value-json'; start?: number; end?: number;
}
interface Envelope {
  value: any; coalesced: IdenticalJsonCoalescence[]; unresolvedIsolation?: CoreUnresolvedIsolation;
}
function demand(value: unknown, reason: string): asserts value { if (!value) throw new Error(reason); }
const space = (raw: string, at: number) => { while (/\s/u.test(raw[at] || '') && at < raw.length) at++; return at; };
function stringEnd(raw: string, start: number) {
  demand(raw[start] === '"', '字段名或字符串边界非法');
  for (let at = start + 1; at < raw.length; at++) {
    if (raw[at] === '\\') at++;
    else if (raw[at] === '"') { JSON.parse(raw.slice(start, at + 1)); return at + 1; }
  }
  throw new Error('备注包含未闭合字符串，不能确定边界');
}
/** For the opaque annotation suffix only, track arrays and strings, not malformed
 * object braces. We do not parse, fix, or reuse any object inside this suffix. */
function opaqueArrayEnd(raw: string, start: number) {
  demand(raw[start] === '[', '末尾备注不是可界定的数组');
  let depth = 0;
  for (let at = start; at < raw.length; at++) {
    if (raw[at] === '"') { at = stringEnd(raw, at) - 1; continue; }
    if (raw[at] === '[') { depth++; demand(depth <= 128, '数组嵌套超限'); }
    if (raw[at] === ']' && --depth === 0) return at + 1;
  }
  throw new Error('末尾备注数组未闭合，不能确定边界');
}
function strictArrayEnd(raw: string, start: number) {
  demand(raw[start] === '[', '核心字段不是数组');
  const stack: string[] = [];
  for (let at = start; at < raw.length; at++) {
    const ch = raw[at];
    if (ch === '"') { at = stringEnd(raw, at) - 1; continue; }
    if (ch === '[' || ch === '{') { stack.push(ch); demand(stack.length <= 128, '核心字段嵌套超限'); }
    if (ch === ']' || ch === '}') {
      const opened = stack.pop();
      demand(opened === (ch === ']' ? '[' : '{'), '核心字段边界不匹配');
      if (!stack.length) return at + 1;
    }
  }
  throw new Error('核心字段未闭合');
}
function recoverTerminalUnresolved(raw: string, failure: unknown): Envelope {
  let at = space(raw, 0); demand(raw[at++] === '{', '非JSON对象，不恢复');
  const core: Record<string, any> = {}, coalesced: IdenticalJsonCoalescence[] = [];
  for (let count = 0; count < 3; count++) {
    at = space(raw, at); const endKey = stringEnd(raw, at), key = JSON.parse(raw.slice(at, endKey));
    at = space(raw, endKey); demand(raw[at++] === ':', '字段分隔符非法'); at = space(raw, at);
    if (count < 2) {
      demand(['steps', 'conclusions'].includes(key) && !Object.hasOwn(core, key), '只恢复严格核心字段之后的末尾备注');
      const start = at, end = strictArrayEnd(raw, start), decoded = parseIdenticalCoreJson(raw.slice(start, end));
      demand(Array.isArray(decoded.value), '核心字段不是数组'); core[key] = decoded.value;
      coalesced.push(...decoded.coalesced.map(item => ({ ...item, position: start + item.position, path: `$[${JSON.stringify(key)}]${item.path.slice(1)}` })));
      at = space(raw, end); demand(raw[at++] === ',', '核心字段后缺少分隔符');
    } else {
      demand(key === 'unresolved' && Object.hasOwn(core, 'steps') && Object.hasOwn(core, 'conclusions'), '末尾字段不是唯一的unresolved');
      const start = at, end = opaqueArrayEnd(raw, start);
      at = space(raw, end); demand(raw[at++] === '}' && space(raw, at) === raw.length, '备注之后存在额外字段或尾部内容');
      return { value: { ...core, unresolved: [] }, coalesced,
        unresolvedIsolation: { state: 'quarantined', raw: raw.slice(start, end), start, end, representation: 'original-field-bytes',
          reason: `末尾备注损坏，整段保留但不进入图；核心字段严格解析：${failure instanceof Error ? failure.message : String(failure)}` } };
    }
  }
  throw new Error('无法确定核心字段和备注边界');
}

/** No arbitrary JSON repair. Main fields always retain strict syntax/duplicate
 * validation. Only a provably terminal optional annotation array may be isolated. */
export function parseCoreQuoteEnvelope(raw: string): Envelope {
  demand(typeof raw === 'string' && raw.length <= 100000, '响应为空或超过预算');
  let decoded: Envelope;
  try { decoded = parseIdenticalCoreJson(raw); }
  catch (error) {
    try { return recoverTerminalUnresolved(raw, error); }
    catch { throw error; } // Retain the original strict diagnostic for core failures.
  }
  const value = decoded.value;
  if (value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).sort().join('|') === 'conclusions|steps|unresolved'
    && (!Array.isArray(value.unresolved) || value.unresolved.length > 20)) {
    const snapshot = JSON.stringify(value.unresolved);
    return { ...decoded, value: { ...value, unresolved: [] }, unresolvedIsolation: {
      state: 'quarantined', raw: snapshot, representation: 'decoded-value-json', reason: '备注容器不是数组或超过20项；未截断冒充已处理，完整值另存' } };
  }
  return decoded;
}
