import {promises as fs} from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {getRagIndexDir, readChunksFile, readManifest, readStructuredDocumentFile, withDocumentSourceSnapshot} from '../ragIndex';
import {documentGraphWindows} from './documentGraphWindows';
import {rankDocumentGraphEntries} from './documentGraphRetrieval';
import {projectSavedDocumentGraphs} from './documentGraphProjection';
import {qualifiedGraphNodeId} from './documentGraphStore';
import {generateEmbedding} from './embedding';
import {assertGraphDocumentId, documentGraphFingerprint, readSavedDocumentGraph, saveDocumentGraph, validateDocumentGraph} from './documentGraphStore';
import type {DocumentGraphCommit, DocumentGraphSourceSnapshot} from '../../services/documentGraphTypes';
import {readProcessingDocumentArgumentV5,readSavedDocumentArgumentV5,documentArgumentV5File} from './documentArgumentV5Store';
import {fileExists,argumentWorkingFile,argumentRebuildMarker} from './documentArgumentReplacement';
import {documentArgumentComponents} from '../../services/documentArgumentV5Protocol';
import {DOCUMENT_ARGUMENT_V5_BRIDGE_PROTOCOL} from '../../services/documentArgumentV5Types';
const planHash=(windows:unknown)=>createHash('sha256').update(JSON.stringify(windows)).digest('hex');

async function source(docId: string) {
  assertGraphDocumentId(docId);
  const dir = await getRagIndexDir();
  const settings = JSON.parse(await fs.readFile(path.join(dir,'knowledge-settings.json'),'utf8'));
  if (settings.enabled !== true) throw new Error('document_graph_disabled');
  const doc = (await readManifest()).find(d => d.id === docId && d.status === 'ready' && !d.needsReindex);
  if (!doc) throw new Error('document_graph_source_not_ready');
  const chunks = await readChunksFile(docId);
  if (!chunks.length) throw new Error('document_graph_missing_chunks');
  return {dir, chunks};
}
export function listDocumentsWithGraphProgress(){
  return withDocumentSourceSnapshot(async()=>{
    const dir=await getRagIndexDir(),docs=await readManifest();
    return Promise.all(docs.map(async d=>{
      const chunks=await readChunksFile(d.id),v5=await readProcessingDocumentArgumentV5(dir,d.id,chunks);
      const active=await readSavedDocumentArgumentV5(dir,d.id,chunks),rebuilding=await fileExists(argumentRebuildMarker(dir,d.id));
      const pending=await fileExists(argumentWorkingFile(dir,d.id));
      const stale=(!rebuilding&&!active&&await fileExists(documentArgumentV5File(dir,d.id)))||(!v5&&pending);
      const bridgeUpgrade=!!v5&&v5.build.completedWindowIds.length===v5.build.totalWindows&&v5.build.bridgeStatus==='complete'
        &&v5.build.bridgeProtocol!==DOCUMENT_ARGUMENT_V5_BRIDGE_PROTOCOL&&documentArgumentComponents(v5).length>1;
      if(v5)return {...d,documentGraphProgress:{version:'v5.0' as const,completedWindows:v5.build.completedWindowIds.length,
        totalWindows:v5.build.totalWindows,nodes:v5.nodes.length,entities:0,unresolved:v5.unresolved.length+(v5.pendingEdges?.length||0),rebuilding,published:!!active,stale,
        bridgeReviewRequired:v5.build.bridgeStatus==='review_required',
        publicationPending:pending&&v5.build.bridgeStatus==='complete'&&v5.build.completedWindowIds.length===v5.build.totalWindows,
        bridgePending:(v5.build.bridgeStatus!=='complete'||bridgeUpgrade)&&v5.build.completedWindowIds.length===v5.build.totalWindows}};
      if(stale||rebuilding)return {...d,documentGraphProgress:{version:'v5.0' as const,completedWindows:0,totalWindows:active?.build.totalWindows||0,
        nodes:0,entities:0,unresolved:0,stale,rebuilding,published:!!active}};
      const g=d.status==='ready'&&!d.needsReindex?await readSavedDocumentGraph(dir,d.id,chunks):null;
      return g?.build?{...d,documentGraphProgress:{completedWindows:g.build.completedWindowIds.length,totalWindows:g.build.totalWindows,
        nodes:g.nodes.length,entities:g.entities?.length||0,unresolved:g.unresolved.length}}:d;
    }));
  });
}
export function prepareDocumentGraphSource(docId: string): Promise<DocumentGraphSourceSnapshot> {
  assertGraphDocumentId(docId);
  return withDocumentSourceSnapshot(async () => {
    const {dir,chunks} = await source(docId), current = await readSavedDocumentGraph(dir,docId,chunks);
    const planned=documentGraphWindows(chunks,await readStructuredDocumentFile(docId));
    const prior=current ? {docId:current.docId,sourceFingerprint:current.sourceFingerprint,previousRevision:current.previousRevision,
      nodes:current.nodes.map(({text:_t,embedding:_v,...n})=>n),relations:current.relations,unresolved:current.unresolved,
      ...(current.entities?{entities:current.entities.map(({embedding:_v,...e})=>e)}:{}),...(current.entityRelations?{entityRelations:current.entityRelations}:{}),...(current.build?{build:current.build}:{})} : undefined;
    return {docId, sourceFingerprint:documentGraphFingerprint(docId,chunks), previousRevision:current?.revision || null,
      chunks:chunks.map(c => ({id:c.id,sectionPath:c.sectionPath,content:c.content})),...planned,windowPlanFingerprint:planHash(planned.windows),current:prior};
  });
}

