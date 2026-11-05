import {useEffect,useRef,useState} from 'react';
import {ArrowLeft,ChevronDown,RefreshCw} from 'lucide-react';
import {useApp} from './context';
import {useServiceIdentity} from './ServiceIdentity';
import {Empty,LinkButton} from './ui';
import {SafeLink} from './LinkSafety';
import {communityNewsSources as api,type NewsSource,type NewsSources,type NewsCollection} from './serviceNewsSourceClient';
import './news-sources.css';

const date=(value:string|null)=>value?new Date(value).toLocaleString('zh-CN',{month:'numeric',day:'numeric',hour:'2-digit',minute:'2-digit'}):'';
const size=(value:number)=>`${Number((value/1024/1024).toFixed(1))} MB`;
function collectionMessage(value:NewsCollection){
  if(value.status==='not_modified')return '订阅内容未更新。';
  if(value.status==='skipped'||value.status==='failed')return value.reason||'本次未收录，请稍后再试。';
  return `已收录 ${value.imported} 篇至待审核${value.duplicates?`，跳过 ${value.duplicates} 篇重复内容`:''}${value.ignored?`，略过 ${value.ignored} 篇`:''}。`;
}
function lastRunMessage(source:NewsSource){
  const value=source.lastRun;if(!value)return '';
  if(value.message)return value.message;
  if(value.status==='collected'||value.status==='not_modified')return collectionMessage({...value,status:value.status,nextCheckAt:source.nextCheckAt});
  return '';
}

