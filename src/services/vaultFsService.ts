import type { NoteItem } from '../types';
import { splitSharableFields } from './userStateService';

/** metadata.json 的版本号，后续结构变更时递增 */
export const METADATA_VERSION = 1;

/** 去掉 content 字段后的笔记元数据（md 只存正文，其余字段集中在此） */
export type NoteMeta = Omit<NoteItem, 'content'>;

/** metadata.json 文件的顶层结构 */
export interface VaultMetadataFile {
  version: number;
  notesMeta: Record<string, NoteMeta>;
}

/** 由 noteId 生成 md 文件名（noteId 由程序生成，天然无 Windows 非法字符） */
export function markdownFileName(noteId: string): string {
  return `${noteId}.md`;
}

/** 序列化：把笔记数组转为 metadata.json 文本（content 字段被剥离，不写入文件） */
export function serializeMetadata(notes: NoteItem[]): string {
  const notesMeta: Record<string, NoteMeta> = {};
  for (const n of notes) {
    // 只保留可分享白名单字段（个人状态字段不写入 metadata，避免随笔记分享泄露）
    const sharable = splitSharableFields(n);
    const meta: Record<string, unknown> = { ...sharable };
    delete meta.content; // content 由独立 .md 文件承载
    notesMeta[n.id] = meta as NoteMeta;
  }
  const file: VaultMetadataFile = { version: METADATA_VERSION, notesMeta };
  return JSON.stringify(file, null, 2);
}

/** 保存时的 md 文件映射：fileName -> 正文内容 */
export function markdownFileMap(notes: NoteItem[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const n of notes) {
    map.set(markdownFileName(n.id), n.content);
  }
  return map;
}

/** 反序列化：解析 metadata.json 文本 + 各 md 正文，合并回 NoteItem[] */
export function deserializeVault(metadataText: string, mdMap: Map<string, string>): NoteItem[] {
  const parsed: VaultMetadataFile = JSON.parse(metadataText);
  const notes: NoteItem[] = [];
  for (const [id, meta] of Object.entries(parsed.notesMeta ?? {})) {
    const content = mdMap.get(markdownFileName(id)) ?? '';
    notes.push({ ...(meta as NoteItem), id, content });
  }
  return notes;
}