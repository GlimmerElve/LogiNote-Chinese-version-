import {ApiError,requireValue} from './errors.js';
import type {HostedPrincipal,HostedProvider,HostedTokens} from './hostedAuth.js';

export interface CloudbaseConfig {
  environment:string;
  region?:string;
  clientId?:string;
  publishableKey?:string;
  timeoutMs?:number;
  maxResponseBytes?:number;
}
export type CloudbaseTokens=HostedTokens&{subject:string};
type Json=Record<string,unknown>;
type Purpose='register'|'reset_password'|'login';
type Operation='signin'|'signup'|'send'|'verify'|'reset'|'refresh'|'profile'|'signout';

const unavailable=()=>new ApiError(503,'auth_unavailable','CloudBase 账号服务暂时不可用，请稍后重试。',true);
const invalidResponse=()=>new ApiError(502,'auth_response_invalid','账号服务返回了无效响应。',true);
function record(value:unknown):Json {if(!value||typeof value!=='object'||Array.isArray(value))throw invalidResponse();return value as Json;}
function boundedString(value:unknown,max=24000):value is string {return typeof value==='string'&&value.length>0&&value.length<=max&&!/[\u0000-\u001f\u007f]/.test(value);}
function seconds(value:unknown):number {if(!Number.isInteger(value)||Number(value)<=0||Number(value)>366*86400)throw invalidResponse();return Number(value);}
function emailInput(value:string):string {requireValue(typeof value==='string'&&value.length<=254&&/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value),400,'invalid_request','请输入有效邮箱。');return value;}
function secretInput(value:string,label:string):string {requireValue(boundedString(value)&&Buffer.byteLength(value)<=32000,400,'invalid_request',`${label}格式不正确。`);return value;}

function providerError(status:number,body:Json,operation:Operation,retryAfterSeconds?:number):ApiError {
  // Provider descriptions may contain submitted identifiers or credentials. Never forward them.
  const code=typeof body.error==='string'?body.error:'';
  if(code==='captcha_required')return new ApiError(409,'captcha_required','CloudBase 要求完成图片验证后再试；当前页面尚未接入图片验证。');
  if(status===429||['rate_limit_exceeded','resource_exhausted','too_many_requests'].includes(code)){
    const seconds=retryAfterSeconds??(code==='rate_limit_exceeded'?60:undefined);
    return new ApiError(429,'rate_limited',seconds?`发送或验证暂时受限，请在 ${seconds} 秒后重试。`:'账号服务暂时限制了请求，请稍后重试。',true,seconds,'cloudbase');
  }
  if(['unimplemented','provider_not_found','internal','unavailable','unreachable'].includes(code)||status>=500)return unavailable();
  if(['invalid_status','user_blocked','user_pending','permission_denied'].includes(code))return new ApiError(403,'auth_account_unavailable','此账号暂时无法登录，请稍后重试或联系管理员。');
  if(['unauthenticated','invalid_token','token_expired','invalid_grant'].includes(code)||status===401)return new ApiError(401,'unauthenticated','登录状态已失效，请重新登录。');
  if(operation==='send'&&code==='not_found'){
    const description=typeof body.error_description==='string'?body.error_description.toLowerCase():'';
    if(description.includes('provider'))return new ApiError(503,'email_provider_unavailable','邮箱验证码通道暂不可用，请检查 CloudBase 的邮箱登录和发件配置。',true);
    return new ApiError(503,'auth_service_unavailable','账号服务暂时无法处理发码请求，请稍后重试。',true);
  }
  if(operation==='send'&&code==='user_not_found')return new ApiError(400,'account_unavailable','暂时无法为此邮箱发送验证码。首次使用请先注册，已有账号请检查邮箱。');
  if(['invalid_username_or_password','invalid_password','password_not_set','not_found','user_not_found'].includes(code))return new ApiError(401,'invalid_credentials','邮箱或密码不正确。首次使用请先注册，已有账号可找回密码。');
  if(['weak_password','password_too_weak'].includes(code))return new ApiError(400,'weak_password','密码未满足账号服务的安全要求，请使用包含大小写字母、数字和符号的密码。');
  if(operation==='verify'&&((status>=400&&status<500)||!!code))return new ApiError(400,'invalid_verification_code','验证码无效、已使用或已过期，请重新获取。');
  if(operation==='signup'&&['failed_precondition','already_exists','email_already_exists'].includes(code))return new ApiError(409,'registration_unavailable','暂时无法完成注册，请尝试登录或找回密码。');
  if(status>=400&&status<500)return new ApiError(400,'auth_request_rejected','账号服务未接受本次操作，请检查输入后重试。');
  return unavailable();
}

