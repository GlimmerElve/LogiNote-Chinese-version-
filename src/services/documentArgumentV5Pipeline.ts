import type { DocumentArgumentGraph, DocumentArgumentV5Commit, DocumentArgumentV5Snapshot } from './documentArgumentV5Types';
import { DOCUMENT_ARGUMENT_V5_BRIDGE_PROTOCOL, DOCUMENT_ARGUMENT_V5_VERSION } from './documentArgumentV5Types';
import { nextDocumentArgumentV5Windows } from '../electron/rag/documentArgumentV5Plan';
import { documentArgumentComponents, documentArgumentEdgeSignature, documentArgumentUniqueEdges, parseDocumentArgumentV5Batch, replayDocumentArgumentNode, selectDocumentArgumentV5Handoff, recordDocumentArgumentV5Issues, v5Demand } from './documentArgumentV5Protocol';
import { DOCUMENT_ARGUMENT_V5_BATCH_TEXT_PROMPT, DOCUMENT_ARGUMENT_V5_BRIDGE_PROMPT } from '../workflows/documentArgumentV5Prompt';
import {documentArgumentReadingWindows} from './documentArgumentReadingWindows';
import {documentArgumentEffectiveRoles,validateDocumentArgumentRoleEvidence} from './documentArgumentRoleRevisions';
import type {DocumentArgumentRoleRevision} from './documentArgumentV5Types';

export interface DocumentArgumentBridgeTask {
  taskId: string;
  /** A complete disconnected unit. Adjacent units may be merged so the model can
   * restore their internal discourse before attaching them to the surrounding graph. */
  component: Array<{ id: string; role: string; text: string }>;
  /** Local ordinal neighbours first; semantic fallbacks appear only in later rounds. */
  candidates: Array<{ id: string; role: string; text: string; distance: number;
    selection: 'ordinal' | 'claim_anchor' | 'context_neighbor' | 'semantic' }>;
  existingEdges: Array<{ kind: 'support' | 'oppose' | 'context' | 'method_for' | 'relates'; from: string; to: string }>;
  round: number;
  /** True only when this and earlier rounds have covered every nominated main-component candidate. */
  exhaustive: boolean;
  /** Quarantined proposals are context for review, never already-admitted edges. */
  proposedEdges?: NonNullable<DocumentArgumentGraph['pendingEdges']>;
}
export interface DocumentArgumentV5Dependencies {
  prepare(docId: string): Promise<DocumentArgumentV5Snapshot>;
  guard(): Promise<void>;
  call(stage: 'extract' | 'bridge', prompt: string, input: unknown): Promise<string>;
  commit(input: DocumentArgumentV5Commit): Promise<{ revision: string; nodes: number; relations: number }>;
  recall(input: DocumentArgumentV5Commit): Promise<DocumentArgumentBridgeTask[]>;
  recordResponse?(stage:'extract'|'bridge',raw:string,error?:string,requestText?:string):Promise<void>;
}
const emptyGraph = (): DocumentArgumentGraph => ({ nodes: [], arguments: [], relations: [], unresolved: [] });
const compactBridgeTask=(task:DocumentArgumentBridgeTask):DocumentArgumentBridgeTask=>({...task,
  existingEdges:[...new Map(task.existingEdges.map(edge=>[documentArgumentEdgeSignature(edge),edge])).values()]});
function recordBridgeIssue(graph:DocumentArgumentGraph,batch:number,reason:string,nodeId?:string){
  const issue={batch:Math.max(1,batch),...(nodeId?{nodeId}:{}),reason:reason.slice(0,600)};
  if(!graph.unresolved.some(old=>old.batch===issue.batch&&old.nodeId===issue.nodeId&&old.reason===issue.reason))graph.unresolved.push(issue);
}
/** Keep the non-reasoning bridge model focused. Every task is preserved, but
 * large audits are split into small requests instead of truncating candidates. */
