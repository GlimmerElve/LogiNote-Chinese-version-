import {createContext,useContext,useEffect,useState,type ReactNode} from 'react';
import {serviceClient,SESSION_CHANGED,type ServiceSession} from './serviceClient';

type Identity={status:'loading'|'ready'|'error';session:ServiceSession|null;error:string};
const IdentityContext=createContext<Identity>({status:'ready',session:{kind:'guest'},error:''});
export const useServiceIdentity=()=>useContext(IdentityContext);
/** No browser demo state is an identity. Auth changes unmount all account-scoped views. */
export function ServiceIdentityProvider({children}:{children:ReactNode}){
  const [identity,setIdentity]=useState<Identity>({status:'loading',session:null,error:''});
  useEffect(()=>{
    let active=true,generation=0,controller:AbortController|undefined;
    const refresh=(clear=false)=>{
      const current=++generation;controller?.abort();controller=new AbortController();
      if(clear)setIdentity({status:'loading',session:null,error:''});
      void serviceClient.getSession(controller.signal).then(session=>{if(active&&generation===current)setIdentity({status:'ready',session,error:''});}).catch(error=>{if(active&&generation===current&&!controller?.signal.aborted)setIdentity({status:'error',session:null,error:error instanceof Error?error.message:'暂时无法读取账号。'});});
    };
    const changed=()=>refresh(true),visible=()=>{if(!document.hidden)refresh();};
    refresh();window.addEventListener(SESSION_CHANGED,changed);document.addEventListener('visibilitychange',visible);
    return()=>{active=false;generation++;controller?.abort();window.removeEventListener(SESSION_CHANGED,changed);document.removeEventListener('visibilitychange',visible);};
  },[]);
  return <IdentityContext value={identity}>{children}</IdentityContext>;
}
