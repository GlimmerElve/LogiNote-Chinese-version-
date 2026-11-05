import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { setDataRoot, CURRENT_INDEX_SCHEMA_VERSION, deleteDocumentSourceFiles,writeChunksFile,readChunksFile } from '../src/electron/ragIndex';
import { setKnowledgeDataRoot } from '../src/electron/rag/knowledgeStore';
import { buildStructuredDocument } from '../src/electron/rag/structuredDocument';
import { planDocumentArgumentV5, nextDocumentArgumentV5Windows } from '../src/electron/rag/documentArgumentV5Plan';
import { prepareDocumentArgumentV5, commitDocumentArgumentV5, recallDocumentArgumentV5Bridges,readDocumentArgumentV5View,resetDocumentArgumentV5,recordDocumentArgumentV5Response } from '../src/electron/rag/documentArgumentV5Service';
import { DOCUMENT_ARGUMENT_V5_PROMPT_HASH, DOCUMENT_ARGUMENT_V5_LEGACY_PROMPT_HASH, documentArgumentV5Hash, readSavedDocumentArgumentV5, archiveDocumentArgumentV5,saveDocumentArgumentV5 } from '../src/electron/rag/documentArgumentV5Store';
import { documentArgumentBridgePackets, runDocumentArgumentV5Batch } from '../src/services/documentArgumentV5Pipeline';
import { documentArgumentComponents, parseDocumentArgumentV5Batch, selectDocumentArgumentV5Handoff } from '../src/services/documentArgumentV5Protocol';
import { listDocumentsWithGraphProgress } from '../src/electron/rag/documentGraphService';
import { DOCUMENT_ARGUMENT_V5_PROMPT, DOCUMENT_ARGUMENT_V5_BATCH_TEXT_PROMPT } from '../src/workflows/documentArgumentV5Prompt';
import {DOCUMENT_ARGUMENT_V5_LEGACY_WINDOW_PROMPT} from '../src/workflows/documentArgumentV5LegacyPrompt';
import type { DocumentChunk } from '../src/types';
import type { DocumentArgumentV5Commit } from '../src/services/documentArgumentV5Types';
import {documentGraphFingerprint} from '../src/electron/rag/documentGraphStore';
import { documentArgumentSourceBlocks } from '../src/electron/rag/documentArgumentV5Sources';
import {searchDocuments} from '../src/electron/ragIndex';
import {readQaDocumentGraph} from '../src/electron/rag/qaDocumentGraphReader';
import {attachQaDocumentGraph,qaGraphAnchorsFromHits} from '../src/services/agent/qaGraphEvidence';
import {readQaDocumentGraphPacket} from '../src/services/agent/qaDocumentGraph';
import {buildQaEvidenceResult} from '../src/services/agent/tools/qaTools';
import {buildDocumentArgumentInputShapeAb,DOCUMENT_ARGUMENT_V5_WINDOWED_ATTENTION_PROMPT} from '../src/services/documentArgumentInputShapeAb';

