import { useRef } from 'react';
import { MoreHorizontal } from 'lucide-react';
import { useApp } from './context';
import { names, type Person } from './model';

export function ConversationMenu({person,onDeleted}:{person:Person;onDeleted:()=>void}) {
  const {state,patch,open}=useApp();
  const menu=useRef<HTMLDetailsElement>(null);
  const blocked=state.blockedPeople.includes(person);
  const close=()=>{
    if(!menu.current)return;
    menu.current.open=false;
    menu.current.querySelector('summary')?.focus({preventScroll:true});
  };
  return <details data-popup ref={menu} className="conversation-menu post-menu more"
    onBlur={event=>{if(!event.currentTarget.contains(event.relatedTarget))event.currentTarget.open=false;}}
    onKeyDown={event=>{if(event.key==='Escape'){event.preventDefault();event.stopPropagation();close();}}}>
    <summary className="icon-button" aria-label="私信更多操作"><MoreHorizontal/></summary>
    <div className="conversation-menu-content post-menu-content">
      <button type="button" onClick={()=>{close();patch({hiddenConversations:[...new Set([...state.hiddenConversations,person])]});onDeleted();}}>删除会话</button>
      <p className="meta">仅从本机会话列表移除，消息记录仍保留。</p>
      <button type="button" onClick={()=>{close();patch({blockedPeople:blocked?state.blockedPeople.filter(id=>id!==person):[...state.blockedPeople,person]});}}>{blocked?'解除拉黑':'拉黑用户'}</button>
      <button type="button" onClick={()=>{close();open({kind:'feedback',target:`与${names[person]}的私信`});}}>反馈与举报</button>
    </div>
  </details>;
}
