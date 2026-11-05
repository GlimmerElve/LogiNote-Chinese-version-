import { createHash } from 'crypto';
import { promises as fs } from 'fs';
import path from 'path';
import type { NoteRagIndexInput } from '../types.ts';
import { projectMaterialRows, type ProjectMaterialRow } from '../services/ragSourcePolicy.ts';
import { rankProjectMaterials, type CognitionMaterialHit } from '../services/cognition/materials.ts';
import { atomicWriteTextFile } from './atomicWrite.ts';
import { searchUserArguments } from './rag/userArgumentIndex.ts';
import { searchSavedFlowReviewArguments, setFlowReviewArgumentDataRoot } from './rag/flowReviewArgumentIndex';

let dataRoot = '';
let queue: Promise<unknown> = Promise.resolve();
export function setCognitionMaterialDataRoot(root: string): void {
  setFlowReviewArgumentDataRoot(root);
  dataRoot = root;
}
function dir(): string {
  if (!dataRoot) throw new Error('个人认知素材目录尚未初始化');
  return path.join(dataRoot, 'user-state', 'cognition-materials');
}
function file(noteId: string): string {
  if (!noteId || noteId.length > 300) throw new Error('noteId 非法');
  return path.join(dir(), `project-${createHash('sha256').update(noteId).digest('hex').slice(0, 32)}.json`);
}
function serial<T>(work: () => Promise<T>): Promise<T> {
  const next = queue.then(work); queue = next.catch(() => undefined); return next;
}
async function sync(input: NoteRagIndexInput): Promise<void> {
  const rows = projectMaterialRows(input);
  if (!rows.length) { await fs.rm(file(input.id), { force: true }); return; }
  await fs.mkdir(dir(), { recursive: true });
  await atomicWriteTextFile(file(input.id), JSON.stringify({ schemaVersion: 1, noteId: input.id, rows }));
}
export function syncCognitionMaterialNote(input: NoteRagIndexInput): Promise<void> { return serial(() => sync(input)); }
export function deleteCognitionMaterialNote(id: string): Promise<void> {
  const target = file(id); // Freeze the root before waiting behind another sync.
  return serial(() => fs.rm(target, { force: true }));
}
export function syncCognitionMaterialNotes(inputs: NoteRagIndexInput[]): Promise<void> {
  return serial(async () => {
    for (const input of inputs) await sync(input);
    const live = new Set(inputs.filter((n) => n.noteType === 'project').map((n) => path.basename(file(n.id))));
    const names = await fs.readdir(dir()).catch((e) => { if (e.code === 'ENOENT') return []; throw e; });
    for (const name of names) if (/^project-[a-f0-9]{32}\.json$/u.test(name) && !live.has(name)) {
      await fs.rm(path.join(dir(), name), { force: true }); // Derived cache only, originals remain intact.
    }
  });
}

/** Private text, saved review graphs and published graphs stay independent, nonfactual channels. */
export async function searchCognitionMaterials(query: string): Promise<CognitionMaterialHit[]> {
  await queue;
  const names = await fs.readdir(dir()).catch((e) => { if (e.code === 'ENOENT') return []; throw e; });
  const rows: ProjectMaterialRow[] = [];
  for (const name of names.filter((n) => /^project-[a-f0-9]{32}\.json$/u.test(n))) {
    const value = JSON.parse(await fs.readFile(path.join(dir(), name), 'utf8'));
    if (value.schemaVersion !== 1 || path.basename(file(value.noteId)) !== name || !Array.isArray(value.rows)) continue;
    rows.push(...value.rows.filter((r: ProjectMaterialRow) => r.noteId === value.noteId && typeof r.text === 'string'
      && r.text.length <= 900 && r.sourceKind === 'project-restatement' && r.stance === 'not_assessed' && r.usableAsFactEvidence === false));
  }
  // No cloud call/model initialization for an own-view query. Existing graph
  // embeddings remain usable elsewhere; empty query vector selects lexical mode.
  const graphs = await searchUserArguments(query, [], 4);
  const reviewGraphs = await searchSavedFlowReviewArguments(query);
  const graphHits: CognitionMaterialHit[] = graphs.flatMap((r) => {
    const first = r.argumentHits?.find((h) => h.match === 'direct');
    if (!first) return [];
    const text = r.argumentHits!.map((h) => h.text).join('\n');
    return [{ noteId: r.noteId, title: r.title, text: text.slice(0, 1000), textTruncated: text.length > 1000,
      passageId: `${first.argumentDocId}:${first.revisionHash}:${first.nodeId}`, score: r.score,
      sourceKind: 'published-argument', stance: 'not_assessed', usableAsFactEvidence: false,
      argumentDocId: first.argumentDocId, revisionHash: first.revisionHash, nodeId: first.nodeId,
      relationSummary: r.relationSummary, argumentHits: r.argumentHits }];
  });
  // Two per channel prevents a long project from crowding out graph structures.
  return [...rankProjectMaterials(rows, query, 2), ...reviewGraphs.slice(0, 2), ...graphHits.slice(0, 2)];
}