// Temporary synthetic store; model and embeddings are controlled stubs. No cloud/user data writes.
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'argument-v5-')), dir = path.join(root, 'rag-index');
await fs.mkdir(dir); await fs.mkdir(path.join(root, 'documents'));
setDataRoot(root); setKnowledgeDataRoot(root);
const write = (name: string, value: unknown) => fs.writeFile(path.join(dir, name), JSON.stringify(value));
const vector = () => Array.from({ length: 384 }, (_, i) => Number(i === 0));
const body = [
  '实验甲采用两种情景。' + '这段为完整实验设计的说明。'.repeat(130),
  '情景甲成功九次，情景乙成功两次。' + '这些是两种情景的观察记录。'.repeat(130),
  '所以两种情景的成功次数不同。' + '这一段给出数据的概括。'.repeat(130),
  '后续干预方法直接处理这些观察。' + '这一段描述后续干预方法。'.repeat(130),
];
const structured = buildStructuredDocument('synthetic-v5', [
  ...body.map((text, i) => ({ text, kind: 'paragraph' as const, sectionPath: '实验甲', locator: { kind: 'text' as const, charStart: i, charEnd: i + 1 } })),
  { text: '表1 成功次数', kind: 'caption', locator: { kind: 'text', charStart: 5, charEnd: 6 } },
  { text: '|情景|成功次数|\n|甲|9|\n|乙|2|', kind: 'table', locator: { kind: 'text', charStart: 6, charEnd: 7 } },
  { text: '参考文献', kind: 'heading', locator: { kind: 'text', charStart: 7, charEnd: 8 } },
  { text: '某作者：前人研究。', kind: 'paragraph', locator: { kind: 'text', charStart: 8, charEnd: 9 } },
]);
const chunks: DocumentChunk[] = [{ id: 'chunk', docId: 'synthetic-v5', fileName: '合成资料.md', index: 0,
  sectionPath: '实验甲', content: structured.normalizedText, textStart: 0, textEnd: structured.normalizedText.length,
  embedding: [], schemaVersion: CURRENT_INDEX_SCHEMA_VERSION }];
const manifest = [{ id: 'synthetic-v5', fileName: '合成资料.md', extension: '.md', status: 'ready', indexable: true, indexSchemaVersion: CURRENT_INDEX_SCHEMA_VERSION }];
await write('manifest.json', manifest); await write('chunks-synthetic-v5.json', chunks);
await write('structured-synthetic-v5.json', structured); await write('knowledge-settings.json', { enabled: true });
// The host uses its actual structured filename; write through the same production helper.
const { writeStructuredDocumentFile } = await import('../src/electron/ragIndex');
await writeStructuredDocumentFile(structured);
const legacyGraph={docId:'synthetic-v5',sourceFingerprint:documentGraphFingerprint('synthetic-v5',chunks),nodes:[{id:'oldNode',source:[{chunkId:'chunk',start:0,end:body[0].length}]}],
  entities:[{id:'oldEntity',name:'实验甲',embedding:vector(),mentions:[{nodeId:'oldNode',quote:'实验甲',reference:false}]}],entityRelations:[]};
await write('argument-graph-synthetic-v5.json',legacyGraph);
await write('knowledge-synthetic-v5.json',{schemaVersion:1,docId:'synthetic-v5',status:'ready',committedChunkIds:['chunk'],entityMentions:[{id:'entity-sentinel'}],entityRelations:[],argumentUnits:[{id:'old-argument'}],argumentEdges:[]});
await write('entity-catalog.json',{schemaVersion:1,entities:[]});

const plan = planDocumentArgumentV5(chunks, structured);
assert.equal(plan.windows.length, 4);
assert.equal(plan.objects.filter(o => o.kind === 'table').length, 1);
assert.equal(plan.objects.filter(o => o.kind === 'references').length, 2);
assert(!plan.windows.some(w => w.text.includes('|情景|') || w.text.includes('某作者')));
const first = nextDocumentArgumentV5Windows({ windows: plan.windows });
assert.equal(first.length, 2);
assert(first.reduce((n, w) => n + [...w.text].length, 0) >= 3000);
assert([...first.map(w=>w.text).join('\n\n')].length < 4000);
assert.throws(() => nextDocumentArgumentV5Windows({ windows: [{ ...plan.windows[0], text: '字'.repeat(4000) }] }), /超过3999/);

