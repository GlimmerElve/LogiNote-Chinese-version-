import assert from 'node:assert/strict';
import {promises as fs} from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {parseRelations,parseReview,makeReviewTasks,validateRelations,relationCycleGroups,type ExtractionNode} from '../src/services/documentGraphProtocol';
import {runDocumentGraphBatch,type DocumentPipelineDependencies} from '../src/services/documentGraphPipeline';
import type {DocumentGraphSourceSnapshot} from '../src/services/documentGraphTypes';
import {documentGraphRuntimePrompts} from '../src/workflows/documentGraphRuntimePrompts';

let checks=0;const test=async(name:string,fn:()=>unknown|Promise<unknown>)=>{await fn();checks++;console.log('PASS '+name);};
const texts=['实验设置条件甲。','条件甲用于说明该项选择。','实验设置条件乙。'];
const nodes:ExtractionNode[]=texts.map((quote,i)=>({id:`N${i+1}`,type:'事实陈述',source:[{window:'W1',quote}]}));
const ids=new Set(nodes.map(n=>n.id));
const edge=(id:string,from:string[],to:any,kind:'support'|'oppose'|'explain'='explain')=>({id,kind,from,to,reason:'合成说明关系待审'});
const rows=[edge('R1',['N1'],['N2']),edge('R2',['N2'],['N1'])];
const draft=(relations=rows)=>JSON.stringify({relations,coreClaims:[],unresolved:[]});
const options={draft:true,requireGapKind:true};
await test('单目标数组无损归一保留审计，默认解析仍拒绝闭环',()=>{
  const before=JSON.stringify(rows),r=parseRelations(draft(),nodes,options);
  assert.equal(r.formatAudit.length,2);assert.equal(r.relations.length,2);assert.equal(r.relations[0].to,'N2');
  assert.deepEqual(r.formatAudit[0],{relationId:'R1',field:'to',before:['N2'],after:'N2'});
  assert.equal(JSON.stringify(rows),before);assert.throws(()=>parseRelations(draft(),nodes),/闭环/);
});
await test('空、多目标、嵌套、数值、未知端点和自连仍拒绝',()=>{
  for(const to of [[],['N2','N3'],[['N2']],[2],['N99'],['N1']])assert.throws(()=>parseRelations(draft([edge('R1',['N1'],to)]),nodes,options));
  assert.throws(()=>parseRelations(draft([{...edge('R1',['N1'],'N2'),extra:true} as any]),nodes,options),/字段/);
  assert.throws(()=>parseRelations(draft([edge('R1',['N1'],'N2'),edge('R1',['N2'],'N3')]),nodes,options),/重复关系ID/);
});
await test('长环与联合前提闭环可检出，不把反对边或混合用途当支持环',()=>{
  const graph=[edge('R1',['N1','N3'],'N2','support'),edge('R2',['N2'],'N1','support')];
  assert.deepEqual(relationCycleGroups(graph)[0].nodeIds.sort(),['N1','N2']);
  assert.equal(relationCycleGroups([edge('R1',['N1'],'N2'),edge('R2',['N2'],'N3'),edge('R3',['N3'],'N1')])[0].relationIds.length,3);
  assert.equal(relationCycleGroups([edge('R1',['N1'],'N2','support'),edge('R2',['N2'],'N1','explain')]).length,0);
  assert.equal(relationCycleGroups([edge('R1',['N1'],'N2','oppose'),edge('R2',['N2'],'N1','oppose')]).length,0);
});
await test('闭环仅变为明确复核任务，不预先删线或改变方向',()=>{
  const initial=parseRelations(draft(),nodes,options),tasks=makeReviewTasks(nodes,initial.relations,[],[]);
  const cycle=tasks.filter(t=>t.check==='relation_cycle');assert.equal(cycle.length,1);
  assert.deepEqual(JSON.parse(cycle[0].quote).relationIds,['R1','R2']);assert.equal(initial.relations.length,2);
  assert(documentGraphRuntimePrompts.review.includes('## 草图闭环专项任务'));
});
const response=(relations:any[],tasks:ReturnType<typeof makeReviewTasks>)=>JSON.stringify({relations,
  decisions:tasks.map(t=>({taskId:t.id,relationIds:relations.filter(r=>r.to===t.nodeId||r.from.includes(t.nodeId)).map(r=>r.id),reason:'依原文保留用途明确的边；其他删除'})),referenceResolutions:[],unresolved:[]});
