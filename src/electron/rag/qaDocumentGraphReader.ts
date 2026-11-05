import {promises as fs} from 'node:fs';
import path from 'node:path';
import {getRagIndexDir, readManifest, readChunksFile, withDocumentSourceSnapshot} from '../ragIndex';
import {buildQaDocumentGraph, emptyQaDocumentGraph, validateQaGraphAnchors} from '../../services/agent/qaDocumentGraph';
import type {KnowledgeShard} from './knowledgeStore';
import {readSavedDocumentGraph} from './documentGraphStore';
import {projectSavedDocumentGraphs, combineDocumentGraphPackets} from './documentGraphProjection';
import {generateEmbedding} from './embedding';
import {readSavedDocumentArgumentV5} from './documentArgumentV5Store';
import {projectDocumentArgumentV5} from './documentArgumentV5Retrieval';
import { resolveDocumentArgumentV5Sources } from './documentArgumentV5Sources.ts';
import {DEFAULT_DOCUMENT_RETRIEVAL_STRATEGY,type DocumentRetrievalStrategy} from '../../services/agent/documentRetrievalPolicy';

/** Existing-source read only. Paths use validated document IDs and the captured storage root. */
export async function readQaDocumentGraph(raw: unknown, query?:string, embed=generateEmbedding,
  options:{retrievalStrategy?:DocumentRetrievalStrategy;intentQuery?:string}={}) {
  const anchors = validateQaGraphAnchors(raw);
  if(query!==undefined&&(typeof query!=='string'||query.length>2000))throw new Error('qa_graph_query_budget');
  if(options.intentQuery!==undefined&&(typeof options.intentQuery!=='string'||options.intentQuery.length>2000))throw new Error('qa_graph_query_budget');
  // Local embedding outside the source transaction. The caller checks vault epochs on return.
  const vector=query?.trim()?await embed(query):undefined;
  return withDocumentSourceSnapshot(async () => {
    const indexDir = await getRagIndexDir();
    const manifest = await readManifest(), ready = new Set(manifest.filter(d => d.status === 'ready' || d.parseStatus === 'ready').map(d => d.id));
    const ids = [...new Set(anchors.map(a => a.docId))].filter(id => ready.has(id));
    const shards: KnowledgeShard[] = [];
    for (const id of ids) {
      try {
        const shard = JSON.parse(await fs.readFile(path.join(indexDir, `knowledge-${id}.json`), 'utf8')) as KnowledgeShard;
        if (shard.schemaVersion === 1 && shard.docId === id && ['ready', 'partial'].includes(shard.status)
          && Array.isArray(shard.committedChunkIds) && Array.isArray(shard.argumentUnits) && Array.isArray(shard.argumentEdges)) shards.push(shard);
      } catch { /* Missing graph does not make a readable passage unavailable. */ }
    }
    const chunks = (await Promise.all(ids.map(readChunksFile))).flat();
    const v5=(await Promise.all(ids.map(id=>readSavedDocumentArgumentV5(indexDir,id,chunks))))
      .filter(g=>g!==null).filter(g=>g.sourceBasis || manifest.some(d=>d.id===g.docId&&d.status==='ready'&&!d.needsReindex));
    const v5Ids=new Set(v5.map(g=>g.docId));
    const native = (await Promise.all(ids.filter(id=>!v5Ids.has(id)&&manifest.some(d=>d.id===id&&d.status==='ready'&&!d.needsReindex)).map(id => readSavedDocumentGraph(indexDir,id,chunks)))).filter(g => g !== null);
    const v5Anchors=anchors.filter(a=>a.nodeId.startsWith('dg5:'));
    const nativeAnchors = anchors.filter(a => a.nodeId.startsWith('dg:')&&!v5Ids.has(a.docId));
    const legacyAnchors = anchors.filter(a => !a.nodeId.startsWith('dg:')&&!a.nodeId.startsWith('dg5:')&&!v5Ids.has(a.docId));
    const legacy = buildQaDocumentGraph({anchors:legacyAnchors, chunks,
      units: shards.flatMap(s => s.argumentUnits.filter(u => u.docId === s.docId && s.committedChunkIds.includes(u.chunkId))),
      edges: shards.flatMap(s => s.argumentEdges.filter(e => e.docId === s.docId && s.committedChunkIds.includes(e.chunkId)))});
    const v5Sources = (await Promise.all(v5.map(g => resolveDocumentArgumentV5Sources(indexDir, g, chunks)))).flat();
    const v5Packet=v5Anchors.length?projectDocumentArgumentV5(v5,chunks,v5Anchors,v5Sources,
      {strategy:options.retrievalStrategy||DEFAULT_DOCUMENT_RETRIEVAL_STRATEGY,query,intentQuery:options.intentQuery,vector}):undefined;
    if (!nativeAnchors.length) return v5Packet?(legacyAnchors.length?combineDocumentGraphPackets([v5Packet,legacy]):v5Packet):legacy;
    const current = projectSavedDocumentGraphs(native,chunks,nativeAnchors,vector);
    return combineDocumentGraphPackets([...(v5Packet?[v5Packet]:[]),current,...(legacyAnchors.length?[legacy]:[])]);
  });
}