let calls = 0, embeds = 0;
const embed = async (_text: string) => { embeds++; return vector(); };
const dependencies = {
  prepare: prepareDocumentArgumentV5,
  guard: async () => {},
  commit: (input: DocumentArgumentV5Commit) => commitDocumentArgumentV5(input, { embed }),
  recall: (input: DocumentArgumentV5Commit) => recallDocumentArgumentV5Bridges(input, embed),
  call: async (stage: string, _prompt: string, input: any) => {
    calls++;
    assert.equal(stage, 'extract');
    assert.equal(_prompt,DOCUMENT_ARGUMENT_V5_BATCH_TEXT_PROMPT);
    assert.deepEqual(Object.keys(input).sort(),['inherited_graph','text']);
    assert.equal(input.text,(calls===1?body.slice(0,2):body.slice(2)).join('\n\n'));
    if (calls === 1) {
      assert.equal(input.inherited_graph.next_node_id, 'N1');
      return JSON.stringify({ nodes: [
        { id: 'N1', role: 'method', source: [{ quote: '实验甲采用两种情景。' }] },
        { id: 'N2', role: 'premise', source: [{ quote: '情景甲成功九次，情景乙成功两次。' }] },
      ], arguments: [], relations: [{ id: 'R1', kind: 'method_for', from: 'N1', to: 'N2', reason: '实验直接产生两种观察' }], unresolved: [] });
    }
    assert.equal(input.inherited_graph.next_node_id, 'N3');
    assert.deepEqual(Object.keys(input.inherited_graph.nodes[0]), ['id', 'role', 'text']);
    assert(!JSON.stringify(input.inherited_graph).includes('quote'));
    assert(input.inherited_graph.edges.some((e: any) => e.from === 'N1' && e.to === 'N2'));
    return JSON.stringify({ nodes: [
      { id: 'N3', role: 'claim', source: [{ quote: '所以两种情景的成功次数不同。' }] },
      { id: 'N4', role: 'method', source: [{ quote: '后续干预方法直接处理这些观察。' }] },
    ], arguments: [{ id: 'A1', claim: 'N3', support: ['N2'], oppose: [], status: 'argued' }],
    relations: [{ id: 'R1', kind: 'method_for', from: 'N4', to: 'N2', reason: '后续方法处理原观察' }], unresolved: [] });
  },
};
const snapshot1 = await prepareDocumentArgumentV5('synthetic-v5');
const result1 = await runDocumentArgumentV5Batch(snapshot1, dependencies);
assert.equal(result1.done, 2); assert.equal(result1.requests, 1); assert.equal(embeds, 2);
// Simulate an already saved first batch from the original window-based contract.
const workingPath=path.join(dir,'argument-graph-v5-synthetic-v5.pending.json');
const legacyPending=JSON.parse(await fs.readFile(workingPath,'utf8'));
legacyPending.build.promptHash=DOCUMENT_ARGUMENT_V5_LEGACY_PROMPT_HASH;
delete legacyPending.build.batches[0].promptHash;
const {revision:_oldRevision,...legacyContent}=legacyPending;
legacyPending.revision=documentArgumentV5Hash(legacyContent);
await fs.writeFile(workingPath,JSON.stringify(legacyPending));
assert.equal(await readSavedDocumentArgumentV5(dir,'synthetic-v5',chunks),null,'partial work is not published');
assert.deepEqual(JSON.parse(await fs.readFile(path.join(dir,'argument-graph-synthetic-v5.json'),'utf8')),legacyGraph,'old graph survives until a complete new graph is ready');
const snapshot2 = await prepareDocumentArgumentV5('synthetic-v5');
assert.equal(snapshot2.current?.nodes.length, 2);
const firstView=await readDocumentArgumentV5View('synthetic-v5');
assert(!firstView.published&&firstView.nodes.length===2&&firstView.edges.length===1);
assert.equal(firstView.progress?.batchCount,1);
const responseRecord={docId:snapshot2.docId,sourceFingerprint:snapshot2.sourceFingerprint,previousRevision:snapshot2.previousRevision,
  windowPlanFingerprint:snapshot2.windowPlanFingerprint,promptHash:snapshot2.promptHash,stage:'extract' as const,raw:'{"invalid":"quote"}',error:'N3 / W3 引文未定位'};
