import {createCipheriv,createDecipheriv,randomBytes} from 'node:crypto';
import {AuthService,type AuthSession,type VerifiedExternalPrincipal} from './auth.js';
import type {Database} from './db.js';
import {ApiError,object,onlyKeys,requireValue,text} from './errors.js';
import {encryptionKey,isOpaqueToken,opaqueToken,passwordWithinBounds,tokenHash} from './security.js';
import {RateLimiter} from './operations.js';
import {systemClock,type Clock} from './types.js';

export interface HostedTokens {accessToken:string;refreshToken:string;expiresIn:number;subject?:string}
export interface HostedPrincipal {subject:string;email?:string;emailVerified?:boolean;displayName?:string}
export interface HostedProvider {
  readonly configured:boolean;readonly environment:string;
  sendEmailCode(email:string,purpose:'register'|'reset_password'|'login'):Promise<{verificationId:string;expiresIn:number}>;
  verifyCode(verificationId:string,code:string):Promise<{verificationToken:string}>;
  register(input:{email:string;password:string;name?:string;verificationToken:string}):Promise<HostedTokens>;
  signIn(email:string,password:string):Promise<HostedTokens>;
  resetPassword(input:{email:string;password:string;verificationToken:string}):Promise<void>;
  refresh(refreshToken:string):Promise<HostedTokens>;
  userInfo(accessToken:string):Promise<HostedPrincipal>;
  signOut(accessToken:string):Promise<void>;
}
type Credentials={accessToken:string;refreshToken:string};
type ProviderSession={session_id:string;environment:string;subject:string;credentials_ciphertext:string;access_expires_at:Date;identity_verified_at:Date|null;identity_verified_email:string|null};
const DAY=86400000;
const IDENTITY_WINDOW_MS=60_000,REFRESH_EARLY_MS=30_000;
function emailValue(value:unknown){const email=text(value,'邮箱',254).toLowerCase();requireValue(/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)&&email.split('@')[0].length<=64,400,'invalid_request','请输入有效邮箱。');return email;}
function passwordValue(value:unknown){requireValue(passwordWithinBounds(value)&&value.length<=64,400,'invalid_password','密码须为 12 至 64 个字符。');return value;}
const codeFailure=()=>new ApiError(400,'invalid_verification_code','验证码无效、已使用或已过期，请重新获取。');

