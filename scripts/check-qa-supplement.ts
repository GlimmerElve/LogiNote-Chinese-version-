import assert from 'node:assert/strict';
import {buildQaDocumentGraph, emptyQaDocumentGraph, validateQaGraphAnchors, readQaDocumentGraphPacket, QA_GRAPH_LIMITS} from '../src/services/agent/qaDocumentGraph';
import {attachQaDocumentGraph, qaGraphAnchorsFromHits} from '../src/services/agent/qaGraphEvidence';
import {createQaSupplementSession, mergeQaSupplement, QA_SUPPLEMENT_TOOL} from '../src/services/agent/qaSupplement';
import {buildQaEvidenceResult, registerQaTools} from '../src/services/agent/tools/qaTools';
import {buildPostToolReviewPrompt, createPostToolReviewState, runPostToolReviews} from '../src/services/agent/postToolReview';
import {runAgentTurn, AGENT_ROLES} from '../src/services/agent/agentEngine';
import {clearToolRegistryForTests, executeTool, getTool} from '../src/services/agent/toolRegistry';
import type {DocumentChunk, KnowledgeArgumentUnit, KnowledgeArgumentEdge, DocumentSearchResult} from '../src/types';
import type {AgentRuntimeContext} from '../src/services/agent/types';

const chunks: DocumentChunk[] = [], units: KnowledgeArgumentUnit[] = [];
for (let i = 1; i <= 3; i++) {
  const text = ['在条件甲下，实验测得结果乙。', '该观察支持条件甲下的判断丙。', '另一实验观察不支持判断丙。'][i-1];
  chunks.push({id: `c${i}`, docId: 'doc1', fileName: '合成资料.md', sectionPath: `实验/${i}`, index: i-1,
    content: text, embedding: [], textStart: 0, sentenceSpans: [{id: `s${i}`, textStart: 0, textEnd: text.length}]});
  units.push({id: `n${i}`, docId: 'doc1', chunkId: `c${i}`, sentenceIds: [`s${i}`], mainType: i === 2 ? '推理' : '事实陈述',
    layer: 'judgment', text, textStart: 0, textEnd: text.length, mentionedEntityIds: [], confidence: .9,
    origin: 'imported-document-extraction', admission: 'admitted'});
}
const edges: KnowledgeArgumentEdge[] = [
  {id: 'e1', docId: 'doc1', chunkId: 'c1', sourceArgumentId: 'n1', targetArgumentId: 'n2', relation: 'support',
    evidenceSentenceIds: ['s1', 's2'], confidence: .9, admission: 'admitted'},
  {id: 'e2', docId: 'doc1', chunkId: 'c3', sourceArgumentId: 'n3', targetArgumentId: 'n2', relation: 'oppose',
    evidenceSentenceIds: ['s3', 's2'], confidence: .9, admission: 'admitted'},
];
const read = (nodeId = 'n2', override: Partial<Parameters<typeof buildQaDocumentGraph>[0]> = {}) =>
  buildQaDocumentGraph({anchors: [{docId: 'doc1', nodeId}], chunks, units, edges, ...override});
const graph = read();
assert.deepEqual(new Set(graph.nodes.map(n => n.nodeId)), new Set(['n1', 'n2', 'n3']));
assert.deepEqual(graph.relations.map(r => r.kind), ['support', 'oppose']);
assert.equal(graph.semanticCertified, false);
assert.equal(read('n1').nodes.some(n => n.nodeId === 'n2'), true, '从前提命中也能读取承接判断');
assert.equal(read('unknown').nodes.length, 0);
assert.equal(read('n2', {units: units.map(n => ({...n, text: '陈旧文本'}))}).nodes.length, 0);
assert.equal(read('n2', {units: units.map(n => ({...n, admission: 'low_confidence'}))}).nodes.length, 0);
assert.equal(read('n2', {edges: [...edges, {...edges[0], id: 'self', sourceArgumentId: 'n2'}]}).relations.length, 2);
assert.equal(read('n2', {edges: [...edges, {...edges[0], id: 'duplicate'}]}).relations.length, 2);
assert.equal(read('n2', {edges: edges.map(e => ({...e, docId: 'other'}))}).relations.length, 0);
assert.throws(() => validateQaGraphAnchors([{docId: '../escape', nodeId: 'n2'}]), /invalid_anchor/);
assert.throws(() => validateQaGraphAnchors(Array(9).fill({docId: 'doc1', nodeId: 'n2'})), /anchor_budget/);
assert.throws(() => validateQaGraphAnchors([{docId: 'doc1', nodeId: 'n2', extra: true}]), /invalid_anchor/);
const long = '长'.repeat(QA_GRAPH_LIMITS.characters + 1);
const clipped = read('n2', {chunks: [{...chunks[1], content: long, sentenceSpans: [{id:'s2', textStart:0, textEnd:long.length}]}],
  units: [{...units[1], text: long, textEnd: long.length}], edges: []});