await recordDocumentArgumentV5Response(responseRecord);
assert.equal(JSON.parse(await fs.readFile(path.join(dir,'argument-response-v5-synthetic-v5-extract.json'),'utf8')).raw,responseRecord.raw);
await assert.rejects(()=>recordDocumentArgumentV5Response({...responseRecord,previousRevision:null}),/版本已变化/);
await assert.rejects(()=>runDocumentArgumentV5Batch(snapshot2,{...dependencies,call:async()=>{throw Error('second batch failed');}}),/second batch failed/);
assert.deepEqual(await readDocumentArgumentV5View('synthetic-v5'),firstView,'second failure preserves the entire first graph');
const result2 = await runDocumentArgumentV5Batch(snapshot2, dependencies);
assert.equal(result2.done, 4); assert.equal(result2.components, 1); assert.equal(calls, 2);
assert.equal(embeds, 4, 'saved vectors reused during continuation');
const stored = await readSavedDocumentArgumentV5(dir, 'synthetic-v5', chunks);
assert(stored); assert.equal(stored.build.bridgeStatus, 'complete');
assert.equal(stored.build.promptHash,DOCUMENT_ARGUMENT_V5_PROMPT_HASH);
assert.deepEqual(stored.build.batches.map(b=>b.promptHash),[DOCUMENT_ARGUMENT_V5_LEGACY_PROMPT_HASH,DOCUMENT_ARGUMENT_V5_PROMPT_HASH]);
assert.deepEqual(stored.nodes.slice(0,2),legacyPending.nodes,'new I/O does not rewrite the old nodes or embeddings');
assert.deepEqual(stored.nodes.map(n => n.id), ['N1', 'N2', 'N3', 'N4']);
assert.equal(stored.arguments[0].support[0], 'N2');
assert.equal(stored.objects.filter(o => o.kind === 'table').length, 1);
assert.equal((await listDocumentsWithGraphProgress())[0].documentGraphProgress?.version, 'v5.0');
await assert.rejects(()=>fs.stat(path.join(dir,'argument-graph-synthetic-v5.json')),/ENOENT/);
await assert.rejects(()=>fs.stat(path.join(dir,'argument-graph-v5-synthetic-v5.pending.json')),/ENOENT/);
const shard=JSON.parse(await fs.readFile(path.join(dir,'knowledge-synthetic-v5.json'),'utf8'));
assert.deepEqual(shard.argumentUnits,[]);assert.deepEqual(shard.argumentEdges,[]);assert.deepEqual(shard.entityMentions,[{id:'entity-sentinel'}]);
const entities=JSON.parse(await fs.readFile(path.join(dir,'entity-graph-synthetic-v5.json'),'utf8'));
assert.equal(entities.entities[0].name,'实验甲');assert(!JSON.stringify(entities).includes('oldNode'));
const hits=await searchDocuments('所以两种情景的成功次数不同',1,{mode:'argument'},{embed:async()=>vector()});
assert(hits.length&&hits[0].documentGraphAnchors?.every(a=>a.nodeId.startsWith('dg5:')),'retrieval reads only active v5');
const packet=await readQaDocumentGraph(qaGraphAnchorsFromHits(hits));
assert.equal(packet.adapter,'source-bound-document-graph-v5');
assert(packet.nodes.length&&packet.relations.some(r=>r.kind==='method_for'));
const cited=attachQaDocumentGraph(buildQaEvidenceResult({question:'成功次数的依据',requestedScope:'global',noteResults:[],documentResults:hits}),packet);
assert(readQaDocumentGraphPacket(cited.documentGraph,new Set(cited.sources.map(s=>s.sourceId))));
await assert.rejects(() => commitDocumentArgumentV5(snapshot2.current!, { embed }), /版本已变化/);

