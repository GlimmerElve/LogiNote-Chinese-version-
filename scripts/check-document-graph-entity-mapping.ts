import assert from 'node:assert/strict';
import {promises as fs} from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {entityReadingLabel,makeEntityReadingFragments,locateEntityMention} from '../src/services/documentGraphEntityReading';
import {parseEntityReadingResult} from '../src/services/documentGraphEntityProtocol';
import {validateEntities,parseRelations,parseReview,makeReviewTasks,missingMaterialNodeIds,type Gap,type ExtractionNode} from '../src/services/documentGraphProtocol';
import {bindReviewedDocumentGraphs} from '../src/services/documentGraphBinding';
import {boundEntityReading} from '../src/services/documentGraphEntitySource';
import {nextPipelineWindows} from '../src/services/documentGraphPipeline';
import {documentGraphRuntimePrompts} from '../src/workflows/documentGraphRuntimePrompts';
import {rankDocumentGraphEntries} from '../src/electron/rag/documentGraphRetrieval';
import type {SavedDocumentGraph} from '../src/services/documentGraphTypes';

let checks=0;
const test=(name:string,fn:()=>void)=>{fn();checks++;console.log('PASS '+name);};
const parts=[{id:'N1',quotes:['  金钱\n心理账户是研究对象。A Time\nManagement Measure。金额 amount of\nmoney paid；再述 amount of money\npaid。','第二段：心理账户。']}];
const fragments=makeEntityReadingFragments(parts),texts=new Map(parts.map(n=>[n.id,n.quotes.join('\n')]));
const mention=(quote:string,occurrence=1,fragmentId='N1:F1')=>({fragmentId,quote,occurrence,reference:false});
const wire=(name:string,mentions=[mention(name)])=>({entities:[{id:'E1',name,mentions}],entityRelations:[]});
const parse=(value:unknown)=>parseEntityReadingResult(JSON.stringify(value),fragments,texts);