assert.equal(clipped.nodes.length, 0);
assert.equal(clipped.omissions.some(o => o.reason === 'character_budget'), true);

const hit = (i: number): DocumentSearchResult => ({docId: 'doc1', chunkId: `c${i}`, fileName: '合成资料.md',
  sectionPath: `实验/${i}`, snippet: units[i-1].text, score: .9, matchKinds: ['passage', 'argument'],
  arguments: [{argumentId: `n${i}`, mainType: units[i-1].mainType, text: units[i-1].text, confidence: .9,
    origin: 'imported-document-extraction', admission: 'admitted', match: 'direct'}]});
const evidence = (hits: DocumentSearchResult[]) => buildQaEvidenceResult({question: '条件甲下的依据是什么？', requestedScope: 'global',
  noteResults: [], documentResults: hits});
assert.deepEqual(qaGraphAnchorsFromHits([hit(2), hit(2)]), [{docId: 'doc1', nodeId: 'n2'}]);
const initialGraph = {...emptyQaDocumentGraph('partial'), omissions: [], nodes: graph.nodes.filter(n => n.nodeId === 'n2')};
const base = attachQaDocumentGraph(evidence([hit(2)]), initialGraph);
const full = attachQaDocumentGraph(base, graph);
assert.equal(full.sources[0].sourceId, 'D1');
assert.equal(full.documentGraph?.nodes.find(n => n.nodeId === 'n2')?.citationId, 'D1');
assert.equal(full.documentGraph?.nodes.find(n => n.nodeId === 'n1')?.citationId, 'D2');
assert.ok(readQaDocumentGraphPacket(full.documentGraph, new Set(['D1','D2','D3'])));
assert.equal(readQaDocumentGraphPacket(full.documentGraph, new Set(['D1'])), undefined);

