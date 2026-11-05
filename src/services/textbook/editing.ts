import type { NoteItem } from '../../types';
import type { WorkspaceNoteChange } from '../agent/workspaceOperations';
import { readTextbookBody, stripTextbookRegion, writeTextbookRegion } from './noteContent';
import { parseTextbookMarkdown, textbookSections } from './markdown';
import { isTextbookBlockLanguage, parseControlledTextbookBlock } from './contentSchema';
import { prepareMarkdownForMdx } from '../markdownMdxCompatibility';

export interface TextbookEditInput {
  projectNoteId: string;
  expectedRevisionId: string;
  replacements?: Array<{ oldText: string; newText: string }>;
  appendText?: string;
}
export function publishedTextbook(notes: NoteItem[], projectNoteId: unknown) {
  if (typeof projectNoteId !== 'string' || !projectNoteId || projectNoteId.length > 200) throw new Error('需要真实项目的稳定 ID');
  const matches = notes.filter(note => note.id === projectNoteId);
  const note = matches[0];
  if (matches.length !== 1 || note.noteType !== 'project' || !note.textbook || note.textbook.projectNoteId !== note.id) throw new Error('目标项目没有可修改的已写入教材');
  const body = readTextbookBody(note.content, note.textbook);
  if (!body) throw new Error('教材边界异常或正文为空；不能按普通笔记覆盖，请先恢复边界');
  return { note, body, manifest: note.textbook };
}

/** Read only published teaching content, never private jobs, profile or review records. */
export function readPublishedTextbook(notes: NoteItem[], projectNoteId: unknown, offset: unknown = 0, limit: unknown = 10000) {
  const { note, body, manifest } = publishedTextbook(notes, projectNoteId);
  if (!Number.isSafeInteger(offset) || (offset as number) < 0 || (offset as number) > body.length
    || !Number.isSafeInteger(limit) || (limit as number) < 1 || (limit as number) > 16000) throw new Error('教材读取偏移或分页长度无效');
  const end = Math.min(body.length, (offset as number) + (limit as number));
  return { projectNoteId: note.id, projectTitle: note.title, revisionId: manifest.revisionId, totalChars: body.length,
    offset, text: body.slice(offset as number, end), ...(end < body.length ? { nextOffset: end } : {}),
    sections: textbookSections(body, manifest).map(({ title, start, chapterId }) => ({ title, offset: start, chapterId })),
    sources: (manifest.sources || []).map(({ sourceId, title, kind }) => ({ sourceId, title, kind })),
    assets: (manifest.assets || []).map(({ id, alt }) => ({ id, alt })),
    notice: '只返回已发布教材；修改用 edit_project_textbook。新增事实须核对既有原文，不把来源编号当作事实验真。' };
}

