import { UsersRound } from 'lucide-react';
import {useEffect,useRef,useState,type MouseEvent} from 'react';
import {CommunityBasicPanel as CommunityDesktopPanel} from './CommunityBasicPanel';
import {communityWebsiteUrl,COMMUNITY_UNAVAILABLE_MESSAGE} from '../services/community/availability';
import {useCommunityExchangeAvailable} from '../services/community/useCommunityExchange';
/** A separate website entry. Never forwards vault paths, user profiles or local identity. */
export function CommunityEntry() {
    const href = communityWebsiteUrl();
    const canExchange=useCommunityExchangeAvailable();
    const [panel,setPanel]=useState<{mode:'share'|'receive';noteId?:string}|null>(null),[menu,setMenu]=useState<{left:number;top:number}|null>(null);
    const [feedback,setFeedback]=useState<{left:number;top:number;message:string}|null>(null);
    const root=useRef<HTMLSpanElement>(null);
    useEffect(()=>{if(!feedback)return;const timer=setTimeout(()=>setFeedback(null),6000);return()=>clearTimeout(timer);},[feedback]);
    useEffect(()=>{if(!canExchange)return;const share=(event:Event)=>{const noteId=(event as CustomEvent).detail?.noteId;if(typeof noteId==='string')setPanel({mode:'share',noteId});};window.addEventListener('loginote:community-share',share);return()=>window.removeEventListener('loginote:community-share',share);},[canExchange]);
    useEffect(()=>{if(!menu&&!feedback)return;const dismiss=(event:Event)=>{if(!root.current?.contains(event.target as Node)){setMenu(null);setFeedback(null);}};const escape=(event:KeyboardEvent)=>{if(event.key==='Escape'){setMenu(null);setFeedback(null);}};window.addEventListener('pointerdown',dismiss);window.addEventListener('scroll',dismiss,true);window.addEventListener('keydown',escape);return()=>{window.removeEventListener('pointerdown',dismiss);window.removeEventListener('scroll',dismiss,true);window.removeEventListener('keydown',escape);};},[menu,feedback]);
    const content = <><UsersRound className="workspace-nav-icon"/><span>社区</span></>;
    const explain=(element:HTMLElement,message:string)=>{const box=element.getBoundingClientRect();setFeedback({left:Math.max(8,Math.min(box.right+12,innerWidth-280)),top:Math.max(8,Math.min(box.top,innerHeight-100)),message});};
    const openWebsite=async(event:MouseEvent<HTMLAnchorElement>)=>{setFeedback(null);if(!window.electronAPI?.openExternal)return;event.preventDefault();const element=event.currentTarget;try{await window.electronAPI.openExternal(href!);}catch{explain(element,'无法打开社区，请检查默认浏览器后重试。');}};
    const entry=href
        ? <a className="workspace-nav-item app-no-drag" href={href} target="_blank" rel="noopener noreferrer" aria-label="社区" title="打开社区网站" onClick={event=>void openWebsite(event)}>{content}</a>
        : <button type="button" className="workspace-nav-item app-no-drag" aria-label="社区" title="社区暂未开放" onClick={event=>explain(event.currentTarget,COMMUNITY_UNAVAILABLE_MESSAGE)}>{content}</button>;
    return <span ref={root} className="workspace-community-entry">{entry}{canExchange&&<button type="button" className="workspace-community-more app-no-drag" aria-label="社区更多操作" aria-expanded={!!menu} onClick={event=>{const box=event.currentTarget.getBoundingClientRect();setMenu(menu?null:{left:Math.max(8,Math.min(box.left,innerWidth-185)),top:Math.min(box.bottom+8,innerHeight-115)});}}>···</button>}{canExchange&&menu&&<div className="workspace-community-menu" style={menu}><button type="button" onClick={()=>{setMenu(null);setPanel({mode:'share'});}}>分享本地资源</button><button type="button" onClick={()=>{setMenu(null);setPanel({mode:'receive'});}}>桌面接收</button></div>}{feedback&&<span role="alert" className="workspace-community-feedback" style={{left:feedback.left,top:feedback.top}}>{feedback.message}</span>}{canExchange&&panel&&<CommunityDesktopPanel mode={panel.mode} noteId={panel.noteId} onClose={()=>setPanel(null)}/>}</span>;
}
