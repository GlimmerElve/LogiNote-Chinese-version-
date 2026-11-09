import {useEffect,useState} from 'react';
import type {CommunityDesktopApi} from './desktopTypes';
import {communityWebsiteUrl,communityDesktopExchangeEnabled} from './availability';

// The configured API address is fixed for the lifetime of a desktop host.
// Share only this boolean, never a binding, account, token or library metadata.
const configurations=new WeakMap<CommunityDesktopApi,Promise<boolean>>();
function configured(host:CommunityDesktopApi){
  let pending=configurations.get(host);
  if(!pending){pending=Promise.resolve().then(()=>host.state()).then(state=>state.configured===true,()=>{configurations.delete(host);return false;});configurations.set(host,pending);}
  return pending;
}
export function useCommunityExchangeAvailable(active=true):boolean {
  const enabled=!!communityWebsiteUrl()&&communityDesktopExchangeEnabled(),host=window.electronAPI?.community;
  const [ready,setReady]=useState(false);
  useEffect(()=>{let current=true;setReady(false);if(!active||!enabled||!host)return;void configured(host).then(value=>{if(current)setReady(value);});return()=>{current=false;};},[active,enabled,host]);
  return active&&enabled&&!!host&&ready;
}
