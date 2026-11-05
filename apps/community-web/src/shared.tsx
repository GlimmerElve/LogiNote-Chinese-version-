import type { ReactNode } from 'react';
import { ArrowRight, ArrowUpRight, Bookmark, FileText, MoreHorizontal, Share2 } from 'lucide-react';
import { Art, Empty, LinkButton, Primary } from './ui';
import { allResources, names, resources, type Person, type Resource } from './model';
import { useApp } from './context';
import { ProfileAvatar } from './ProfileAvatar';
import { Comments } from './Comments';
import { canReadDiscussion, findDiscussion } from './discussions';
import { TopicLinks } from './TopicLinks';
import { ResourceBody } from './ResourceBody';

export function Hero({title,subtitle,children}:{title:string;subtitle?:string;children?:ReactNode}){
  return <section className="hero"><h1>{title}</h1>{subtitle&&<p>{subtitle}</p>}{children}</section>;
}
export function ScenarioContent({children}:{children:ReactNode}){
  const {scenario,setScenario}=useApp();if(scenario==='正常')return <>{children}</>;
  return <div className="scenario-result" aria-busy={scenario==='加载中'}><Empty action={<LinkButton onClick={()=>setScenario('正常')}>{scenario==='加载失败'?'重新加载':'返回演示内容'}</LinkButton>}>{scenario==='加载中'?'正在加载相关内容…':scenario==='空内容'?'这个方向还没有相关内容。':scenario==='加载失败'?'暂时无法加载，已保留你的位置与草稿。':'当前没有访问权限，草稿已保留。'}</Empty></div>;
}
export function FollowButton({person}:{person:Person}){
  const {state,patch}=useApp();if(person==='me')return null;
  const active=state.followedPeople.includes(person);
  return <LinkButton aria-label={`${active?'取消关注':'关注'}${names[person]}`} aria-pressed={active} onClick={()=>patch({followedPeople:active?state.followedPeople.filter(p=>p!==person):[...state.followedPeople,person]})}>{active?'已关注':'关注'}</LinkButton>;
}
export function Author({person='he',meta='分享了学习路线 · 数学 · 4月12日'}:{person?:Person;meta?:string}){
  const {go,state}=useApp();const name=person==='me'?state.profile.name:names[person];
  return <div className="author"><ProfileAvatar person={person}/><div><button className="author-name" onClick={()=>go(person==='me'?'me':'friends',person)}>{name}</button><span className="meta">{meta}</span></div></div>;
}
export function More({target,postId}:{target:string;postId?:string}){const {open,deletePost}=useApp();
  if(postId){return <details data-popup className="post-menu more" onBlur={e=>{if(!e.currentTarget.contains(e.relatedTarget))e.currentTarget.open=false;}} onKeyDown={e=>{if(e.key==='Escape'){e.currentTarget.open=false;e.currentTarget.querySelector('summary')?.focus();}}}><summary aria-label={target+'更多操作'} className="icon-button"><MoreHorizontal/></summary><div className="post-menu-content"><button type="button" onClick={()=>deletePost(postId)}>删除动态</button><p className="meta">仅删除动态，已分享的资源仍保留。</p></div></details>;}
  return <button className="icon-button more" aria-label={`${target}更多操作`} onClick={()=>open({kind:'feedback',target})}><MoreHorizontal/></button>;}
