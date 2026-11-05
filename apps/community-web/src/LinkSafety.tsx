import {createContext,useContext,useRef,useState,type ReactNode} from 'react';
import {ExternalLink} from 'lucide-react';
import {Overlay,Primary} from './ui';

export function linkDestination(raw:string,base=location.href){
  try{
    const url=new URL(raw,base);
    if(url.protocol==='mailto:')return {kind:'mail' as const,url};
    if(!['http:','https:'].includes(url.protocol)||url.username||url.password)return null;
    return {kind:url.origin===new URL(base).origin?'internal' as const:'external' as const,url};
  }catch{return null;}
}
const LinkSafetyContext=createContext<((raw:string)=>void)|null>(null);
export function useLinkSafety(){return useContext(LinkSafetyContext);}

export function LinkSafetyProvider({children}:{children:ReactNode}){
  const [target,setTarget]=useState<URL|null>(null),cancel=useRef<HTMLButtonElement>(null);
  const open=(raw:string)=>{const result=linkDestination(raw);if(!result)return;if(result.kind==='external')setTarget(result.url);else if(result.kind==='internal')location.href=result.url.href;};
  return <LinkSafetyContext value={open}>{children}{target&&<Overlay title="即将访问外部网站" kind="modal" initialFocusRef={cancel} onClose={()=>setTarget(null)}>
    <div className="external-link-target"><ExternalLink size={20}/><strong>{target.host}</strong></div>
    <p className="external-link-address">{target.href}</p>
    <p className="meta">请核对网址，谨防仿冒网站。不要向不可信网站提供社区密码、验证码等敏感信息。</p>
    <div className="panel-actions"><button type="button" ref={cancel} className="text-button" onClick={()=>setTarget(null)}>返回社区</button><Primary onClick={()=>{window.open(target.href,'_blank','noopener,noreferrer');setTarget(null);}}>继续访问</Primary></div>
  </Overlay>}</LinkSafetyContext>;
}
export function SafeLink({href,children}:{href:string;children:ReactNode}){
  const open=useLinkSafety(),result=linkDestination(href);
  if(!result)return <span>{children}</span>;
  return <a href={result.url.href} target={result.kind==='external'?'_blank':undefined} rel={result.kind==='external'?'noopener noreferrer':undefined} onClick={event=>{if(result.kind==='external'){event.preventDefault();open?.(result.url.href);}}} onAuxClick={event=>{if(event.button===1&&result.kind==='external'){event.preventDefault();open?.(result.url.href);}}}>{children}</a>;
}
