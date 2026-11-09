import fs from 'node:fs/promises';
import {LEARNING_METRICS,statisticsDate,type LearningStatisticsPolicy,type LearningStatisticsSnapshot} from '../../apps/community-api/src/learningStatisticsContract';
import {MAX_RESOURCE_FILE_BYTES,FILE_TRANSFER_TIMEOUT_MS} from '../../apps/community-api/src/uploadLimits';
import {MAX_TRANSFER_CHUNK_BYTES,LEGACY_FILE_TRANSFER,parseFileTransferCapabilities,transferRanges,verifyTransferRange,verifyUploadChunk,type FileTransferCapabilities,type TransferRange} from '../services/community/fileTransfer';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import type {NoteItem,ResourceItem} from '../types';
import {detectLocalFileType} from '../services/localResource';
import {atomicWriteTextFile} from './atomicWrite';
import {exportCommunitySnapshot,type SnapshotAsset} from '../services/community/snapshotExport';
import {preparationRoot} from '../services/progressiveLearning/preparation';
import {basicResourceDelivery,publicResourceUrl,type BasicDelivery} from '../../apps/community-api/src/basicSharing';
import {exportCommunityNotes} from '../services/community/resourceExport';
import {prepareCommunityNotes,scheduleCommunityPlan,communityPlanLeafDependencies} from '../services/community/resourceImport';
import {inspectResource,readResourcePackage,createResourcePackage,type ResourceManifest} from '../../apps/community-api/src/resourceFormat';
import type {CommunityDesktopState,CommunityPreparedResource,CommunityLocalTemplate,CommunitySavedResource} from '../services/community/desktopTypes';

type Environment={vaultRoot:string;userStateDir:string;dataRoot:string;epoch:number};
type DocumentReceipt={id:string;state:'indexing'|'indexed'|'stored'};
// Kept under its original persisted key for compatibility; includes committed
// copies awaiting an acknowledgement as well as documents still being indexed.
type PendingIndex={receiptId:string;leaseToken:string;documentId?:string;documents?:DocumentReceipt[];result?:ImportResult};
type Secret={token:string;pendingIndexes:PendingIndex[]};
type Binding={version:1;api:string;targetKey:string;rootHash:string;accountId?:string;displayName?:string;deviceId?:string;secret?:string};
type FileDescriptor={id:string;name:string;mime:string;bytes:number;hash:string;role:string};
type Version={delivery?:BasicDelivery;id:string;entryId:string;version:number;title:string;body:string;preview:{format:string};files:FileDescriptor[]};
type Task={id:string;accountId:string;targetKey:string;entryId:string;version:Version;leaseToken:string};
type TemplateRow=CommunityLocalTemplate&{manifest:ResourceManifest;resources?:ResourceItem[];source:{accountId:string;entryId:string;versionId:string};activation?:{startDate:string;dailyMinutes:number;weekdays?:number[]}};
type Prepared={descriptor:CommunityPreparedResource;bytes:Uint8Array;environment:Environment;expires:number;snapshot?:boolean;assets?:SnapshotAsset[];attempts?:Map<string,{stageId?:string;intent?:{attachmentId:string;uploadToken:string};uploaded?:boolean;entryId?:string;assets?:Record<string,{id:string;token:string;uploaded?:boolean}>}>};
type ImportResult={state:'imported'|'stored'|'indexing'|'indexed';localIds:string[];kind?:'template'|'notes'|'document'|'link';documents?:DocumentReceipt[]};
class CommunityHttpError extends Error{constructor(message:string,readonly status:number){super(message);}}
type RequestOptions={method?:string;body?:unknown;key?:string;token?:string;headers?:Record<string,string>;binary?:Uint8Array;download?:boolean;expectedDownloadBytes?:number;range?:TransferRange};
export interface CommunityHostOptions{
  apiUrl:string;
  origin:string;
  environment:()=>Environment;
  deviceLabel?:(environment:Environment)=>string;
  loadNotes:()=>Promise<NoteItem[]>;
  progressiveTeaching?:(noteId:string)=>Promise<import('../services/progressiveLearning/types').SharedProgressiveTeaching|null>;
  readLearningStatistics?:(environment:Environment)=>Promise<LearningStatisticsSnapshot>;
  changeNotes:(change:(notes:NoteItem[])=>NoteItem[],isCurrent:()=>boolean)=>Promise<void>;
  importDocument:(input:{id:string;name:string;sourcePath:string;bytes:number;hash:string;sourceUrl:string;communitySource?:{accountId:string;entryId:string;versionId:string;role:string;kind?:'snapshot'|'file'}},isCurrent:()=>boolean)=>Promise<{id:string;status:'indexing'|'indexed'|'stored'}>;
  readSnapshot?:(id:string,isCurrent:()=>boolean)=>Promise<string>;
  snapshotDocumentIds?:(isCurrent:()=>boolean)=>Promise<string[]>;
  documentStatus:(id:string)=>Promise<'indexing'|'indexed'|'stored'>;
  encrypt:(value:string)=>string|null;
  decrypt:(value:string)=>string;
}
const hash=(value:string|Uint8Array)=>createHash('sha256').update(value).digest('hex');
const isId=(value:unknown):value is string=>typeof value==='string'&&/^[a-zA-Z0-9_-]{1,150}$/.test(value);
function check(value:unknown,message:string):asserts value{if(!value)throw Error(message);}
const same=(a:Environment,b:Environment)=>a.epoch===b.epoch&&path.resolve(a.vaultRoot)===path.resolve(b.vaultRoot)&&path.resolve(a.userStateDir)===path.resolve(b.userStateDir)&&path.resolve(a.dataRoot)===path.resolve(b.dataRoot);
function validateApi(value:string){if(!value)return '';const url=new URL(value);check(!url.username&&!url.password&&!url.search&&!url.hash&&url.pathname==='/api/community/v1'&&(url.protocol==='https:'||url.protocol==='http:'&&['127.0.0.1','localhost','[::1]'].includes(url.hostname)),'社区服务地址不正确。');return url.href.replace(/\/$/,'');}
async function privateDirectory(parent:string,name:string){await fs.mkdir(parent,{recursive:true});const directory=path.resolve(parent,name);check(path.dirname(directory)===path.resolve(parent),'社区目录越界。');await fs.mkdir(directory,{recursive:true});const stat=await fs.lstat(directory);check(stat.isDirectory()&&!stat.isSymbolicLink(),'社区目录不能使用符号链接。');return directory;}

