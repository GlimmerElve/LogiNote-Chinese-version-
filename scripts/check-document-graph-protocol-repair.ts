import assert from 'node:assert/strict';
import {promises as fs} from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {NODE_TYPES,normalizeModelRelations,validateRelations,parseRelations,parseReview,type ExtractionNode,type ReviewTask} from '../src/services/documentGraphProtocol';
import {DOCUMENT_GRAPH_TYPE_CONTRACT,documentGraphRuntimePrompts} from '../src/workflows/documentGraphRuntimePrompts';
import stage1 from '../src/workflows/documentGraphStage1';

let checks=0;
const test=(name:string,fn:()=>void)=>{fn();checks++;console.log('PASS '+name);};
const ids=new Set(['N1','N2','N3']);
const edge=(id:string,from=['N1'],to='N2',kind:'support'|'oppose'|'explain'='explain',reason='说明实验的来源')=>({id,kind,from,to,reason});
const nodes:ExtractionNode[]=[...ids].map(id=>({id,type:'事实陈述',source:[]}));
const tasks:ReviewTask[]=[{id:'T1',nodeId:'N2',check:'reference_target',quote:'该实验'}];
const review=()=>({relations:[edge('R1'),edge('R2',undefined,undefined,undefined,'这个具体实验是被回指的对象')],
  decisions:[{taskId:'T1',relationIds:['R2'],reason:'选择被回指的实验'}],
  referenceResolutions:[{taskId:'T1',targets:['N1'],reason:'该实验指N1'}],unresolved:[]});

test('三个阶段共享全部九类含义；初抽提示词未改写',()=>{
  assert.equal(documentGraphRuntimePrompts.nodes,stage1);
  assert.deepEqual([...DOCUMENT_GRAPH_TYPE_CONTRACT.matchAll(/^- (.+?)：/gmu)].slice(0,9).map(m=>m[1]),NODE_TYPES);
  for(const prompt of Object.values(documentGraphRuntimePrompts))assert.equal(prompt.split(DOCUMENT_GRAPH_TYPE_CONTRACT).length,2);
  for(const stage of ['relations','review'] as const){
    const prompt=documentGraphRuntimePrompts[stage];
    assert(prompt.includes('观察、数据、实验设计、背景、引用他人的结论'));
    assert(prompt.includes('真实的混块、错误归类仍应报告'));
    assert(prompt.indexOf(DOCUMENT_GRAPH_TYPE_CONTRACT)<prompt.indexOf(stage==='relations'?'## 执行步骤':'## 执行流程'));
  }
});
test('同类同端点去重，保留两个原始理由且不修改输入',()=>{
  const raw=review().relations,before=JSON.stringify(raw),r=normalizeModelRelations(raw,ids);
  assert.equal(r.relations.length,1);assert.equal(r.aliases.get('R2'),'R1');
  assert.deepEqual(r.normalizationAudit,[{removedId:'R2',retainedId:'R1',kind:'explain',from:['N1'],to:'N2',removedReason:raw[1].reason,retainedReason:raw[0].reason}]);
  assert.equal(JSON.stringify(raw),before);
});
test('共同前提按集合去重，不能合并成单独理由',()=>{
  const r=normalizeModelRelations([edge('R1',['N1','N2'],'N3'),edge('R2',['N2','N1'],'N3'),edge('R3',['N1'],'N3')],ids);
  assert.equal(r.relations.length,2);assert.deepEqual(r.relations[0].from,['N1','N2']);
});
test('不同类型、不同方向、不同目标不合并',()=>{
  const r=normalizeModelRelations([edge('R1'),edge('R2',undefined,undefined,'support'),edge('R3',['N2'],'N1','oppose'),edge('R4',['N1'],'N3')],ids);
  assert.equal(r.relations.length,4);
});
test('映射decision关系ID后仍执行回指端点检查',()=>{
  const r=parseReview(JSON.stringify(review()),nodes,tasks);
  assert.deepEqual(r.decisions[0].relationIds,['R1']);assert.deepEqual(r.referenceResolutions[0].targets,['N1']);
  assert.equal(r.normalizationAudit.length,1);
});
test('decision同时引用原边和别名时去重',()=>{
  const v=review();v.decisions[0].relationIds=['R1','R2'];
  assert.deepEqual(parseReview(JSON.stringify(v),nodes,tasks).decisions[0].relationIds,['R1']);
});
test('未知关系ID仍拒绝',()=>{
  const v=review();v.decisions[0].relationIds=['R99'];assert.throws(()=>parseReview(JSON.stringify(v),nodes,tasks),/未知关系/);
});
test('回指缺边仍拒绝，不因去重放宽目标约束',()=>{
  const v=review();v.referenceResolutions[0].targets=['N3'];assert.throws(()=>parseReview(JSON.stringify(v),nodes,tasks),/对应直接连线/);
});
test('decision原始重复ID仍拒绝',()=>{
  const v=review();v.decisions[0].relationIds=['R2','R2'];assert.throws(()=>parseReview(JSON.stringify(v),nodes,tasks),/ID列表/);
});
test('未知/重复任务仍拒绝',()=>{
  const v=review();v.decisions[0].taskId='T99';assert.throws(()=>parseReview(JSON.stringify(v),nodes,tasks),/复核任务/);
});
test('空回指必须留缺口',()=>{
  const v=review();v.referenceResolutions[0].targets=[];assert.throws(()=>parseReview(JSON.stringify(v),nodes,tasks),/未解析回指/);
});
test('重复关系ID即使相同也拒绝，避免歧义映射',()=>{
  assert.throws(()=>normalizeModelRelations([edge('R1'),edge('R1')],ids),/重复关系ID/);
  assert.throws(()=>normalizeModelRelations([edge('R1'),edge('R1',['N3'])],ids),/重复关系ID/);
});
test('先查原始数量上限，不能通过重复边绕过预算',()=>{
  assert.throws(()=>normalizeModelRelations([edge('R1'),edge('R2')],ids,1),/关系上限/);
});
test('重复边的超长理由、额外字段仍拒绝',()=>{
  assert.throws(()=>normalizeModelRelations([edge('R1'),edge('R2',undefined,undefined,undefined,'a'.repeat(601))],ids),/文本为空或超限/);
  assert.throws(()=>normalizeModelRelations([edge('R1'),{...edge('R2'),extra:true}],ids),/字段不符合协议/);
});
test('自环、悬空、重复前提仍拒绝',()=>{
  assert.throws(()=>normalizeModelRelations([edge('R1',['N2'])],ids),/关系端点/);
  assert.throws(()=>normalizeModelRelations([edge('R1',['N99'])],ids),/关系端点/);
  assert.throws(()=>normalizeModelRelations([edge('R1',['N1','N1'])],ids),/ID列表/);
});
test('去重不能掩盖支持或解释闭环',()=>{
  for(const kind of ['support','explain'] as const)
    assert.throws(()=>normalizeModelRelations([edge('R1',['N1'],'N2',kind),edge('R2',['N2'],'N1',kind),edge('R3',['N1'],'N2',kind)],ids),/闭环/);
});
test('宿主严格校验仍拒绝未经归一化的重复关系',()=>{
  assert.throws(()=>validateRelations([edge('R1'),edge('R2')],ids),/重复关系/);
});
test('阶段二共享归一化，不修改主张/缺口、不猜测误报',()=>{
  const original={coreClaims:[{nodeId:'N2',status:'incomplete',gaps:['需要核对']}],relations:review().relations,unresolved:[{nodeId:'N1',reason:'引用结论不能属于事实陈述'}]};
  const result=parseRelations(JSON.stringify(original),nodes);
  assert.equal(result.relations.length,1);assert.deepEqual(result.coreClaims,original.coreClaims);assert.deepEqual(result.unresolved,original.unresolved);
});