export function documentArgumentBridgePackets(tasks:DocumentArgumentBridgeTask[],maxTasks=4,maxCharacters=24000){
  const packets:DocumentArgumentBridgeTask[][]=[];let current:DocumentArgumentBridgeTask[]=[];
  for(const task of tasks.map(compactBridgeTask)){
    v5Demand(JSON.stringify({tasks:[task]}).length<=maxCharacters,
      `补链单个任务超过${maxCharacters}字符；已停止发送，保留草图，请缩小该断链任务`);
    const next=[...current,task],tooMany=next.length>maxTasks,tooLarge=JSON.stringify({tasks:next}).length>maxCharacters;
    if(current.length&&(tooMany||tooLarge)){packets.push(current);current=[task];}else current=next;
  }
  if(current.length)packets.push(current);return packets;
}
export function documentArgumentV5NeedsWork(snapshot: DocumentArgumentV5Snapshot) {
  return snapshot.publicationPending || !snapshot.current || snapshot.current.build.completedWindowIds.length < snapshot.windows.length || snapshot.current.build.bridgeStatus !== 'complete';
}

/** Independent is a semantic decision, not a synonym for exhausted retrieval. */
export function documentArgumentBridgeState(input:DocumentArgumentV5Commit):DocumentArgumentV5Commit['build']['bridgeStatus']{
  if(input.pendingEdges?.length)return input.build.bridgeReviews?.some(r=>r.decision==='unresolved')?'review_required':'pending';
  const detached=documentArgumentComponents(input).slice(1);
  if(!detached.length)return 'complete';
  const independent=new Set(input.build.bridgeReviews?.filter(r=>r.decision==='independent'&&!r.proposalIds).flatMap(r=>r.nodeIds)||[]);
  if(detached.every(group=>group.every(id=>independent.has(id))))return 'complete';
  return input.build.bridgeReviews?.some(r=>r.decision==='unresolved')?'review_required':'pending';
}

function pendingRelationTasks(input:DocumentArgumentV5Commit,chunks:DocumentArgumentV5Snapshot['chunks']):DocumentArgumentBridgeTask[]{
  const roles=documentArgumentEffectiveRoles(input),byId=new Map(input.nodes.map(n=>[n.id,n]));
  const present=(id:string)=>({id,role:roles.get(id)!,text:replayDocumentArgumentNode(byId.get(id)!,chunks)});
  return (input.pendingEdges||[]).filter(edge=>byId.has(edge.from)&&byId.has(edge.to)&&!input.build.bridgeReviews?.some(review=>review.decision==='unresolved'
    &&review.proposalIds?.includes(edge.id))).map(edge=>({
    taskId:`P:${edge.id}`,component:[present(edge.from)],candidates:[{...present(edge.to),distance:Math.abs(Number(edge.from.slice(1))-Number(edge.to.slice(1))),selection:'ordinal' as const}],
    existingEdges:[],proposedEdges:[edge],round:1,exhaustive:true,
  }));
}

/** One extraction request per explicit batch; all detached groups are checked in
 * small bridge packets at the end. Receipts survive a local failure for explicit
 * continuation. Never automatic model retries. */
