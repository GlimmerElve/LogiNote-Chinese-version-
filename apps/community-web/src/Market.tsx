import { ChevronRight, FileText, Search, SlidersHorizontal } from 'lucide-react';
import { useApp } from './context';
import { allResources, names, type Resource } from './model';
import { allContentTopics, canonicalTopicId, topicIdsFor, topicSearchText } from './contentTopics';
import { Hero, ResourceCover, ScenarioContent } from './shared';
import { ProfileAvatar } from './ProfileAvatar';
import { ArrowLink, Empty, LinkButton, Primary } from './ui';
import { TopicLinks } from './TopicLinks';

export function ResourceRows({items}:{items:Resource[]}){
  const {state,go,open}=useApp();
  return <div className="market-list">{items.map(resource=><article className="market-row" key={resource.id}>
    <ResourceCover resource={resource}/><div className="resource-copy"><h2><button className="heading-button" onClick={()=>open({kind:'resource',id:resource.id})}>{resource.title}</button></h2>
      <div className="resource-author"><ProfileAvatar person={resource.author} size={36}/><button className="author-name" onClick={()=>go(resource.author==='me'?'me':'friends',resource.author)}>{resource.author==='me'?state.profile.name:names[resource.author]}</button></div>
      <p>{resource.summary}</p><span className="meta">{resource.kind}</span><TopicLinks content={resource}/>
    </div><ArrowLink onClick={()=>open({kind:'resource',id:resource.id})}>查看</ArrowLink>
  </article>)}</div>;
}
export function MarketPage(){
  const {state,go,marketView,setMarketView}=useApp();const {query,topic,limit}=marketView;const kind=marketView.kind||'全部';const selectedTopic=topic==='全部'?'全部':canonicalTopicId(state,topic);
  const change=(values:Partial<typeof marketView>)=>setMarketView({...marketView,...values,limit:3});
  const options=allContentTopics(state),topicName=options.find(t=>t.id===selectedTopic)?.name;
  const found=allResources(state).filter(resource=>resource.scope!=='仅共学群可见'&&(selectedTopic==='全部'||topicIdsFor(state,resource).includes(selectedTopic))&&(kind==='全部'||resource.kind===kind)&&`${resource.title} ${resource.summary} ${resource.kind} ${topicSearchText(state,resource)}`.toLowerCase().includes(query.toLowerCase()));
  return <><Hero title="资源市场" subtitle="找到现在用得上的资料，按自己的节奏学习。"/><section className="market-column">
    <div className="market-top-action"><Primary onClick={()=>go('publish')}><FileText size={18}/>分享资源</Primary></div>
    <div className="market-search-area"><div className="market-search"><Search/><input type="search" aria-label="搜索资源市场" placeholder="找资料、话题或学习路线……" value={query} onChange={event=>change({query:event.target.value})}/></div>
    <details data-popup className={`market-filters ${topic!=='全部'||kind!=='全部'?'active':''}`}><summary aria-label="筛选资源" title={`筛选资源${topicName?` · ${topicName}`:''}${kind!=='全部'?` · ${kind}`:''}`}><SlidersHorizontal size={16}/><span>筛选</span></summary><div>
      <label>类型<select aria-label="资源类型筛选" value={kind} onChange={event=>change({kind:event.target.value})}>{['全部','知识笔记','学习路线','练习','学习经验','链接资料'].map(value=><option key={value}>{value}</option>)}</select></label>
      <label>话题<select aria-label="资源话题筛选" value={selectedTopic} onChange={event=>change({topic:event.target.value})}><option value="全部">全部话题</option>{options.map(item=><option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
      {(topic!=='全部'||kind!=='全部')&&<LinkButton onClick={()=>change({topic:'全部',kind:'全部'})}>清除筛选</LinkButton>}
    </div></details></div>
    <ScenarioContent><ResourceRows items={found.slice(0,limit)}/>{!found.length?<Empty>没有找到相关资源，试试其他关键词或清除筛选。</Empty>:limit<found.length?<button className="load-more" onClick={()=>setMarketView({...marketView,limit:limit+6})}>查看更多<ChevronRight size={17}/></button>:<p className="end-note">已显示这些资源。</p>}</ScenarioContent>
  </section></>;
}
