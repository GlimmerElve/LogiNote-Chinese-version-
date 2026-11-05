import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { setDataRoot, setModelsDir, writeManifest, readManifest } from '../src/electron/ragIndex';
import { prepareMaterial } from '../src/electron/materialStore';
import { getMaterialCatalog, readMaterialPage } from '../src/electron/materialReader';
import { searchMaterialText } from '../src/electron/materialSearch';
import { loadProgressiveMaterials, mergeProgressiveMaterials } from '../src/services/progressiveLearning/materials';
import { progressiveProvenance, isMaterialFrontMatter } from '../src/services/progressiveLearning/sourcePolicy';
import { progressiveGenerationRequest } from '../src/services/progressiveLearning/generation';
import type { NoteItem, UploadedDocument } from '../src/types';
import type { ProgressiveCourse } from '../src/services/progressiveLearning/types';

globalThis.fetch=async()=>assert.fail('material retrieval is offline: no model or external search');
const root=await fs.mkdtemp(path.resolve('build/progressive-materials-'));
setDataRoot(root);setModelsDir(path.join(root,'no-models-installed'));
await fs.mkdir(path.join(root,'documents'),{recursive:true});
const entry=(id:string):UploadedDocument=>({id,fileName:id+'.md',extension:'.md',fileType:'md',indexable:true,status:'pending',parseStatus:'pending',uploadAt:new Date().toISOString(),chunkCount:0,totalChars:0,size:1});
const original='# 版权信息\n\n荷马研究测试版。ISBN:1234567890。出版社：测试。版权所有。\n\n'+Array.from({length:150},(_,i)=>`# 普通章节 ${i}\n\n这段说明用于保留完整目录的位置，没有当前课题的证据。`).join('\n\n')
  +'\n\n# 第三编\n\n'+'这是一段需要越过的普通背景。'.repeat(1400)+'荷马用身体部位词表达心理活动，斯内尔据此讨论统一灵魂；这是一项解释，仍需要核对反例与替代解释。'
  +'\n\n# 荷马的身体词汇与反例\n\n身体词汇的多样性并不直接证明没有统一的自我，语言表达与心理经验之间还需要独立证据。'.repeat(12)
  +'\n\n# 荷马词汇演示代码\n\n```python\n# 荷马身体词汇的合成分类示例\ndef classify_homer_word(word):\n    return "身体" if word == "胸膛" else "其他"\n```'
  +'\n\n# 函数资料\n\n函数要求每个允许输入有唯一输出。定义域表示允许的输入范围。';