let reads = 0, searches = 0;
let forwardedQuery:string|undefined,forwardedIntent:string|undefined;
const deps = {readGraph: async (_anchors:unknown,query?:string,intentQuery?:string) => {reads++;forwardedQuery=query;forwardedIntent=intentQuery;return graph;}, search: async () => {searches++; return [hit(1)];}};
const session = createQaSupplementSession(base, deps);
const expanded = await session.execute({mode: 'expand', missingMaterial: '判断丙的直接依据和反证', anchors: [{docId:'doc1',nodeId:'n2'}]});
assert.equal(expanded.supplement.status, 'added');
assert.equal(expanded.supplement.addedNodes, 2);
assert.equal(expanded.supplement.addedRelations, 2);
assert.equal(forwardedQuery,base.question,'expand forwards the original question instead of silently using general intent');
assert.equal(expanded.sources[0].sourceId, 'D1');
assert.equal(session.available, false);
await assert.rejects(() => session.execute({}), /budget_exhausted/);
assert.equal(reads, 1);
assert.equal(mergeQaSupplement(full, full).supplement.status, 'no_new_material');
const sameChunkNewPassage = mergeQaSupplement(base, evidence([{...hit(2), snippet: '同一正文块中新命中的条件和统计数据。'}]));
assert.equal(sameChunkNewPassage.supplement.addedSources, 1, '同块新命中原文不能被去重吃掉');
assert.equal(sameChunkNewPassage.sources[0].sourceId, 'D1');
assert.equal(sameChunkNewPassage.sources[1].sourceId, 'D2');
assert.equal(mergeQaSupplement(base, evidence([])).sources[0].sourceId, 'D1');
const unknown = createQaSupplementSession(base, deps);
await assert.rejects(() => unknown.execute({mode:'expand', missingMaterial:'依据', anchors:[{docId:'doc1',nodeId:'invented'}]}), /unknown_anchor/);
assert.equal(unknown.available, false);
assert.equal(reads, 1, '无效节点不得触发读取');
const rejected = createQaSupplementSession(base, deps);
await assert.rejects(() => rejected.execute({mode:'search', missingMaterial:'依据', query:'甲', includePersonalCognition:true}), /invalid_request/);
assert.equal(searches, 0);
const searched = await createQaSupplementSession(base, deps).execute({mode:'search', missingMaterial:'实验甲的原始结果', query:'实验甲 条件甲 测量结果'});
assert.equal(searches, 1);
assert.equal(forwardedQuery,'实验甲 条件甲 测量结果','search forwards its rewritten matching query');
assert.equal(forwardedIntent,base.question,'rewritten matching does not replace original question intent');
assert.equal(searched.question, base.question);
assert.equal(searched.requestedScope, base.requestedScope);
assert.equal(searched.sources[0].sourceId, 'D1');
const failed = createQaSupplementSession(base, {...deps, search: async () => {throw new Error('offline');}});
await assert.rejects(() => failed.execute({mode:'search',missingMaterial:'依据',query:'甲'}), /offline/);
await assert.rejects(() => failed.execute({mode:'search',missingMaterial:'依据',query:'甲'}), /budget_exhausted/);
const race = createQaSupplementSession(base, deps);
const raced = await Promise.allSettled([race.execute({mode:'search',missingMaterial:'依据',query:'甲'}), race.execute({mode:'search',missingMaterial:'依据',query:'甲'})]);
assert.deepEqual(raced.map(r => r.status), ['fulfilled','rejected']);
const changed = structuredClone(full);
changed.documentGraph!.nodes[0].text = '变更的正文';
assert.throws(() => mergeQaSupplement(full, changed), /source_changed/);
const personal: typeof base = {...base, personalCognition: {status:'unavailable',method:'local-lexical-v1',items:[],warning:'读取失败'}};
assert.deepEqual(mergeQaSupplement(personal, evidence([])).personalCognition, personal.personalCognition);
const state = createPostToolReviewState();
await runPostToolReviews({skillId:'personalized-qa',userRequest:base.question,state,auditRunId:'synthetic',allowLlmReviews:false,
  steps:[{call:{id:'read',name:'retrieve_qa_evidence',arguments:{}},ok:true,result:expanded}]});
const prompt = buildPostToolReviewPrompt(state);
assert.ok(prompt.includes('n1') && prompt.includes('e1') && prompt.includes('D2'));
assert.equal(state.llmCallsUsed, 0);
assert.equal(state.qaEvidence?.documentGraph?.nodes.length, 3);

// Actual Agent loop with in-memory desktop API only; no network/storage service exists in this fixture.
const cache = new Map<string,string>();
Object.assign(globalThis, {localStorage:{getItem:(k:string)=>cache.get(k)??null,setItem:(k:string,v:string)=>cache.set(k,v),removeItem:(k:string)=>cache.delete(k)}});
let ipcSearches = 0, ipcReads = 0;
let ipcQuery:string|undefined,ipcIntent:string|undefined;
Object.assign(globalThis, {window:{electronAPI:{noteRag:{search:async()=>[]},ragDocs:{search:async () => {ipcSearches++;return [hit(1)];},
  readArgumentEvidence:async (_anchors:unknown,query?:string,intentQuery?:string) => {ipcReads++;ipcQuery=query;ipcIntent=intentQuery;return graph;}}}}});
