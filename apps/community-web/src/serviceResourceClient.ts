import {serviceClient,ServiceApiError} from './serviceClient';
import {contentMutation} from './serviceContentClient';
import type {BasicDelivery} from '../../community-api/src/basicSharing';
import type {ResourcePreview} from '../../community-api/src/resourceFormat';
export type ResourceFile={id:string;role:'main'|'attachment'|'image'|'cover';name:string;mime:string;bytes:number;hash?:string;state?:'pending'|'ready'|'cancelled'};
export type ResourceVersion={delivery:BasicDelivery;id:string;entryId:string;version:number;title:string;body:string;license:string;createdAt:string;preview:ResourcePreview;files:ResourceFile[]};
export type Receipt={id:string;entryId:string;version:number;title:string;state:string;errorCode?:string;updatedAt:string;result?:{kind?:string;documents?:{id:string;state:string}[]}};
export type ConnectedDevice={id:string;label:string;isDefault:boolean;lastSeenAt:string|null};
async function binary(accountId:string,path:string,options:{data?:File;uploadToken?:string;downloadToken?:string}):Promise<Blob>{
  const session=await serviceClient.getSession();if(session.kind!=='authenticated'||session.account.accountId!==accountId)throw new ServiceApiError('account_changed','账号已变化，请重新打开此页面。');
  const config=serviceClient.configuration;if(config.kind!=='configured')throw new ServiceApiError('not_configured','社区服务尚未配置。');
  const response=await fetch(config.baseUrl+path,{method:options.data?'PUT':'GET',credentials:'include',cache:'no-store',headers:{...(options.data?{'Content-Type':'application/octet-stream','X-Upload-Token':options.uploadToken!}:{}),...(options.downloadToken?{'X-Download-Token':options.downloadToken}:{}),'X-CSRF-Token':session.csrfToken},body:options.data});
  if(!response.ok){let message='文件传输未能完成，请重试。';try{message=(await response.json()).error.message||message;}catch{}throw new ServiceApiError('file_transfer_failed',message,true,response.status);}
  return response.blob();
}
export const communityResources={
  createStage:(accountId:string)=>contentMutation<{stageId:string}>('/resource-stages',accountId,{}),
  stage:(id:string,signal?:AbortSignal)=>serviceClient.request<{stageId:string;files:ResourceFile[]}>(`/resource-stages/${id}`,{signal}),
  async upload(accountId:string,stageId:string,file:File,role:ResourceFile['role'],key:string){
    const intent=await serviceClient.request<{attachmentId:string;uploadToken:string}>(`/resource-stages/${stageId}/files`,{method:'POST',body:{name:file.name,mime:file.type||(file.name.endsWith('.lnresource')?'application/octet-stream':/\.md$/i.test(file.name)?'text/markdown':'application/octet-stream'),bytes:file.size,role},authenticated:true,accountScope:accountId,idempotencyKey:key});
    await binary(accountId,`/attachments/${intent.attachmentId}/content`,{data:file,uploadToken:intent.uploadToken});return intent.attachmentId;
  },
  remove:(accountId:string,stageId:string,fileId:string)=>contentMutation(`/resource-stages/${stageId}/files/${fileId}`,accountId,undefined,'DELETE'),
  inspect:(accountId:string,stageId:string,fileId:string)=>serviceClient.request<ResourcePreview>(`/resource-stages/${stageId}/files/${fileId}/inspection`,{authenticated:true,accountScope:accountId}),
  receive:(accountId:string,id:string,versionId:string)=>contentMutation(`/entries/${id}/receive`,accountId,{versionId}),
  versions:(id:string,signal?:AbortSignal)=>serviceClient.request<{current:ResourceVersion|null;versions:{id:string;version:number;createdAt:string}[]}>(`/entries/${id}/versions`,{signal}),
  preview:(id:string,versionId:string,unitId:string,signal?:AbortSignal)=>serviceClient.request<{id:string;title:string;body?:string;minutes?:number;images?:Record<string,string>}>(`/entries/${id}/versions/${versionId}/preview/${unitId}`,{signal}),
  async download(accountId:string,file:ResourceFile){const grant=await serviceClient.request<{token:string}>(`/attachments/${file.id}/download`,{method:'POST',body:{},authenticated:true,accountScope:accountId});return binary(accountId,`/attachments/${file.id}/content`,{downloadToken:grant.token});},
  devices:(signal?:AbortSignal)=>serviceClient.request<ConnectedDevice[]>('/me/devices',{signal}),
  approve:(accountId:string,code:string)=>contentMutation<{approved:true;label:string}>('/me/devices/approve',accountId,{code}),
  revoke:(accountId:string,id:string)=>contentMutation(`/me/devices/${id}`,accountId,undefined,'DELETE'),
  receipts:(signal?:AbortSignal)=>serviceClient.request<Receipt[]>('/me/receipts',{signal}),
  changeReceipt:(accountId:string,id:string,action:'cancel'|'retry')=>contentMutation(`/me/receipts/${id}`,accountId,{action},'PUT'),
};
