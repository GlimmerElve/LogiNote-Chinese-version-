import { useEffect, useRef, useState } from 'react';
import { ChevronDown, Pin } from 'lucide-react';
import { useApp } from './context';
import { MessageComposer } from './MessageComposer';
import { SharedMessageList } from './Sharing';
import { allGroups, names, type Person } from './model';
import { commentsFor, findDiscussion, pinnedGroupDiscussion } from './discussions';
import { ProfileAvatar } from './ProfileAvatar';
import { Avatar } from './ui';

/** The group page and message-center links use this one conversation history. */
export function GroupChat({groupId,targetMessageId,showTopic=false}:{groupId:string;targetMessageId?:string;showTopic?:boolean}){
  const {state,patch,go}=useApp();const body=useRef<HTMLDivElement>(null),topicPanel=useRef<HTMLDetailsElement>(null),[sent,setSent]=useState('');
  const conversation=`group:${groupId}`;const messages=state.structuredMessages.filter(message=>message.conversation===conversation);
  const group=allGroups(state).find(item=>item.id===groupId),candidate=group?pinnedGroupDiscussion(group):undefined;
  const topic=candidate&&!state.deletedPostIds.includes(candidate.id)?candidate:undefined;
  const historyTopic=topic||findDiscussion(state,`group-question:${groupId}`);
  const history=historyTopic?commentsFor(state,historyTopic.id):[];
  const name=(person:Person)=>person==='me'?state.profile.name:names[person];
  useEffect(()=>{if(showTopic&&topicPanel.current)topicPanel.current.open=true;},[groupId,showTopic]);
  useEffect(()=>{
    if(!historyTopic||!state.joinedGroupIds.includes(groupId))return;
    const oldDraft=state.commentDrafts[historyTopic.id],current=state.messageDrafts[conversation];
    if(!oldDraft?.body.trim()||current?.body.trim()||current?.imageIds.length)return;
    const replyTo=history.find(comment=>comment.id===oldDraft.replyToId);
    const text=replyTo?`回复 ${name(replyTo.author)}：${oldDraft.body}`:oldDraft.body;
    patch({messageDrafts:{...state.messageDrafts,[conversation]:{body:text,imageIds:[]}},commentDrafts:{...state.commentDrafts,[historyTopic.id]:{body:''}}});
  },[groupId,historyTopic?.id]);
  useEffect(()=>{if(!targetMessageId||!body.current)return;const element=body.current.querySelector<HTMLElement>(`[data-message-id="${CSS.escape(targetMessageId)}"]`);if(element)body.current.scrollTop+=element.getBoundingClientRect().top-body.current.getBoundingClientRect().top;},[groupId,targetMessageId]);
  useEffect(()=>{if(sent&&body.current)body.current.scrollTop=body.current.scrollHeight;},[sent]);
  if(!state.joinedGroupIds.includes(groupId))return null;
  return <div className="conversation group-chat-shell" aria-label="群会话室">
    {topic&&<details ref={topicPanel} className="group-chat-topic" data-topic-id={topic.id}><summary><Pin size={17}/><span><small>置顶话题</small><strong>{topic.title}</strong></span><ChevronDown size={17}/></summary><div><p>{topic.body}</p><span className="meta">发起人：<button type="button" className="inline-author" onClick={()=>go(topic.author==='me'?'me':'friends',topic.author)}>{name(topic.author)}</button></span></div></details>}
    <div ref={body} className="conversation-body">
      {history.length>0&&<><p className="chat-history-label">{topic?'此前的话题讨论':`${historyTopic?.title} · 此前讨论`}</p>{history.map(comment=>{
        const target=history.find(item=>item.id===comment.replyToId);
        return <div className={`chat-message ${comment.author==='me'?'mine':''}`} key={comment.id} data-comment-id={comment.id}>{comment.author==='me'?<Avatar size={40}/>:<ProfileAvatar person={comment.author} size={40}/>}<div><b>{name(comment.author)}</b>{target&&<span className="meta">回复 {name(target.author)}</span>}<p className="user-body">{comment.body}</p></div></div>;
      })}</>}
      {messages.length?<SharedMessageList messages={messages}/>:!history.length&&<p className="muted">{topic?'围绕上方话题说说你的理解，或分享相关截图、资源。':'在这里交流问题、分享截图或资源卡片。'}</p>}
    </div>
    <MessageComposer key={conversation} conversation={conversation} topicId={topic?.id} placeholder={topic?'围绕这个话题聊一聊，也可以粘贴截图……':undefined} onSent={setSent}/>
  </div>;
}