const latest = await prepareDocumentArgumentV5('synthetic-v5');
const abParagraphs=first;
const abPair=buildDocumentArgumentInputShapeAb(abParagraphs,{next_node_id:'N1',nodes:[],edges:[]});
assert(abPair.parity.sameText&&abPair.parity.windows<=abParagraphs.length&&abPair.parity.sourceParagraphs===abParagraphs.length);
assert(!JSON.stringify(abPair.windowed.input).includes('section'));
assert(DOCUMENT_ARGUMENT_V5_WINDOWED_ATTENTION_PROMPT.includes('id`\u548c`text')&&!DOCUMENT_ARGUMENT_V5_WINDOWED_ATTENTION_PROMPT.includes('每项含 id、section、text'));
// Local bridge recall merges adjacent detached nodes and nominates their ordinal
// neighbour without inferring an edge itself.
const localAudit=structuredClone(latest.current!);localAudit.previousRevision=latest.previousRevision;
localAudit.arguments=[];localAudit.relations=localAudit.relations.filter(r=>r.from==='N1'&&r.to==='N2');
localAudit.build.bridgeStatus='pending';
const localTasks=await recallDocumentArgumentV5Bridges(localAudit,embed);
assert.deepEqual(localTasks.map(t=>t.component.map(n=>n.id)),[['N3','N4']]);
assert.deepEqual(localTasks[0].candidates.map(n=>n.id),['N2','N1']);
assert.deepEqual(localTasks[0].candidates.map(n=>n.selection),['ordinal','context_neighbor']);
assert(localTasks[0].candidates.length<=12);assert.equal(localTasks[0].exhaustive,true);
assert.equal(localTasks[0].round,1);assert.deepEqual(localTasks[0].existingEdges,[{kind:'method_for',from:'N1',to:'N2'}]);
const packetTasks=Array.from({length:5},(_,i)=>({...localTasks[0],taskId:`P${i+1}`}));
const packets=documentArgumentBridgePackets(packetTasks,2,100000);
assert.deepEqual(packets.map(group=>group.length),[2,2,1]);
assert.deepEqual(packets.flat().map(task=>task.taskId),packetTasks.map(task=>task.taskId),'packet split must not drop detached groups');
const empty = { nodes: [], arguments: [], relations: [], unresolved: [] };
const inherited = selectDocumentArgumentV5Handoff(empty, latest.chunks);
assert.throws(() => parseDocumentArgumentV5Batch(JSON.stringify({ nodes: [{ id: 'N1', role: 'claim', source: [{ window: first[0].id, quote: '不存在的原文' }] }], arguments: [], relations: [], unresolved: [] }), first, empty, inherited, 1), /逐字定位/);
const malicious = structuredClone(latest.current!);
malicious.previousRevision = latest.previousRevision;
malicious.nodes[0].role = 'background';
await assert.rejects(() => commitDocumentArgumentV5(malicious, { embed }), /续跑不得修改/);
const frozenFile = await fs.readFile(path.join(dir, 'argument-graph-v5-synthetic-v5.json'), 'utf8');
await write('knowledge-settings.json', { enabled: false });
await assert.rejects(() => prepareDocumentArgumentV5('synthetic-v5'), /未启用/);
await assert.rejects(()=>resetDocumentArgumentV5('synthetic-v5'),/未启用/);
const readOnlyView=await readDocumentArgumentV5View('synthetic-v5');
assert(readOnlyView.published&&readOnlyView.nodes.length===4);
assert(!JSON.stringify(readOnlyView).includes('embedding'),'UI projection never returns vectors');
assert.equal((await readQaDocumentGraph(qaGraphAnchorsFromHits(hits))).adapter,'source-bound-document-graph-v5');
const pausedHits=await searchDocuments('所以两种情景的成功次数不同',1,undefined,{embed:async()=>vector()});
assert(pausedHits[0]?.documentGraphAnchors?.length,'default auto retrieval survives extraction pause');
await write('knowledge-settings.json', { enabled: true });
const nextCommit = { ...latest.current!, previousRevision: latest.previousRevision };
let revoke = false;
await assert.rejects(() => commitDocumentArgumentV5(nextCommit, { assertEnvironment: () => { if (revoke) throw Error('revoked'); revoke = true; }, embed }), /revoked/);
assert.equal(await fs.readFile(path.join(dir, 'argument-graph-v5-synthetic-v5.json'), 'utf8'), frozenFile);

