import { promises as fs } from 'node:fs';
import path from 'node:path';
import { getRagIndexDir, readManifest, readChunksFile, readStructuredDocumentFile, withDocumentSourceSnapshot } from '../ragIndex';
import { assertGraphDocumentId, documentGraphFingerprint } from './documentGraphStore';
import { planDocumentArgumentV5 } from './documentArgumentV5Plan';
import { documentArgumentV5File, documentArgumentV5Hash, DOCUMENT_ARGUMENT_V5_PROMPT_HASH, readProcessingDocumentArgumentV5, readSavedDocumentArgumentV5, saveDocumentArgumentV5, validateDocumentArgumentV5Commit,archiveDocumentArgumentV5 } from './documentArgumentV5Store';
import {argumentWorkingFile,argumentRebuildMarker,fileExists} from './documentArgumentReplacement';
import { generateEmbedding, cosineSimilarity } from './embedding';
import { replayDocumentArgumentNode, documentArgumentComponents, documentArgumentUniqueEdges, v5Demand } from '../../services/documentArgumentV5Protocol';
import {DOCUMENT_ARGUMENT_V5_BRIDGE_PROTOCOL} from '../../services/documentArgumentV5Types';
import type { DocumentArgumentV5Commit, DocumentArgumentV5Snapshot, SavedDocumentArgumentV5,DocumentArgumentGraphView,DocumentArgumentV5ResponseRecord } from '../../services/documentArgumentV5Types';
import { atomicWriteTextFile } from '../atomicWrite';
import { bm25Score, buildDf, tokenize } from '../hybridSearch';
import { documentArgumentSourceFingerprint, readDocumentArgumentSourceBlocks } from './documentArgumentV5Sources.ts';
import {documentArgumentQuoteHints} from '../../services/documentArgumentQuoteHints';
import {documentArgumentEffectiveRoles} from '../../services/documentArgumentRoleRevisions';