export function BookmarkButton({id}:{id:string}){const {state,bookmark}=useApp();const active=state.bookmarks.includes(id);return <LinkButton aria-pressed={active} onClick={()=>bookmark(id)}><Bookmark size={19} fill={active?'currentColor':'none'}/>{active?'已收藏':'收藏'}</LinkButton>;}
export function ResourceCover({resource,className=''}:{resource:Resource;className?:string}){
  if(resource.cover)return <div className={`resource-art uploaded-cover ${className}`}><img src={resource.cover} alt={`${resource.title}的封面`}/></div>;
  if(resources.some(r=>r.id===resource.id))return <Art type={resource.art} className={className}/>;
  return <div className={`resource-art text-cover ${className}`} aria-label="资源类型图标，无封面"><FileText size={30}/><span>{resource.kind}</span></div>;
}
export function ResourceStrip({id='linear',attribution=false}:{id?:string;attribution?:boolean}){
  const {open,state,go}=useApp();const r=allResources(state).find(r=>r.id===id);
  if(!r)return <p className="muted">这份资源暂不可用。</p>;
  if(r.scope==='仅共学群可见'&&r.author!=='me'&&!state.joinedGroupIds.includes(r.groupId||''))return <p className="muted">仅共学群成员可以查看此资源。</p>;
  return <div className="resource-strip" data-resource-id={r.id}><ResourceCover resource={r}/><div className="strip-copy"><h3>{r.title}</h3><span className="meta">{r.kind} · {attribution?<><button type="button" className="inline-author" onClick={()=>go(r.author==='me'?'me':'friends',r.author)}>{r.author==='me'?state.profile.name:names[r.author]}</button> · </>:null}{r.scope||'公开'}</span><p>{r.summary}</p></div><Primary onClick={()=>open({kind:'resource',id:r.id})}>查看{r.kind==='学习路线'?'这份路线':'资源'}<ArrowRight size={17}/></Primary></div>;
}
export function PostActions({threadId,resourceId,full=false,extraActions}:{threadId:string;resourceId?:string;full?:boolean;extraActions?:ReactNode}){
  const {open}=useApp();
  return <Comments key={threadId} threadId={threadId} full={full} actions={<><BookmarkButton id={resourceId||threadId}/>{resourceId&&<LinkButton onClick={e=>open({kind:'share',id:resourceId,anchor:e.currentTarget.getBoundingClientRect()})}><Share2 size={18}/>分享资源</LinkButton>}{extraActions}</>}/>;
}
export function ThreadPost({id,detail=false,extraActions}:{id:string;detail?:boolean;extraActions?:ReactNode}){
  const {state,go}=useApp();const post=findDiscussion(state,id);
  if(!post||!canReadDiscussion(state,post))return null;
  const deletable=post.author==='me'&&(state.posts.some(p=>p.id===id)||['seed-gradient','seed-summary'].includes(id));
  return <article className={detail?'post discussion-original':'post'} data-author={post.author} data-post-id={id}>
    <Author person={post.author} meta={`${post.groupId?'仅共学群可见':'公开分享'} · 本机演示`}/>
    <div className="post-tools">{!detail&&<button type="button" className="icon-button post-detail-button" aria-label="查看讨论详情" title="查看详情" onClick={()=>go('discussion',id)}><ArrowUpRight size={18}/></button>}<More target={post.title||post.body.slice(0,20)||'资源分享'} postId={deletable?id:undefined}/></div>
    <div className="post-body">{post.title&&(detail?<h1>{post.title}</h1>:<h2>{post.title}</h2>)}
      {post.body&&(post.bodyFormat==='markdown'?<div className="original-post-body post-markdown"><ResourceBody body={post.body}/></div>:<p className="user-body original-post-body">{post.body}</p>)}{post.resourceId&&<ResourceStrip id={post.resourceId} attribution/>}
      <TopicLinks content={post}/><PostActions threadId={id} resourceId={post.resourceId} full={detail} extraActions={extraActions}/>
    </div>
  </article>;
}
export function RoutePost(){return <ThreadPost id="linear"/>;}
export function QuestionPost(){return <ThreadPost id="question-gradient"/>;}
export function DemoPosts({scope,groupId}:{scope?:string;groupId?:string}){
  const {state}=useApp();return <>{state.posts.filter(p=>(!scope||p.scope===scope)&&(!groupId||(p.groupId||'linear')===groupId)).map(p=><ThreadPost key={p.id} id={p.id}/>)}</>;
}
