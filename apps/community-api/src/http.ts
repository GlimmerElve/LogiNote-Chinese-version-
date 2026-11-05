import {createServer,type IncomingMessage,type ServerResponse} from 'node:http';
import {createHash,randomUUID,timingSafeEqual} from 'node:crypto';
import type {Database,Sql} from './db.js';
import type {ApiConfig} from './config.js';
import {AuthService,type Mailer,type SessionView} from './auth.js';
import {CloudbaseClient} from './cloudbase.js';
import {HostedAuthService,type HostedProvider} from './hostedAuth.js';
import {AccessService,uuid} from './access.js';
import {GovernanceService} from './governance.js';
import {AttentionService} from './attention.js';
import {ProfileService} from './profile.js';
import {LearningStatisticsService} from './learningStatistics.js';
import {ContentService} from './content.js';
import {MessageService} from './messages.js';
import {GroupService} from './groups.js';
import {GroupTaskService} from './groupTasks.js';
import {NewsService} from './news.js';
import {NewsSourceService} from './newsSources.js';
import {createNewsFeedFetcher,type NewsFeedFetcher} from './newsFeedFetch.js';
import {GroupLimitsService} from './groupLimits.js';
import {ReportTriageService} from './reportTriage.js';
import {ResourceService} from './resources.js';
import {DeliveryService} from './delivery.js';
import {RateLimiter,runIdempotent,QuotaService,MAX_FILE_BYTES} from './operations.js';
import {FILE_TOO_LARGE_MESSAGE,FILE_TRANSFER_TIMEOUT_MS,MAX_ACCOUNT_STORAGE_BYTES} from './uploadLimits.js';
import {FileService} from './files.js';
import {TransferQuota} from './transfers.js';
import path from 'node:path';
import {ApiError,object,onlyKeys,requireValue} from './errors.js';
import {systemClock,type Clock,type Actor} from './types.js';