async function source(docId: string) {
  assertGraphDocumentId(docId);
  const dir = await getRagIndexDir();
  const settings = JSON.parse(await fs.readFile(path.join(dir, 'knowledge-settings.json'), 'utf8'));
  v5Demand(settings.enabled === true, '资料论证处理未启用');
  v5Demand((await readManifest()).some(d => d.id === docId && d.indexable), '资料不存在或不支持解析');
  const chunks = await readDocumentArgumentSourceBlocks(dir, docId);
  const structured=await readStructuredDocumentFile(docId);
  const plan = planDocumentArgumentV5(chunks, structured);
  return { dir, chunks, plan,quoteHints:documentArgumentQuoteHints(structured) };
}
function asCommit(g: SavedDocumentArgumentV5): DocumentArgumentV5Commit {
  const { schemaVersion: _s, revision: _r, embeddingModel: _e, objects: _o, semanticCertified: _c, sourceBasis: _basis, ...commit } = g;
  return { ...commit, nodes: g.nodes.map(({ text: _t, embedding: _v, ...n }) => n) };
}
export async function resetDocumentArgumentV5(docId:string){
  return withDocumentSourceSnapshot(async()=>{const state=await source(docId);await archiveDocumentArgumentV5(state.dir,docId);});
}
export async function recordDocumentArgumentV5Response(record:DocumentArgumentV5ResponseRecord,assertEnvironment:()=>void=()=>{}) {
  v5Demand(record&&['extract','bridge'].includes(record.stage)&&typeof record.raw==='string'&&record.raw.length<=2_000_000
    &&(record.error===undefined||typeof record.error==='string'&&record.error.length<=10000)
    &&(record.requestText===undefined||record.stage==='extract'&&typeof record.requestText==='string'&&record.requestText.length<=50000),'响应记录格式');
  const input=structuredClone(record);
  return withDocumentSourceSnapshot(async()=>{
    assertEnvironment();
    const state=await source(input.docId),prior=await readProcessingDocumentArgumentV5(state.dir,input.docId,state.chunks);
    v5Demand(input.sourceFingerprint===documentArgumentSourceFingerprint(input.docId,state.chunks)
      &&input.windowPlanFingerprint===documentArgumentV5Hash(state.plan)&&input.promptHash===DOCUMENT_ARGUMENT_V5_PROMPT_HASH
      &&input.previousRevision===(prior?.revision||null),'响应记录来源或版本已变化');
    assertEnvironment();
    // Whitelist fields: never persist model credentials or unrelated runtime configuration.
    await atomicWriteTextFile(path.join(state.dir,`argument-response-v5-${input.docId}-${input.stage}.json`),JSON.stringify({
      schemaVersion:1,docId:input.docId,sourceFingerprint:input.sourceFingerprint,windowPlanFingerprint:input.windowPlanFingerprint,
      promptHash:input.promptHash,previousRevision:input.previousRevision,stage:input.stage,raw:input.raw,
      error:input.error,requestText:input.requestText,savedAt:new Date().toISOString(),admitted:false,
    }));
  });
}
export async function readDocumentArgumentV5View(docId:string):Promise<DocumentArgumentGraphView>{
  assertGraphDocumentId(docId);
  return withDocumentSourceSnapshot(async()=>{
    const dir=await getRagIndexDir(),doc=(await readManifest()).find(d=>d.id===docId);
    v5Demand(doc?.indexable,'资料已删除或不支持解析');
    const chunks=await readChunksFile(docId),working=await fileExists(argumentWorkingFile(dir,docId));
    // Inspection follows the current generation. Retrieval continues to use only
    // the published graph until the replacement is complete.
    const graph=await readSavedDocumentArgumentV5(dir,docId,chunks,working);
    v5Demand(graph,'没有可读取的论证图；正文变化后请重新生成论证图');
    const effective=documentArgumentEffectiveRoles(graph);
    return {docId,published:!working,revision:graph.revision,
      progress:{batchCount:graph.build.batchCount,completedWindows:graph.build.completedWindowIds.length,totalWindows:graph.build.totalWindows},
      nodes:graph.nodes.map(({id,role,text,batch})=>({id,role:effective.get(id)!,...(effective.get(id)!==role?{originalRole:role}:{}),text,batch})),
      edges:[...graph.arguments.flatMap(a=>[
        ...(a.support.length?[{id:`${a.id}:support`,kind:'support' as const,from:a.support,to:a.claim,reason:'原文论证依据'}]:[]),
        ...a.oppose.map(id=>({id:`${a.id}:oppose:${id}`,kind:'oppose' as const,from:[id],to:a.claim,reason:'原文反对依据'}))]),
        ...graph.relations.map(r=>({...r,from:[r.from]}))],unresolved:[...graph.unresolved,...(graph.pendingEdges||[]).map(edge=>({
          batch:edge.batch,nodeId:edge.from,reason:`待复核关系：${edge.from} → ${edge.to} ${edge.kind}；${edge.reason}`.slice(0,600)}))]};
  });
}
export async function prepareDocumentArgumentV5(docId: string): Promise<DocumentArgumentV5Snapshot> {
  return withDocumentSourceSnapshot(async () => {
    const state = await source(docId), current = await readProcessingDocumentArgumentV5(state.dir, docId, state.chunks);
    const pending=await fileExists(argumentWorkingFile(state.dir,docId)),reset=await fileExists(argumentRebuildMarker(state.dir,docId));
    const exists = pending||(!reset&&await fileExists(documentArgumentV5File(state.dir,docId)));
    v5Demand(!exists || current, '已存 v5 图谱来源变化或文件损坏；请在资料详情中选择“重新生成论证图”，未覆盖旧文件');
    if (current) validateDocumentArgumentV5Commit(asCommit(current), state.chunks, state.plan);
    const bridgeUpgrade=!!current&&current.build.completedWindowIds.length===current.build.totalWindows&&current.build.bridgeStatus==='complete'
      &&current.build.bridgeProtocol!==DOCUMENT_ARGUMENT_V5_BRIDGE_PROTOCOL&&documentArgumentComponents(current).length>1;
    const projected=current?asCommit(current):undefined;
    if(projected&&bridgeUpgrade)projected.build={...projected.build,bridgeStatus:'pending',bridgeProtocol:DOCUMENT_ARGUMENT_V5_BRIDGE_PROTOCOL};
    return { docId, sourceFingerprint: documentArgumentSourceFingerprint(docId, state.chunks), previousRevision: current?.revision || null,
      ...state.plan, quoteHints:state.quoteHints, windowPlanFingerprint: documentArgumentV5Hash(state.plan), promptHash: DOCUMENT_ARGUMENT_V5_PROMPT_HASH,
      chunks: state.chunks.map(c => ({ id: c.id, sectionPath: c.sectionPath, content: c.content })), current: projected,
      publicationPending:pending&&current?.build.bridgeStatus==='complete'&&current.build.completedWindowIds.length===current.build.totalWindows };
  });
}

