import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import type { DocumentChunk } from '../../types';
import type { DocumentArgumentPlan, DocumentArgumentV5Commit, SavedDocumentArgumentV5 } from '../../services/documentArgumentV5Types';
import { DOCUMENT_ARGUMENT_V5_BRIDGE_PROTOCOL, DOCUMENT_ARGUMENT_V5_VERSION } from '../../services/documentArgumentV5Types';
import { DOCUMENT_ARGUMENT_V5_BATCH_TEXT_PROMPT } from '../../workflows/documentArgumentV5Prompt';
import {DOCUMENT_ARGUMENT_V5_LEGACY_WINDOW_PROMPT,DOCUMENT_ARGUMENT_V5_LEGACY_BATCH_TEXT_PROMPT} from '../../workflows/documentArgumentV5LegacyPrompt';
import { replayDocumentArgumentNode, validateDocumentArgumentV5Graph, recordDocumentArgumentV5Issues, v5Demand } from '../../services/documentArgumentV5Protocol';
import { assertGraphDocumentId, documentGraphFingerprint } from './documentGraphStore';
import { atomicWriteTextFile } from '../atomicWrite';
import {argumentWorkingFile,argumentRebuildMarker,fileExists,startArgumentReplacement,removeSupersededDocumentArguments} from './documentArgumentReplacement';
import {validateDocumentArgumentRoleEvidence} from '../../services/documentArgumentRoleRevisions';
import { documentArgumentSourceFingerprint, isStructuredArgumentSource, resolveDocumentArgumentV5Sources, STRUCTURED_ARGUMENT_SOURCE } from './documentArgumentV5Sources.ts';

