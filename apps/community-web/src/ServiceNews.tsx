import {lazy,Suspense,useEffect,useRef,useState} from 'react';
import {ArrowLeft,Search} from 'lucide-react';
import {useApp} from './context';
import {Empty,LinkButton,Primary,Tabs} from './ui';
import {Hero} from './shared';
import {useServiceIdentity} from './ServiceIdentity';
import {communityNews as api,type NewsDraft,type NewsItem,type NewsKind,type NewsSourceInfo} from './serviceNewsClient';
import NewsSourcesPage from './NewsSources';
import {ContentBody,prepareContentImage,type InlineImageFile} from './ContentImages';
import {communityResources} from './serviceResourceClient';
import {ServiceEntryCard} from './ServiceEntries';
import {SafeLink} from './LinkSafety';
import {ServiceApiError} from './serviceClient';
import {readNewsRecovery,writeNewsRecovery,clearNewsRecovery,trackNewsDraftFlush,waitNewsDraftFlush,type NewsFields,type PendingNewsSave} from './newsDraftRecovery';
import './service-news.css';
const RichEditor=lazy(()=>import('./NewsRichEditor'));
const states:Record<string,string>={draft:'草稿',pending:'待审核',returned:'退回修改',rejected:'不予采用',approved:'已审核'};
const kinds:Record<NewsKind,string>={news:'资讯',article:'官方文章',announcement:'平台公告'};
const actions:Record<string,string>={submit:'提交审核',publish:'审核发布',return:'退回修改',reject:'不予采用',down:'下架',restore:'恢复公开',withdraw_pending:'撤回待审稿',withdraw_published:'作者撤回公开版'};
const sourceDate=(value:NewsSourceInfo)=>value.sourceDateLabel|| (value.sourcePublishedAt?new Date(value.sourcePublishedAt).toLocaleDateString('zh-CN'):'');
function useNewsAccount(){const {session}=useServiceIdentity();return session?.kind==='authenticated'?session:null;}
export function ServiceNewsPage({route}:{route:string}){
  const {go}=useApp(),account=useNewsAccount();
  const [composeEpoch,setComposeEpoch]=useState(0);
  useEffect(()=>{const arrive=()=>{if(/^#\/news\/write(?:~(?:article|announcement))?$/.test(location.hash))setComposeEpoch(value=>value+1);};window.addEventListener('hashchange',arrive);return()=>window.removeEventListener('hashchange',arrive);},[]);
  const [part,id]=route.split('~');
  if(part==='sources')return <NewsSourcesPage key={`${account?.account.accountId}:${account?.role}:${account?.mfa}`}/>;
  if(part==='write'||part==='edit')return account?<NewsEditor key={route+':'+composeEpoch} id={part==='edit'?id:undefined} kind={part==='write'&&['article','announcement'].includes(id)?id as NewsKind:'news'}/>:<section className="reading-column"><Hero title="投稿"/><Empty action={<Primary onClick={()=>go('account')}>登录</Primary>}>登录后提交你的文章或推荐链接。</Empty></section>;
  if(part==='review'&&id)return <NewsReview id={id}/>;
  if(/^[\da-f-]{36}$/i.test(route))return <NewsDetail id={route}/>;
  return <NewsDirectory mode={part==='mine'?'mine':part==='queue'?'queue':'public'}/>;
}
function NewsDirectory({mode}:{mode:'public'|'mine'|'queue'}){
  const {go}=useApp(),account=useNewsAccount(),[tab,setTab]=useState('资讯'),[items,setItems]=useState<NewsItem[]>([]),[next,setNext]=useState<number|null>(null),[loading,setLoading]=useState(true),[error,setError]=useState(''),[q,setQ]=useState(''),[search,setSearch]=useState(''),[version,setVersion]=useState(0);
  const generation=useRef(0);
  const view=mode==='public'?tab==='资讯'?'news':'official':mode,canReview=account?.role==='administrator'&&account.mfa==='verified';
  useEffect(()=>{const timer=setTimeout(()=>setSearch(q.trim()),250);return()=>clearTimeout(timer);},[q]);
  useEffect(()=>{const current=++generation.current;setItems([]);setNext(null);setError('');if(mode==='queue'&&!canReview||mode==='mine'&&!account){setLoading(false);return;}const controller=new AbortController();setLoading(true);void api.list(view,search,0,controller.signal).then(value=>{if(current===generation.current&&!controller.signal.aborted){setItems(value.items);setNext(value.nextOffset);}}).catch(error=>{if(current===generation.current&&!controller.signal.aborted)setError(error.message);}).finally(()=>{if(current===generation.current&&!controller.signal.aborted)setLoading(false);});return()=>{controller.abort();generation.current++;};},[view,search,version,canReview,account?.account.accountId]);
  return <section className="reading-column service-news"><header className="news-heading"><div>{mode!=='public'&&<LinkButton onClick={()=>go('news')}><ArrowLeft size={15}/>资讯与公告</LinkButton>}<h1>{mode==='mine'?'我的投稿':mode==='queue'?'投稿审核':'资讯与公告'}</h1></div><div className="news-heading-actions">{account&&mode!=='mine'&&<LinkButton onClick={()=>go('news','mine')}>我的投稿</LinkButton>}{mode==='public'&&account?.role==='administrator'&&<LinkButton onClick={()=>go('news','queue')}>审核管理</LinkButton>}<Primary onClick={()=>go(account?'news':'account',account?'write':undefined)}>投稿</Primary></div></header>
    {mode==='public'&&<Tabs items={['资讯','官方']} value={tab} onChange={setTab} trailing={<details data-popup className="service-filter"><summary><Search size={15}/>搜索</summary><div><input type="search" aria-label="搜索资讯" value={q} onChange={event=>setQ(event.target.value)} placeholder="标题、内容或作者…"/></div></details>}/>}
    {mode==='queue'&&canReview&&<div className="news-owner-actions"><LinkButton onClick={()=>go('news','write~article')}>写官方文章</LinkButton><LinkButton onClick={()=>go('news','write~announcement')}>发布公告</LinkButton><LinkButton onClick={()=>go('news','sources')}>资讯来源</LinkButton></div>}
    {mode==='queue'&&!canReview?<Empty action={<LinkButton onClick={()=>go('account','settings')}>账号设置</LinkButton>}>需要平台管理员身份及本次多因素验证。</Empty>:mode==='mine'&&!account?<Empty action={<Primary onClick={()=>go('account')}>登录</Primary>}>登录后查看自己的投稿。</Empty>:<>
      {error&&<p className="inline-status" role="alert">{error} <LinkButton onClick={()=>setVersion(v=>v+1)}>重试</LinkButton></p>}
      {items.map(item=><article className="news-row" key={item.id}><p className="meta">{item.kind==='news'?(item.sourceName|| (item.origin==='user'?item.authorName+' · 用户投稿':item.sourceUrl?new URL(item.sourceUrl).hostname:item.authorName)):kinds[item.kind]}{sourceDate(item)?' · 原文 '+sourceDate(item):''}{mode!=='public'?' · '+states[item.state]:!sourceDate(item)&&item.publishedAt?' · '+new Date(item.publishedAt).toLocaleDateString('zh-CN'):''}</p><h2><button type="button" onClick={()=>go('news',mode==='mine'?'edit~'+item.id:mode==='queue'?'review~'+item.id:item.id)}>{item.title||'未命名草稿'}</button></h2>{item.summary&&<p>{item.summary}</p>}{mode==='mine'&&item.reason&&<p className="news-reason">审核说明：{item.reason}</p>}</article>)}
      {loading?<p className="meta" role="status">正在读取…</p>:!items.length&&!error&&<Empty>{mode==='mine'?'还没有投稿，写下你的第一篇分享吧。':mode==='queue'?'当前没有待审核稿件。':search?'没有找到相关内容。':'暂时没有已发布内容。'}</Empty>}
      {next!==null&&<LinkButton disabled={loading} onClick={()=>{if(loading||next===null)return;const current=generation.current;setLoading(true);setError('');void api.list(view,search,next).then(value=>{if(current===generation.current){setItems(old=>[...old,...value.items.filter(item=>!old.some(saved=>saved.id===item.id))]);setNext(value.nextOffset);}}).catch(error=>{if(current===generation.current)setError(error.message);}).finally(()=>{if(current===generation.current)setLoading(false);});}}>查看更多</LinkButton>}
    </>}
  </section>;
}
type Fields=NewsFields;
function NewsEditor({id,kind}:{id?:string;kind:NewsKind}){
  const {go}=useApp(),account=useNewsAccount()!,recovery=useRef(readNewsRecovery(account.account.accountId,id,kind));
  const empty:Fields={title:'',body:'',topics:[],sourceUrl:''};
  const [fields,setFields]=useState<Fields>(recovery.current?.fields||empty),[topicsText,setTopicsText]=useState(recovery.current?.fields.topics.join('，')||''),[info,setInfo]=useState<NewsDraft|null>(null),[ready,setReady]=useState(false),[busy,setBusy]=useState(false),[imageBusy,setImageBusy]=useState(false),[preview,setPreview]=useState(false),[error,setError]=useState(''),[conflict,setConflict]=useState(false),[status,setStatus]=useState(''),[files,setFiles]=useState<InlineImageFile[]>([]);
  const latest=useRef(fields),saved=useRef(''),record=useRef<NewsDraft|null>(null),stage=useRef<string|undefined>(recovery.current?.stageId),alive=useRef(true),loaded=useRef(false),queue=useRef(Promise.resolve()),pending=useRef<PendingNewsSave|null>(recovery.current?.pending||null),imagesQueue=useRef<Promise<unknown>>(Promise.resolve()),fileList=useRef<InlineImageFile[]>(recovery.current?.images||[]),uninserted=useRef<InlineImageFile[]>(recovery.current?.uninsertedImages||[]);
  const uploading=useRef(false),conflicted=useRef(false),baseVersion=useRef<number|undefined>(recovery.current?.version),releasedNewAlias=useRef(false);
  const signature=(value:Fields)=>JSON.stringify(value);
  const journal=()=>{
    const current=record.current,draftId=current?.id||id,draftKind=current?.kind||kind,accountId=account.account.accountId;
    if(current&&!id&&!releasedNewAlias.current){clearNewsRecovery(accountId,undefined,kind);releasedNewAlias.current=true;}
    if(signature(latest.current)===saved.current&&!pending.current&&!stage.current&&!uploading.current&&!uninserted.current.length){clearNewsRecovery(accountId,draftId,draftKind);return;}
    writeNewsRecovery({accountId,id:draftId,kind:draftKind,fields:latest.current,version:baseVersion.current,stageId:stage.current,images:fileList.current,uninsertedImages:uninserted.current,pending:pending.current,updatedAt:Date.now()});
  };
  const update=(value:Fields)=>{latest.current=value;uninserted.current=uninserted.current.filter(image=>!value.body.includes('attachment:'+image.id));journal();setFields(value);setStatus('');if(!conflict)setError('');};
  useEffect(()=>{alive.current=true;const controller=new AbortController();
    const restore=async(value:NewsDraft|null,receipt:NewsDraft|null)=>{
      const local=recovery.current,remote=value?{title:value.revision.title,body:value.revision.body,topics:value.revision.topics,sourceUrl:value.revision.sourceUrl}:empty;
      // The own-draft endpoint verifies ownership before any tab recovery is shown.
      const exact=!!local?.pending&&!!value&&local.pending.signature===signature(remote),committed=exact||!!receipt&&receipt.id===value?.id,consumedStage=committed&&local?.stageId===local?.pending?.input.stageId;
      const changed=!!local&&!!value&&(value.revision.state==='pending'||!exact&&(receipt?receipt.version!==value.version:local.version!==undefined&&local.version!==value.version));
      let images=value?.revision.images||[];
      if(local?.stageId&&!consumedStage){const staged=await communityResources.stage(local.stageId,controller.signal);images=[...images,...staged.files.filter(file=>file.role==='image'&&file.state==='ready')];}
      if(controller.signal.aborted)return;
      record.current=value;baseVersion.current=changed?receipt?.version??local?.version:value?.version;conflicted.current=changed;stage.current=consumedStage?undefined:local?.stageId;pending.current=committed?null:local?.pending||null;saved.current=signature(remote);
      if(!id&&value&&location.hash.startsWith('#/news/write'))history.replaceState(null,'','#/news/edit~'+value.id);
      const restored=local?{...local.fields}:remote;
      for(const image of local?.uninsertedImages||[])if(images.some(file=>file.id===image.id)&&!restored.body.includes('attachment:'+image.id))restored.body+='\n\n!['+image.name+'](attachment:'+image.id+')';
      fileList.current=images;uninserted.current=[];latest.current=restored;setFields(restored);setTopicsText(restored.topics.join('，'));setFiles(images);setInfo(value);loaded.current=true;setReady(true);
      if(changed){pending.current=null;setConflict(true);setError('稿件已在其他页面变化，本页编辑仍保留。读取最新版本后，可以保留本页内容继续保存。');}
      else if(local)setStatus('已恢复本页未保存的编辑');
      journal();
    };
    void(async()=>{await waitNewsDraftFlush(account.account.accountId,id,kind);if(controller.signal.aborted)return;recovery.current=readNewsRecovery(account.account.accountId,id,kind);let receipt:NewsDraft|null=null,replayError='';const uncertain=recovery.current?.pending;
      if(uncertain)try{receipt=await api.save(account.account.accountId,uncertain.id,uncertain.input,uncertain.key);}catch(error){if(!(error instanceof ServiceApiError)||error.status<400||error.status>=500)throw error;recovery.current={...recovery.current!,pending:null};pending.current=null;writeNewsRecovery(recovery.current);replayError=error.message;}
      const draftId=id||receipt?.id,value=draftId?await api.draft(draftId,controller.signal):null;await restore(value,receipt);if(replayError&&!conflicted.current)setError(replayError);
    })().catch(error=>{if(!controller.signal.aborted)setError(error.message);});
    return()=>{alive.current=false;controller.abort();};
  },[id]);
  const persist=(ensureDraft=false)=>{
    const job=queue.current.catch(()=>{}).then(async()=>{
      if(!loaded.current||uploading.current||conflicted.current)return record.current;
      // Finish an uncertain attempt with its original key before saving newer edits.
      for(let pass=0;pass<3;pass++){
        const value=latest.current,encoded=signature(value);if(!pending.current&&encoded===saved.current&&(!ensureDraft||record.current?.revision.state==='draft'))return record.current;
        pending.current??={id:record.current?.id,input:{...value,...(record.current?{expectedVersion:record.current.version}:{kind}),...(stage.current?{stageId:stage.current}:{})},signature:encoded,key:crypto.randomUUID()};journal();
        const attempt=pending.current;let result:NewsDraft;try{result=await api.save(account.account.accountId,attempt.id,attempt.input,attempt.key);}catch(error){if(error instanceof ServiceApiError&&error.status>=400&&error.status<500){pending.current=null;if(error.code==='version_conflict'){conflicted.current=true;journal();if(alive.current)setConflict(true);throw Error('稿件已在其他页面变化，本页编辑仍保留。读取最新版本后，可以保留本页内容继续保存。');}journal();}throw error;}record.current=result;baseVersion.current=result.version;saved.current=attempt.signature;pending.current=null;
        if(stage.current===attempt.input.stageId)stage.current=undefined;
        journal();
        if(alive.current){setInfo(result);setStatus(encoded===signature(latest.current)?'草稿已保存':'');if(!id&&location.hash.startsWith('#/news/write'))history.replaceState(null,'','#/news/edit~'+result.id);}
      }
      return record.current;
    });queue.current=job.then(()=>{},()=>{});return job;
  };
  const persistRef=useRef(persist);persistRef.current=persist;
  useEffect(()=>{if(!ready||busy||imageBusy||conflict||info?.revision.state==='pending')return;const timer=setTimeout(()=>void persistRef.current().catch(error=>{if(alive.current)setError(error.message);}),800);return()=>clearTimeout(timer);},[fields,ready,busy,imageBusy,conflict,info?.revision.state]);
  useEffect(()=>()=>{if(!loaded.current)return;journal();const work=(async()=>{while(uploading.current)await imagesQueue.current.catch(()=>{});if(signature(latest.current)!==saved.current||pending.current)await persistRef.current();})();trackNewsDraftFlush(account.account.accountId,record.current?.id||id,record.current?.kind||kind,work);void work.catch(()=>{});},[]);
  const run=async(work:()=>Promise<void>)=>{if(busy||imageBusy)return;setBusy(true);setError('');try{await work();}catch(error){setError(error instanceof Error?error.message:'暂时无法提交，请重试。');}finally{if(alive.current)setBusy(false);}};
  const addImage=(source:File):Promise<{src:string;name:string}>=>{
    uploading.current=true;setImageBusy(true);journal();
    const job=imagesQueue.current.catch(()=>{}).then(async()=>{await queue.current.catch(()=>{});requireImageLimit(latest.current.body);const file=await prepareContentImage(source);stage.current??=(await communityResources.createStage(account.account.accountId)).stageId;journal();const attachmentId=await communityResources.upload(account.account.accountId,stage.current,file,'image',crypto.randomUUID()),image={id:attachmentId,name:file.name,mime:file.type,bytes:file.size};fileList.current=[...fileList.current,image];uninserted.current.push(image);
      if(alive.current)setFiles(fileList.current);else{latest.current={...latest.current,body:latest.current.body+'\n\n!['+image.name+'](attachment:'+image.id+')'};uninserted.current=uninserted.current.filter(file=>file.id!==image.id);}
      journal();return {src:'attachment:'+attachmentId,name:file.name};
    });const done=job.finally(()=>{if(imagesQueue.current===done){uploading.current=false;journal();if(alive.current)setImageBusy(false);}});imagesQueue.current=done;return done;
  };
  const blocked=info?.revision.state==='pending'&&!conflict,official=(info?.kind||kind)!=='news';
  if(error&&!ready)return <section className="reading-column"><p className="inline-status" role="alert">{error}</p><LinkButton onClick={()=>go('news','mine')}>返回我的投稿</LinkButton></section>;
  return <section className="reading-column news-write"><header className="news-heading"><div><LinkButton onClick={()=>go('news','mine')}><ArrowLeft size={15}/>我的投稿</LinkButton><h1>{official?kinds[info?.kind||kind]:'投稿'}</h1></div>{ready&&<p className="meta" role="status">{imageBusy?'正在上传图片…':blocked?'待审核':status}</p>}</header>
    {error&&<p className="inline-status" role="alert">{error}{conflict&&<LinkButton disabled={busy||imageBusy} onClick={()=>void run(async()=>{const current=record.current;if(!current)return;const fresh=await api.draft(current.id);if(fresh.revision.state==='pending')throw Error('远端稿件已提交审核。本页编辑仍保留，请先在其他页面撤回待审版本后重试。');record.current=fresh;baseVersion.current=fresh.version;conflicted.current=false;setInfo(fresh);saved.current=signature({title:fresh.revision.title,body:fresh.revision.body,topics:fresh.revision.topics,sourceUrl:fresh.revision.sourceUrl});setConflict(false);await persist();setStatus('本页编辑已保存。');})}>读取最新版本并保留本页编辑</LinkButton>}</p>}{info?.revision.reason&&<p className="news-reason">审核说明：{info.revision.reason}</p>}
    {!ready?<p className="meta">正在读取稿件…</p>:blocked?<><h2>{fields.title||'投稿内容'}</h2>{fields.sourceUrl&&!fields.body.includes(fields.sourceUrl)&&<p className="news-source">原文：<SafeLink href={fields.sourceUrl}>{fields.sourceUrl}</SafeLink></p>}<ContentBody body={fields.body} images={files}/><div className="news-editor-actions"><Primary disabled={busy} onClick={()=>void run(async()=>{const value=await api.withdraw(account.account.accountId,record.current!,'pending');record.current=value;baseVersion.current=value.version;setInfo(value);setStatus('已撤回，可以继续编辑。');})}>撤回并修改</Primary>{info?.published&&<LinkButton onClick={()=>go('news',info.id)}>查看公开版本</LinkButton>}</div></>:<>
      <input className="news-title-input" aria-label="投稿标题" placeholder="标题（可选）" maxLength={160} value={fields.title} disabled={busy} onChange={event=>update({...latest.current,title:event.target.value})}/>
      <Tabs items={['编辑','预览']} value={preview?'预览':'编辑'} onChange={value=>setPreview(value==='预览')}/>
      <div hidden={preview}><Suspense fallback={<p className="meta">正在加载编辑器…</p>}><RichEditor body={fields.body} accountId={account.account.accountId} disabled={busy} onChange={body=>update({...latest.current,body})} onImage={addImage} onError={setError}/></Suspense></div>
      {preview&&<article className="news-preview" aria-label="投稿预览"><h1>{fields.title||'未填写标题'}</h1><ContentBody body={fields.body} images={files}/></article>}
      <details data-popup className="news-more"><summary>更多</summary><div><label>原文链接（可选）<input aria-label="投稿原文链接" type="url" placeholder="https://…" value={fields.sourceUrl} onChange={event=>update({...latest.current,sourceUrl:event.target.value})} disabled={busy}/></label><label>话题（可选）<input aria-label="投稿话题" placeholder="最多三个，用逗号分隔" value={topicsText} onChange={event=>{setTopicsText(event.target.value);update({...latest.current,topics:event.target.value.split(/[,，]/).map(s=>s.trim()).filter(Boolean).slice(0,3)});}} disabled={busy}/></label></div></details>
      <div className="news-editor-actions"><LinkButton disabled={busy||imageBusy||conflict} onClick={()=>void run(async()=>{await persist();setStatus('草稿已保存');})}>保存草稿</LinkButton>{info?.published&&<><LinkButton onClick={()=>go('news',info.id)}>查看公开版</LinkButton><LinkButton disabled={busy||imageBusy||conflict} onClick={()=>void run(async()=>{const current=await persist();const result=await api.withdraw(account.account.accountId,current!,'published');record.current=result;baseVersion.current=result.version;setInfo(result);setStatus('公开版本已撤回。');})}>撤回公开版</LinkButton></>}<Primary disabled={busy||imageBusy||conflict||!fields.body.trim()&&!fields.sourceUrl.trim()} onClick={()=>void run(async()=>{const current=await persist(true);if(!current)return;const value=await api.submit(account.account.accountId,current);record.current=value;baseVersion.current=value.version;setInfo(value);setStatus('已提交审核');})}>{busy?'正在保存…':'提交审核'}</Primary></div>
    </>}
  </section>;
}
function requireImageLimit(body:string){if((body.match(/!\[[^\]]*\]\(attachment:/g)||[]).length>=8)throw Error('每篇最多包含 8 张图片。');}
function NewsReview({id}:{id:string}){
  const {go}=useApp(),account=useNewsAccount(),[value,setValue]=useState<NewsDraft|null>(null),[error,setError]=useState(''),[reason,setReason]=useState(''),[busy,setBusy]=useState(false),[revision,setRevision]=useState(0);
  const allowed=account?.role==='administrator'&&account.mfa==='verified';
  useEffect(()=>{if(!allowed)return;const controller=new AbortController();void api.draft(id,controller.signal,true).then(setValue).catch(error=>{if(!controller.signal.aborted)setError(error.message);});return()=>controller.abort();},[id,allowed,revision]);
  const act=async(action:string)=>{if(!value||!account||busy)return;setBusy(true);setError('');try{setValue(await api.review(account.account.accountId,value,action,reason));setReason('');}catch(error){setError(error instanceof Error?error.message:'审核暂未完成。');}finally{setBusy(false);}};
  return <section className="reading-column service-news"><LinkButton onClick={()=>go('news','queue')}><ArrowLeft size={15}/>返回审核队列</LinkButton><h1>审核稿件</h1>{!allowed?<Empty action={<LinkButton onClick={()=>go('account','settings')}>账号设置</LinkButton>}>需要平台管理员身份及本次多因素验证。</Empty>:<>{error&&<p className="inline-status" role="alert">{error} <LinkButton onClick={()=>setRevision(v=>v+1)}>重新读取当前版本</LinkButton></p>}{value&&<><p className="meta">{value.sourceName||value.author.displayName}{sourceDate(value)?' · 原文 '+sourceDate(value):''} · {kinds[value.kind]} · 第 {value.revision.number} 稿 · {states[value.revision.state]}</p><h2>{value.revision.title}</h2>{value.revision.sourceUrl&&<p className="news-source">原文：<SafeLink href={value.revision.sourceUrl}>{value.revision.sourceUrl}</SafeLink></p>}<ContentBody body={value.revision.body} images={value.revision.images}/><div className="news-review-actions"><label>审核说明<textarea aria-label="资讯审核说明" rows={2} placeholder="退回、拒绝或下架时说明原因…" maxLength={2000} value={reason} onChange={event=>setReason(event.target.value)} disabled={busy}/></label><div>{value.revision.state==='pending'?<>{value.origin!=='feed'&&<LinkButton disabled={busy||!reason.trim()} onClick={()=>void act('return')}>退回修改</LinkButton>}<LinkButton disabled={busy||!reason.trim()} onClick={()=>void act('reject')}>不予采用</LinkButton><Primary disabled={busy} onClick={()=>void act('publish')}>审核通过并发布</Primary></>:null}{value.published?<LinkButton disabled={busy||!reason.trim()} onClick={()=>void act('down')}>下架公开版</LinkButton>:value.withdrawn?<LinkButton disabled={busy||!reason.trim()} onClick={()=>void act('restore')}>恢复公开版</LinkButton>:null}{value.published&&<LinkButton onClick={()=>go('news',id)}>查看公开版</LinkButton>}</div></div><details className="fold"><summary>审核记录</summary>{value.events.map(event=><p className="meta" key={event.position}>{event.actorName} · {actions[event.action]||event.action} · {new Date(event.createdAt).toLocaleString('zh-CN')}{event.reason?'：'+event.reason:''}</p>)}</details></>}</>}
  </section>;
}
function NewsDetail({id}:{id:string}){
  const {go}=useApp(),account=useNewsAccount(),[value,setValue]=useState<Awaited<ReturnType<typeof api.read>>|null>(null),[error,setError]=useState('');
  useEffect(()=>{let active=true,controller:AbortController|null=null,timer:number|undefined;const load=async()=>{if(controller)return;controller=new AbortController();try{const value=await api.read(id,controller.signal);if(active){setValue(value);setError('');}}catch(error){if(active){setValue(null);setError(error instanceof Error?error.message:'暂时无法读取内容。');}}finally{controller=null;}};const resume=()=>{if(document.hidden)return;clearTimeout(timer);timer=window.setTimeout(()=>void load(),50);};void load();window.addEventListener('focus',resume);window.addEventListener('online',resume);document.addEventListener('visibilitychange',resume);return()=>{active=false;clearTimeout(timer);controller?.abort();window.removeEventListener('focus',resume);window.removeEventListener('online',resume);document.removeEventListener('visibilitychange',resume);};},[id]);
  return <section className="reading-column service-entry-detail service-news-detail"><div className="news-detail-back"><LinkButton onClick={()=>go('news')}><ArrowLeft size={15}/>资讯与公告</LinkButton>{account?.role==='administrator'&&account.mfa==='verified'&&<LinkButton onClick={()=>go('news','review~'+id)}>审核记录与管理</LinkButton>}</div>{error?<Empty>{error}</Empty>:value?<><p className="meta">{value.kind==='news'?(value.sourceName|| (value.origin==='user'?'用户投稿':'编辑收录')):kinds[value.kind]}{sourceDate(value)?' · 原文 '+sourceDate(value):''}{value.sourceUrl&&<> · 原文：<SafeLink href={value.sourceUrl}>{new URL(value.sourceUrl).hostname}</SafeLink></>}</p><ServiceEntryCard value={value.entry} detail/></>:<p className="meta">正在读取内容…</p>}</section>;
}