/** Server-only REST client. It does not persist passwords, tokens, or provider profiles. */
export class CloudbaseClient implements HostedProvider {
  readonly configured:boolean;
  readonly environment:string;
  private readonly origin:string;
  private readonly clientId?:string;
  private readonly timeoutMs:number;
  private readonly responseLimit:number;
  constructor(config?:CloudbaseConfig,private readonly fetcher:typeof fetch=fetch){
    this.environment=config?.environment||'';this.configured=!!this.environment;
    const region=config?.region||'ap-shanghai';
    requireValue(!this.configured||/^[a-z0-9][a-z0-9-]{0,126}$/.test(this.environment),500,'auth_configuration_invalid','CloudBase 环境配置不正确。');
    requireValue(['ap-shanghai','ap-guangzhou','ap-singapore'].includes(region),500,'auth_configuration_invalid','CloudBase 地域配置不正确。');
    requireValue(config?.clientId===undefined||boundedString(config.clientId,256),500,'auth_configuration_invalid','CloudBase 客户端配置不正确。');
    // Public HTTP API gateway, as shown in the CloudBase console and HTTP docs.
    this.origin=`https://${this.environment}.api${region==='ap-singapore'?'.intl':''}.tcloudbasegateway.com`;
    this.clientId=config?.clientId;
    this.timeoutMs=config?.timeoutMs??10000;this.responseLimit=config?.maxResponseBytes??65536;
    requireValue(Number.isInteger(this.timeoutMs)&&this.timeoutMs>=10&&this.timeoutMs<=30000&&Number.isInteger(this.responseLimit)&&this.responseLimit>=128&&this.responseLimit<=1048576,500,'auth_configuration_invalid','CloudBase 请求配置不正确。');
    // publishableKey is not a user credential. These documented public auth routes need
    // no SecretId/SecretKey, client_credentials, or service-account access key.
  }
  private async request(operation:Operation,path:string,body?:Json,accessToken?:string,captchaToken?:string):Promise<Json>{
    requireValue(this.configured,503,'auth_not_configured','CloudBase 账号服务尚未配置。');
    const url=new URL(`/auth/v1/${path}`,this.origin);
    if(this.clientId)url.searchParams.set('client_id',this.clientId);
    const headers:Record<string,string>={Accept:'application/json'};
    if(body!==undefined)headers['Content-Type']='application/json';
    if(accessToken)headers.Authorization=`Bearer ${secretInput(accessToken,'登录令牌')}`;
    if(captchaToken)headers['x-captcha-token']=secretInput(captchaToken,'图片验证令牌');
    const controller=new AbortController();let timer:ReturnType<typeof setTimeout>|undefined;
    const timeout=new Promise<never>((_,reject)=>{timer=setTimeout(()=>{controller.abort();reject(unavailable());},this.timeoutMs);});
    try{
      return await Promise.race([timeout,(async()=>{
        const response=await this.fetcher(url,{method:body===undefined?'GET':'POST',headers,...(body===undefined?{}:{body:JSON.stringify(body)}),signal:controller.signal,redirect:'error',credentials:'omit',cache:'no-store'});
        const length=response.headers.get('content-length');
        if(length!==null&&(!/^\d+$/.test(length)||Number(length)>this.responseLimit)){controller.abort();throw invalidResponse();}
        const reader=response.body?.getReader();let count=0;const chunks:Uint8Array[]=[];
        if(reader){try{while(true){const next=await reader.read();if(next.done)break;count+=next.value.byteLength;if(count>this.responseLimit){controller.abort();void reader.cancel().catch(()=>{});throw invalidResponse();}chunks.push(next.value);}}finally{reader.releaseLock();}}
        const raw=Buffer.concat(chunks).toString('utf8');let value:Json;
        try{value=raw.trim()?record(JSON.parse(raw)):{};}catch{throw invalidResponse();}
        const retryHeader=response.headers.get('retry-after');
        const retrySeconds=retryHeader&&/^\d+$/.test(retryHeader)&&Number(retryHeader)>0?Math.min(86400,Number(retryHeader)):undefined;
        if(!response.ok||typeof value.error==='string'||(typeof value.error_code==='number'&&value.error_code!==0))throw providerError(response.status,value,operation,retrySeconds);
        return value;
      })()]);
    }catch(error){const known=error instanceof ApiError?error:unavailable();known.source='cloudbase';throw known;}
    finally{if(timer)clearTimeout(timer);controller.abort();}
  }
  private tokens(value:Json):CloudbaseTokens {
    if(typeof value.token_type!=='string'||value.token_type.toLowerCase()!=='bearer'||!boundedString(value.access_token)||!boundedString(value.refresh_token)||!boundedString(value.sub,512)||value.sub==='service_account')throw invalidResponse();
    return {accessToken:value.access_token,refreshToken:value.refresh_token,expiresIn:seconds(value.expires_in),subject:value.sub};
  }
  async sendEmailCode(email:string,purpose:Purpose,captchaToken?:string){
    requireValue(purpose==='register'||purpose==='reset_password'||purpose==='login',400,'invalid_request','验证码用途不正确。');
    // HTTP API accepts email + target. SDK-specific usage selects a provider that
    // may not exist in this environment, even when email login is configured.
    // The BFF challenge separately binds register/reset/login to its consumer.
    const value=await this.request('send','verification',{email:emailInput(email),target:purpose==='register'?'ANY':'USER'},undefined,captchaToken);
    if(!boundedString(value.verification_id,2048))throw invalidResponse();
    return {verificationId:value.verification_id,expiresIn:seconds(value.expires_in)};
  }
  async verifyCode(verificationId:string,code:string){
    secretInput(verificationId,'验证码请求');requireValue(/^\d{6}$/.test(code),400,'invalid_verification_code','请输入 6 位邮箱验证码。');
    const value=await this.request('verify','verification/verify',{verification_id:verificationId,verification_code:code});
    if(!boundedString(value.verification_token))throw invalidResponse();return {verificationToken:value.verification_token};
  }
  async register(input:{email:string;password:string;name?:string;verificationToken:string}){
    requireValue(input.name===undefined||typeof input.name==='string'&&input.name.length<=80,400,'invalid_request','昵称不能超过 80 个字符。');
    return this.tokens(await this.request('signup','signup',{email:emailInput(input.email),password:secretInput(input.password,'密码'),verification_token:secretInput(input.verificationToken,'邮箱验证令牌'),...(input.name?{name:input.name}:{})}));
  }
  async signIn(email:string,password:string,captchaToken?:string){
    // Official @cloudbase/auth 3.9.1 signInWithPassword({email}) maps the complete
    // mailbox to username here. Do not truncate it to the username UI length limit.
    return this.tokens(await this.request('signin','signin',{username:emailInput(email),password:secretInput(password,'密码')},undefined,captchaToken));
  }
  async resetPassword(input:{email:string;password:string;verificationToken:string}):Promise<void>{
    // Official @cloudbase/oauth 3.9.1 auth API: POST /auth/v1/reset, not the
    // authenticated PATCH /user/password operation for changing an old password.
    await this.request('reset','reset',{email:emailInput(input.email),new_password:secretInput(input.password,'密码'),verification_token:secretInput(input.verificationToken,'邮箱验证令牌')});
  }
  async refresh(refreshToken:string){return this.tokens(await this.request('refresh','token',{grant_type:'refresh_token',refresh_token:secretInput(refreshToken,'刷新令牌'),...(this.clientId?{client_id:this.clientId}:{})}));}
  async userInfo(accessToken:string):Promise<HostedPrincipal>{
    const value=await this.request('profile','user/me',undefined,secretInput(accessToken,'登录令牌'));
    if(!boundedString(value.sub,512)||value.sub==='service_account')throw invalidResponse();
    if(value.status!==undefined&&value.status!=='ACTIVE')throw new ApiError(403,'auth_account_unavailable','此账号暂时无法登录，请联系管理员。');
    if(value.email!==undefined&&(!boundedString(value.email,254)||!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.email)))throw invalidResponse();
    if(value.email_verified!==undefined&&typeof value.email_verified!=='boolean')throw invalidResponse();
    return {subject:value.sub,...(typeof value.email==='string'?{email:value.email}:{}),...(typeof value.email_verified==='boolean'?{emailVerified:value.email_verified}:{}),...(boundedString(value.name,80)?{displayName:value.name}:{})};
  }
  async signOut(accessToken:string):Promise<void>{await this.request('signout','user/signout',{},secretInput(accessToken,'登录令牌'));}
}
