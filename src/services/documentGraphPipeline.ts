import type {DocumentGraphCommit,DocumentGraphSourceSnapshot,DocumentGraphWindow,DocumentGraphEntity,DocumentGraphEntityRelation} from './documentGraphTypes';
import {bindReviewedDocumentGraphs} from './documentGraphBinding';
import {parseNodes,parseRelations,parseReview,makeReviewTasks,missingMaterialNodeIds,json,shape,demand,str,validateRelations,type ExtractionWindow,type RelationNormalization} from './documentGraphProtocol';
import {boundEntityReading} from './documentGraphEntitySource';
import {parseEntityReadingResult} from './documentGraphEntityProtocol';
import {inspectNodeSources,confirmNodeSources,NodeSourceRepairRequired,type NodeSourceRepairProposal,type NodeSourceRepairAudit} from './documentGraphNodeRepair';
import {documentGraphRuntimePrompts} from '../workflows/documentGraphRuntimePrompts';
import entityPrompt from '../workflows/documentGraphEntityPrompt';
import crossPrompt from '../workflows/documentGraphCrossPrompt';

export const DOCUMENT_PIPELINE_VERSION='document-pipeline-v1' as const;
export interface DocumentPipelineDependencies {
  prepare(docId:string):Promise<DocumentGraphSourceSnapshot>;
  call(stage:string,prompt:string,input:unknown):Promise<string>;
  recall(input:DocumentGraphCommit,targets:string[]):Promise<Record<string,string[]>>;
  commit(input:DocumentGraphCommit):Promise<{revision:string;nodes:number;relations:number}>;
  guard():Promise<void>;
  confirmNodeRepair?(proposal:NodeSourceRepairProposal):Promise<boolean>;
}
export type DocumentPipelineProgress=(text:string)=>void;
export function readPipelineWindows(s:DocumentGraphSourceSnapshot,windows:DocumentGraphWindow[]):ExtractionWindow[]{
  const chunks=new Map(s.chunks.map(c=>[c.id,c]));
  return windows.map(w=>({id:w.id,section:w.section,text:w.parts.map(p=>{
    const c=chunks.get(p.chunkId);demand(c&&p.start>=0&&p.end>p.start&&p.end<=c.content.length,'窗口来源');return c.content.slice(p.start,p.end);
  }).join('\n')}));
}
export function nextPipelineWindows(s:DocumentGraphSourceSnapshot){
  demand(s.windows?.length,'未生成有效资料阅读窗口');const done=new Set(s.current?.build?.completedWindowIds||[]);
  if(s.current?.build)demand(s.current.build.windowPlanFingerprint===s.windowPlanFingerprint,'阅读窗口发生变化，不能沿旧进度继续');
  const selected:DocumentGraphWindow[]=[];let chars=0;
  for(const w of s.windows){if(done.has(w.id))continue;const len=readPipelineWindows(s,[w])[0].text.length;
    demand(len<=12000,`${w.id} 完整语义窗口超出单次处理预算，未强行拆句`);
    if(selected.length&&(selected.length>=5||chars+len>6000))break;
    selected.push(w);chars+=len;
  }return selected;
}
/** One user action, one bounded batch (4 calls, plus at most 1 cross-graph call).
 * Successful stages stay in this run's cache for an explicit retry; no automatic retries.
 * Failed node quotes are retained separately as pending receipts, never admitted as valid output.
 * Only a fully validated batch is committed. Prior graph stays readable after failure. */