clearToolRegistryForTests(); registerQaTools();
const registered = getTool('retrieve_qa_evidence')!;
// Keep the first evidence retrieval focused, then exercise the real supplement API path.
const {registerTool} = await import('../src/services/agent/toolRegistry');
registerTool({...registered,execute:async () => base});
const noWrite = () => {throw new Error('unexpected mutation');};
const ctx = new Proxy({getNotes:()=>[],getActiveNote:()=>null,getPlanDraftSession:()=>null,getResourceDraftSession:()=>null,
  ensureDataFresh:async()=>{}}, {get:(target,key)=>key in target ? Reflect.get(target,key)
    : /^(?:create|apply|append|stage|commit|start|discard|navigate|openNote|enterLearning)/u.test(String(key)) ? noWrite : undefined}) as unknown as AgentRuntimeContext;
let modelCalls = 0;
const turn = await runAgentTurn({role: AGENT_ROLES.default,userText:base.question,preferredSkillId:'personalized-qa',history:[],ctx,
  memoryPrefixLoader:async()=>'',enableMultiAgent:false,callLlm:async request => {
    modelCalls++;
    if (modelCalls === 1) {
      assert.equal(request.tools?.some(t => t.name === QA_SUPPLEMENT_TOOL.name), true);
      return {content:'',toolCalls:[{id:'supplement1',name:QA_SUPPLEMENT_TOOL.name,
        arguments:{mode:'search',missingMaterial:'原始实验数据',query:'条件甲 实验数据'}}]};
    }
    assert.equal(request.tools?.some(t => t.name === QA_SUPPLEMENT_TOOL.name), false);
    assert.match(request.systemPromptOverride || '', /"id":"e1"/);
    assert.match(request.systemPromptOverride || '', /"citationId":"D2"/);
    return {content:'条件甲下的实验结果为乙，支持判断丙。[D2]'};
  }});
assert.equal(modelCalls, 2);
assert.equal(ipcSearches, 1);
assert.equal(ipcReads, 1);
assert.equal(ipcQuery,'条件甲 实验数据');assert.equal(ipcIntent,base.question,'real Agent → client → desktop adapter preserves original intent');
assert.equal(turn.toolTrace.filter(s => s.call.name === QA_SUPPLEMENT_TOOL.name && s.ok).length, 1);
assert.ok(turn.updatedHistory.at(-1)?.citations?.some(c => c.sourceId === 'D2'), '最终答案必须识别补检索的真实引用');
let duplicateRound = 0;
const duplicateTurn = await runAgentTurn({role:AGENT_ROLES.default,userText:base.question,requestedSkillId:'personalized-qa',history:[],ctx,
  memoryPrefixLoader:async()=>'',enableMultiAgent:false,callLlm:async request=>{
    if (++duplicateRound === 1) return {content:'',toolCalls:['once','twice'].map(id=>({id,name:QA_SUPPLEMENT_TOOL.name,
      arguments:{mode:'expand',missingMaterial:'判断丙的依据',anchors:[{docId:'doc1',nodeId:'n2'}]}}))};
    assert.equal(request.tools?.some(t=>t.name===QA_SUPPLEMENT_TOOL.name),false);
    return {content:'首个补查已给出实验结果乙。[D2]'};
  }});
assert.equal(duplicateTurn.toolTrace.filter(s=>s.call.name===QA_SUPPLEMENT_TOOL.name&&s.ok).length,1);
assert.equal(duplicateTurn.toolTrace.find(s=>s.call.id==='twice')?.error,'qa_supplement_budget_exhausted');
assert.equal(ipcReads,2,'同一响应中的重复工具调用不得重复读取');
registerTool({...registered,execute:async()=>full});
let noNewRound = 0;
const noNewTurn = await runAgentTurn({role:AGENT_ROLES.default,userText:base.question,requestedSkillId:'personalized-qa',history:[],ctx,
  memoryPrefixLoader:async()=>'',enableMultiAgent:false,callLlm:async request=>{
    if (++noNewRound === 1) return {content:'',toolCalls:[{id:'nonew',name:QA_SUPPLEMENT_TOOL.name,
      arguments:{mode:'expand',missingMaterial:'更多实验依据',anchors:[{docId:'doc1',nodeId:'n2'}]}}]};
    assert.equal(request.tools?.some(t=>t.name===QA_SUPPLEMENT_TOOL.name),false);
    assert.match(JSON.stringify(request.agentMessages),/no_new_material/);
    return {content:'未检索到额外依据；已有观察为乙。[D2]'};
  }});
