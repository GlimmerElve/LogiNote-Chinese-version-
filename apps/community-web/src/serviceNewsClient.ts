import {serviceClient} from './serviceClient';
import {contentMutation,type ServiceEntry} from './serviceContentClient';
import type {InlineImageFile} from './ContentImages';
export type NewsKind='news'|'article'|'announcement';
export type NewsSourceInfo={sourceName?:string|null;sourcePublishedAt?:string|null;sourceDateLabel?:string|null};
export type NewsRevision={id:string;number:number;state:string;title:string;body:string;topics:string[];sourceUrl:string;reason:string;images:InlineImageFile[]};
export type NewsDraft=NewsSourceInfo&{id:string;version:number;kind:NewsKind;origin:string;author:{accountId:string;displayName:string};published:boolean;withdrawn:boolean;revision:NewsRevision;events:{position:string;action:string;reason:string;createdAt:string;actorName:string}[]};
export type NewsItem=NewsSourceInfo&{id:string;kind:NewsKind;origin:string;title:string;summary:string;state:string;reason:string;sourceUrl:string;authorName:string;publishedAt:string|null};
export type NewsInput={title:string;body:string;topics:string[];sourceUrl:string;kind?:NewsKind;expectedVersion?:number;stageId?:string};
const root='/news/';
export const communityNews={
  list:(view:string,q='',offset=0,signal?:AbortSignal)=>serviceClient.request<{items:NewsItem[];nextOffset:number|null}>('/news?'+new URLSearchParams({view,q,offset:String(offset)}).toString().replaceAll('+','%20'),{signal}),
  draft:(id:string,signal?:AbortSignal,review=false)=>serviceClient.request<NewsDraft>(root+id+(review?'/review':'/draft'),{signal}),
  read:(id:string,signal?:AbortSignal)=>serviceClient.request<NewsSourceInfo&{kind:NewsKind;origin:string;sourceUrl:string;number:number;entry:ServiceEntry}>(root+id,{signal}),
  save:(accountId:string,id:string|undefined,input:NewsInput,key:string)=>serviceClient.request<NewsDraft>(id?root+id+'/draft':'/news/drafts',{method:id?'PUT':'POST',body:input,authenticated:true,accountScope:accountId,idempotencyKey:key}),
  submit:(accountId:string,value:NewsDraft)=>contentMutation<NewsDraft>(root+value.id+'/submit',accountId,{expectedVersion:value.version}),
  withdraw:(accountId:string,value:NewsDraft,target:'pending'|'published')=>contentMutation<NewsDraft>(root+value.id+'/withdraw',accountId,{expectedVersion:value.version,target}),
  review:(accountId:string,value:NewsDraft,action:string,reason:string)=>contentMutation<NewsDraft>(root+value.id+'/review',accountId,{expectedVersion:value.version,revisionId:value.revision.id,action,reason}),
};
