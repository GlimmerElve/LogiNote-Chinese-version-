/** Reproducible acceptance runner. Offline by default; live requests are opt-in. */
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { classifyTeachableAcceptance } from './teachable-acceptance-status.mjs';
import { writeTeachingReview } from './teachable-acceptance-review.mjs';

const args = process.argv.slice(2), desktop = args.includes('--desktop'), live = args.includes('--live');
if (args.some(arg => !['--desktop','--live'].includes(arg))) throw Error('支持的参数：--desktop、--live');
const fixture = await readFile('scripts/fixtures/teachable-acceptance-cases.json','utf8'), cases = JSON.parse(fixture);
await mkdir('build/teachable-suite', {recursive:true});
const root = await mkdtemp(path.resolve('build/teachable-suite/run-'));
const report = { schema:1, startedAt:new Date().toISOString(), source:'synthetic only', fixtureSha256:createHash('sha256').update(fixture).digest('hex'), desktop, live,
  cases:cases.cases.map(({id,discipline,checks})=>({id,discipline,checks,teachingReview:'not-reviewed',visualReview:'not-reviewed'})), checks:[], liveResults:[],
  scope:'自动通过不代表已验证教学效果、领域真实性、所有设备或所有交互类型。' };

async function run(name, argv, timeoutMs=180000) {
  process.stdout.write(`\n[${name}]\n`);
  const child=spawn(process.execPath,argv,{cwd:process.cwd(),env:process.env,windowsHide:true,stdio:['ignore','pipe','pipe']});
  let stdout='',stderr='',timedOut=false;
  child.stdout.on('data',data=>{const text=String(data);stdout+=text;process.stdout.write(text)});
  child.stderr.on('data',data=>{const text=String(data);stderr+=text;process.stderr.write(text)});
  const timer=setTimeout(()=>{timedOut=true;child.kill()},timeoutMs);
  const outcome=await new Promise(resolve=>{child.once('error',error=>resolve({error:error.name}));child.once('exit',(code,signal)=>resolve({code,signal}))});
  clearTimeout(timer);
  const ok=!timedOut && outcome.code===0;
  report.checks.push({name,status:ok?'passed':'failed',...(timedOut?{reason:'timeout'}:{}),...(!ok&&outcome.error?{reason:outcome.error}:{})});
  return {ok,stdout,stderr};
}
const offline=[
  ['案例选型与确定性结果','scripts/check-teachable-acceptance-cases.ts'],
  ['函数、定义域与预测','scripts/check-interactive-function-figure.ts'],
  ['数学显示故障回归','scripts/check-math-display-regressions.ts'],
  ['概率与样本','scripts/check-interactive-probability-figure.ts'],
  ['分类阈值','scripts/check-interactive-threshold-figure.ts'],
  ['齿轮','scripts/check-interactive-gear-figure.ts'],
  ['缓存','scripts/check-interactive-lru-figure.ts'],
  ['教学机制按需加载','scripts/check-teachable-mechanism-coverage.ts'],
  ['生成与恢复','scripts/check-interactive-figure-pipeline.ts'],
  ['局部修复','scripts/check-interactive-figure-repair.ts'],
  ['修复记录及附件恢复','scripts/check-interactive-figure-store.ts'],
  ['Markdown 分享','scripts/check-interactive-figure-share.ts'],
  ['阅读位置与后台图示','scripts/check-textbook-reading-performance.ts'],
];
await run('验收状态判定',['scripts/check-teachable-acceptance-status.mjs']);
await run('人工评审表',['scripts/check-teachable-acceptance-review.mjs']);
for(const [name,file] of offline) await run(name,['scripts/run-tsx-safe.cjs',file]);
if(desktop){
  const built=await run('构建当前前端',['scripts/build-vite.mjs']);
  if(built.ok){
    await run('隔离交互图、主题与局部检查',['scripts/check-interactive-figure-native.mjs']);
    await run('笔记及心流阅读、离线分享',['--experimental-strip-types','scripts/check-note-reading-native.mjs']);
    await run('渐进教材、保存与右侧重开',['--experimental-strip-types','scripts/check-progressive-phase3-native.mjs']);
  } else report.checks.push({name:'桌面验收',status:'skipped',reason:'frontend build failed'});
}
if(live){
  // Each invocation sends only the hard-coded synthetic case and makes one request.
  const mapping={math:'math-symmetry',limit:'math-limit',threshold:'threshold',physics:'gear-external',computing:'lru',coin:'coin-frequency',chemistry:'chemistry-electrolysis',motion:'spring',psychology:'psychology'};
  for(const [scenario,caseId] of Object.entries(mapping)){
    const result=await run(`真实模型合成案例 ${scenario}`,['scripts/run-tsx-safe.cjs','scripts/check-interactive-figure-model-live.ts','--execute',`--case=${scenario}`]);
    let output;
    for(const line of result.stdout.split(/\r?\n/u)) try {const value=JSON.parse(line);if(value.passed===true)output=value;} catch {}
    const entry={scenario,caseId,status:result.ok&&output?'generated':'failed',...(output?{model:output.model,usage:output.usage,output:output.output}:{}),
      teachingReview:'not-reviewed',visualReview:'not-reviewed'};
    if(output && desktop && report.checks.some(item=>item.name==='构建当前前端' && item.status==='passed')){
      const folder=path.dirname(output.output), relative=path.relative(path.resolve('build/teachable-acceptance'),folder);
      if(relative.startsWith('..')||path.isAbsolute(relative))throw Error('unexpected synthetic artifact path');
      const inspection=await run(`隔离检查合成结果 ${scenario}`,['scripts/check-teachable-live-artifact-native.mjs',folder]);
      let summary; for(const line of inspection.stdout.split(/\r?\n/u))try{const value=JSON.parse(line);if(value.preflight)summary=value}catch{}
      entry.runtime=inspection.ok&&summary?summary:{preflight:'failed'};
      if(inspection.ok)entry.safePreview=path.join(folder,'figure-portable.html');
    }
    report.liveResults.push(entry);
  }
}
report.finishedAt=new Date().toISOString();
report.status=classifyTeachableAcceptance(report);
const file=path.join(root,'report.json'); await writeFile(file,JSON.stringify(report,null,2),'utf8');
const review=await writeTeachingReview(file);
console.log(`\n验收报告：${file}\n人工评审表：${review}\n自动检查：${report.status}。案例的教学、视觉和真实学习效果须单独验收。`);
if(report.status!=='passed')process.exitCode=1;