await writeManifest([entry('doc-lesson'),entry('doc-outside')]);
await fs.writeFile(path.join(root,'documents/doc-lesson.md'),original);
await prepareMaterial({allowedDocIds:['doc-lesson']},'doc-lesson');
const version=(await getMaterialCatalog({allowedDocIds:['doc-lesson'],docId:'doc-lesson',limit:1})).document.version!;
const note:NoteItem={id:'leaf',title:'荷马时代的心灵观与斯内尔的发现之争',noteType:'project',projectRole:'learning',content:'PRIVATE_NOTE_BODY',tags:[],links:[],backlinks:[],dueDates:[],createdAt:'a',updatedAt:'a',resources:[{title:'心理学史教材',kind:'local',documentId:'doc-lesson',url:'loginote-document://doc-lesson'}]};
const outside={...note,id:'other-root',resources:[{title:'别的根项目资料',kind:'local' as const,documentId:'doc-outside',url:'loginote-document://doc-outside'}]};
const focus='荷马的身体词汇：没有统一灵魂的人，说明斯内尔的论证与反例';
let ticks=0;const timer=setInterval(()=>ticks++,1);
const searched=await searchMaterialText({allowedDocIds:['doc-lesson'],docId:'doc-lesson',query:focus,subject:note.title,limit:12});clearInterval(timer);
assert.ok(ticks>0,'host yields during full-source search');
assert.ok(searched.hits.length);assert.ok(searched.hits.every(h=>!isMaterialFrontMatter(h.sectionPath)));
assert.ok(searched.hits.some(h=>h.sectionPath==='第三编'&&h.matchStart!>h.textStart+12000),'body matches deep in a large untitled paragraph must be located');
const actionTitle=await searchMaterialText({allowedDocIds:['doc-lesson'],docId:'doc-lesson',query:'识别输入和输出',topic:'识别输入和输出',subject:'识别输入和输出'});
assert.ok(actionTitle.hits.some(hit=>hit.sectionPath==='函数资料'),'an instructional verb must not replace the actual page topic');
const calls:any[]=[];
const reader={search:async(req:any)=>{calls.push(req);assert.deepEqual(req.allowedDocIds,['doc-lesson']);return searchMaterialText(req);},page:readMaterialPage,catalog:getMaterialCatalog,web:async()=>[]};
const packets=await loadProgressiveMaterials(note,[note,outside],focus,undefined,reader);
assert.ok(packets.length>0);assert.ok(packets.some(p=>p.text.includes('荷马用身体部位词')));
assert.ok(packets.some(p=>p.locator?.includes('身体词汇与反例')));
assert.ok(packets.some(p=>p.text.includes('```python')),'relevant original code examples remain available');
assert.ok(packets.every(p=>!p.text.includes('ISBN')&&!p.locator?.includes('版权信息')));
assert.ok(packets.reduce((n,p)=>n+p.text.length,0)<=12000);
assert.ok(!JSON.stringify(calls).includes('PRIVATE_NOTE_BODY'));assert.ok(!JSON.stringify(calls).includes('doc-outside'));
assert.equal((await readManifest()).find(d=>d.id==='doc-lesson')!.status,'pending','no vector/index completion is required or started');
await assert.rejects(searchMaterialText({allowedDocIds:[],docId:'doc-lesson',query:focus}));
await assert.rejects(searchMaterialText({allowedDocIds:['doc-lesson'],docId:'doc-outside',query:focus}));
await assert.rejects(searchMaterialText({allowedDocIds:['doc-lesson'],docId:'doc-lesson',query:focus,version:'0'.repeat(64)}));
const fallback=await loadProgressiveMaterials(note,[note],focus,undefined,{...reader,search:async()=>{throw Error('older bridge');}});
assert.ok(fallback.some(p=>p.locator?.includes('荷马的身体词汇')),'catalog fallback must paginate past entry 100');
const stale=await loadProgressiveMaterials(note,[note],focus,undefined,{...reader,page:async req=>({...await readMaterialPage(req),version:'0'.repeat(64)})});
assert.equal(stale.length,0,'stale reads never enter context');
const abort=new AbortController();abort.abort();await assert.rejects(loadProgressiveMaterials(note,[note],focus,abort.signal,reader));
const copyright={id:'S1',kind:'document' as const,title:'教材.pdf',text:'# 版权信息\nISBN:1234567890\n出版社：测试',locator:'doc@v / 版权信息'};
assert.deepEqual(progressiveProvenance([copyright],'教材[S1]。').sources,[]);assert.equal(progressiveProvenance([copyright],'教材[S1]。').invalidMarkers,1);
const course={title:note.title,sourcePackets:[copyright,...packets.map((p,i)=>({...p,id:'S'+(i+2)}))],pages:[],plan:null,budget:{maxMainlinePages:4},generation:{pageId:'main-1',mainlineIndex:0,previousTeaching:{title:'上页',excerpt:'上页的论点[S1]，旧编号不能当新页证据。'}}} as unknown as ProgressiveCourse;
const input=JSON.parse(progressiveGenerationRequest(course).userInput);
assert.ok(!input.sourceExcerpts.some(s=>s.text.includes('ISBN')));assert.ok(!input.previousTeaching.excerpt.includes('[S1]'));
assert.equal(course.generation.previousTeaching!.excerpt,'上页的论点[S1]，旧编号不能当新页证据。');
const combined=mergeProgressiveMaterials(packets,[{...packets[0],id:'S1',text:'补充薄弱点材料'.repeat(500)}]);
assert.ok(combined.some(s=>s.text.includes('补充薄弱点')));assert.equal(new Set(combined.map(p=>p.id)).size,combined.length);assert.ok(combined.reduce((n,p)=>n+p.text.length,0)<=12000);
const proof:any={root,status:'passed',synthetic:{sections:searched.document.blockCount,hits:searched.hits.length,packets:packets.length,characters:packets.reduce((n,p)=>n+p.text.length,0),yieldTicks:ticks},network:'blocked'};
if(process.argv.includes('--real-book')){
  // Only the user-referenced uploaded book is copied. Never copy the vault,
  // model settings, restatements, answers, or change the original library.
  const config=JSON.parse(await fs.readFile(path.join(os.homedir(), '.logi-note', 'storage-config.json'),'utf8'));
  const docId=process.env.LOGINOTE_TEST_DOCUMENT_ID;assert.ok(docId,'--real-book requires LOGINOTE_TEST_DOCUMENT_ID for the explicitly authorized fixture document');const manifest=JSON.parse(await fs.readFile(path.join(config.dataRoot,'rag-index/manifest.json'),'utf8'));
  const doc=(Array.isArray(manifest)?manifest:manifest.documents).find((d:any)=>d.id===docId);assert.ok(doc);
  const fixture=path.join(root,'book-copy');await fs.mkdir(path.join(fixture,'documents'),{recursive:true});await fs.mkdir(path.join(fixture,'rag-index'),{recursive:true});
  const file=path.join(config.dataRoot,'documents',docId+doc.extension),structured=path.join(config.dataRoot,'rag-index','structured-'+docId+'.json');
  const hash=async(f:string)=>createHash('sha256').update(await fs.readFile(f)).digest('hex');
  const before=[await hash(file),await hash(structured)];
  await fs.copyFile(file,path.join(fixture,'documents',docId+doc.extension));await fs.copyFile(structured,path.join(fixture,'rag-index','structured-'+docId+'.json'));
  setDataRoot(fixture);await writeManifest([{...doc,status:'pending'}]);
  const realNote={...note,resources:[{...note.resources![0],documentId:docId,url:'loginote-document://'+docId}]};
  const real=await loadProgressiveMaterials(realNote,[realNote],focus,undefined,{search:searchMaterialText,page:readMaterialPage,catalog:getMaterialCatalog,web:async()=>[]});
  assert.ok(real.length>0);assert.ok(real.some(s=>/荷马/u.test(s.text)));assert.ok(real.every(s=>!s.locator?.includes('版权信息')&&!s.locator?.includes('发展心理学组织')),'same-surname discussion outside the Homer topic is not useful evidence');
  assert.deepEqual([await hash(file),await hash(structured)],before,'real book and parsed original remain byte-identical');
  proof.realBook={packets:real.length,characters:real.reduce((n,p)=>n+p.text.length,0),locations:real.map(p=>p.locator?.split(' / ').slice(1).join(' / ')),originalUnchanged:true};
}
await fs.writeFile(path.join(root,'result.json'),JSON.stringify(proof,null,2));console.log(JSON.stringify(proof,null,2));
