export type CommunityLaunchMode='full'|'entry'|'community';
/** UI release scope only. The server separately enforces permissions and release gates. */
const configuredMode=import.meta.env?.VITE_COMMUNITY_LAUNCH_MODE;
export const communityLaunchMode:CommunityLaunchMode=configuredMode==='entry'||configuredMode==='community'?configuredMode:'full';
export const communityEntryMode=communityLaunchMode==='entry';
export const communityNetworkMode=communityLaunchMode!=='full';
export function communityCapabilitiesFor(mode:CommunityLaunchMode=communityLaunchMode){
  const full=mode==='full',community=mode==='community';
  const terminalExchange=full||community&&import.meta.env?.VITE_COMMUNITY_TERMINAL_EXCHANGE_ENABLED==='true';
  const governance=full||community&&import.meta.env?.VITE_COMMUNITY_GOVERNANCE_ENABLED==='true';
  const groups=full||community&&import.meta.env?.VITE_COMMUNITY_GROUPS_ENABLED==='true';
  return {sharing:full||community,social:full||community,files:full||community,
    governance,admin:governance,mfa:governance,adminConfiguration:full,
    terminalExchange,learningStatistics:full,groups,news:full,attention:full};
}
export const communityCapabilities=communityCapabilitiesFor();
const entryPages=new Set(['home','market','friends','resource','discussion','topic','search','account','me']);
export function communityPageAvailable(page:string,mode:CommunityLaunchMode=communityLaunchMode){
  const capabilities=communityCapabilitiesFor(mode);
  return mode==='full'||entryPages.has(page)||capabilities.sharing&&page==='publish'||capabilities.social&&['following','messages'].includes(page)||capabilities.governance&&['feedback','admin'].includes(page)||capabilities.groups&&['groups','group'].includes(page);
}
export function communityPanelAvailable(kind:string){return communityLaunchMode==='full'||communityCapabilities.sharing&&kind==='composeMenu';}
const uuid='[\\da-f-]{36}';
const matches=(route:string,pattern:string)=>new RegExp('^'+pattern+'$','i').test(route);
export function communityRequestAvailable(path:string,method:string,mode:CommunityLaunchMode=communityLaunchMode){
  if(mode==='full')return true;
  const [route,query='']=path.split('?',2),params=new URLSearchParams(query),capabilities=communityCapabilitiesFor(mode);
  if(method==='GET'){
    if(['/me/session','/identity/provider','/me/profile'].includes(route))return true;
    if(capabilities.files&&route==='/capabilities')return true;
    if(route==='/entries')return (capabilities.groups||!params.has('groupId'))&&(!params.has('view')||['public',...(capabilities.sharing?['mine','bookmarks','participated','following']:[]),...(capabilities.groups?['group']:[]),...(capabilities.terminalExchange?['learning']:[])].includes(params.get('view')!));
    if(capabilities.groups&&(route==='/groups'||matches(route,`/groups/${uuid}(?:/(?:overview|members|audit|pins|messages(?:/${uuid})?|sync|draft|content-drafts/(?:post|resource)|tasks(?:/${uuid}(?:/activity)?)?))?`)))return true;
    if(route==='/people')return capabilities.social||!params.has('following');
    if(matches(route,`/people/${uuid}`)||matches(route,`/entries/${uuid}(?:/comments|/versions(?:/${uuid}(?:/preview/[A-Za-z0-9_-]+)?)?)?`))return true;
    if(capabilities.sharing&&(matches(route,'/me/drafts/(?:post|resource)')||matches(route,`/resource-stages/${uuid}(?:/files/${uuid}/inspection)?`)))return true;
    if(capabilities.social&&(route==='/me/blocked'||route==='/conversations'||matches(route,`/conversations/${uuid}(?:/messages|/sync|/draft)?`)))return true;
    if(capabilities.governance&&(route==='/me/reports'||matches(route,`/reports/${uuid}`)))return true;
    if(capabilities.admin&&(route==='/admin/reports'||matches(route,`/admin/reports/${uuid}/(?:evidence|audit)`)))return true;
    return capabilities.terminalExchange&&['/me/devices','/me/receipts'].includes(route)||capabilities.learningStatistics&&route==='/me/learning-statistics';
  }
  if(method==='POST'){
    if(capabilities.groups&&(route==='/groups'||matches(route,`/groups/${uuid}/(?:membership|messages|stages|tasks)`)))return true;
    if(/^\/identity\/(?:email-code|register|login|reset-password)$/.test(route)||route==='/me/sign-out')return true;
    if(capabilities.sharing&&(route==='/entries'||route==='/resource-stages'||matches(route,`/entries/${uuid}/(?:comments|restore)`)))return true;
    if(capabilities.files&&(route==='/attachments/intents'||matches(route,`/resource-stages/${uuid}/files`)||matches(route,`/attachments/${uuid}/download`)))return true;
    if(capabilities.social&&(route==='/conversations'||matches(route,`/conversations/${uuid}/(?:messages|stages)`)))return true;
    if(capabilities.governance&&(route==='/reports'||matches(route,`/reports/${uuid}/appeals`)))return true;
    if(capabilities.admin&&(matches(route,`/admin/reports/${uuid}/(?:assign|triage|decisions|suggestion-feedback)`)||matches(route,`/admin/appeals/${uuid}/review`)))return true;
    if(capabilities.mfa&&matches(route,'/me/mfa/(?:challenge|email-code|email-confirm)'))return true;
    return capabilities.terminalExchange&&(route==='/me/devices/approve'||matches(route,`/entries/${uuid}/receive`));
  }
  if(method==='PUT'){
    if(capabilities.groups&&matches(route,`/groups/${uuid}(?:/(?:members/${uuid}|messages/${uuid}|draft|participation|content-drafts/(?:post|resource)|tasks/${uuid}(?:/progress)?))?`))return true;
    if(route==='/me/profile')return true;
    if(capabilities.sharing&&(matches(route,`/entries/${uuid}(?:/bookmark|/solution)?`)||matches(route,'/me/drafts/(?:post|resource)')))return true;
    if(capabilities.social&&(matches(route,`/people/${uuid}/(?:follow|block)`)||matches(route,`/conversations/${uuid}(?:/draft)?`)))return true;
    return capabilities.terminalExchange&&(matches(route,`/me/(?:devices|receipts)/${uuid}`)||matches(route,`/entries/${uuid}/learning`))||capabilities.learningStatistics&&route==='/me/learning-statistics';
  }
  if(method==='DELETE')return capabilities.sharing&&(matches(route,`/(?:entries|comments)/${uuid}`)||matches(route,`/resource-stages/${uuid}/files/${uuid}`))||capabilities.social&&matches(route,`/conversations/${uuid}/stages/${uuid}/files/${uuid}`)||capabilities.terminalExchange&&matches(route,`/me/devices/${uuid}`)||capabilities.groups&&matches(route,`/groups/${uuid}(?:/stages/${uuid}/files/${uuid})?`);
  return false;
}
export const COMMUNITY_ENTRY_NOTICE='预发布 · 目前开放浏览、注册登录和个人资料。';
