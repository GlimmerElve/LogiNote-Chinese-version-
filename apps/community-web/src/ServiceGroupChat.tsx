import {startVisiblePoll} from './visiblePoll';
import {useEffect,useLayoutEffect,useMemo,useRef,useState} from 'react';
import {ArrowLeft,MessageCircle,Pin} from 'lucide-react';
import {LinkButton,Overlay} from './ui';
import {MessageContextMenu} from './MessageContextMenu';
import {ServiceAvatar} from './ServiceAvatar';
import {ResourceBody} from './ResourceBody';
import {PrivateComposer,PrivateImage} from './ServiceMessages';
import {ServiceGovernancePage} from './ServiceGovernance';
import {communityGroups as api,groupMessageTransport,type GroupInfo,type GroupMessage} from './serviceGroupClient';
type CachedRoom={items:GroupMessage[];before:string|null;cursor:string;top:number;atBottom:boolean};
const merge=(old:GroupMessage[],next:GroupMessage[])=>[...new Map([...old,...next].map(item=>[item.id,item])).values()].sort((a,b)=>BigInt(a.position)<BigInt(b.position)?-1:1);
export function GroupConversation({group,accountId,active,threadId,pins,onThread,onChanged}:{group:GroupInfo;accountId:string;active:boolean;threadId?:string;pins:GroupMessage[];onThread:(id?:string)=>void;onChanged:()=>void}){
  const cache=useRef(new Map<string,CachedRoom>());
  return <div>{!threadId&&pins.length>0&&<div className="service-group-pins"><Pin size={16}/><span className="meta">置顶讨论</span><LinkButton onClick={()=>onThread(pins[0].id)}>{pins[0].body.split('\n')[0].slice(0,60)||'一起讨论'}<span aria-hidden="true"> ›</span></LinkButton>{pins.length>1&&<details data-popup><summary className="meta">其他话题</summary>{pins.slice(1).map(pin=><p key={pin.id}><LinkButton onClick={()=>onThread(pin.id)}>{pin.body.split('\n')[0].slice(0,60)}</LinkButton></p>)}</details>}</div>}<GroupTimeline key={threadId||'main'} group={group} accountId={accountId} active={active} threadId={threadId} cache={cache.current} onThread={onThread} onChanged={onChanged}/></div>;
}
function GroupTimeline({group,accountId,active,threadId,cache,onThread,onChanged}:{group:GroupInfo;accountId:string;active:boolean;threadId?:string;cache:Map<string,CachedRoom>;onThread:(id?:string)=>void;onChanged:()=>void}){
  const key=threadId||'main',saved=cache.get(key),[items,setItems]=useState<GroupMessage[]>(saved?.items||[]),[before,setBefore]=useState<string|null>(saved?.before||null),[loaded,setLoaded]=useState(!!saved),[topic,setTopic]=useState<GroupMessage|null>(null),[error,setError]=useState(''),[busy,setBusy]=useState(false),[report,setReport]=useState<GroupMessage|null>(null);
  const scroll=useRef<HTMLDivElement>(null),cursor=useRef(saved?.cursor||'0'),atBottom=useRef(saved?.atBottom??true),restore=useRef<number|null>(saved?.top??null),prepend=useRef<{height:number;top:number}|null>(null),latest=useRef({items,before,loaded}),refreshRef=useRef<()=>Promise<void>>(async()=>{});
  const transport=useMemo(()=>groupMessageTransport(threadId),[threadId]);
  latest.current={items,before,loaded};
  useLayoutEffect(()=>{const box=scroll.current;return()=>{if(latest.current.loaded)cache.set(key,{...latest.current,cursor:cursor.current,top:box?.scrollTop||0,atBottom:atBottom.current});};},[key,cache]);
  useEffect(()=>{
    const controller=new AbortController();let fetching=false;
    const refresh=async(signal=controller.signal)=>{
      if(fetching||document.hidden||!active)return;fetching=true;
      try{
        if(!latest.current.loaded){const history=await api.history(group.id,{threadId},signal);if(signal.aborted)return;setItems(history.items);setBefore(history.nextBefore);cursor.current=history.syncCursor;setLoaded(true);latest.current={items:history.items,before:history.nextBefore,loaded:true};}
        else {let more=true,changes:GroupMessage[]=[];for(let page=0;more&&page<10;page++){const delta=await api.sync(group.id,cursor.current,signal);if(signal.aborted)return;changes.push(...delta.changes);cursor.current=delta.cursor;more=delta.hasMore;}if(changes.length){const root=changes.find(item=>item.id===threadId);if(root)setTopic(root);setItems(old=>merge(old,changes.filter(item=>item.threadId===(threadId||null))));}}
        if(threadId){const root=await api.topic(group.id,threadId,signal);if(!signal.aborted)setTopic(root);}
        if(!signal.aborted)setError('');
      }catch(error){if(!signal.aborted){setError(error instanceof Error?error.message:'暂时无法读取群消息。');onChanged();throw error;}}finally{fetching=false;}
    };
    refreshRef.current=refresh;const poll=active?startVisiblePoll(signal=>refresh(signal),{intervalMs:5000}):null;return()=>{controller.abort();poll?.stop();};
  },[group.id,threadId,active]);
  useLayoutEffect(()=>{const box=scroll.current;if(!box)return;if(restore.current!==null){box.scrollTop=restore.current;restore.current=null;}else if(prepend.current){box.scrollTop=prepend.current.top+box.scrollHeight-prepend.current.height;prepend.current=null;}else if(atBottom.current)box.scrollTop=box.scrollHeight;},[items]);
  const action=async(message:GroupMessage,kind:string)=>{if(busy)return;setBusy(true);setError('');try{await api.messageAction(accountId,group.id,message.id,kind);await refreshRef.current();onChanged();}catch(error){setError(error instanceof Error?error.message:'暂时无法操作。');}finally{setBusy(false);}};
  const back=()=>{if(scroll.current)cache.set(key,{items,before,cursor:cursor.current,top:scroll.current.scrollTop,atBottom:atBottom.current});onThread();};
  return <section className="service-conversation service-group-conversation" aria-label={threadId?'群话题讨论':'群交流'}><header>{threadId?<><LinkButton onClick={back}><ArrowLeft size={17}/>返回群交流</LinkButton><strong>话题讨论{topic?.threadClosed?' · 已结束':''}</strong></>:<strong>群交流</strong>}</header><div ref={scroll} className="service-message-log" aria-label="群消息记录" onScroll={()=>{const box=scroll.current;if(box)atBottom.current=box.scrollHeight-box.scrollTop-box.clientHeight<60;}}>
    {threadId&&topic&&<article className="service-group-original"><p className="meta">{topic.senderName} 发起的话题</p>{topic.visible?<><ResourceBody body={topic.body}/>{topic.files.map(file=><PrivateImage key={file.id} file={file} accountId={accountId}/>)}</>:<p className="meta">原消息已不可见，已有讨论保留。</p>}</article>}
    {before&&<LinkButton disabled={busy} onClick={()=>{setBusy(true);void api.history(group.id,{threadId,before}).then(history=>{if(scroll.current)prepend.current={height:scroll.current.scrollHeight,top:scroll.current.scrollTop};atBottom.current=false;setItems(old=>merge(old,history.items));setBefore(history.nextBefore);}).catch(error=>setError(error.message)).finally(()=>setBusy(false));}}>查看更早消息</LinkButton>}
    {items.map(message=><MessageContextMenu key={message.id} messageId={message.id} mine={message.senderId===accountId} label={message.senderName+'的消息'} enabled={message.visible} actions={[
      ...(message.body?[{label:'复制文字',onSelect:()=>{void navigator.clipboard.writeText(message.body).catch(()=>setError('复制失败，可以选择文字后复制。'));}}]:[]),
      ...(group.canManage&&!message.threadId?[{label:message.pinned?'取消置顶':'置顶讨论',disabled:busy,onSelect:()=>void action(message,message.pinned?'unpin':'pin')},{label:message.threadClosed?'重新开放讨论':'结束讨论',disabled:busy,onSelect:()=>void action(message,message.threadClosed?'reopen':'close')}]:[]),
      ...(message.senderId===accountId||group.canManage?[{label:'删除消息',disabled:busy,onSelect:()=>void action(message,'remove')}]:[]),
      ...(message.senderId!==accountId?[{label:'反馈与举报',onSelect:()=>setReport(message)}]:[]),
    ]}><ServiceAvatar name={message.senderName} size={32}/><div><p className="meta">{message.senderName} · {new Date(message.createdAt).toLocaleString('zh-CN',{month:'numeric',day:'numeric',hour:'2-digit',minute:'2-digit'})}</p>{message.visible?<><div className="service-message-bubble">{message.body&&<ResourceBody body={message.body}/>}<div className="service-message-images">{message.files.map(file=><PrivateImage key={file.id} file={file} accountId={accountId}/>)}</div></div>{!threadId&&<LinkButton className={'service-message-thread '+(message.replyCount?'has-replies':'')} aria-label={message.replyCount?'查看'+message.replyCount+'条回复':'发起讨论'} onClick={()=>onThread(message.id)}><MessageCircle size={14}/><span>{message.replyCount?message.replyCount+' 条回复':'发起讨论'}{message.threadClosed?' · 已结束':''}</span></LinkButton>}</>:<p className="meta">该消息已不可见。</p>}</div></MessageContextMenu>)}
    {loaded&&!items.length&&<p className="meta">{threadId?'在这个话题下，分享你的理解和问题。':'从一个问题或发现开始交流。'}</p>}</div>{error&&<p className="inline-status" role="alert">{error}</p>}{(!group.canSend||topic?.threadClosed)&&<p className="service-contact-state">{group.state==='archived'?'共学群已归档，可以继续阅读历史。':topic?.threadClosed?'话题已结束，可以继续阅读讨论。':'暂时不能在本群发送内容。'}</p>}<PrivateComposer accountId={accountId} id={group.id} messages={items} disabled={!group.canSend||!loaded||busy||!!threadId&&(!topic||topic.threadClosed)} transport={transport} onSent={()=>refreshRef.current()}/>{report&&<Overlay title="反馈与举报" onClose={()=>setReport(null)}><ServiceGovernancePage target={{targetType:'object',targetId:report.id,label:'这条群消息'}}/></Overlay>}</section>;
}
