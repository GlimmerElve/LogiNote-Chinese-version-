import {useEffect,useId,useLayoutEffect,useRef,useState,type ReactNode} from 'react';

type Action={label:string;onSelect:()=>void;disabled?:boolean};
const OPEN='community-message-context-open';

/** Native top-layer popover escapes the scrolling transcript's clipping boundary. */
export function MessageContextMenu({messageId,mine,label,enabled,actions,children}:{messageId:string;mine:boolean;label:string;enabled:boolean;actions:Action[];children:ReactNode}){
  const id=useId(),row=useRef<HTMLElement>(null),panel=useRef<HTMLDivElement>(null),timer=useRef<ReturnType<typeof setTimeout>|undefined>(undefined),touch=useRef<{x:number;y:number}|null>(null);
  const [point,setPoint]=useState<{x:number;y:number}|null>(null);
  const clearPress=()=>{clearTimeout(timer.current);touch.current=null;};
  const close=(restore=false)=>{setPoint(null);if(restore)row.current?.focus({preventScroll:true});};
  const open=(x:number,y:number)=>{if(!enabled)return;window.dispatchEvent(new CustomEvent(OPEN,{detail:id}));setPoint({x,y});};
  useEffect(()=>()=>clearPress(),[]);
  useEffect(()=>{if(!enabled)setPoint(null);},[enabled]);
  useLayoutEffect(()=>{
    if(!point||!panel.current)return;
    const element=panel.current;element.showPopover();
    const box=element.getBoundingClientRect(),width=document.documentElement.clientWidth,height=window.innerHeight;
    const left=Math.max(8,Math.min(point.x,width-box.width-8));
    const top=Math.max(8,Math.min(point.y+box.height>height-8?point.y-box.height:point.y,height-box.height-8));
    element.style.left=left+'px';element.style.top=top+'px';
    element.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus({preventScroll:true});
    const outside=(event:Event)=>{if(!event.composedPath().includes(element))close();};
    const other=(event:Event)=>{if((event as CustomEvent).detail!==id)close();};
    const scroll=(event:Event)=>{if(event.target!==element&&!element.contains(event.target as Node))close();};
    const resize=()=>close();
    document.addEventListener('pointerdown',outside,true);document.addEventListener('focusin',outside,true);
    document.addEventListener('scroll',scroll,true);window.addEventListener('resize',resize);window.addEventListener(OPEN,other);
    return()=>{if(element.isConnected&&element.matches(':popover-open'))element.hidePopover();document.removeEventListener('pointerdown',outside,true);document.removeEventListener('focusin',outside,true);document.removeEventListener('scroll',scroll,true);window.removeEventListener('resize',resize);window.removeEventListener(OPEN,other);};
  },[point,id]);
  return <article ref={row} data-message-id={messageId} className={'service-message '+(mine?'mine':'')} tabIndex={enabled?0:undefined} aria-label={label} aria-keyshortcuts="Shift+F10" onContextMenu={event=>{
    if(!enabled||(event.target as Element).closest('a'))return;
    event.preventDefault();event.stopPropagation();const box=row.current!.getBoundingClientRect();open(event.clientX||box.left+20,event.clientY||box.top+20);
  }} onKeyDown={event=>{
    if(event.key==='ContextMenu'||event.key==='F10'&&event.shiftKey){event.preventDefault();const box=row.current!.getBoundingClientRect();open(mine?box.right-36:box.left+36,box.top+30);}
  }} onPointerDown={event=>{
    if(event.pointerType!=='touch'||(event.target as Element).closest('button,a,input,textarea,summary'))return;
    clearPress();const x=event.clientX,y=event.clientY;touch.current={x,y};timer.current=setTimeout(()=>{touch.current=null;open(x,y);},550);
  }} onPointerMove={event=>{if(touch.current&&Math.hypot(event.clientX-touch.current.x,event.clientY-touch.current.y)>10)clearPress();}} onPointerUp={clearPress} onPointerCancel={clearPress}>
    {children}
    {point&&<div ref={panel} popover="manual" role="menu" aria-label="消息操作" className="service-message-context" onContextMenu={event=>event.preventDefault()} onKeyDown={event=>{
      if(event.key==='Escape'){event.preventDefault();event.stopPropagation();close(true);return;}
      const buttons=Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')),index=buttons.indexOf(document.activeElement as HTMLButtonElement);
      if(['ArrowDown','ArrowUp','Home','End'].includes(event.key)){event.preventDefault();const next=event.key==='Home'?0:event.key==='End'?buttons.length-1:(index+(event.key==='ArrowUp'?-1:1)+buttons.length)%buttons.length;buttons[next]?.focus();}
      if(event.key==='Tab')close();
    }}>{actions.map(action=><button type="button" role="menuitem" key={action.label} disabled={action.disabled} onClick={()=>{close(true);action.onSelect();}}>{action.label}</button>)}</div>}
  </article>;
}