test('中英文排版修整不改标点、大小写、连字符或普通行内空格',()=>{
  assert.equal(entityReadingLabel('  金钱\n心理账户 A Time\r\nManagement  Measure '),'金钱心理账户 A Time Management Measure');
  assert.equal(entityReadingLabel('pre-\ncondition，ABC\nDEF；心理  账户'),'pre- condition，ABC DEF；心理 账户');
});
test('阅读短词恢复逐字原文与精确坐标',()=>{
  const r=parse(wire('金钱心理账户'));assert.equal(r.issues.length,0);
  const m=r.entities[0].mentions[0];assert.equal(m.quote,'金钱\n心理账户');assert.equal(texts.get('N1')!.slice(m.source!.start,m.source!.end),m.quote);
  validateEntities(r.entities,[],texts);
});
test('重复短词必须选出现次数；不得默认选择第一个',()=>{
  assert.equal(locateEntityMention(fragments[0],'amount of money paid').status,'ambiguous');
  const one=locateEntityMention(fragments[0],'amount of money paid',1),two=locateEntityMention(fragments[0],'amount of money paid',2);
  assert.equal(one.status,'matched');assert.equal(two.status,'matched');
  if(one.status==='matched'&&two.status==='matched'){assert.notEqual(one.source.start,two.source.start);assert.equal(two.quote,'amount of money\npaid');}
  assert.equal(locateEntityMention(fragments[0],'amount of money paid',3).status,'invalid_occurrence');
});
test('节点第二片段的偏移包含原始第一片段和分隔符',()=>{
  const r=parse(wire('心理账户',[mention('心理账户',1,'N1:F2')])),m=r.entities[0].mentions[0];
  assert.equal(m.source!.start,parts[0].quotes[0].length+1+4);assert.equal(texts.get('N1')!.slice(m.source!.start,m.source!.end),'心理账户');
});
test('不能跨片段造词；错误位置隔离但有效实体保留',()=>{
  const r=parse({entities:[wire('金钱心理账户').entities[0],{id:'E2',name:'paid。第二段',mentions:[mention('paid。第二段')]}],entityRelations:[]});
  assert.equal(r.entities.length,1);assert(r.issues.some(i=>i.reason==='missing'));
});
test('同一原话可跨存储块恢复，不同原话片段不得合造实体',()=>{
  const snapshot={docId:'test',sourceFingerprint:'s',previousRevision:null,chunks:[{id:'c1',content:'金钱'},{id:'c2',content:'心理账户。'},{id:'c3',content:'对象甲。'}]} as any;
  const graph={graphId:'G1',windows:[{id:'W1',parts:[{chunkId:'c1',start:0,end:2},{chunkId:'c2',start:0,end:5},{chunkId:'c3',start:0,end:4}]}],
    nodes:[{id:'N1',type:'事实陈述' as const,source:[{window:'W1',quote:'金钱\n心理账户。'},{window:'W1',quote:'对象甲。'}]}],relations:[],unresolved:[]};
  const bound=bindReviewedDocumentGraphs(snapshot,[graph]);
  const read=boundEntityReading(snapshot,graph,bound.nodes);
  assert.equal(read.fragments.length,2);assert.equal(read.fragments[0].text,'金钱心理账户。');
  const r=parseEntityReadingResult(JSON.stringify(wire('金钱心理账户')),read.fragments,read.texts);
  assert.equal(r.entities[0].mentions[0].quote,'金钱\n心理账户');
  assert.equal(locateEntityMention(read.fragments[0],'账户。对象甲').status,'missing');
});
test('没有具名来源的实体及其依赖关系一起隔离',()=>{
  const r=parse({entities:[wire('金钱心理账户').entities[0],{id:'E2',name:'编造名',mentions:[mention('编造名')]}],
    entityRelations:[{from:'E1',to:'E2',predicate:'指向',evidenceNodeIds:['N1']}]});
  assert.equal(r.entities.length,1);assert.equal(r.entityRelations.length,0);assert(r.issues.some(i=>i.reason.startsWith('relation_quarantined')));
});
test('未知片段隔离；未知实体端点和畸形协议仍拒绝',()=>{
  assert.equal(parse(wire('金钱心理账户',[mention('金钱心理账户',1,'N999:F1')])).entities.length,0);
  assert.throws(()=>parse({...wire('金钱心理账户'),entityRelations:[{from:'E1',to:'E999',predicate:'关联',evidenceNodeIds:['N1']}]}),/端点/);
  assert.throws(()=>parse(wire('金钱心理账户',[mention('金钱心理账户',0)])),/位置选择/);
});
test('重复位置去重并记录，不增加假别名',()=>{
  const r=parse(wire('金钱心理账户',[mention('金钱心理账户'),mention('金钱心理账户')]));
  assert.equal(r.entities[0].mentions.length,1);assert.equal(r.issues[0].reason,'duplicate_occurrence');
});
test('host拒绝伪造坐标；旧版精确原话仍兼容',()=>{
  const r=parse(wire('金钱心理账户'));r.entities[0].mentions[0].source!.start++;
  assert.throws(()=>validateEntities(r.entities,[],texts),/坐标/);
  validateEntities([{id:'E1',name:'研究对象',mentions:[{nodeId:'N1',quote:'研究对象',reference:false}]}],[],texts);
  assert.throws(()=>validateEntities([{id:'E1',name:'金钱心理账户',mentions:[{nodeId:'N1',quote:'金钱\n心理账户',reference:false}]}],[],texts),/命名依据/);
});
test('实体词面召回使用可读名称，不受原始换行影响，不推广代词',()=>{
  const r=parse(wire('金钱心理账户')),vector=Array(384).fill(0);
  const graph={docId:'test',sourceFingerprint:'s',revision:'r',nodes:[{id:'N1',text:texts.get('N1')!,embedding:vector,source:[{chunkId:'c1'}]}],entities:r.entities,entityRelations:[]} as unknown as SavedDocumentGraph;
  assert.equal(rankDocumentGraphEntries([graph],'金钱心理账户',vector)[0].entityScore,1);
  assert.equal(rankDocumentGraphEntries([graph],'这个概念',vector).find(n=>n.nodeId.endsWith('N1'))?.entityScore||0,0);
});
const nodes:ExtractionNode[]=['N1','N2','N3'].map(id=>({id,type:'事实陈述',source:[]}));
const diagnostics:Gap[]=[{nodeId:'N1',kind:'classification_note',reason:'正常事实不属于核心主张'},
  {nodeId:'N2',kind:'node_issue',reason:'观察和解释混块'}, {nodeId:'N3',kind:'missing_material',reason:'前文实验对象不在输入中'}];