export default function NewsSourcesPage(){
  const {go}=useApp(),{session}=useServiceIdentity(),account=session?.kind==='authenticated'?session:null;
  const allowed=account?.role==='administrator'&&account.mfa==='verified',accountId=account?.account.accountId;
  const [data,setData]=useState<NewsSources|null>(null),[loading,setLoading]=useState(true),[error,setError]=useState(''),[retry,setRetry]=useState(0),[busy,setBusy]=useState<Record<string,'save'|'collect'>>({}),[messages,setMessages]=useState<Record<string,{text:string;error?:boolean}>>({});
  const mounted=useRef(false),working=useRef(new Map<string,'save'|'collect'>());
  useEffect(()=>{mounted.current=true;return()=>{mounted.current=false;};},[]);
  useEffect(()=>{setData(null);setError('');setMessages({});setBusy({});working.current.clear();if(!allowed||!accountId){setLoading(false);return;}const controller=new AbortController();setLoading(true);void api.list(accountId,controller.signal).then(value=>{if(!controller.signal.aborted)setData(value);}).catch(error=>{if(!controller.signal.aborted)setError(error instanceof Error?error.message:'暂时无法读取资讯来源。');}).finally(()=>{if(!controller.signal.aborted)setLoading(false);});return()=>controller.abort();},[allowed,accountId,retry]);
  const run=async(source:NewsSource,kind:'save'|'collect',work:()=>Promise<void>)=>{
    if(working.current.has(source.id)||kind==='collect'&&working.current.size>0||kind==='save'&&Array.from(working.current.values()).includes('collect'))return;
    working.current.set(source.id,kind);setBusy(Object.fromEntries(working.current));setMessages(previous=>({...previous,[source.id]:{text:''}}));
    try{await work();}catch(error){if(mounted.current)setMessages(previous=>({...previous,[source.id]:{text:error instanceof Error?error.message:'操作暂未完成，请重试。',error:true}}));}
    finally{working.current.delete(source.id);if(mounted.current)setBusy(Object.fromEntries(working.current));}
  };
  const save=(source:NewsSource,input:{enabled?:boolean;intervalMinutes?:number})=>void run(source,'save',async()=>{
    const value=await api.save(accountId!,source,input);if(!mounted.current)return;setData(previous=>previous?{...previous,items:previous.items.map(item=>item.id===value.id?value:item)}:previous);setMessages(previous=>({...previous,[source.id]:{text:input.enabled===undefined?'收录间隔已保存。':value.enabled?'已开启定时收录，内容将先进入待审核。':'已暂停定时收录。'}}));
  });
  const collect=(source:NewsSource)=>void run(source,'collect',async()=>{
    const result=await api.collect(accountId!,source.id);if(!mounted.current)return;setMessages(previous=>({...previous,[source.id]:{text:collectionMessage(result),error:result.status==='failed'}}));
    try{const value=await api.list(accountId!);if(mounted.current)setData(value);}catch(error){if(mounted.current)setError(`收录结果已返回，来源状态暂未更新。${error instanceof Error?error.message:''}`);}
  });
  const collecting=Object.values(busy).includes('collect'),anyBusy=Object.keys(busy).length>0;
  return <section className="reading-column service-news news-sources">
    <header className="news-heading"><div><LinkButton onClick={()=>go('news','queue')}><ArrowLeft size={15}/>审核管理</LinkButton><h1>资讯来源</h1></div>{allowed&&<LinkButton disabled={loading||anyBusy} onClick={()=>setRetry(value=>value+1)}>刷新状态</LinkButton>}</header>
    {!allowed?<Empty action={<LinkButton onClick={()=>go('account','settings')}>账号设置</LinkButton>}>需要平台管理员身份及本次多因素验证。</Empty>:<>
      <p className="news-sources-intro">开启需要的来源，收录内容先进入<LinkButton onClick={()=>go('news','queue')}>待审核</LinkButton>，审核后公开。</p>
      {error&&<p className="inline-status" role="alert">{error} <LinkButton disabled={anyBusy} onClick={()=>setRetry(value=>value+1)}>重新读取</LinkButton></p>}
      {loading?<p className="meta" role="status">正在读取来源…</p>:data&&<>
        <div className="news-sources-list">{data.items.map(source=><article className="news-source-row" key={source.id} aria-labelledby={'source-'+source.id}>
          <div className="news-source-main"><div className="news-source-copy"><h2 id={'source-'+source.id}>{source.name}</h2><p className="news-source-description">{source.description}</p><p className="meta">{source.lastSuccessAt?`上次收录 ${date(source.lastSuccessAt)}`:'尚未收录'}{source.importedCount>0?` · 累计 ${source.importedCount} 篇`:''}</p></div>
            <div className="news-source-controls"><LinkButton disabled={!source.enabled||anyBusy||source.lastStatus==='collecting'} title={!source.enabled?'开启来源后可以收录':undefined} aria-label={'收录'+source.name} onClick={()=>collect(source)}><RefreshCw size={14} className={busy[source.id]==='collect'||source.lastStatus==='collecting'?'news-source-spin':undefined}/>{busy[source.id]==='collect'||source.lastStatus==='collecting'?'收录中…':'收录'}</LinkButton><label className="news-source-toggle"><input type="checkbox" role="switch" aria-label={'开启'+source.name} checked={source.enabled} disabled={!!busy[source.id]||collecting||source.lastStatus==='collecting'} onChange={event=>save(source,{enabled:event.target.checked})}/><span>{source.enabled?'已开启':'开启'}</span></label></div>
          </div>
          {messages[source.id]?.text?<p className={'news-source-result'+(messages[source.id].error?' failed':'')} role={messages[source.id].error?'alert':'status'}>{messages[source.id].text}</p>:source.lastError?<p className="news-source-result failed">最近收录未完成：{source.lastError}</p>:lastRunMessage(source)&&<p className="news-source-result">最近一次：{lastRunMessage(source)}</p>}
          <details className="news-source-settings"><summary>来源与设置<ChevronDown size={13}/></summary><div><p>订阅地址：<SafeLink href={source.url}>{source.url}</SafeLink></p><label>收录间隔 <select aria-label={source.name+'收录间隔'} value={source.intervalMinutes} disabled={!!busy[source.id]||collecting||source.lastStatus==='collecting'} onChange={event=>save(source,{intervalMinutes:Number(event.target.value)})}>{Array.from(new Set([source.intervalMinutes,...[60,180,360,720,1440].filter(value=>value>=data.limits.minimumIntervalMinutes)])).sort((a,b)=>a-b).map(value=><option key={value} value={value}>{value<60?`${value} 分钟`:value%60===0?`每 ${value/60} 小时`:`每 ${value} 分钟`}</option>)}</select></label>{source.enabled&&source.nextCheckAt&&<p>下次检查：{date(source.nextCheckAt)}</p>}{source.lastAttemptAt&&<p>最近尝试：{date(source.lastAttemptAt)}{source.consecutiveFailures>0?` · 连续 ${source.consecutiveFailures} 次未完成`:''}</p>}</div></details>
        </article>)}</div>
        <details className="news-source-limits"><summary>收录规则与今日用量<ChevronDown size={14}/></summary><div><p>仅收录标题、摘要和原文入口，不自动发布。重复内容不会再次进入审核队列。</p><p>每次最多 {data.limits.maxItemsPerRun} 篇，最短间隔 {data.limits.minimumIntervalMinutes} 分钟，单份订阅最多 {size(data.limits.maxFeedBytes)}。</p><p>今日请求 {data.usage.requests} / {data.limits.maxRequestsPerDay} 次，读取 {size(data.usage.bytes)} / {size(data.limits.maxBytesPerDay)}。</p></div></details>
      </>}
    </>}
  </section>;
}