// A failing optional bridge does not lose a validated extraction; next run skips extraction.
const bridgeSnapshot = structuredClone(latest);
bridgeSnapshot.previousRevision = null; delete bridgeSnapshot.current;
bridgeSnapshot.windows = bridgeSnapshot.windows.slice(0, 1);
let captured: DocumentArgumentV5Commit | undefined;
let bridgeCalls = 0;
const bridgeDeps = {
  prepare: async () => bridgeSnapshot, guard: async () => {}, commit: async (c: DocumentArgumentV5Commit) => { captured = structuredClone(c); return { revision: 'r', nodes: c.nodes.length, relations: c.relations.length }; },
  recall: async () => [{ taskId: 'C1', component: [{ id: 'N2', role: 'premise', text: '说明' }],
    candidates: [{ id: 'N1', role: 'claim', text: '实验', distance: 1, selection: 'ordinal' as const }], existingEdges: [], round: 1, exhaustive: true }],
  call: async (stage: string, _prompt: string, input: any) => {
    if (stage === 'bridge') { bridgeCalls++; throw Error('synthetic bridge failure'); }
    return JSON.stringify({ nodes: [
      { id: 'N1', role: 'claim', source: [{ quote: '实验甲采用两种情景。' }] },
      { id: 'N2', role: 'premise', source: [{ quote: '这段为完整实验设计的说明。' }] },
    ], arguments: [{id:'A1',claim:'N1',support:[],oppose:[],status:'stated_only'}], relations: [], unresolved: [] });
  },
};
// Unique occurrence for this focused synthetic case.
bridgeSnapshot.windows[0] = { ...bridgeSnapshot.windows[0], text: '实验甲采用两种情景。这段为完整实验设计的说明。', parts: [{ chunkId: bridgeSnapshot.chunks[0].id, start: 0, end: '实验甲采用两种情景。这段为完整实验设计的说明。'.length }] };
const pending = await runDocumentArgumentV5Batch(bridgeSnapshot, bridgeDeps);
assert(pending.bridgePending && captured && captured.nodes.length === 2);
const pendingGraph=structuredClone(captured);
bridgeSnapshot.current = captured;
const finished = await runDocumentArgumentV5Batch(bridgeSnapshot, { ...bridgeDeps, call: async stage => {
  assert.equal(stage, 'bridge'); bridgeCalls++;
  return JSON.stringify({ bridges: [{ taskId: 'C1', decision: 'add', additions: [
    { from: 'N2', to: 'N1', kind: 'support', basis: '说明直接支持实验主张' }], basis: '已接回相邻实验' }] });
} });
assert.equal(finished.requests, 1); assert.equal(finished.components, 1); assert.equal(bridgeCalls, 2);
assert.equal(documentArgumentComponents(captured!).length, 1);
assert.deepEqual(captured!.arguments[0],pendingGraph.arguments[0],'补链不得修改已保存的主张记录');
assert(captured!.arguments.slice(pendingGraph.arguments.length).some(a=>a.claim==='N1'&&a.support.includes('N2')),
  '对旧主张的新 support 必须作为新 argument 追加');

