import {formatShareText} from './shareText';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { ArrowLeft, ChevronRight, Share2, UsersRound } from 'lucide-react';
import { useApp } from './context';
import { ProfileAvatar } from './ProfileAvatar';
import { allGroups, allResources, names, people, type Person, type SharedMessage } from './model';
import { Avatar, ArrowLink, Empty, LinkButton, Primary, Tabs } from './ui';
import { Hero, ResourceStrip, ScenarioContent } from './shared';
import { topicIdsFor } from './contentTopics';
import { MessageComposer } from './MessageComposer';
import { MessageImages } from './MessageImages';
import { ConversationMenu } from './ConversationMenu';

export function SharePanel({id}:{id:string}){
  const {state,patch,go}=useApp();const resource=allResources(state).find(r=>r.id===id);const invite=id.startsWith('group:')?allGroups(state).find(g=>g.id===id.slice(6)):undefined;
  const [destination,setDestination]=useState(resource?.scope==='仅共学群可见'?'共学群':'私信');const [recipient,setRecipient]=useState('');const [body,setBody]=useState('');const [status,setStatus]=useState('');const [sent,setSent]=useState(false);const [conversation,setConversation]=useState('');const [sentMessageId,setSentMessageId]=useState('');
  if(!resource&&!invite)return <Empty>找不到要分享的内容。</Empty>;
  const restricted=resource?.scope==='仅共学群可见';
  const groups=allGroups(state).filter(g=>state.joinedGroupIds.includes(g.id)&&(!restricted||g.id===resource?.groupId));
  const allowed=destination==='公开动态'?!restricted:destination==='私信'?!restricted&&!state.blockedPeople.includes(recipient as Person)&&people.some(p=>p.id===recipient):groups.some(g=>g.id===recipient);
  const submit=(e:FormEvent)=>{
    e.preventDefault();if(!allowed||sent)return;
    if(destination==='公开动态'&&resource){patch({posts:[{id:`repost-${Date.now()}`,body:body.trim()||'分享一份值得慢慢读的资源。',type:'discovery',topicIds:topicIdsFor(state,resource),scope:'公开',resourceId:resource.id},...state.posts]});setStatus('演示：资源卡片已加入本机公共交流，未对外发布。');}
    else {const target=destination==='共学群'?`group:${recipient}`:recipient;const message:SharedMessage={id:`share-${Date.now()}`,conversation:target,body:body.trim(),resourceId:resource?.id,groupId:invite?.id};patch({structuredMessages:[...state.structuredMessages,message]});setConversation(target);setSentMessageId(message.id);setStatus('演示：已把资源卡片记入本机会话，未实际发送。');}
    setSent(true);
  };
  return <form className="share-panel" onSubmit={submit}>{resource?<ResourceStrip id={resource.id} attribution/>:<GroupInviteCard id={invite!.id}/>}<p className="meta">分享的是指向原内容的卡片，保留作者和访问范围。</p><Tabs items={restricted?['共学群']:invite?['私信','共学群']:['私信','共学群','公开动态']} value={destination} onChange={v=>{setDestination(v);setRecipient('');setSent(false);setStatus('');}}/>{restricted&&<p className="inline-status">仅群内资源只能分享到原共学群，不会转为公开内容。</p>}
  {destination==='私信'&&<label className="field-label">发给谁<select aria-label="选择分享接收人" value={recipient} onChange={e=>{setRecipient(e.target.value);setSent(false);}}><option value="">选择接收人</option>{people.map(p=><option value={p.id} key={p.id} disabled={state.blockedPeople.includes(p.id)}>{p.name}{state.blockedPeople.includes(p.id)?'（已拉黑）':''}</option>)}</select></label>}
  {destination==='共学群'&&<label className="field-label">分享到<select aria-label="选择分享共学群" value={recipient} onChange={e=>{setRecipient(e.target.value);setSent(false);}}><option value="">选择已加入的共学群</option>{groups.map(g=><option value={g.id} key={g.id}>{g.name}</option>)}</select></label>}
  <textarea aria-label="分享留言（可选）" placeholder="想说点什么（可选）……" value={body} onChange={e=>setBody(e.target.value)}/>{status&&<p className="inline-status" role="status">{status}</p>}<div className="panel-actions"><Primary type="submit" disabled={!allowed||sent}>{sent?'已记入本机':destination==='公开动态'?'分享到公共交流':'分享卡片'}</Primary>{sent&&<ArrowLink onClick={()=>go(destination==='公开动态'?'home':'messages',conversation?`${conversation}~${sentMessageId}`:undefined)}>查看分享</ArrowLink>}</div>
  {resource&&<div className="center-link"><LinkButton onClick={async()=>{try{await navigator.clipboard.writeText(formatShareText(resource.title,`${location.origin}${location.pathname}#/resource/${resource.id}`));setStatus('标题与本地预览链接已复制；不会改变资源的可见范围。');}catch{setStatus('暂时无法复制，可在资源独立页面复制地址。');}}}>复制资源链接</LinkButton><p className="meta">目前为本地预览地址，部署后才能用于跨设备访问。</p></div>}</form>;
}
function GroupInviteCard({id}:{id:string}){const {state,go}=useApp();const group=allGroups(state).find(g=>g.id===id);if(!group)return <p className="muted">共学邀请已失效。</p>;return <div className="group-invite-card" data-group-id={id}><UsersRound size={27}/><div><h3>{group.name}</h3><p>{group.description||'一起交流和学习。'}</p><span className="meta">共学邀请 · {group.policy==='open'?'开放加入':'申请加入'}</span></div><ArrowLink onClick={()=>go('group',id)}>查看共学</ArrowLink></div>;}
export function SharedMessageList({messages}:{messages:SharedMessage[]}){
  return <>{messages.map(m=><div className="chat-message mine shared-message" data-message-id={m.id} data-topic-id={m.topicId} key={m.id}><Avatar size={40}/><div><span className="meta">本机演示消息 · 未发送</span>{m.body&&<p className="user-body">{m.body}</p>}<MessageImages ids={m.imageIds}/>{m.resourceId&&<ResourceStrip id={m.resourceId} attribution/>} {m.groupId&&<GroupInviteCard id={m.groupId}/>}</div></div>)}</>;
}
export function MessagesPage(){
  const {state,patch,resourceId,go,open}=useApp();const groups=allGroups(state).filter(g=>state.joinedGroupIds.includes(g.id));
  const validConversation=(id:string)=>people.some(p=>p.id===id)||groups.some(g=>`group:${g.id}`===id);
  const desired=resourceId.split('~')[0],targetMessageId=resourceId.split('~')[1];
  const visiblePeople=people.filter(person=>!state.hiddenConversations.includes(person.id));
  const first=validConversation(desired)?desired:visiblePeople[0]?.id||'';
  const [active,setActive]=useState(first);const [tab,setTab]=useState(first.startsWith('group:')?'共学群':'私信');const [mobileOpen,setMobileOpen]=useState(false);const [lastSent,setLastSent]=useState('');const [deletedConversation,setDeletedConversation]=useState<Person|null>(null);const messageBody=useRef<HTMLDivElement>(null);
  useEffect(()=>{if(validConversation(desired)&&desired.startsWith('group:')){go('group',`${desired.slice(6)}~chat${targetMessageId?'~'+targetMessageId:''}`);return;}if(validConversation(desired)){if(state.hiddenConversations.includes(desired))patch({hiddenConversations:state.hiddenConversations.filter(id=>id!==desired)});setActive(desired);setTab(desired.startsWith('group:')?'共学群':'私信');setMobileOpen(true);}},[resourceId]);
  useEffect(()=>{if(!targetMessageId||active!==desired)return;const frame=requestAnimationFrame(()=>{const body=document.querySelector<HTMLElement>('.conversation-body');const target=body?.querySelector<HTMLElement>(`[data-message-id="${CSS.escape(targetMessageId)}"]`);if(body&&target)body.scrollTop+=target.getBoundingClientRect().top-body.getBoundingClientRect().top;});return()=>cancelAnimationFrame(frame);},[active,resourceId]);
  const isGroup=active.startsWith('group:');const group=groups.find(g=>`group:${g.id}`===active);const person:Person=people.some(p=>p.id===active)?active as Person:'lin';const title=isGroup?(group?.name||'共学群不可访问'):active?names[person]:'暂无会话';
  const messages=state.structuredMessages.filter(m=>m.conversation===active);
  useEffect(()=>{if(!lastSent)return;const frame=requestAnimationFrame(()=>{const body=messageBody.current;if(body)body.scrollTop=body.scrollHeight;});return()=>cancelAnimationFrame(frame);},[lastSent]);
  const choose=(id:string)=>{setActive(id);setMobileOpen(true);};
  if(tab==='共学群')return <><Hero title="消息" subtitle="在方便的时候，再回应。"><div className="topic-picker">{['私信','共学群'].map(value=><button className={`chip ${tab===value?'active':''}`} key={value} onClick={()=>{setTab(value);setActive('lin');}}>{value}</button>)}</div></Hero><section className="reading-column group-inbox">{groups.length?groups.map(item=>{
    const last=state.structuredMessages.filter(message=>message.conversation===`group:${item.id}`).at(-1);
    return <button type="button" className="group-inbox-row" key={item.id} onClick={()=>go('group',`${item.id}~chat${last?'~'+last.id:''}`)}><UsersRound size={32}/><span><b>{item.name}</b><small>{last?.body||((last?.imageIds?.length)?'图片或表情包':last?.resourceId?'分享的资源':'进入群交流')}</small></span><ChevronRight size={17}/></button>;
  }):<Empty action={<ArrowLink onClick={()=>go('groups')}>找共学</ArrowLink>}>还没有参与的共学群。</Empty>}</section></>;
  return <><Hero title="消息" subtitle="在方便的时候，再回应。"><div className="topic-picker">{['私信','共学群'].map(t=><button className={`chip ${tab===t?'active':''}`} key={t} onClick={()=>{setTab(t);setMobileOpen(false);if(t==='私信'&&isGroup)setActive('lin');if(t==='共学群'&&!isGroup&&groups[0])setActive(`group:${groups[0].id}`);}}>{t}</button>)}</div></Hero><section className={`messages-layout ${mobileOpen?'conversation-open':''}`}><ScenarioContent><aside className="conversation-list" aria-label="会话列表">{tab==='私信'?visiblePeople.map(p=><div key={p.id} className={`conversation-row ${active===p.id?'selected':''}`}><ProfileAvatar person={p.id} size={48}/><button type="button" className="conversation-select" onClick={()=>choose(p.id)}><span><b>{p.name}</b><small>{state.blockedPeople.includes(p.id)?'已拉黑':state.followedPeople.includes(p.id)?'已关注的作者':'公开社区成员'}</small></span></button></div>):groups.length?groups.map(g=><button key={g.id} className={active===`group:${g.id}`?'selected':''} onClick={()=>choose(`group:${g.id}`)}><UsersRound size={36}/><span><b>{g.name}</b><small>仅群成员可参与</small></span></button>):<Empty action={<ArrowLink onClick={()=>go('groups')}>找共学</ArrowLink>}>还没有参与的共学群。</Empty>}</aside>
  <div className="conversation"><div className="conversation-heading"><button className="icon-button mobile-back" aria-label="返回会话列表" onClick={()=>setMobileOpen(false)}><ArrowLeft/></button>{isGroup?<UsersRound size={35}/>:active&&<ProfileAvatar person={person} size={48}/>}<div><b>{title}</b><span className="meta">{isGroup?'共学交流':'社区私信'}</span></div>{active&&<ConversationMenu person={person} onDeleted={()=>{setDeletedConversation(person);setActive(visiblePeople.find(item=>item.id!==person)?.id||'');setMobileOpen(false);go('messages');}}/>}</div><div ref={messageBody} className="conversation-body">{validConversation(active)?<>
  {!isGroup&&person==='lin'&&<><div className="chat-message"><ProfileAvatar person="lin" size={40}/><div><b>林同学</b><span className="meta">4月12日 14:20</span><p>你之前问的矩阵变换，我找到了一份很直观的图解。</p></div></div><ResourceStrip id="matrix"/><div className="chat-message mine"><Avatar size={40}/><div><span className="meta">4月12日 14:28 · 我</span><p>谢谢，我正好想把这个问题再理一理。</p></div></div><div className="chat-message"><ProfileAvatar person="lin" size={40}/><div><b>林同学</b><span className="meta">4月12日 14:35</span><p>有新的理解也可以一起讨论。</p></div></div></>}
  <SharedMessageList messages={messages}/>
  {isGroup&&active==='group:linear'&&!messages.length&&<p className="muted">可以在这里交流，也可以从群内资源选择“分享资源”发送卡片。</p>}
  {!isGroup&&person!=='lin'&&!messages.length&&<p className="muted">从一句具体的问候开始，或分享一份相关资源。</p>}
  </>:<Empty>{isGroup?'你当前没有这个共学群的访问权限。':'从作者资料卡片发起私信，或撤销删除会话。'}</Empty>}</div>{state.blockedPeople.includes(person)&&active&&<p className="inline-status conversation-blocked">已拉黑此用户，不能向对方发送私信或资源卡片。</p>}<MessageComposer key={active} conversation={active} disabled={!validConversation(active)||state.blockedPeople.includes(person)} onSent={setLastSent}/></div></ScenarioContent></section>{deletedConversation&&<div className="center-link" role="status">会话已从本机列表移除，消息仍保留。<LinkButton onClick={()=>{patch({hiddenConversations:state.hiddenConversations.filter(id=>id!==deletedConversation)});setActive(deletedConversation);setDeletedConversation(null);}}>撤销删除</LinkButton></div>}<div className="center-link"><LinkButton onClick={()=>open({kind:'privacy'})}>提醒设置<ChevronRight size={15}/></LinkButton></div></>;
}
export function ShareResourceAction({id}:{id:string}){const {open}=useApp();return <LinkButton onClick={()=>open({kind:'share',id})}><Share2 size={18}/>分享资源</LinkButton>;}
