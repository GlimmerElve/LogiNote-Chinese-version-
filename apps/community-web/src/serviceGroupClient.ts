import {serviceClient} from './serviceClient';
import {contentMutation,type PageResult,type PublicPerson,type ContentDraft} from './serviceContentClient';
import {communityMessages,type PrivateMessage,type MessageDraft} from './serviceMessageClient';
import type {MessageTransport} from './ServiceMessages';
export type GroupInfo={id:string;name:string;description:string;joinPolicy:'open'|'request';state:'active'|'archived';ownerId:string;learningPaused:boolean;membership:'none'|'active'|'left'|'invited'|'requested'|'banned';role:'owner'|'administrator'|'member'|null;canManage:boolean;canSend:boolean;memberLimit:number;memberCount:number;mutedUntil:string|null};
export type GroupMember=PublicPerson&{role:'owner'|'administrator'|'member';state:string;mutedUntil:string|null};
export type GroupMessage=PrivateMessage&{senderName:string;threadId:string|null;pinned:boolean;threadClosed:boolean;replyCount:number};
export type GroupAudit={id:string;action:string;actorName:string;targetName:string|null;createdAt:string};
const base=(id:string)=>'/groups/'+id;
const query=(input:Record<string,unknown>)=>{const q=new URLSearchParams();for(const [key,value] of Object.entries(input))if(value!==undefined&&value!=='')q.set(key,String(value));return q.size?'?'+q.toString():'';};
export const communityGroups={
  list:(input:{view?:'mine'|'discover';q?:string;offset?:number}={},signal?:AbortSignal)=>serviceClient.request<PageResult<GroupInfo>>('/groups'+query(input),{signal}),
  overview:(id:string,signal?:AbortSignal)=>serviceClient.request<{group:GroupInfo;pins:GroupMessage[]}>(base(id)+'/overview',{signal}),
  get:(id:string,signal?:AbortSignal)=>serviceClient.request<GroupInfo>(base(id),{signal}),
  create:(accountId:string,input:{name:string;description:string;joinPolicy:'open'|'request'})=>contentMutation<GroupInfo>('/groups',accountId,input),
  update:(accountId:string,id:string,input:Partial<Pick<GroupInfo,'name'|'description'|'joinPolicy'|'state'>>)=>contentMutation<GroupInfo>(base(id),accountId,input,'PUT'),
  dissolve:(accountId:string,id:string)=>contentMutation<{dissolved:true}>(base(id),accountId,undefined,'DELETE'),
  participation:(accountId:string,id:string,paused:boolean)=>contentMutation<GroupInfo>(base(id)+'/participation',accountId,{paused},'PUT'),
  membership:(accountId:string,id:string,action:'join'|'leave'|'cancel')=>contentMutation(base(id)+'/membership',accountId,{action}),
  members:(id:string,offset=0,signal?:AbortSignal)=>serviceClient.request<PageResult<GroupMember>>(base(id)+'/members'+query({offset}),{authenticated:true,signal}),
  manage:(accountId:string,id:string,memberId:string,action:string,until?:string)=>contentMutation(base(id)+'/members/'+memberId,accountId,{action,...(until?{until}:{})},'PUT'),
  audit:(id:string,offset=0,signal?:AbortSignal)=>serviceClient.request<PageResult<GroupAudit>>(base(id)+'/audit'+query({offset}),{authenticated:true,signal}),
  history:(id:string,input:{after?:string;before?:string;threadId?:string}={},signal?:AbortSignal)=>serviceClient.request<{items:GroupMessage[];syncCursor:string;nextBefore:string|null;nextAfter:string|null}>(base(id)+'/messages'+query(input),{authenticated:true,signal}),
  sync:(id:string,since:string,signal?:AbortSignal)=>serviceClient.request<{changes:GroupMessage[];cursor:string;hasMore:boolean}>(base(id)+'/sync'+query({since}),{authenticated:true,signal}),
  topic:(id:string,messageId:string,signal?:AbortSignal)=>serviceClient.request<GroupMessage>(base(id)+'/messages/'+messageId,{authenticated:true,signal}),
  pins:(id:string,signal?:AbortSignal)=>serviceClient.request<GroupMessage[]>(base(id)+'/pins',{authenticated:true,signal}),
  messageAction:(accountId:string,id:string,messageId:string,action:string)=>contentMutation(base(id)+'/messages/'+messageId,accountId,{action},'PUT'),
  contentDraft:(id:string,kind:'post'|'resource',signal?:AbortSignal)=>serviceClient.request<ContentDraft>(base(id)+'/content-drafts/'+kind,{authenticated:true,signal}),
  saveContentDraft:(accountId:string,id:string,kind:'post'|'resource',draft:ContentDraft)=>contentMutation<ContentDraft>(base(id)+'/content-drafts/'+kind,accountId,draft,'PUT'),
};
// The same composer, image pipeline and retry keys serve direct rooms and group threads.
export function groupMessageTransport(threadId?:string):MessageTransport{
  const context=threadId?{threadId}:{};
  const payload=(draft:MessageDraft)=>({body:draft.body,clientId:draft.clientId,...context,...(draft.stageId&&draft.files.length?{stageId:draft.stageId}:{})});
  return {
    draft:(id,signal)=>serviceClient.request<MessageDraft>(base(id)+'/draft'+query(context),{authenticated:true,signal}),
    saveDraft:(accountId,id,draft)=>contentMutation<MessageDraft>(base(id)+'/draft',accountId,{...payload(draft),...(draft.stageId?{stageId:draft.stageId}:{})},'PUT'),
    send:(accountId,id,draft)=>contentMutation<{id:string}>(base(id)+'/messages',accountId,payload(draft)),
    stage:(accountId,id)=>contentMutation<{stageId:string}>(base(id)+'/stages',accountId,context),
    upload:communityMessages.upload,
    removeImage:(accountId,id,stageId,fileId)=>contentMutation(base(id)+'/stages/'+stageId+'/files/'+fileId,accountId,undefined,'DELETE'),
  };
}

