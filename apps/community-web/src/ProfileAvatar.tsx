import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useApp } from './context';
import { names, people, type Person } from './model';
import { Avatar } from './ui';

let dismissActiveCard: (()=>void)|null=null;

/** Hover previews stay nonmodal; clicking or tapping always opens the profile. */
export function ProfileAvatar({person,size=48}:{person:Person;size?:number}) {
  const {state,patch,go}=useApp();
  const personInfo=people.find(p=>p.id===person);
  const name=person==='me'?state.profile.name:names[person];
  const followed=state.followedPeople.includes(person);
  const blocked=state.blockedPeople.includes(person);
  const trigger=useRef<HTMLButtonElement>(null);
  const card=useRef<HTMLDivElement>(null);
  const showTimer=useRef<number|undefined>(undefined);
  const hideTimer=useRef<number|undefined>(undefined);
  const id=useId();
  const [position,setPosition]=useState<{left:number;top:number}|null>(null);
  const clearTimers=useCallback(()=>{window.clearTimeout(showTimer.current);window.clearTimeout(hideTimer.current);},[]);
  const hide=useCallback(()=>{
    clearTimers();setPosition(null);
    if(dismissActiveCard===hide)dismissActiveCard=null;
  },[clearTimers]);
  useEffect(()=>()=>{clearTimers();if(dismissActiveCard===hide)dismissActiveCard=null;},[clearTimers,hide]);
  useEffect(()=>{hide();},[person,hide]);
  const show=()=>{
    clearTimers();
    if(person==='me'||!personInfo||position)return;
    showTimer.current=window.setTimeout(()=>{
      if(!trigger.current?.isConnected)return;
      dismissActiveCard?.();dismissActiveCard=hide;
      const rect=trigger.current.getBoundingClientRect();
      setPosition({left:Math.min(rect.left,innerWidth-304),top:rect.bottom+10});
    },400);
  };
  const leave=()=>{
    clearTimers();
    // Allow crossing the small gap between the avatar and its card.
    hideTimer.current=window.setTimeout(()=>{
      if(card.current?.contains(document.activeElement)&&document.activeElement?.matches(':focus-visible'))return;
      hide();
    },180);
  };
  const isOpen=!!position;
  useLayoutEffect(()=>{
    if(!isOpen||!card.current||!trigger.current)return;
    const anchor=trigger.current.getBoundingClientRect(),box=card.current.getBoundingClientRect();
    const below=anchor.bottom+10;
    setPosition({left:Math.max(12,Math.min(anchor.left,innerWidth-box.width-12)),top:Math.max(12,Math.min(below+box.height<=innerHeight-12?below:anchor.top-box.height-10,innerHeight-box.height-12))});
  },[isOpen,followed,blocked]);
  useEffect(()=>{
    if(!isOpen)return;
    const scroll=(e:Event)=>{if(!card.current?.contains(e.target as Node))hide();};
    const escape=(e:KeyboardEvent)=>{
      if(e.key!=='Escape')return;
      e.stopPropagation();e.preventDefault();
      if(card.current?.contains(document.activeElement))trigger.current?.focus({preventScroll:true});
      hide();
    };
    window.addEventListener('scroll',scroll,true);window.addEventListener('resize',hide);window.addEventListener('hashchange',hide);
    document.addEventListener('keydown',escape,true);
    return()=>{window.removeEventListener('scroll',scroll,true);window.removeEventListener('resize',hide);window.removeEventListener('hashchange',hide);document.removeEventListener('keydown',escape,true);};
  },[isOpen,hide]);
  const visit=()=>{hide();go(person==='me'?'me':'friends',person);};
  const blur=(next:EventTarget|null)=>{
    if(next instanceof Node&&(trigger.current?.contains(next)||card.current?.contains(next)))return;
    leave();
  };
  return <>
    <button ref={trigger} type="button" className="avatar-button profile-avatar" aria-label={`查看${name}主页`} aria-describedby={isOpen?id:undefined}
      onPointerEnter={e=>{if(e.pointerType==='mouse')show();}} onPointerLeave={leave}
      onFocus={e=>{if(e.currentTarget.matches(':focus-visible'))show();}} onBlur={e=>blur(e.relatedTarget)}
      onKeyDown={e=>{if(e.key==='ArrowDown'&&isOpen){e.preventDefault();card.current?.querySelector<HTMLButtonElement>('button')?.focus({preventScroll:true});}}}
      onClick={visit}><Avatar person={person} size={size}/></button>
    {position&&personInfo&&createPortal(<div ref={card} id={id} role="region" aria-label={`${name}的资料卡`} className="person-hover-card" style={position}
      onPointerEnter={clearTimers} onPointerLeave={leave} onFocus={clearTimers} onBlur={e=>blur(e.relatedTarget)}>
      <div className="person-card-heading"><button type="button" className="person-card-identity" onClick={visit}><Avatar person={person} size={36}/><strong>{name}</strong></button>
        <button type="button" className="text-button" aria-label={`${followed?'取消关注':'关注'}${name}`} aria-pressed={followed} onClick={()=>patch({followedPeople:followed?state.followedPeople.filter(p=>p!==person):[...state.followedPeople,person]})}>{followed?'已关注':'关注'}</button></div>
      <p>{personInfo.bio}</p><div className="person-card-interests">{personInfo.interests.slice(0,3).map(t=><span key={t}>{t}</span>)}</div>
      {followed&&!blocked&&<button type="button" className="text-button person-card-message" onClick={()=>{hide();patch({hiddenConversations:state.hiddenConversations.filter(id=>id!==person)});go('messages',person);}}>私信</button>}
    </div>,trigger.current?.closest('dialog[open]')||document.body)}
  </>;
}
