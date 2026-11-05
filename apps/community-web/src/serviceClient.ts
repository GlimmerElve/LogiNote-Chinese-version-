export type ServiceMfa='not_required'|'enrollment_required'|'challenge_required'|'verified';
export type ServiceSession={kind:'guest'}|{kind:'authenticated';account:{accountId:string;displayName:string;email?:string;avatarUrl?:string};role:'member'|'administrator';expiresAt:string;csrfToken:string;mfa:ServiceMfa};
export type AuthenticatedServiceSession=Extract<ServiceSession,{kind:'authenticated'}>;
export type DeliveryResult={delivery:'sent'|'accepted'|'not_configured';expiresAt?:string;accepted?:boolean};
export type MfaEnrollment={secret:string;otpauthUri:string;expiresAt:string};
export type IdentityProvider={provider:'cloudbase'|'local';configured:boolean;emailVerification:'code'|'link';passwordMinLength:number;passwordMaxLength:number;resendAfterSeconds:number};
export type EmailCodeDelivery={delivery:'sent'|'not_configured';verificationId?:string;expiresAt?:string;resendAfterSeconds:number};
export type EmailCodeCredentials={email:string;password:string;code:string;verificationId:string};
import type {OwnLearningStatistics,LearningStatisticsPolicy} from '../../community-api/src/learningStatisticsContract';
export type ServiceProfile={accountId:string;displayName:string;bio:string;interests:string[];avatarUrl?:string;learningStatistics?:OwnLearningStatistics};
export const SESSION_CHANGED='community-session-changed';
const identityChannel=typeof window!=='undefined'&&typeof BroadcastChannel!=='undefined'?new BroadcastChannel('loginote-community-identity'):null;
identityChannel?.addEventListener('message',event=>{if(event.data==='changed')window.dispatchEvent(new Event(SESSION_CHANGED));});
function sessionChanged(){window.dispatchEvent(new Event(SESSION_CHANGED));identityChannel?.postMessage('changed');}