// Frozen-role conflicts are retained with diagnostics, not rejected.
const invalidBridgeSnapshot=structuredClone(bridgeSnapshot);invalidBridgeSnapshot.current=pendingGraph;
let invalidCaptured:DocumentArgumentV5Commit|undefined;
const excessiveButTolerated=Array.from({length:17},()=>({from:'N2',to:'N1',kind:'method_for',basis:'错误地把背景作为方法'}));
const invalidBridge=await runDocumentArgumentV5Batch(invalidBridgeSnapshot,{...bridgeDeps,
  commit:async(c:DocumentArgumentV5Commit)=>{invalidCaptured=structuredClone(c);return{revision:'r2',nodes:c.nodes.length,relations:c.relations.length};},
  call:async stage=>{assert.equal(stage,'bridge');return JSON.stringify({bridges:[{taskId:'C1',decision:'add',additions:[
    ...excessiveButTolerated],basis:'结构角色错误'}]});}});
assert(!invalidBridge.bridgePending&&invalidBridge.warning);
assert.equal(invalidCaptured?.build.bridgeStatus,'complete');
assert.equal(invalidCaptured?.relations.filter(r=>r.kind==='method_for'&&r.from==='N2'&&r.to==='N1').length,1,'duplicate proposals only log, never append duplicate arrows');
assert(invalidCaptured!.unresolved.some(u=>u.reason.includes('[本地告警]')&&u.reason.includes('method_for 角色不匹配')));

