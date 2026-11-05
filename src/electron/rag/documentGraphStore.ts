import {promises as fs} from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import type {DocumentChunk} from '../../types';
import type {DocumentGraphCommit, SavedDocumentGraph} from '../../services/documentGraphTypes';
import {atomicWriteTextFile} from '../atomicWrite';
import {validateEntities} from '../../services/documentGraphProtocol';

const TYPES = new Set(['定义','命名','推理','事实陈述','假设','对比','举例','反例削弱','建议对策']);
export function assertGraphDocumentId(id: unknown): asserts id is string {
  if (typeof id !== 'string' || !/^[A-Za-z0-9_-][A-Za-z0-9._-]{0,159}$/u.test(id)
    || /[.]$/u.test(id)) throw new Error('document_graph_invalid_doc_id');
}
const file = (dir: string, docId: string) => {
  assertGraphDocumentId(docId); return path.join(dir, `argument-graph-${docId}.json`);
};
export function documentGraphFingerprint(docId: string, chunks: DocumentChunk[]): string {
  assertGraphDocumentId(docId);
  return createHash('sha256').update(JSON.stringify([docId, chunks.filter(c => c.docId === docId)
    .map(c => [c.id, c.index, c.content, c.textStart, c.textEnd, c.schemaVersion, c.sectionPath, c.embeddingModelVersion])
    .sort((a, b) => String(a[0]).localeCompare(String(b[0])))])).digest('hex');
}
export const qualifiedGraphNodeId = (g: SavedDocumentGraph, id: string) => `dg:${g.docId}:${g.revision}:${id}`;

/** Only coordinates are accepted from callers; stored text is reconstructed by the host. */
export function validateDocumentGraph(input: DocumentGraphCommit, chunks: DocumentChunk[]) {
  assertGraphDocumentId(input?.docId);
  if (Object.keys(input).some(k=>!['docId','nodes','previousRevision','relations','sourceFingerprint','unresolved','entities','entityRelations','build'].includes(k))
    || !/^[a-f0-9]{64}$/u.test(input.sourceFingerprint)
    || (input.previousRevision !== null && !/^[a-f0-9]{64}$/u.test(input.previousRevision))
    || input.sourceFingerprint !== documentGraphFingerprint(input.docId, chunks)) throw new Error('document_graph_source_changed');
  if (!Array.isArray(input.nodes) || input.nodes.length > 640
    || !Array.isArray(input.relations) || input.relations.length > 1280
    || !Array.isArray(input.unresolved) || input.unresolved.length > 128
    || input.unresolved.some(s => typeof s !== 'string' || s.length > 600)) throw new Error('document_graph_budget');
  const byChunk = new Map(chunks.filter(c => c.docId === input.docId).map(c => [c.id, c]));
  if (byChunk.size !== chunks.filter(c => c.docId === input.docId).length) throw new Error('document_graph_duplicate_chunk');
  const ids = new Set<string>(); let characters = 0;
  const nodes = input.nodes.map(n => {
    if (!n || Object.keys(n).sort().join('|') !== 'graphId|id|source|type'
      || !/^[A-Za-z0-9_-]{1,64}$/u.test(n.graphId) || typeof n.id !== 'string'
      || !n.id.startsWith(`${n.graphId}:`) || !/^[A-Za-z0-9_:-]{1,128}$/u.test(n.id)
      || ids.has(n.id) || !TYPES.has(n.type) || !Array.isArray(n.source)
      || !n.source.length || n.source.length > 12) throw new Error('document_graph_invalid_node');
    ids.add(n.id);
    const fragments = new Set<string>();
    const texts = n.source.map(s => {
      const c = byChunk.get(s?.chunkId), key = JSON.stringify(s);
      if (!s || Object.keys(s).sort().join('|') !== 'chunkId|end|start' || !c
        || !Number.isSafeInteger(s.start) || !Number.isSafeInteger(s.end)
        || s.start < 0 || s.end <= s.start || s.end > c.content.length || fragments.has(key)) throw new Error('document_graph_invalid_source');
      fragments.add(key); return c.content.slice(s.start, s.end);
    });
    const text = texts.join('\n'); characters += text.length;
    if (!text.trim() || text.length > 12000 || characters > 1_000_000) throw new Error('document_graph_text_budget');
    return {...n, source: n.source.map(s => ({...s})), text};
  });
  const edgeIds = new Set<string>(), signatures = new Set<string>();
  const relations = input.relations.map(r => {
    if (!r || Object.keys(r).sort().join('|') !== 'from|id|kind|reason|to'
      || typeof r.id !== 'string' || !/^[A-Za-z0-9_:-]{1,128}$/u.test(r.id) || edgeIds.has(r.id)
      || !['support','oppose','explain'].includes(r.kind) || !Array.isArray(r.from) || !r.from.length || r.from.length > 12
      || new Set(r.from).size !== r.from.length || r.from.includes(r.to) || [...r.from, r.to].some(id => !ids.has(id))
      || typeof r.reason !== 'string' || !r.reason.trim() || r.reason.length > 600) throw new Error('document_graph_invalid_relation');
    const signature = JSON.stringify([r.kind, [...r.from].sort(), r.to]);
    if (signatures.has(signature)) throw new Error('document_graph_duplicate_relation');
    edgeIds.add(r.id); signatures.add(signature); return {...r, from: [...r.from]};
  });
  // Opposing paths are not positive premises. Same-kind proof/explanation cycles are not admitted.
  for (const kind of ['support','explain']) {
    const adjacency = new Map<string, string[]>();
    for (const r of relations.filter(r => r.kind === kind)) for (const from of r.from)
      adjacency.set(from, [...(adjacency.get(from) || []), r.to]);
    const active = new Set<string>(), done = new Set<string>();
    const visit = (id: string) => {
      if (active.has(id)) throw new Error('document_graph_relation_cycle');
      if (done.has(id)) return;
      active.add(id); for (const next of adjacency.get(id) || []) visit(next); active.delete(id); done.add(id);
    };
    for (const id of ids) visit(id);
  }
  validateEntities(input.entities||[],input.entityRelations||[],new Map(nodes.map(n=>[n.id,n.text])));
  if(input.build){const b=input.build;
    if(Object.keys(b).sort().join('|')!=='completedWindowIds|totalWindows|version|windowPlanFingerprint'||b.version!=='document-pipeline-v1'||!Number.isSafeInteger(b.totalWindows)||b.totalWindows<1||b.totalWindows>4096||!/^[a-f0-9]{64}$/u.test(b.windowPlanFingerprint)
      ||!Array.isArray(b.completedWindowIds)||b.completedWindowIds.length>b.totalWindows||new Set(b.completedWindowIds).size!==b.completedWindowIds.length
      ||b.completedWindowIds.some(id=>!/^W[1-9]\d*$/u.test(id)))throw new Error('document_graph_build_progress');
  }
  return {nodes, relations};
}