/** Server-only bridge: CloudBase authenticates, the community assigns roles and stores its own cookie. */
export class HostedAuthService {
  private readonly key:Buffer;
  private readonly rates:RateLimiter;
  private readonly lookups=new Map<string,Promise<unknown>>();
  constructor(private readonly db:Database,private readonly local:AuthService,private readonly provider:HostedProvider,key:string,private readonly clock:Clock=systemClock){this.key=encryptionKey(key);this.rates=new RateLimiter(db,clock);}
  metadata(){return {provider:'cloudbase' as const,configured:this.provider.configured,emailVerification:'code' as const,passwordMinLength:12,passwordMaxLength:64,resendAfterSeconds:60};}
  private ready(){requireValue(this.provider.configured,503,'auth_not_configured','CloudBase 账号服务尚未配置。');}
  private seal(credentials:Credentials,sessionId:string){
    const iv=randomBytes(12),cipher=createCipheriv('aes-256-gcm',this.key,iv);cipher.setAAD(Buffer.from(`community-cloudbase:${sessionId}:v1`));
    const data=Buffer.concat([cipher.update(JSON.stringify(credentials),'utf8'),cipher.final()]);
    return `v1.${iv.toString('base64url')}.${data.toString('base64url')}.${cipher.getAuthTag().toString('base64url')}`;
  }
  private open(envelope:string,sessionId:string):Credentials {
    try{
      const [version,iv,data,tag,...extra]=envelope.split('.');if(version!=='v1'||extra.length)throw Error();
      const nonce=Buffer.from(iv,'base64url'),body=Buffer.from(data,'base64url'),authTag=Buffer.from(tag,'base64url');if(nonce.length!==12||authTag.length!==16||body.length>65536)throw Error();
      const decipher=createDecipheriv('aes-256-gcm',this.key,nonce);decipher.setAAD(Buffer.from(`community-cloudbase:${sessionId}:v1`));decipher.setAuthTag(authTag);
      const value=JSON.parse(Buffer.concat([decipher.update(body),decipher.final()]).toString('utf8'));
      if(typeof value.accessToken!=='string'||!value.accessToken||typeof value.refreshToken!=='string'||!value.refreshToken)throw Error();return value;
    }catch{throw new ApiError(503,'auth_session_unavailable','登录状态暂时无法读取，请重新登录。');}
  }
  private expiry(tokens:HostedTokens){requireValue(Number.isInteger(tokens.expiresIn)&&tokens.expiresIn>0&&tokens.expiresIn<=366*86400&&typeof tokens.accessToken==='string'&&tokens.accessToken.length>0&&tokens.accessToken.length<=24000&&typeof tokens.refreshToken==='string'&&tokens.refreshToken.length>0&&tokens.refreshToken.length<=24000,502,'auth_response_invalid','账号服务返回了无效响应。');return new Date(this.clock().getTime()+tokens.expiresIn*1000);}
  private principal(value:HostedPrincipal,verifiedEmail?:string):VerifiedExternalPrincipal {
    requireValue(value.emailVerified!==false,403,'email_not_verified','请先在 CloudBase 验证邮箱。');
    requireValue(!!value.email&&((value.emailVerified===true)||(value.emailVerified===undefined&&verifiedEmail===value.email.toLowerCase())),403,'email_verification_required','请验证邮箱后继续登录。');
    return {provider:'cloudbase',environment:this.provider.environment,subject:value.subject,email:emailValue(value.email),emailVerified:true,...(value.displayName?{displayName:value.displayName}:{})};
  }
  private async previouslyVerifiedEmail(value:HostedPrincipal){
    if(!value.email||value.emailVerified!==undefined)return undefined;
    const row=(await this.db.query<{email:string}>(`SELECT a.email FROM external_identities e JOIN accounts a ON a.id=e.account_id WHERE e.provider='cloudbase' AND e.environment=$1 AND e.subject=$2 AND a.email_verified_at IS NOT NULL`,[this.provider.environment,value.subject])).rows[0];
    return row?.email===value.email.toLowerCase()?row.email:undefined;
  }
  private async issue(tokens:HostedTokens,email:string,hasEmailProof=false):Promise<AuthSession>{
    const accessExpiry=this.expiry(tokens),verifiedAt=this.clock(),info=await this.provider.userInfo(tokens.accessToken);
    requireValue(tokens.subject===undefined||tokens.subject===info.subject,401,'external_identity_mismatch','账号服务返回的身份不匹配。');
    requireValue(info.email?.toLowerCase()===email,401,'external_identity_mismatch','账号服务返回的邮箱与本次登录不匹配。');
    const principal=this.principal(info,hasEmailProof?email:await this.previouslyVerifiedEmail(info));
    const session=await this.local.issueExternalSession(principal,{expiresAt:new Date(this.clock().getTime()+7*DAY)});
    try{
      const row=(await this.db.query<{id:string}>('SELECT id FROM sessions WHERE token_hash=$1 AND revoked_at IS NULL',[tokenHash(session.sessionToken)])).rows[0];
      requireValue(row,401,'unauthenticated','请重新登录。');
      await this.db.query('INSERT INTO hosted_sessions(session_id,environment,subject,credentials_ciphertext,access_expires_at,updated_at,identity_verified_at,identity_verified_email) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',[row.id,principal.environment,principal.subject,this.seal(tokens,row.id),accessExpiry,this.clock(),verifiedAt,principal.email]);
      return session;
    }catch(error){await this.local.logout(session.sessionToken);throw error;}
  }
  async sendEmailCode(input:unknown){
    this.ready();const value=object(input);onlyKeys(value,['email','purpose']);const email=emailValue(value.email);
    requireValue(value.purpose==='register'||value.purpose==='reset_password'||value.purpose==='login',400,'invalid_request','验证码用途不正确。');
    await this.rates.consume(`email-code:${this.provider.environment}:${tokenHash(email)}`,1,60000);
    const sent=await this.provider.sendEmailCode(email,value.purpose),now=this.clock(),verificationId=opaqueToken();
    requireValue(!!sent.verificationId&&sent.verificationId.length<=2048&&Number.isInteger(sent.expiresIn)&&sent.expiresIn>0,502,'auth_response_invalid','账号服务返回了无效响应。');
    const expiresAt=new Date(now.getTime()+Math.min(sent.expiresIn,600)*1000);
    await this.db.transaction(async sql=>{
      await sql.query('UPDATE hosted_email_challenges SET consumed_at=$3 WHERE email=$1 AND purpose=$2 AND consumed_at IS NULL',[email,value.purpose,now]);
      await sql.query('INSERT INTO hosted_email_challenges(token_hash,email,purpose,verification_id,expires_at,created_at) VALUES($1,$2,$3,$4,$5,$6)',[tokenHash(verificationId),email,value.purpose,sent.verificationId,expiresAt,now]);
    });
    return {delivery:'sent' as const,verificationId,expiresAt:expiresAt.toISOString(),resendAfterSeconds:60};
  }
  private async verification(email:string,purpose:'register'|'reset_password'|'login',value:Record<string,unknown>){
    if(!isOpaqueToken(value.verificationId)||typeof value.code!=='string'||!/^\d{6}$/.test(value.code))throw codeFailure();
    const hash=tokenHash(value.verificationId),code=value.code;
    const outcome=await this.db.transaction(async sql=>{
      const row=(await sql.query<{email:string;purpose:string;verification_id:string;expires_at:Date;attempts:number;consumed_at:Date|null}>('SELECT * FROM hosted_email_challenges WHERE token_hash=$1 FOR UPDATE',[hash])).rows[0];
      if(!row||row.email!==email||row.purpose!==purpose||row.consumed_at||new Date(row.expires_at).getTime()<=this.clock().getTime()||row.attempts>=5)return {error:codeFailure()};
      await sql.query('UPDATE hosted_email_challenges SET attempts=attempts+1 WHERE token_hash=$1',[hash]);
      try{
        const result=await this.provider.verifyCode(row.verification_id,code);
        await sql.query('UPDATE hosted_email_challenges SET consumed_at=$2 WHERE token_hash=$1',[hash,this.clock()]);
        return {verificationToken:result.verificationToken};
      }catch(error){return {error};}
    });
    if(outcome.error)throw outcome.error;return outcome.verificationToken!;
  }
  async register(input:unknown){
    this.ready();const value=object(input);onlyKeys(value,['email','password','displayName','code','verificationId']);const email=emailValue(value.email),password=passwordValue(value.password);
    requireValue(value.displayName===undefined||typeof value.displayName==='string'&&value.displayName.trim().length<=80,400,'invalid_request','昵称不能超过 80 个字符。');
    const verificationToken=await this.verification(email,'register',value);
    const tokens=await this.provider.register({email,password,verificationToken,...(typeof value.displayName==='string'&&value.displayName.trim()?{name:value.displayName.trim()}:{})});
    try{return await this.issue(tokens,email,true);}
    catch(error){await this.provider.signOut(tokens.accessToken).catch(()=>{});throw error;}
  }
  async login(input:unknown){
    this.ready();const value=object(input);onlyKeys(value,['email','password','code','verificationId']);const email=emailValue(value.email);
    requireValue(typeof value.password==='string'&&value.password.length>0&&value.password.length<=128&&Buffer.byteLength(value.password)<=512,400,'invalid_request','请输入有效密码。');
    const tokens=await this.provider.signIn(email,value.password);
    try{
      let proof=false;
      if(value.code!==undefined||value.verificationId!==undefined){await this.verification(email,'login',value);proof=true;}
      return await this.issue(tokens,email,proof);
    }catch(error){await this.provider.signOut(tokens.accessToken).catch(()=>{});throw error;}
  }
  async lookup(token:string|undefined,options:{requireFresh?:boolean}={}){
    if(!isOpaqueToken(token))return null;
    // A sensitive request must not join a lookup allowed to reuse verification.
    const key=tokenHash(token)+(options.requireFresh?':fresh':':ordinary'),existing=this.lookups.get(key);
    if(existing){const verified=await existing;return verified?this.local.lookup(token):null;}
    const pending=this.lookupOnce(token,!!options.requireFresh);this.lookups.set(key,pending);
    try{return await pending;}finally{if(this.lookups.get(key)===pending)this.lookups.delete(key);}
  }
  private async lookupOnce(token:string|undefined,requireFresh:boolean){
    if(!isOpaqueToken(token))return null;
    const view=await this.local.lookup(token);if(!view)return null;
    const identity=await this.local.externalIdentity(token);if(!identity||identity.environment!==this.provider.environment)return null;
    this.ready();
    const outcome=await this.db.transaction(async sql=>{
      const row=(await sql.query<ProviderSession>(`SELECT h.* FROM hosted_sessions h JOIN sessions s ON s.id=h.session_id WHERE s.token_hash=$1 AND s.revoked_at IS NULL AND s.expires_at>$2 FOR UPDATE OF h`,[tokenHash(token),this.clock()])).rows[0];
      if(!row||row.environment!==identity.environment||row.subject!==identity.subject)return {invalid:true};
      try{
        let credentials=this.open(row.credentials_ciphertext,row.session_id);
        const now=this.clock(),verifiedAt=row.identity_verified_at?new Date(row.identity_verified_at).getTime():NaN;
        const refreshDue=new Date(row.access_expires_at).getTime()<=now.getTime()+REFRESH_EARLY_MS;
        // The row lock shares this bounded window across server processes. Never
        // reuse roles, MFA, membership, restrictions or a revoked local session.
        if(!requireFresh&&view.actor.role!=='administrator'&&!refreshDue&&row.identity_verified_email===view.account.email&&verifiedAt<=now.getTime()&&now.getTime()-verifiedAt<IDENTITY_WINDOW_MS)return {invalid:false};
        const verificationStarted=now;
        if(refreshDue){
          const refreshed=await this.provider.refresh(credentials.refreshToken),expiry=this.expiry(refreshed);credentials=refreshed;
          requireValue(refreshed.subject===undefined||refreshed.subject===identity.subject,401,'external_identity_mismatch','账号服务返回的身份不匹配。');
          await sql.query('UPDATE hosted_sessions SET credentials_ciphertext=$2,access_expires_at=$3,updated_at=$4 WHERE session_id=$1',[row.session_id,this.seal(credentials,row.session_id),expiry,this.clock()]);
        }
        const principal=this.principal(await this.provider.userInfo(credentials.accessToken),view.account.email);
        if(principal.subject!==identity.subject||principal.environment!==identity.environment||principal.email!==view.account.email){
          await sql.query('UPDATE hosted_sessions SET identity_verified_at=NULL,identity_verified_email=NULL WHERE session_id=$1',[row.session_id]);
          return {invalid:true};
        }
        await sql.query('UPDATE hosted_sessions SET identity_verified_at=$2,identity_verified_email=$3 WHERE session_id=$1',[row.session_id,verificationStarted,principal.email]);
        return {invalid:false};
      }catch(error){
        // An error cannot extend or revive a previous successful window, even
        // when a sensitive request revalidates before its normal expiry.
        await sql.query('UPDATE hosted_sessions SET identity_verified_at=NULL,identity_verified_email=NULL WHERE session_id=$1',[row.session_id]);
        if(error instanceof ApiError&&[401,403].includes(error.status))return {invalid:true};
        // A refresh token may already have rotated remotely. Commit its encrypted
        // replacement even when the following profile check is temporarily down.
        return {error};
      }
    });
    if(outcome.error)throw outcome.error;
    if(outcome.invalid){await this.logout(token);return null;}return this.local.lookup(token);
  }
  async logout(token:string|undefined){
    if(!isOpaqueToken(token))return;
    // Revoke the community session even if the upstream is temporarily unavailable.
    await this.local.logout(token);
    const row=(await this.db.query<ProviderSession>('DELETE FROM hosted_sessions WHERE session_id IN (SELECT id FROM sessions WHERE token_hash=$1) RETURNING *',[tokenHash(token)])).rows[0];
    if(row){try{await this.provider.signOut(this.open(row.credentials_ciphertext,row.session_id).accessToken);}catch{/* Cookie and community access are already revoked. */}}
  }
  async resetPassword(input:unknown){
    this.ready();const value=object(input);onlyKeys(value,['email','password','code','verificationId']);const email=emailValue(value.email),password=passwordValue(value.password);
    const verificationToken=await this.verification(email,'reset_password',value);
    // The CloudBase code proves this mailbox. Revoke before the remote password write:
    // even if a following network call fails, old community sessions cannot stay active.
    // This never associates accounts or grants access by email.
    await this.db.transaction(async sql=>{
      const accounts=await sql.query<{id:string}>(`SELECT a.id FROM accounts a JOIN external_identities e ON e.account_id=a.id WHERE e.provider='cloudbase' AND e.environment=$1 AND a.email=$2 AND a.email_verified_at IS NOT NULL ORDER BY a.id FOR UPDATE OF a`,[this.provider.environment,email]);
      for(const account of accounts.rows){
        await sql.query('UPDATE sessions SET revoked_at=$2,mfa_verified_until=NULL WHERE account_id=$1 AND revoked_at IS NULL',[account.id,this.clock()]);
        await sql.query('DELETE FROM hosted_sessions WHERE session_id IN (SELECT id FROM sessions WHERE account_id=$1)',[account.id]);
      }
    });
    await this.provider.resetPassword({email,password,verificationToken});
    return {reset:true as const};
  }
  async enrollTotp(token:string,input:unknown){
    const value=object(input);onlyKeys(value,['password']);requireValue(typeof value.password==='string'&&value.password.length>0&&value.password.length<=128,400,'invalid_request','请输入当前密码。');
    const view=await this.lookup(token);requireValue(view&&view.actor.role==='administrator',403,'forbidden','只有管理员可以设置管理验证。');
    const tokens=await this.provider.signIn(view.account.email,value.password);
    try{return await this.local.enrollExternalTotp(token,this.principal(await this.provider.userInfo(tokens.accessToken),view.account.email));}
    finally{await this.provider.signOut(tokens.accessToken).catch(()=>{});}
  }
  confirmTotp(token:string,input:unknown){return this.local.confirmTotp(token,input);}
  challengeTotp(token:string,input:unknown){return this.local.challengeTotp(token,input);}
}