/** Host-only bridge. Renderer never receives device tokens, filesystem paths or arbitrary-file reads. */
export class CommunityHost{
  private readonly api:string;
  private binding:Binding|null=null;
  private secret:Secret|null=null;
  private bindingEnvironment:Environment|null=null;
  private bindingLoad:{environment:Environment;promise:Promise<void>}|null=null;
  private bindingWrites:Promise<void>=Promise.resolve();
  private pairingGeneration=0;
  private pairing:{id:string;code:string;claimToken:string;expiresAt:string;environment:Environment;generation:number}|null=null;
  private pairingPoll:{pairing:NonNullable<CommunityHost['pairing']>;promise:Promise<void>}|null=null;
  private prepared=new Map<string,Prepared>();
  private active=false;
  private stopped=false;
  private timer:ReturnType<typeof setInterval>|null=null;
  private lastStatus='';
  private statisticsDirty=0;
  private statisticsLast:{key:string;fingerprint:string;checked:number;dirty:number}|null=null;
  private statisticsRetryAt=0;
  private referenceWrites:Promise<void>=Promise.resolve();
  private receivingCleanup=new Set<string>();
  private focusWanted=false;
  private focusSync:Promise<void>|null=null;
  private focusAgain=false;
  private focusLease:{environment:Environment;token:string;enabled:boolean;checked:number}|null=null;
  private fileTransfer:{expires:number;promise:Promise<FileTransferCapabilities>}|null=null;
  constructor(private readonly options:CommunityHostOptions){this.api=validateApi(options.apiUrl);}
  private current(environment:Environment){return !this.stopped&&same(environment,this.options.environment());}
  private sessionCurrent(environment:Environment,token:string,accountId:string,targetKey:string){return this.current(environment)&&this.secret?.token===token&&this.binding?.accountId===accountId&&this.binding.targetKey===targetKey;}
  private async localBinding(){
    const environment={...this.options.environment()};
    if(this.bindingLoad&&same(environment,this.bindingLoad.environment)){await this.bindingLoad.promise;check(this.current(environment),'知识库已切换。');return;}
    if(this.bindingEnvironment&&same(environment,this.bindingEnvironment))return;
    if(this.bindingEnvironment||this.bindingLoad)this.focusWanted=false;
    this.focusLease=null;this.secret=null;this.binding=null;this.pairing=null;this.pairingGeneration++;this.prepared.clear();this.statisticsLast=null;this.statisticsRetryAt=0;this.bindingEnvironment=null;
    const load={environment,promise:Promise.resolve()};this.bindingLoad=load;
    load.promise=(async()=>{
      let saved:Binding|undefined;try{const file=path.join(environment.userStateDir,'community-device.json');const stat=await fs.lstat(file);check(stat.isFile()&&!stat.isSymbolicLink(),'桌面连接记录无效。');saved=JSON.parse(await fs.readFile(file,'utf8'));}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
      const rootHash=hash(path.resolve(environment.vaultRoot));let binding:Binding,secret:Secret|null=null;
      if(saved?.version===1&&saved.api===this.api&&saved.rootHash===rootHash&&isId(saved.targetKey)){binding=saved;if(saved.secret){try{secret=JSON.parse(this.options.decrypt(saved.secret));}catch{secret=null;}}}
      else binding={version:1,api:this.api,targetKey:randomUUID(),rootHash};
      await this.cleanStaleReceiving(environment);
      check(this.bindingLoad===load&&this.current(environment),'知识库已切换，未加载旧社区授权。');
      // Publish a fully loaded binding together: focus sync and receipt polling
      // must never observe an environment marker while its token is still loading.
      this.binding=binding;this.secret=secret;this.bindingEnvironment=environment;
    })().finally(()=>{if(this.bindingLoad===load)this.bindingLoad=null;});
    await load.promise;
  }
  private async cleanStaleReceiving(environment:Environment){
    const directory=path.resolve(environment.userStateDir,'community-receive');check(path.dirname(directory)===path.resolve(environment.userStateDir),'社区目录越界。');
    let stat;try{stat=await fs.lstat(directory);}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return;throw error;}
    check(stat.isDirectory()&&!stat.isSymbolicLink(),'社区目录不能使用符号链接。');
    for(const name of await fs.readdir(directory)){
      check(this.current(environment),'知识库已切换。');
      if(!/^community-[a-f\d]{32}\.[a-zA-Z0-9]{1,12}$/.test(name))continue;
      const file=path.join(directory,name),item=await fs.lstat(file).catch(error=>{if((error as NodeJS.ErrnoException).code==='ENOENT')return null;throw error;});
      // Old staging files have no independent source authority. Retry downloads
      // regenerate them; leave fresh files alone in case another host is active.
      if(item?.isFile()&&!item.isSymbolicLink()&&(this.receivingCleanup.has(file)||Date.now()-item.mtimeMs>=24*60*60_000))await this.removeReceivingFile(file,environment);
    }
  }
  private async removeReceivingFile(file:string,environment:Environment){
    const directory=path.resolve(environment.userStateDir,'community-receive');
    check(path.dirname(directory)===path.resolve(environment.userStateDir)&&path.dirname(path.resolve(file))===directory&&/^community-[a-f\d]{32}\.[a-zA-Z0-9]{1,12}$/.test(path.basename(file)),'社区临时文件越界。');
    let folder;try{folder=await fs.lstat(directory);}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT'){this.receivingCleanup.delete(file);return;}throw error;}check(folder.isDirectory()&&!folder.isSymbolicLink(),'社区临时目录不能使用符号链接。');
    let entry;try{entry=await fs.lstat(file);}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT'){this.receivingCleanup.delete(file);return;}throw error;}
    check(entry.isFile()&&!entry.isSymbolicLink(),'社区临时文件无效。');
    try{await fs.unlink(file);this.receivingCleanup.delete(file);}catch(error){
      const code=(error as NodeJS.ErrnoException).code;
      if(code==='ENOENT'){this.receivingCleanup.delete(file);return;}
      if(['EPERM','EACCES','EBUSY'].includes(code||'')){this.receivingCleanup.add(file);return;}
      throw error;
    }
  }
  private async retryReceivingCleanup(environment:Environment){
    const directory=path.resolve(environment.userStateDir,'community-receive');
    for(const file of [...this.receivingCleanup]){if(path.dirname(file)!==directory)continue;check(this.current(environment),'知识库已切换。');await this.removeReceivingFile(file,environment);}
  }
  private async saveBinding(){
    const environment=this.bindingEnvironment,binding=this.binding,secret=this.secret;check(environment&&binding&&this.current(environment),'知识库已切换，请重新连接。');
    const encrypted=secret?this.options.encrypt(JSON.stringify(secret)):null,content=JSON.stringify({...binding,secret:encrypted||undefined});
    const work=async()=>{await privateDirectory(environment.userStateDir,'community');check(this.binding===binding&&this.secret===secret&&this.current(environment),'社区账号或知识库已切换，未保存旧授权。');await atomicWriteTextFile(path.join(environment.userStateDir,'community-device.json'),content,{allowCopyFallback:false});if(this.binding===binding&&this.current(environment))binding.secret=encrypted||undefined;};
    const pending=this.bindingWrites.then(work,work);this.bindingWrites=pending.then(()=>{},()=>{});await pending;
  }
  private async transferCapabilities():Promise<FileTransferCapabilities>{
    if(this.fileTransfer&&this.fileTransfer.expires>Date.now())return this.fileTransfer.promise;
    const pending={expires:Date.now()+60_000,promise:Promise.resolve(LEGACY_FILE_TRANSFER)};
    pending.promise=this.send<unknown>('/capabilities').then(parseFileTransferCapabilities).catch(error=>{if(error instanceof CommunityHttpError&&error.status===404)return LEGACY_FILE_TRANSFER;if(this.fileTransfer===pending)this.fileTransfer=null;throw error;});this.fileTransfer=pending;return pending.promise;
  }
  private async request<T>(route:string,options:RequestOptions={}):Promise<T>{
    const size=options.binary?.length||options.expectedDownloadBytes||0;
    // Cloud HTTP has a lower body limit than the old local server. Discover at
    // the safe 4 MiB boundary, then follow the server's negotiated threshold.
    const capability=size>MAX_TRANSFER_CHUNK_BYTES?await this.transferCapabilities():LEGACY_FILE_TRANSFER;
    if(options.binary&&capability.chunkedUpload&&size>capability.thresholdBytes){
      const id=route.match(/^\/desktop\/attachments\/([a-zA-Z0-9_-]+)\/content$/)?.[1];check(id,'社区上传地址不正确。');let result:unknown;
      for(const range of transferRanges(size,capability.chunkBytes)){
        result=await this.send<unknown>(route+`?offset=${range.start}`+(range.end===size-1?'&complete=1':''),{...options,binary:options.binary.subarray(range.start,range.end+1)});verifyUploadChunk(result,id,range);
      }
      return result as T;
    }
    if(options.download&&capability.rangeDownload&&size>capability.thresholdBytes){
      check(size<=MAX_RESOURCE_FILE_BYTES,'接收文件超过 100 MB。');const chunks:Uint8Array[]=[];
      for(const range of transferRanges(size,capability.chunkBytes))chunks.push(await this.send<Uint8Array>(route,{...options,range}));
      return Buffer.concat(chunks) as T;
    }
    return this.send(route,options);
  }
  private async send<T>(route:string,options:RequestOptions={}):Promise<T>{
    check(this.api,'社区服务地址尚未配置。');check(/^\/[a-zA-Z0-9/_-]+(?:\?offset=\d+(?:&complete=1)?)?$/.test(route),'社区请求地址不正确。');
    const response=await fetch(this.api+route,{method:options.method||'GET',redirect:'error',signal:AbortSignal.timeout(options.binary||options.download?FILE_TRANSFER_TIMEOUT_MS:30_000),headers:{Origin:this.options.origin,...(options.body!==undefined?{'Content-Type':'application/json'}:{}),...(options.binary?{'Content-Type':'application/octet-stream'}:{}),...(options.token?{Authorization:`Bearer ${options.token}`}:{}) ,...(options.key?{'Idempotency-Key':options.key}:{}),...options.headers,...(options.range?{Range:`bytes=${options.range.start}-${options.range.end}`}:{})},body:options.binary?Buffer.from(options.binary):options.body===undefined?undefined:JSON.stringify(options.body)});
    if(options.download&&response.ok){if(options.range)check(response.status===206,'社区服务未返回所需文件分块。');const chunks:Uint8Array[]=[];let bytes=0;const reader=response.body!.getReader();try{for(;;){const chunk=await reader.read();if(chunk.done)break;bytes+=chunk.value.length;check(bytes<=(options.range?options.range.end-options.range.start+1:MAX_RESOURCE_FILE_BYTES),'接收文件大小不正确。');chunks.push(chunk.value);}}finally{await reader.cancel().catch(()=>{});reader.releaseLock();}if(options.range)verifyTransferRange(response.headers.get('Content-Range'),options.range,bytes);return Buffer.concat(chunks) as T;}
    const envelope=await response.json();if(!response.ok||!envelope.ok){if(response.status===401&&options.token&&this.secret?.token===options.token){this.secret=null;if(this.binding){delete this.binding.secret;delete this.binding.deviceId;delete this.binding.accountId;delete this.binding.displayName;}await this.saveBinding();}throw new CommunityHttpError(envelope.error?.message||'社区服务暂时不可用。',response.status);}return envelope.value as T;
  }
  async state():Promise<CommunityDesktopState>{await this.localBinding();if(this.pairing)await this.pollPairing();const directory=path.resolve(this.options.environment().userStateDir,'community-receive'),cleanupPending=[...this.receivingCleanup].some(file=>path.dirname(file)===directory);return {configured:!!this.api,connected:!!this.secret,displayName:this.binding?.displayName,accountId:this.binding?.accountId,libraryLabel:path.basename(path.resolve(this.options.environment().vaultRoot))||'知识库',persistent:!!this.binding?.secret,...(this.pairing?{pairing:{code:this.pairing.code,expiresAt:this.pairing.expiresAt}}:{}),lastStatus:[this.lastStatus,cleanupPending?'部分临时接收文件暂未清理完成，将在后续检查时重试。':''].filter(Boolean).join(' ')};}
  async connect(){await this.localBinding();const generation=++this.pairingGeneration,environment={...this.options.environment()},label=(this.options.deviceLabel?.(environment)||'LogiNote 桌面 · '+path.basename(path.resolve(environment.vaultRoot))).replace(/[\u0000-\u001f\u007f]/g,' ').slice(0,60),result=await this.request<{pairingId:string;code:string;claimToken:string;expiresAt:string}>('/desktop/pairings',{method:'POST',body:{label:label||'LogiNote 桌面',targetKey:this.binding!.targetKey}});check(this.current(environment)&&generation===this.pairingGeneration,'社区连接请求已变化，请使用当前连接码。');this.pairing={id:result.pairingId,code:result.code,claimToken:result.claimToken,expiresAt:result.expiresAt,environment,generation};return this.state();}
  private async pollPairing(){
    const pairing=this.pairing;if(!pairing)return;
    if(!this.current(pairing.environment)||pairing.generation!==this.pairingGeneration||Date.parse(pairing.expiresAt)<Date.now()){if(this.pairing===pairing)this.pairing=null;return;}
    if(this.pairingPoll?.pairing===pairing){await this.pairingPoll.promise;return;}
    const poll={pairing,promise:Promise.resolve()};this.pairingPoll=poll;
    poll.promise=this.pollPairingOnce(pairing).finally(()=>{if(this.pairingPoll===poll)this.pairingPoll=null;});
    await poll.promise;
  }
  private async pollPairingOnce(pairing:NonNullable<CommunityHost['pairing']>){
    const current=()=>this.pairing===pairing&&pairing.generation===this.pairingGeneration&&this.current(pairing.environment);
    const result=await this.request<{state:'pending'|'connected';token?:string;accountId?:string;deviceId?:string;displayName?:string;targetKey?:string}>(`/desktop/pairings/${pairing.id}`,{method:'POST',body:{claimToken:pairing.claimToken}});
    // A late claim cannot revive a disconnected or replaced pairing. All state
    // readers and receipt ticks share one claim so they cannot reset index work.
    if(!current())return;
    if(result.state==='connected'){
    check(this.current(pairing.environment)&&result.targetKey===this.binding!.targetKey&&isId(result.accountId)&&isId(result.deviceId)&&typeof result.token==='string','连接目标已变化。');
    if(this.secret&&this.binding?.accountId!==result.accountId){
      // Rebinding this library is a handover, not a second active account. Use
      // the old bearer to revoke only the grant actually owned by this host.
      try{await this.request('/desktop/disconnect',{method:'POST',body:{},token:this.secret.token});}
      catch(error){if(!(error instanceof CommunityHttpError&&error.status===401))throw error;}
      if(!current())return;
      this.prepared.clear();this.statisticsLast=null;this.statisticsRetryAt=0;
    }
    this.focusLease=null;this.secret={token:result.token,pendingIndexes:this.secret?.token===result.token?this.secret.pendingIndexes:[]};Object.assign(this.binding!,{accountId:result.accountId,deviceId:result.deviceId,displayName:result.displayName});this.pairing=null;await this.saveBinding();if(pairing.generation!==this.pairingGeneration||!this.current(pairing.environment)||this.secret?.token!==result.token)return;void this.syncFocus();this.lastStatus='已连接，等待你在网页保存到 LogiNote 的资料或引用。';}}
  async disconnect(){this.pairingGeneration++;this.pairing=null;await this.localBinding();const environment={...this.options.environment()},binding=this.binding,token=this.secret?.token;if(token)await this.request('/desktop/disconnect',{method:'POST',body:{},token});check(this.current(environment)&&this.binding===binding&&this.secret?.token===token,'社区连接已变化，未断开新的账号。');this.focusLease=null;this.secret=null;this.prepared.clear();if(this.binding){delete this.binding.accountId;delete this.binding.displayName;delete this.binding.deviceId;delete this.binding.secret;}await this.saveBinding();}
  async catalog(){await this.localBinding();return (await this.options.loadNotes()).map(note=>({id:note.id,title:note.title,noteType:note.noteType,parentId:note.parentId,hasPlan:!!note.planMeta}));}
  private remember(bytes:Uint8Array,name:string,body?:string):CommunityPreparedResource{const inspected=inspectResource(bytes,name,name.toLowerCase().endsWith('.pdf')?'application/pdf':'application/octet-stream'),selectionId=randomUUID();const descriptor:CommunityPreparedResource={selectionId,name,title:inspected.title,body:body??(inspected.format==='markdown'?inspected.items[0]?.body||'':inspected.format==='notes'&&inspected.units===1?inspected.items[0]?.body||'':`资源：${inspected.title}`),bytes:bytes.length,units:inspected.units,kind:inspected.format as CommunityPreparedResource['kind'],items:inspected.items.map(({id,title,parentId})=>({id,title,parentId}))};for(const [id,item] of this.prepared)if(item.expires<=Date.now())this.prepared.delete(id);while(this.prepared.size&&(this.prepared.size>=8||[...this.prepared.values()].reduce((total,item)=>total+item.bytes.length,bytes.length)>2*MAX_RESOURCE_FILE_BYTES))this.prepared.delete(this.prepared.keys().next().value!);this.prepared.set(selectionId,{descriptor,bytes,environment:{...this.options.environment()},expires:Date.now()+15*60_000});return descriptor;}
  async prepare(input:{noteIds:string[];kind:'notes'|'plan';includeDescendants:boolean}){check(input?.kind==='notes'&&input.noteIds?.length===1&&input.includeDescendants===false,'本轮只分享单篇只读快照，不包含下级、关联笔记或计划。');const environment={...this.options.environment()},all=await this.options.loadNotes(),note=all.find(note=>note.id===input.noteIds[0]);check(note&&this.current(environment),'所选笔记已不存在或知识库已切换。');const teaching=await this.options.progressiveTeaching?.(note.id);check(this.current(environment),"知识库已切换，未创建分享快照。");check(teaching||note.textbook||!preparationRoot(note,all),'项目尚无已生成教材，请从叶子项目生成后分享。');const snapshot=exportCommunitySnapshot(note,teaching),descriptor=this.remember(new TextEncoder().encode(snapshot.body),note.title.replace(/[<>:"/\\|?*\x00-\x1f]/g,'_')+'.md');this.prepared.get(descriptor.selectionId)!.assets=snapshot.assets;this.prepared.get(descriptor.selectionId)!.snapshot=true;descriptor.images=Object.fromEntries(snapshot.assets.map(asset=>['attachment:'+asset.key,'data:'+asset.mime+';base64,'+Buffer.from(asset.bytes).toString('base64')]));return descriptor;}
  async prepareLegacy(input:{noteIds:string[];kind:'notes'|'plan';includeDescendants:boolean}){check(input&&Array.isArray(input.noteIds)&&input.noteIds.every(isId)&&['notes','plan'].includes(input.kind),'选择内容不正确。');const environment={...this.options.environment()},all=await this.options.loadNotes();check(this.current(environment),'知识库已切换。');const selected=new Set(input.noteIds);if(input.includeDescendants){let more=true;while(more){more=false;for(const note of all)if(note.parentId&&selected.has(note.parentId)&&!selected.has(note.id)){selected.add(note.id);more=true;}}}const teaching=new Map<string,import('../services/progressiveLearning/types').SharedProgressiveTeaching>();for(const id of selected){const value=await this.options.progressiveTeaching?.(id);if(value)teaching.set(id,value);}check(this.current(environment),'知识库已切换，未创建分享包。');const result=exportCommunityNotes(all,input.noteIds,{kind:input.kind,includeDescendants:input.includeDescendants,progressiveTeaching:teaching});return this.remember(result.bytes,result.name);}
  checkedLink(value:unknown){check(typeof value==='string','链接格式不正确。');let url=publicResourceUrl(value);if(!url){try{const source=new URL(value),origin=new URL(this.options.origin);if(source.origin===origin.origin&&source.hash.startsWith('#/resource/')&&!source.username&&!source.password)url=source.href;}catch{}}check(url,'只打开公开 HTTP(S) 链接，不支持本地地址、带账号密码的地址或程序协议。');return url;}
  async prepareLink(value:string){check(typeof value==='string'&&value.length<=4096,'链接格式不正确。');const url=publicResourceUrl(value.trim());check(url,'请粘贴公开的 HTTP(S) 网页或视频链接。');const descriptor=this.remember(new TextEncoder().encode(url),'链接.md');const kind=basicResourceDelivery({body:url,preview:{format:'markdown'},files:[]}).kind;check(kind==='link'||kind==='video-link','链接无效。');descriptor.kind=kind;descriptor.title=new URL(url).hostname;descriptor.body=url;return descriptor;}
  async prepareFile(file:string){const environment={...this.options.environment()};check(!/\.(lnresource|lnsnapshot|mp4|webm|mov|mkv|avi)$/i.test(file),'本轮不分享组合资源包；视频请在网页粘贴链接。');check(path.isAbsolute(file),'文件选择无效。');const stat=await fs.lstat(file);check(stat.isFile()&&!stat.isSymbolicLink()&&stat.size>0&&stat.size<=MAX_RESOURCE_FILE_BYTES,'请选择 100 MB 以内的普通文件。');const bytes=await fs.readFile(file);check(this.current(environment),'知识库已切换，请重新选择分享文件。');return this.remember(bytes,path.basename(file));}
  async publish(input:{selectionId:string;title:string;body:string;scope:'public'|'self'}){
    await this.localBinding();check(this.secret&&this.binding?.accountId,'请先连接社区账号。');check(input&&typeof input.title==='string'&&input.title.trim().length>0&&input.title.length<=160&&typeof input.body==='string'&&input.body.length<=50000&&['public','self'].includes(input.scope),'分享标题、正文或范围不正确。');
    const prepared=this.prepared.get(input.selectionId);check(prepared&&prepared.expires>Date.now()&&this.current(prepared.environment),'所选资源已过期或知识库已切换，请重新预览。');
    const token=this.secret.token,accountId=this.binding.accountId,targetKey=this.binding.targetKey;
    const assertCurrent=()=>check(this.sessionCurrent(prepared.environment,token,accountId,targetKey),'社区账号或知识库已变化，未发布旧的分享内容。');
    const request=async<T>(route:string,options:RequestOptions={})=>{assertCurrent();const value=await this.request<T>(route,{...options,token});assertCurrent();return value;};
    // Files already supply the content; an optional introduction must not block publication.
    if(!input.body.trim()&&['pdf','file'].includes(prepared.descriptor.kind))input={...input,body:prepared.descriptor.body};
    check(input.body.trim().length>0,'分享正文不能为空。');
    const identity=await request<{accountId:string;targetKey:string}>('/desktop/session');check(identity.accountId===accountId&&identity.targetKey===targetKey,'桌面账号或知识库授权已变化。');
    check(!['notes','plan'].includes(prepared.descriptor.kind),'组合资源分享暂不开放。');check(!prepared.snapshot||input.body.trim()===prepared.descriptor.body.trim(),'快照正文已固定，请回到原笔记修改并重新预览。');
    // A single-note editor edits the published source, not a second, divergent description.
    let bytes=prepared.bytes;if(prepared.descriptor.kind==='markdown')bytes=new TextEncoder().encode(input.body.trim());
    if(prepared.descriptor.kind==='notes'){const resource=readResourcePackage(bytes);if(resource.manifest.notes.length===1){const note=resource.manifest.notes[0];note.title=input.title.trim();resource.manifest.title=note.title;resource.files[note.file]=new TextEncoder().encode(input.body.trim());bytes=createResourcePackage(resource.manifest,resource.files);}}
    // Changed edits have a new identity; retries of the same content reuse the original write keys.
    const fingerprint=hash(JSON.stringify([input.title.trim(),input.body.trim(),input.scope])).slice(0,16),key=`share-${input.selectionId}-${fingerprint}`;
    prepared.attempts??=new Map();let attempt=prepared.attempts.get(fingerprint);if(!attempt){attempt={};prepared.attempts.set(fingerprint,attempt);}if(attempt.entryId)return {id:attempt.entryId};
    if(prepared.descriptor.kind==='link'||prepared.descriptor.kind==='video-link'){check(input.body.trim()===prepared.descriptor.body,'链接已固定，请重新粘贴。');const result=await request<{id:string}>('/desktop/entries',{method:'POST',body:{title:input.title.trim(),body:prepared.descriptor.body,scope:input.scope,resourceType:'link',topics:[]},key:key+'-publish'});attempt.entryId=result.id;return result;}
    if(!attempt.stageId)attempt.stageId=(await request<{stageId:string}>('/desktop/resource-stages',{method:'POST',body:{},key:key+'-stage'})).stageId;
    let publishedBody=input.body.trim();for(const asset of prepared.assets||[]){attempt.assets??={};let uploaded=attempt.assets[asset.key];if(!uploaded){const grant=await request<{attachmentId:string;uploadToken:string}>(`/desktop/resource-stages/${attempt.stageId}/files`,{method:'POST',body:{name:asset.name,mime:asset.mime,bytes:asset.bytes.length,role:'image'},key:key+'-'+asset.key});uploaded={id:grant.attachmentId,token:grant.uploadToken};attempt.assets[asset.key]=uploaded;}if(!uploaded.uploaded){await request(`/desktop/attachments/${uploaded.id}/content`,{method:'PUT',binary:asset.bytes,headers:{'X-Upload-Token':uploaded.token}});uploaded.uploaded=true;}publishedBody=publishedBody.replaceAll('attachment:'+asset.key,'attachment:'+uploaded.id);}if(prepared.descriptor.kind==='markdown')bytes=new TextEncoder().encode(publishedBody);
    if(!attempt.intent)attempt.intent=await request<{attachmentId:string;uploadToken:string}>(`/desktop/resource-stages/${attempt.stageId}/files`,{method:'POST',body:{name:prepared.descriptor.name,mime:prepared.descriptor.kind==='pdf'?'application/pdf':prepared.descriptor.kind==='markdown'?'text/markdown':'application/octet-stream',bytes:bytes.length,role:'main'},key:key+'-file'});
    if(!attempt.uploaded){await request(`/desktop/attachments/${attempt.intent.attachmentId}/content`,{method:'PUT',binary:bytes,headers:{'X-Upload-Token':attempt.intent.uploadToken}});attempt.uploaded=true;}assertCurrent();
    const result=await request<{id:string}>('/desktop/entries',{method:'POST',body:{title:input.title.trim(),body:publishedBody,scope:input.scope,stageId:attempt.stageId,resourceType:prepared.descriptor.kind==='plan'?'route':'note',topics:[]},key:key+'-publish'});attempt.entryId=result.id;return result;
  }
  start(){if(this.timer||!this.api)return;this.stopped=false;this.timer=setInterval(()=>void this.tick().catch(()=>{}),25_000);this.timer.unref();void this.tick().catch(()=>{});}
  stop(){this.stopped=true;this.bindingLoad=null;this.pairingGeneration++;this.pairing=null;if(this.timer)clearInterval(this.timer);this.timer=null;this.prepared.clear();}
  async receiveNow(){await this.tick();return this.state();}
  learningStatisticsChanged(){this.statisticsDirty++;}
  /** Only a boolean delivery policy crosses the bridge. No learning record,
   * document, screen state or public presence is sent. Disconnected leases expire. */
  async setFocus(enabled:boolean):Promise<void>{check(typeof enabled==='boolean','专注状态必须是布尔值。');this.focusWanted=enabled;await this.syncFocus();}
  private syncFocus():Promise<void>{
    if(this.focusSync){this.focusAgain=true;return this.focusSync;}
    const work=async()=>{do{this.focusAgain=false;try{await this.syncFocusOnce();}catch{/* Offline focus synchronization is retried by the existing device tick. */}}while(this.focusAgain&&!this.stopped);};
    this.focusSync=work().finally(()=>{this.focusSync=null;});return this.focusSync;
  }
  private async syncFocusOnce(){
    if(this.stopped||!this.api)return;await this.localBinding();
    const environment={...this.options.environment()},token=this.secret?.token;if(!token||!this.binding?.accountId)return;
    const enabled=this.focusWanted,lease=this.focusLease,matches=!!lease&&lease.token===token&&same(lease.environment,environment);
    // An uncertain true request still needs a false cleanup after leaving focus.
    // Initial idle operation performs no focus request, even after a cold restart.
    if(!enabled&&(!matches||!lease.enabled))return;
    if(enabled&&matches&&lease.enabled&&Date.now()-lease.checked<20_000)return;
    // A lost false response may already have cleared the lease. Invalidate the
    // acknowledgement before either write, so rapid re-entry sends a fresh true.
    this.focusLease={environment,token,enabled:true,checked:0};
    await this.request('/desktop/focus',{method:'PUT',body:{enabled},token});
    if(this.current(environment)&&this.secret?.token===token)this.focusLease={environment,token,enabled,checked:Date.now()};
  }
  private async syncLearningStatistics(policy:LearningStatisticsPolicy|null|undefined,environment:Environment,token:string){
    if(!policy?.enabled||!this.options.readLearningStatistics){this.statisticsLast=null;return;}
    if(policy.sourceDeviceId!==this.binding?.deviceId||!Number.isSafeInteger(policy.revision)||!policy.metrics.length||!policy.metrics.every(metric=>LEARNING_METRICS.includes(metric)))return;
    const now=Date.now(),day=statisticsDate(new Date(),Intl.DateTimeFormat().resolvedOptions().timeZone),key=JSON.stringify([this.binding?.accountId,policy.revision,day]);
    if(now<this.statisticsRetryAt)return;
    // Reuse the device session tick, coalescing local writes and reads. No new heartbeat.
    if(this.statisticsLast?.key===key&&now-this.statisticsLast.checked<60_000)return;
    if(this.statisticsLast?.key===key&&this.statisticsLast.dirty===this.statisticsDirty&&now-this.statisticsLast.checked<15*60_000)return;
    const dirty=this.statisticsDirty;
    try{
      const source=await this.options.readLearningStatistics(environment);
      if(!this.current(environment)||this.secret?.token!==token)return;
      const snapshot:LearningStatisticsSnapshot={state:source.state,asOfDate:source.asOfDate,timeZone:source.timeZone,computedAt:source.computedAt,calculationVersion:'loginote-learning-v1',values:source.state==='ready'?Object.fromEntries(policy.metrics.map(metric=>[metric,source.values[metric]])):{}};
      const fingerprint=hash(JSON.stringify({...snapshot,computedAt:undefined}));
      if(this.statisticsLast?.key!==key||this.statisticsLast.fingerprint!==fingerprint)await this.request('/desktop/learning-statistics',{method:'PUT',body:{revision:policy.revision,snapshot},token});
      if(this.current(environment))this.statisticsLast={key,fingerprint,checked:now,dirty};
      this.statisticsRetryAt=0;
    }catch{this.statisticsRetryAt=now+60_000;/* An unavailable statistic must not block resource receipt. */}
  }
  private async tick(){if(this.stopped||!this.api)return;void this.syncFocus();if(this.active||this.stopped)return;this.active=true;try{await this.localBinding();await this.retryReceivingCleanup({...this.options.environment()});if(this.pairing)await this.pollPairing();if(!this.secret||!this.binding?.accountId)return;const environment={...this.options.environment()},token=this.secret.token,accountId=this.binding.accountId,targetKey=this.binding.targetKey,secret=this.secret;
      const current=()=>this.sessionCurrent(environment,token,accountId,targetKey),assertCurrent=()=>check(current(),'社区账号或知识库已变化，未接收旧账号内容。');
      const combined=secret.pendingIndexes.length===0,identity=await this.request<{accountId:string;targetKey:string;isDefault:boolean;learningStatistics?:LearningStatisticsPolicy|null;task?:Task|null}>(combined?'/desktop/poll':'/desktop/session',combined?{method:'POST',body:{protocol:2},token}:{token});assertCurrent();check(identity.accountId===accountId&&identity.targetKey===targetKey,'社区接收目标不匹配，未写入知识库。');await this.syncLearningStatistics(identity.learningStatistics,environment,token);assertCurrent();
      for(const pending of [...secret.pendingIndexes]){
        const documents=await Promise.all((pending.documents||[{id:pending.documentId!,state:'indexing' as const}]).map(async document=>({id:document.id,state:await this.options.documentStatus(document.id)})));assertCurrent();if(documents.some(document=>document.state==='indexing'))continue;
        const original=pending.result||{state:'indexing' as const,localIds:documents.map(document=>document.id),kind:'document' as const},state=original.kind==='document'&&original.state==='indexing'?(documents.some(document=>document.state==='stored')?'stored':'indexed'):original.state;
        try{await this.request(`/desktop/receipts/${pending.receiptId}`,{method:'PUT',body:{...original,documents,leaseToken:pending.leaseToken,state,...(documents.some(document=>document.state==='stored'&&original.documents?.find(item=>item.id===document.id)?.state==='indexing')?{errorCode:'index_failed'}:{})},token});}
        catch(error){
          assertCurrent();
          // A withdrawn object, replaced lease or expired first acknowledgement
          // must not pin the whole device queue. The server can re-lease any
          // eligible receiving task; stable local IDs prevent duplicate copies.
          if(!(error instanceof CommunityHttpError)||![403,404,409].includes(error.status))throw error;
        }
        assertCurrent();secret.pendingIndexes=secret.pendingIndexes.filter(item=>item.receiptId!==pending.receiptId);await this.saveBinding();
      }
      // The combined poll may have claimed under a newer default-device state
      // than its session metadata. An authorized task takes precedence; only a
      // separate claim request needs the session's default-device gate.
      if(!combined&&!identity.isDefault)return;
      const task=combined?identity.task||null:await this.request<Task|null>('/desktop/claim',{method:'POST',body:{protocol:2},token});if(!task)return;assertCurrent();check(task.accountId===accountId&&task.targetKey===targetKey,'社区接收目标不匹配，未写入知识库。');
      const downloaded=new Map<string,Uint8Array>();const staging=await privateDirectory(environment.userStateDir,'community-receive');let result:ImportResult,committed=false;
      try{for(const file of task.version.files){assertCurrent();check(isId(file.id)&&Number.isSafeInteger(file.bytes)&&file.bytes>0&&file.bytes<=MAX_RESOURCE_FILE_BYTES&&/^[a-f\d]{64}$/.test(file.hash),'资源文件清单不正确。');const bytes=await this.request<Uint8Array>(`/desktop/receipts/${task.id}/files/${file.id}`,{download:true,expectedDownloadBytes:file.bytes,headers:{'X-Receipt-Lease':task.leaseToken,'X-Community-Protocol':'2'},token});assertCurrent();check(bytes.length===file.bytes&&hash(bytes)===file.hash,'文件校验失败或接收知识库已变化。');downloaded.set(file.id,bytes);}
        // Recheck permission after transfer, immediately before any local write.
        const stillCurrent=await this.request<{accountId:string;targetKey:string}>('/desktop/session',{token});assertCurrent();check(stillCurrent.accountId===task.accountId&&stillCurrent.targetKey===task.targetKey,'账号或知识库已变化。');
        await this.request(`/desktop/receipts/${task.id}/validate`,{method:'POST',body:{leaseToken:task.leaseToken,protocol:2},token});
        assertCurrent();result=await this.importBasicTask(task,downloaded,staging,environment,current);committed=true;assertCurrent();
        secret.pendingIndexes=secret.pendingIndexes.filter(item=>item.receiptId!==task.id);secret.pendingIndexes.push({receiptId:task.id,leaseToken:task.leaseToken,documents:result.documents||[],result});await this.saveBinding();
        await this.request(`/desktop/receipts/${task.id}`,{method:'PUT',body:{leaseToken:task.leaseToken,...result},token});assertCurrent();
        if(!result.documents?.some(document=>document.state==='indexing')){secret.pendingIndexes=secret.pendingIndexes.filter(item=>item.receiptId!==task.id);await this.saveBinding();}
        this.lastStatus=result.kind==='link'?'链接已保存为本地引用，未下载原站内容。':result.state==='imported'?'资源已保存。':result.state==='indexing'?'资料已入库，正在建立索引。':'资源文件已保存。';
      }catch(error){if(!committed&&current()){await this.request(`/desktop/receipts/${task.id}`,{method:'PUT',body:{leaseToken:task.leaseToken,state:'failed',localIds:[],errorCode:'import_failed'},token}).catch(()=>{});}throw error;}
    }catch(error){this.lastStatus=error instanceof Error?error.message:'社区接收暂未完成。';}finally{this.active=false;}}
  private referenceOperation<T>(work:()=>Promise<T>):Promise<T>{const pending=this.referenceWrites.then(work,work);this.referenceWrites=pending.then(()=>{},()=>{});return pending;}
  private async savedRecords(environment:Environment=this.options.environment()):Promise<(CommunitySavedResource&{accountId:string})[]>{const file=path.join(environment.userStateDir,'community-references.json');try{const stat=await fs.lstat(file);check(stat.isFile()&&!stat.isSymbolicLink()&&stat.size<=4*1024*1024,'本地社区引用清单无效。');const value=JSON.parse(await fs.readFile(file,'utf8'));check(value.version===1&&Array.isArray(value.items),'本地社区引用清单无效。');return value.items;}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return [];throw error;}}
  private async writeReferences(items:(CommunitySavedResource&{accountId:string})[],environment:Environment,isCurrent:()=>boolean=()=>this.current(environment)){check(isCurrent(),'社区账号或知识库已切换。');await atomicWriteTextFile(path.join(environment.userStateDir,'community-references.json'),JSON.stringify({version:1,items}),{allowCopyFallback:false});}
  async references():Promise<CommunitySavedResource[]>{
    await this.localBinding();const environment={...this.options.environment()},accountId=this.binding?.accountId;
    return this.referenceOperation(async()=>{check(this.current(environment),'知识库已切换。');let rows=await this.savedRecords(environment);
      if(this.options.snapshotDocumentIds&&rows.some(row=>row.kind==='snapshot')){const existing=new Set(await this.options.snapshotDocumentIds(()=>this.current(environment))),kept=rows.filter(row=>row.kind!=='snapshot'||!!row.documentId&&existing.has(row.documentId));if(kept.length!==rows.length){await this.writeReferences(kept,environment);rows=kept;}}
      check(this.current(environment)&&accountId===this.binding?.accountId,'社区账号或知识库已切换。');return rows.filter(row=>row.accountId===accountId).map(({accountId:_accountId,...row})=>row);
    });
  }
  async snapshot(id:string):Promise<{title:string;body:string;sourceUrl:string;version:number}>{await this.localBinding();check(isId(id),'快照标识无效。');const environment={...this.options.environment()},saved=(await this.references()).find(row=>row.id===id&&row.kind==='snapshot');check(saved?.documentId&&this.options.readSnapshot,'未找到当前账号的只读快照。');const body=await this.options.readSnapshot(saved.documentId,()=>this.current(environment));check(this.current(environment),'知识库已切换。');return {title:saved.title,body,sourceUrl:saved.sourceUrl,version:saved.version};}
  private async saveReference(task:Task,environment:Environment,kind:'snapshot'|'link'|'video-link',documentId?:string,url?:string,isCurrent:()=>boolean=()=>this.current(environment)){return this.referenceOperation(async()=>{check(isCurrent(),'社区账号或知识库已切换。');const items=await this.savedRecords(environment),id='community-'+hash(`${task.accountId}:${task.targetKey}:${task.version.id}:reference`).slice(0,32);check(isCurrent(),'社区账号或知识库已切换。');if(!items.some(row=>row.id===id)){items.unshift({id,accountId:task.accountId,kind,title:task.version.title,version:task.version.version,entryId:task.entryId,sourceUrl:`${this.options.origin}/#/resource/${task.entryId}`,createdAt:new Date().toISOString(),...(documentId?{documentId}:{}),...(url?{url}:{})});await this.writeReferences(items,environment,isCurrent);}return id;});}
  private async importBasicTask(task:Task,downloaded:Map<string,Uint8Array>,staging:string,environment:Environment,isCurrent:()=>boolean=()=>this.current(environment)):Promise<ImportResult>{
    check(isCurrent(),'社区账号或知识库已切换。');const delivery=task.version.delivery||basicResourceDelivery(task.version);check(delivery.kind!=='unsupported','此组合资源不在本轮范围，未自动恢复笔记或计划。');
    const documents:DocumentReceipt[]=[];for(const file of task.version.files.filter(file=>file.role==='attachment'))documents.push(await this.importFile(task,file,downloaded.get(file.id)!,staging,environment,'file',isCurrent));
    if(delivery.kind==='link'||delivery.kind==='video-link'){const url=delivery.url&&publicResourceUrl(delivery.url);check(url,'资源链接无效。');const id=await this.saveReference(task,environment,delivery.kind,undefined,url,isCurrent);return {state:'imported',kind:'link',localIds:[id,...documents.map(document=>document.id)],documents};}
    if(delivery.kind==='snapshot'){
      let body=task.version.body;for(const file of task.version.files.filter(file=>file.role==='image'&&body.includes('attachment:'+file.id))){const data=downloaded.get(file.id);check(data&&/^image\/(png|jpeg|webp)$/.test(file.mime),'快照图片缺失。');body=body.replaceAll('attachment:'+file.id,'data:'+file.mime+';base64,'+Buffer.from(data).toString('base64'));}check(!/attachment:/.test(body),'快照图片引用不完整。');const bytes=new TextEncoder().encode(body);check(bytes.length<=20*1024*1024,'快照内容过大，未写入本地。');const file:FileDescriptor={id:task.version.id,name:task.version.title.replace(/[<>:"/\\|?*\x00-\x1f]/g,'_')+'.md',mime:'text/markdown',bytes:bytes.length,hash:hash(bytes),role:'main'};
      const imported=await this.importFile(task,file,bytes,staging,environment,'snapshot',isCurrent);documents.unshift(imported);const id=await this.saveReference(task,environment,'snapshot',imported.id,undefined,isCurrent);return {state:'stored',kind:'document',localIds:[imported.id,id,...documents.slice(1).map(document=>document.id)],documents};
    }
    const main=task.version.files.find(file=>file.role==='main');check(main&&downloaded.has(main.id),'资料缺少主文件。');documents.unshift(await this.importFile(task,main,downloaded.get(main.id)!,staging,environment,'file',isCurrent));return {state:documents.some(document=>document.state==='indexing')?'indexing':documents.every(document=>document.state==='indexed')?'indexed':'stored',kind:'document',localIds:documents.map(document=>document.id),documents};
  }
  private async importFile(task:Task,file:FileDescriptor,bytes:Uint8Array,staging:string,environment:Environment,kind:'snapshot'|'file'='file',isCurrent:()=>boolean=()=>this.current(environment)):Promise<DocumentReceipt>{
    check(isCurrent(),'社区账号或知识库已切换。');
    const id='community-'+hash(`${task.accountId}:${task.targetKey}:${task.version.id}:${file.id}`).slice(0,32),localFile=path.join(staging,id+'.'+(file.name.split('.').at(-1)||'bin').replace(/[^a-zA-Z0-9]/g,''));
    await fs.writeFile(localFile,bytes,{flag:'wx'}).catch(async error=>{const stat=await fs.lstat(localFile);if((error as NodeJS.ErrnoException).code!=='EEXIST'||!stat.isFile()||stat.isSymbolicLink()||hash(await fs.readFile(localFile))!==file.hash)throw error;});
    try{
      check(isCurrent(),'社区账号或知识库已切换。');const document=await this.options.importDocument({id,name:file.name,sourcePath:localFile,bytes:file.bytes,hash:file.hash,sourceUrl:`${this.options.origin}/#/resource/${task.entryId}`,communitySource:{accountId:task.accountId,entryId:task.entryId,versionId:task.version.id,role:file.role,kind}},isCurrent);return {id:document.id,state:document.status};
    }finally{
      // The adapter copies into its authoritative document store before it
      // resolves. A failed transfer can redownload on retry, so neither success
      // nor failure needs a second plaintext copy in this staging directory.
      check(path.dirname(path.resolve(localFile))===path.resolve(staging),'社区临时文件越界。');
      await this.removeReceivingFile(localFile,environment);
    }
  }
  private async importTask(task:Task,downloaded:Map<string,Uint8Array>,staging:string,environment:Environment):Promise<ImportResult>{
    const documents:DocumentReceipt[]=[];for(const file of task.version.files.filter(file=>file.role==='attachment')){check(this.current(environment),'知识库已切换。');documents.push(await this.importFile(task,file,downloaded.get(file.id)!,staging,environment));}
    const finish=(result:ImportResult):ImportResult=>({...result,localIds:[...result.localIds,...documents.map(document=>document.id)],...(documents.length?{documents}:{})});
    let main=task.version.files.find(file=>file.role==='main');if(!main&&task.version.preview.format==='markdown'){const bytes=new TextEncoder().encode(task.version.body);main={id:task.version.id,name:'资源正文.md',mime:'text/markdown',bytes:bytes.length,hash:hash(bytes),role:'main'};downloaded.set(main.id,bytes);}check(main&&downloaded.has(main.id),'资源缺少主文件。');const bytes=downloaded.get(main.id)!,source={accountId:task.accountId,entryId:task.entryId,versionId:task.version.id,sourceUrl:`${this.options.origin}/#/resource/${task.entryId}`};const idFor=(id:string)=>'community-'+hash(`${task.accountId}:${task.targetKey}:${task.version.id}:${id}`).slice(0,32);
    const attachments:ResourceItem[]=documents.map(document=>{const file=task.version.files.find(file=>'community-'+hash(`${task.accountId}:${task.targetKey}:${task.version.id}:${file.id}`).slice(0,32)===document.id)!;return {title:file.name,url:`loginote-document://${document.id}`,kind:'local',documentId:document.id,sourceUrl:source.sourceUrl,fileType:detectLocalFileType(file.name)};});
    const prepareNotes=(notes:NoteItem[],resource:{manifest:ResourceManifest;files:Record<string,Uint8Array>})=>{const result=prepareCommunityNotes(notes,resource.manifest,resource.files,source,idFor);if(!result.replayed&&attachments.length)result.notes=result.notes.map(note=>note.id===idFor('@container')?{...note,resources:attachments}:note);return result;};
    if(main.name.toLowerCase().endsWith('.lnresource')){const resource=readResourcePackage(bytes);if(resource.manifest.kind==='plan'){
        const directory=await privateDirectory(environment.userStateDir,'community-templates'),id=idFor('template'),file=path.join(directory,id+'.lnresource');await fs.writeFile(file,bytes,{flag:'wx'}).catch(async error=>{if((error as NodeJS.ErrnoException).code!=='EEXIST'||hash(await fs.readFile(file))!==hash(bytes))throw error;});
        let companionIds:string[]=[];if(resource.manifest.notes.length)await this.options.changeNotes(notes=>{const result=prepareNotes(notes,resource);companionIds=result.localIds;return result.notes;},()=>this.current(environment));
        const index=await this.readTemplates();if(!index.some(item=>item.id===id)){check(this.current(environment),'知识库已切换。');index.push({id,title:resource.manifest.title,state:'inactive',units:resource.manifest.plan.length,entryId:task.entryId,version:task.version.version,createdAt:new Date().toISOString(),manifest:resource.manifest,source,resources:attachments});await this.writeTemplates(index,environment);}return finish({state:'imported',localIds:[id,...companionIds],kind:'template'});
      }
      let ids:string[]=[];await this.options.changeNotes(notes=>{const result=prepareNotes(notes,resource);ids=result.localIds;return result.notes;},()=>this.current(environment));return finish({state:'imported',localIds:ids,kind:'notes'});
    }
    const inspected=inspectResource(bytes,main.name,main.mime);
    if(inspected.format==='markdown'){
      const manifest:ResourceManifest={format:'loginote-resource',version:1,kind:'notes',title:task.version.title,contentVersion:String(task.version.version),license:'仅供个人学习',notes:[{id:'document',title:task.version.title,noteType:'knowledge',file:'notes/document.md',links:[],externalLinks:[],tags:[]}],assets:[],plan:[]};
      const files:Record<string,Uint8Array>={};let body=new TextDecoder().decode(bytes);for(const image of task.version.files.filter(file=>file.role==='image')){const extension=image.mime==='image/png'?'png':image.mime==='image/jpeg'?'jpg':'webp',file='assets/image_'+image.id+'.'+extension;const data=downloaded.get(image.id);check(data,'正文图片缺失。');manifest.assets.push({file,mime:image.mime as ResourceManifest['assets'][number]['mime'],bytes:data.length});files[file]=data;body=body.replaceAll('attachment:'+image.id,file);}files['notes/document.md']=new TextEncoder().encode(body);let ids:string[]=[];await this.options.changeNotes(notes=>{const result=prepareNotes(notes,{manifest,files});ids=result.localIds;return result.notes;},()=>this.current(environment));return finish({state:'imported',localIds:ids,kind:'notes'});
    }
    const imported=await this.importFile(task,main,bytes,staging,environment);documents.unshift(imported);return {state:documents.some(document=>document.state==='indexing')?'indexing':documents.every(document=>document.state==='indexed')?'indexed':'stored',localIds:documents.map(document=>document.id),kind:'document',documents};
  }
  private async readTemplates():Promise<TemplateRow[]>{const environment=this.options.environment();try{const file=path.join(environment.userStateDir,'community-templates.json'),stat=await fs.lstat(file);check(stat.isFile()&&!stat.isSymbolicLink(),'模板目录不能使用符号链接。');const value=JSON.parse(await fs.readFile(file,'utf8'));check(value.version===1&&Array.isArray(value.items),'社区模板目录无效。');return value.items;}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return [];throw error;}}
  private async writeTemplates(items:TemplateRow[],environment:Environment){check(this.current(environment),'知识库已切换。');await fs.mkdir(environment.userStateDir,{recursive:true});await atomicWriteTextFile(path.join(environment.userStateDir,'community-templates.json'),JSON.stringify({version:1,items}),{allowCopyFallback:false});}
  async templates():Promise<CommunityLocalTemplate[]>{await this.localBinding();return (await this.readTemplates()).filter(row=>row.source.accountId===this.binding?.accountId).map(({manifest:_manifest,source:_source,activation:_activation,resources:_resources,...row})=>row);}
  async activateTemplate(_input:{id:string;startDate:string;dailyMinutes:number;weekdays?:number[];allowOverlap?:boolean}):Promise<{localIds:string[]}>{throw Error('本轮不启用结构化计划；已保存的旧模板保留。');}
  async activateLegacyTemplate(input:{id:string;startDate:string;dailyMinutes:number;weekdays?:number[];allowOverlap?:boolean}){
    await this.localBinding();check(this.secret&&this.binding?.accountId&&isId(input.id),'请先连接社区账号。');const environment={...this.options.environment()},items=await this.readTemplates(),item=items.find(row=>row.id===input.id&&row.source.accountId===this.binding?.accountId);check(item,'没有找到当前账号的计划模板。');check(item.state==='inactive'||item.activation?.startDate===input.startDate&&item.activation?.dailyMinutes===input.dailyMinutes&&JSON.stringify([...(item.activation?.weekdays??[0,1,2,3,4,5,6])].sort())===JSON.stringify([...(input.weekdays??[0,1,2,3,4,5,6])].sort()),'计划已启用，请到计划板块调整。');
    const file=path.join(environment.userStateDir,'community-templates',item.id+'.lnresource'),stat=await fs.lstat(file);check(stat.isFile()&&!stat.isSymbolicLink(),'计划模板不能使用符号链接。');const resource=readResourcePackage(await fs.readFile(file));check(input.weekdays===undefined||Array.isArray(input.weekdays),'学习日不正确。');check(input.allowOverlap===undefined||typeof input.allowOverlap==='boolean','排期选择不正确。');const schedule=scheduleCommunityPlan(resource.manifest.plan,input.startDate,input.dailyMinutes,input.weekdays);const idFor=(id:string)=>'community-'+hash(`${item.id}:active:${id}`).slice(0,32);let localIds:string[]=[];
    await this.options.changeNotes(notes=>{const expected=[idFor('@active-root'),...resource.manifest.plan.map(node=>idFor(node.id))];const previous=notes.filter(note=>expected.includes(note.id));if(previous.length){check(previous.length===expected.length&&previous.every(note=>note.communityImport?.versionId===item.source.versionId),'部分计划内容被移除，请先在计划板块处理。');localIds=expected;return notes;}
      const overlap=notes.filter(note=>note.planMeta?.status==='active'&&note.planMeta.startDate&&note.planMeta.targetDate&&note.planMeta.startDate<=schedule.meta.targetDate&&note.planMeta.targetDate>=input.startDate);
      check(!overlap.length||input.allowOverlap===true,`与已有计划「${overlap.map(note=>note.title).slice(0,3).join('、')}」同期，新计划每日另需 ${input.dailyMinutes} 分钟。可调整日期，或确认同时安排；已有计划不会被挪动。`);
      const used=new Set(notes.map(note=>note.title.toLocaleLowerCase())),titleFor=(title:string)=>{let next=title,n=1;while(used.has(next.toLocaleLowerCase()))next=`${title}（社区计划 ${n++}）`;used.add(next.toLocaleLowerCase());return next;},rootId=idFor('@active-root'),now=new Date().toISOString();
      const root:NoteItem={id:rootId,title:titleFor(item.title),content:'',noteType:'project',tags:['社区计划'],links:[],backlinks:[],dueDates:[],createdAt:now,updatedAt:now,planMeta:schedule.meta,communityImport:{...item.source,sourceId:'active:@container'},resources:item.resources||notes.find(note=>note.communityImport?.accountId===item.source.accountId&&note.communityImport.versionId===item.source.versionId&&note.communityImport.sourceId==='@container')?.resources};
      const created=resource.manifest.plan.map(node=>{const range=schedule.allocations.get(node.id)!;const title=titleFor(node.title),id=idFor(node.id),leaf=!resource.manifest.plan.some(child=>child.parentId===node.id);const companion=notes.find(note=>note.communityImport?.accountId===item.source.accountId&&note.communityImport.versionId===item.source.versionId&&note.communityImport.sourceId===node.id);return {id,title,content:companion?`配套内容：[[${companion.title}]]`:'',noteType:'project' as const,parentId:node.parentId?idFor(node.parentId):rootId,tags:['社区计划'],links:companion?[companion.title]:[],backlinks:[],dueDates:leaf?[{id:id+'-task',noteId:id,noteTitle:title,taskText:title,startDate:range.startDate,dueDate:range.dueDate,completed:false,priority:'medium' as const,estimatedMinutes:node.minutes,source:'scheduler' as const,dependencyTaskIds:communityPlanLeafDependencies(resource.manifest.plan,node.id).map(key=>idFor(key)+'-task')}]:[],createdAt:now,updatedAt:now,communityImport:{...item.source,sourceId:'active:'+node.id}};});localIds=[rootId,...created.map(note=>note.id)];return [...notes,root,...created];},()=>this.current(environment));
    item.state='active';item.activation={startDate:input.startDate,dailyMinutes:input.dailyMinutes,weekdays:schedule.meta.activeWeekdays};await this.writeTemplates(items,environment);return {localIds};
  }
}