export async function runDocumentGraphBatch(s:DocumentGraphSourceSnapshot,deps:DocumentPipelineDependencies,
  progress:DocumentPipelineProgress=()=>{},cache=new Map<string,string>()){
  const planned=nextPipelineWindows(s);if(!planned.length)return {completed:0,total:s.windows!.length,done:s.current!.build!.completedWindowIds.length,requests:0};
  if(s.current&&!s.current.build)throw new Error('该资料已有旧版独立图，请先保留旧图并明确重建范围；未自动覆盖。');
  const windows=readPipelineWindows(s,planned),graphId=`G${(s.current?.build?.completedWindowIds.length||0)+1}`;
  const normalizationAudit:Array<{stage:'relations'|'review';entries:RelationNormalization[]}>=[];
  const recordNormalization=(stage:'relations'|'review',entries:RelationNormalization[])=>{
    if(entries.length){normalizationAudit.push({stage,entries});progress(`本地合并 ${entries.length} 条同类型同端点重复关系；已保留ID映射和原始理由`);}
  };
  let requests=0;
  const check=async()=>{await deps.guard();const now=await deps.prepare(s.docId);
    demand(now.sourceFingerprint===s.sourceFingerprint&&now.windowPlanFingerprint===s.windowPlanFingerprint&&now.previousRevision===s.previousRevision&&now.environmentId===s.environmentId,'资料来源、资料库或图谱版本已变化，请重新开始本批');};
  const call=async(stage:string,prompt:string,input:unknown)=>{
    await check();progress(stage);const key=JSON.stringify([stage,prompt,input]);
    if(cache.has(key))return cache.get(key)!;
    requests++;const text=await deps.call(stage,prompt,input);return text;
  };
  const checked=async<T>(stage:string,prompt:string,input:unknown,parse:(raw:string)=>T)=>{
    const text=await call(stage,prompt,input);const result=parse(text);cache.set(JSON.stringify([stage,prompt,input]),text);return result;
  };
  const nodeStage='1/5 提取完整语义块',nodeInput={windows},nodePrompt=documentGraphRuntimePrompts.nodes;
  const nodeKey=JSON.stringify([nodeStage,nodePrompt,nodeInput]);
  const pendingKey=JSON.stringify(['pending-node-source',nodeKey]),approvalKey=JSON.stringify(['confirmed-node-source',nodeKey]);
  await check();
  const nodeRaw=cache.get(pendingKey)??await call(nodeStage,nodePrompt,nodeInput);
  const proposal=inspectNodeSources(nodeRaw,windows);
  let acceptedNodeRaw=nodeRaw;let nodeSourceRepairAudit:NodeSourceRepairAudit[]=[];
  if(proposal.issues.length){
    // Failed provenance is a pending receipt, never a successful-stage cache entry.
    // Preserve the original response across a declined repair or downstream failure.
    cache.set(pendingKey,nodeRaw);
    const confirmed=cache.get(approvalKey)===nodeRaw;
    if(!confirmed){
      progress(`已保留 ${proposal.validNodeCount}/${proposal.nodeCount} 个来源通过的节点；${proposal.issues.length} 处引文待确认`);
      if(!proposal.canConfirm||!deps.confirmNodeRepair||!await deps.confirmNodeRepair(structuredClone(proposal)))throw new NodeSourceRepairRequired(proposal);
    }
    await check();
    const repair=confirmNodeSources(nodeRaw,windows,true);
    acceptedNodeRaw=repair.correctedRaw;nodeSourceRepairAudit=repair.audit;
    cache.set(approvalKey,nodeRaw);
    progress(`按已确认原文修订 ${repair.audit.length} 处引文，保留初抽原始响应；继续本批后续步骤`);
  }
  const nodes=parseNodes(acceptedNodeRaw,windows);cache.set(nodeKey,acceptedNodeRaw);
  const initial=await checked('2/5 构建论证与说明关系',documentGraphRuntimePrompts.relations,{windows,nodes},raw=>parseRelations(raw,nodes,{requireGapKind:true,draft:true}));
  recordNormalization('relations',initial.normalizationAudit);
  const tasks=makeReviewTasks(nodes,initial.relations,initial.coreClaims,initial.unresolved);
  const cycles=tasks.filter(t=>t.check==='relation_cycle');
  if(initial.formatAudit.length)progress(`本地归一 ${initial.formatAudit.length} 个单目标数组，保留格式审计`);
  if(cycles.length)progress(`草图发现 ${cycles.length} 组闭环，交由带原文复核；尚不具备入库资格`);
  // Normalization receipts remain local; do not add unexpected fields to the model contract.
  const draft={nodes,relations:initial.relations,coreClaims:initial.coreClaims,unresolved:initial.unresolved};
  const review=await checked('3/5 带原文复核',documentGraphRuntimePrompts.review,{windows,draft,reviewTasks:tasks},raw=>parseReview(raw,nodes,tasks,{requireGapKind:true}));
  recordNormalization('review',review.normalizationAudit);
  const local=bindReviewedDocumentGraphs(s,[{graphId,windows:planned,nodes,relations:review.relations,
    unresolved:review.unresolved.filter(u=>u.kind!=='classification_note').map(u=>`${u.nodeId}: [${u.kind}] ${u.reason}`.slice(0,600))}]);
  // Build coordinates from the same source parts the host replays, including chunk seams.
  const {fragments,texts:localTexts}=boundEntityReading(s,{graphId,windows:planned,nodes,relations:[],unresolved:[]},local.nodes);
  const entityInput={nodes:nodes.map(n=>({id:n.id,type:n.type,
    fragments:fragments.filter(f=>f.nodeId===n.id).map(f=>({id:f.id,text:f.text}))}))};
  const raw=await checked('4/5 实体与节点映射',entityPrompt,entityInput,text=>parseEntityReadingResult(text,fragments,localTexts));
  if(raw.issues.length){
    progress(`实体位置校验：隔离 ${raw.issues.length} 项未通过映射的提及或依赖关系，保留 ${raw.entities.length} 个有原文依据的实体`);
    local.unresolved.push(`[实体位置待核对] ${raw.issues.length} 项未纳入实体检索：${raw.issues.slice(0,6).map(i=>`${i.entityId}/${i.fragmentId||'-'} ${i.reason}`).join('；')}${raw.issues.length>6?'；其余见本批回执':''}`.slice(0,600));
  }
  // Keep a reference only when the prior, independent review resolved the same occurrence
  // to a named occurrence of this entity. Never promote pronouns to global aliases.
  const admittedReference=(e:DocumentGraphEntity,m:DocumentGraphEntity['mentions'][number])=>{
    if(!m.reference)return true;
    const task=tasks.find(t=>t.nodeId===m.nodeId&&t.check==='reference_target'&&t.quote===m.quote);
    const targets=review.referenceResolutions.find(r=>r.taskId===task?.id)?.targets||[];
    return targets.length>0&&targets.every(id=>e.mentions.some(named=>!named.reference&&named.nodeId===id))
      &&raw.entities.filter((other:DocumentGraphEntity)=>other.mentions.some(x=>x.nodeId===m.nodeId&&x.quote===m.quote&&x.reference)).length===1;
  };
  const entities:DocumentGraphEntity[]=raw.entities.map((e:DocumentGraphEntity)=>({...e,id:`${graphId}:${e.id}`,
    mentions:e.mentions.filter(m=>admittedReference(e,m)).map(m=>({...m,nodeId:`${graphId}:${m.nodeId}`}))}));
  const entityRelations:DocumentGraphEntityRelation[]=raw.entityRelations.map((r:DocumentGraphEntityRelation)=>({...r,from:`${graphId}:${r.from}`,to:`${graphId}:${r.to}`,evidenceNodeIds:r.evidenceNodeIds.map(id=>`${graphId}:${id}`)}));
  const prior=s.current;
  const commit:DocumentGraphCommit={...local,nodes:[...(prior?.nodes||[]),...local.nodes],relations:[...(prior?.relations||[]),...local.relations],
    entities:[...(prior?.entities||[]),...entities],entityRelations:[...(prior?.entityRelations||[]),...entityRelations],
    unresolved:[...(prior?.unresolved||[]),...local.unresolved],
    build:{version:DOCUMENT_PIPELINE_VERSION,completedWindowIds:[...(prior?.build?.completedWindowIds||[]),...planned.map(w=>w.id)],totalWindows:s.windows!.length,windowPlanFingerprint:s.windowPlanFingerprint!}};
  const texts=new Map(commit.nodes.map(n=>[n.id,n.source.map(p=>s.chunks.find(c=>c.id===p.chunkId)!.content.slice(p.start,p.end)).join('\n')]));
  const possible=missingMaterialNodeIds(review.unresolved).map(id=>`${graphId}:${id}`);
  if(prior?.nodes.length&&possible.length){
    const targetIds=possible.slice(0,8);await check();progress('5/5 本地跨图召回与修剪');
    const candidates=await deps.recall(commit,targetIds);
    const present=(id:string)=>{const n=commit.nodes.find(n=>n.id===id)!;return {id:n.id,graphId:n.graphId,type:n.type,text:texts.get(id),section:n.source.map(p=>s.chunks.find(c=>c.id===p.chunkId)!.sectionPath).join(' / ')};};
    const packets=targetIds.filter(id=>candidates[id]?.length).map(id=>({target:present(id),candidates:candidates[id].map(present),
      existingRelations:commit.relations.filter(r=>[...r.from,r.to].every(x=>[id,...candidates[id]].includes(x)))}));
    if(packets.length){
      const v=json(await call('5/5 核对跨图候选关系',crossPrompt,{packets}));shape(v,['results']);demand(Array.isArray(v.results)&&v.results.length===packets.length,'跨图结果遗漏');const seen=new Set<string>();
      for(const result of v.results){shape(result,['targetId','relations','unresolved']);const p=packets.find(p=>p.target.id===result.targetId);demand(p&&!seen.has(result.targetId),'跨图目标');seen.add(result.targetId);
        const allowed=new Set([p.target.id,...p.candidates.map(n=>n.id)]);const edges=validateRelations(result.relations,allowed,16);
        for(const r of edges){demand([...r.from,r.to].includes(p.target.id),'跨图关系未包含目标');demand([...r.from,r.to].filter(id=>id!==p.target.id).every(id=>commit.nodes.find(n=>n.id===id)!.graphId!==p.target.graphId),'禁止修改图内关系');
          const sig=(e:typeof r)=>JSON.stringify([e.kind,[...e.from].sort(),e.to]);if(!commit.relations.some(e=>sig(e)===sig(r)))commit.relations.push({...r,id:`${graphId}:X${commit.relations.length+1}`});}
        demand(Array.isArray(result.unresolved)&&result.unresolved.length<=4,'跨图缺口');for(const gap of result.unresolved){str(gap);commit.unresolved.push(`${result.targetId}: ${gap}`.slice(0,600));}
      }
    }
    for(const id of possible)if(!targetIds.includes(id)||!candidates[id]?.length)commit.unresolved.push(`${id}: 跨图候选未召回或本批预算不足；不等于全文无依据。`);
  }
  validateRelations(commit.relations,new Set(commit.nodes.map(n=>n.id)),1280);
  demand(commit.unresolved.length<=128,'未解决缺口超过预算，需检查后再入库');
  await check();progress('本地向量化并保存已复核批次');await deps.commit(commit);cache.clear();
  return {completed:planned.length,total:s.windows!.length,done:commit.build!.completedWindowIds.length,requests,normalizationAudit,
    entityMappingAudit:{issues:raw.issues,mappings:raw.mappings},
    classificationNotes:review.unresolved.filter(u=>u.kind==='classification_note'),nodeSourceRepairAudit,
    nodeSourceRepairReceipt:nodeSourceRepairAudit.length?{originalRaw:nodeRaw,acceptedRaw:acceptedNodeRaw}:undefined,
    relationFormatAudit:{relations:initial.formatAudit,review:review.formatAudit},draftCycleTasks:cycles};
}
