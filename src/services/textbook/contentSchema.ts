/** Shared, deterministic format gate for generation, editing and reading. Never execute supplied options. */
import { optionalFunctionPlot } from './functionPlot';
import { parseScienceDiagram, parseMoleculeDiagram } from './scienceDiagram';
export const TEXTBOOK_BLOCK_LANGUAGES = ['mermaid', 'chart', 'function-plot', 'science-diagram', 'molecule', 'textbook-tip', 'textbook-answer', 'textbook-image', 'textbook-references'] as const;
export type TextbookBlockLanguage = typeof TEXTBOOK_BLOCK_LANGUAGES[number];
export interface TextbookFormatScope { sourceIds?: readonly string[]; assetIds?: readonly string[] }
export interface TextbookChart {
  title: string; type: 'bar' | 'line' | 'pie'; labels: string[];
  series: Array<{ name: string; data: number[] }>; sourceIds: string[]; simulated: boolean;
}
export interface TextbookTip { title: string; text: string; kind: 'tip' | 'warning' | 'definition' }
export interface TextbookAnswer { title: string; text: string }
export interface TextbookImage { assetId: string; caption?: string }
export interface TextbookReferences { entries: Array<{ sourceId: string; title: string; detail: string }> }
const ID = /^[a-zA-Z0-9_-]{1,80}$/u;
function requireFormat(ok: unknown, message: string): asserts ok { if (!ok) throw new Error(message); }
function record(value: unknown, keys: string[]): asserts value is Record<string, unknown> {
  requireFormat(!!value && typeof value === 'object' && !Array.isArray(value), '格式必须是 JSON 对象');
  requireFormat(Object.keys(value).every((key) => keys.includes(key)), '包含未授权字段，不能使用原始渲染选项');
}
function text(value: unknown, max = 160): asserts value is string {
  requireFormat(typeof value === 'string' && value.trim().length > 0 && value.length <= max
    && !/[<>\u0000-\u0008\u000b\u000c\u000e-\u001f]/u.test(value), '文本为空、过长或包含 HTML/控制字符');
}
function json(code: string, max = 24_000): unknown {
  requireFormat(code.length <= max, '格式块过大');
  try { return JSON.parse(code); } catch { throw new Error('JSON 格式无效；原始源码仍保留'); }
}
/** Text inside an annotation is Markdown, not another renderer or an instruction channel. */
export function validateAnnotationText(value: unknown): asserts value is string {
  text(value, 12_000);
  requireFormat(!/!\[|\]\(|<\/?[A-Za-z]|(?:javascript|data|file|https?):|^\s*(?:[-*+]\s+\[[ xX]\]|```|~~~)|@due\(|\[\[/imu.test(value), '提示/答案只允许文字、公式和基础 Markdown，不允许图片、外部链接、任务或嵌套执行块');
}
function validateTimelineLines(lines: string[]): void {
  let periods = 0, events = 0, groups = 0, titles = 0, activePeriod = false;
  const label = (value: string, max: number) => { text(value, max); requireFormat(!/[#:]/u.test(value), '时间轴标签不能混用注释或冒号，请使用中文冒号'); };
  for (const raw of lines.slice(1)) {
    const line = raw.trim();
    if (line.startsWith('title ')) { requireFormat(++titles <= 1 && periods === 0, '时间轴标题只能在时期之前出现一次'); label(line.slice(6).trim(), 120); }
    else if (line.startsWith('section ')) { requireFormat(++groups <= 12, '时间轴阶段分组超过12个'); label(line.slice(8).trim(), 80); activePeriod = false; }
    else if (/^:\s+/u.test(line)) { requireFormat(activePeriod, '时间轴追加事件前必须有时期'); label(line.replace(/^:\s+/u, ''), 160); events++; }
    else {
      const parts = line.split(/\s+:\s+/u).map(part => part.trim());
      label(parts[0], 80); requireFormat(++periods <= 12, '时间轴时期超过12个'); activePeriod = true;
      for (const event of parts.slice(1)) { label(event, 160); events++; }
    }
    requireFormat(events <= 24, '时间轴事件超过24个');
  }
  requireFormat(periods > 0 && events > 0, '时间轴需要时期和对应事件');
}
export function validateMermaid(code: string): string {
  requireFormat(code.length <= 8_000 && code.trim().length > 0, '图示源码为空或超过 8,000 字符');
  // Legacy/generated labels often use an attribute-free HTML break. Treat only
  // this exact spelling as text line-break syntax before the HTML gate. Nothing
  // supplied by the lesson is passed through as HTML; stored source stays intact.
  code = code.replace(/<br[ \t]*\/?>/giu, '\\n');
  requireFormat(!/%%\{|^\s*---|\b(?:click|callback|href|link|links|icon|image|classDef|linkStyle|style)\b|@\{|(?:https?|javascript|data|file):|url\s*\(|<\/?[a-zA-Z]|!\[|\]\(|&(?:#|lt;|gt;)|[\u0000-\u0008\u000b\u000c\u000e-\u001f]/imu.test(code), '图示禁止初始化指令、交互、HTML、样式注入、图标、图片和外部链接');
  const lines = code.split(/\r?\n/u).filter((line) => line.trim() && !line.trim().startsWith('%%'));
  requireFormat(lines.length <= 120, '图示超过 120 行');
  requireFormat(/^(?:flowchart\s+(?:TB|TD|BT|RL|LR)|sequenceDiagram|mindmap|timeline)\s*$/u.test(lines[0]?.trim() || ''), '仅支持 flowchart、sequenceDiagram、mindmap 和 timeline');
  if (lines[0].trim() === 'timeline') validateTimelineLines(lines);
  const edges = code.match(/(?:-->|==>|-\.->|---|--[x o]|->>|-->>|-->|->)/gu) || [];
  requireFormat(edges.length <= 80, '图示连线超过 80 条');
  const nodeTokens = code.match(/\b[A-Za-z_][\w-]*\s*(?=[\[({])/gu) || [];
  requireFormat(new Set(nodeTokens.map((item) => item.trim())).size <= 80, '图示节点超过 80 个');
  if (lines[0].trim().startsWith('flowchart')) {
    const withoutLabels = lines.slice(1).join('\n').replace(/%%[^\n]*|"[^"\n]*"|\[[^\]\n]*\]|\{[^}\n]*\}|\([^\)\n]*\)|\|[^|\n]*\|/gu, '');
    const identifiers = (withoutLabels.match(/\b[A-Za-z_0-9][\w-]*/gu) || []).filter((item) => !['subgraph', 'end', 'direction', 'TB', 'TD', 'BT', 'RL', 'LR'].includes(item));
    requireFormat(new Set(identifiers).size <= 80, '图示节点超过 80 个');
  }
  requireFormat(lines[0].trim() !== 'mindmap' || lines.length <= 81, '思维导图节点超过 80 个');
  return code.trim();
}
export function parseChartBlock(code: string, scope: TextbookFormatScope = {}): TextbookChart {
  const value = json(code); record(value, ['title', 'type', 'labels', 'series', 'sourceIds', 'simulated']);
  text(value.title, 120); requireFormat(['bar', 'line', 'pie'].includes(value.type as string), '图表类型仅支持 bar、line、pie');
  requireFormat(Array.isArray(value.labels) && value.labels.length >= 1 && value.labels.length <= 40, '图表需要 1–40 个标签');
  value.labels.forEach((label) => text(label, 80));
  requireFormat(Array.isArray(value.series) && value.series.length >= 1 && value.series.length <= 6, '图表需要 1–6 个数值序列');
  for (const series of value.series) {
    record(series, ['name', 'data']); text(series.name, 80);
    requireFormat(Array.isArray(series.data) && series.data.length === value.labels.length
      && series.data.every((number) => typeof number === 'number' && Number.isFinite(number) && Math.abs(number) <= 1e12
        && (value.type !== 'pie' || number >= 0)), '数值序列必须与标签等长、有限，且饼图不能为负数');
  }
  requireFormat(value.type !== 'pie' || value.series.length === 1, '饼图只能包含一个序列');
  requireFormat(typeof value.simulated === 'boolean', '必须明确 simulated：示意数据或真实资料数据');
  requireFormat(Array.isArray(value.sourceIds) && value.sourceIds.length <= 12 && new Set(value.sourceIds).size === value.sourceIds.length
    && value.sourceIds.every((id) => typeof id === 'string' && ID.test(id) && (scope.sourceIds || []).includes(id)), '图表引用了未授权或重复的来源');
  requireFormat(value.simulated || value.sourceIds.length > 0, '真实图表必须引用已采集的资料来源；不能伪造数据');
  return value as unknown as TextbookChart;
}
export function parseTextbookTip(code: string): TextbookTip {
  if (!code.trim().startsWith('{')) { validateAnnotationText(code); return { title: '学习提示', text: code.trim(), kind: 'tip' }; }
  const value = json(code, 16_000); record(value, ['title', 'text', 'kind']); text(value.title, 120); validateAnnotationText(value.text);
  // The historical authoring example used this literal union as a kind value.
  // It is presentation only: normalize that exact typo without rewriting the
  // source/draft or spending a model retry. All unknown kinds still fail.
  if (value.kind === 'tip|warning|definition') value.kind = 'tip';
  requireFormat(['tip', 'warning', 'definition'].includes(value.kind as string), '提示类型无效');
  return value as unknown as TextbookTip;
}
export function parseTextbookAnswer(code: string): TextbookAnswer {
  if (!code.trim().startsWith('{')) { validateAnnotationText(code); return { title: '参考答案与解释', text: code.trim() }; }
  const value = json(code, 16_000); record(value, ['title', 'text']); text(value.title, 120); validateAnnotationText(value.text);
  return value as unknown as TextbookAnswer;
}
export function parseTextbookImage(code: string, scope: TextbookFormatScope = {}): TextbookImage {
  const value = json(code, 1_000); record(value, ['assetId', 'caption']);
  requireFormat(typeof value.assetId === 'string' && ID.test(value.assetId) && (scope.assetIds || []).includes(value.assetId), '图片必须使用教材清单中已授权的 assetId');
  if (value.caption !== undefined) text(value.caption, 400);
  return value as unknown as TextbookImage;
}
/** Bibliography metadata renders as React text, never Markdown/HTML, URLs or
 * executable options. Keep full titles/locations, including literal < and >. */
export function parseTextbookReferences(code: string, scope: TextbookFormatScope = {}): TextbookReferences {
  const value = json(code, 1_000_000); record(value, ['entries']);
  requireFormat(Array.isArray(value.entries) && value.entries.length > 0 && value.entries.length <= 192, '参考资料条目为空或过多');
  const ids = new Set<string>();
  const plain = (value: unknown, max: number) => requireFormat(typeof value === 'string' && value.length <= max
    && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/u.test(value), '参考资料文本无效或过长');
  for (const entry of value.entries) {
    record(entry, ['sourceId', 'title', 'detail']);
    requireFormat(typeof entry.sourceId === 'string' && ID.test(entry.sourceId) && /^[LN]\d+$/u.test(entry.sourceId)
      && !ids.has(entry.sourceId) && (!scope.sourceIds || scope.sourceIds.includes(entry.sourceId)), '参考资料引用了未授权或重复的来源');
    ids.add(entry.sourceId);
    plain(entry.title, 8192); plain(entry.detail, 16_000);
    requireFormat((entry.title as string).trim().length > 0, '参考资料标题为空');
  }
  return value as unknown as TextbookReferences;
}
export function isTextbookBlockLanguage(language: string): language is TextbookBlockLanguage {
  return (TEXTBOOK_BLOCK_LANGUAGES as readonly string[]).includes(language);
}
export function parseControlledTextbookBlock(language: string, code: string, scope: TextbookFormatScope = {}) {
  switch (language) {
    case 'mermaid': return validateMermaid(code);
    case 'chart': return parseChartBlock(code, scope);
    case 'function-plot': return optionalFunctionPlot(code);
    case 'science-diagram': return parseScienceDiagram(code, scope.sourceIds);
    case 'molecule': return parseMoleculeDiagram(code, scope.sourceIds);
    case 'textbook-tip': return parseTextbookTip(code);
    case 'textbook-answer': return parseTextbookAnswer(code);
    case 'textbook-image': return parseTextbookImage(code, scope);
    case 'textbook-references': return parseTextbookReferences(code, scope);
    default: throw new Error('未知的受控教材格式');
  }
}