export const documentArgumentV5Hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export const DOCUMENT_ARGUMENT_V5_LEGACY_PROMPT_HASH = createHash('sha256').update(DOCUMENT_ARGUMENT_V5_LEGACY_WINDOW_PROMPT).digest('hex');
export const DOCUMENT_ARGUMENT_V5_LEGACY_BATCH_PROMPT_HASH = createHash('sha256').update(DOCUMENT_ARGUMENT_V5_LEGACY_BATCH_TEXT_PROMPT).digest('hex');
export const DOCUMENT_ARGUMENT_V5_PROMPT_HASH = createHash('sha256').update(DOCUMENT_ARGUMENT_V5_BATCH_TEXT_PROMPT).digest('hex');
const acceptedPromptHashes=new Set([DOCUMENT_ARGUMENT_V5_LEGACY_PROMPT_HASH,DOCUMENT_ARGUMENT_V5_LEGACY_BATCH_PROMPT_HASH,DOCUMENT_ARGUMENT_V5_PROMPT_HASH]);
export function documentArgumentV5File(dir: string, docId: string) {
  assertGraphDocumentId(docId);
  return path.join(dir, `argument-graph-v5-${docId}.json`);
}
/** Compatibility name: explicit re-indexing stages a replacement and keeps the old active graph. */
export async function archiveDocumentArgumentV5(dir: string, docId: string) {
  await startArgumentReplacement(dir,docId);
}
const vectorValid = (v: unknown): v is number[] => Array.isArray(v) && v.length === 384 && v.every(n => typeof n === 'number' && Number.isFinite(n)) && v.some(n => n !== 0);
export function validateDocumentArgumentV5Commit(input: DocumentArgumentV5Commit, chunks: DocumentChunk[], plan?: DocumentArgumentPlan) {
  assertGraphDocumentId(input?.docId);
  v5Demand(Object.keys(input).every(k => ['docId', 'sourceFingerprint', 'previousRevision', 'nodes', 'arguments', 'relations', 'unresolved', 'roleRevisions', 'pendingEdges', 'edgeAudits', 'build', 'tableBindings'].includes(k)), '提交字段');
  v5Demand(input.sourceFingerprint === documentArgumentSourceFingerprint(input.docId, chunks)
    && (input.previousRevision === null || /^[a-f0-9]{64}$/u.test(input.previousRevision)), '资料来源版本');
  validateDocumentArgumentV5Graph(input,{qualityMode:'record'});
  const build = input.build;
  v5Demand(build && build.version === DOCUMENT_ARGUMENT_V5_VERSION && acceptedPromptHashes.has(build.promptHash)
    && /^[a-f0-9]{64}$/u.test(build.windowPlanFingerprint) && Array.isArray(build.completedWindowIds)
    && Number.isSafeInteger(build.totalWindows) && build.totalWindows >= 0 && build.totalWindows <= 10000
    && build.completedWindowIds.length <= build.totalWindows && new Set(build.completedWindowIds).size === build.completedWindowIds.length
    && Number.isSafeInteger(build.batchCount) && build.batchCount >= 0 && ['pending', 'review_required', 'complete'].includes(build.bridgeStatus)
    && (build.bridgeProtocol===undefined||[DOCUMENT_ARGUMENT_V5_BRIDGE_PROTOCOL,'v508-role-bridge-v5','ordinal-context-v1','ordinal-claim-context-v2','ordinal-role-refinement-v3','recoverable-role-bridge-v4'].includes(build.bridgeProtocol))
    && Array.isArray(build.batches) && build.batches.length === build.batchCount
    && build.batches.every(b=>b.promptHash===undefined||acceptedPromptHashes.has(b.promptHash)), '处理进度或冻结版本');
  v5Demand(build.bridgeReviews===undefined||Array.isArray(build.bridgeReviews)&&build.bridgeReviews.length<=8000
    &&build.bridgeReviews.every(review=>review&&Array.isArray(review.nodeIds)&&review.nodeIds.length>0
      &&new Set(review.nodeIds).size===review.nodeIds.length&&review.nodeIds.every(id=>input.nodes.some(node=>node.id===id))
      &&(review.proposalIds===undefined||Array.isArray(review.proposalIds)&&review.proposalIds.length>0
        &&new Set(review.proposalIds).size===review.proposalIds.length&&review.proposalIds.every(id=>typeof id==='string'&&id.length<=100))
      &&['independent','unresolved'].includes(review.decision)&&Number.isSafeInteger(review.round)&&review.round>0
      &&typeof review.basis==='string'&&!!review.basis.trim()&&review.basis.length<=600),'补链复核记录');
  v5Demand((input.pendingEdges||[]).every(edge=>edge.batch<=build.batchCount),'待复核关系批次');
  if(build.bridgeProtocol===DOCUMENT_ARGUMENT_V5_BRIDGE_PROTOCOL&&build.bridgeStatus==='complete'){
    v5Demand(build.totalWindows===0||input.nodes.length>0,'正文未形成任何论证节点，不得发布空图');
  }
  if (plan) {
    v5Demand(documentArgumentV5Hash(plan) === build.windowPlanFingerprint && build.totalWindows === plan.windows.length
      && build.completedWindowIds.every((n, i) => n === plan.windows[i]?.id), '窗口计划已变化');
    const completed = plan.windows.slice(0, build.completedWindowIds.length).flatMap(w => w.parts);
    for (const n of input.nodes) for (const s of n.source) {
      v5Demand(completed.some(p => p.chunkId === s.chunkId && s.start >= p.start && s.end <= p.end), `${n.id} 来源未完成或不是正文`);
    }
  }
  let chars = 0;
  const nodes = input.nodes.map(n => {
    v5Demand(Object.keys(n).sort().join('|') === (n.fallbackText===undefined?'batch|id|role|source':'batch|fallbackText|id|role|source') && n.batch <= build.batchCount, '节点字段');
    for (const s of n.source) v5Demand(Object.keys(s).sort().join('|') === 'chunkId|end|start', '来源字段');
    const text = replayDocumentArgumentNode(n, chunks.filter(c => c.docId === input.docId));
    chars += text.length;
    v5Demand(text.trim() && text.length <= 20000 && chars <= 2_000_000, '节点文本预算');
    return { ...n, text };
  });
  validateDocumentArgumentRoleEvidence(input,new Map(nodes.map(node=>[node.id,node.text])));
  v5Demand((input.roleRevisions||[]).every(event=>event.batch<=build.batchCount),'角色修订批次');
  v5Demand(Array.isArray(input.tableBindings) && input.tableBindings.length <= 4000 && input.tableBindings.every(b => input.nodes.some(n => n.id === b.nodeId)
    && (!plan || plan.objects.some(o => o.id === b.tableId && o.kind === 'table'))), '表格绑定');
  return nodes;
}