export async function commitDocumentArgumentV5(raw: DocumentArgumentV5Commit, options: { assertEnvironment?: () => void; embed?: (text: string) => Promise<number[]> } = {}) {
  v5Demand(raw && JSON.stringify(raw).length <= 4_000_000, '提交预算');
  const input: DocumentArgumentV5Commit = structuredClone(raw);
  options.assertEnvironment?.();
  const snapshot = await withDocumentSourceSnapshot(async () => {
    const state = await source(input.docId), nodes = validateDocumentArgumentV5Commit(input, state.chunks, state.plan);
    const prior = await readProcessingDocumentArgumentV5(state.dir, input.docId, state.chunks);
    v5Demand((prior?.revision || null) === input.previousRevision, '图谱版本已变化');
    if (prior) {
      const previous = asCommit(prior);
      v5Demand(previous.nodes.every((n, i) => JSON.stringify(n) === JSON.stringify(input.nodes[i]))
        && previous.arguments.every((a, i) => JSON.stringify(a) === JSON.stringify(input.arguments[i]))
        && previous.relations.every((r, i) => JSON.stringify(r) === JSON.stringify(input.relations[i]))
        && (previous.roleRevisions||[]).every((event,i)=>JSON.stringify(event)===JSON.stringify(input.roleRevisions?.[i]))
        && previous.build.completedWindowIds.every((id, i) => input.build.completedWindowIds[i] === id), '续跑不得修改已保存交接图');
    }
    return { ...state, nodes, prior };
  });
  const vectors: number[][] = [];
  for (const node of snapshot.nodes) {
    options.assertEnvironment?.();
    const old = snapshot.prior?.nodes.find(n => n.id === node.id && n.text === node.text);
    vectors.push(old?.embedding || await (options.embed || generateEmbedding)(node.text));
  }
  options.assertEnvironment?.();
  return withDocumentSourceSnapshot(async () => {
    options.assertEnvironment?.(); const latest = await source(input.docId);
    v5Demand(latest.dir === snapshot.dir, '资料库已变化');
    return saveDocumentArgumentV5(latest.dir, input, latest.chunks, latest.plan, vectors);
  });
}

/** Build compact local discourse packets for the semantic bridge model.
 * Ordinal neighbours nominate candidates; they never create edges locally. */
