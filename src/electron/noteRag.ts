import path from 'path';
import type { NoteRagIndexInput, NoteReferenceIndexStatus, NoteSearchResult } from '../types';
import { generateEmbedding } from './rag/embedding';
import {
  classifyDocumentQueryIntent,
  fuseKnowledgeChannelRanks,
  retrievalWeights,
} from './rag/knowledgeRetrieval.ts';
import { createNoteReferenceIndex } from './rag/noteReferenceIndex';

/**
 * 笔记本体 RAG（运行在 Electron 主进程）。
 *
 * 与资料文档 RAG 共用同一套中文嵌入模型（paraphrase-multilingual-MiniLM-L12-v2）
 * 与同一个 hybridSearch 混合检索工具，解决 renderer 端旧实现的三个缺陷：
 *   1. 英文模型 all-MiniLM-L6-v2 对中文区分度极差；
 *   2. 纯 dense 检索、无关键词兜底、无阈值；
 *   3. renderer 无法离线加载本地模型。
 *
 * 存储：`<dataRoot>/note-embeddings.json`（v2，全文规范块、原文坐标、版本与状态）。
 * 旧明确知识点缓存按 legacy 迁移，重建前不作为当前分块返回；不混入用户图。
 */

const roots = new Map<string, ReturnType<typeof createNoteReferenceIndex>>();
let activeIndex: ReturnType<typeof createNoteReferenceIndex> | undefined;
function store() { if (!activeIndex) throw new Error('参考索引目录尚未初始化'); return activeIndex; }

export function setNoteRagDataRoot(root: string): void {
  if (!root || !path.isAbsolute(root)) throw new Error('参考索引目录未初始化');
  const resolved = path.resolve(root);
  if (!roots.has(resolved)) roots.set(resolved, createNoteReferenceIndex(resolved, generateEmbedding));
  activeIndex = roots.get(resolved);
}

export async function indexNote(input: NoteRagIndexInput): Promise<void> {
  return store().index(input);
}

/** 批量索引（全量重建用）。逐条复用 indexNote，串行推进避免模型并发峰值。 */
export async function indexNotes(inputs: NoteRagIndexInput[]): Promise<void> {
  return store().indexAll(inputs);
}

export async function deleteNoteIndex(noteId: string): Promise<void> {
  return store().remove(noteId);
}

export async function deleteNoteIndexes(noteIds: string[]): Promise<void> {
  return store().removeMany(noteIds);
}

export async function countNotes(): Promise<number> {
  return store().count();
}
export async function getNoteIndexStatus(noteId: string): Promise<NoteReferenceIndexStatus> { return store().status(noteId); }

interface RankedNotePassage extends NoteSearchResult {
  fusedScore: number;
}

/**
 * 仅供个人素材通道使用的旧融合工具；普通资料检索不得调用。
 * 没有用户图命中时直接返回旧通道结果，避免改变原有排序。
 */
export function fuseNoteAndArgumentResults(
  query: string,
  passages: RankedNotePassage[],
  argumentsByNote: NoteSearchResult[],
  k: number,
): NoteSearchResult[] {
  if (argumentsByNote.length === 0) {
    return passages.slice(0, k).map(({ fusedScore: _fusedScore, ...result }) => result);
  }
  const rawWeights = retrievalWeights(classifyDocumentQueryIntent(query));
  const total = rawWeights.passage + rawWeights.argument || 1;
  const ranks = fuseKnowledgeChannelRanks({
    passage: passages.map((item) => item.noteId),
    entity: [],
    argument: argumentsByNote.map((item) => item.noteId),
  }, {
    passage: rawWeights.passage / total,
    entity: 0,
    argument: rawWeights.argument / total,
  });
  const passageById = new Map(passages.map((item) => [item.noteId, item]));
  const argumentById = new Map(argumentsByNote.map((item) => [item.noteId, item]));
  return [...new Set([...passageById.keys(), ...argumentById.keys()])]
    .map((noteId) => {
      const passage = passageById.get(noteId);
      const argument = argumentById.get(noteId);
      const preferArgument = Boolean(argument) && (
        !passage || ['reason', 'support', 'opposition'].includes(classifyDocumentQueryIntent(query))
      );
      const primary = preferArgument ? argument! : passage || argument!;
      const matchKinds = [
        ...(passage ? ['note' as const] : []),
        ...(argument ? ['argument' as const] : []),
      ];
      const snippet = passage && argument
        ? (preferArgument
            ? `${argument.snippet.slice(0, 600)}\n[笔记正文] ${passage.snippet.slice(0, 250)}`
            : `${passage.snippet.slice(0, 250)}\n${argument.snippet.slice(0, 600)}`)
        : primary.snippet;
      return {
        noteId,
        title: primary.title,
        score: Math.max(passage?.score || 0, argument?.score || 0),
        snippet,
        matchKinds,
        argumentHits: argument?.argumentHits,
        relationSummary: argument?.relationSummary,
        evidenceOrigin: preferArgument ? 'user-argument-doc' as const : passage?.evidenceOrigin || argument?.evidenceOrigin,
        admission: argument?.admission,
        evidenceGrade: argument?.evidenceGrade,
        rankScore: ranks.get(noteId) || 0,
      };
    })
    .sort((left, right) => right.rankScore - left.rankScore)
    .slice(0, k)
    .map(({ rankScore: _rankScore, ...result }) => result);
}

/** 知识点正文资料检索。可选范围仅由host独立作用域传入，不是新renderer权限。 */
export async function searchNotes(query: string, k = 5, allowedNoteIds?: string[]): Promise<NoteSearchResult[]> {
  const selectedIds = allowedNoteIds === undefined ? undefined : [...allowedNoteIds];
  // An explicitly empty host scope must not open the index or load the query embedding model.
  if (selectedIds?.length === 0) return [];
  const q = (query || '').trim();
  if (!q) return [];
  const index = store();
  // Model failure does not hide an exact lexical match; never fabricate a semantic vector.
  const qv = await generateEmbedding(q).catch(() => []);
  return index.search(q, qv, k, selectedIds);
}