test('分类说明不进入缺口复核，只有真实缺材料进入跨图召回',()=>{
  assert.deepEqual(missingMaterialNodeIds(diagnostics),['N3']);
  assert(!makeReviewTasks(nodes,[],[],diagnostics).some(t=>t.nodeId==='N1'&&t.check==='prior_gap'));
  assert(makeReviewTasks(nodes,[],[],diagnostics).some(t=>t.nodeId==='N2'&&t.check==='prior_gap'));
  assert.deepEqual(missingMaterialNodeIds([{nodeId:'N1',reason:'旧版未分类说明'}]),[]);
});
test('新模型协议强制诊断类别；旧回放仍可读取',()=>{
  const v={coreClaims:[],relations:[],unresolved:diagnostics};
  parseRelations(JSON.stringify(v),nodes,{requireGapKind:true});
  const old={...v,unresolved:[{nodeId:'N1',reason:'旧诊断'}]};
  assert.throws(()=>parseRelations(JSON.stringify(old),nodes,{requireGapKind:true}),/字段/);parseRelations(JSON.stringify(old),nodes);
  for(const stage of ['relations','review'] as const){assert(documentGraphRuntimePrompts[stage].includes('classification_note'));assert(!documentGraphRuntimePrompts[stage].includes('unresolved: [{nodeId, reason}]'));}
});
test('正常分类说明不能代替未解析回指的具体缺口',()=>{
  const task={id:'T1',nodeId:'N1',check:'reference_target',quote:'该实验'};
  const v={relations:[],decisions:[{taskId:'T1',relationIds:[],reason:'无对象'}],referenceResolutions:[{taskId:'T1',targets:[],reason:'无对象'}],
    unresolved:[{nodeId:'N1',kind:'classification_note',reason:'该实验只是事实陈述'}]};
  assert.throws(()=>parseReview(JSON.stringify(v),nodes,[task],{requireGapKind:true}),/未解析回指/);
});

// Optional read-only replay. Old responses are not relabeled as new model output.
// Select only uniquely locatable old mentions; ambiguity is reported, never guessed.
if(process.argv[2]){
  const dir=path.resolve(process.argv[2]),names=['01-response.json','04-response.json','source-snapshot.json'];
  const bytes=await Promise.all(names.map(n=>fs.readFile(path.join(dir,n))));
  const digest=(b:Buffer)=>createHash('sha256').update(b).digest('hex'),before=bytes.map(digest);
  const initial=JSON.parse(JSON.parse(bytes[0].toString()).content),old=JSON.parse(JSON.parse(bytes[1].toString()).content),snapshot=JSON.parse(bytes[2].toString());
  const local=bindReviewedDocumentGraphs(snapshot,[{graphId:'G1',windows:nextPipelineWindows(snapshot),nodes:initial.nodes,relations:[],unresolved:[]}]);
  const {fragments:fsources,texts:nt}=boundEntityReading(snapshot,{graphId:'G1',windows:nextPipelineWindows(snapshot),nodes:initial.nodes,relations:[],unresolved:[]},local.nodes);
  let originalExact=0,recovered=0;const quarantined:Array<{entity:string;node:string;quote:string;matches:number}>=[];
  const converted={entities:old.entities.map((e:any)=>({...e,mentions:e.mentions.flatMap((m:any)=>{
    const candidates=fsources.filter(f=>f.nodeId===m.nodeId).flatMap(f=>{
      const quote=entityReadingLabel(m.quote),r=locateEntityMention(f,quote);
      return r.count?Array.from({length:r.count},(_,i)=>({fragmentId:f.id,quote,occurrence:i+1,reference:m.reference})):[];
    });
    if(candidates.length!==1){quarantined.push({entity:e.id,node:m.nodeId,quote:m.quote,matches:candidates.length});return [];}
    if(nt.get(m.nodeId)!.includes(m.quote))originalExact++;else recovered++;
    return candidates;
  })})).filter((e:any)=>e.mentions.length),entityRelations:[]};
  const retainedIds=new Set(converted.entities.map((e:any)=>e.id));
  converted.entityRelations=old.entityRelations.filter((r:any)=>retainedIds.has(r.from)&&retainedIds.has(r.to));
  const replay=parseEntityReadingResult(JSON.stringify(converted),fsources,nt);
  validateEntities(replay.entities,replay.entityRelations,nt);
  assert.equal(recovered,5);assert.equal(originalExact,44);assert.equal(quarantined.length,7);
  assert(quarantined.every(m=>m.matches===2));assert.equal(replay.entities.length,22);
  assert.equal(replay.entities.reduce((n,e)=>n+e.mentions.length,0),48);
  assert(replay.issues.some(i=>i.entityId==='E12'&&i.reason==='no_grounded_canonical_name'));
  assert.deepEqual(await Promise.all(names.map(async n=>digest(await fs.readFile(path.join(dir,n))))),before,'historical receipts unchanged');
  console.log(JSON.stringify({readOnlyReplay:dir,originalExact,recovered,quarantined,retainedEntities:replay.entities.length,
    retainedMentions:replay.entities.reduce((n,e)=>n+e.mentions.length,0),retainedRelations:replay.entityRelations.length,issues:replay.issues},null,2));
}
console.log(`PASS ${checks} entity mapping / classified-gap checks; zero model requests.`);