export async function readSavedDocumentGraph(dir: string, docId: string, chunks: DocumentChunk[]): Promise<SavedDocumentGraph | null> {
  const target = file(dir, docId);
  try {
    if(await fs.stat(path.join(dir,`argument-graph-v5-${docId}.json`)).then(()=>true,()=>false))return null;
    const stat = await fs.stat(target); if (stat.size > 20_000_000) return null;
    const g = JSON.parse(await fs.readFile(target, 'utf8')) as SavedDocumentGraph;
    if (g.schemaVersion !== 1 || g.semanticCertified !== false || g.docId !== docId
      || !/^[a-f0-9]{64}$/u.test(g.revision) || g.embeddingModel !== 'paraphrase-multilingual-MiniLM-L12-v2') return null;
    const replay = validateDocumentGraph({docId, sourceFingerprint:g.sourceFingerprint, previousRevision:g.previousRevision,
      nodes:g.nodes.map(({text:_text, embedding:_embedding, ...n}) => n), relations:g.relations, unresolved:g.unresolved,
      ...(g.entities?{entities:g.entities.map(({embedding:_v,...e})=>e)}:{}),...(g.entityRelations?{entityRelations:g.entityRelations}:{}),...(g.build?{build:g.build}:{})}, chunks);
    if (g.nodes.some((n, i) => n.text !== replay.nodes[i].text || !validVector(n.embedding))) return null;
    if(g.entities?.some(e=>!validVector(e.embedding)))return null;
    if (graphRevision(g) !== g.revision) return null;
    return g;
  } catch { return null; }
}
const validVector = (v: unknown): v is number[] => Array.isArray(v) && v.length === 384
  && v.every(n => typeof n === 'number' && Number.isFinite(n)) && v.some(n => n !== 0);
function graphRevision(g: Omit<SavedDocumentGraph, 'revision'> | SavedDocumentGraph): string {
  const {revision:_revision, ...content} = g as SavedDocumentGraph;
  return createHash('sha256').update(JSON.stringify(content)).digest('hex');
}

/** Caller holds the source transaction and checks CAS/source again after local embeddings finish. */
export async function saveDocumentGraph(dir: string, input: DocumentGraphCommit, chunks: DocumentChunk[], vectors: number[][],entityVectors:number[][]=[]) {
  if(await fs.stat(path.join(dir,`argument-graph-v5-${input.docId}.json`)).then(()=>true,()=>false))throw new Error('document_graph_superseded_by_v5');
  const replay = validateDocumentGraph(input, chunks);
  if (vectors.length !== replay.nodes.length || vectors.some(v => !validVector(v))) throw new Error('document_graph_invalid_embedding');
  if(entityVectors.length!==(input.entities?.length||0)||entityVectors.some(v=>!validVector(v)))throw new Error('document_graph_invalid_entity_embedding');
  const current = await readSavedDocumentGraph(dir, input.docId, chunks);
  if ((current?.revision || null) !== input.previousRevision) throw new Error('document_graph_revision_changed');
  const content: Omit<SavedDocumentGraph, 'revision'> = {...input, schemaVersion:1,
    entities:input.entities?.map((e,i)=>({...e,embedding:entityVectors[i]})),
    nodes:replay.nodes.map((n,i) => ({...n, embedding:[...vectors[i]]})), relations:replay.relations,
    unresolved:[...input.unresolved], embeddingModel:'paraphrase-multilingual-MiniLM-L12-v2', semanticCertified:false};
  const saved: SavedDocumentGraph = {...content, revision:graphRevision(content)};
  await atomicWriteTextFile(file(dir,input.docId), JSON.stringify(saved));
  return {revision:saved.revision, nodes:saved.nodes.length, relations:saved.relations.length};
}
