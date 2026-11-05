import assert from 'node:assert/strict';
import {promises as fs} from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {parseNodes,type ExtractionWindow} from '../src/services/documentGraphProtocol';
import {inspectNodeSources,confirmNodeSources,NodeSourceRepairRequired} from '../src/services/documentGraphNodeRepair';
import {runDocumentGraphBatch,type DocumentPipelineDependencies} from '../src/services/documentGraphPipeline';
import type {DocumentGraphSourceSnapshot} from '../src/services/documentGraphTypes';

let checks=0;const test=async(name:string,fn:()=>unknown|Promise<unknown>)=>{await fn();checks++;console.log('PASS '+name);};
const original='本研究记录每个参与者在两种给定条件下的选择，商店位于开车20 分钟时程以外的地方，询问参与者是否愿意前往另一家商店购买相同的商品。';
const typo=original.replace('开车20','开车走20');
const windows:ExtractionWindow[]=[{id:'W1',section:'合成实验',text:original}];
const raw=(quote=typo)=>JSON.stringify({nodes:[{id:'N1',type:'事实陈述',source:[{window:'W1',quote}]}]});
await test('长引文一字偏差仅产生候选，不修改原始响应',()=>{
  const input=raw(),p=inspectNodeSources(input,windows);assert(p.canConfirm);assert.equal(p.issues[0].candidates[0].quote,original);
  assert.equal(p.validNodeCount,0);assert.equal(raw(),input);assert.throws(()=>parseNodes(input,windows),/原话/);
  assert.throws(()=>confirmNodeSources(input,windows,false),/未确认/);
  const fixed=confirmNodeSources(input,windows,true);assert.equal(parseNodes(fixed.correctedRaw,windows)[0].source[0].quote,original);
  assert.equal(fixed.audit[0].before,typo);assert.equal(fixed.audit[0].after,original);
});
await test('否定、数字变化也必须显式确认，不能自动修词',()=>{
  for(const changed of [original.replace('20','30'),original.replace('愿意','不愿意')]){
    const p=inspectNodeSources(raw(changed),windows);assert(p.canConfirm);assert.throws(()=>confirmNodeSources(raw(changed),windows,false));
  }
});
await test('排版映射恢复原文，仍须确认',()=>{
  const ws=[{...windows[0],text:original.replace('商店位于','商店\n位于')}];
  const p=inspectNodeSources(raw(original),ws);assert.equal(p.issues[0].candidates[0].method,'layout');
  assert.equal(parseNodes(confirmNodeSources(raw(original),ws,true).correctedRaw,ws)[0].source[0].quote,ws[0].text);
});
await test('重复出现、多个近似候选、短词和无对应原文不自动选',()=>{
  assert(!inspectNodeSources(raw(original),[{...windows[0],text:original+'\n'+original}]).canConfirm);
  assert(!inspectNodeSources(raw(),[{...windows[0],text:original+'\n'+original}]).canConfirm);
  assert(!inspectNodeSources(raw('商店位于开车走20分钟'),windows).canConfirm);
  assert(!inspectNodeSources(raw('不存在的引用内容'),windows).canConfirm);
});
await test('协议形状和来源窗口未知仍受限制',()=>{
  assert.throws(()=>inspectNodeSources('{"nodes":[],"extra":true}',windows),/字段/);
  const p=inspectNodeSources(raw(),[]);assert.equal(p.issues[0].reason,'missing_window');assert(!p.canConfirm);
});
await test('修订后也不能绕过跨节点重复包含规则',()=>{
  const v=JSON.parse(raw());v.nodes.push({id:'N2',type:'事实陈述',source:[{window:'W1',quote:original.slice(0,20)}]});
  assert.throws(()=>confirmNodeSources(JSON.stringify(v),windows,true),/重复包含/);
});
const snapshot:DocumentGraphSourceSnapshot={docId:'synthetic',sourceFingerprint:'s1',previousRevision:null,environmentId:'env1',
  windowPlanFingerprint:'p1',chunks:[{id:'c1',sectionPath:'合成实验',content:original}],windows:[{id:'W1',section:'合成实验',parts:[{chunkId:'c1',start:0,end:original.length}]}]};