assert.equal(noNewRound,2);
assert.equal((noNewTurn.toolTrace.find(s=>s.call.id==='nonew')?.result as {supplement?:{status:string}}).supplement?.status,'no_new_material');
registerTool({...registered,execute:async()=>base});
const desktop = (globalThis as any).window.electronAPI.ragDocs;
const successfulSearch = desktop.search;
desktop.search = async()=>{throw new Error('synthetic_reader_offline');};
let failedRound = 0;
const failedTurn = await runAgentTurn({role:AGENT_ROLES.default,userText:base.question,requestedSkillId:'personalized-qa',history:[],ctx,
  memoryPrefixLoader:async()=>'',enableMultiAgent:false,callLlm:async request=>{
    if (++failedRound === 1) return {content:'',toolCalls:[{id:'failed',name:QA_SUPPLEMENT_TOOL.name,
      arguments:{mode:'search',missingMaterial:'更多实验依据',query:'实验甲 依据'}}]};
    assert.equal(request.tools?.some(t=>t.name===QA_SUPPLEMENT_TOOL.name),false);
    assert.match(request.systemPromptOverride||'',/"nodeId":"n2"/);
    return {content:'补查暂不可用，保留已有判断丙的原文。[D1]'};
  }});
assert.equal(failedTurn.toolTrace.find(s=>s.call.id==='failed')?.ok,false);
assert.ok(failedTurn.updatedHistory.at(-1)?.citations?.some(c=>c.sourceId==='D1'));
desktop.search = successfulSearch;
let reviewedRound = 0;
await runAgentTurn({role:AGENT_ROLES.default,userText:base.question,requestedSkillId:'personalized-qa',history:[],ctx,
  memoryPrefixLoader:async()=>'',enableMultiAgent:true,callLlm:async request=>{
    reviewedRound++;
    if (reviewedRound === 1) return {content:JSON.stringify({coverage:'partial',supportedCitationIds:[],risks:['首轮D1不足以回答'],answerGuidance:['补找原始观察']})};
    if (reviewedRound === 2) return {content:'',toolCalls:[{id:'reviewed-supplement',name:QA_SUPPLEMENT_TOOL.name,
      arguments:{mode:'expand',missingMaterial:'原始观察',anchors:[{docId:'doc1',nodeId:'n2'}]}}]};
    if (reviewedRound === 3) {
      assert.match(request.systemPromptOverride||'',/首轮D1不足以回答/);
      assert.equal(request.tools?.some(t=>t.name===QA_SUPPLEMENT_TOOL.name),false);
      return {content:'原始观察为结果乙。[D2]'};
    }
    assert.equal(request.tools,undefined,'原有最终审核不得获得工具');
    const body = JSON.parse(request.userInput);
    assert.equal(body.supportedCitationIds.includes('D1'),false,'补查不能重新准入首轮被排除的引用');
    assert.equal(body.supportedCitationIds.includes('D2'),true);
    assert.ok(body.documentGraph.nodes.some((n:{nodeId:string})=>n.nodeId==='n1'),'审核也必须读到补回的节点原文');
    return {content:JSON.stringify({valid:true,invalidCitationIds:[],unsupportedClaims:[],repairInstructions:[]})};
  }});
assert.equal(reviewedRound,4,'补检索不增加独立审核模型请求');
// A separate skill cannot use the synthetic capability via the global registry.
assert.equal((await executeTool(QA_SUPPLEMENT_TOOL.name,{},ctx)).ok, false);
// Original real preflight adapter: return source-verified graph and retain the rich nodes.
registerTool(registered);
const preflight = await executeTool('retrieve_qa_evidence',{question:base.question,scope:'global'},ctx);
assert.equal(preflight.ok, true);
assert.equal((preflight.result as typeof full).documentGraph?.nodes.length, 3);
console.log('QA supplement: source replay, graph budgets, stable citations, one-shot/race/failure guards, no-new stop, and real Agent loop passed; cloud calls=0.');
