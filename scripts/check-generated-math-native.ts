import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { compileElectron } from './build-electron.mjs';
import { prepareElectronRuntime } from './start-electron.mjs';
import { ProgressiveLearningStore } from '../src/electron/progressiveLearningStore';
import type { NoteItem } from '../src/types';

// Isolated production Electron app. Synthetic teaching/answers only, cloud blocked.
const { chromium } = createRequire(path.join(process.env.LOGINOTE_BROWSER_MODULES || process.env.LOGINOTE_PLAYWRIGHT_MODULES || path.join(os.homedir(), '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules'), 'progressive-phase1-check.cjs'))('playwright');
const root = await fs.mkdtemp(path.resolve('build/generated-math-native-'));
const appRoot=path.join(root,'app'), state=path.join(root,'state'), at=new Date().toISOString();
for (const dir of ['vault/notes','user-state']) await fs.mkdir(path.join(state,dir),{recursive:true});
await fs.mkdir(path.join(appRoot,'dist-electron'),{recursive:true});
const note=(id:string,title:string,extra:any={}):NoteItem=>({id,title,noteType:'project',projectRole:'learning',content:'',tags:[],links:[],backlinks:[],dueDates:[],createdAt:at,updatedAt:at,...extra});
const casesTex=String.raw`m(a)= \begin{cases} 0 & a<0 \\ -a^2 & 0\le a\le2 \\ 4-4a & a>2. \end{cases}`;
const parent=note('formula-root','公式兼容验收根项目');
const project=note('formula-project','公式兼容验收',{parentId:parent.id,content:"人工说明 f(x)=x^2。\n\n### 本项目需要掌握的知识点\n\n[[平均变化率]]：函数在区间上的平均变化率为 [f(x0+Δx)-f(x0)]/Δx。\n\n[[导数]]：若 lim(Δx→0)[f(x0+Δx)-f(x0)]/Δx 存在，则 f'(x0) 有定义。\n\n[[运算法则]]：(uv)'=u'v+uv'；(x^n)'=nx^{n-1}。\n\n"+`分段条件：因此 [ ${casesTex} ] 边界并入中间段时公式仍然一致。`+"\n\n### 手写补充\n这里的 x=0 保留为普通文本。",dueDates:[{id:'formula-deadline',noteId:'formula-project',noteTitle:'公式兼容验收',taskText:'公式兼容验收',dueDate:'2026-11-06',estimatedMinutes:30,priority:'medium',completed:false}]});
const knowledge=note('formula-knowledge','平均变化率',{noteType:'knowledge',projectRole:undefined,content:"## 导数\n\n**概念说明 **：f(x)=x^3-3x 的导数为 f'(x)=3x^2-3。"});
const layout=note('layout-project','知识点排版验收',{content:'### 本项目需要掌握的知识点\n\n'+[
 ['经验主义与联想主义','经验主义主张一切心理内容与知识最初来自感官经验，反对天赋观念。联想主义则说明简单感觉如何通过邻近、相似与因果等关系结合，形成复杂观念。学习时可以先比较两者分别回答的问题，再用一个日常记忆的例子解释联想如何发生。'],
 ['康德式先天综合与经验主义的分歧','康德不否认经验是知识的起点，但认为知识不能全部由经验说明。时间与空间是组织经验的先天形式，因果性等范畴使我们能够把感觉理解为一个有规律的世界。比较时要分清知识从何开始与知识如何可能这两个问题。'],
 ['浪漫主义对心理的挑战','浪漫主义反对把人看作被动接收印象的机器，强调情感、意志与个体历史。理解这一立场时，可把同一个人的生活经历、感受与行动放在一起考察，避免只用孤立的感觉元素说明完整的心理生活。'],
 ['联想主义的科学遗产','联想主义为学习研究提供了可检验的方向：经验影响心理内容，联系可以加强或减弱，变化可以通过实验观察。它的贡献也有边界，机械式的元素联结不足以解释所有思维活动。阅读后尝试区分哪些主张被实验心理学继承，哪些受到后来的整体论批评。'],
].map(([title,summary])=>`[[${title}]]：${summary}`).join('\n\n')});
const notes=[parent,project,knowledge,layout];
for(const n of notes)await fs.writeFile(path.join(state,'vault/notes',n.id+'.md'),n.content);
await fs.writeFile(path.join(state,'vault/metadata.json'),JSON.stringify({version:1,notesMeta:Object.fromEntries(notes.map(({content,...m})=>[m.id,m]))}));
await fs.writeFile(path.join(state,'user-state/user-state.json'),JSON.stringify({version:1,noteStates:{}}));
await fs.writeFile(path.join(state,'user-state/settings.json'),JSON.stringify({version:1,appSettings:{theme:'light',localOnly:true,autoAiSegment:false,cloudSyncEnabled:false,fontSize:16}}));
await fs.writeFile(path.join(state,'user-state/llm.json'),JSON.stringify({version:1,settings:{providers:[{id:'deepseek-default',name:'合成离线验收',apiType:'openai-compatible',baseUrl:'https://formula.invalid',apiKey:'',enabled:true,models:['fixture'],selectedModel:'fixture',createdAt:at}],defaultProviderId:'deepseek-default',workflowBinding:{'textbook-chapter':'deepseek-default'}}}));
const store=new ProgressiveLearningStore(path.join(state,'user-state'),{readTarget:async()=>({note:project,root:parent,isLeaf:true})});
const quote='左正右负（先增后减）→ 极大值';
const questions=[{id:'q1',kind:'judgment',prompt:"设 f(x)=x^3，f'(0)=0，所以 x=0 是极值点。对吗？",objective:'核对驻点',conceptKeys:[],focus:'concept',options:[{id:'A',text:"错误；f'(x)=3x^2 在两侧同号"},{id:'B',text:'正确；x=0'}],correctOptionId:'A',referenceAnswer:'错误',explanation:"f'(0)=0 不足以判断极值。"},
{id:'q2',kind:'application',prompt:"设 f(x)=x^3-3x。求 f'(x)=0 的点，用一阶导数判别法判断极值。",objective:'一阶导数判断',conceptKeys:[],focus:'calculation',referenceAnswer:'x=-1 为极大值点，x=1 为极小值点。',explanation:'检查导数两侧的符号',referenceQuote:'先求驻点，再判断导数在两侧的变号情况（概括，不是逐字原文）'}];
const initial:any=await store.command({op:'begin',projectNoteId:project.id,sourcePackets:[{id:'S1',kind:'document',title:'旧页参考教材.pdf',text:'# 版权信息\n\nISBN:1234567890\n出版社：合成出版社\n版权所有',locator:'synthetic-doc@old-version / 版权信息'}]},1);
let c:any=await store.command({op:'publish',lease:initial.lease,teaching:{sequence:1,plan:{title:'一阶导数',objectives:['核对驻点与极值'],pages:[{id:'main-1',title:'驻点与极值',objectives:['判断极值']}]},title:'驻点与极值',body:`# 一阶导数\n\n${quote}。左负右正为极小值。\n\nf(x)=x^3-3x，先求导，再检查各驻点两侧的符号。\n\n因此 [ ${casesTex} ] 边界并入中间段时公式仍然一致。\n\n**指令（instruction） **回答“要做什么”。\n\n**上下文（context） **回答“基于什么做”。\n\n**约束（constraint） **回答“必须满足什么”。\n\n**输出格式（output format） **回答“结果长什么样”。`,questions,concepts:[],hook:{id:'hook',kind:'reflection',prompt:'为什么驻点不一定是极值？'}} as any},1);
const saved:any=await store.command({op:'study',projectNoteId:project.id,request:{environmentId:c.environmentId,courseId:c.id,pageId:'main-1',expectedVersion:c.study.version,mutation:{kind:'draft',drafts:{q2:{text:"合成作答：f'(x)=3x-3，所以只有 x=1。"}}}}},1);
await store.command({op:'study',projectNoteId:project.id,request:{environmentId:c.environmentId,courseId:c.id,pageId:'main-1',expectedVersion:saved.study.version,mutation:{kind:'submit',submissionId:'pending-synthetic',questionIds:['q2']}}},1);
const originalPage=JSON.stringify(c.page); const originalHash=c.pages[0].contentHash;
store.releaseOwner(1);
await fs.writeFile(path.join(appRoot,'package.json'),JSON.stringify({name:'generated-math-check',version:'1.0.10'}));
for(const dir of ['dist','python','models'])await fs.symlink(path.resolve(dir),path.join(appRoot,dir),'junction');
for(const [name,bytes]of await compileElectron(process.cwd()))await fs.writeFile(path.join(appRoot,'dist-electron',name),bytes);
await fs.writeFile(path.join(root,'test-control-preload.cjs'),`require('electron').contextBridge.exposeInMainWorld('formulaTest',{close:()=>require('electron').ipcRenderer.invoke('save-test:command',{op:'close'})});`);
const bootstrap=path.join(root,'bootstrap.cjs');
await fs.writeFile(bootstrap,`globalThis.fetch=async()=>{throw Error('Cloud blocked for synthetic math acceptance');};
require('electron').app.on('browser-window-created',(_event,win)=>win.setSize(1680,1400));
const {ipcMain,utilityProcess}=require('electron'),{EventEmitter}=require('node:events'),fs=require('node:fs');
utilityProcess.fork=()=>{const w=new EventEmitter();w.postMessage=()=>{};w.kill=()=>{setImmediate(()=>w.emit('exit',0));return true;};return w;};
const register=ipcMain.handle.bind(ipcMain);ipcMain.handle=(channel,handler)=>register(channel,async(event,...args)=>{
 if(channel==='llm:request'){const input=JSON.parse(args[0].userInput);fs.appendFileSync(${JSON.stringify(path.join(root,'assessment.jsonl'))},JSON.stringify(input)+'\\n');return{content:JSON.stringify({results:input.tasks.map(t=>({attemptId:t.attemptId,referenceId:t.evidenceId||input.teaching[0].id,judgment:{outcome:'incorrect',errorKind:'calculation',explanation:"导数应为 $f'(x)=3x^2-3$。",referenceAnswer:'$x=-1$ 为极大值点，$x=1$ 为极小值点。'}}))})};}
 return handler(event,...args);
});require(${JSON.stringify(path.resolve('scripts/note-save-native-bootstrap.cjs'))});`);
const runtime=await prepareElectronRuntime(process.env.PROGRESSIVE_TEST_ELECTRON?{executable:process.env.PROGRESSIVE_TEST_ELECTRON}:{});
const env:NodeJS.ProcessEnv={...process.env,LOGINOTE_SAVE_NATIVE_ROOT:root,LOGINOTE_SAVE_NATIVE_PACKAGE:appRoot,SAVE_NATIVE_GPU:'1'};delete env.ELECTRON_RUN_AS_NODE;
const child=spawn(runtime,[bootstrap,'--remote-debugging-port=0'],{env,windowsHide:true,stdio:['ignore','pipe','pipe']});
let output='',browser:any,page:any; child.stderr.on('data',bytes=>output+=bytes);
const exited=new Promise(resolve=>child.once('exit',(code,signal)=>resolve({code,signal})));
const proof:any={root,network:'blocked',checks:[],errors:[]};
const sourceStage=async(stage:string)=>{(proof.sourceStages??=[]).push({stage,unchanged:(await fs.readFile(path.join(state,'vault/notes',project.id+'.md'),'utf8'))===project.content});};
const pause=(ms:number)=>new Promise(r=>setTimeout(r,ms));
try{
 let endpoint;for(let i=0;i<300&&!endpoint;i++){endpoint=output.match(/DevTools listening on (ws:\/\/[^\s]+)/u)?.[1];if(!endpoint)await pause(100);}
 assert.ok(endpoint,output);browser=await chromium.connectOverCDP(endpoint);page=browser.contexts()[0].pages()[0];page.setDefaultTimeout(15000);page.on('pageerror',(e:any)=>proof.errors.push(e.message));
 await page.getByRole('button',{name:'笔记',exact:true}).click({timeout:45000});
 const openNote=async(title:string)=>{await page.getByTitle(`打开「${title}」`,{exact:true}).click();await page.waitForFunction(title=>Array.from(document.querySelectorAll('input,textarea')).some((e:any)=>e.value===title),title);};
 await openNote(layout.title);
 const index=page.locator('.mdxeditor-content-editable');
 await index.locator('h4').nth(3).waitFor();
 const dimensions=await index.locator('h4').first().evaluate((h:HTMLElement)=>{const title=getComputedStyle(h),body=getComputedStyle(h.nextElementSibling!);return{background:title.backgroundColor,space:parseFloat(title.marginTop),lineHeight:parseFloat(body.lineHeight)/parseFloat(body.fontSize),descriptionWidth:h.nextElementSibling!.getBoundingClientRect().width,titleWidth:h.getBoundingClientRect().width};});
 assert.ok(dimensions.space>=20&&dimensions.lineHeight>=1.8);
 assert.ok(Math.abs(dimensions.descriptionWidth-dimensions.titleWidth)<=1,JSON.stringify(dimensions));proof.knowledgeLayout=dimensions;
 await index.screenshot({path:path.join(root,'knowledge-layout-light.png')});
 await page.evaluate(()=>document.documentElement.classList.add('dark'));
 assert.notEqual(await index.locator('h4').first().evaluate((h:HTMLElement)=>getComputedStyle(h).backgroundColor),dimensions.background);
 await index.screenshot({path:path.join(root,'knowledge-layout-dark.png')});
 await page.evaluate(()=>document.documentElement.classList.remove('dark'));
 await page.setViewportSize({width:980,height:900});
 assert.ok(await index.evaluate((e:HTMLElement)=>e.scrollWidth<=e.clientWidth+1));
 const narrow=await index.locator('h4').first().evaluate((h:HTMLElement)=>({descriptionWidth:h.nextElementSibling!.getBoundingClientRect().width,titleWidth:h.getBoundingClientRect().width}));
 assert.ok(Math.abs(narrow.descriptionWidth-narrow.titleWidth)<=1,JSON.stringify(narrow));
 assert.ok(narrow.descriptionWidth<dimensions.descriptionWidth,JSON.stringify({wide:dimensions,narrow}));proof.knowledgeLayoutNarrow=narrow;
 await index.screenshot({path:path.join(root,'knowledge-layout-narrow.png')});
 await page.setViewportSize({width:1440,height:1050});
 await openNote(parent.title);assert.equal(await fs.readFile(path.join(state,'vault/notes',layout.id+'.md'),'utf8'),layout.content);
 proof.checks.push('旧知识点索引独立标题、间距与行高；浅色/深色/窄屏适配；仅查看不改写原文');
 if(!process.argv.includes('--layout-only')){
 await openNote(project.title);
 await page.waitForFunction(()=>document.querySelectorAll('.mdxeditor .katex').length>=5);
 proof.projectFormulaCount=await page.locator('.mdxeditor .katex').count();
 const editorCases=await page.locator('.mdxeditor annotation[encoding="application/x-tex"]').allTextContents();
 assert.ok(editorCases.includes(casesTex),'actual rich-text import retains the exact three-row cases formula');
 proof.editorCasesRows=(editorCases.find((latex:string)=>latex===casesTex)!.match(/\\\\/gu)||[]).length;
 assert.equal(proof.editorCasesRows,2);
 assert.ok(await page.locator('.mdxeditor').innerText().then((s:string)=>s.includes('人工说明 f(x)=x^2')));
 await page.screenshot({path:path.join(root,'project-knowledge-formulas.png')});
 await sourceStage('project-open');
 await page.locator('.mdxeditor').getByRole('link',{name:knowledge.title,exact:true}).click();
 const preview=page.getByRole('dialog');await preview.locator('.katex').first().waitFor();assert.equal(await preview.locator('.katex').count(),2);
 assert.equal(await preview.locator('strong').filter({hasText:'概念说明'}).count(),1);
 await sourceStage('preview-open');
 await preview.getByRole('button',{name:'打开编辑',exact:true}).click();await page.waitForFunction(title=>Array.from(document.querySelectorAll('input,textarea')).some((e:any)=>e.value===title),knowledge.title);
 await page.locator('.mdxeditor:visible strong').filter({hasText:'概念说明'}).waitFor();
 assert.equal(await page.locator('.mdxeditor:visible .katex').count(),2);
 await sourceStage('knowledge-editor-open');
 proof.checks.push('已有项目知识点摘要与知识笔记公式可视化；未改写人工段落');
 await page.getByRole('button',{name:'学习',exact:true}).click();
 const card=page.locator('button.flow-project-card').filter({hasText:project.title});if(await card.count())await card.click();else await page.getByRole('button',{name:'进入心流',exact:true}).click();
 await page.getByRole('dialog').getByRole('button',{name:'出发，开始学习',exact:true}).click();
 await sourceStage('flow-enter');
 const toggle=page.locator('.focus-flow-analysis-control [role="switch"]');if(await toggle.getAttribute('aria-checked')==='true')await toggle.click();
 const quiz=page.locator('[data-progressive-quiz]'),q1=quiz.locator('[data-question-id="q1"]'),q2=quiz.locator('[data-question-id="q2"]');
 await q2.getByRole('button',{name:'重试判定',exact:true}).waitFor();
 const reader=page.locator('[data-progressive-course]');
 await reader.locator('.katex annotation[encoding="application/x-tex"]').filter({hasText:'\\begin{cases}'}).waitFor({state:'attached'});
 const readingCases=await reader.locator('.katex annotation[encoding="application/x-tex"]').allTextContents();
 assert.ok(readingCases.includes(casesTex),'actual progressive reader retains cases rows and conditions');
 proof.checks.push('同款裸方括号cases在编辑器和心流正文渲染为三行，原文和课程hash保持不变');
 await reader.locator('[data-teaching-provenance="unusable-excerpts"]').waitFor();
 await reader.locator('.progressive-course-provenance summary').click();
 assert.ok((await reader.locator('.progressive-course-provenance').innerText()).includes('不能用于核实教材内容'));
 for(const label of ['指令（instruction）','上下文（context）','约束（constraint）','输出格式（output format）'])assert.equal(await reader.locator('strong').filter({hasText:label}).count(),1);
 proof.checks.push('截图中四种标签已加粗，知识点预览和编辑同步兼容；概括或缺少引文的题目成功发布');
 assert.ok(await q1.locator('.progressive-question-prompt .katex').count()>=3);assert.ok(await q1.locator('fieldset .katex').count()>=1);assert.ok(await q2.locator('.progressive-question-prompt .katex').count()>=2);
 await q2.getByRole('button',{name:'重试判定',exact:true}).click();await q2.getByRole('status').filter({hasText:'需要再核对'}).waitFor();
 assert.equal(await q2.getByRole('textbox',{name:'你的回答',exact:true}).inputValue(),"合成作答：f'(x)=3x-3，所以只有 x=1。");
 await q2.getByText('查看解析与参考答案',{exact:true}).click();assert.ok(await q2.locator('.progressive-answer-explanation .katex').count()>=3);
 assert.equal(await quiz.locator('[role="alert"]').count(),0);await page.screenshot({path:path.join(root,'quiz-formulas-and-retry.png')});
 await q1.locator('input[value="A"]').check();await q1.getByRole('button',{name:'提交答案',exact:true}).click();await q1.getByRole('status').filter({hasText:'回答正确'}).waitFor();
 proof.checks.push('题干、选项、解析公式已渲染；重试引用编号成功且原作答不变');
 await page.getByRole('button',{name:'退出并保存',exact:true}).click();await page.locator('.flow-mode-container').waitFor({state:'detached'});
 await sourceStage('flow-exit');
 await page.getByRole('button',{name:'笔记',exact:true}).click();await openNote(project.title);
 await page.getByRole('button',{name:'撤销完成',exact:true}).waitFor();
 c=await store.command({op:'load',projectNoteId:project.id},2);assert.equal(c.completion.status,'committed');assert.equal(c.lastSuccessfulReview,undefined);assert.equal(c.pages[0].contentHash,originalHash);assert.equal(JSON.stringify(c.page),originalPage);assert.equal(c.study.attempts.length,2);
 assert.equal(await fs.readFile(path.join(state,'vault/notes',project.id+'.md'),'utf8'),project.content);assert.equal(await fs.readFile(path.join(state,'vault/notes',knowledge.id+'.md'),'utf8'),knowledge.content);
 const attempt=c.study.attempts.find((a:any)=>a.questionId==='q2');assert.ok(c.page.body.includes(attempt.judgment.referenceQuote));assert.equal(c.study.attempts.find((a:any)=>a.questionId==='q1').judgment.referenceQuote,undefined);
 proof.checks.push('全题已提交、没有复盘仍自动完成；课程版本/原题/教材哈希/原笔记均未被显示兼容修改');
 const editor=page.locator('.mdxeditor-content-editable[contenteditable="true"]');
 await editor.click();await editor.press('Control+End');await page.keyboard.type('EDIT_UNDO_SENTINEL');
 await page.waitForFunction(()=>document.querySelector('.mdxeditor-content-editable')?.textContent?.includes('EDIT_UNDO_SENTINEL'));
 await editor.press('Control+z');await page.waitForFunction(()=>!document.querySelector('.mdxeditor-content-editable')?.textContent?.includes('EDIT_UNDO_SENTINEL'));
 await openNote(parent.title);assert.ok(!(await fs.readFile(path.join(state,'vault/notes',project.id+'.md'),'utf8')).includes('EDIT_UNDO_SENTINEL'));
 proof.checks.push('仅焦点变更不保存；真正编辑与撤销仍同步到保存草稿，不吞首个输入或撤销');
 }
 assert.deepEqual(proof.errors,[]);await page.evaluate(()=>(window as any).formulaTest.close());
 let timeout:any;const receipt:any=await Promise.race([exited,new Promise(r=>timeout=setTimeout(()=>r({timeout:true}),20000))]);clearTimeout(timeout);assert.equal(receipt.code,0,output);proof.nativeExit=receipt.code;proof.status='passed';
}catch(error:any){proof.status='failed';proof.error=error.stack||String(error);if(page){await fs.writeFile(path.join(root,'failure-text.txt'),await page.locator('body').innerText().catch(()=>''));await page.screenshot({path:path.join(root,'failure.png')}).catch(()=>{});}process.exitCode=1;}
finally{if(child.exitCode===null)child.kill();await browser?.close().catch(()=>{});await fs.writeFile(path.join(root,'result.json'),JSON.stringify(proof,null,2));console.log(JSON.stringify(proof,null,2));}
