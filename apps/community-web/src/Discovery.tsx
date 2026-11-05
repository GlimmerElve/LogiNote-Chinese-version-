import { useState } from 'react';
import { ChevronRight, Search } from 'lucide-react';
import { useApp } from './context';
import { ProfileAvatar } from './ProfileAvatar';
import { people } from './model';
import { Avatar, ArrowLink, Empty, LinkButton, Tabs } from './ui';
import { DemoPosts, FollowButton, Hero, QuestionPost, RoutePost, ScenarioContent, ThreadPost } from './shared';
import { Composer } from './Composer';
import { filterPublicFeed, hasFeedFilters, publicFeedPosts, PublicFeedFilters } from './PublicFeed';

export function HomePage({following=false}:{following?:boolean}){
  const {state,patch,go,open,resourceId}=useApp();
  const [tab,setTab]=useState(resourceId==='people'?'找同好':'公共交流');const [followingLimit,setFollowingLimit]=useState(3);
  const view=state.publicFeedView;const limit=following?followingLimit:view.limit;
  const filtered=!following&&hasFeedFilters(view);
  const publicPosts=publicFeedPosts(state);
  const entries=following?publicPosts.filter(post=>state.followedPeople.includes(post.author)):filterPublicFeed(state,publicPosts,view);
  return <><Hero title={following?'关注的人，正在分享什么':'与你一起，慢慢学深'} subtitle={following?'这里只显示你已关注作者的公开动态。':'社区首页 · 看见新的发现，遇见尚未认识的同行者。'}/><section className="reading-column">
    {following?<div className="section-toolbar"><span>关注动态</span><LinkButton onClick={()=>open({kind:'manageFollowing'})}>管理关注的人<ChevronRight size={15}/></LinkButton></div>:<div className="home-feed-toolbar"><Tabs items={['公共交流','找同好','我的参与']} value={tab} onChange={setTab} trailing={<div className="home-feed-tools">{tab==='公共交流'&&<PublicFeedFilters/>}<LinkButton className="text-button home-news-action" aria-label="关注资讯" onClick={()=>go('news')}><span className="home-news-label">关注资讯</span><span className="home-news-short" aria-hidden="true">资讯</span><ChevronRight size={15}/></LinkButton></div>}/></div>}
    {!following&&tab==='公共交流'&&<Composer/>}
    <ScenarioContent>{!following&&tab==='找同好'?<PeopleDirectory/>:!following&&tab==='我的参与'?<>{state.posts.length?<DemoPosts/>:<Empty>发过的分享与参与过的讨论会留在这里。</Empty>}</>:entries.length?<>{entries.slice(0,limit).map(entry=><ThreadPost id={entry.id} key={entry.id}/>)}{entries.length>limit&&<button className="load-more" onClick={()=>following?setFollowingLimit(value=>value+3):patch({publicFeedView:{...view,limit:view.limit+3}})}>查看更多交流<ChevronRight size={16}/></button>}</>:<Empty action={filtered?<LinkButton onClick={()=>patch({publicFeedView:{query:'',topicId:'',kind:'全部',limit:3}})}>查看全部动态</LinkButton>:<ArrowLink onClick={()=>go('home','people')}>到公共区域找同好</ArrowLink>}>{following?'还没有关注的作者动态。去公共交流或找同好，点击“关注”后再来这里。':filtered?'没有符合这些条件的动态。可以减少关键词、切换话题或清除筛选。':'暂时没有公开分享。'}</Empty>}</ScenarioContent>
    {!following&&tab==='公共交流'&&<div className="friend-banner"><h3>找个同行的人</h3><p>按兴趣和学习目标，认识尚未关注的作者。</p><ArrowLink onClick={()=>setTab('找同好')}>找同好</ArrowLink></div>}
  </section></>;
}
export function PeopleDirectory(){
  const {go}=useApp();const [query,setQuery]=useState('');
  const found=people.filter(p=>`${p.name} ${p.bio} ${p.goal} ${p.interests.join(' ')}`.toLowerCase().includes(query.toLowerCase()));
  return <div className="people-directory"><p className="muted">从公开分享中认识彼此。关注是单向订阅，不需要对方同意。</p><div className="market-search"><Search size={19}/><input type="search" aria-label="搜索同好" placeholder="搜名字、兴趣或学习目标……" value={query} onChange={e=>setQuery(e.target.value)}/></div>{found.length?found.map(p=><article className="person-row" key={p.id}><ProfileAvatar person={p.id} size={56}/><div><button className="author-name" onClick={()=>go('friends',p.id)}>{p.name}</button><p>{p.bio}</p><span className="meta">正在探索：{p.goal}</span></div><FollowButton person={p.id}/></article>):<Empty>没有找到相关的人，试试其他名字或方向。</Empty>}</div>;
}
export function ManageFollowing(){const {state,go}=useApp();const found=people.filter(p=>state.followedPeople.includes(p.id));return <><p className="muted">只影响“关注”页，不会向对方发送申请或提醒。</p>{found.length?found.map(p=><div className="person-row" key={p.id}><ProfileAvatar person={p.id}/><button className="author-name" onClick={()=>go('friends',p.id)}>{p.name}</button><FollowButton person={p.id}/></div>):<Empty action={<ArrowLink onClick={()=>go('home','people')}>到公共区域找同好</ArrowLink>}>还没有关注作者。</Empty>}</>;}
export function PeopleProfile(){
  const {resourceId,go}=useApp();const person=people.find(p=>p.id===resourceId)||people[0];const [tab,setTab]=useState('公开分享');
  return <section className="reading-column profile-page"><div className="breadcrumb"><a href="#/home/people">公共区域</a><span>/</span><span>{person.name}</span></div><div className="profile-heading"><Avatar person={person.id} size={148}/><div className="profile-info"><h1>{person.name}</h1><p className="lead">{person.bio}</p><div className="profile-topics">{person.interests.map(t=><span className="chip" key={t}>{t}</span>)}</div><p className="goal">正在探索：{person.goal}</p></div><div className="profile-actions"><FollowButton person={person.id}/><LinkButton onClick={()=>go('messages',person.id)}>打个招呼</LinkButton></div></div><Tabs items={['公开分享','学习目标']} value={tab} onChange={setTab}/>{tab==='学习目标'?<div className="goal-panel"><h2>{person.goal}</h2><p>仅展示作者主动公开的内容。</p></div>:person.id==='he'?<RoutePost/>:person.id==='lin'?<ThreadPost id="matrix"/>:<QuestionPost/>}</section>;
}