export async function recallDocumentArgumentV5Bridges(raw: DocumentArgumentV5Commit, embed = generateEmbedding) {
  const input = structuredClone(raw);
  const state = await withDocumentSourceSnapshot(async () => {
    const state = await source(input.docId);
    validateDocumentArgumentV5Commit(input, state.chunks, state.plan);
    const prior = await readProcessingDocumentArgumentV5(state.dir, input.docId, state.chunks);
    v5Demand((prior?.revision || null) === input.previousRevision, '图谱版本已变化');
    return { ...state, prior };
  });
  const components = documentArgumentComponents(input);
  if (components.length < 2) return [];
  const text = new Map(input.nodes.map(n => [n.id, replayDocumentArgumentNode(n, state.chunks)]));
  const effective=documentArgumentEffectiveRoles(input);
  const main = new Set(components[0]);
  const present = (id: string) => ({ id, role: effective.get(id)!, text: text.get(id)! });
  // Adjacent disconnected components usually form one omitted discourse span
  // (for example N30..N40). Merge them before asking the model to reconnect it.
  const detached=components.slice(1),parent=detached.map((_,i)=>i);
  const find=(i:number):number=>parent[i]===i?i:(parent[i]=find(parent[i]));
  const union=(a:number,b:number)=>{a=find(a);b=find(b);if(a!==b)parent[b]=a;};
  const owner=new Map<number,number>();
  detached.forEach((component,i)=>component.forEach(id=>owner.set(Number(id.slice(1)),i)));
  for(const [number,index] of owner){const next=owner.get(number+1);if(next!==undefined)union(index,next);}
  const grouped=new Map<number,Set<string>>();
  detached.forEach((component,i)=>{const root=find(i),set=grouped.get(root)||new Set<string>();component.forEach(id=>set.add(id));grouped.set(root,set);});
  const groups=[...grouped.values()].map(set=>[...set].sort((a,b)=>Number(a.slice(1))-Number(b.slice(1))))
    .sort((a,b)=>Number(a[0].slice(1))-Number(b[0].slice(1))).filter(group=>{
      const ids=new Set(group);
      return !input.build.bridgeReviews?.some(review=>!review.proposalIds&&review.nodeIds.length===ids.size&&review.nodeIds.every(id=>ids.has(id)))
        &&!input.unresolved.some(u=>u.nodeId&&ids.has(u.nodeId)&&/^\u5c40\u90e8\u8865\u94fe\u5019\u9009\u5df2\u7a77\u5c3d\uff1a/u.test(u.reason));
    });
  const allEdges=documentArgumentUniqueEdges(input);
  const tasks=[] as Array<{taskId:string;component:ReturnType<typeof present>[];candidates:Array<ReturnType<typeof present>&{distance:number;selection:'ordinal'|'claim_anchor'|'context_neighbor'|'semantic'}>;
    existingEdges:Array<{kind:'support'|'oppose'|'context'|'method_for'|'relates';from:string;to:string}>;round:number;exhaustive:boolean}>;
  for(const [i,group] of groups.entries()){
    const sourceIds=new Set(group);
    const previousRounds=input.unresolved.filter(u=>u.nodeId&&sourceIds.has(u.nodeId)&&/^\u5c40\u90e8\u8865\u94fe\u7b2c\d+\u8f6e/u.test(u.reason))
      .map(u=>Number(/^\u5c40\u90e8\u8865\u94fe\u7b2c(\d+)\u8f6e/u.exec(u.reason)?.[1]||0));
    const round=Math.max(0,...previousRounds)+1,mainIds=[...main].sort((a,b)=>Number(a.slice(1))-Number(b.slice(1)));
    const low=Number(group[0].slice(1)),high=Number(group[group.length-1].slice(1));
    const distance=(id:string)=>{const number=Number(id.slice(1));return number<low?low-number:number>high?number-high:0;};
    type Selection='ordinal'|'claim_anchor'|'context_neighbor'|'semantic';
    const nominations=new Map<string,{priority:number;distance:number;selection:Selection;score:number}>();
    const nominate=(id:string,priority:number,selection:Selection,score=0)=>{
      if(!main.has(id))return;const next={priority,distance:distance(id),selection,score},old=nominations.get(id);
      if(!old||priority<old.priority||priority===old.priority&&(next.distance<old.distance||next.distance===old.distance&&score>old.score))nominations.set(id,next);
    };
    const before=mainIds.filter(id=>Number(id.slice(1))<low).at(-1),after=mainIds.find(id=>Number(id.slice(1))>high);
    if(before)nominate(before,0,'ordinal');if(after)nominate(after,0,'ordinal');
    if(!before&&!after)for(const id of mainIds.slice().sort((a,b)=>distance(a)-distance(b)).slice(0,2))nominate(id,0,'ordinal');
    const boundaryIds=[...nominations].filter(([,value])=>value.priority===0).sort((a,b)=>a[1].distance-b[1].distance).slice(0,2).map(([id])=>id);
    for(const edge of allEdges)for(const anchor of boundaryIds){
      if(edge.from===anchor&&main.has(edge.to))nominate(edge.to,2,'context_neighbor');
      if(edge.to===anchor&&main.has(edge.from))nominate(edge.from,2,'context_neighbor');
    }
    const query=group.map(id=>text.get(id)).join('\n'),queryVector=await embed(query),df=buildDf(mainIds.map(id=>text.get(id)!));
    const avg=mainIds.reduce((sum,id)=>sum+Math.max(1,tokenize(text.get(id)!).length),0)/Math.max(1,mainIds.length),tokens=tokenize(query);
    const scores=new Map<string,number>();
    for(const id of mainIds){const vector=state.prior?.nodes.find(n=>n.id===id)?.embedding||await embed(text.get(id)!);
      const score=Math.max(0,cosineSimilarity(queryVector,vector))+Math.min(1,bm25Score(tokens,text.get(id)!,df,mainIds.length,avg))*.15;
      scores.set(id,score);if(nominations.has(id))nominations.get(id)!.score=score;
    }
    const componentHasClaim=group.some(id=>effective.get(id)==='claim');
    if(componentHasClaim){
      const mainClaims=mainIds.filter(id=>effective.get(id)==='claim')
        .sort((a,b)=>(scores.get(b)||0)-(scores.get(a)||0)||distance(a)-distance(b)||Number(a.slice(1))-Number(b.slice(1)));
      for(const id of mainClaims.slice(0,2))nominate(id,1,'claim_anchor',scores.get(id)||0);
    }
    for(const id of mainIds)if(!nominations.has(id))nominate(id,3,'semantic',scores.get(id)||0);
    const coreIds=[...boundaryIds];
    for(const id of [...nominations].filter(([,value])=>value.selection==='claim_anchor')
      .sort((a,b)=>b[1].score-a[1].score||a[1].distance-b[1].distance).slice(0,2).map(([id])=>id))if(!coreIds.includes(id))coreIds.push(id);
    for(const edge of allEdges)for(const anchor of coreIds){
      if(edge.from===anchor&&main.has(edge.to))nominate(edge.to,2,'context_neighbor',scores.get(edge.to)||0);
      if(edge.to===anchor&&main.has(edge.from))nominate(edge.from,2,'context_neighbor',scores.get(edge.from)||0);
    }
    const core=new Set(coreIds),secondary=[...nominations].filter(([id])=>!core.has(id)).sort((a,b)=>a[1].priority-b[1].priority
      ||b[1].score-a[1].score||a[1].distance-b[1].distance||Number(a[0].slice(1))-Number(b[0].slice(1)));
    const capacity=Math.max(1,12-coreIds.length),offset=(round-1)*capacity,page=secondary.slice(offset,offset+capacity);
    const selected=[...coreIds.map(id=>[id,nominations.get(id)!] as const),...page];
    const candidates=selected.map(([id,meta])=>({...present(id),distance:meta.distance,selection:meta.selection}));
    const exhaustive=offset+page.length>=secondary.length;
    const allowed=new Set([...sourceIds,...candidates.map(c=>c.id)]);
    const existingEdges=allEdges.filter(e=>allowed.has(e.from)&&allowed.has(e.to))
      .map(e=>({kind:e.kind,from:e.from,to:e.to}));
    tasks.push({taskId:`C${i+1}`,component:group.map(present),candidates,existingEdges,round,exhaustive});
  }
  await withDocumentSourceSnapshot(async () => {
    const latest = await source(input.docId), prior = await readProcessingDocumentArgumentV5(latest.dir, input.docId, latest.chunks);
    v5Demand(latest.dir === state.dir && documentArgumentSourceFingerprint(input.docId, latest.chunks) === input.sourceFingerprint
      && documentArgumentV5Hash(latest.plan) === input.build.windowPlanFingerprint && (prior?.revision || null) === input.previousRevision, '召回期间资料或版本变化');
  });
  return tasks;
}