// Optional read-only replay of the real failed receipt. No output file, source write or model call.
if(process.argv[2]){
  assert.equal(process.argv.length,3);
  const run=await fs.realpath(process.argv[2]);
  const files=['03-request.json','03-response.json','execution-failure.json'];
  const bytes=await Promise.all(files.map(f=>fs.readFile(path.join(run,f))));
  const request=JSON.parse(bytes[0].toString()),response=JSON.parse(bytes[1].toString());
  const input=JSON.parse(request.request.messages[1].content),raw=JSON.parse(response.content);
  const result=parseReview(response.content,input.draft.nodes,input.reviewTasks);
  assert.deepEqual(result.unresolved,raw.unresolved,'never silently erase semantic problems during structural replay');
  assert.deepEqual(result.referenceResolutions,raw.referenceResolutions);
  assert.equal(result.relations.length,47);assert.equal(raw.relations.length,48);
  assert(result.normalizationAudit.some(a=>a.removedId==='R42'&&a.retainedId==='R37'));
  const refTask=result.referenceResolutions.find(r=>r.targets.includes('N16'))!;
  assert(result.decisions.find(d=>d.taskId===refTask.taskId).relationIds.includes('R37'));
  const sha=(b:Buffer)=>createHash('sha256').update(b).digest('hex');
  for(let i=0;i<files.length;i++)assert.equal(sha(await fs.readFile(path.join(run,files[i]))),sha(bytes[i]));
  console.log(JSON.stringify({replay:'structural_pass_only',originalRelations:raw.relations.length,normalizedRelations:result.relations.length,
    audit:result.normalizationAudit,retainedSemanticDiagnostics:result.unresolved.length,saved:false,cloudRequests:0,productionWrites:0}));
}
console.log(JSON.stringify({checks,cloudRequests:0,productionWrites:0,semanticPromptEffect:'requires_new_model_acceptance'}));
