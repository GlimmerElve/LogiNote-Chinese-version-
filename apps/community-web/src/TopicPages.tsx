import { useState } from 'react';
import { ChevronRight, Search } from 'lucide-react';
import { useApp } from './context';
import { allGroups, allResources } from './model';
import { filterPublicFeed, publicFeedPosts } from './PublicFeed';
import { canonicalTopicId, searchTopics, topicIdsFor, topicSearchText } from './contentTopics';
import { Hero, ThreadPost } from './shared';
import { ResourceRows } from './Market';
import { GroupRow } from './Groups';
import { ArrowLink, Empty, Tabs } from './ui';

function ContentResults({mode,topicId,query=''}:{mode:string;topicId?:string;query?:string}){
  const {state}=useApp();const [limit,setLimit]=useState(3);
  const matches=(item:{topicIds?:string[];topic?:string;resourceId?:string;groupId?:string},text:string)=>(!topicId||topicIdsFor(state,item).includes(topicId))&&`${text} ${topicSearchText(state,item)}`.toLowerCase().includes(query.toLowerCase());
  const foundPosts=filterPublicFeed(state,publicFeedPosts(state),{query,topicId:topicId||'',kind:'全部',limit:3});
  const resources=allResources(state).filter(resource=>resource.scope!=='仅共学群可见'&&matches(resource,`${resource.title} ${resource.summary} ${resource.kind}`));
  const groups=allGroups(state).filter(group=>matches(group,`${group.name} ${group.description}`));
  const count=mode==='动态'?foundPosts.length:mode==='资源'?resources.length:groups.length;
  return <>{!count?<Empty>这里暂时没有相关{mode}。</Empty>:mode==='动态'?foundPosts.slice(0,limit).map(post=><ThreadPost key={post.id} id={post.id}/>):mode==='资源'?<ResourceRows items={resources.slice(0,limit)}/>:groups.slice(0,limit).map(group=><GroupRow key={group.id} group={group}/>)}{count>limit&&<button className="load-more" onClick={()=>setLimit(limit+3)}>查看更多{mode}<ChevronRight size={16}/></button>}</>;
}
export function TopicPage(){
  const {state,resourceId,go}=useApp();const [tab,setTab]=useState('动态');const id=canonicalTopicId(state,resourceId);const topic=state.topicCatalog.find(item=>item.id===id);
  if(!topic)return <section className="reading-column"><h1>没有找到这个话题</h1><ArrowLink onClick={()=>go('search')}>搜索其他话题</ArrowLink></section>;
  return <section className="reading-column topic-page"><div className="breadcrumb"><a href="#/home">首页</a><span>/</span><span>话题</span></div><Hero title={`#${topic.name}`} subtitle={topic.description||'围绕这个话题，交流发现与问题。'}/><Tabs items={['动态','资源','共学']} value={tab} onChange={setTab}/><ContentResults key={`${id}-${tab}`} mode={tab} topicId={id}/></section>;
}
export function SearchPage(){
  const {state,resourceId,go}=useApp();const [query,setQuery]=useState(resourceId);const [tab,setTab]=useState(searchTopics(state,resourceId).length?'话题':'资源');
  const found=searchTopics(state,query);const [limit,setLimit]=useState(6);
  return <section className="reading-column search-page"><Hero title="搜索" subtitle="从一个话题或具体问题开始。"/><div className="market-search"><Search size={19}/><input autoFocus type="search" aria-label="搜索社区" placeholder="搜索话题、动态、资源或共学……" value={query} onChange={event=>{setQuery(event.target.value);setLimit(6);}}/></div>
    <Tabs items={['话题','动态','资源','共学']} value={tab} onChange={setTab}/>{!query.trim()?<Empty>输入你想了解的内容。</Empty>:tab==='话题'?<>{found.slice(0,limit).map(topic=><article className="topic-search-row" key={topic.id}><button type="button" className="heading-button" onClick={()=>go('topic',topic.id)}>#{topic.name}</button>{topic.description&&<p>{topic.description}</p>}</article>)}{!found.length&&<Empty>没有找到相关话题，可以切换查看动态或资源。</Empty>}{found.length>limit&&<button className="load-more" onClick={()=>setLimit(limit+6)}>查看更多话题<ChevronRight size={16}/></button>}</>:<ContentResults key={`${query}-${tab}`} query={query} mode={tab}/>}
  </section>;
}
