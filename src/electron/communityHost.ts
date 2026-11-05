import fs from 'node:fs/promises';
import {LEARNING_METRICS,statisticsDate,type LearningStatisticsPolicy,type LearningStatisticsSnapshot} from '../../apps/community-api/src/learningStatisticsContract';
import {MAX_RESOURCE_FILE_BYTES,FILE_TRANSFER_TIMEOUT_MS} from '../../apps/community-api/src/uploadLimits';
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
export interface CommunityHostOptions{
  apiUrl:string;
  origin:string;
  environment:()=>Environment;
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
  private pairing:{id:string;code:string;claimToken:string;expiresAt:string;environment:Environment}|null=null;
  private prepared=new Map<string,Prepared>();
  private active=false;
  private stopped=false;
  private timer:ReturnType<typeof setInterval>|null=null;
  private lastStatus='';
  private statisticsDirty=0;
  private statisticsLast:{key:string;fingerprint:string;checked:number;dirty:number}|null=null;
  private statisticsRetryAt=0;
  private referenceWrites:Promise<void>=Promise.resolve();
  private focusWanted=false;
  private focusSync:Promise<void>|null=null;
  private focusAgain=false;
  private focusLease:{environment:Environment;token:string;enabled:boolean;checked:number}|null=null;
  constructor(private readonly options:CommunityHostOptions){this.api=validateApi(options.apiUrl);}
  private current(environment:Environment){return !this.stopped&&same(environment,this.options.environment());}
  private async localBinding(){
    const environment=this.options.environment();if(this.bindingEnvironment&&same(environment,this.bindingEnvironment))return;
    if(this.bindingEnvironment)this.focusWanted=false;
    this.focusLease=null;this.secret=null;this.binding=null;this.pairing=null;this.prepared.clear();this.statisticsLast=null;this.statisticsRetryAt=0;this.bindingEnvironment={...environment};
    let saved:Binding|undefined;try{const file=path.join(environment.userStateDir,'community-device.json');const stat=await fs.lstat(file);check(stat.isFile()&&!stat.isSymbolicLink(),'桌面连接记录无效。');saved=JSON.parse(await fs.readFile(file,'utf8'));}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
    const rootHash=hash(path.resolve(environment.vaultRoot));
    if(saved?.version===1&&saved.api===this.api&&saved.rootHash===rootHash&&isId(saved.targetKey)){this.binding=saved;if(saved.secret){try{this.secret=JSON.parse(this.options.decrypt(saved.secret));}catch{this.secret=null;}}}
    else this.binding={version:1,api:this.api,targetKey:randomUUID(),rootHash};
  }
  private async saveBinding(){const environment=this.bindingEnvironment;check(environment&&this.binding&&this.current(environment),'知识库已切换，请重新连接。');await privateDirectory(environment.userStateDir,'community');const encrypted=this.secret?this.options.encrypt(JSON.stringify(this.secret)):null;this.binding.secret=encrypted||undefined;await atomicWriteTextFile(path.join(environment.userStateDir,'community-device.json'),JSON.stringify(this.binding),{allowCopyFallback:false});}
  private async request<T>(route:string,options:{method?:string;body?:unknown;key?:string;token?:string;headers?:Record<string,string>;binary?:Uint8Array;download?:boolean}={}):Promise<T>{
    check(this.api,'社区服务地址尚未配置。');check(/^\/[a-zA-Z0-9/_-]+$/.test(route),'社区请求地址不正确。');
    const response=await fetch(this.api+route,{method:options.method||'GET',redirect:'error',signal:AbortSignal.timeout(options.binary||options.download?FILE_TRANSFER_TIMEOUT_MS:30_000),headers:{Origin:this.options.origin,...(options.body!==undefined?{'Content-Type':'application/json'}:{}),...(options.binary?{'Content-Type':'application/octet-stream'}:{}),...(options.token?{Authorization:`Bearer ${options.token}`}:{}) ,...(options.key?{'Idempotency-Key':options.key}:{}),...options.headers},body:options.binary?Buffer.from(options.binary):options.body===undefined?undefined:JSON.stringify(options.body)});
    if(options.download&&response.ok){const chunks:Uint8Array[]=[];let bytes=0;const reader=response.body!.getReader();try{for(;;){const chunk=await reader.read();if(chunk.done)break;bytes+=chunk.value.length;check(bytes<=MAX_RESOURCE_FILE_BYTES,'接收文件超过 100 MB。');chunks.push(chunk.value);}}finally{reader.releaseLock();}return Buffer.concat(chunks) as T;}
    const envelope=await response.json();if(!response.ok||!envelope.ok){if(response.status===401&&options.token&&this.secret?.token===options.token){this.secret=null;if(this.binding){delete this.binding.secret;delete this.binding.deviceId;delete this.binding.accountId;delete this.binding.displayName;}await this.saveBinding();}throw new CommunityHttpError(envelope.error?.message||'社区服务暂时不可用。',response.status);}return envelope.value as T;
  }
  async state():Promise<CommunityDesktopState>{await this.localBinding();if(this.pairing)await this.pollPairing();return {configured:!!this.api,connected:!!this.secret,displayName:this.binding?.displayName,accountId:this.binding?.accountId,libraryLabel:'当前知识库',persistent:!!this.binding?.secret,...(this.pairing?{pairing:{code:this.pairing.code,expiresAt:this.pairing.expiresAt}}:{}),lastStatus:this.lastStatus};}
  async connect(){await this.localBinding();const environment={...this.options.environment()},result=await this.request<{pairingId:string;code:string;claimToken:string;expiresAt:string}>('/desktop/pairings',{method:'POST',body:{label:'LogiNote 桌面 · 当前知识库',targetKey:this.binding!.targetKey}});check(this.current(environment),'知识库已切换。');this.pairing={id:result.pairingId,code:result.code,claimToken:result.claimToken,expiresAt:result.expiresAt,environment};return this.state();}
  private async pollPairing(){const pairing=this.pairing;if(!pairing)return;if(!this.current(pairing.environment)||Date.parse(pairing.expiresAt)<Date.now()){this.pairing=null;return;}const result=await this.request<{state:'pending'|'connected';token?:string;accountId?:string;deviceId?:string;displayName?:string;targetKey?:string}>(`/desktop/pairings/${pairing.id}`,{method:'POST',body:{claimToken:pairing.claimToken}});if(result.state==='connected'){
    check(this.current(pairing.environment)&&result.targetKey===this.binding!.targetKey&&isId(result.accountId)&&isId(result.deviceId)&&typeof result.token==='string','连接目标已变化。');
    if(this.secret&&this.binding?.accountId!==result.accountId){
      // Rebinding this library is a handover, not a second active account. Use
      // the old bearer to revoke only the grant actually owned by this host.
      try{await this.request('/desktop/disconnect',{method:'POST',body:{},token:this.secret.token});}
      catch(error){if(!(error instanceof CommunityHttpError&&error.status===401))throw error;}
      check(this.current(pairing.environment),'知识库已切换，未替换社区账号。');
      this.prepared.clear();this.statisticsLast=null;this.statisticsRetryAt=0;
    }
    this.focusLease=null;this.secret={token:result.token,pendingIndexes:[]};Object.assign(this.binding!,{accountId:result.accountId,deviceId:result.deviceId,displayName:result.displayName});this.pairing=null;await this.saveBinding();void this.syncFocus();this.lastStatus='已连接，等待你在网页保存到 LogiNote 的资料或引用。';}}
  async disconnect(){await this.localBinding();if(this.secret)await this.request('/desktop/disconnect',{method:'POST',body:{},token:this.secret.token});this.focusLease=null;this.secret=null;this.pairing=null;if(this.binding){delete this.binding.accountId;delete this.binding.displayName;delete this.binding.deviceId;delete this.binding.secret;}await this.saveBinding();}
  async catalog(){await this.localBinding();return (await this.options.loadNotes()).map(note=>({id:note.id,title:note.title,noteType:note.noteType,parentId:note.parentId,hasPlan:!!note.planMeta}));}
  private remember(bytes:Uint8Array,name:string,body?:string):CommunityPreparedResource{const inspected=inspectResource(bytes,name,name.toLowerCase().endsWith('.pdf')?'application/pdf':'application/octet-stream'),selectionId=randomUUID();const descriptor:CommunityPreparedResource={selectionId,name,title:inspected.title,body:body??(inspected.format==='markdown'?inspected.items[0]?.body||'':inspected.format==='notes'&&inspected.units===1?inspected.items[0]?.body||'':`资源：${inspected.title}`),bytes:bytes.length,units:inspected.units,kind:inspected.format as CommunityPreparedResource['kind'],items:inspected.items.map(({id,title,parentId})=>({id,title,parentId}))};for(const [id,item] of this.prepared)if(item.expires<=Date.now())this.prepared.delete(id);while(this.prepared.size&&(this.prepared.size>=8||[...this.prepared.values()].reduce((total,item)=>total+item.bytes.length,bytes.length)>2*MAX_RESOURCE_FILE_BYTES))this.prepared.delete(this.prepared.keys().next().value!);this.prepared.set(selectionId,{descriptor,bytes,environment:{...this.options.environment()},expires:Date.now()+15*60_000});return descriptor;}
  async prepare(input:{noteIds:string[];kind:'notes'|'plan';includeDescendants:boolean}){check(input?.kind==='notes'&&input.noteIds?.length===1&&input.includeDescendants===false,'本轮只分享单篇只读快照，不包含下级、关联笔记或计划。');const environment={...this.options.environment()},all=await this.options.loadNotes(),note=all.find(note=>note.id===input.noteIds[0]);check(note&&this.current(environment),'所选笔记已不存在或知识库已切换。');const teaching=await this.options.progressiveTeaching?.(note.id);check(this.current(environment),"知识库已切换，未创建分享快照。");check(teaching||note.textbook||!preparationRoot(note,all),'项目尚无已生成教材，请从叶子项目生成后分享。');const snapshot=exportCommunitySnapshot(note,teaching),descriptor=this.remember(new TextEncoder().encode(snapshot.body),note.title.replace(/[<>:"/\\|?*\x00-\x1f]/g,'_')+'.md');this.prepared.get(descriptor.selectionId)!.assets=snapshot.assets;this.prepared.get(descriptor.selectionId)!.snapshot=true;descriptor.images=Object.fromEntries(snapshot.assets.map(asset=>['attachment:'+asset.key,'data:'+asset.mime+';base64,'+Buffer.from(asset.bytes).toString('base64')]));return descriptor;}
  async prepareLegacy(input:{noteIds:string[];kind:'notes'|'plan';includeDescendants:boolean}){check(input&&Array.isArray(input.noteIds)&&input.noteIds.every(isId)&&['notes','plan'].includes(input.kind),'选择内容不正确。');const environment={...this.options.environment()},all=await this.options.loadNotes();check(this.current(environment),'知识库已切换。');const selected=new Set(input.noteIds);if(input.includeDescendants){let more=true;while(more){more=false;for(const note of all)if(note.parentId&&selected.has(note.parentId)&&!selected.has(note.id)){selected.add(note.id);more=true;}}}const teaching=new Map<string,import('../services/progressiveLearning/types').SharedProgressiveTeaching>();for(const id of selected){const value=await this.options.progressiveTeaching?.(id);if(value)teaching.set(id,value);}check(this.current(environment),'知识库已切换，未创建分享包。');const result=exportCommunityNotes(all,input.noteIds,{kind:input.kind,includeDescendants:input.includeDescendants,progressiveTeaching:teaching});return this.remember(result.bytes,result.name);}
  checkedLink(value:unknown){check(typeof value==='string','链接格式不正确。');let url=publicResourceUrl(value);if(!url){try{const source=new URL(value),origin=new URL(this.options.origin);if(source.origin===origin.origin&&source.hash.startsWith('#/resource/')&&!source.username&&!source.password)url=source.href;}catch{}}check(url,'只打开公开 HTTP(S) 链接，不支持本地地址、带账号密码的地址或程序协议。');return url;}
  async prepareLink(value:string){check(typeof value==='string'&&value.length<=4096,'链接格式不正确。');const url=publicResourceUrl(value.trim());check(url,'请粘贴公开的 HTTP(S) 网页或视频链接。');const descriptor=this.remember(new TextEncoder().encode(url),'链接.md');const kind=basicResourceDelivery({body:url,preview:{format:'markdown'},files:[]}).kind;check(kind==='link'||kind==='video-link','链接无效。');descriptor.kind=kind;descriptor.title=new URL(url).hostname;descriptor.body=url;return descriptor;}
  async prepareFile(file:string){check(!/\.(lnresource|lnsnapshot|mp4|webm|mov|mkv|avi)$/i.test(file),'本轮不分享组合资源包；视频请在网页粘贴链接。');check(path.isAbsolute(file),'文件选择无效。');const stat=await fs.lstat(file);check(stat.isFile()&&!stat.isSymbolicLink()&&stat.size>0&&stat.size<=MAX_RESOURCE_FILE_BYTES,'请选择 100 MB 以内的普通文件。');return this.remember(await fs.readFile(file),path.basename(file));}
  async publish(input:{selectionId:string;title:string;body:string;scope:'public'|'self'}){
    await this.localBinding();check(this.secret&&this.binding?.accountId,'请先连接社区账号。');check(input&&typeof input.title==='string'&&input.title.trim().length>0&&input.title.length<=160&&typeof input.body==='string'&&input.body.length<=50000&&['public','self'].includes(input.scope),'分享标题、正文或范围不正确。');
    const prepared=this.prepared.get(input.selectionId);check(prepared&&prepared.expires>Date.now()&&this.current(prepared.environment),'所选资源已过期或知识库已切换，请重新预览。');
    // Files already supply the content; an optional introduction must not block publication.
    if(!input.body.trim()&&['pdf','file'].includes(prepared.descriptor.kind))input={...input,body:prepared.descriptor.body};
    check(input.body.trim().length>0,'分享正文不能为空。');
    const identity=await this.request<{accountId:string;targetKey:string}>('/desktop/session',{token:this.secret.token});check(identity.accountId===this.binding.accountId&&identity.targetKey===this.binding.targetKey,'桌面账号或知识库授权已变化。');
    check(!['notes','plan'].includes(prepared.descriptor.kind),'组合资源分享暂不开放。');check(!prepared.snapshot||input.body.trim()===prepared.descriptor.body.trim(),'快照正文已固定，请回到原笔记修改并重新预览。');
    // A single-note editor edits the published source, not a second, divergent description.
    let bytes=prepared.bytes;if(prepared.descriptor.kind==='markdown')bytes=new TextEncoder().encode(input.body.trim());
    if(prepared.descriptor.kind==='notes'){const resource=readResourcePackage(bytes);if(resource.manifest.notes.length===1){const note=resource.manifest.notes[0];note.title=input.title.trim();resource.manifest.title=note.title;resource.files[note.file]=new TextEncoder().encode(input.body.trim());bytes=createResourcePackage(resource.manifest,resource.files);}}
    // Changed edits have a new identity; retries of the same content reuse the original write keys.
    const token=this.secret.token,fingerprint=hash(JSON.stringify([input.title.trim(),input.body.trim(),input.scope])).slice(0,16),key=`share-${input.selectionId}-${fingerprint}`;
    prepared.attempts??=new Map();let attempt=prepared.attempts.get(fingerprint);if(!attempt){attempt={};prepared.attempts.set(fingerprint,attempt);}if(attempt.entryId)return {id:attempt.entryId};
    if(prepared.descriptor.kind==='link'||prepared.descriptor.kind==='video-link'){check(input.body.trim()===prepared.descriptor.body,'链接已固定，请重新粘贴。');const result=await this.request<{id:string}>('/desktop/entries',{method:'POST',body:{title:input.title.trim(),body:prepared.descriptor.body,scope:input.scope,resourceType:'link',topics:[]},token,key:key+'-publish'});attempt.entryId=result.id;return result;}
    if(!attempt.stageId)attempt.stageId=(await this.request<{stageId:string}>('/desktop/resource-stages',{method:'POST',body:{},token,key:key+'-stage'})).stageId;
    let publishedBody=input.body.trim();for(const asset of prepared.assets||[]){attempt.assets??={};let uploaded=attempt.assets[asset.key];if(!uploaded){const grant=await this.request<{attachmentId:string;uploadToken:string}>(`/desktop/resource-stages/${attempt.stageId}/files`,{method:'POST',body:{name:asset.name,mime:asset.mime,bytes:asset.bytes.length,role:'image'},token,key:key+'-'+asset.key});uploaded={id:grant.attachmentId,token:grant.uploadToken};attempt.assets[asset.key]=uploaded;}if(!uploaded.uploaded){await this.request(`/desktop/attachments/${uploaded.id}/content`,{method:'PUT',binary:asset.bytes,headers:{'X-Upload-Token':uploaded.token},token});uploaded.uploaded=true;}publishedBody=publishedBody.replaceAll('attachment:'+asset.key,'attachment:'+uploaded.id);}if(prepared.descriptor.kind==='markdown')bytes=new TextEncoder().encode(publishedBody);
    if(!attempt.intent)attempt.intent=await this.request<{attachmentId:string;uploadToken:string}>(`/desktop/resource-stages/${attempt.stageId}/files`,{method:'POST',body:{name:prepared.descriptor.name,mime:prepared.descriptor.kind==='pdf'?'application/pdf':prepared.descriptor.kind==='markdown'?'text/markdown':'application/octet-stream',bytes:bytes.length,role:'main'},token,key:key+'-file'});
    if(!attempt.uploaded){await this.request(`/desktop/attachments/${attempt.intent.attachmentId}/content`,{method:'PUT',binary:bytes,headers:{'X-Upload-Token':attempt.intent.uploadToken},token});attempt.uploaded=true;}check(this.current(prepared.environment),'知识库已切换，未发布。');
    const result=await this.request<{id:string}>('/desktop/entries',{method:'POST',body:{title:input.title.trim(),body:publishedBody,scope:input.scope,stageId:attempt.stageId,resourceType:prepared.descriptor.kind==='plan'?'route':'note',topics:[]},token,key:key+'-publish'});attempt.entryId=result.id;return result;
  }
  start(){if(this.timer||!this.api)return;this.stopped=false;this.timer=setInterval(()=>void this.tick().catch(()=>{}),25_000);this.timer.unref();void this.tick().catch(()=>{});}
  stop(){this.stopped=true;if(this.timer)clearInterval(this.timer);this.timer=null;this.prepared.clear();}
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
  private async tick(){if(this.stopped||!this.api)return;void this.syncFocus();if(this.active||this.stopped)return;this.active=true;try{await this.localBinding();if(this.pairing)await this.pollPairing();if(!this.secret||!this.binding?.accountId)return;const environment={...this.options.environment()},token=this.secret.token;const combined=this.secret.pendingIndexes.length===0;const identity=await this.request<{accountId:string;targetKey:string;isDefault:boolean;learningStatistics?:LearningStatisticsPolicy|null;task?:Task|null}>(combined?'/desktop/poll':'/desktop/session',combined?{method:'POST',body:{protocol:2},token}:{token});check(this.current(environment)&&identity.accountId===this.binding.accountId&&identity.targetKey===this.binding.targetKey,'社区接收目标不匹配，未写入知识库。');await this.syncLearningStatistics(identity.learningStatistics,environment,token);if(!identity.isDefault)return;
      for(const pending of [...this.secret.pendingIndexes]){const documents=await Promise.all((pending.documents||[{id:pending.documentId!,state:'indexing' as const}]).map(async document=>({id:document.id,state:await this.options.documentStatus(document.id)})));if(documents.some(document=>document.state==='indexing'))continue;const original=pending.result||{state:'indexing' as const,localIds:documents.map(document=>document.id),kind:'document' as const},state=original.kind==='document'?(documents.some(document=>document.state==='stored')?'stored':'indexed'):original.state;await this.request(`/desktop/receipts/${pending.receiptId}`,{method:'PUT',body:{...original,documents,leaseToken:pending.leaseToken,state,...(documents.some(document=>document.state==='stored'&&original.documents?.find(item=>item.id===document.id)?.state==='indexing')?{errorCode:'index_failed'}:{})},token});this.secret.pendingIndexes=this.secret.pendingIndexes.filter(item=>item.receiptId!==pending.receiptId);await this.saveBinding();}
      const task=combined?identity.task||null:await this.request<Task|null>('/desktop/claim',{method:'POST',body:{protocol:2},token});if(!task)return;check(task.accountId===this.binding.accountId&&task.targetKey===this.binding.targetKey&&this.current(environment),'社区接收目标不匹配，未写入知识库。');
      const downloaded=new Map<string,Uint8Array>();const staging=await privateDirectory(environment.userStateDir,'community-receive');let result:ImportResult,committed=false;
      try{for(const file of task.version.files){check(isId(file.id)&&Number.isSafeInteger(file.bytes)&&file.bytes>0&&file.bytes<=MAX_RESOURCE_FILE_BYTES&&/^[a-f\d]{64}$/.test(file.hash),'资源文件清单不正确。');const bytes=await this.request<Uint8Array>(`/desktop/receipts/${task.id}/files/${file.id}`,{download:true,headers:{'X-Receipt-Lease':task.leaseToken,'X-Community-Protocol':'2'},token});check(this.current(environment)&&bytes.length===file.bytes&&hash(bytes)===file.hash,'文件校验失败或接收知识库已变化。');downloaded.set(file.id,bytes);}
        // Recheck permission after transfer, immediately before any local write.
        const stillCurrent=await this.request<{accountId:string;targetKey:string}>('/desktop/session',{token});check(stillCurrent.accountId===task.accountId&&stillCurrent.targetKey===task.targetKey&&this.current(environment),'账号或知识库已变化。');
        await this.request(`/desktop/receipts/${task.id}/validate`,{method:'POST',body:{leaseToken:task.leaseToken,protocol:2},token});
        result=await this.importBasicTask(task,downloaded,staging,environment);committed=true;
        if(result.documents?.some(document=>document.state==='indexing')){this.secret.pendingIndexes=this.secret.pendingIndexes.filter(item=>item.receiptId!==task.id);this.secret.pendingIndexes.push({receiptId:task.id,leaseToken:task.leaseToken,documents:result.documents,result});await this.saveBinding();}
        await this.request(`/desktop/receipts/${task.id}`,{method:'PUT',body:{leaseToken:task.leaseToken,...result},token});this.lastStatus=result.kind==='link'?'链接已保存为本地引用，未下载原站内容。':result.state==='imported'?'资源已保存。':result.state==='indexing'?'资料已入库，正在建立索引。':'资源文件已保存。';
      }catch(error){if(!committed&&this.current(environment)){await this.request(`/desktop/receipts/${task.id}`,{method:'PUT',body:{leaseToken:task.leaseToken,state:'failed',localIds:[],errorCode:'import_failed'},token}).catch(()=>{});}throw error;}
    }catch(error){this.lastStatus=error instanceof Error?error.message:'社区接收暂未完成。';}finally{this.active=false;}}
  private referenceOperation<T>(work:()=>Promise<T>):Promise<T>{const pending=this.referenceWrites.then(work,work);this.referenceWrites=pending.then(()=>{},()=>{});return pending;}
  private async savedRecords(environment:Environment=this.options.environment()):Promise<(CommunitySavedResource&{accountId:string})[]>{const file=path.join(environment.userStateDir,'community-references.json');try{const stat=await fs.lstat(file);check(stat.isFile()&&!stat.isSymbolicLink()&&stat.size<=4*1024*1024,'本地社区引用清单无效。');const value=JSON.parse(await fs.readFile(file,'utf8'));check(value.version===1&&Array.isArray(value.items),'本地社区引用清单无效。');return value.items;}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return [];throw error;}}
  private async writeReferences(items:(CommunitySavedResource&{accountId:string})[],environment:Environment){check(this.current(environment),'知识库已切换。');await atomicWriteTextFile(path.join(environment.userStateDir,'community-references.json'),JSON.stringify({version:1,items}),{allowCopyFallback:false});}
  async references():Promise<CommunitySavedResource[]>{
    await this.localBinding();const environment={...this.options.environment()},accountId=this.binding?.accountId;
    return this.referenceOperation(async()=>{check(this.current(environment),'知识库已切换。');let rows=await this.savedRecords(environment);
      if(this.options.snapshotDocumentIds&&rows.some(row=>row.kind==='snapshot')){const existing=new Set(await this.options.snapshotDocumentIds(()=>this.current(environment))),kept=rows.filter(row=>row.kind!=='snapshot'||!!row.documentId&&existing.has(row.documentId));if(kept.length!==rows.length){await this.writeReferences(kept,environment);rows=kept;}}
      check(this.current(environment)&&accountId===this.binding?.accountId,'社区账号或知识库已切换。');return rows.filter(row=>row.accountId===accountId).map(({accountId:_accountId,...row})=>row);
    });
  }
  async snapshot(id:string):Promise<{title:string;body:string;sourceUrl:string;version:number}>{await this.localBinding();check(isId(id),'快照标识无效。');const environment={...this.options.environment()},saved=(await this.references()).find(row=>row.id===id&&row.kind==='snapshot');check(saved?.documentId&&this.options.readSnapshot,'未找到当前账号的只读快照。');const body=await this.options.readSnapshot(saved.documentId,()=>this.current(environment));check(this.current(environment),'知识库已切换。');return {title:saved.title,body,sourceUrl:saved.sourceUrl,version:saved.version};}
  private async saveReference(task:Task,environment:Environment,kind:'snapshot'|'link'|'video-link',documentId?:string,url?:string){return this.referenceOperation(async()=>{check(this.current(environment),'知识库已切换。');const items=await this.savedRecords(environment),id='community-'+hash(`${task.accountId}:${task.targetKey}:${task.version.id}:reference`).slice(0,32);if(!items.some(row=>row.id===id)){items.unshift({id,accountId:task.accountId,kind,title:task.version.title,version:task.version.version,entryId:task.entryId,sourceUrl:`${this.options.origin}/#/resource/${task.entryId}`,createdAt:new Date().toISOString(),...(documentId?{documentId}:{}),...(url?{url}:{})});await this.writeReferences(items,environment);}return id;});}
  private async importBasicTask(task:Task,downloaded:Map<string,Uint8Array>,staging:string,environment:Environment):Promise<ImportResult>{
    const delivery=task.version.delivery||basicResourceDelivery(task.version);check(delivery.kind!=='unsupported','此组合资源不在本轮范围，未自动恢复笔记或计划。');
    const documents:DocumentReceipt[]=[];for(const file of task.version.files.filter(file=>file.role==='attachment'))documents.push(await this.importFile(task,file,downloaded.get(file.id)!,staging,environment));
    if(delivery.kind==='link'||delivery.kind==='video-link'){const url=delivery.url&&publicResourceUrl(delivery.url);check(url,'资源链接无效。');const id=await this.saveReference(task,environment,delivery.kind,undefined,url);return {state:'imported',kind:'link',localIds:[id,...documents.map(document=>document.id)],documents};}
    if(delivery.kind==='snapshot'){
      let body=task.version.body;for(const file of task.version.files.filter(file=>file.role==='image'&&body.includes('attachment:'+file.id))){const data=downloaded.get(file.id);check(data&&/^image\/(png|jpeg|webp)$/.test(file.mime),'快照图片缺失。');body=body.replaceAll('attachment:'+file.id,'data:'+file.mime+';base64,'+Buffer.from(data).toString('base64'));}check(!/attachment:/.test(body),'快照图片引用不完整。');const bytes=new TextEncoder().encode(body);check(bytes.length<=20*1024*1024,'快照内容过大，未写入本地。');const file:FileDescriptor={id:task.version.id,name:task.version.title.replace(/[<>:"/\\|?*\x00-\x1f]/g,'_')+'.md',mime:'text/markdown',bytes:bytes.length,hash:hash(bytes),role:'main'};
      const imported=await this.importFile(task,file,bytes,staging,environment,'snapshot');documents.unshift(imported);const id=await this.saveReference(task,environment,'snapshot',imported.id);return {state:'stored',kind:'document',localIds:[imported.id,id,...documents.slice(1).map(document=>document.id)],documents};
    }
    const main=task.version.files.find(file=>file.role==='main');check(main&&downloaded.has(main.id),'资料缺少主文件。');documents.unshift(await this.importFile(task,main,downloaded.get(main.id)!,staging,environment));return {state:documents.some(document=>document.state==='indexing')?'indexing':documents.every(document=>document.state==='indexed')?'indexed':'stored',kind:'document',localIds:documents.map(document=>document.id),documents};
  }
  private async importFile(task:Task,file:FileDescriptor,bytes:Uint8Array,staging:string,environment:Environment,kind:'snapshot'|'file'='file'):Promise<DocumentReceipt>{
    const id='community-'+hash(`${task.accountId}:${task.targetKey}:${task.version.id}:${file.id}`).slice(0,32),localFile=path.join(staging,id+'.'+(file.name.split('.').at(-1)||'bin').replace(/[^a-zA-Z0-9]/g,''));
    await fs.writeFile(localFile,bytes,{flag:'wx'}).catch(async error=>{const stat=await fs.lstat(localFile);if((error as NodeJS.ErrnoException).code!=='EEXIST'||!stat.isFile()||stat.isSymbolicLink()||hash(await fs.readFile(localFile))!==file.hash)throw error;});
    const document=await this.options.importDocument({id,name:file.name,sourcePath:localFile,bytes:file.bytes,hash:file.hash,sourceUrl:`${this.options.origin}/#/resource/${task.entryId}`,communitySource:{accountId:task.accountId,entryId:task.entryId,versionId:task.version.id,role:file.role,kind}},()=>this.current(environment));return {id:document.id,state:document.status};
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