export async function runDocumentArgumentV5Batch(snapshot: DocumentArgumentV5Snapshot, deps: DocumentArgumentV5Dependencies,
  progress: (message: string) => void = () => {}, receipts = new Map<string, string>(),options:{retryReview?:boolean}={}) {
  const prior = snapshot.current, planned = nextDocumentArgumentV5Windows(snapshot);
  let graph: DocumentArgumentGraph = prior ? structuredClone({ nodes: prior.nodes, arguments: prior.arguments, relations: prior.relations, unresolved: prior.unresolved,
    ...(prior.roleRevisions?{roleRevisions:prior.roleRevisions}:{}),...(prior.pendingEdges?{pendingEdges:prior.pendingEdges}:{}),
    ...(prior.edgeAudits?{edgeAudits:prior.edgeAudits}:{}) }) : emptyGraph();
  const batch = (prior?.build.batchCount || 0) + Number(planned.length > 0);
  let requests = 0, warning = '';
  const meaningfulBridgeEdges=new Set<string>();
  const retryReview=options.retryReview===true&&prior?.build.bridgeStatus==='review_required';
  if(retryReview){
    graph.unresolved=graph.unresolved.filter(u=>!/^局部补链(?:候选已穷尽|第\d+轮结构拒绝)/u.test(u.reason));
    progress('按本次用户操作重新核对未确认关系；保留原节点、旧边及已确认独立记录');
  }
  const check = async () => {
    await deps.guard();
    const current = await deps.prepare(snapshot.docId);
    v5Demand(current.sourceFingerprint === snapshot.sourceFingerprint && current.windowPlanFingerprint === snapshot.windowPlanFingerprint
      && current.promptHash === snapshot.promptHash && current.previousRevision === snapshot.previousRevision && current.environmentId === snapshot.environmentId, '处理期间资料、图谱或资料库已变化');
  };
  const call = async (stage: 'extract' | 'bridge', prompt: string, input: unknown) => {
    await check();
    const key = JSON.stringify([stage, prompt, input]);
    let raw = receipts.get(key);
    if (raw === undefined) {
      requests++;
      raw = await deps.call(stage, prompt, input);
      // Preserve even an invalid response. Explicit continuation can revalidate
      // it after a local fix without silently issuing another paid request.
      receipts.set(key, raw);
    }
    await deps.recordResponse?.(stage,raw,undefined,stage==='extract'?(input as {text:string}).text:undefined);
    return raw;
  };
  const inherited = selectDocumentArgumentV5Handoff(graph, snapshot.chunks);
  let fresh: DocumentArgumentGraph | undefined;
  if (planned.length) {
    const reading=documentArgumentReadingWindows(planned,snapshot.quoteHints);
    progress(`v5.0.8 联合分块、标注与连线（${planned.reduce((s, w) => s + [...w.text].length, 0)}字完整正文；交接${inherited.nodes.length}节点）`);
    const input = { text: reading[0].text, inherited_graph: inherited };
    const raw = await call('extract', DOCUMENT_ARGUMENT_V5_BATCH_TEXT_PROMPT, input);
    try { fresh = parseDocumentArgumentV5Batch(raw, reading, graph, inherited, batch,'batch-text',false,'v5.0.8','record'); }
    catch(error) {
      await deps.recordResponse?.('extract',raw,error instanceof Error?error.message:String(error),input.text);
      throw new Error(`${error instanceof Error?error.message:String(error)}；本次响应已保留，继续操作只会重新校验，不会自动重发；需新请求时请选择重新生成论证图。`);
    }
    graph.nodes.push(...fresh.nodes); graph.arguments.push(...fresh.arguments);
    graph.relations.push(...fresh.relations);
    graph.unresolved.push(...fresh.unresolved);
    if(fresh.pendingEdges?.length){
      graph.pendingEdges=[...(graph.pendingEdges||[]),...fresh.pendingEdges];
      progress(`本批${fresh.pendingEdges.length}条角色冲突关系已隔离待复核，合法节点与关系继续保存`);
    }
  }
  const coverage = planned.map(window => {
    const marks = new Uint8Array(window.text.length);
    let base = 0;
    for (const part of window.parts) {
      for (const node of fresh?.nodes || []) for (const source of node.source) if (source.chunkId === part.chunkId) {
        const start = Math.max(part.start, source.start), end = Math.min(part.end, source.end);
        if (end > start) marks.fill(1, base + start - part.start, base + end - part.start);
      }
      base += part.end - part.start;
    }
    let covered = 0, total = 0;
    for (let i = 0; i < marks.length; i++) if (!/\s/u.test(window.text[i])) { total++; covered += marks[i]; }
    return { window: window.id, covered, total };
  });
  const done = [...(prior?.build.completedWindowIds || []), ...planned.map(w => w.id)];
  const input: DocumentArgumentV5Commit = { ...graph, docId: snapshot.docId, sourceFingerprint: snapshot.sourceFingerprint,
    previousRevision: snapshot.previousRevision,
    build: { version: DOCUMENT_ARGUMENT_V5_VERSION, promptHash: snapshot.promptHash, windowPlanFingerprint: snapshot.windowPlanFingerprint,
      completedWindowIds: done, totalWindows: snapshot.windows.length, batchCount: batch, bridgeStatus: 'pending',bridgeProtocol:DOCUMENT_ARGUMENT_V5_BRIDGE_PROTOCOL,
      ...(prior?.build.bridgeReviews?{bridgeReviews:structuredClone(prior.build.bridgeReviews.filter(r=>!retryReview||r.decision==='independent'))}:{}),
      batches: [...(prior?.build.batches || []).map(b=>({...b,promptHash:b.promptHash??prior!.build.promptHash})), ...(planned.length ? [{ batch, promptHash:snapshot.promptHash, characters: planned.reduce((s, w) => s + [...w.text].length, 0),
        inheritedCharacters: [...JSON.stringify(inherited)].length, requests, coverage }] : [])] },
    tableBindings: [...(prior?.tableBindings || [])] };
  for (const node of fresh?.nodes || []) {
    const text = replayDocumentArgumentNode(node, snapshot.chunks);
    for (const table of snapshot.objects.filter(o => o.kind === 'table')) {
      const number = table.title.match(/(?:表|Table)\s*(\d+)/iu)?.[1];
      if (number && new RegExp(`表\\s*${number}(?!\\d)`, 'u').test(text)
        && !input.tableBindings.some(b => b.tableId === table.id && b.nodeId === node.id)) input.tableBindings.push({ tableId: table.id, nodeId: node.id });
    }
  }
  if(snapshot.publicationPending)input.build.bridgeStatus='complete';
  else if (done.length === snapshot.windows.length) {
    const components = documentArgumentComponents(graph);
    if (components.length < 2 && !input.pendingEdges?.length) input.build.bridgeStatus = 'complete';
    else {
      try {
        await check(); progress(`全文局部补链：${components.length - 1}个断开分量，按编号上下文交由模型判断`);
        const tasks = [...pendingRelationTasks(input,snapshot.chunks),...await deps.recall(input)].map(compactBridgeTask);
        if (tasks.length) {
          // Bridge responses are optional repairs over an already valid graph. Work
          // on a detached copy so a bad model edge can never poison the extraction
          // that is committed after this block.
          let bridgeGraph=structuredClone(input);
          const seen = new Set<string>();
          const edgeSignatures = new Set(documentArgumentUniqueEdges(bridgeGraph).map(documentArgumentEdgeSignature));
          const addArgumentEdge = (graph:DocumentArgumentV5Commit,kind:'support'|'oppose',from:string,to:string) => {
            // Saved arguments are an immutable prefix during continuation. A
            // bridge may connect old nodes, but it must express that edge in a
            // newly appended argument instead of mutating the old claim record.
            let suffix=graph.arguments.length+1,id=`BR:A${suffix}`;
            while(graph.arguments.some(argument=>argument.id===id)){suffix++;id=`BR:A${suffix}`;}
            graph.arguments.push({id,claim:to,support:kind==='support'?[from]:[],oppose:kind==='oppose'?[from]:[],
              status:kind==='support'?'argued':'stated_only'});
          };
          const boundedTasks=tasks.filter(task=>{
            if(JSON.stringify({tasks:[task]}).length<=24000)return true;
            seen.add(task.taskId);
            (bridgeGraph.build.bridgeReviews??=[]).push({nodeIds:task.proposedEdges
              ?[...new Set(task.proposedEdges.flatMap(edge=>[edge.from,edge.to]))]:task.component.map(node=>node.id),
              ...(task.proposedEdges?{proposalIds:task.proposedEdges.map(edge=>edge.id)}:{}),decision:'unresolved',round:task.round,
              basis:'完整任务超过24000字符；未发送、未截断节点文本，需进一步拆分候选上下文'});
            bridgeGraph.unresolved.push({batch:Math.max(1,batch),nodeId:task.component[0].id,
              reason:'局部补链任务超过24000字符：已保留完整节点及候选，未发送该任务；其他小任务继续核对。'});
            warning='本批已保存；部分补链任务过大，已停发这些任务，其他有效补链结果保留。';
            return false;
          });
          const packets=documentArgumentBridgePackets(boundedTasks);
          for(const [packetIndex,packet] of packets.entries()){
            progress(`全文局部补链：第${packetIndex+1}/${packets.length}组，核对${packet.length}个断开单元`);
            // Earlier packets may refine a node also present in a later packet.
            const effective=documentArgumentEffectiveRoles(bridgeGraph);
            const packetInput=packet.map(task=>({...task,component:task.component.map(n=>({...n,role:effective.get(n.id)!})),
              candidates:task.candidates.map(n=>({...n,role:effective.get(n.id)!}))}));
            const raw = await call('bridge', DOCUMENT_ARGUMENT_V5_BRIDGE_PROMPT, { tasks:packetInput });
            const result = JSON.parse(raw.trim().replace(/^```(?:json)?\s*/iu, '').replace(/\s*```$/u, ''));
            v5Demand(result && Object.keys(result).join('|') === 'bridges' && Array.isArray(result.bridges) && result.bridges.length === packet.length, '补链输出字段');
            for (const decision of result.bridges) {
              const task = packet.find(t => t.taskId === decision.taskId);
              v5Demand(task && !seen.has(decision.taskId) && ['add', 'no_link', 'independent'].includes(decision.decision)
                && Array.isArray(decision.additions)
                && typeof decision.basis === 'string' && !!decision.basis.trim() && decision.basis.length <= 600, '补链决定');
              seen.add(decision.taskId);
              const componentIds=new Set(task.component.map(n=>n.id)),candidateIds=new Set(task.candidates.map(n=>n.id));
              bridgeGraph.unresolved=bridgeGraph.unresolved.filter(u=>!(u.nodeId&&componentIds.has(u.nodeId)&&/^局部补链(?:第|候选)/u.test(u.reason)));
              // Stage 1: validate semantic role proposals before any proposed edge.
              // Neither old nor proposed edges qualify as evidence of a new role.
              v5Demand(decision.roleRevisions===undefined||Array.isArray(decision.roleRevisions)&&decision.roleRevisions.length<=task.component.length+task.candidates.length,'角色修订列表');
              for(const proposal of decision.roleRevisions||[]){
                try{
                  v5Demand(proposal&&Object.keys(proposal).sort().join('|')==='from|nodeEvidence|nodeId|reason|to|usageEvidence'
                    &&(componentIds.has(proposal.nodeId)||candidateIds.has(proposal.nodeId))
                    &&(componentIds.has(proposal.usageEvidence?.nodeId)||candidateIds.has(proposal.usageEvidence?.nodeId)),'角色修订超出候选或字段错误');
                  // Overlapping tasks may independently repeat an already accepted
                  // proposal. Do not turn an idempotent repetition into a false alarm.
                  if(documentArgumentEffectiveRoles(bridgeGraph).get(proposal.nodeId)===proposal.to
                    &&bridgeGraph.roleRevisions?.some(event=>event.action==='revise'&&event.nodeId===proposal.nodeId
                      &&event.from===proposal.from&&event.to===proposal.to&&event.nodeEvidence.quote===proposal.nodeEvidence?.quote
                      &&event.usageEvidence.nodeId===proposal.usageEvidence.nodeId&&event.usageEvidence.quote===proposal.usageEvidence.quote))continue;
                  const trial=structuredClone(bridgeGraph);
                  let suffix=(trial.roleRevisions||[]).length+1,id=`RV${suffix}`;
                  while(trial.roleRevisions?.some(r=>r.id===id)){suffix++;id=`RV${suffix}`;}
                  const event:Extract<DocumentArgumentRoleRevision,{action:'revise'}>={...proposal,id,action:'revise',batch:Math.max(1,batch)};
                  trial.roleRevisions=[...(trial.roleRevisions||[]),event];
                  const texts=new Map(trial.nodes.map(node=>[node.id,replayDocumentArgumentNode(node,snapshot.chunks)]));
                  validateDocumentArgumentRoleEvidence(trial,texts);
                  if(event.to==='claim'&&!trial.arguments.some(a=>a.claim===event.nodeId)){
                    trial.arguments.push({id:`${id}:A`,claim:event.nodeId,support:[],oppose:[],status:'stated_only'});
                  }
                  recordDocumentArgumentV5Issues(trial);bridgeGraph=trial;
                }catch(error){
                  bridgeGraph.unresolved.push({batch:Math.max(1,batch),...(bridgeGraph.nodes.some(n=>n.id===proposal?.nodeId)?{nodeId:proposal.nodeId}:{}),
                    reason:`角色修订未准入：${error instanceof Error?error.message:String(error)}`.slice(0,600)});
                }
              }
              if (decision.decision === 'no_link'||decision.decision==='independent') {
                v5Demand(decision.additions.length===0,'no_link/independent 不得新增边');
                v5Demand(decision.decision!=='independent'||task.exhaustive,'候选未穷尽，不得声明独立');
                if(task.exhaustive){
                  const nodeIds=task.proposedEdges?[...new Set(task.proposedEdges.flatMap(e=>[e.from,e.to]))]:[...componentIds];
                  (bridgeGraph.build.bridgeReviews??=[]).push({nodeIds,...(task.proposedEdges?{proposalIds:task.proposedEdges.map(e=>e.id)}:{}),decision:decision.decision==='independent'?'independent':'unresolved',round:task.round,basis:decision.basis});
                  if(decision.decision==='independent'&&task.proposedEdges){
                    const reviewed=new Set(task.proposedEdges.map(e=>e.id));
                    bridgeGraph.pendingEdges=bridgeGraph.pendingEdges?.filter(e=>!reviewed.has(e.id));
                  }
                }
                bridgeGraph.unresolved.push({batch:Math.max(1,batch),nodeId:task.component[0].id,
                  reason:decision.decision==='independent'?`局部补链已确认独立：${decision.basis}`:task.exhaustive?`局部补链候选已穷尽，待确认：${decision.basis}`:`局部补链第${task.round}轮未确定：${decision.basis}`});
                continue;
              }
              v5Demand(decision.additions.length>0,'add 至少新增一条边');
              let taskRelevantAdded=0,proposalSatisfied=false;const rejected:string[]=[];
              for(const addition of decision.additions){
                v5Demand(addition&&typeof addition.from==='string'&&typeof addition.to==='string'
                  &&['support','oppose','context','method_for','relates'].includes(addition.kind)
                  &&typeof addition.basis==='string'&&addition.basis.trim()&&addition.basis.length<=600,'补链边字段');
                const endpoints=[addition.from,addition.to];
                const inTask=endpoints.every(id=>componentIds.has(id)||candidateIds.has(id))&&endpoints.some(id=>componentIds.has(id));
                if(!inTask)recordBridgeIssue(bridgeGraph,batch,`[本地告警] 补链超出局部候选：${addition.from} → ${addition.to}`);
                const signature=documentArgumentEdgeSignature(addition);
                if(edgeSignatures.has(signature)){
                  recordBridgeIssue(bridgeGraph,batch,`[本地告警] 补链重复关系：${addition.from} → ${addition.to} ${addition.kind}`);
                  if(task.proposedEdges?.some(edge=>documentArgumentEdgeSignature(edge)===signature))proposalSatisfied=true;
                  // Idempotency is not a semantic rejection: raw output remains in
                  // response diagnostics, but an existing arrow is never appended.
                  continue;
                }
                const trial=structuredClone(bridgeGraph);
                if(addition.kind==='support'||addition.kind==='oppose')addArgumentEdge(trial,addition.kind,addition.from,addition.to);
                else trial.relations.push({id:`BR${trial.relations.length+1}`,kind:addition.kind,from:addition.from,to:addition.to,reason:addition.basis,policy:'v5.0.8'});
                try{
                  recordDocumentArgumentV5Issues(trial);bridgeGraph=trial;edgeSignatures.add(signature);
                  if(inTask&&addition.from!==addition.to&&endpoints.every(id=>trial.nodes.some(node=>node.id===id))){
                    taskRelevantAdded++;meaningfulBridgeEdges.add(signature);
                  }
                }
                catch(error){rejected.push(`${addition.from}→${addition.to} ${addition.kind}：${error instanceof Error?error.message:String(error)}`);}
              }
              if(taskRelevantAdded===0&&!proposalSatisfied){
                const basis=`本轮没有新增涉及待补节点的有效端点关系，仅重复旧边、补入无关关系或返回不可读取关系。${rejected.join('；')}`.slice(0,500);
                recordBridgeIssue(bridgeGraph,batch,task.exhaustive?`局部补链候选已穷尽，待确认：${basis}`:
                  `局部补链第${task.round}轮未确定：${basis}`,task.component[0].id);
                if(task.exhaustive)(bridgeGraph.build.bridgeReviews??=[]).push({nodeIds:task.proposedEdges
                  ?[...new Set(task.proposedEdges.flatMap(e=>[e.from,e.to]))]:[...componentIds],...(task.proposedEdges?{proposalIds:task.proposedEdges.map(e=>e.id)}:{}),decision:'unresolved',round:task.round,basis});
              }else if(task.proposedEdges){
                const reviewed=new Set(task.proposedEdges.map(e=>e.id));
                bridgeGraph.pendingEdges=bridgeGraph.pendingEdges?.filter(e=>!reviewed.has(e.id));
              }
            }
            // A later malformed packet must not roll back earlier valid packets.
            bridgeGraph.pendingEdges=bridgeGraph.pendingEdges?.filter(edge=>!edgeSignatures.has(JSON.stringify([edge.kind,edge.from,edge.to])));
            recordDocumentArgumentV5Issues(bridgeGraph);
            Object.assign(input,structuredClone(bridgeGraph));
          }
          v5Demand(seen.size===tasks.length,'补链任务未全部返回');
          recordDocumentArgumentV5Issues(bridgeGraph);
          bridgeGraph.build.bridgeStatus=documentArgumentBridgeState(bridgeGraph);
          input.nodes=bridgeGraph.nodes;input.arguments=bridgeGraph.arguments;input.relations=bridgeGraph.relations;
          input.unresolved=bridgeGraph.unresolved;input.build=bridgeGraph.build;
          if(bridgeGraph.roleRevisions)input.roleRevisions=bridgeGraph.roleRevisions;
          if(bridgeGraph.pendingEdges)input.pendingEdges=bridgeGraph.pendingEdges;
          if(bridgeGraph.edgeAudits)input.edgeAudits=bridgeGraph.edgeAudits;
        }
        else {
          input.build.bridgeStatus=documentArgumentBridgeState(input);
          if(input.build.bridgeStatus!=='complete')input.build.bridgeStatus='review_required';
        }
      } catch (error) {
        // Keep a good extraction even when optional bridge work needs explicit continuation.
        warning = `初抽结果已保留；局部补链待核对：${error instanceof Error ? error.message : String(error)}`;
        input.unresolved.push({batch:Math.max(1,batch),reason:`[补链告警] ${warning}`.slice(0,600)});
        input.build.bridgeStatus='review_required';
      }
    }
  }
  if(done.length===snapshot.windows.length&&input.build.bridgeStatus==='review_required'&&!warning)
    warning='论证图已生成；仍有未确认关系或断开分量，已记录待核对问题，不阻止发布。';
  const issues=recordDocumentArgumentV5Issues(input);
  if(issues.length&&!warning)warning=`论证图已保存；发现${issues.length}项本地告警，详见待核对问题，不阻止后续处理。`;
  if (planned.length) input.build.batches[input.build.batches.length-1].requests=requests;
  await check(); progress('本地向量化并保存 v5.0 资料论证图');
  await deps.commit(input); receipts.clear();
  const remaining = documentArgumentComponents(input);
  const previousSignatures=new Set(documentArgumentUniqueEdges(prior||emptyGraph()).map(documentArgumentEdgeSignature));
  const newTargetEdges=documentArgumentUniqueEdges(input).some(edge=>{
    const signature=documentArgumentEdgeSignature(edge);
    return meaningfulBridgeEdges.has(signature)&&!previousSignatures.has(signature);
  });
  const previousRounds=new Map<string,number>();
  for(const issue of prior?.unresolved||[]){
    const round=Number(/^局部补链第(\d+)轮未确定：/u.exec(issue.reason)?.[1]||0);
    if(issue.nodeId&&round)previousRounds.set(issue.nodeId,Math.max(round,previousRounds.get(issue.nodeId)||0));
  }
  const candidatePageAdvanced=input.unresolved.some(issue=>issue.nodeId
    &&Number(/^局部补链第(\d+)轮未确定：/u.exec(issue.reason)?.[1]||0)>(previousRounds.get(issue.nodeId)||0));
  return { completed: planned.length, total: snapshot.windows.length, done: done.length, requests,
    nodes: input.nodes.length, components: remaining.length, bridgePending: input.build.bridgeStatus !== 'complete' && done.length === snapshot.windows.length,
    bridgeReviewRequired:input.build.bridgeStatus==='review_required',
    bridgeProgress:!!planned.length||newTargetEdges
      ||(input.roleRevisions?.length||0)>(prior?.roleRevisions?.length||0)
      ||(input.pendingEdges?.length||0)<(prior?.pendingEdges?.length||0)
      ||candidatePageAdvanced,
    warning, coverage, batchCharacters: planned.reduce((s, w) => s + [...w.text].length, 0) };
}
