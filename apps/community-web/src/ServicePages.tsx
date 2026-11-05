import {LearningStatistics} from './LearningStatistics';
import {ServiceGroupDirectory,ServiceGroupPage} from './ServiceGroups';
import {useEffect,useState} from 'react';
import {Search,SlidersHorizontal} from 'lucide-react';
import {useApp} from './context';
import type {Page} from './model';
import {Empty,LinkButton,Primary,Tabs} from './ui';
import {Hero} from './shared';
import {ServiceAccountPage} from './ServiceAccount';
import {ServiceProfilePage} from './ServiceProfile';
import {ServiceAvatar} from './ServiceAvatar';
import {ServiceGovernancePage} from './ServiceGovernance';
import {useServiceIdentity} from './ServiceIdentity';
import {SESSION_CHANGED} from './serviceClient';
import {communityContent,type EntryKind,type PublicPerson,type ServiceEntry} from './serviceContentClient';
import {ServiceEntryCard,ServiceEntryEditor,ServiceEntryList,ServiceFollow,ServicePerson} from './ServiceEntries';
import './service-content.css';
import {ServiceMessagesPage} from './ServiceMessages';
import {ServiceNewsPage} from './ServiceNews';

export function ServicePages({page,id}:{page:Page;id:string}){
  const identity=useServiceIdentity();
  if(identity.status==='loading')return <section className="reading-column"><p className="meta" role="status">正在连接社区…</p></section>;
  if(identity.status==='error')return <section className="reading-column"><Empty action={<LinkButton onClick={()=>window.dispatchEvent(new Event(SESSION_CHANGED))}>重新连接</LinkButton>}>{identity.error}</Empty></section>;
  const scope=identity.session?.kind==='authenticated'?identity.session.account.accountId:'guest';
  // A peer change updates the inbox; only an account change rebuilds its shell.
  return <ServicePageContent key={`${scope}:${page}:${page==='messages'?'':page==='group'?id.split('~')[0]:id}`} page={page} id={id}/>;
}
function ServicePageContent({page,id}:{page:Page;id:string}){
  const {go}=useApp();
  if(page==='account')return <ServiceAccountPage onAuthenticated={()=>go('me')} redirectAuthenticated={id!=='settings'}/>;
  if(page==='me')return <ServiceProfilePage/>;
  if(page==='admin')return <ServiceGovernancePage mode="administrator"/>;
  if(page==='feedback')return <ServiceGovernancePage/>;
  if(page==='home'||page==='following')return <ServiceHome following={page==='following'} action={id}/>;
  if(page==='market')return <ServiceMarket/>;
  if(page==='publish')return <ServicePublish/>;
  if(page==='resource'||page==='discussion')return <ServiceDetail id={id}/>;
  if(page==='friends')return <ServicePublicProfile id={id}/>;
  if(page==='search'||page==='topic')return <ServiceSearch topic={page==='topic'} value={id}/>;
  if(page==='groups')return <ServiceGroupDirectory/>;
  if(page==='group')return <ServiceGroupPage route={id}/>;
  if(page==='messages')return <ServiceMessagesPage peerId={id}/>;
  if(page==='news')return <ServiceNewsPage route={id}/>;
  const title=page==='news'?'关注资讯':'共学';
  return <section className="reading-column service-pending"><Hero title={title}/><Empty>{page==='news'?'资讯来源正在接入，暂未发布内容。':'共学群正在接入真实成员、群内资源与讨论权限，暂未开放。'}</Empty></section>;
}
function ServiceHome({following,action}:{following:boolean;action:string}){
  const {session}=useServiceIdentity(),{go}=useApp();const [tab,setTab]=useState(action==='people'?'找同好':'公共交流'),[version,setVersion]=useState(0),[q,setQ]=useState(''),[kind,setKind]=useState<'all'|EntryKind>('all');
  if(following&&session?.kind!=='authenticated')return <section className="reading-column"><Hero title="关注"/><Empty action={<Primary onClick={()=>go('account')}>登录</Primary>}>登录后查看你关注的人。</Empty></section>;
  return <><Hero title={following?'关注的人，正在分享什么':'与你一起，慢慢学深'} subtitle={following?'只显示你主动关注作者的公开内容。':'分享发现，解决问题，遇见一起学习的人。'}/><section className="reading-column service-home">
    {following?<Tabs items={['关注动态','管理关注']} value={tab==='管理关注'?'管理关注':'关注动态'} onChange={setTab}/>:<Tabs items={['公共交流','找同好','我的参与']} value={tab} onChange={setTab} trailing={tab==='公共交流'&&<div className="home-feed-tools"><details data-popup className="service-filter"><summary><SlidersHorizontal size={15}/>筛选</summary><div><input type="search" aria-label="筛选公开动态" placeholder="关键词…" value={q} onChange={event=>setQ(event.target.value)}/><select aria-label="动态类型" value={kind} onChange={event=>setKind(event.target.value as typeof kind)}><option value="all">全部</option><option value="post">分享发现</option><option value="question">求助</option><option value="resource">资源分享</option></select></div></details><LinkButton onClick={()=>go('news')}>资讯与公告</LinkButton></div>}/>} 
    {following&&tab==='管理关注'?<ServicePeople following/>:!following&&tab==='找同好'?<ServicePeople/>:!following&&tab==='我的参与'?(session?.kind==='authenticated'?<ServiceEntryList query={{view:'participated'}} empty="你发布或回应的讨论会留在这里。"/>:<Empty action={<Primary onClick={()=>go('account')}>登录</Primary>}>登录后查看自己的参与。</Empty>):<>
      {!following&&(session?.kind==='authenticated'?<ServiceEntryEditor kind={action==='question'?'question':'post'} onPublished={()=>setVersion(value=>value+1)}/>:<div className="service-login-prompt"><LinkButton onClick={()=>go('account')}>登录后分享发现或提出问题</LinkButton></div>)}
      <ServiceEntryList query={{view:following?'following':'public',q,kind}} version={version} empty={following?'你关注的人还没有公开分享。':'暂时没有符合条件的公开分享。'}/>
    </>}
  </section></>;
}
function ServiceMarket(){
  const [q,setQ]=useState(''),[type,setType]=useState('all');
  return <><Hero title="资源市场" subtitle="按自己的需要，找到值得慢慢学的内容。"/><section className="reading-column service-market"><div className="service-market-search"><div className="market-search"><Search size={19}/><input type="search" aria-label="搜索公开资源" placeholder="找资料、话题或学习路线…" value={q} onChange={event=>setQ(event.target.value)}/></div><details data-popup className="service-filter"><summary><SlidersHorizontal size={15}/>筛选</summary><div><label>资源形式<select aria-label="资源形式筛选" value={type} onChange={event=>setType(event.target.value)}><option value="all">全部</option><option value="note">知识笔记</option><option value="route">学习路线</option><option value="exercise">练习</option><option value="scene">场景模拟</option><option value="link">链接</option></select></label></div></details></div><ServiceEntryList query={{view:'public',kind:'resource',q,resourceType:type==='all'?undefined:type}} empty="暂时没有符合条件的公开资源。"/></section></>;
}
function ServicePublish(){const {go}=useApp();return <section className="reading-column"><Hero title="分享资源" subtitle="写下内容或介绍，也可以直接粘贴链接。"/><ServiceEntryEditor kind="resource" onPublished={entry=>go('resource',entry.id)}/></section>;}
function ServiceDetail({id}:{id:string}){
  const [entry,setEntry]=useState<ServiceEntry|null>(null),[error,setError]=useState('');
  useEffect(()=>{
    let request:AbortController|null=null,timer:number|undefined,active=true,queued=false;
    const load=async()=>{
      if(request){queued=true;return;}queued=false;const current=new AbortController();request=current;
      try{const value=await communityContent.get(id,current.signal);if(active&&!current.signal.aborted){setEntry(value);setError('');}}
      catch(error){if(active&&!current.signal.aborted){setEntry(null);setError(error instanceof Error?error.message:'暂时无法读取内容。');}}
      finally{if(request===current)request=null;if(queued&&active&&!document.hidden)void load();}
    };
    // Recheck on return, without adding an idle resource-detail polling loop.
    const resume=()=>{if(document.hidden)return;clearTimeout(timer);timer=window.setTimeout(()=>void load(),50);};
    void load();window.addEventListener('focus',resume);window.addEventListener('online',resume);document.addEventListener('visibilitychange',resume);
    return()=>{active=false;clearTimeout(timer);request?.abort();window.removeEventListener('focus',resume);window.removeEventListener('online',resume);document.removeEventListener('visibilitychange',resume);};
  },[id]);
  return <section className="reading-column service-entry-detail">{error?<Empty>{error}</Empty>:entry?<ServiceEntryCard value={entry} detail/>:<p className="meta" role="status">正在读取内容…</p>}</section>;
}
function ServicePeople({following=false}:{following?:boolean}){
  const {go}=useApp();const [q,setQ]=useState(''),[items,setItems]=useState<PublicPerson[]>([]),[error,setError]=useState(''),[version,setVersion]=useState(0),[loading,setLoading]=useState(true),[next,setNext]=useState<number|null>(null);
  useEffect(()=>{const controller=new AbortController();setLoading(true);setError('');void communityContent.people({q,following},controller.signal).then(result=>{setItems(result.items);setNext(result.nextOffset);}).catch(error=>{if(!controller.signal.aborted)setError(error.message);}).finally(()=>{if(!controller.signal.aborted)setLoading(false);});return()=>controller.abort();},[q,following,version]);
  return <div className="people-directory"><div className="market-search"><Search size={18}/><input type="search" aria-label="搜索社区用户" placeholder="搜昵称或兴趣…" value={q} onChange={event=>setQ(event.target.value)}/></div>{error&&<p className="inline-status" role="alert">{error}</p>}{items.map(person=><article className="person-row" key={person.accountId}><ServicePerson person={person} size={52}/><div><button type="button" className="author-name" onClick={()=>go('friends',person.accountId)}>{person.displayName}</button>{person.bio&&<p>{person.bio}</p>}{person.interests.length>0&&<p className="meta">{person.interests.join(' · ')}</p>}</div><ServiceFollow person={person} onChanged={()=>{if(following)setVersion(value=>value+1);}}/></article>)}{loading&&<p className="meta">正在读取用户…</p>}{!loading&&!error&&!items.length&&<Empty>{following?'还没有关注的人。':'没有找到符合条件的用户。'}</Empty>}{next!==null&&<LinkButton onClick={()=>void communityContent.people({q,following,offset:next}).then(result=>{setItems(previous=>[...previous,...result.items]);setNext(result.nextOffset);}).catch(error=>setError(error.message))}>查看更多用户</LinkButton>}</div>;
}
function ServicePublicProfile({id}:{id:string}){
  const [person,setPerson]=useState<PublicPerson|null>(null),[error,setError]=useState('');
  useEffect(()=>{const controller=new AbortController();setPerson(null);setError('');const refresh=()=>{void communityContent.person(id,controller.signal).then(setPerson).catch(error=>{if(!controller.signal.aborted){setPerson(null);setError(error.message);}});};refresh();window.addEventListener('focus',refresh);return()=>{controller.abort();window.removeEventListener('focus',refresh);};},[id]);
  return <section className="reading-column profile-page">{error?<Empty>{error}</Empty>:person?<><div className="profile-heading"><ServiceAvatar name={person.displayName} size={148}/><div className="profile-info"><h1>{person.displayName}</h1>{person.bio&&<p className="lead">{person.bio}</p>}<div className="profile-topics">{person.interests.map(interest=><span className="chip" key={interest}>{interest}</span>)}</div><LearningStatistics value={person.learningStatistics}/></div><div className="profile-actions"><ServiceFollow person={person} alwaysMessage/></div></div><h2 className="service-section-title">公开分享</h2><ServiceEntryList query={{view:'public',authorId:person.accountId}} empty="这位用户还没有公开分享。"/></>:<p className="meta">正在读取公开资料…</p>}</section>;
}
function ServiceSearch({topic,value}:{topic:boolean;value:string}){
  const [q,setQ]=useState(topic?'':value),[tab,setTab]=useState('全部');return <section className="reading-column"><Hero title={topic?`#${value}`:'搜索公开内容'}/>{!topic&&<div className="market-search"><Search size={18}/><input aria-label="搜索公开内容" type="search" value={q} placeholder="输入关键词…" onChange={event=>setQ(event.target.value)}/></div>}<Tabs items={['全部','资源','交流']} value={tab} onChange={setTab}/>{topic||q.trim()?<ServiceEntryList query={{view:'public',q,topic:topic?value:undefined,kind:tab==='资源'?'resource':tab==='交流'?'discussion':'all'}} empty="没有找到符合条件的公开内容。"/>:<Empty>输入关键词，查找公开动态和资源。</Empty>}</section>;
}