export async function readSavedDocumentArgumentV5(dir: string, docId: string, chunks: DocumentChunk[], working=false): Promise<SavedDocumentArgumentV5 | null> {
  try {
    const target = working?argumentWorkingFile(dir,docId):documentArgumentV5File(dir, docId), stat = await fs.stat(target);
    if (stat.size > 30_000_000) return null;
    const g = JSON.parse(await fs.readFile(target, 'utf8')) as SavedDocumentArgumentV5;
    v5Demand(g.schemaVersion === 2 && g.docId === docId && g.semanticCertified === false && g.embeddingModel === 'paraphrase-multilingual-MiniLM-L12-v2', '保存版本');
    v5Demand(g.sourceBasis === undefined || g.sourceBasis === STRUCTURED_ARGUMENT_SOURCE, '来源格式');
    const { revision, schemaVersion: _s, embeddingModel: _m, semanticCertified: _c, sourceBasis: _basis, objects, ...commit } = g;
    const sources = await resolveDocumentArgumentV5Sources(dir, g, chunks);
    const replay = validateDocumentArgumentV5Commit({ ...commit, nodes: g.nodes.map(({ text: _t, embedding: _v, ...n }) => n) }, sources);
    v5Demand(g.nodes.every((n, i) => n.text === replay[i].text && vectorValid(n.embedding)), '已存文本或向量');
    const { revision: _r, ...content } = g;
    v5Demand(documentArgumentV5Hash(content) === revision && Array.isArray(objects), '保存校验和');
    return g;
  } catch { return null; }
}

export async function readProcessingDocumentArgumentV5(dir:string,docId:string,chunks:DocumentChunk[]){
  if(await fileExists(argumentWorkingFile(dir,docId)))return readSavedDocumentArgumentV5(dir,docId,chunks,true);
  if(await fileExists(argumentRebuildMarker(dir,docId)))return null;
  return readSavedDocumentArgumentV5(dir,docId,chunks);
}

export async function saveDocumentArgumentV5(dir: string, input: DocumentArgumentV5Commit, chunks: DocumentChunk[], plan: DocumentArgumentPlan, vectors: number[][]) {
  input=structuredClone(input);
  recordDocumentArgumentV5Issues(input);
  const nodes = validateDocumentArgumentV5Commit(input, chunks, plan);
  v5Demand(vectors.length === nodes.length && vectors.every(vectorValid), '本地向量');
  const current = await readProcessingDocumentArgumentV5(dir, input.docId, chunks);
  const exists = await fileExists(argumentWorkingFile(dir,input.docId))||(!(await fileExists(argumentRebuildMarker(dir,input.docId)))&&await fileExists(documentArgumentV5File(dir,input.docId)));
  v5Demand(!exists || current, '已存图谱不可读，未覆盖旧文件');
  v5Demand((current?.revision || null) === input.previousRevision, '图谱版本已变化');
  const content = { ...input, schemaVersion: 2 as const, nodes: nodes.map((n, i) => ({ ...n, embedding: vectors[i] })),
    ...(chunks.length && chunks.every(c => isStructuredArgumentSource(input.docId, c.id)) ? { sourceBasis: STRUCTURED_ARGUMENT_SOURCE } : {}),
    embeddingModel: 'paraphrase-multilingual-MiniLM-L12-v2' as const, objects: plan.objects, semanticCertified: false as const };
  const saved: SavedDocumentArgumentV5 = { ...content, revision: documentArgumentV5Hash(content) };
  await atomicWriteTextFile(argumentWorkingFile(dir, input.docId), JSON.stringify(saved));
  // Publication means extraction is finished, not that every semantic warning
  // was resolved. The saved graph remains explicitly semanticCertified=false.
  if(input.build.completedWindowIds.length===input.build.totalWindows){
    await atomicWriteTextFile(documentArgumentV5File(dir,input.docId),JSON.stringify(saved));
    await removeSupersededDocumentArguments(dir,input.docId);
  }
  return { revision: saved.revision, nodes: saved.nodes.length, relations: saved.relations.length };
}
