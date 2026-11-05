import { useEffect, useRef } from 'react';
import { Search, SlidersHorizontal, X } from 'lucide-react';
import { useApp } from './context';
import { allResources, names, type DemoState, type PublicFeedView } from './model';
import { allContentTopics, canonicalTopicId, topicIdsFor, topicSearchText } from './contentTopics';
import { discussionPosts, findDiscussion, type DiscussionPost } from './discussions';
import { LinkButton } from './ui';
import { resourcePlainText } from './resourceText';

export function publicFeedPosts(state:DemoState):DiscussionPost[]{
  const ids=[...state.posts.filter(post=>post.scope==='公开').map(post=>post.id),...discussionPosts.filter(post=>!post.groupId).map(post=>post.id)];
  return [...new Set(ids)].map(id=>findDiscussion(state,id)).filter((post):post is DiscussionPost=>{
    if(!post||post.groupId)return false;
    const resource=allResources(state).find(item=>item.id===post.resourceId);
    return resource?.scope!=='仅共学群可见';
  });
}
export function filterPublicFeed(state:DemoState,posts:DiscussionPost[],view:PublicFeedView){
  const topicId=view.topicId?canonicalTopicId(state,view.topicId):'';
  const words=view.query.normalize('NFKC').toLocaleLowerCase().trim().split(/\s+/).filter(Boolean);
  return posts.filter(post=>{
    const kind=post.type==='question'?'求助':post.resourceId?'资源分享':'分享发现';
    if(view.kind!=='全部'&&kind!==view.kind)return false;
    if(topicId&&!topicIdsFor(state,post).includes(topicId))return false;
    const resource=allResources(state).find(item=>item.id===post.resourceId);
    const author=post.author==='me'?state.profile.name:names[post.author];
    const text=resourcePlainText(`${post.title||''} ${post.body} ${resource?.title||''} ${resource?.summary||''} ${author} ${topicSearchText(state,post)}`).normalize('NFKC').toLocaleLowerCase();
    return words.every(word=>text.includes(word));
  });
}
export function hasFeedFilters(view:PublicFeedView){return !!view.query.trim()||!!view.topicId||view.kind!=='全部';}
export function PublicFeedFilters(){
  const {state,patch}=useApp();const view=state.publicFeedView;
  const container=useRef<HTMLDivElement>(null),details=useRef<HTMLDetailsElement>(null);
  const close=()=>{if(details.current){details.current.open=false;details.current.querySelector('summary')?.focus({preventScroll:true});}};
  useEffect(()=>{
    const dismiss=(event:PointerEvent)=>{if(event.target instanceof Node&&!container.current?.contains(event.target)&&details.current)details.current.open=false;};
    document.addEventListener('pointerdown',dismiss);
    return()=>document.removeEventListener('pointerdown',dismiss);
  },[]);
  const options=allContentTopics(state);const topicId=view.topicId?canonicalTopicId(state,view.topicId):'';
  const topicName=options.find(topic=>topic.id===topicId)?.name;
  const change=(values:Partial<PublicFeedView>)=>patch({publicFeedView:{...view,...values,limit:3}});
  const description=[view.query.trim()?`“${view.query.trim().slice(0,12)}${view.query.trim().length>12?'…':''}”`:'',topicName||'',view.kind==='全部'?'':view.kind].filter(Boolean).join(' · ');
  return <div ref={container} className={`public-feed-filters ${hasFeedFilters(view)?'active':''}`} aria-label="公共交流筛选"><details data-popup ref={details} onKeyDown={event=>{if(event.key==='Escape'){event.preventDefault();event.stopPropagation();close();}}} onBlur={event=>{if(event.relatedTarget&&!container.current?.contains(event.relatedTarget))event.currentTarget.open=false;}}>
    <summary title={`筛选${description?` · ${description}`:''}`}><SlidersHorizontal size={16}/><span className="feed-filter-label">筛选</span>{description&&<span className="feed-filter-description">· {description}</span>}</summary>
    <div className="feed-filter-fields"><div className="feed-filter-search"><Search size={17}/><input type="search" aria-label="筛选交流关键词" placeholder="搜索这一区的动态……" maxLength={160} value={view.query} onChange={event=>change({query:event.target.value})}/></div>
      <label>话题<select aria-label="交流话题筛选" value={topicId} onChange={event=>change({topicId:event.target.value})}><option value="">全部话题</option>{options.map(topic=><option key={topic.id} value={topic.id}>{topic.name}</option>)}</select></label>
      <label>类型<select aria-label="动态类型筛选" value={view.kind} onChange={event=>change({kind:event.target.value as PublicFeedView['kind']})}><option value="全部">全部动态</option>{['求助','资源分享','分享发现'].map(kind=><option key={kind}>{kind}</option>)}</select></label>
    </div>
  </details>{hasFeedFilters(view)&&<LinkButton className="text-button feed-filter-clear" aria-label="清除筛选" title="清除筛选" onClick={()=>patch({publicFeedView:{query:'',topicId:'',kind:'全部',limit:3}})}><X size={13}/><span>清除</span></LinkButton>}</div>;
}
