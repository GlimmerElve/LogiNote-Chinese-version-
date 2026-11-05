import {serviceClient} from './serviceClient';
import {contentMutation,type PublicPerson} from './serviceContentClient';
export type MessageFile={id:string;name:string;mime:string;bytes:number};
export type Conversation={id:string;person:PublicPerson;state:'pending'|'accepted'|'rejected';incoming:boolean;blockedByMe:boolean;contactUnavailable:boolean;canSend:boolean;updatedAt:string};
export type PrivateMessage={id:string;position:string;senderId:string;clientId?:string;body:string;files:MessageFile[];visible:boolean;createdAt:string};
export type MessageDraft={body:string;clientId?:string;stageId?:string;files:MessageFile[]};
const prefix=(id:string)=>'/conversations/'+id;
export const communityMessages={
  list:(offset=0,signal?:AbortSignal,q='')=>serviceClient.request<{items:Conversation[];nextOffset:number|null}>('/conversations?offset='+offset+(q?'&q='+encodeURIComponent(q):''),{authenticated:true,signal}),
  open:(accountId:string,peerId:string)=>contentMutation<Conversation>('/conversations',accountId,{peerId}),
  get:(id:string,signal?:AbortSignal)=>serviceClient.request<Conversation>(prefix(id),{authenticated:true,signal}),
  sync:(id:string,after?:string,signal?:AbortSignal)=>serviceClient.request<{items:PrivateMessage[];conversation:Conversation;nextBefore:string|null;nextAfter:string|null}>(prefix(id)+'/sync'+(after?'?after='+after:''),{authenticated:true,signal}),
  history:(id:string,input:{after?:string;before?:string}={},signal?:AbortSignal)=>serviceClient.request<{items:PrivateMessage[];nextBefore:string|null;nextAfter:string|null}>(prefix(id)+'/messages'+(input.after?'?after='+input.after:input.before?'?before='+input.before:''),{authenticated:true,signal}),
  change:(accountId:string,id:string,action:'accept'|'reject'|'hide')=>contentMutation(prefix(id),accountId,{action},'PUT'),
  block:(accountId:string,peerId:string,enabled:boolean)=>contentMutation('/people/'+peerId+'/block',accountId,{enabled},'PUT'),
  blocked:(signal?:AbortSignal)=>serviceClient.request<{accountId:string;displayName:string}[]>('/me/blocked',{authenticated:true,signal}),
  draft:(id:string,signal?:AbortSignal)=>serviceClient.request<MessageDraft>(prefix(id)+'/draft',{authenticated:true,signal}),
  saveDraft:(accountId:string,id:string,draft:MessageDraft)=>contentMutation<MessageDraft>(prefix(id)+'/draft',accountId,{body:draft.body,clientId:draft.clientId,...(draft.stageId?{stageId:draft.stageId}:{})},'PUT'),
  stage:(accountId:string,id:string)=>contentMutation<{stageId:string}>(prefix(id)+'/stages',accountId,{}),
  send:(accountId:string,id:string,draft:MessageDraft)=>contentMutation<{id:string}>(prefix(id)+'/messages',accountId,{body:draft.body,clientId:draft.clientId,...(draft.stageId&&draft.files.length?{stageId:draft.stageId}:{})}),
  async upload(accountId:string,stageId:string,file:File,key:string){
    const intent=await serviceClient.request<{attachmentId:string;uploadToken:string}>('/attachments/intents',{method:'POST',body:{objectId:stageId,name:file.name,mime:file.type,bytes:file.size},authenticated:true,accountScope:accountId,idempotencyKey:key});
    const session=await serviceClient.getSession(),config=serviceClient.configuration;if(session.kind!=='authenticated'||session.account.accountId!==accountId||config.kind!=='configured')throw Error('账号已变化，请重新打开会话。');
    const response=await fetch(config.baseUrl+'/attachments/'+intent.attachmentId+'/content',{method:'PUT',credentials:'include',headers:{'Content-Type':'application/octet-stream','X-CSRF-Token':session.csrfToken,'X-Upload-Token':intent.uploadToken},body:file});
    if(!response.ok){let message='图片上传失败，请重试。';try{message=(await response.json()).error.message||message;}catch{}throw Error(message);}
    return {id:intent.attachmentId,name:file.name,mime:file.type,bytes:file.size};
  },
  removeImage:(accountId:string,id:string,stageId:string,fileId:string)=>contentMutation(prefix(id)+'/stages/'+stageId+'/files/'+fileId,accountId,undefined,'DELETE'),
};
