import type { NoteRagIndexInput } from '../types.ts';
import { removeLearningBlockMarkers, stripTextbookRegion } from './textbook/noteContent.ts';

/** 来源分类不是正确性判定：知识点正文仅是参考资料，不自动代表权威事实。 */
export function referenceNoteContent(note: Pick<NoteRagIndexInput, 'noteType' | 'content'>): string {
  return note.noteType === 'knowledge' ? note.content || '' : '';
}

/** Empty editors, HTML wrappers and the default placeholder are not reference evidence. */
export function hasSubstantiveReferenceText(value: string): boolean {
  const text = (value || '').replace(/<[^>]+>/gu, ' ').replace(/&(?:nbsp|#160);/giu, ' ')
    .replace(/data:image\/[^)\s]+/gu, ' ').trim();
  if (!text || text === '请对该知识点进行定义描述') return false;
  return text.replace(/[#>*_`\-[\]()\s]/gu, '').length >= 2;
}

/** 只提取项目复述；计划/任务为业务数据，论证图由独立个人通道索引。 */
export function personalProjectContent(note: NoteRagIndexInput): string {
  if (note.noteType !== 'project') return '';
  let text = removeLearningBlockMarkers(stripTextbookRegion(note.content || '', note.textbook).outside);
  for (const block of note.generatedContentBlocks || []) {
    if (typeof block === 'string' && block.trim()) text = text.split(block).join('\n');
  }
  const lines = text.split(/\r?\n/u);
  let inTask = false, inFence = false;
  const legacy = lines.filter((line) => {
    // Legacy plans contain checkbox tasks / stable task anchors. Continuations
    // belong to that task until a blank or a non-indented new paragraph.
    if (/^\s*```|^\s*~~~/u.test(line)) { inFence = !inFence; return true; }
    if (inFence) return true;
    if (/^\s*[-*+]\s+\[[ xX]\]|<!--\s*ln-task:|@due\(/u.test(line)) { inTask = true; return false; }
    if (inTask && /^\s{2,}\S/u.test(line)) return false;
    inTask = false;
    if (/^\s*<!--.*(?:argument|论证).*-->\s*$/iu.test(line)) return false;
    return true;
  }).join('\n').replace(/\n{3,}/gu, '\n\n').trim();
  const restatements = (note.learningReviewRecords || [])
    .filter((record) => record.projectNoteId === note.id && record.schemaVersion === 1)
    .map((record) => typeof record.editedRestatement === 'string' ? record.editedRestatement : record.rawRestatement).filter(Boolean);
  return [legacy, ...restatements].filter(Boolean).join('\n\n');
}

export interface ProjectMaterialRow {
  noteId: string; title: string; text: string; passageId: string;
  textTruncated?: boolean;
  sourceKind: 'project-restatement'; stance: 'not_assessed'; usableAsFactEvidence: false;
}

/** All paragraphs are indexed, not just the opening generated plan. */
export function projectMaterialRows(note: NoteRagIndexInput): ProjectMaterialRow[] {
  const body = personalProjectContent(note);
  const rows: ProjectMaterialRow[] = [];
  for (const paragraph of body.split(/\n\s*\n/u)) {
    if (paragraph.trim().replace(/[#>*_`\s]/gu, '').length < 2) continue;
    for (let offset = 0; offset < paragraph.length; offset += 900) {
      const text = paragraph.slice(offset, offset + 900).trim();
      if (!text) continue;
      rows.push({ noteId: note.id, title: note.title, text, passageId: `p${rows.length + 1}`,
        textTruncated: paragraph.length > 900,
        sourceKind: 'project-restatement', stance: 'not_assessed', usableAsFactEvidence: false });
    }
  }
  return rows;
}

export function rememberGeneratedContent(note: { generatedContentBlocks?: string[] }, block: string): string[] {
  return [...new Set([...(note.generatedContentBlocks || []), block].filter((text) => text.trim()))];
}
