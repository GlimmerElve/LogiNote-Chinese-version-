import publicDeployment from './publicDeployment.json';

/** Public addresses and feature gates only. Never place service keys here. */
export interface PublicCommunityDeployment {
  webEnabled:boolean;
  websiteUrl:string;
  apiUrl:string;
  desktopExchangeEnabled:boolean;
}
export const publicCommunityDeployment:PublicCommunityDeployment=publicDeployment;
const localHost=(hostname:string)=>{const host=hostname.replace(/\.$/,'');return host==='localhost'||host.endsWith('.localhost')||/^127\./.test(host)||['0.0.0.0','[::]','[::1]'].includes(host)||/^\[::ffff:7f[\da-f]{2}:/i.test(host);};
const explicitFlag=(value:string|undefined,fallback:boolean)=>value===undefined?fallback:value==='true';
function localAddress(value:string|undefined){try{return !!value&&localHost(new URL(value).hostname);}catch{return false;}}

export function resolveCommunityWebsiteUrl(raw:string|undefined,options:{release:boolean;releaseEnabled:boolean}):string|null {
  if(options.release&&!options.releaseEnabled||!raw?.trim())return null;
  try{const url=new URL(raw.trim()),local=localHost(url.hostname);if(url.username||url.password)return null;if(options.release?url.protocol!=='https:'||local:url.protocol!=='https:'&&!(url.protocol==='http:'&&local))return null;return url.href;}catch{return null;}
}

export function resolveCommunityWebConfiguration(options:{release:boolean;development?:boolean;developmentWebsiteUrl?:string;websiteOverride?:string;releaseEnabledOverride?:string;desktopExchangeOverride?:string;explicitWebsiteOverride?:boolean},deployment:PublicCommunityDeployment=publicCommunityDeployment){
  // Published release gates are authoritative. Old build/runtime environment
  // overrides may narrow availability, but cannot reopen a withheld release.
  const releaseEnabled=(!options.release||deployment.webEnabled)&&explicitFlag(options.releaseEnabledOverride,deployment.webEnabled);
  // A newly accepted network deployment takes precedence over a stale local
  // preview URL from .env.local. An explicitly supplied process override wins.
  const preferNetwork=deployment.webEnabled&&!options.explicitWebsiteOverride&&localAddress(options.websiteOverride);
  const raw=preferNetwork?deployment.websiteUrl:options.websiteOverride??(deployment.webEnabled?deployment.websiteUrl:options.development?options.developmentWebsiteUrl||'':'');
  const websiteUrl=resolveCommunityWebsiteUrl(raw,{release:options.release,releaseEnabled});
  return {websiteUrl,releaseEnabled,desktopExchangeEnabled:!!websiteUrl&&(!options.release||deployment.desktopExchangeEnabled)&&explicitFlag(options.desktopExchangeOverride,deployment.desktopExchangeEnabled)};
}

function apiAddress(raw:string,packaged:boolean){
  if(!raw)return '';
  const url=new URL(raw);if(url.username||url.password||url.search||url.hash||url.pathname.replace(/\/$/,'')!=='/api/community/v1'||(url.protocol!=='https:'&&!(url.protocol==='http:'&&!packaged&&localHost(url.hostname)))||packaged&&localHost(url.hostname))throw Error('社区服务地址必须是有效的 HTTPS API 地址。');
  return url.href.replace(/\/$/,'');
}
function requestOrigin(raw:string,packaged:boolean){const url=new URL(raw);if(url.origin!==raw||url.username||url.password||(url.protocol!=='https:'&&!(url.protocol==='http:'&&!packaged&&localHost(url.hostname)))||packaged&&localHost(url.hostname))throw Error('社区网站 Origin 配置不正确。');return url.origin;}

export function resolveCommunityHostConfiguration(options:{packaged:boolean;apiOverride?:string;originOverride?:string;desktopExchangeOverride?:string},deployment:PublicCommunityDeployment=publicCommunityDeployment){
  if(options.packaged&&!deployment.webEnabled)return {websiteUrl:null,apiUrl:'',origin:'',desktopExchangeEnabled:false};
  const web=resolveCommunityWebConfiguration({release:options.packaged,development:!options.packaged,developmentWebsiteUrl:'http://127.0.0.1:5174'},deployment);
  const enabled=(!options.packaged||deployment.desktopExchangeEnabled)&&explicitFlag(options.desktopExchangeOverride,deployment.desktopExchangeEnabled);
  const candidate=options.apiOverride??(deployment.webEnabled?deployment.apiUrl:!options.packaged?'http://127.0.0.1:5180/api/community/v1':'');
  const apiUrl=enabled?apiAddress(candidate.trim(),options.packaged):'';
  const websiteOrigin=web.websiteUrl?new URL(web.websiteUrl).origin:'';
  const origin=options.originOverride?requestOrigin(options.originOverride,options.packaged):websiteOrigin||(apiUrl?new URL(apiUrl).origin:'');
  return {websiteUrl:web.websiteUrl,apiUrl,origin,desktopExchangeEnabled:enabled&&!!apiUrl};
}
