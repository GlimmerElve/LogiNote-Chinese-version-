import type { H5pProgress } from './h5pStore';
import type { H5pAppearance } from './h5pAppearance';

// Host-owned, deliberately narrow adaptation for standalone True/False. Keep
// full-bleed media and every other (including nested) content type untouched.
// H5P.Question's no-frame rule removes horizontal margins with !important.
export const H5P_CONTENT_LAYOUT_CSS = `
.h5p-content.h5p-no-frame > .h5p-question.h5p-true-false > :is(.h5p-question-introduction, .h5p-question-content, .h5p-question-buttons, .h5p-question-feedback:not(.h5p-question-popup)) {
  margin-left: clamp(16px, 2vw, 24px) !important;
  margin-right: clamp(16px, 2vw, 24px) !important;
}
.h5p-content.h5p-no-frame > .h5p-question.h5p-true-false > .h5p-question-buttons.wrap {
  width: auto;
}
`;

export const H5P_PLAYER_HTML = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="stylesheet" href="theme.css"><link rel="stylesheet" href="player/styles/h5p.css"><title>H5P 本地场景 · LogiNote</title>
<style>html.dark button{color:var(--ln-bg-app,#171c18)}button:disabled{opacity:.5;cursor:not-allowed}</style>
<style>html{color-scheme:light}html.dark{color-scheme:dark}body{margin:0;padding:clamp(16px,3vw,32px);background:var(--ln-bg-app,#fbf8f1);color:var(--ln-text-primary,#17221b);font:14px/1.6 var(--ln-font-body,system-ui)}header{display:flex;align-items:center;flex-wrap:wrap;gap:12px;padding-bottom:20px}header strong{font:700 22px var(--ln-font-display,serif)}#status{flex:1;min-width:160px;color:var(--ln-text-secondary,#536259);font-size:12px}button{min-height:40px;border:1px solid var(--ln-border,#dedfd7);border-radius:var(--ln-radius-md,12px);padding:8px 16px;cursor:pointer;font:inherit;color:var(--ln-text-on-accent,#fff);background:var(--ln-accent,#2f5743)}button:hover{background:var(--ln-accent-hover,#274838)}button:focus-visible,summary:focus-visible{outline:3px solid var(--ln-focus-ring,#a2b9a8);outline-offset:3px}#player{min-height:220px;overflow:hidden;border:1px solid var(--ln-border,#dedfd7);border-radius:var(--ln-radius-lg,16px);background:#fff;box-shadow:var(--ln-shadow-soft)}details{margin-top:16px;color:var(--ln-text-secondary,#536259);font-size:12px}summary{cursor:pointer;width:fit-content;padding:6px 0}#detail{white-space:pre-wrap;max-width:72em}a{color:var(--ln-accent)}</style>
</head><body><header><strong>互动场景</strong><span id="status" role="status">正在初始化…</span><button id="save" type="button" disabled>保存进度</button></header><div id="player" aria-label="H5P 场景内容"></div><details id="help"><summary>本地运行与进度</summary><p id="detail">只保存内容类型支持的进度，报告的分数不代表知识掌握。场景内的样式由作者设计；此窗口不允许联网、读取笔记或调用模型。</p></details>
<script src="player/main.bundle.js" onerror="document.getElementById('status').textContent='播放器资源加载失败'"></script><script src="bootstrap.js" onerror="document.getElementById('status').textContent='进度或启动脚本读取失败，请关闭后在场景库重试'"></script></body></html>`;

/** Trusted bootstrap; H5P content is still untrusted and may falsify its own results. */
export function h5pBootstrap(progress: H5pProgress | null, appearance?: H5pAppearance, generation = ''): string {
  const initial = JSON.stringify(progress || { version: 1 }).replace(/</gu, '\\u003c');
  return `(()=>{
const base=new URL('./',location.href).href, status=document.getElementById('status');
const pageGeneration=${JSON.stringify(generation)};
window.logiH5pAppearance=value=>{document.documentElement.classList.toggle('dark',value?.theme==='dark');document.documentElement.style.colorScheme=value?.theme==='dark'?'dark':'light';for(const [key,token] of Object.entries(value?.tokens||{}))document.documentElement.style.setProperty(key,token);};
window.logiH5pAppearance(${JSON.stringify(appearance || { theme: 'light', tokens: {} }).replace(/</gu, '\\u003c')});
let snapshot=${initial},pendingSaves=0,saveTail=Promise.resolve(),ready=false,loading=true;
const instance=()=>{const frame=document.querySelector('#player iframe');return frame?.contentWindow?.H5P?.instances?.[0]||window.H5P?.instances?.[0];};
const persist=async()=>{
 try{
   const current=instance();if(!current)throw Error('场景尚未就绪或已失效，未覆盖进度');if(typeof current.getCurrentState==='function'){const state=current.getCurrentState();if(state!==undefined)snapshot.state=state;}
   const payload=JSON.stringify(snapshot);if(payload.length>900000)throw Error('进度超过保存上限');
   const response=await fetch(base+'checkpoint',{method:'POST',headers:{'Content-Type':'application/json','X-H5P-Page':pageGeneration},body:payload});
   if(!response.ok)throw Error('本地进度保存失败');
   status.textContent=snapshot.state!==undefined?'进度已保存':'本内容类型尚未提供可恢复进度，已记录本次报告';
 }catch(error){status.textContent=String(error.message||error);throw error;}
};
const save=()=>{
 if(!ready)return Promise.resolve();
 pendingSaves++;
 // A close checkpoint waits for earlier writes, then captures the latest state.
 // A failed earlier attempt must not poison an explicitly requested retry.
 const operation=saveTail.catch(()=>{}).then(persist);
 saveTail=operation;
 return operation.finally(()=>{pendingSaves--;});
};
window.logiH5pCheckpoint=save;
const options={id:'local',h5pJsonPath:base+'package',frameJs:base+'player/frame.bundle.js',frameCss:base+'player/styles/h5p.css',customCss:base+'content-layout.css',frame:false,fullScreen:true,saveFreq:10,reportingIsEnabled:true,export:false,embed:false};
// Pinned core reads contentUserData[subContentId][dataType], not the README's array-shaped example.
if(snapshot.state!==undefined)options.contentUserData={0:{state:JSON.stringify(snapshot.state)}};
const saveButton=document.getElementById('save');saveButton.disabled=true;saveButton.onclick=()=>save().catch(()=>{});
let loadTimer,pollTimer;
const rootReady=()=>new Promise((resolve,reject)=>{const probe=()=>{
 if(!loading){reject(Error('初始化已停止'));return;}
 try{const current=instance();if(current){resolve(current);return;}}catch(error){reject(error);return;}
 pollTimer=setTimeout(probe,50);
};probe();});
const load=Promise.resolve().then(()=>new H5PStandalone.H5P(document.getElementById('player'),options)).then(rootReady);
const timeout=new Promise((_,reject)=>{loadTimer=setTimeout(()=>reject(Error('内容初始化超时，未开始自动保存。请检查场景包或在场景库备份进度后重试')),15000);});
Promise.race([load,timeout]).then(()=>{
 ready=true;saveButton.disabled=false;status.textContent='场景已载入，进度每 10 秒保存（需内容类型支持）';
 const dispatcher=window.H5P?.externalDispatcher;
 dispatcher?.on('xAPI',event=>{
   const statement=event?.data?.statement;
   if(statement?.context?.contextActivities?.parent?.length)return;
   if(statement?.result?.completion===true)snapshot.reportedCompleted=true;
   const score=statement?.result?.score;if(score&&Number.isFinite(score.raw)&&Number.isFinite(score.max))snapshot.reportedScore={raw:score.raw,max:score.max};
 });
 setInterval(()=>{if(!pendingSaves)save().catch(()=>{});},10000);
}).catch(error=>{ready=false;saveButton.disabled=true;status.textContent='场景加载失败';document.getElementById('help').open=true;document.getElementById('detail').textContent=String(error.message||error)+'。未自动下载缺失依赖或联网。';})
 .finally(()=>{loading=false;clearTimeout(loadTimer);clearTimeout(pollTimer);});
})();`;
}
