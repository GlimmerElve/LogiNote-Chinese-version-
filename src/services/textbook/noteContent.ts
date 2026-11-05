import type { NoteItem } from '../../types.ts';
import type { TextbookManifest } from './types.ts';

/** 原文坐标与围栏状态供读取、替换及任务解析共用，避免各自找到不同边界。 */
function contentLines(content: string) {
  let fence = '', fenceContainerIndent = 0;
  const listContentIndents: number[] = [];
  const columns = (whitespace: string, start = 0) => {
    let column = start;
    for (const char of whitespace) column += char === '\t' ? 4 - column % 4 : 1;
    return column;
  };
  return [...content.matchAll(/[^\n]*(?:\n|$)/gu)].filter((match) => match[0]).map((match) => {
    const text = match[0].replace(/\r?\n$/u, '');
    const leading = text.match(/^[ \t]*/u)![0];
    const indent = columns(leading), body = text.slice(leading.length);
    // 列表容器结束也结束其内围栏；空行本身不结束列表或围栏。
    if (fence && body && indent < fenceContainerIndent) fence = '';
    let code = !!fence;
    if (fence) {
      const delimiter = indent - fenceContainerIndent <= 3 ? body.match(/^(`{3,}|~{3,})(.*)$/u) : null;
      if (delimiter && delimiter[1][0] === fence[0] && delimiter[1].length >= fence.length && !delimiter[2].trim()) fence = '';
    } else if (body) {
      while (listContentIndents.length && indent < listContentIndents[listContentIndents.length - 1]) listContentIndents.pop();
      const containerIndent = listContentIndents[listContentIndents.length - 1] || 0;
      // 四空格是相对当前列表内容的缩进，而不是相对整行左边界。
      code = indent - containerIndent >= 4;
      let delimiter = code ? null : body.match(/^(`{3,}|~{3,})(.*)$/u);
      let openingContainerIndent = containerIndent;
      if (!code && !delimiter) {
        const list = body.match(/^([-+*]|\d{1,9}[.)])([ \t]+|$)/u);
        if (list) {
          const markerEnd = indent + list[1].length;
          const padding = columns(list[2], markerEnd) - markerEnd || 1;
          openingContainerIndent = markerEnd + (padding <= 4 ? padding : 1);
          listContentIndents.push(openingContainerIndent);
          code = padding > 4;
          // 允许列表项自身以围栏开始，不把其中的示例变成嵌套任务。
          delimiter = code ? null : body.slice(list[0].length).match(/^(`{3,}|~{3,})(.*)$/u);
        }
      }
      if (delimiter) { fence = delimiter[1]; fenceContainerIndent = openingContainerIndent; code = true; }
    }
    return { text, start: match.index!, end: match.index! + match[0].length, code };
  });
}

export function hasLearningReviewMarker(content: string, id: string): boolean {
  const marker = learningReviewMarker(id);
  return contentLines(content).some((line) => !line.code && line.text.trim() === marker);
}

export function learningReviewMarker(id: string): string {
  return `<LearningReviewBlock id="${encodeURIComponent(id)}" />`;
}

/** 只识别独占一行且不在代码围栏中的受控块；不把代码示例当成来源边界。 */
export function removeLearningBlockMarkers(content: string): string {
  return contentLines(content).filter((line) => line.code ||
    !/^\s*<(?:ArgumentBlock|LearningReviewBlock)\s+id=(?:"[^"\n]*"|'[^'\n]*')\s*\/?>\s*$/u.test(line.text))
    .map((line) => content.slice(line.start, line.end)).join('');
}

export function textbookRegionMarkers(regionId: string): [string, string] {
  const id = encodeURIComponent(regionId);
  return [`<TextbookBoundary id="${id}" edge="start" />`, `<TextbookBoundary id="${id}" edge="end" />`];
}

/** Detect live managed textbook markers while ignoring fenced/indented code examples. */
export function hasTextbookBoundaryMarker(content: string): boolean {
  return contentLines(content).some((line) => !line.code
    && /^\s*<TextbookBoundary\b[^>\n]*\bedge=(?:"(?:start|end)"|'(?:start|end)')[^>\n]*\/?>\s*$/u.test(line.text));
}

function findTextbookRegion(content: string, textbook: TextbookManifest) {
  const [start, end] = textbookRegionMarkers(textbook.regionId);
  const lines = contentLines(content);
  const starts = lines.filter((line) => !line.code && line.text.trim() === start);
  const ends = lines.filter((line) => !line.code && line.text.trim() === end);
  if (starts.length !== 1 || ends.length !== 1 || starts[0].start >= ends[0].start) return null;
  return { startLine: starts[0].start, endLine: ends[0].end,
    startAt: starts[0].start + starts[0].text.indexOf(start),
    endAt: ends[0].start + ends[0].text.indexOf(end) + end.length };
}

/** 边界丢失/重复/未闭合时 fail closed，不猜测正文中的哪段是用户原话。 */
export function stripTextbookRegion(content: string, textbook?: TextbookManifest): { outside: string; valid: boolean } {
  if (!textbook) return { outside: content, valid: true };
  const region = findTextbookRegion(content, textbook);
  return region ? { outside: content.slice(0, region.startLine) + content.slice(region.endLine), valid: true }
    : { outside: '', valid: false };
}

export type LogicCheckSource =
  | { ok: true; text: string; scope: 'selection' | 'note' | 'note_without_textbook'; notice: string | null }
  | { ok: false; reason: 'invalid_textbook_boundary' | 'empty_note'; message: string };

/**
 * Build the only text that the note logic checker may send to a model.
 * Resolve the managed region against the complete note before considering a
 * selection, so selecting inside/crossing the textbook cannot leak its text.
 */
export function prepareLogicCheckSource(content: string, selection: string, textbook?: TextbookManifest): LogicCheckSource {
  if (!textbook && hasTextbookBoundaryMarker(content)) {
    return { ok: false, reason: 'invalid_textbook_boundary',
      message: '检测到未绑定的教材边界，逻辑检查已停止，避免误把教材纳入分析。请先恢复教材信息。' };
  }
  const stripped = stripTextbookRegion(content, textbook);
  if (!stripped.valid) return { ok: false, reason: 'invalid_textbook_boundary',
    message: '教材边界异常，逻辑检查已停止，避免误把教材纳入分析。请先恢复教材边界。' };
  const outside = removeLearningBlockMarkers(stripped.outside).trim();
  if (!outside) return { ok: false, reason: 'empty_note', message: textbook
    ? '除教材内容外没有可检查的笔记正文。请先补充自己的判断、推理或说明。'
    : '当前笔记没有可检查的正文。' };
  const selected = selection.trim();
  if (selected && outside.includes(selected)) return { ok: true, text: selected, scope: 'selection',
    notice: textbook ? '已排除教材内容；本次只检查选中的笔记正文。' : null };
  if (textbook) return { ok: true, text: outside, scope: 'note_without_textbook', notice: selected
    ? '选区位于教材内或跨越教材边界，已改为只检查教材之外的笔记正文。'
    : '已排除教材内容；本次只检查你写的笔记正文。' };
  return { ok: true, text: outside, scope: 'note', notice: null };
}
/** Exact managed body for durable verification; fail closed on malformed boundaries. */
export function readTextbookBody(content: string, textbook: TextbookManifest): string | null {
  const region = findTextbookRegion(content, textbook);
  if (!region) return null;
  const [start, end] = textbookRegionMarkers(textbook.regionId);
  return content.slice(region.startAt + start.length, region.endAt - end.length).trim();
}

/** 排除教材演示与代码示例，但保留行数，既有任务 ID/勾选坐标不漂移。 */
export function projectPlanningContent(content: string, textbook?: TextbookManifest): string {
  const region = textbook ? findTextbookRegion(content, textbook) : null;
  return contentLines(content).map((line) => {
    const excluded = line.code || (!!textbook && (!region || (line.start >= region.startLine && line.start < region.endLine)));
    return excluded ? content.slice(line.start, line.end).replace(/[^\r\n]/gu, ' ') : content.slice(line.start, line.end);
  }).join('');
}

/** 手工/后续发布通道使用的窄写入：只替换受管教材，不动其他正文或记录。 */
export function writeTextbookRegion(note: NoteItem, body: string, manifest: TextbookManifest): NoteItem {
  if (note.noteType !== 'project' || manifest.projectNoteId !== note.id) throw new Error('教材目标项目不匹配');
  const [start, end] = textbookRegionMarkers(manifest.regionId);
  if (body.includes(start) || body.includes(end)) throw new Error('教材正文包含保留边界标记');
  let content = note.content;
  if (note.textbook) {
    if (note.textbook.regionId !== manifest.regionId) throw new Error('不能更换既有教材区域身份');
    const region = findTextbookRegion(content, note.textbook);
    if (!region) throw new Error('教材边界已变化，请先恢复或确认正文');
    content = content.slice(0, region.startAt) + `${start}\n\n${body}\n\n${end}` + content.slice(region.endAt);
  } else {
    content = `${content}${content.trim() ? '\n\n' : ''}${start}\n\n${body}\n\n${end}`;
  }
  return { ...note, textbook: manifest, content, updatedAt: manifest.updatedAt };
}
