import assert from 'node:assert/strict';
import {promises as fs} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {setDataRoot, CURRENT_INDEX_SCHEMA_VERSION} from '../src/electron/ragIndex';
import {readQaDocumentGraph} from '../src/electron/rag/qaDocumentGraphReader';

// Synthetic filesystem only. No real user index, embedding runtime or provider is configured.
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'qa-graph-reader-'));
setDataRoot(root);
await assert.rejects(() => readQaDocumentGraph([{docId:'../bad',nodeId:'N1'}]), /invalid_anchor/);
assert.deepEqual(await fs.readdir(root), [], '非法请求不能触发文件创建');
assert.equal((await readQaDocumentGraph([{docId:'doc1',nodeId:'N1'}])).nodes.length, 0);
assert.deepEqual(await fs.readdir(root), [], '未启用索引的只读请求不能创建目录');
const index = path.join(root,'rag-index');
await fs.mkdir(index);
const text = '合成实验观察到结果甲。';
const chunk = {id:'c1',docId:'doc1',fileName:'synthetic.md',index:0,sectionPath:'实验',content:text,embedding:[],
  textStart:0,sentenceSpans:[{id:'S1',textStart:0,textEnd:text.length}]};
const unit = {id:'N1',docId:'doc1',chunkId:'c1',sentenceIds:['S1'],mainType:'事实陈述',layer:'judgment',
  textStart:0,textEnd:text.length,text,mentionedEntityIds:[],confidence:.9,origin:'imported-document-extraction',admission:'admitted'};
const shard = {schemaVersion:1,docId:'doc1',status:'ready',committedChunkIds:['c1'],argumentUnits:[unit],argumentEdges:[]};
const save = (name:string,data:unknown)=>fs.writeFile(path.join(index,name),JSON.stringify(data),'utf8');
await save('knowledge-settings.json',{enabled:true});
const doc = {id:'doc1',fileName:'synthetic.md',status:'ready',indexSchemaVersion:CURRENT_INDEX_SCHEMA_VERSION};
await save('manifest.json',[doc]);
await save('chunks-doc1.json',[chunk]);
await save('knowledge-doc1.json',shard);
const before = await Promise.all((await fs.readdir(index)).sort().map(async name => [name, await fs.readFile(path.join(index,name),'utf8')]));
const result = await readQaDocumentGraph([{docId:'doc1',nodeId:'N1'}]);
assert.equal(result.nodes.length, 1);
assert.equal(result.nodes[0].quote,text);
const after = await Promise.all((await fs.readdir(index)).sort().map(async name => [name, await fs.readFile(path.join(index,name),'utf8')]));
assert.deepEqual(after,before,'读取不能改写任何索引文件');
await save('knowledge-doc1.json',{...shard,committedChunkIds:[]});
assert.equal((await readQaDocumentGraph([{docId:'doc1',nodeId:'N1'}])).nodes.length,0,'未提交节点不能混入');
await save('knowledge-doc1.json',shard);
await save('chunks-doc1.json',[{...chunk,content:'合成正文已更新。'}]);
assert.equal((await readQaDocumentGraph([{docId:'doc1',nodeId:'N1'}])).nodes.length,0,'陈旧来源不能恢复节点');
await save('chunks-doc1.json',[chunk]);
await save('manifest.json',[{...doc,indexSchemaVersion:0}]);
assert.equal((await readQaDocumentGraph([{docId:'doc1',nodeId:'N1'}])).nodes.length,0,'待重索引资料不能被当作可用图');
await save('manifest.json',[doc]);
await save('knowledge-settings.json',{enabled:false});
assert.equal((await readQaDocumentGraph([{docId:'doc1',nodeId:'N1'}])).nodes.length,1,'暂停抽取不影响读取有效旧图');
console.log('QA graph backend: extraction pause still allows read-only retrieval; missing/stale/uncommitted guards and unchanged files passed; cloud calls=0.');