const PREFIX='/api/community/v1';
export function sessionDto(view:SessionView|null,avatarUrl?:string){return view?{kind:'authenticated',account:{accountId:view.account.id,displayName:view.account.displayName,email:view.account.email,...(avatarUrl?{avatarUrl}:{})},role:view.actor.role,expiresAt:view.expiresAt,csrfToken:view.csrfToken,mfa:view.mfa}:{kind:'guest'};}
export interface SafeLog {requestId:string;method:string;route:string;status:number;durationMs:number;errorCode?:string;errorSource?:'community'|'cloudbase'}
export interface HttpOptions {db:Database;config:ApiConfig;mailer:Mailer;clock?:Clock;log?:(entry:SafeLog)=>void;hostedProvider?:HostedProvider;newsFeedFetcher?:NewsFeedFetcher}
const header=(request:IncomingMessage,name:string)=>{const value=request.headers[name];return typeof value==='string'?value:undefined;};
function matches(a:string|undefined,b:string){if(!a||a.length>256)return false;const x=Buffer.from(a),y=Buffer.from(b);return x.length===y.length&&timingSafeEqual(x,y);}
function cookieValue(request:IncomingMessage,name:string){const parts=(header(request,'cookie')||'').split(';').map(part=>part.trim()).filter(part=>part.startsWith(`${name}=`));return parts.length===1?parts[0].slice(name.length+1):undefined;}
async function readJson(request:IncomingMessage,limit=64*1024):Promise<unknown>{
  requireValue((header(request,'content-type')||'').split(';')[0]==='application/json',415,'unsupported_media_type','请使用 JSON 请求。');
  const length=Number(header(request,'content-length')||0);requireValue(Number.isFinite(length)&&length<=limit,413,'payload_too_large','请求内容过大。');
  const chunks:Buffer[]=[];let bytes=0;
  for await(const chunk of request){const buffer=Buffer.from(chunk);bytes+=buffer.length;requireValue(bytes<=limit,413,'payload_too_large','请求内容过大。');chunks.push(buffer);}
  try{return JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{throw new ApiError(400,'invalid_json','请求内容不是有效的 JSON。');}
}
async function readFileBody(request:IncomingMessage){
  requireValue((header(request,'content-type')||'').split(';')[0]==='application/octet-stream',415,'unsupported_media_type','文件内容需使用二进制上传。');
  const length=Number(header(request,'content-length')||0);requireValue(Number.isFinite(length)&&length<=MAX_FILE_BYTES,413,'file_too_large',FILE_TOO_LARGE_MESSAGE);
  const chunks:Buffer[]=[];let bytes=0;for await(const chunk of request){const buffer=Buffer.from(chunk);bytes+=buffer.length;requireValue(bytes<=MAX_FILE_BYTES,413,'file_too_large',FILE_TOO_LARGE_MESSAGE);chunks.push(buffer);}return Buffer.concat(chunks);
}
export function createCommunityServer(options:HttpOptions){
  const {db,config,mailer}=options,clock=options.clock||systemClock;
  const auth=new AuthService(db,{encryptionKey:config.encryptionKey},mailer,clock),access=new AccessService(db,clock),governance=new GovernanceService(db,access,clock),attention=new AttentionService(db,{clock}),rates=new RateLimiter(db,clock);
  const hostedAuth=config.authProvider==='cloudbase'?new HostedAuthService(db,auth,options.hostedProvider||new CloudbaseClient(config.cloudbase||{environment:''}),config.encryptionKey,clock):null;
  const activeAuth=hostedAuth||auth;
  const profiles=new ProfileService(db,access,clock);
  const learningStatistics=new LearningStatisticsService(db,access,clock);
  const content=new ContentService(db,access,clock);
  const providerMetadata=()=>hostedAuth?hostedAuth.metadata():{provider:'local',configured:true,emailVerification:'link',passwordMinLength:12,passwordMaxLength:128,resendAfterSeconds:60};
  const mailState=()=>hostedAuth?(hostedAuth.metadata().configured?'managed_by_cloudbase':'not_configured'):(mailer.configured?'configured':'not_configured');
  const files=new FileService(db,access,new QuotaService(db,{globalLimitBytes:config.globalStorageLimitBytes},clock),{directory:path.join(config.dataDirectory,'attachments'),grantKey:config.encryptionKey},clock);
  const resources=new ResourceService(db,access,files,clock),delivery=new DeliveryService(db,access,resources,files,config.encryptionKey,clock);
  const messages=new MessageService(db,access,files,attention,clock);
  const groups=new GroupService(db,access,files,clock);
  const groupTasks=new GroupTaskService(db,access,groups,clock);
  const news=new NewsService(db,access,files,content,clock);
  const newsSources=new NewsSourceService(db,access,news,clock,options.newsFeedFetcher||createNewsFeedFetcher(config.newsDnsMode||'system'));
  const groupLimits=new GroupLimitsService(db,access,clock);
  const reportTriage=new ReportTriageService(db,access,clock);
  const transfers=new TransferQuota(db,config.globalDownloadLimitBytes||0,clock);
  const cookieName=config.secureCookies?'__Host-community_session':'loginote_community_session';
  const server=createServer(async(request,response)=>{
    const requestId=randomUUID(),started=Date.now(),method=request.method||'GET';let route='unmatched',errorCode:string|undefined,errorSource:SafeLog['errorSource'];
    response.setHeader('X-Request-Id',requestId);response.setHeader('Cache-Control','no-store');response.setHeader('X-Content-Type-Options','nosniff');response.setHeader('Referrer-Policy','no-referrer');response.setHeader('Vary','Origin');
    const send=(value:unknown,status=200)=>{response.statusCode=status;response.setHeader('Content-Type','application/json; charset=utf-8');response.end(JSON.stringify({ok:true,value,requestId}));};
    const csrf=(view:SessionView)=>requireValue(matches(header(request,'x-csrf-token'),view.csrfToken),403,'csrf_invalid','请求验证已失效，请刷新后重试。');
    const setCookie=(token:string,maxAge:number)=>response.setHeader('Set-Cookie',`${cookieName}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${config.secureCookies?'; Secure':''}`);
    try{
      const url=new URL(request.url||'/', 'http://community.invalid');requireValue(url.pathname.startsWith(`${PREFIX}/`),404,'not_found','接口不存在。');
      const origin=header(request,'origin');
      if(origin){requireValue(config.allowedOrigins.includes(origin),403,'origin_forbidden','请求来源不受支持。');response.setHeader('Access-Control-Allow-Origin',origin);response.setHeader('Access-Control-Allow-Credentials','true');}
      if(method==='OPTIONS'){
        route='preflight';requireValue(!!origin,403,'origin_forbidden','缺少请求来源。');
        requireValue(['GET','POST','PUT','DELETE'].includes(header(request,'access-control-request-method')||''),405,'method_not_allowed','不支持此方法。');
        const requested=(header(request,'access-control-request-headers')||'').toLowerCase().split(',').map(v=>v.trim()).filter(Boolean);
        requireValue(requested.every(v=>['content-type','x-csrf-token','idempotency-key','x-upload-token','x-download-token'].includes(v)),400,'invalid_request','不支持此请求头。');
        response.setHeader('Access-Control-Allow-Methods','GET, POST, PUT, DELETE');response.setHeader('Access-Control-Allow-Headers','Content-Type, X-CSRF-Token, Idempotency-Key, X-Upload-Token, X-Download-Token');response.setHeader('Access-Control-Max-Age','600');response.statusCode=204;response.end();return;
      }
      const path=url.pathname.slice(PREFIX.length);
      const queryAllowed=method==='GET'&&(path==='/news'||path==='/entries'||path==='/people'||path==='/conversations'||path==='/groups'||/^\/groups\/[\da-f-]+\/(?:messages|draft|members|audit|sync|tasks)$/i.test(path)||/^\/groups\/[\da-f-]+\/tasks\/[\da-f-]+\/activity$/i.test(path)||/^\/(?:entries\/[\da-f-]+\/comments|conversations\/[\da-f-]+\/(?:messages|sync))$/i.test(path));
      requireValue(!url.search||queryAllowed,400,'invalid_request','接口不接受查询参数。');
      const query=(keys:readonly string[])=>{const input=Object.fromEntries(url.searchParams);onlyKeys(input,keys);requireValue([...url.searchParams.keys()].length===Object.keys(input).length,400,'invalid_request','筛选参数不能重复。');return input;};
      if(method!=='GET'){requireValue(!!origin,403,'origin_forbidden','缺少请求来源。');}
      const ipHash=createHash('sha256').update(request.socket.remoteAddress||'unknown').digest('hex');
      await rates.consume(`http:${ipHash}`,600,60_000);
      const avatarMatch=path.match(/^\/profiles\/([\da-f-]+)\/avatar\/(\d{1,18})$/i);
      const token=cookieValue(request,cookieName),publicIdentity=path.startsWith('/identity/')||path==='/health'||!!avatarMatch;
      const freshIdentity=path.startsWith('/admin/')||path.startsWith('/me/mfa/')||path==='/me/devices'||path.startsWith('/me/devices/');
      const view=publicIdentity?null:path==='/me/sign-out'?await auth.lookup(token):hostedAuth?await hostedAuth.lookup(token,{requireFresh:freshIdentity}):await auth.lookup(token);
      const actor=():Actor=>{requireValue(view,401,'authentication_required','请先登录。');return view.actor;};
      const authorized=()=>{const result=actor();csrf(view!);return result;};
      const body=async()=>readJson(request,/^\/news\/(?:drafts|[\da-f-]+\/draft)$/i.test(path)?256*1024:64*1024);
      const mutate=async<T>(operation:string,payload:unknown,work:(actor:Actor,sql:Sql)=>Promise<T>)=>{const current=authorized();if(operation.startsWith('admin.')){await access.assertPlatformAdmin(current);await access.assertCapability(current,'write');}await rates.consume(`write:${current.accountId}`,60,60_000);const key=header(request,'idempotency-key');requireValue(key,400,'idempotency_required','请提供请求幂等键。');return runIdempotent(db,current.accountId,key,operation,payload,sql=>work(current,sql));};
      if(method==='GET'&&path==='/health'){route='health';await db.query('SELECT 1');send({status:'ready',authentication:providerMetadata(),mail:mailState(),storage:config.globalStorageLimitBytes>0?'local_private':'not_configured'});return;}
      if(method==='GET'&&path==='/identity/provider'){route='identity.provider';send(providerMetadata());return;}
      if(method==='GET'&&path==='/me/session'){route='session';send(sessionDto(view,view?(await profiles.get(view.actor)).avatarUrl:undefined));return;}
      if(method==='GET'&&avatarMatch){route='profile.avatar';const bytes=await profiles.avatar(uuid(avatarMatch[1]),avatarMatch[2]);response.statusCode=200;response.setHeader('Content-Type','image/webp');response.setHeader('Content-Length',bytes.length);response.setHeader('Cache-Control','public, max-age=300');response.end(bytes);return;}
      if(method==='GET'&&path==='/me/profile'){route='profile.read';const current=actor();send({...await profiles.get(current),learningStatistics:await learningStatistics.own(current)});return;}
      if(method==='PUT'&&path==='/me/profile'){route='profile.update';const input=await body();send(await mutate(route,input,(current,sql)=>profiles.update(current,input,sql)));return;}
      if(path==='/me/learning-statistics'){
        route='learning-statistics.settings';
        if(method==='GET'){send(await learningStatistics.own(actor()));return;}
        if(method==='PUT'){const input=await body();send(await mutate(route,input,(current,sql)=>learningStatistics.update(current,input,sql)));return;}
      }
      if(path==='/groups'){
        if(method==='GET'){route='groups.list';send(await groups.list(view?.actor||null,query(['view','q','offset'])));return;}
        if(method==='POST'){route='groups.create';const input=await body();send(await mutate(route,input,(current,sql)=>groups.create(current,input,sql)),201);return;}
      }
      if(path==='/news'&&method==='GET'){route='news.list';send(await news.list(view?.actor||null,query(['view','offset','q'])));return;}
      if(path==='/news/sources'&&method==='GET'){route='admin.news.sources';send(await newsSources.list(actor()));return;}
      const newsSourceMatch=path.match(/^\/news\/sources\/([a-z][a-z0-9-]{0,40})(\/collect)?$/);
      if(newsSourceMatch){const id=newsSourceMatch[1];route='admin.news.sources.'+(newsSourceMatch[2]?'collect':'update');
        if(method==='PUT'&&!newsSourceMatch[2]){const input=await body();send(await mutate(route+':'+id,input,(current,sql)=>newsSources.save(current,id,input,sql)));return;}
        if(method==='POST'&&newsSourceMatch[2]){
          const input=object(await body());onlyKeys(input,[]);const current=authorized();await access.assertPlatformAdmin(current);await access.assertCapability(current,'write');
          const key=header(request,'idempotency-key');requireValue(key&&key.length<=200&&!/[\u0000-\u001f\u007f]/.test(key),400,'idempotency_required','请提供请求幂等键。');await rates.consume('news-collect:'+current.accountId,10,60_000);
          // Collection owns a persistent lease and deduplication transaction. Do
          // not keep the generic HTTP idempotency transaction open over a fetch.
          send(await newsSources.collect(current,id));return;
        }
      }
      if(path==='/news/drafts'&&method==='POST'){route='news.create';const input=await body();send(await mutate(route,input,(current,sql)=>news.save(current,undefined,input,sql)),201);return;}
      const newsMatch=path.match(/^\/news\/([\da-f-]+)(?:\/(draft|submit|withdraw|review))?$/i);
      if(newsMatch){const id=uuid(newsMatch[1]),action=newsMatch[2];route='news.'+(action||'read');
        if(method==='GET'){if(!action)send(await news.publicDetail(view?.actor||null,id));else if(action==='draft'||action==='review')send(await news.privateDetail(actor(),id,db,action==='review'));else throw new ApiError(405,'method_not_allowed','不支持此操作。');return;}
        if(action==='draft'&&method==='PUT'){const input=await body();send(await mutate('news.edit:'+id,input,(current,sql)=>news.save(current,id,input,sql)));return;}
        if(['submit','withdraw','review'].includes(action||'')&&method==='POST'){const input=await body();send(await mutate((action==='review'?'admin.news.review':'news.'+action)+':'+id,input,(current,sql)=>action==='review'?news.review(current,id,input,sql):action==='submit'?news.submit(current,id,input,sql):news.withdraw(current,id,input,sql)));return;}
      }
      const taskMatch=path.match(/^\/groups\/([\da-f-]+)\/tasks(?:\/([\da-f-]+)(?:\/(progress|activity))?)?$/i);
      if(taskMatch){const id=uuid(taskMatch[1]),task=taskMatch[2]?uuid(taskMatch[2]):undefined,action=taskMatch[3];route='groups.tasks.'+(action||(task?'detail':'list'));
        if(method==='GET'){if(!task)send(await groupTasks.list(actor(),id,query(['view','offset'])));else if(action==='activity')send(await groupTasks.activity(actor(),id,task,query(['before'])));else if(!action)send(await groupTasks.get(actor(),id,task));else throw new ApiError(405,'method_not_allowed','不支持此操作。');return;}
        if(method==='POST'&&!task){const input=await body();send(await mutate(route+':'+id,input,(current,sql)=>groupTasks.create(current,id,input,sql)),201);return;}
        if(method==='PUT'&&task&&action!=='activity'){const input=await body();send(await mutate(route+':'+id+':'+task,input,(current,sql)=>action==='progress'?groupTasks.progress(current,id,task,input,sql):groupTasks.update(current,id,task,input,sql)));return;}
      }
      const participationMatch=path.match(/^\/groups\/([\da-f-]+)\/participation$/i);
      if(participationMatch&&method==='PUT'){const id=uuid(participationMatch[1]);route='groups.participation';const input=await body();send(await mutate(route+':'+id,input,(current,sql)=>groups.participation(current,id,input,sql)));return;}
      const groupContentDraft=path.match(/^\/groups\/([\da-f-]+)\/content-drafts\/(post|resource)$/i);
      if(groupContentDraft){const [,id,kind]=groupContentDraft;route='groups.content-draft';if(method==='GET'){send(await groups.contentDraft(actor(),uuid(id),kind));return;}if(method==='PUT'){const input=await body();send(await mutate(route+':'+id+':'+kind,input,(current,sql)=>groups.saveContentDraft(current,uuid(id),kind,input,sql)));return;}}
      const groupMatch=path.match(/^\/groups\/([\da-f-]+)(?:\/(membership|members|messages|pins|draft|stages|audit|sync|overview))?$/i);
      const groupMemberMatch=path.match(/^\/groups\/([\da-f-]+)\/members\/([\da-f-]+)$/i);
      const groupMessageMatch=path.match(/^\/groups\/([\da-f-]+)\/messages\/([\da-f-]+)$/i);
      const groupFileMatch=path.match(/^\/groups\/([\da-f-]+)\/stages\/([\da-f-]+)\/files\/([\da-f-]+)$/i);
      if(groupMemberMatch&&method==='PUT'){const [,id,target]=groupMemberMatch;route='groups.member';const input=await body();send(await mutate(route+':'+id+':'+target,input,(current,sql)=>groups.manage(current,uuid(id),uuid(target),input,sql)));return;}
      if(groupMessageMatch){const [,id,messageId]=groupMessageMatch;if(method==='GET'){route='groups.topic';send(await groups.topic(actor(),uuid(id),uuid(messageId)));return;}if(method==='PUT'){route='groups.message-action';const input=await body();send(await mutate(route+':'+messageId,input,(current,sql)=>groups.messageAction(current,uuid(id),uuid(messageId),input,sql)));return;}}
      if(groupFileMatch&&method==='DELETE'){const [,id,stageId,fileId]=groupFileMatch;route='groups.remove-image';send(await mutate(route+':'+fileId,{},(current,sql)=>groups.removeImage(current,uuid(id),uuid(stageId),uuid(fileId),sql)));return;}
      if(groupMatch){const id=uuid(groupMatch[1]),action=groupMatch[2];route='groups.'+(action||'detail');
        if(method==='GET'){if(!action)send(await groups.detail(view?.actor||null,id));else if(action==='overview'){const group=await groups.detail(view?.actor||null,id);send({group,pins:group.membership==='active'?await groups.pins(actor(),id):[]});}else if(action==='messages')send(await groups.history(actor(),id,query(['before','after','threadId'])));else if(action==='pins')send(await groups.pins(actor(),id));else if(action==='sync')send(await groups.sync(actor(),id,query(['since'])));else if(action==='members')send(await groups.members(actor(),id,query(['offset'])));else if(action==='audit')send(await groups.auditHistory(actor(),id,query(['offset'])));else if(action==='draft')send(await groups.draft(actor(),id,query(['threadId']).threadId));else throw new ApiError(405,'method_not_allowed','不支持此操作。');return;}
        if(method==='DELETE'&&!action){send(await mutate('groups.dissolve:'+id,{},(current,sql)=>groups.dissolve(current,id,sql)));return;}
        if(method==='PUT'&&!action){const input=await body();send(await mutate(route+':'+id,input,(current,sql)=>groups.update(current,id,input,sql)));return;}
        if(method==='PUT'&&action==='draft'){const input=await body();send(await mutate(route+':'+id,input,(current,sql)=>groups.saveDraft(current,id,input,sql)));return;}
        if(method==='POST'&&action==='membership'){const input=await body();send(await mutate(route+':'+id,input,(current,sql)=>groups.membership(current,id,input,sql)));return;}
        if(method==='POST'&&action==='stages'){const input=await body();send(await mutate(route+':'+id,input,(current,sql)=>groups.stage(current,id,input,sql)),201);return;}
        if(method==='POST'&&action==='messages'){const input=await body();await rates.consume('message:'+actor().accountId,30,60_000);send(await mutate(route+':'+id,input,(current,sql)=>groups.send(current,id,input,sql)),201);return;}
      }
      if(path==='/conversations'){
        if(method==='GET'){route='messages.list';send(await messages.list(actor(),query(['q','offset'])));return;}
        if(method==='POST'){route='messages.open';const input=await body();send(await mutate(route,input,(current,sql)=>messages.open(current,input,sql)));return;}
      }
      if(path==='/me/blocked'&&method==='GET'){route='messages.blocked';send(await messages.blocked(actor()));return;}
      const blockMatch=path.match(/^\/people\/([\da-f-]+)\/block$/i);
      if(blockMatch&&method==='PUT'){const id=uuid(blockMatch[1]);route='messages.block';const input=await body();send(await mutate(route+':'+id,input,(current,sql)=>messages.block(current,id,input,sql)));return;}
      const conversationMatch=path.match(/^\/conversations\/([\da-f-]+)(?:\/(messages|draft|stages|sync))?$/i);
      const messageFileMatch=path.match(/^\/conversations\/([\da-f-]+)\/stages\/([\da-f-]+)\/files\/([\da-f-]+)$/i);
      if(messageFileMatch&&method==='DELETE'){const [,conversationId,stageId,fileId]=messageFileMatch;route='messages.remove-image';send(await mutate(route+':'+fileId,{},(current,sql)=>messages.removeImage(current,uuid(conversationId),uuid(stageId),uuid(fileId),sql)));return;}
      if(conversationMatch){const id=uuid(conversationMatch[1]),action=conversationMatch[2];route='messages.'+(action||'detail');
        if(method==='GET'){if(!action)send(await messages.detail(actor(),id));else if(action==='messages')send(await messages.history(actor(),id,query(['before','after'])));else if(action==='sync')send(await messages.sync(actor(),id,query(['before','after'])));else if(action==='draft')send(await messages.draft(actor(),id));else throw new ApiError(405,'method_not_allowed','不支持此操作。');return;}
        if(method==='PUT'&&!action){const input=await body();send(await mutate(route+':'+id,input,(current,sql)=>messages.change(current,id,input,sql)));return;}
        if(method==='PUT'&&action==='draft'){const input=await body();send(await mutate(route+':'+id,input,(current,sql)=>messages.saveDraft(current,id,input,sql)));return;}
        if(method==='POST'&&action==='messages'){const input=await body();await rates.consume('message:'+actor().accountId,30,60_000);send(await mutate(route+':'+id,input,(current,sql)=>messages.send(current,id,input,sql)),201);return;}
        if(method==='POST'&&action==='stages'){const input=object(await body());onlyKeys(input,[]);send(await mutate(route+':'+id,input,(current,sql)=>messages.stage(current,id,sql)),201);return;}
      }
      if(path==='/entries'&&method==='GET'){route='content.list';send(await content.list(view?.actor||null,query(['view','kind','resourceType','q','topic','authorId','groupId','offset','limit'])));return;}
      const commentMatch=path.match(/^\/comments\/([\da-f-]+)$/i);
      if(commentMatch&&method==='DELETE'){const id=uuid(commentMatch[1]),input=object(await body());onlyKeys(input,[]);route='content.comment-withdraw';send(await mutate(route+':'+id,input,(current,sql)=>content.removeComment(current,id,sql)));return;}
      if(path==='/entries'&&method==='POST'){route='content.create';const input=object(await body());send(await mutate(route,input,async(current,sql)=>{const {stageId,license,...fields}=input;requireValue(fields.kind==='resource'||license===undefined,400,'invalid_request','普通分享无需资源许可字段。');const entry=await content.create(current,fields,sql);if(fields.kind==='resource')await resources.publish(current,entry.id,stageId===undefined?undefined:uuid(stageId),license,sql);else await resources.publishImages(current,entry.id,stageId===undefined?undefined:uuid(stageId),entry.body,sql);return content.get(current,entry.id,sql);}),201);return;}
      const entryMatch=path.match(/^\/entries\/([\da-f-]+)(?:\/(comments|bookmark|learning|restore|solution))?$/i);
      if(entryMatch){const id=uuid(entryMatch[1]),action=entryMatch[2];route=`content.${action||method.toLowerCase()}`;
        if(!action&&method==='GET'){send(await content.get(view?.actor||null,id));return;}
        if(!action&&method==='PUT'){const input=object(await body());send(await mutate(`${route}:${id}`,input,async(current,sql)=>{const {stageId,license,...fields}=input;const entry=await content.update(current,id,fields,sql);if(entry.kind==='resource')await resources.publish(current,id,stageId===undefined?undefined:uuid(stageId),license,sql);else{requireValue(license===undefined,400,'invalid_request','普通分享无需资源许可字段。');await resources.publishImages(current,id,stageId===undefined?undefined:uuid(stageId),entry.body,sql);}return content.get(current,id,sql);}));return;}
        if(!action&&method==='DELETE'){send(await mutate(`${route}:${id}`,{},(current,sql)=>content.withdraw(current,id,sql)));return;}
        if(action==='restore'&&method==='POST'){const input=object(await body());onlyKeys(input,[]);send(await mutate(`${route}:${id}`,{},(current,sql)=>content.restore(current,id,sql)));return;}
        if(action==='comments'&&method==='GET'){send(await content.comments(view?.actor||null,id,query(['offset','limit'])));return;}
        if(action==='solution'&&method==='PUT'){const input=await body();send(await mutate(`${route}:${id}`,input,(current,sql)=>content.solution(current,id,input,sql)));return;}
        if(action==='comments'&&method==='POST'){const input=object(await body());send(await mutate(`${route}:${id}`,input,async(current,sql)=>{const {stageId,...fields}=input;const comment=await content.comment(current,id,fields,sql);await resources.publishImages(current,comment.id,stageId===undefined?undefined:uuid(stageId),String(fields.body),sql);return comment;}),201);return;}
        if((action==='bookmark'||action==='learning')&&method==='PUT'){const input=await body();send(await mutate(`${route}:${id}`,input,async(current,sql)=>{const result=await content.relation(current,id,action,input,sql);if(action==='learning'&&result.enabled)await delivery.enqueue(current,id,sql);return result;}));return;}
      }
      if(path==='/people'&&method==='GET'){route='people.list';send(await content.people(view?.actor||null,query(['q','offset','limit','following'])));return;}
      const personMatch=path.match(/^\/people\/([\da-f-]+)(\/follow)?$/i);
      if(personMatch){const id=uuid(personMatch[1]);route=personMatch[2]?'people.follow':'people.profile';if(!personMatch[2]&&method==='GET'){send({...await content.publicProfile(view?.actor||null,id),learningStatistics:await learningStatistics.visible(view?.actor||null,id)});return;}if(personMatch[2]&&method==='PUT'){const input=await body();send(await mutate(`${route}:${id}`,input,(current,sql)=>content.follow(current,id,input,sql)));return;}}
      const draftMatch=path.match(/^\/me\/drafts\/(post|resource)$/);
      if(draftMatch){route='drafts';if(method==='GET'){send(await content.draft(actor(),draftMatch[1]));return;}if(method==='PUT'){const input=await body();send(await mutate(`${route}:${draftMatch[1]}`,input,(current,sql)=>content.saveDraft(current,draftMatch[1],input,sql)));return;}}
      if(path==='/resource-stages'&&method==='POST'){route='resources.stage';const input=object(await body());onlyKeys(input,[]);send(await mutate(route,input,(current,sql)=>resources.stage(current,sql)),201);return;}
      const inspectionMatch=path.match(/^\/resource-stages\/([\da-f-]+)\/files\/([\da-f-]+)\/inspection$/i);
      if(inspectionMatch&&method==='GET'){route='resources.inspect';const current=actor();await rates.consume('resource-inspect:'+current.accountId,20,60_000);send(await resources.inspectStageFile(current,uuid(inspectionMatch[1]),uuid(inspectionMatch[2])));return;}
      const stageMatch=path.match(/^\/resource-stages\/([\da-f-]+)(?:\/files(?:\/([\da-f-]+))?)?$/i);
      if(stageMatch){const id=uuid(stageMatch[1]);route='resources.stage-files';if(method==='GET'&&!stageMatch[2]){send(await resources.stageFiles(actor(),id));return;}if(method==='POST'&&path.endsWith('/files')){const current=authorized(),key=header(request,'idempotency-key');requireValue(key,400,'idempotency_required','请提供请求幂等键。');await rates.consume('upload:'+current.accountId,20,60_000);send(await resources.intent(current,id,await body(),key),201);return;}if(method==='DELETE'&&stageMatch[2]){send(await mutate(route+':'+stageMatch[2],{},(current,sql)=>resources.remove(current,id,stageMatch[2],sql)));return;}}
      const versionMatch=path.match(/^\/entries\/([\da-f-]+)\/versions(?:\/([\da-f-]+)(?:\/preview\/([a-zA-Z0-9_-]+))?)?$/i);
      if(versionMatch&&method==='GET'){route='resources.version';const id=uuid(versionMatch[1]);if(versionMatch[3])send(await resources.previewUnit(view?.actor||null,id,uuid(versionMatch[2]),versionMatch[3]));else if(versionMatch[2])send(await resources.version(view?.actor||null,id,uuid(versionMatch[2])));else send({current:await resources.version(view?.actor||null,id),versions:await resources.versions(view?.actor||null,id)});return;}
      if(path==='/me/devices'&&method==='GET'){route='delivery.devices';send(await delivery.devices(actor()));return;}
      if(path==='/me/devices/approve'&&method==='POST'){route='delivery.approve';const input=await body();await rates.consume('pair-approve:'+actor().accountId,10,60_000);send(await mutate(route,input,(current,sql)=>delivery.approve(current,input,sql)));return;}
      const deviceMatch=path.match(/^\/me\/devices\/([\da-f-]+)$/i);
      if(deviceMatch&&method==='DELETE'){route='delivery.revoke';send(await mutate(route+':'+deviceMatch[1],{},(current,sql)=>delivery.revoke(current,deviceMatch[1],sql)));return;}
      const receiveVersion=path.match(/^\/entries\/([\da-f-]+)\/receive$/i);
      if(receiveVersion&&method==='POST'){route='delivery.enqueue';const input=object(await body());onlyKeys(input,['versionId']);send(await mutate(route+':'+receiveVersion[1],input,(current,sql)=>delivery.enqueue(current,uuid(receiveVersion[1]),sql,input.versionId===undefined?undefined:uuid(input.versionId))),201);return;}
      if(path==='/me/receipts'&&method==='GET'){route='delivery.receipts';send(await delivery.receipts(actor()));return;}
      const receiptMatch=path.match(/^\/me\/receipts\/([\da-f-]+)$/i);
      if(receiptMatch&&method==='PUT'){route='delivery.receipt-change';const input=await body();send(await mutate(route+':'+receiptMatch[1],input,(current,sql)=>delivery.changeReceipt(current,receiptMatch[1],input,sql)));return;}
      if(path==='/desktop/pairings'&&method==='POST'){route='delivery.pair-start';await rates.consume('pair-start:'+ipHash,10,60_000);send(await delivery.startPairing(await body()),201);return;}
      const pairMatch=path.match(/^\/desktop\/pairings\/([\da-f-]+)$/i);
      if(pairMatch&&method==='POST'){route='delivery.pair-claim';await rates.consume('pair-poll:'+ipHash,120,60_000);send(await delivery.claimPairing(pairMatch[1],await body()));return;}
      if(path.startsWith('/desktop/')){route='delivery.desktop';const device=await delivery.device(header(request,'authorization')?.replace(/^Bearer /,''));const desktopActor:Actor={accountId:device.account_id,role:'member',mfaVerified:false};
        const desktopMutate=async<T>(operation:string,payload:unknown,work:(sql:Sql)=>Promise<T>)=>{await access.assertCapability(desktopActor,'write');const key=header(request,'idempotency-key');requireValue(key,400,'idempotency_required','请提供请求幂等键。');await rates.consume('write:'+desktopActor.accountId,60,60_000);return runIdempotent(db,desktopActor.accountId,key,operation,payload,work);};
        if(path==='/desktop/disconnect'&&method==='POST'){send(await db.transaction(sql=>delivery.revoke(desktopActor,device.id,sql)));return;}
        if(path==='/desktop/focus'&&method==='PUT'){const input=object(await body());onlyKeys(input,['enabled']);requireValue(typeof input.enabled==='boolean',400,'invalid_request','专注状态必须是布尔值。');await rates.consume('desktop-focus:'+device.id,30,60_000);send(await attention.setDeviceFocus(device,input.enabled));return;}
        if(path==='/desktop/resource-stages'&&method==='POST'){const input=object(await body());onlyKeys(input,[]);send(await desktopMutate('desktop.stage',input,sql=>resources.stage(desktopActor,sql)),201);return;}
        const stage=path.match(/^\/desktop\/resource-stages\/([\da-f-]+)\/files$/i);
        if(stage&&method==='POST'){await rates.consume('upload:'+desktopActor.accountId,20,60_000);const key=header(request,'idempotency-key');requireValue(key,400,'idempotency_required','请提供请求幂等键。');send(await resources.intent(desktopActor,uuid(stage[1]),await body(),key),201);return;}
        const upload=path.match(/^\/desktop\/attachments\/([\da-f-]+)\/content$/i);
        if(upload&&method==='PUT'){send(await files.put(desktopActor,uuid(upload[1]),header(request,'x-upload-token')||'',await readFileBody(request)));return;}
        if(path==='/desktop/entries'&&method==='POST'){const input=object(await body());onlyKeys(input,['title','body','scope','stageId','resourceType','topics']);requireValue(input.scope==='public'||input.scope==='self',400,'invalid_request','请选择公开或仅自己。');send(await desktopMutate('desktop.publish',input,async sql=>{const {stageId,...fields}=input;const entry=await content.create(desktopActor,{...fields,kind:'resource'},sql);await resources.publish(desktopActor,entry.id,stageId===undefined?undefined:uuid(stageId),undefined,sql);return entry;}),201);return;}
        if(path==='/desktop/poll'&&method==='POST'){const input=object(await body());onlyKeys(input,['protocol']);requireValue(input.protocol===2,409,'protocol_update_required','请使用更新后的 LogiNote。');send({accountId:device.account_id,deviceId:device.id,targetKey:device.target_key,isDefault:device.is_default,learningStatistics:device.learning_statistics||null,task:await delivery.claim(device)});return;}if(path==='/desktop/learning-statistics'&&method==='PUT'){send(await learningStatistics.accept(device,await body()));return;}if(path==='/desktop/session'&&method==='GET'){send({accountId:device.account_id,deviceId:device.id,targetKey:device.target_key,isDefault:device.is_default,learningStatistics:device.learning_statistics||null});return;}if(path==='/desktop/claim'&&method==='POST'){const input=object(await body());onlyKeys(input,['protocol']);requireValue(input.protocol===2,409,'protocol_update_required','请重启更新后的 LogiNote，使用只读资料接收方式。');send(await delivery.claim(device));return;}const validateMatch=path.match(/^\/desktop\/receipts\/([\da-f-]+)\/validate$/i);if(validateMatch&&method==='POST'){const input=object(await body());requireValue(input.protocol===2,409,'protocol_update_required','请使用更新后的只读资料接收方式。');delete input.protocol;send(await delivery.validate(device,validateMatch[1],input));return;}const match=path.match(/^\/desktop\/receipts\/([\da-f-]+)(?:\/files\/([\da-f-]+))?$/i);if(match&&method==='PUT'&&!match[2]){send(await delivery.acknowledge(device,match[1],await body()));return;}if(match?.[2]&&method==='GET'){requireValue(header(request,'x-community-protocol')==='2',409,'protocol_update_required','请使用更新后的只读资料接收方式。');transfers.assertConfigured();const saved=await delivery.download(device,match[1],match[2],header(request,'x-receipt-lease'));await transfers.consume(saved.buffer.length);response.setHeader('Content-Type','application/octet-stream');response.setHeader('Content-Length',saved.buffer.length);response.statusCode=200;response.end(saved.buffer);return;}}
      if(path==='/attachments/intents'&&method==='POST'){route='attachments.intent';const current=authorized(),key=header(request,'idempotency-key');requireValue(key,400,'idempotency_required','请提供请求幂等键。');await rates.consume(`upload:${current.accountId}`,20,60_000);send(await files.createIntent(current,await body(),key),201);return;}
      let attachmentMatch=path.match(/^\/attachments\/([\da-f-]+)\/(content|download)$/i);
      if(attachmentMatch){const id=uuid(attachmentMatch[1]),action=attachmentMatch[2];route=`attachments.${action}`;
        if(action==='content'&&method==='PUT'){const current=authorized();await rates.consume(`upload:${current.accountId}`,20,60_000);send(await files.put(current,id,header(request,'x-upload-token')||'',await readFileBody(request)));return;}
        if(action==='download'&&method==='POST'){const current=authorized();transfers.assertConfigured();await rates.consume(`download:${current.accountId}`,60,60_000);send(await files.createDownload(current,id));return;}
        if(action==='content'&&method==='GET'){const current=actor();transfers.assertConfigured();await rates.consume(`download:${current.accountId}`,60,60_000);const file=await files.download(current,id,header(request,'x-download-token')||'');await transfers.consume(file.buffer.length);response.statusCode=200;response.setHeader('Content-Type','application/octet-stream');response.setHeader('Content-Disposition',`attachment; filename*=UTF-8''${encodeURIComponent(file.name).replace(/[!'()*]/g,char=>`%${char.charCodeAt(0).toString(16).toUpperCase()}`)}`);response.setHeader('Content-Length',file.buffer.length);response.end(file.buffer);return;}}
      attachmentMatch=path.match(/^\/attachments\/([\da-f-]+)$/i);
      if(attachmentMatch&&method==='DELETE'){route='attachments.cancel';send(await files.cancel(authorized(),uuid(attachmentMatch[1])));return;}
      if(method==='POST'&&path.startsWith('/identity/')){
        const identityAction=path.slice('/identity/'.length);route=['email-code','register','verify-email','login','resend-verification','recover','reset-password'].includes(identityAction)?`identity.${identityAction}`:'identity';await rates.consume(`identity:${ipHash}`,20,15*60_000);const input=await body();
        if(hostedAuth){
          if(path==='/identity/email-code'){send(await hostedAuth.sendEmailCode(input));return;}
          if(path==='/identity/register'||path==='/identity/login'){
            const session=path==='/identity/register'?await hostedAuth.register(input):await hostedAuth.login(input);
            setCookie(session.sessionToken,Math.max(0,Math.floor((Date.parse(session.expiresAt)-clock().getTime())/1000)));send(sessionDto(session),path.endsWith('/register')?201:200);return;
          }
          if(path==='/identity/reset-password'){send(await hostedAuth.resetPassword(input));return;}
          throw new ApiError(400,'identity_method_unavailable','请使用 CloudBase 邮箱验证码流程。');
        }
        if(path==='/identity/register'){send(await auth.register(input),201);return;}
        if(path==='/identity/verify-email'){send(await auth.verifyEmail(input));return;}
        if(path==='/identity/login'){const session=await auth.login(input);setCookie(session.sessionToken,Math.max(0,Math.floor((Date.parse(session.expiresAt)-clock().getTime())/1000)));send(sessionDto(session));return;}
        if(path==='/identity/resend-verification'){send(await auth.requestEmailVerification(input));return;}
        if(path==='/identity/recover'){send(await auth.requestPasswordReset(input));return;}
        if(path==='/identity/reset-password'){send(await auth.resetPassword(input));return;}
      }
      if(method==='POST'&&path==='/me/sign-out'){route='sign-out';if(view)authorized();await activeAuth.logout(token);setCookie('',0);send({signedOut:true});return;}
      if(method==='POST'&&path.startsWith('/me/mfa/')){
        route='mfa';const current=authorized();await rates.consume(`mfa:${current.accountId}`,10,60_000);const input=await body();
        if(path==='/me/mfa/enroll'){send(await activeAuth.enrollTotp(token!,input));return;}
        if(path==='/me/mfa/confirm'){send(sessionDto(await activeAuth.confirmTotp(token!,input)));return;}
        if(path==='/me/mfa/challenge'){send(sessionDto(await activeAuth.challengeTotp(token!,input)));return;}
      }
      if(path==='/me/attention'&&method==='GET'){route='attention';send(await attention.getPreferences(actor()));return;}
      if(path==='/me/attention'&&method==='PUT'){route='attention';const current=authorized();send(await attention.updatePreferences(current,await body()));return;}
      if(path==='/me/focus'&&method==='PUT'){route='focus';const current=authorized(),input=object(await body());onlyKeys(input,['enabled']);requireValue(typeof input.enabled==='boolean',400,'invalid_request','专注状态必须是布尔值。');send(await attention.setFocus(current,input.enabled));return;}
      if(path==='/objects'&&method==='POST'){route='objects.create';const input=await body();send(await mutate(route,input,(current,sql)=>access.createObject(current,input,sql)),201);return;}
      let match=path.match(/^\/objects\/([\da-f-]+)$/i);
      if(match&&method==='GET'){route='objects.read';send(await access.readObject(view?.actor||null,uuid(match[1])));return;}
      if(path==='/reports'&&method==='POST'){route='reports.submit';const input=await body();send(await mutate(route,input,(current,sql)=>governance.submit(current,input,sql)),201);return;}
      if(path==='/me/reports'&&method==='GET'){route='reports.mine';send(await governance.listMine(actor()));return;}
      match=path.match(/^\/reports\/([\da-f-]+)(\/appeals)?$/i);
      if(match){const id=uuid(match[1]);if(!match[2]&&method==='GET'){route='reports.read';send(await governance.get(actor(),id));return;}
        if(match[2]&&method==='POST'){route='reports.appeal';const input=await body();send(await mutate(`${route}:${id}`,input,(current,sql)=>governance.appeal(current,id,input,sql)),201);return;}}
      if(path==='/admin/reports'&&method==='GET'){route='admin.queue';send(await governance.listQueue(actor()));return;}
      const reportTriageMatch=path.match(/^\/admin\/reports\/([\da-f-]+)\/triage$/i);
      if(reportTriageMatch&&method==='POST'){const id=uuid(reportTriageMatch[1]),input=await body();route='admin.report-triage';send(await mutate(route+':'+id,input,(current,sql)=>reportTriage.update(current,id,input,sql)));return;}
      if(path==='/admin/group-limits'){
        route='admin.group-limits';
        if(method==='GET'){send(await groupLimits.get(actor()));return;}
        if(method==='PUT'){const input=await body();send(await mutate(route,input,(current,sql)=>groupLimits.update(current,input,sql)));return;}
      }
      const suggestionFeedbackMatch=path.match(/^\/admin\/reports\/([\da-f-]+)\/suggestion-feedback$/i);
      if(suggestionFeedbackMatch&&method==='POST'){const id=uuid(suggestionFeedbackMatch[1]),input=await body();route='admin.suggestion-feedback';send(await mutate(route+':'+id,input,(current,sql)=>governance.respondSuggestion(current,id,input,sql)));return;}
      if(path==='/admin/config'&&method==='GET'){route='admin.config';await access.assertPlatformAdmin(actor());send({authentication:providerMetadata(),mail:mailState(),storage:config.globalStorageLimitBytes>0?'local_private':'not_configured',globalStorageLimitBytes:config.globalStorageLimitBytes,download:await transfers.usage(),maxFileBytes:MAX_FILE_BYTES,maxAccountStorageBytes:MAX_ACCOUNT_STORAGE_BYTES,push:'not_configured',ordinaryAlertsDefault:false,showUnreadBadges:false,replayAfterFocus:false});return;}
      match=path.match(/^\/admin\/reports\/([\da-f-]+)\/(assign|decisions|evidence|audit)$/i);
      if(match){const id=uuid(match[1]),action=match[2];route=`admin.${action}`;
        if(action==='evidence'&&method==='GET'){const current=authorized();send(await governance.readEvidence(current,id));return;}
        if(action==='audit'&&method==='GET'){send(await governance.listAudit(actor(),id));return;}
        if((action==='assign'||action==='decisions')&&method==='POST'){const input=await body();send(await mutate(`${route}:${id}`,input,(current,sql)=>action==='assign'?governance.assign(current,id,input,sql):governance.decide(current,id,input,sql)));return;}}
      match=path.match(/^\/admin\/appeals\/([\da-f-]+)\/review$/i);
      if(match&&method==='POST'){route='admin.appeal-review';const id=uuid(match[1]),input=await body();send(await mutate(`${route}:${id}`,input,(current,sql)=>governance.reviewAppeal(current,id,input,sql)));return;}
      throw new ApiError(404,'not_found','接口不存在。');
    }catch(error){
      const known=error instanceof ApiError?error:new ApiError(500,'internal_error','服务暂时无法完成请求，请稍后重试。',true);errorCode=known.code;errorSource=known.source;
      const retryAfter=Number.isInteger(known.retryAfterSeconds)&&known.retryAfterSeconds!>0&&known.retryAfterSeconds!<=86400?known.retryAfterSeconds:undefined;
      if(!response.headersSent){response.statusCode=known.status;response.setHeader('Content-Type','application/json; charset=utf-8');if(retryAfter)response.setHeader('Retry-After',retryAfter);response.end(JSON.stringify({ok:false,error:{code:known.code,message:known.message,retryable:known.retryable,...(retryAfter?{retryAfterSeconds:retryAfter}:{})},requestId}));}else response.end();
      if(!request.complete)request.resume();
    }finally{options.log?.({requestId,method,route,status:response.statusCode,durationMs:Date.now()-started,...(errorCode?{errorCode}:{}),...(errorSource?{errorSource}:{})});}
  });
  server.requestTimeout=FILE_TRANSFER_TIMEOUT_MS;server.headersTimeout=15_000;server.keepAliveTimeout=5_000;
  return {server,auth,hostedAuth,access,governance,attention,files,news,newsSources};
}