/** Content safety/provenance membership only, not a new whole-book semantic review. */
function validateEditedBody(body: string, note: NoteItem): void {
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/u.test(body)) throw new Error('教材包含无效控制字符');
  const manifest = note.textbook!, sourceIds = (manifest.sources || []).map(source => source.sourceId);
  const assetIds = (manifest.assets || []).map(asset => asset.id);
  const sourceSet = new Set(sourceIds), display: string[] = [];
  const rendered = (node: any): string => typeof node.value === 'string' ? node.value : (node.children || []).map(rendered).join('');
  const checkText = (value: string) => {
    for (const hit of value.matchAll(/\[([LN]\d+)\]/gu)) if (!sourceSet.has(hit[1])) throw new Error(`教材引用了未授权来源 ${hit[1]}`);
    if (/\[(?:[CMR]\d+)\]|(?:个人证据|内部证据|认知记录|个人记录|内部编号)[^\n。]{0,80}\b[CMR]\d+\b/u.test(value)) throw new Error('不能把内部个人证据编号写入教材');
    display.push(value);
  };
  const visit = (node: any) => {
    if (node.type === 'html' || node.type === 'image' || node.type === 'imageReference') throw new Error('教材只允许受控素材，不允许 HTML、控制块或外部图片');
    if ((node.type === 'link' || node.type === 'definition') && !/^#[a-zA-Z0-9_.:-]+$/u.test(node.url || '')) throw new Error('教材不接受新增外部链接；请使用既有来源引用');
    if (node.type === 'listItem' && node.checked != null) throw new Error('教材不新增项目任务，请使用章末复述问题');
    if (node.type === 'code') {
      const raw = body.slice(node.position.start.offset, node.position.end.offset), lines = raw.split(/\r?\n/u);
      const opening = lines[0].match(/^\s*(`{3,}|~{3,})/u);
      if (opening && (lines.length < 2 || !new RegExp(`^\\s*${opening[1][0]}{${opening[1].length},}\\s*$`, 'u').test(lines.at(-1)!))) throw new Error('代码或图示围栏未闭合，请替换完整围栏块');
      if (isTextbookBlockLanguage(node.lang || '')) {
        const parsed = parseControlledTextbookBlock(node.lang, node.value, { sourceIds, assetIds });
        const decoded = typeof parsed === 'string' ? parsed.replace(/#(?:([0-9]{1,7})|x([0-9a-f]{1,6}));/giu, (raw, decimal, hex) => {
          const point = parseInt(decimal || hex, decimal ? 10 : 16); return point > 0 && point <= 0x10ffff && !(point >= 0xd800 && point <= 0xdfff) ? String.fromCodePoint(point) : raw;
        }) : JSON.stringify(parsed);
        checkText(decoded || '');
        // Decode annotation Markdown entities/inline emphasis as the reader does.
        if (node.lang === 'textbook-tip' || node.lang === 'textbook-answer') {
          const parsedAnnotation = parsed as { text: string };
          visit(parseTextbookMarkdown(parsedAnnotation.text));
        }
      }
      return; // Ordinary code remains inert, not fact-citation prose.
    }
    if (node.type === 'text') {
      if (/@due\(/u.test(node.value)) throw new Error('教材不能写入计划任务标记');
      checkText(node.value);
    }
    if (['paragraph', 'heading', 'tableCell'].includes(node.type)) checkText(rendered(node));
    node.children?.forEach(visit);
  };
  visit(parseTextbookMarkdown(body));
  const displayed = [body, ...display].join('\n');
  for (const record of note.learningReviewRecords || []) for (const value of [record.rawRestatement, record.editedRestatement, record.summary]) {
    if (value && value.trim().length >= 24 && displayed.includes(value.trim())) throw new Error('不能把私人复盘原文复制进可分享教材');
  }
}

/** A bounded patch, not a generation restart. Keep identities, references and all outside bytes. */
export function preparePublishedTextbookEdit(notes: NoteItem[], input: TextbookEditInput): WorkspaceNoteChange {
  const { note, body, manifest } = publishedTextbook(notes, input.projectNoteId);
  if (typeof input.expectedRevisionId !== 'string' || input.expectedRevisionId !== manifest.revisionId) throw new Error('教材版本已变化，请重新读取后修改');
  const replacements = input.replacements === undefined ? [] : input.replacements;
  if (!Array.isArray(replacements) || replacements.length > 10 || (!replacements.length && input.appendText === undefined)) throw new Error('需要1至10处精确替换，或在教材末尾补充内容');
  const ranges: Array<{ start: number; end: number; text: string }> = [];
  for (const replacement of replacements) {
    if (!replacement || Object.keys(replacement).some(key => !['oldText', 'newText'].includes(key))
      || typeof replacement.oldText !== 'string' || !replacement.oldText || replacement.oldText.length > 16000
      || typeof replacement.newText !== 'string' || replacement.newText.length > 16000) throw new Error('教材替换必须提供有界、真实的 oldText/newText');
    const start = body.indexOf(replacement.oldText);
    if (start < 0 || body.indexOf(replacement.oldText, start + 1) >= 0) throw new Error('教材片段不存在或不唯一，请重新读取并补充上下文定位');
    const end = start + replacement.oldText.length;
    if (ranges.some(range => start < range.end && end > range.start)) throw new Error('教材替换范围不能重叠，请合并为一个完整片段');
    ranges.push({ start, end, text: replacement.newText });
  }
  let nextBody = body;
  let shift = 0;
  const editedRanges = [...ranges].sort((a, b) => a.start - b.start).map(range => {
    const start = range.start + shift;
    shift += range.text.length - (range.end - range.start);
    return { start, end: start + range.text.length };
  });
  for (const range of ranges.sort((a, b) => b.start - a.start)) nextBody = nextBody.slice(0, range.start) + range.text + nextBody.slice(range.end);
  if (input.appendText !== undefined) {
    if (typeof input.appendText !== 'string' || !input.appendText.trim() || input.appendText.length > 16000) throw new Error('教材追加内容为空或过长');
    const start = nextBody.length + 2;
    nextBody += '\n\n' + input.appendText;
    editedRanges.push({ start, end: nextBody.length });
  }
  if (!nextBody.trim() || nextBody === body || nextBody.length > Math.max(300000, body.length + 32000)) throw new Error('教材没有实际变更、为空或改动过大');
  // Preserve chapter identities/outline; content/subsections/figures can change.
  const outline = (text: string) => parseTextbookMarkdown(text).children.filter(node => node.type === 'heading' && node.depth <= 2)
    .map(node => text.slice(node.position!.start.offset, node.position!.end.offset));
  if (JSON.stringify(outline(body)) !== JSON.stringify(outline(nextBody))) throw new Error('局部编辑须保留教材一级/二级目录；请在既有章节下修改或用三级标题追加补充');
  // Parse with full context (so math/code stay opaque), but normalize only the
  // newly authored spans. Existing prose outside the approved patch stays exact.
  const compatible = prepareMarkdownForMdx(nextBody);
  for (const patch of compatible.patches.filter(patch => editedRanges.some(range => patch.start >= range.start && patch.end <= range.end))
    .sort((a, b) => b.start - a.start)) nextBody = nextBody.slice(0, patch.start) + patch.replacement + nextBody.slice(patch.end);
  validateEditedBody(nextBody, note);
  const now = new Date().toISOString();
  const after = writeTextbookRegion(note, nextBody, { ...manifest, revisionId: `edit-${crypto.randomUUID()}`, updatedAt: now });
  if (stripTextbookRegion(after.content, after.textbook).outside !== stripTextbookRegion(note.content, manifest).outside) throw new Error('教材编辑意外涉及正文之外区域，已停止');
  return { kind: 'edit', label: `局部修改教材《${note.title}》`, before: [note], after: [after] };
}
