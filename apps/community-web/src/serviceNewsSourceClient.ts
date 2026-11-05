import {serviceClient} from './serviceClient';
import {contentMutation} from './serviceContentClient';

export type NewsSource={
  id:string;name:string;url:string;description:string;recommended?:boolean;enabled:boolean;intervalMinutes:number;version:number;
  lastAttemptAt:string|null;lastSuccessAt:string|null;nextCheckAt:string|null;lastStatus:string|null;lastError:string|null;
  consecutiveFailures:number;importedCount:number;authorizedBy:string|null;authorizedAt:string|null;
  lastRun?:{status:string;imported:number;duplicates:number;ignored:number;message:string;finishedAt:string|null}|null;
};
export type NewsSources={items:NewsSource[];limits:{minimumIntervalMinutes:number;maxItemsPerRun:number;maxRequestsPerDay:number;maxBytesPerDay:number;maxFeedBytes:number};usage:{day:string;requests:number;bytes:number}};
export type NewsCollection={status:'collected'|'not_modified'|'skipped'|'failed';reason?:string;imported:number;duplicates:number;ignored:number;nextCheckAt:string|null};
export const communityNewsSources={
  list:(accountId:string,signal?:AbortSignal)=>serviceClient.request<NewsSources>('/news/sources',{authenticated:true,accountScope:accountId,signal}),
  save:(accountId:string,value:NewsSource,input:{enabled?:boolean;intervalMinutes?:number})=>contentMutation<NewsSource>('/news/sources/'+value.id,accountId,{expectedVersion:value.version,enabled:input.enabled??value.enabled,intervalMinutes:input.intervalMinutes??value.intervalMinutes},'PUT'),
  collect:(accountId:string,id:string)=>contentMutation<NewsCollection>('/news/sources/'+id+'/collect',accountId,{}),
};