export type GroupTask={id:string;groupId:string;title:string;body:string;dueOn:string|null;state:'open'|'closed'|'removed';closed:boolean;version:number;creatorId:string;creatorName:string;myState:'none'|'doing'|'done';progressVersion:number;completedAt:string|null;participantCount:number;completedCount:number;createdAt:string;updatedAt:string};
export type GroupTaskDraft={title:string;body?:string;dueOn?:string|null};
export type TaskActivity={id:string;action:string;actorName:string;createdAt:string};
export const groupTasks={
  list:(id:string,input:{view?:string;offset?:number}={},signal?:AbortSignal)=>serviceClient.request<PageResult<GroupTask>>(base(id)+'/tasks'+query(input),{authenticated:true,signal}),
  get:(id:string,taskId:string,signal?:AbortSignal)=>serviceClient.request<GroupTask>(base(id)+'/tasks/'+taskId,{authenticated:true,signal}),
  create:(accountId:string,id:string,input:GroupTaskDraft)=>contentMutation<GroupTask>(base(id)+'/tasks',accountId,input),
  update:(accountId:string,id:string,task:GroupTask,action:string,fields?:GroupTaskDraft)=>contentMutation<GroupTask>(base(id)+'/tasks/'+task.id,accountId,{action,expectedVersion:task.version,...fields},'PUT'),
  progress:(accountId:string,id:string,task:GroupTask,state:GroupTask['myState'])=>contentMutation<GroupTask>(base(id)+'/tasks/'+task.id+'/progress',accountId,{state,expectedVersion:task.progressVersion},'PUT'),
  activity:(id:string,taskId:string,before?:string,signal?:AbortSignal)=>serviceClient.request<{items:TaskActivity[];nextBefore:string|null}>(base(id)+'/tasks/'+taskId+'/activity'+query({before}),{authenticated:true,signal}),
};