function fixture(){
  const state={calls:[] as string[],commits:0,confirmations:0,failRelation:false,revoked:false,changed:false};
  const deps:DocumentPipelineDependencies={prepare:async()=>state.changed?{...snapshot,sourceFingerprint:'changed'}:snapshot,
    guard:async()=>{if(state.revoked)throw Error('revoked');},recall:async()=>{throw Error('unexpected recall');},commit:async()=>{state.commits++;return {revision:'r1',nodes:1,relations:0};},
    call:async(stage,_prompt,payload:any)=>{
      state.calls.push(stage);
      if(stage.startsWith('1/'))return raw();
      if(stage.startsWith('2/')){if(state.failRelation)throw Error('relation_transport_failure');
        assert.equal(payload.nodes[0].source[0].quote,original);return JSON.stringify({relations:[],coreClaims:[],unresolved:[]});}
      if(stage.startsWith('3/'))return JSON.stringify({relations:[],decisions:payload.reviewTasks.map((t:any)=>({taskId:t.id,relationIds:[],reason:'独立事实保留'})),referenceResolutions:[],unresolved:[]});
      if(stage.startsWith('4/'))return JSON.stringify({entities:[],entityRelations:[]});
      throw Error('unexpected stage');
    }};
  return {state,deps,cache:new Map<string,string>()};
}
await test('暂缓后保留原始响应，确认续跑不重发初抽',async()=>{
  const {state,deps,cache}=fixture();deps.confirmNodeRepair=async()=>{state.confirmations++;return false;};
  await assert.rejects(()=>runDocumentGraphBatch(snapshot,deps,()=>{},cache),NodeSourceRepairRequired);
  assert.equal(state.calls.length,1);assert.equal(state.commits,0);assert([...cache.values()].includes(raw()));
  deps.confirmNodeRepair=async proposal=>{state.confirmations++;proposal.issues[0].candidates[0].quote='恶意修改回调候选';return true;};
  const result=await runDocumentGraphBatch(snapshot,deps,()=>{},cache);
  assert.equal(result.requests,3);assert.equal(state.calls.filter(c=>c.startsWith('1/')).length,1);
  assert.equal(result.nodeSourceRepairAudit?.[0].after,original);assert.equal(state.commits,1);assert.equal(cache.size,0);
  assert.equal(result.nodeSourceRepairReceipt?.originalRaw,raw());
  assert.equal(parseNodes(result.nodeSourceRepairReceipt!.acceptedRaw,windows)[0].source[0].quote,original);
});
await test('后续阶段失败不丢失已确认修订；再次接续不重复确认',async()=>{
  const {state,deps,cache}=fixture();state.failRelation=true;
  deps.confirmNodeRepair=async()=>{state.confirmations++;return true;};
  await assert.rejects(()=>runDocumentGraphBatch(snapshot,deps,()=>{},cache),/relation_transport_failure/);
  assert.equal(state.calls.length,2);state.failRelation=false;
  const result=await runDocumentGraphBatch(snapshot,deps,()=>{},cache);
  assert.equal(state.confirmations,1);assert.equal(result.requests,3);assert.equal(result.nodeSourceRepairAudit?.length,1);
});
await test('没有确认入口时保留待审状态而非静默修复',async()=>{
  const {state,deps,cache}=fixture();await assert.rejects(()=>runDocumentGraphBatch(snapshot,deps,()=>{},cache),NodeSourceRepairRequired);
  await assert.rejects(()=>runDocumentGraphBatch(snapshot,deps,()=>{},cache),NodeSourceRepairRequired);
  assert.equal(state.calls.length,1);assert.equal(state.commits,0);
});
await test('确认期间来源改变或权限撤回，停止后续请求和保存',async()=>{
  for(const mode of ['changed','revoked'] as const){const {state,deps,cache}=fixture();
    deps.confirmNodeRepair=async()=>{state[mode]=true;return true;};
    await assert.rejects(()=>runDocumentGraphBatch(snapshot,deps,()=>{},cache),mode==='changed'?/资料来源/:/revoked/);
    assert.equal(state.calls.length,1);assert.equal(state.commits,0);assert(![...cache.keys()].some(k=>k.includes('confirmed-node-source')));
  }
});
if(process.argv[2]){
  const dir=path.resolve(process.argv[2]),file=path.join(dir,'01-response.json'),bytes=await fs.readFile(file);
  const request=JSON.parse(await fs.readFile(path.join(dir,'01-request.json'),'utf8'));
  const ws=JSON.parse(request.request.messages[1].content).windows,content=JSON.parse(bytes.toString()).content;
  await test('真实失败只读回放：仅N24一字修订，其他25节点不变',()=>{
    const proposal=inspectNodeSources(content,ws);assert.equal(proposal.validNodeCount,25);assert(proposal.canConfirm);
    assert.equal(proposal.issues[0].nodeId,'N24');assert.equal(proposal.issues.length,1);
    const result=confirmNodeSources(content,ws,true),before=JSON.parse(content).nodes,after=parseNodes(result.correctedRaw,ws);
    assert.equal(after.length,26);assert.equal(result.audit[0].before.replace('开车走20','开车20'),result.audit[0].after);
    for(let i=0;i<26;i++)if(i!==23)assert.deepEqual(before[i],after[i]);
  });
  assert.equal(createHash('sha256').update(await fs.readFile(file)).digest('hex'),createHash('sha256').update(bytes).digest('hex'));
}
console.log(JSON.stringify({checks,cloudRequests:0,productionWrites:0,scope:'source repair and in-session resume; not semantic graph certification'}));
