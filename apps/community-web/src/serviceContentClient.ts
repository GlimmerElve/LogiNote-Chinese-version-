import type {InlineImageFile} from './ContentImages';
import {serviceClient,SESSION_CHANGED} from './serviceClient';
import type {DisplayedLearningStatistics} from '../../community-api/src/learningStatisticsContract';
export type PublicPerson={accountId:string;displayName:string;bio:string;interests:string[];followed:boolean;isMe:boolean;learningStatistics?:DisplayedLearningStatistics|null};
export type EntryKind='post'|'question'|'resource';
export type EntryScope='public'|'self'|'group';
export type ServiceEntry={news?:boolean;images?:InlineImageFile[];id:string;kind:EntryKind;title:string;body:string;resourceType:'note'|'route'|'exercise'|'link'|'scene'|null;topics:string[];scope:EntryScope;groupId:string|null;author:PublicPerson;createdAt:string;updatedAt:string;state:string;bookmarked:boolean;inLearning:boolean;learningCount:number;commentCount:number;acceptedCommentId?:string|null;canAcceptSolution?:boolean};
export type ServiceComment={images?:InlineImageFile[];id:string;entryId:string;replyToId:string|null;replyToName:string|null;body:string;author:PublicPerson;createdAt:string};
export type PageResult<T>={items:T[];nextOffset:number|null};
export type EntryQuery={view?:'public'|'following'|'mine'|'participated'|'bookmarks'|'learning'|'group';kind?:'all'|'discussion'|EntryKind;resourceType?:string;q?:string;topic?:string;authorId?:string;groupId?:string;offset?:number;limit?:number};
export type ContentDraft={stageId?:string|null;title:string;body:string;topics:string[];scope?:'public'|'self';resourceType?:NonNullable<ServiceEntry['resourceType']>};
export type NewEntry={kind:EntryKind;title?:string;body:string;resourceType?:'note'|'route'|'exercise'|'link'|'scene';topics?:string[];scope?:EntryScope;groupId?:string;stageId?:string|null;license?:string};
function params(input:Record<string,unknown>){const query=new URLSearchParams();for(const [key,value] of Object.entries(input))if(value!==undefined&&value!=='')query.set(key,String(value));return query.size?`?${query.toString().replace(/\+/g,'%20')}`:'';}
// Keep the same key while a result is uncertain; confirmed operations get a fresh key.
// Keys and payload comparisons stay in memory and are discarded on identity change.
const retries=new Map<string,{payload:string;key:string}>();
if(typeof window!=='undefined')window.addEventListener(SESSION_CHANGED,()=>retries.clear());
export async function contentMutation<T>(path:string,accountId:string,body?:unknown,method:'POST'|'PUT'|'DELETE'='POST'):Promise<T>{
  const slot=`${accountId}:${method}:${path}`,payload=JSON.stringify(body??null),previous=retries.get(slot),attempt=previous?.payload===payload?previous:{payload,key:crypto.randomUUID()};
  retries.set(slot,attempt);
  const result=await serviceClient.request<T>(path,{method,body,authenticated:true,accountScope:accountId,idempotencyKey:attempt.key});
  if(retries.get(slot)===attempt)retries.delete(slot);
  return result;
}
const mutate=contentMutation;
export const communityContent={
  list:(input:EntryQuery={},signal?:AbortSignal)=>serviceClient.request<PageResult<ServiceEntry>>('/entries'+params(input),{signal}),
  get:(id:string,signal?:AbortSignal)=>serviceClient.request<ServiceEntry>(`/entries/${id}`,{signal}),
  create:(accountId:string,input:NewEntry)=>mutate<ServiceEntry>('/entries',accountId,input),
  update:(accountId:string,id:string,input:ContentDraft)=>mutate<ServiceEntry>(`/entries/${id}`,accountId,input,'PUT'),
  withdraw:(accountId:string,id:string)=>mutate<{withdrawn:true}>(`/entries/${id}`,accountId,undefined,'DELETE'),
  restore:(accountId:string,id:string)=>mutate<ServiceEntry>(`/entries/${id}/restore`,accountId,{}),
  relation:(accountId:string,id:string,kind:'bookmark'|'learning',enabled:boolean)=>mutate<{enabled:boolean}>(`/entries/${id}/${kind}`,accountId,{enabled},'PUT'),
  solution:(accountId:string,id:string,commentId:string|null)=>mutate<ServiceEntry>(`/entries/${id}/solution`,accountId,{commentId},'PUT'),
  comments:(id:string,limit=3,offset=0,signal?:AbortSignal)=>serviceClient.request<PageResult<ServiceComment>>(`/entries/${id}/comments${params({limit,offset})}`,{signal}),
  comment:(accountId:string,id:string,body:string,replyToId?:string,stageId?:string)=>mutate<{id:string}>(`/entries/${id}/comments`,accountId,{body,...(replyToId?{replyToId}:{}),...(stageId?{stageId}:{})}),
  removeComment:(accountId:string,id:string)=>mutate<{withdrawn:true}>(`/comments/${id}`,accountId,{},'DELETE'),
  people:(input:{q?:string;offset?:number;following?:boolean}={},signal?:AbortSignal)=>serviceClient.request<PageResult<PublicPerson>>('/people'+params(input.following===false?{...input,following:undefined}:input),{signal}),
  person:(id:string,signal?:AbortSignal)=>serviceClient.request<PublicPerson>(`/people/${id}`,{signal}),
  follow:(accountId:string,id:string,enabled:boolean)=>mutate<{enabled:boolean}>(`/people/${id}/follow`,accountId,{enabled},'PUT'),
  draft:(kind:'post'|'resource',signal?:AbortSignal)=>serviceClient.request<ContentDraft>(`/me/drafts/${kind}`,{signal}),
  saveDraft:(accountId:string,kind:'post'|'resource',draft:ContentDraft)=>mutate<ContentDraft>(`/me/drafts/${kind}`,accountId,draft,'PUT'),
};
