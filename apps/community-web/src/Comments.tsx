import { useId, useRef, useState, type ReactNode } from 'react';
import { MessageCircle } from 'lucide-react';
import { useApp } from './context';
import { ProfileAvatar } from './ProfileAvatar';
import { names, type CommunityComment } from './model';
import { canReadDiscussion, commentsFor, findDiscussion } from './discussions';
import { Avatar, LinkButton, Primary } from './ui';

/** One thread per original post, shared by feed previews and detail pages. */
export function Comments({threadId,full=false,actions}:{threadId:string;full?:boolean;actions?:ReactNode}) {
  const {state,patch,go}=useApp();
  const post=findDiscussion(state,threadId);
  const comments=commentsFor(state,threadId);
  const roots=comments.filter(c=>!c.parentId);
  const draft=state.commentDrafts[threadId]||{body:''};
  const [editing,setEditing]=useState(full||!!draft.body);
  const [limit,setLimit]=useState(20);
  const [expanded,setExpanded]=useState<string[]>([]);
  const [allOpen,setAllOpen]=useState(false);
  const input=useRef<HTMLTextAreaElement>(null);
  const editorId=useId();
  const listId=useId();
  if(!post||!canReadDiscussion(state,post))return null;
  const name=(person:CommunityComment['author'])=>person==='me'?state.profile.name:names[person];
  const target=comments.find(c=>c.id===draft.replyToId);
  const showAll=full||allOpen;
  const previewRoots=roots.slice(-2);
  const previewCount=previewRoots.reduce((count,root)=>count+1+Math.min(1,comments.filter(c=>c.parentId===root.id).length),0);
  const update=(body:string,replyToId=draft.replyToId)=>patch({commentDrafts:{...state.commentDrafts,[threadId]:{body,replyToId}}});
  const respond=(comment?:CommunityComment)=>{
    update(draft.body,comment?.id||'');setEditing(true);
    requestAnimationFrame(()=>input.current?.focus({preventScroll:true}));
  };
  const renderComment=(comment:CommunityComment,nested=false)=>{
    const replyTo=comments.find(c=>c.id===comment.replyToId);
    return <div className={`community-comment ${nested?'nested':''}`} key={comment.id} data-comment-id={comment.id}>
      <ProfileAvatar person={comment.author} size={nested?26:30}/>
      <div className="comment-copy"><button type="button" className="author-name" onClick={()=>go(comment.author==='me'?'me':'friends',comment.author)}>{name(comment.author)}</button>
        {nested&&replyTo&&<span className="comment-recipient"> 回复 {name(replyTo.author)}</span>}
        <p className="user-body">{comment.body}</p>
        <LinkButton onClick={()=>respond(comment)}>回复</LinkButton>
      </div>
    </div>;
  };
  return <section className={`comments ${full?'comments-full':'comments-preview'}`} data-thread-id={threadId} aria-label="评论区">
    <div className="post-actions"><LinkButton aria-expanded={editing} aria-controls={editorId} onClick={()=>respond()}><MessageCircle size={18}/>{full?'写评论':'回应'}</LinkButton>{actions}</div>
    {full&&<h2 className="comments-heading">评论{comments.length?` · ${comments.length}`:''}</h2>}
    <div className="comment-list" id={listId}>{(showAll?roots.slice(0,limit):previewRoots).map(root=>{
      const replies=comments.filter(c=>c.parentId===root.id);
      const shown=showAll?(expanded.includes(root.id)?replies:replies.slice(0,3)):replies.slice(-1);
      return <div className="comment-thread" key={root.id}>{renderComment(root)}{shown.length>0&&<div className="comment-replies">{shown.map(c=>renderComment(c,true))}</div>}{showAll&&replies.length>shown.length&&<LinkButton className="text-button more-replies" onClick={()=>setExpanded([...expanded,root.id])}>展开其余 {replies.length-shown.length} 条回复</LinkButton>}</div>;
    })}</div>
    {showAll&&roots.length>limit&&<LinkButton onClick={()=>setLimit(limit+20)}>加载更多评论</LinkButton>}
    {!full&&(allOpen||comments.length>previewCount)&&<LinkButton className="text-button discussion-detail-link" aria-expanded={allOpen} aria-controls={listId} onClick={()=>setAllOpen(!allOpen)}>{allOpen?'收起讨论':`查看全部讨论（${comments.length}）`}</LinkButton>}
    {full&&!comments.length&&<p className="meta">还没有评论，分享你的理解或疑问吧。</p>}
    {editing&&<form id={editorId} className="inline-comment-form" onSubmit={e=>{
      e.preventDefault();if(!draft.body.trim())return;
      const comment:CommunityComment={id:`comment-${crypto.randomUUID()}`,threadId,author:'me',body:draft.body.trim(),parentId:target?(target.parentId||target.id):undefined,replyToId:target?.id};
      patch({comments:[...state.comments,comment],commentDrafts:{...state.commentDrafts,[threadId]:{body:''}}});
      if(comment.parentId)setExpanded([...new Set([...expanded,comment.parentId])]);
      setLimit(Math.max(limit,roots.length+1));
      input.current?.focus({preventScroll:true});
    }}>
      <div className="comment-input-row"><Avatar size={32}/><textarea ref={input} aria-label="讨论回复" placeholder={target?`回复 ${name(target.author)}…`:'写下你的理解或疑问…'} value={draft.body} onChange={e=>update(e.target.value)}/></div>
      <div className="comment-form-actions"><span className="meta">仅存本机演示</span>{!full&&<LinkButton onClick={()=>setEditing(false)}>收起</LinkButton>}<Primary type="submit" disabled={!draft.body.trim()}>{target?`回复 ${name(target.author)}`:'发表回应'}</Primary></div>
    </form>}
  </section>;
}
