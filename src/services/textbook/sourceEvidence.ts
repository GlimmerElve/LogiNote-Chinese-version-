import type { NoteItem } from '../../types';
import type { TextbookManifest } from './types';
import { readLocalMaterialPage } from '../documentRagClient';
import { textbookHash } from './fingerprint';
import { readTextbookWebEvidence } from './jobClient';

export type TextbookSourcePointer = NonNullable<TextbookManifest['sources']>[number];
/** Shared by the existing reader and Agent: published, version-bound evidence only. */
export async function readSourceEvidence(source: TextbookSourcePointer, allNotes: NoteItem[] = [], cursor?: number, projectNoteId?: string): Promise<{ text: string; nextCursor?: number }> {
  if (source.kind === 'web') {
    if (!projectNoteId || !source.web) throw new Error('网页来源没有已发布教材定位；不会读取内部任务草稿');
    return readTextbookWebEvidence({ projectNoteId, sourceId: source.sourceId, snapshotId: source.web.snapshotId, version: source.version, cursor });
  }
  if (source.kind === 'knowledge') {
    const note = allNotes.find((item) => item.id === source.id && item.noteType === 'knowledge');
    if (!note) throw new Error('来源知识点已不在当前笔记库；不会读取内部任务草稿');
    if (await textbookHash({ title: note.title, content: note.content, aliases: note.aliases }) !== source.version) throw new Error('知识点来源已变化，无法把当前内容当作生成时原文；可打开笔记核对');
    return { text: note.content.slice(0, 20_000) + (note.content.length > 20_000 ? '\n\n[内容较长，请打开知识点继续阅读]' : '') };
  }
  if (!source.blockId || !Number.isSafeInteger(source.textStart) || !Number.isSafeInteger(source.textEnd)
    || source.textStart! < 0 || source.textEnd! <= source.textStart!) throw new Error('旧教材没有精确原文定位；请打开源文件核对，不会以搜索摘要冒充证据');
  const position = cursor ?? source.textStart!;
  if (!Number.isSafeInteger(position) || position < source.textStart! || position >= source.textEnd!) throw new Error('原文续读坐标不在已引用范围');
  const page = await readLocalMaterialPage({ allowedDocIds: [source.id], docId: source.id, version: source.version,
    target: { kind: 'block', blockId: source.blockId, neighbors: 0 }, cursor: position, maxChars: Math.max(128, Math.min(8_000, source.textEnd! - position)) });
  if (page.docId !== source.id || page.version !== source.version) throw new Error('原文与教材来源版本不一致');
  const excerpts = page.excerpts.filter((item) => item.blockId === source.blockId && item.textStart < source.textEnd!);
  const text = excerpts.map((item) => item.text.slice(Math.max(0, position - item.textStart), Math.max(0, source.textEnd! - item.textStart))).join('\n');
  if (!text.trim()) throw new Error('原文片段已不可用');
  return { text: text.replace(/data:image\/(?:png|jpeg|gif|webp);base64,[A-Za-z0-9+/=]+/giu, '[内嵌图片字节省略]'),
    nextCursor: page.nextCursor !== undefined && page.nextCursor < source.textEnd! ? page.nextCursor : undefined };
}