/** Explicit commit only. Local embeddings run outside the short source transaction; then source/CAS are rechecked. */
export async function commitDocumentGraph(input: DocumentGraphCommit, options: {
  assertEnvironment?: () => void; embed?: (text: string) => Promise<number[]>;
} = {}) {
  // Isolate against caller mutation while asynchronous embeddings are running.
  if (!input || JSON.stringify(input).length > 2_000_000) throw new Error('document_graph_input_budget');
  const captured: DocumentGraphCommit = JSON.parse(JSON.stringify(input));
  assertGraphDocumentId(captured.docId); options.assertEnvironment?.();
  const snapshot = await withDocumentSourceSnapshot(async () => {
    const state = await source(captured.docId), replay = validateDocumentGraph(captured,state.chunks);
    const current = await readSavedDocumentGraph(state.dir,captured.docId,state.chunks);
    if ((current?.revision || null) !== captured.previousRevision) throw new Error('document_graph_revision_changed');
    if(captured.build){
      const plan=documentGraphWindows(state.chunks,await readStructuredDocumentFile(captured.docId));
      if(planHash(plan.windows)!==captured.build.windowPlanFingerprint||plan.windows.length!==captured.build.totalWindows
        ||captured.build.completedWindowIds.some((id,i)=>id!==plan.windows[i]?.id))throw new Error('document_graph_window_plan_changed');
    }
    return {...state, replay};
  });
  const vectors: number[][] = [];
  for (const n of snapshot.replay.nodes) {options.assertEnvironment?.(); vectors.push(await (options.embed || generateEmbedding)(n.text));}
  const entityVectors:number[][]=[];
  for(const e of captured.entities||[]){options.assertEnvironment?.();entityVectors.push(await (options.embed||generateEmbedding)([...new Set([e.name,...e.mentions.filter(m=>!m.reference).map(m=>m.quote)])].join('；')));}
  options.assertEnvironment?.();
  return withDocumentSourceSnapshot(async () => {
    options.assertEnvironment?.(); const current = await source(captured.docId);
    if (current.dir !== snapshot.dir) throw new Error('document_graph_environment_changed');
    if(captured.build&&planHash(documentGraphWindows(current.chunks,await readStructuredDocumentFile(captured.docId)).windows)!==captured.build.windowPlanFingerprint)throw new Error('document_graph_window_plan_changed');
    return saveDocumentGraph(current.dir,captured,current.chunks,vectors,entityVectors);
  });
}

/** Full-document candidate recall over the previously committed graphs; IDs are not embedded. */
export async function recallDocumentGraphCandidates(input:DocumentGraphCommit,targetIds:string[],embed=generateEmbedding){
  if(!Array.isArray(targetIds)||targetIds.length>8||new Set(targetIds).size!==targetIds.length)throw new Error('cross_graph_target_budget');
  const state=await withDocumentSourceSnapshot(async()=>{
    const s=await source(input.docId),draft=validateDocumentGraph(input,s.chunks),prior=await readSavedDocumentGraph(s.dir,input.docId,s.chunks);
    if((prior?.revision||null)!==input.previousRevision)throw new Error('document_graph_revision_changed');
    if(targetIds.some(id=>!draft.nodes.some(n=>n.id===id)))throw new Error('cross_graph_unknown_target');
    return {...s,draft,prior};
  });
  const result:Record<string,string[]>={};
  for(const id of targetIds){
    const target=state.draft.nodes.find(n=>n.id===id)!;
    if(!state.prior){result[id]=[];continue;}
    const vector=await embed(target.text),g=state.prior;
    const entries=rankDocumentGraphEntries([g],target.text,vector).filter(e=>g.nodes.find(n=>qualifiedGraphNodeId(g,n.id)===e.nodeId)?.graphId!==target.graphId).slice(0,3);
    const packet=projectSavedDocumentGraphs([g],state.chunks,entries.map(e=>({docId:g.docId,nodeId:e.nodeId})),vector);
    const inverse=new Map(g.nodes.map(n=>[qualifiedGraphNodeId(g,n.id),n]));
    result[id]=packet.nodes.map(n=>inverse.get(n.nodeId)!).filter(n=>n.graphId!==target.graphId).map(n=>n.id).slice(0,16);
  }
  await withDocumentSourceSnapshot(async()=>{const latest=await source(input.docId),prior=await readSavedDocumentGraph(latest.dir,input.docId,latest.chunks);
    if(latest.dir!==state.dir||documentGraphFingerprint(input.docId,latest.chunks)!==input.sourceFingerprint||(prior?.revision||null)!==input.previousRevision)throw new Error('document_graph_source_changed');});
  return result;
}