export class ServiceApiError extends Error {
  constructor(public readonly code:string,message:string,public readonly retryable=false,public readonly status=0,public readonly retryAfterSeconds?:number){super(message);this.name='ServiceApiError';}
}
export type ServiceConfiguration={kind:'configured';baseUrl:string}|{kind:'not_configured'}|{kind:'invalid';message:string};
export function resolveServiceConfiguration(raw:string|undefined):ServiceConfiguration {
  if(!raw?.trim())return {kind:'not_configured'};
  try{
    const url=new URL(raw.trim()),loopback=['127.0.0.1','localhost','[::1]'].includes(url.hostname);
    if(url.username||url.password||url.search||url.hash||url.protocol!=='https:'&&!(url.protocol==='http:'&&loopback))throw Error('invalid');
    const path=url.pathname.replace(/\/$/,'');if(path&&path!=='/api/community/v1')throw Error('invalid');
    return {kind:'configured',baseUrl:`${url.origin}/api/community/v1`};
  }catch{return {kind:'invalid',message:'社区服务地址配置无效，请使用 HTTPS 或本机回环地址。'};}
}
const record=(value:unknown):value is Record<string,unknown>=>!!value&&typeof value==='object'&&!Array.isArray(value);
export class CommunityServiceClient {
  readonly configuration:ServiceConfiguration;
  constructor(raw:string|undefined){this.configuration=resolveServiceConfiguration(raw);}
  get configured(){return this.configuration.kind==='configured';}
  async request<T>(path:string,{method='GET',body,authenticated=false,idempotencyKey,signal,accountScope}:{method?:'GET'|'POST'|'PUT'|'PATCH'|'DELETE';body?:unknown;authenticated?:boolean;idempotencyKey?:string;signal?:AbortSignal;accountScope?:string}={}):Promise<T> {
    if(this.configuration.kind!=='configured')throw new ServiceApiError('not_configured',this.configuration.kind==='invalid'?this.configuration.message:'社区账号服务尚未接入。',false,503);
    if(!/^\/[a-z0-9/_-]+(?:\?[A-Za-z0-9%=&._~-]+)?$/i.test(path))throw new ServiceApiError('invalid_request','请求地址不正确。');
    const headers:Record<string,string>={Accept:'application/json'};
    if(body!==undefined)headers['Content-Type']='application/json';
    if(idempotencyKey!==undefined){if(!/^[A-Za-z0-9._:-]{8,128}$/.test(idempotencyKey))throw new ServiceApiError('invalid_request','请求标识格式不正确。');headers['Idempotency-Key']=idempotencyKey;}
    // Reads already carry the HttpOnly cookie and are authenticated by the BFF.
    // CSRF is required for mutations, not a second identity roundtrip before GET.
    if(authenticated&&(method!=='GET'||accountScope)){const session=await this.getSession(signal);if(session.kind!=='authenticated')throw new ServiceApiError('unauthenticated','请先登录。',false,401);if(accountScope&&session.account.accountId!==accountScope)throw new ServiceApiError('account_changed','账号已变化，请重新打开此页面。',false,409);if(method!=='GET')headers['X-CSRF-Token']=session.csrfToken;}
    let response:Response;
    try{response=await fetch(`${this.configuration.baseUrl}${path}`,{method,credentials:'include',cache:'no-store',headers,body:body===undefined?undefined:JSON.stringify(body),signal});}
    catch(error){if(error instanceof DOMException&&error.name==='AbortError')throw error;throw new ServiceApiError('network_unavailable','暂时无法连接社区服务，请稍后重试。',true);}
    let envelope:unknown;try{envelope=await response.json();}catch{throw new ServiceApiError('invalid_response','社区服务返回了无法识别的响应。',true,response.status);}
    if(!record(envelope))throw new ServiceApiError('invalid_response','社区服务返回了无法识别的响应。',true,response.status);
    if(envelope.ok===true&&response.ok&&Object.hasOwn(envelope,'value'))return envelope.value as T;
    if(envelope.ok===false&&record(envelope.error)&&typeof envelope.error.code==='string'&&typeof envelope.error.message==='string'){
      const retry=envelope.error.retryAfterSeconds;
      throw new ServiceApiError(envelope.error.code,envelope.error.message,envelope.error.retryable===true,response.status,Number.isInteger(retry)&&Number(retry)>0&&Number(retry)<=86400?Number(retry):undefined);
    }
    throw new ServiceApiError('invalid_response','社区服务请求未能完成。',response.status>=500,response.status);
  }
  async getSession(signal?:AbortSignal):Promise<ServiceSession> {
    const value=await this.request<unknown>('/me/session',{signal});
    if(record(value)&&value.kind==='guest')return {kind:'guest'};
    if(record(value)&&value.kind==='authenticated'&&record(value.account)&&typeof value.account.accountId==='string'&&typeof value.account.displayName==='string'&&typeof value.expiresAt==='string'&&typeof value.csrfToken==='string'&&['member','administrator'].includes(String(value.role))&&['not_required','enrollment_required','challenge_required','verified'].includes(String(value.mfa)))return value as ServiceSession;
    throw new ServiceApiError('invalid_response','社区账号状态响应不正确。',true);
  }
  async getIdentityProvider(signal?:AbortSignal):Promise<IdentityProvider>{
    const value=await this.request<unknown>('/identity/provider',{signal});
    if(record(value)&&((value.provider==='cloudbase'&&value.emailVerification==='code')||(value.provider==='local'&&value.emailVerification==='link'))&&typeof value.configured==='boolean'&&Number.isInteger(value.passwordMinLength)&&Number.isInteger(value.passwordMaxLength)&&Number(value.passwordMinLength)>=1&&Number(value.passwordMaxLength)>=Number(value.passwordMinLength)&&Number(value.passwordMaxLength)<=256&&Number.isInteger(value.resendAfterSeconds)&&Number(value.resendAfterSeconds)>=0&&Number(value.resendAfterSeconds)<=3600)return value as IdentityProvider;
    throw new ServiceApiError('invalid_response','账号认证配置响应不正确。',true);
  }
  async sendEmailCode(email:string,purpose:'register'|'reset_password'|'login'):Promise<EmailCodeDelivery>{
    const value=await this.request<unknown>('/identity/email-code',{method:'POST',body:{email,purpose}});
    if(record(value)&&value.delivery==='not_configured')return {delivery:'not_configured',resendAfterSeconds:0};
    if(record(value)&&value.delivery==='sent'&&typeof value.verificationId==='string'&&value.verificationId.length>0&&value.verificationId.length<=2048&&typeof value.expiresAt==='string'&&Number.isFinite(Date.parse(value.expiresAt))&&Number.isInteger(value.resendAfterSeconds)&&Number(value.resendAfterSeconds)>=0&&Number(value.resendAfterSeconds)<=3600)return value as EmailCodeDelivery;
    throw new ServiceApiError('invalid_response','验证码发送结果无法确认，请稍后重试。',true);
  }
  async registerCloudBase(input:EmailCodeCredentials&{displayName?:string}){await this.request<unknown>('/identity/register',{method:'POST',body:input});const session=await this.getSession();if(session.kind!=='authenticated')throw new ServiceApiError('session_unavailable','注册已提交，但登录会话未能确认。请尝试登录。',true);sessionChanged();return session;}
  resetPasswordCloudBase(input:EmailCodeCredentials){return this.request<{reset:true}>('/identity/reset-password',{method:'POST',body:input});}
  register(input:{email:string;password:string;displayName?:string}){return this.request<DeliveryResult>('/identity/register',{method:'POST',body:input});}
  verifyEmail(token:string){return this.request<{verified:true}>('/identity/verify-email',{method:'POST',body:{token}});}
  async login(input:{email:string;password:string;code?:string;verificationId?:string}){await this.request<unknown>('/identity/login',{method:'POST',body:input});const session=await this.getSession();if(session.kind!=='authenticated')throw new ServiceApiError('session_unavailable','登录会话未能确认，请检查浏览器 Cookie 设置后重试。',true);sessionChanged();return session;}
  resendVerification(email:string){return this.request<DeliveryResult>('/identity/resend-verification',{method:'POST',body:{email}});}
  recover(email:string){return this.request<DeliveryResult>('/identity/recover',{method:'POST',body:{email}});}
  resetPassword(token:string,password:string){return this.request<{reset:true}>('/identity/reset-password',{method:'POST',body:{token,password}});}
  async signOut(){const result=await this.request<{signedOut:true}>('/me/sign-out',{method:'POST',authenticated:true});sessionChanged();return result;}
  async getProfile(signal?:AbortSignal):Promise<ServiceProfile>{
    const value=await this.request<unknown>('/me/profile',{signal});
    if(record(value)&&typeof value.accountId==='string'&&typeof value.displayName==='string'&&typeof value.bio==='string'&&Array.isArray(value.interests)&&value.interests.every(item=>typeof item==='string'))return value as ServiceProfile;
    throw new ServiceApiError('invalid_response','个人资料响应不正确。',true);
  }
  async updateProfile(input:Pick<ServiceProfile,'displayName'|'bio'|'interests'>&{avatarData?:string|null},accountId?:string){const profile=await this.request<ServiceProfile>('/me/profile',{method:'PUT',body:input,authenticated:true,accountScope:accountId,idempotencyKey:crypto.randomUUID()});sessionChanged();return profile;}
  getLearningStatistics(signal?:AbortSignal){return this.request<OwnLearningStatistics>('/me/learning-statistics',{signal});}
  updateLearningStatistics(input:LearningStatisticsPolicy,accountId:string){return this.request<OwnLearningStatistics>('/me/learning-statistics',{method:'PUT',body:input,authenticated:true,accountScope:accountId,idempotencyKey:crypto.randomUUID()});}
  enrollMfa(password:string){return this.request<MfaEnrollment>('/me/mfa/enroll',{method:'POST',body:{password},authenticated:true});}
  async confirmMfa(code:string){await this.request<unknown>('/me/mfa/confirm',{method:'POST',body:{code},authenticated:true});return this.getSession();}
  async challengeMfa(code:string){await this.request<unknown>('/me/mfa/challenge',{method:'POST',body:{code},authenticated:true});return this.getSession();}
}
export const serviceClient=new CommunityServiceClient(import.meta.env.VITE_COMMUNITY_API_URL);
export const serviceEnabled=()=>serviceClient.configured;
