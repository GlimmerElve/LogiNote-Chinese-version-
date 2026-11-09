import { parseTextbookMarkdown } from '../textbook/markdown';
import { validateMermaid } from '../textbook/contentSchema';

export interface ProgressiveDiagramPatch { oldText: string; newText: string }
function located(body: string, diagramIndex: number) {
  if (!Number.isSafeInteger(diagramIndex) || diagramIndex < 0 || diagramIndex > 15) throw Error('请指定实际图示编号');
  const diagrams = parseTextbookMarkdown(body).children.filter(node => node.type === 'code' && node.lang === 'mermaid');
  const node = diagrams[diagramIndex];
  if (!node || node.type !== 'code' || node.position?.start.offset === undefined || node.position.end.offset === undefined)
    throw Error('该页没有对应的独立 Mermaid 图示，请重新读取');
  const start = node.position.start.offset, end = node.position.end.offset, raw = body.slice(start, end);
  const lines = raw.split(/\r?\n/u), open = /^[ ]{0,3}(`{3,}|~{3,})[ \t]*mermaid[ \t]*$/u.exec(lines[0]);
  const close = /^[ ]{0,3}(`{3,}|~{3,})[ \t]*$/u.exec(lines.at(-1) || '');
  if (!open || !close || open[1][0] !== close[1][0] || close[1].length < open[1].length) throw Error('图示围栏不完整，原文保持不变');
  const codeStart = start + raw.indexOf('\n') + 1;
  const closingStart = start + raw.lastIndexOf('\n') + 1;
  const trailing = body.slice(codeStart, closingStart).match(/\r?\n$/u)?.[0] || '';
  const codeEnd = closingStart - trailing.length, code = body.slice(codeStart, codeEnd);
  if (code.length > 5000) throw Error('图示源码超过局部修复预算，请先缩小图示');
  return { code, codeStart, codeEnd, start, end, diagramCount: diagrams.length };
}

/** Explicit reads only: no whole-page model review or background reader work. */
export function readProgressiveDiagram(body: string, diagramIndex = 0) {
  const value = located(body, diagramIndex);
  return { diagramIndex, diagramCount: value.diagramCount, code: value.code,
    before: body.slice(Math.max(0, value.start - 600), value.start), after: body.slice(value.end, value.end + 600) };
}

/** All offsets bind to the ORIGINAL diagram. No patch can touch prose, the
 * fence, another diagram, a question or a saved generation checkpoint. */
export function patchProgressiveDiagram(body: string, diagramIndex: number, replacements: readonly ProgressiveDiagramPatch[]): string {
  const value = located(body, diagramIndex);
  if (!Array.isArray(replacements) || !replacements.length || replacements.length > 4) throw Error('单图修复仅接受1–4处补丁');
  const patches = replacements.map(item => {
    if (!item || Object.keys(item).some(key => !['oldText', 'newText'].includes(key))
      || typeof item.oldText !== 'string' || !item.oldText || item.oldText.length > 500
      || typeof item.newText !== 'string' || item.newText.length > 800 || item.oldText === item.newText)
      throw Error('图示补丁为空、过长或包含无效字段');
    const start = value.code.indexOf(item.oldText);
    if (start < 0 || start !== value.code.lastIndexOf(item.oldText)) throw Error('图示补丁锚点缺失或不唯一，请重新读取');
    return { start, end: start + item.oldText.length, text: item.newText };
  }).sort((a, b) => a.start - b.start);
  if (patches.some((item, index) => index && item.start < patches[index - 1].end)) throw Error('图示补丁范围重叠');
  let code = value.code;
  for (const patch of [...patches].reverse()) code = code.slice(0, patch.start) + patch.text + code.slice(patch.end);
  if (!code.trim() || code.length > 5000 || /^\s*(?:`{3,}|~{3,})/mu.test(code)) throw Error('图示补丁越过围栏或超过局部预算');
  validateMermaid(code); // Safety/size validation, not a claim of semantic truth.
  const next = body.slice(0, value.codeStart) + code + body.slice(value.codeEnd);
  if (next === body) throw Error('图示补丁没有实际变化');
  return next;
}