await test('复核原样保留闭环仍失败，修正后通过，漏答任务仍拒绝',()=>{
  const initial=parseRelations(draft(),nodes,options),tasks=makeReviewTasks(nodes,initial.relations,[],[]);
  assert.throws(()=>parseReview(response(initial.relations,tasks),nodes,tasks),/闭环/);
  assert.equal(parseReview(response(initial.relations.slice(0,1),tasks),nodes,tasks).relations.length,1);
  const missing=JSON.parse(response(initial.relations.slice(0,1),tasks));missing.decisions.pop();
  assert.throws(()=>parseReview(JSON.stringify(missing),nodes,tasks),/任务遗漏/);
  assert.throws(()=>validateRelations(rows,ids),/关系端点/);
  assert.throws(()=>validateRelations(initial.relations,ids),/闭环/);
});
await test('终稿单元素目标也可归一，但双向环不因数组包装漏检',()=>{
  const final={relations:[edge('R1',['N1'],['N2'])],decisions:[],referenceResolutions:[],unresolved:[]};
  const accepted=parseReview(JSON.stringify(final),nodes,[]);assert.equal(accepted.formatAudit.length,1);
  assert.equal(accepted.relations[0].to,'N2');
  final.relations.push(edge('R2',['N2'],['N1']));assert.throws(()=>parseReview(JSON.stringify(final),nodes,[]),/闭环/);
});
await test('真实协调器先复核循环草图，未修复不执行实体或保存；接续不重发前两步',async()=>{
  const content=texts.join('\n');
  const source:DocumentGraphSourceSnapshot={docId:'synthetic',sourceFingerprint:'s1',previousRevision:null,environmentId:'e1',windowPlanFingerprint:'p1',
    chunks:[{id:'c1',sectionPath:'合成',content}],windows:[{id:'W1',section:'合成',parts:[{chunkId:'c1',start:0,end:content.length}]}]};
  let fix=false,commits=0;const calls:string[]=[];
  const deps:DocumentPipelineDependencies={prepare:async()=>source,guard:async()=>{},recall:async()=>{throw Error('unexpected recall');},
    commit:async input=>{validateRelations(input.relations,new Set(input.nodes.map(n=>n.id)));commits++;return {revision:'r1',nodes:3,relations:1};},
    call:async(stage,prompt,input:any)=>{calls.push(stage);
      if(stage.startsWith('1/'))return JSON.stringify({nodes});
      if(stage.startsWith('2/'))return draft();
      if(stage.startsWith('3/')){assert(input.reviewTasks.some((t:any)=>t.check==='relation_cycle'));assert(prompt.includes('## 草图闭环专项任务'));
        assert.equal(input.draft.relations.length,2);return response(fix?input.draft.relations.slice(0,1):input.draft.relations,input.reviewTasks);}
      if(stage.startsWith('4/'))return JSON.stringify({entities:[],entityRelations:[]});throw Error(stage);
    }};
  const cache=new Map<string,string>();await assert.rejects(()=>runDocumentGraphBatch(source,deps,()=>{},cache),/闭环/);
  assert.equal(commits,0);assert.equal(calls.length,3);
  fix=true;const result=await runDocumentGraphBatch(source,deps,()=>{},cache);
  assert.equal(result.requests,2);assert.equal(calls.filter(s=>s.startsWith('1/')).length,1);assert.equal(calls.filter(s=>s.startsWith('2/')).length,1);
  assert.equal(commits,1);assert.equal(result.draftCycleTasks?.length,1);assert.equal(result.relationFormatAudit?.relations.length,2);
});
if(process.argv[2])await test('真实24边只读回放：全部格式归一、两组往返归成一组闭环任务，保留全部语义供复核',async()=>{
  const dir=path.resolve(process.argv[2]),file=path.join(dir,'01-response.json'),bytes=await fs.readFile(file);
  const saved=JSON.parse(bytes.toString()),input=JSON.parse(JSON.parse(await fs.readFile(path.join(dir,'01-request.json'),'utf8')).request.messages[1].content);
  const initial=parseRelations(saved.content,input.nodes,options),original=JSON.parse(saved.content);
  assert.equal(initial.relations.length,24);assert.equal(initial.formatAudit.length,24);
  assert.deepEqual(initial.coreClaims,original.coreClaims);assert.deepEqual(initial.unresolved,original.unresolved);
  for(let i=0;i<24;i++)assert.deepEqual(initial.relations[i],{...original.relations[i],to:original.relations[i].to[0]});
  const tasks=makeReviewTasks(input.nodes,initial.relations,initial.coreClaims,initial.unresolved),cycles=tasks.filter(t=>t.check==='relation_cycle');
  assert.equal(cycles.length,1);const group=JSON.parse(cycles[0].quote);
  assert.deepEqual(group.nodeIds.sort(),['N22','N23','N24']);assert.deepEqual(group.relationIds,['R18','R19','R20','R21']);
  assert.throws(()=>validateRelations(initial.relations,new Set(input.nodes.map((n:any)=>n.id))),/闭环/);
  const sha=(b:Buffer)=>createHash('sha256').update(b).digest('hex');assert.equal(sha(bytes),sha(await fs.readFile(file)));
});
console.log(JSON.stringify({checks,cloudRequests:0,productionWrites:0,semanticCorrection:'not tested with live model'}));