assert.equal(DOCUMENT_ARGUMENT_V5_PROMPT_HASH, createHash('sha256').update(DOCUMENT_ARGUMENT_V5_BATCH_TEXT_PROMPT).digest('hex'));
assert.equal(DOCUMENT_ARGUMENT_V5_LEGACY_PROMPT_HASH,createHash('sha256').update(DOCUMENT_ARGUMENT_V5_LEGACY_WINDOW_PROMPT).digest('hex'));
assert.equal(DOCUMENT_ARGUMENT_V5_BATCH_TEXT_PROMPT,DOCUMENT_ARGUMENT_V5_PROMPT,'workflow default and batch extraction must use the same active prompt');
assert(DOCUMENT_ARGUMENT_V5_PROMPT.startsWith('# 原文论证抽取器 v5.0.8'));
assert(!DOCUMENT_ARGUMENT_V5_PROMPT.includes('## 本版说明')&&!DOCUMENT_ARGUMENT_V5_PROMPT.includes('在 v5.0.7 基础上'));
assert(!DOCUMENT_ARGUMENT_V5_BATCH_TEXT_PROMPT.includes('source.window'));
assert(!DOCUMENT_ARGUMENT_V5_BATCH_TEXT_PROMPT.includes('`windows`'));
const frozenContract = JSON.parse(await fs.readFile(new URL('../docs/document-argument-v5-contract.json', import.meta.url), 'utf8'));
assert.equal(DOCUMENT_ARGUMENT_V5_PROMPT_HASH, frozenContract.effectivePromptSha256, 'accepted prompt must not drift');
const concurrent = await Promise.allSettled([commitDocumentArgumentV5(nextCommit, { embed }), commitDocumentArgumentV5(nextCommit, { embed })]);
assert.equal(concurrent.filter(r => r.status === 'fulfilled').length, 1, 'concurrent CAS admits exactly one commit');
assert.equal(concurrent.filter(r => r.status === 'rejected').length, 1);
const beforeArchive = await fs.readFile(path.join(dir, 'argument-graph-v5-synthetic-v5.json'), 'utf8');
await archiveDocumentArgumentV5(dir, 'synthetic-v5');
assert.equal(await fs.readFile(path.join(dir,'argument-graph-v5-synthetic-v5.json'),'utf8'),beforeArchive,'rebuild keeps the sole active graph until replacement completes');
assert((await fs.readdir(dir)).includes('argument-rebuild-synthetic-v5.json'));
assert.equal((await prepareDocumentArgumentV5('synthetic-v5')).current, undefined, 'explicit rebuild starts with clean v5 progress');
const rebuildSnapshot=await prepareDocumentArgumentV5('synthetic-v5');
await assert.rejects(()=>runDocumentArgumentV5Batch(rebuildSnapshot,{...dependencies,call:async()=>{throw Error('new extraction failed');}}),/new extraction failed/);
assert.equal(await fs.readFile(path.join(dir,'argument-graph-v5-synthetic-v5.json'),'utf8'),beforeArchive,'a failed rebuild never deletes the previous active graph');
// Replacement is a complete snapshot, not an append: removed nodes and vectors disappear.
const replacement=structuredClone(latest.current!);
replacement.previousRevision=null;
replacement.nodes=replacement.nodes.filter(n=>n.id!=='N4');
replacement.relations=replacement.relations.filter(r=>r.from!=='N4'&&r.to!=='N4');
const originalSources=documentArgumentSourceBlocks(structured,'合成资料.md');
await saveDocumentArgumentV5(dir,{...snapshot2.current!,previousRevision:null},originalSources,planDocumentArgumentV5(originalSources,structured),snapshot2.current!.nodes.map(()=>vector()));
const replacementPreview=await readDocumentArgumentV5View('synthetic-v5');
assert(!replacementPreview.published&&replacementPreview.nodes.length===2,'view the new first batch, not the old four-node published graph');
assert.equal((await readSavedDocumentArgumentV5(dir,'synthetic-v5',chunks))?.nodes.length,4,'retrieval keeps the old active version until full replacement');
await archiveDocumentArgumentV5(dir,'synthetic-v5');
await saveDocumentArgumentV5(dir,replacement,originalSources,planDocumentArgumentV5(originalSources,structured),replacement.nodes.map(()=>vector()));
const replaced=await readSavedDocumentArgumentV5(dir,'synthetic-v5',chunks);
assert.deepEqual(replaced?.nodes.map(n=>n.id),['N1','N2','N3'],'new graph replaces all old nodes and their embeddings');
assert(!(await fs.readdir(dir)).some(name=>name.includes('.pending.')||name==='argument-rebuild-synthetic-v5.json'));
assert.equal((await readQaDocumentGraph(qaGraphAnchorsFromHits(hits))).nodes.length,0,'anchors from replaced revision cannot retrieve the old graph');
const newHits=await searchDocuments('成功次数',1,{mode:'argument'},{embed:async()=>vector()});
assert(newHits[0]?.documentGraphAnchors?.length);
assert(!(await readQaDocumentGraph(qaGraphAnchorsFromHits(newHits))).nodes.some(n=>n.text.includes('后续干预方法')));
await writeChunksFile('synthetic-v5',[{...chunks[0],id:'replacement-body',content:'全新正文',embedding:vector()}]);
const replacedBody=await readChunksFile('synthetic-v5');
assert.equal(replacedBody.length,1);assert.equal(replacedBody[0].id,'replacement-body');
assert.equal(replacedBody[0].content,'全新正文','body rebuild overwrites, never appends old chunks');
assert(await readSavedDocumentArgumentV5(dir,'synthetic-v5',replacedBody),'changing passage chunks alone must not invalidate a graph bound to unchanged original paragraphs');
await writeStructuredDocumentFile({...structured,normalizedText:structured.normalizedText.replace('实验甲','实验乙')});
assert.equal(await readSavedDocumentArgumentV5(dir,'synthetic-v5',replacedBody),null,'a real change to the preprocessed original must invalidate the graph');
await deleteDocumentSourceFiles('synthetic-v5');
await assert.rejects(() => fs.stat(path.join(dir, 'argument-graph-v5-synthetic-v5.json')), /ENOENT/);
await assert.rejects(() => fs.stat(path.join(dir, 'argument-rebuild-synthetic-v5.json')), /ENOENT/);
console.log('v5 production processing passed: paragraph batches → frozen joint extraction → inherited IDs → exact anchors → local embeddings → persistence/resume → bounded bridge → progress/delete.');
console.log('No cloud calls, no production writes.');
