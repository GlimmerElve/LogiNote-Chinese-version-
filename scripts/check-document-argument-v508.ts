import assert from 'node:assert/strict';
import {DOCUMENT_ARGUMENT_V5_PROMPT,DOCUMENT_ARGUMENT_V5_BATCH_TEXT_PROMPT,DOCUMENT_ARGUMENT_V5_BRIDGE_PROMPT} from '../src/workflows/documentArgumentV5Prompt';
import {DOCUMENT_ARGUMENT_V5_PROMPT_HASH,DOCUMENT_ARGUMENT_V5_LEGACY_PROMPT_HASH,DOCUMENT_ARGUMENT_V5_LEGACY_BATCH_PROMPT_HASH} from '../src/electron/rag/documentArgumentV5Store';
import {validateDocumentArgumentV5Graph,parseDocumentArgumentV5Batch} from '../src/services/documentArgumentV5Protocol';
import type {DocumentArgumentGraph} from '../src/services/documentArgumentV5Types';

assert.equal(DOCUMENT_ARGUMENT_V5_PROMPT,DOCUMENT_ARGUMENT_V5_BATCH_TEXT_PROMPT);
assert(DOCUMENT_ARGUMENT_V5_PROMPT.startsWith('# 原文论证抽取器 v5.0.8'));
assert(!DOCUMENT_ARGUMENT_V5_PROMPT.includes('## 本版说明')&&!DOCUMENT_ARGUMENT_V5_PROMPT.includes('v5.0.7'));
assert(DOCUMENT_ARGUMENT_V5_PROMPT.trimEnd().endsWith('禁止输出代码块外任何文字。'));
assert.equal(DOCUMENT_ARGUMENT_V5_PROMPT_HASH,'3da9d9aa05ae1baf356492ebb0b8707730666a0f807727f73e0a44e6e7f0f940');
assert.equal(DOCUMENT_ARGUMENT_V5_LEGACY_PROMPT_HASH,'2f4fd22e4b3002b39bf16507f1b351ed0a1358d5ac64a785cfb25d64f33d29c8');
assert.equal(DOCUMENT_ARGUMENT_V5_LEGACY_BATCH_PROMPT_HASH,'ce6d6b10bbb0ea0ee5db3b752658e7d10c4ad822340d73a4e02c2ce472b00822');
assert(DOCUMENT_ARGUMENT_V5_BRIDGE_PROMPT.includes('context.from=background/premise')&&DOCUMENT_ARGUMENT_V5_BRIDGE_PROMPT.includes('直接产生结果的background'));

const graph:DocumentArgumentGraph={nodes:[
  {id:'N1',role:'background',batch:1,source:[],fallbackText:'情景甲使用问卷测量回答比例。'},
  {id:'N2',role:'premise',batch:1,source:[],fallbackText:'测得回答是的比例为30%。'},
  {id:'N3',role:'background',batch:1,source:[],fallbackText:'上述观察说明此处统计指标的含义。'},
],arguments:[],relations:[],unresolved:[]};
const edge={id:'R1',kind:'method_for' as const,from:'N1',to:'N2',reason:'情景直接产生回答比例'};
assert.throws(()=>validateDocumentArgumentV5Graph({...graph,relations:[edge]}),/method_for/,'legacy rules remain strict');
validateDocumentArgumentV5Graph({...graph,relations:[{...edge,policy:'v5.0.8'}]});
validateDocumentArgumentV5Graph({...graph,relations:[{id:'R2',kind:'context',from:'N2',to:'N3',reason:'观察解释概念',policy:'v5.0.8'}]});
const anchored={...graph,nodes:graph.nodes.map(({fallbackText:_f,...node},index)=>({...node,source:[{chunkId:'C1',start:index*10,end:index*10+5}]}))};
assert.throws(()=>validateDocumentArgumentV5Graph({...anchored,relations:[{id:'R2',kind:'context',from:'N3',to:'N1',reason:'向前解释',policy:'v5.0.8'}]}),/前文指向后文/);
validateDocumentArgumentV5Graph({...graph,relations:[{id:'R2',kind:'context',from:'N3',to:'N1',reason:'未定位块由语义判断先后，不猜位置',policy:'v5.0.8'}]});
// Existing backward legacy context is not rewritten or invalidated by new forward edges.
validateDocumentArgumentV5Graph({...graph,relations:[{id:'OLD',kind:'context',from:'N3',to:'N1',reason:'旧版概念说明'}, {...edge,policy:'v5.0.8'}]});
assert.throws(()=>validateDocumentArgumentV5Graph({...graph,relations:[{...edge,from:'N2',to:'N3',policy:'v5.0.8'}]}),/method_for/);
assert.throws(()=>validateDocumentArgumentV5Graph({...graph,nodes:graph.nodes.map(n=>n.id==='N1'?{...n,role:'method'}:n),relations:[
  {id:'R2',kind:'context',from:'N1',to:'N3',reason:'方法不能发出context',policy:'v5.0.8'}]}),/context 来源/);

const prior={...graph,nodes:graph.nodes.slice(0,1)},body=graph.nodes[1].fallbackText!;
const windows=[{id:'batch-text',section:'',text:body,parts:[{chunkId:'C1',start:0,end:body.length}]}];
const inherited={next_node_id:'N2',nodes:[{id:'N1',role:'background' as const,text:graph.nodes[0].fallbackText!}],edges:[]};
const raw=JSON.stringify({nodes:[{id:'N2',role:'premise',source:[{quote:body}]}],arguments:[],relations:[edge],unresolved:[]});
const fresh=parseDocumentArgumentV5Batch(raw,windows,prior,inherited,2,'batch-text',true,'v5.0.8');
assert.equal(fresh.pendingEdges?.length||0,0,'background method_for allowed by v5.0.8 must not be quarantined');
assert.equal(fresh.relations[0].policy,'v5.0.8');assert.equal(prior.nodes[0].role,'background');assert(!fresh.roleRevisions);
assert.throws(()=>parseDocumentArgumentV5Batch(raw,windows,prior,inherited,2,'batch-text'),/method_for/);
console.log('v5.0.8 migration passed: exact active prompt hash, no version commentary, frozen legacy hashes, version-stamped relation rules, no forced role changes, old/new edge coexistence.');
console.log('No cloud calls or production writes.');
