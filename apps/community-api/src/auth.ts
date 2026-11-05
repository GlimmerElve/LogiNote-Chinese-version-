import {randomUUID} from 'node:crypto';
import type {Database,Sql} from './db.js';
import {ApiError,object,onlyKeys,requireValue,text} from './errors.js';
import {systemClock,type Actor,type Clock} from './types.js';
import {decryptMfaSecret,encryptMfaSecret,encryptionKey,hashPassword,isOpaqueToken,matchingTotpStep,newTotpSecret,opaqueToken,passwordWithinBounds,tokenHash,verifyPassword} from './security.js';

export interface AuthConfig {encryptionKey:string;issuer?:string;sessionTtlMs?:number;verificationTtlMs?:number;resetTtlMs?:number}
export interface MailMessage {to:string;purpose:'verify_email'|'reset_password';token:string;expiresAt:Date}
export interface Mailer {readonly configured:boolean;send(message:MailMessage):Promise<'sent'|'not_configured'>}
export interface AuthAccount {id:string;email:string;displayName:string;emailVerified:boolean}
export interface SessionView {actor:Actor;account:AuthAccount;csrfToken:string;expiresAt:string;mfa:'not_required'|'enrollment_required'|'challenge_required'|'verified'}
export interface AuthSession extends SessionView {sessionToken:string}
/** Constructed only from the configured provider's server-verified userinfo. */
export interface ExternalIdentity {provider:'cloudbase';environment:string;subject:string}
export interface VerifiedExternalPrincipal extends ExternalIdentity {email:string;emailVerified:true;displayName?:string}
type AccountRow={id:string;email:string;display_name:string;role:Actor['role'];auth_provider:'local'|'cloudbase';password_hash:string|null;email_verified_at:Date|null;login_failures:number;login_locked_until:Date|null};
type SessionRow={id:string;account_id:string;csrf_token:string;expires_at:Date;mfa_verified_until:Date|null};
type MfaRow={secret_ciphertext:string;enabled_at:Date|null;pending_expires_at:Date|null;last_used_step:string|null;failed_attempts:number;locked_until:Date|null};
type ActionToken={id:string;account_id:string;expires_at:Date;consumed_at:Date|null};
const MINUTE=60000,STEP_UP_MS=10*MINUTE,LOCK_MS=10*MINUTE,MAX_FAILURES=5;
const expired=(value:Date|null,now:Date)=>!value||new Date(value).getTime()<=now.getTime();
const failure=()=>new ApiError(401,'invalid_credentials','邮箱或密码不正确。');
const badToken=()=>new ApiError(400,'invalid_token','链接无效、已使用或已过期。');

function emailValue(value:unknown):string {
  const email=text(value,'邮箱',254).toLowerCase();
  requireValue(/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)&&email.split('@')[0].length<=64,400,'invalid_request','请输入有效邮箱。');return email;
}
function passwordValue(value:unknown):string {
  requireValue(passwordWithinBounds(value),400,'invalid_password','密码须为 12 至 128 个字符。');return value;
}
function codeValue(input:unknown):string {
  const value=object(input);onlyKeys(value,['code']);requireValue(typeof value.code==='string'&&/^\d{6}$/.test(value.code),400,'invalid_request','请输入六位验证码。');return value.code;
}
function duration(value:number|undefined,fallback:number):number {
  const resolved=value??fallback;if(!Number.isSafeInteger(resolved)||resolved<=0||resolved>366*86400000)throw new Error('Invalid authentication lifetime.');return resolved;
}

function externalPrincipal(value:VerifiedExternalPrincipal):VerifiedExternalPrincipal {
  const input=object(value);onlyKeys(input,['provider','environment','subject','email','emailVerified','displayName']);
  requireValue(input.provider==='cloudbase'&&typeof input.environment==='string'&&/^[a-zA-Z0-9_-]{1,128}$/.test(input.environment),400,'invalid_external_identity','外部认证环境无效。');
  requireValue(typeof input.subject==='string'&&input.subject.length>0&&input.subject.length<=256&&!/[\u0000-\u001f\u007f]/.test(input.subject),400,'invalid_external_identity','外部账号标识无效。');
  requireValue(input.emailVerified===true,403,'email_not_verified','请先在 CloudBase 完成邮箱验证。');
  requireValue(input.displayName===undefined||typeof input.displayName==='string'&&input.displayName.trim().length<=80,400,'invalid_request','昵称不能超过 80 个字符。');
  return {provider:'cloudbase',environment:input.environment,subject:input.subject,email:emailValue(input.email),emailVerified:true,...(typeof input.displayName==='string'?{displayName:input.displayName.trim()}:{} )};
}

export class AuthService {
  private readonly key:Buffer;
  private readonly issuer:string;
  private readonly sessionTtl:number;
  private readonly verificationTtl:number;
  private readonly resetTtl:number;
  constructor(private readonly db:Database,config:AuthConfig,private readonly mailer:Mailer,private readonly clock:Clock=systemClock){
    this.key=encryptionKey(config.encryptionKey);this.issuer=config.issuer||'LogiNote';
    this.sessionTtl=duration(config.sessionTtlMs,7*86400000);this.verificationTtl=duration(config.verificationTtlMs,24*60*MINUTE);this.resetTtl=duration(config.resetTtlMs,30*MINUTE);
  }
  private async issue(sql:Sql,accountId:string,purpose:MailMessage['purpose'],now:Date):Promise<{token:string;expiresAt:Date}> {
    const token=opaqueToken(),expiresAt=new Date(now.getTime()+(purpose==='verify_email'?this.verificationTtl:this.resetTtl));
    await sql.query('UPDATE auth_tokens SET consumed_at=$3 WHERE account_id=$1 AND purpose=$2 AND consumed_at IS NULL',[accountId,purpose,now]);
    await sql.query('INSERT INTO auth_tokens(id,account_id,token_hash,purpose,expires_at,created_at) VALUES($1,$2,$3,$4,$5,$6)',[randomUUID(),accountId,tokenHash(token),purpose,expiresAt,now]);
    return {token,expiresAt};
  }
  private async deliver(message:MailMessage):Promise<'sent'|'not_configured'> {
    if(!this.mailer.configured)return 'not_configured';
    try{return await this.mailer.send(message);}catch{throw new ApiError(503,'mail_unavailable','邮件暂时无法发送，请稍后重试。',true);}
  }
  private view(account:AccountRow,session:SessionRow,mfaEnabled:boolean,now:Date):SessionView {
    const verified=account.role==='administrator'&&!expired(session.mfa_verified_until,now);
    return {actor:{accountId:account.id,role:account.role,mfaVerified:verified},account:{id:account.id,email:account.email,displayName:account.display_name,emailVerified:!!account.email_verified_at},csrfToken:session.csrf_token,expiresAt:new Date(session.expires_at).toISOString(),mfa:account.role!=='administrator'?'not_required':verified?'verified':mfaEnabled?'challenge_required':'enrollment_required'};
  }
  private async session(sql:Sql,account:AccountRow,now:Date,expiresAt:Date):Promise<AuthSession> {
    const sessionToken=opaqueToken(),session:SessionRow={id:randomUUID(),account_id:account.id,csrf_token:opaqueToken(),expires_at:expiresAt,mfa_verified_until:null};
    await sql.query('INSERT INTO sessions(id,account_id,token_hash,csrf_token,expires_at,created_at) VALUES($1,$2,$3,$4,$5,$6)',[session.id,account.id,tokenHash(sessionToken),session.csrf_token,expiresAt,now]);
    const mfa=(await sql.query<{enabled_at:Date|null}>('SELECT enabled_at FROM account_mfa WHERE account_id=$1',[account.id])).rows[0];
    return {...this.view(account,session,!!mfa?.enabled_at,now),sessionToken};
  }
  /** Never links by email: provider + configured environment + subject is the identity. */
  async issueExternalSession(value:VerifiedExternalPrincipal,options:{expiresAt?:Date}={}):Promise<AuthSession> {
    const principal=externalPrincipal(value),now=this.clock();
    const requested=options.expiresAt?.getTime()??now.getTime()+this.sessionTtl;
    requireValue(Number.isFinite(requested)&&requested>now.getTime(),401,'external_session_expired','外部认证已过期，请重新登录。');
    const expiresAt=new Date(Math.min(requested,now.getTime()+this.sessionTtl));
    return this.db.transaction(async sql=>{
      const identityKey=JSON.stringify([principal.provider,principal.environment,principal.subject]);
      await sql.query("SELECT pg_advisory_xact_lock(hashtextextended(current_schema()||':external:'||$1,0))",[identityKey]);
      const found=(await sql.query<{account_id:string}>('SELECT account_id FROM external_identities WHERE provider=$1 AND environment=$2 AND subject=$3',[principal.provider,principal.environment,principal.subject])).rows[0];
      let account:AccountRow;
      if(found){
        account=(await sql.query<AccountRow>('SELECT * FROM accounts WHERE id=$1 FOR UPDATE',[found.account_id])).rows[0];
        requireValue(account?.auth_provider==='cloudbase',401,'external_identity_mismatch','外部账号关联无效。');
        // Keep the community nickname stable; identity contact changes remain provider controlled.
        await sql.query('UPDATE accounts SET email=$2,email_verified_at=COALESCE(email_verified_at,$3),updated_at=$3 WHERE id=$1',[account.id,principal.email,now]);
        account={...account,email:principal.email,email_verified_at:account.email_verified_at??now};
      }else{
        const accountId=randomUUID();
        account=(await sql.query<AccountRow>("INSERT INTO accounts(id,email,display_name,auth_provider,password_hash,email_verified_at,created_at,updated_at) VALUES($1,$2,$3,'cloudbase',NULL,$4,$4,$4) RETURNING *",[accountId,principal.email,principal.displayName||'新同学',now])).rows[0];
        await sql.query('INSERT INTO external_identities(id,account_id,provider,environment,subject,created_at) VALUES($1,$2,$3,$4,$5,$6)',[randomUUID(),accountId,principal.provider,principal.environment,principal.subject,now]);
      }
      return this.session(sql,account,now,expiresAt);
    });
  }
  async externalIdentity(sessionToken:string):Promise<ExternalIdentity|null> {
    return this.db.transaction(async sql=>{
      const {account}=await this.authenticated(sql,sessionToken,this.clock());
      if(account.auth_provider!=='cloudbase')return null;
      const identity=(await sql.query<ExternalIdentity>('SELECT provider,environment,subject FROM external_identities WHERE account_id=$1',[account.id])).rows[0];
      requireValue(identity,401,'external_identity_mismatch','外部账号关联无效。');return identity;
    });
  }
  /** Locks the account before session/token/MFA rows, consistently across mutations. */
  private async authenticated(sql:Sql,token:string,now:Date):Promise<{account:AccountRow;session:SessionRow}> {
    requireValue(isOpaqueToken(token),401,'unauthenticated','请先登录。');
    const candidate=(await sql.query<{account_id:string}>('SELECT account_id FROM sessions WHERE token_hash=$1',[tokenHash(token)])).rows[0];
    requireValue(candidate,401,'unauthenticated','会话无效或已过期。');
    const account=(await sql.query<AccountRow>('SELECT * FROM accounts WHERE id=$1 FOR UPDATE',[candidate.account_id])).rows[0];
    const session=(await sql.query<SessionRow>('SELECT * FROM sessions WHERE token_hash=$1 AND revoked_at IS NULL AND expires_at>$2 FOR UPDATE',[tokenHash(token),now])).rows[0];
    requireValue(account&&account.email_verified_at&&session,401,'unauthenticated','会话无效或已过期。');return {account,session};
  }
  async register(input:unknown):Promise<{account:AuthAccount;delivery:'sent'|'not_configured';expiresAt:string}> {
    const value=object(input);onlyKeys(value,['email','password','displayName']);
    const email=emailValue(value.email),password=passwordValue(value.password);
    requireValue(value.displayName===undefined||typeof value.displayName==='string'&&value.displayName.trim().length<=80,400,'invalid_request','昵称不能超过 80 个字符。');
    const displayName=typeof value.displayName==='string'&&value.displayName.trim()?value.displayName.trim():'新同学';
    const id=randomUUID(),now=this.clock(),passwordHash=await hashPassword(password);
    let issued:{token:string;expiresAt:Date};
    try{issued=await this.db.transaction(async sql=>{
      await sql.query('INSERT INTO accounts(id,email,display_name,password_hash,created_at,updated_at,password_changed_at) VALUES($1,$2,$3,$4,$5,$5,$5)',[id,email,displayName,passwordHash,now]);
      return this.issue(sql,id,'verify_email',now);
    });}catch(error){if((error as {code?:string}).code==='23505')throw new ApiError(409,'email_registered','此邮箱已注册，请登录或重新发送验证邮件。');throw error;}
    const delivery=await this.deliver({to:email,purpose:'verify_email',...issued});
    return {account:{id,email,displayName,emailVerified:false},delivery,expiresAt:issued.expiresAt.toISOString()};
  }
  private async actionAccount(sql:Sql,rawToken:string,purpose:MailMessage['purpose'],now:Date):Promise<{account:AccountRow;token:ActionToken}> {
    if(!isOpaqueToken(rawToken))throw badToken();
    const candidate=(await sql.query<ActionToken>('SELECT * FROM auth_tokens WHERE token_hash=$1 AND purpose=$2',[tokenHash(rawToken),purpose])).rows[0];
    if(!candidate)throw badToken();
    const account=(await sql.query<AccountRow>('SELECT * FROM accounts WHERE id=$1 FOR UPDATE',[candidate.account_id])).rows[0];
    const token=(await sql.query<ActionToken>('SELECT * FROM auth_tokens WHERE id=$1 FOR UPDATE',[candidate.id])).rows[0];
    if(!account||account.auth_provider!=='local'||!token||token.consumed_at||expired(token.expires_at,now))throw badToken();return {account,token};
  }
  async verifyEmail(input:unknown):Promise<{verified:true}> {
    const value=object(input);onlyKeys(value,['token']);const token=typeof value.token==='string'?value.token:'';const now=this.clock();
    await this.db.transaction(async sql=>{
      const found=await this.actionAccount(sql,token,'verify_email',now);
      await sql.query('UPDATE auth_tokens SET consumed_at=$2 WHERE id=$1',[found.token.id,now]);
      await sql.query('UPDATE accounts SET email_verified_at=COALESCE(email_verified_at,$2),updated_at=$2 WHERE id=$1',[found.account.id,now]);
    });return {verified:true};
  }
  private async requestMail(input:unknown,purpose:MailMessage['purpose']):Promise<{accepted:true;delivery:'accepted'|'not_configured'}> {
    const value=object(input);onlyKeys(value,['email']);const email=emailValue(value.email),now=this.clock();
    const issued=await this.db.transaction(async sql=>{
      const account=(await sql.query<AccountRow>("SELECT * FROM accounts WHERE email=$1 AND auth_provider='local' FOR UPDATE",[email])).rows[0];
      if(!account||(purpose==='verify_email'&&account.email_verified_at))return null;
      return this.issue(sql,account.id,purpose,now);
    });
    if(issued)await this.deliver({to:email,purpose,...issued});
    return {accepted:true,delivery:this.mailer.configured?'accepted':'not_configured'};
  }
  requestEmailVerification(input:unknown){return this.requestMail(input,'verify_email');}
  requestPasswordReset(input:unknown){return this.requestMail(input,'reset_password');}
  async login(input:unknown):Promise<AuthSession> {
    const value=object(input);onlyKeys(value,['email','password']);const email=emailValue(value.email);
    requireValue(typeof value.password==='string'&&value.password.length<=128&&Buffer.byteLength(value.password)<=512,400,'invalid_request','密码长度不正确。');
    const password=value.password,now=this.clock(),sessionToken=opaqueToken(),csrfToken=opaqueToken(),expiresAt=new Date(now.getTime()+this.sessionTtl);
    const result=await this.db.transaction(async sql=>{
      const account=(await sql.query<AccountRow>("SELECT * FROM accounts WHERE email=$1 AND auth_provider='local' FOR UPDATE",[email])).rows[0];
      const valid=await verifyPassword(password,account?.password_hash??undefined);
      if(!account)return {error:failure()};
      if(!expired(account.login_locked_until,now))return {error:failure()};
      if(!valid){
        const attempts=account.login_failures+1;
        await sql.query('UPDATE accounts SET login_failures=$2,login_locked_until=$3,updated_at=$4 WHERE id=$1',[account.id,attempts>=MAX_FAILURES?0:attempts,attempts>=MAX_FAILURES?new Date(now.getTime()+LOCK_MS):null,now]);
        return {error:failure()};
      }
      if(!account.email_verified_at)return {error:new ApiError(403,'email_not_verified','请先验证邮箱。')};
      await sql.query('UPDATE accounts SET login_failures=0,login_locked_until=NULL,updated_at=$2 WHERE id=$1',[account.id,now]);
      const session:SessionRow={id:randomUUID(),account_id:account.id,csrf_token:csrfToken,expires_at:expiresAt,mfa_verified_until:null};
      await sql.query('INSERT INTO sessions(id,account_id,token_hash,csrf_token,expires_at,created_at) VALUES($1,$2,$3,$4,$5,$6)',[session.id,account.id,tokenHash(sessionToken),csrfToken,expiresAt,now]);
      const mfa=(await sql.query<{enabled_at:Date|null}>('SELECT enabled_at FROM account_mfa WHERE account_id=$1',[account.id])).rows[0];
      return {view:this.view(account,session,!!mfa?.enabled_at,now)};
    });
    if(result.error)throw result.error;return {...result.view!,sessionToken};
  }
  async lookup(token:string|undefined):Promise<SessionView|null> {
    if(!isOpaqueToken(token))return null;const now=this.clock();
    const result=await this.db.query<AccountRow&SessionRow&{session_id:string;mfa_enabled_at:Date|null}>(`SELECT a.*,s.id AS session_id,s.account_id,s.csrf_token,s.expires_at,s.mfa_verified_until,m.enabled_at AS mfa_enabled_at FROM sessions s JOIN accounts a ON a.id=s.account_id LEFT JOIN account_mfa m ON m.account_id=a.id WHERE s.token_hash=$1 AND s.revoked_at IS NULL AND s.expires_at>$2 AND a.email_verified_at IS NOT NULL`,[tokenHash(token),now]);
    const row=result.rows[0];return row?this.view(row,{id:row.session_id,account_id:row.account_id,csrf_token:row.csrf_token,expires_at:row.expires_at,mfa_verified_until:row.mfa_verified_until},!!row.mfa_enabled_at,now):null;
  }
  async logout(token:string|undefined):Promise<void> {if(isOpaqueToken(token))await this.db.query('UPDATE sessions SET revoked_at=$2,mfa_verified_until=NULL WHERE token_hash=$1 AND revoked_at IS NULL',[tokenHash(token),this.clock()]);}
  async resetPassword(input:unknown):Promise<{reset:true}> {
    const value=object(input);onlyKeys(value,['token','password']);const token=typeof value.token==='string'?value.token:'',password=passwordValue(value.password),now=this.clock();
    if(!isOpaqueToken(token))throw badToken();const passwordHash=await hashPassword(password);
    await this.db.transaction(async sql=>{
      const found=await this.actionAccount(sql,token,'reset_password',now);
      await sql.query('UPDATE accounts SET password_hash=$2,password_changed_at=$3,updated_at=$3,login_failures=0,login_locked_until=NULL WHERE id=$1',[found.account.id,passwordHash,now]);
      await sql.query('UPDATE auth_tokens SET consumed_at=$2 WHERE account_id=$1 AND purpose=$3 AND consumed_at IS NULL',[found.account.id,now,'reset_password']);
      await sql.query('UPDATE sessions SET revoked_at=$2,mfa_verified_until=NULL WHERE account_id=$1 AND revoked_at IS NULL',[found.account.id,now]);
    });return {reset:true};
  }
  async enrollTotp(sessionToken:string,input:unknown):Promise<{secret:string;otpauthUri:string;expiresAt:string}> {
    const value=object(input);onlyKeys(value,['password']);requireValue(typeof value.password==='string'&&value.password.length<=128,400,'invalid_request','请输入当前密码。');const password=value.password,now=this.clock();
    return this.db.transaction(async sql=>{
      const {account}=await this.authenticated(sql,sessionToken,now);
      requireValue(account.role==='administrator',403,'forbidden','只有管理员可以设置管理验证。');
      requireValue(account.auth_provider==='local',403,'external_reauthentication_required','请通过 CloudBase 当前密码重新认证。');
      requireValue(await verifyPassword(password,account.password_hash??undefined),401,'invalid_credentials','当前密码不正确。');
      return this.beginTotpEnrollment(sql,account,now);
    });
  }
  /** The caller must have freshly authenticated this principal with the provider password. */
  async enrollExternalTotp(sessionToken:string,value:VerifiedExternalPrincipal):Promise<{secret:string;otpauthUri:string;expiresAt:string}> {
    const principal=externalPrincipal(value),now=this.clock();
    return this.db.transaction(async sql=>{
      const {account}=await this.authenticated(sql,sessionToken,now);
      requireValue(account.role==='administrator',403,'forbidden','只有管理员可以设置管理验证。');
      requireValue(account.auth_provider==='cloudbase',403,'external_identity_mismatch','外部账号关联不匹配。');
      const identity=(await sql.query<ExternalIdentity>('SELECT provider,environment,subject FROM external_identities WHERE account_id=$1',[account.id])).rows[0];
      requireValue(identity&&identity.provider===principal.provider&&identity.environment===principal.environment&&identity.subject===principal.subject,403,'external_identity_mismatch','请使用当前账号重新认证。');
      return this.beginTotpEnrollment(sql,account,now);
    });
  }
  private async beginTotpEnrollment(sql:Sql,account:AccountRow,now:Date):Promise<{secret:string;otpauthUri:string;expiresAt:string}> {
      const existing=(await sql.query<MfaRow>('SELECT * FROM account_mfa WHERE account_id=$1 FOR UPDATE',[account.id])).rows[0];
      requireValue(!existing?.enabled_at,409,'mfa_already_enabled','管理验证已启用。');
      const secret=newTotpSecret(),expiresAt=new Date(now.getTime()+STEP_UP_MS),encrypted=encryptMfaSecret(secret,this.key,account.id);
      await sql.query(`INSERT INTO account_mfa(account_id,secret_ciphertext,pending_expires_at,created_at,updated_at) VALUES($1,$2,$3,$4,$4) ON CONFLICT(account_id) DO UPDATE SET secret_ciphertext=EXCLUDED.secret_ciphertext,pending_expires_at=EXCLUDED.pending_expires_at,last_used_step=NULL,failed_attempts=0,locked_until=NULL,updated_at=EXCLUDED.updated_at`,[account.id,encrypted,expiresAt,now]);
      const label=encodeURIComponent(`${this.issuer}:${account.email}`),otpauthUri=`otpauth://totp/${label}?secret=${secret}&issuer=${encodeURIComponent(this.issuer)}&algorithm=SHA1&digits=6&period=30`;
      return {secret,otpauthUri,expiresAt:expiresAt.toISOString()};
  }
  private async verifyTotp(sessionToken:string,input:unknown,enrollment:boolean):Promise<SessionView> {
    const code=codeValue(input),now=this.clock();
    const outcome=await this.db.transaction(async sql=>{
      const {account,session}=await this.authenticated(sql,sessionToken,now);
      requireValue(account.role==='administrator',403,'forbidden','只有管理员可以进行管理验证。');
      const mfa=(await sql.query<MfaRow>('SELECT * FROM account_mfa WHERE account_id=$1 FOR UPDATE',[account.id])).rows[0];
      requireValue(mfa,409,'mfa_not_enrolled','请先设置管理验证。');
      requireValue(enrollment?!mfa.enabled_at:!!mfa.enabled_at,409,enrollment?'mfa_already_enabled':'mfa_not_enabled',enrollment?'管理验证已启用。':'请先确认管理验证设置。');
      if(enrollment&&expired(mfa.pending_expires_at,now))throw new ApiError(400,'mfa_enrollment_expired','设置已过期，请重新开始。');
      if(!expired(mfa.locked_until,now))return {error:new ApiError(429,'mfa_rate_limited','验证码尝试过多，请稍后重试。',true)};
      let secret:string;try{secret=decryptMfaSecret(mfa.secret_ciphertext,this.key,account.id);}catch{throw new ApiError(503,'mfa_unavailable','管理验证暂不可用。',true);}
      const matched=matchingTotpStep(secret,code,now,mfa.last_used_step===null?null:BigInt(mfa.last_used_step));
      if(matched===null){
        const failures=mfa.failed_attempts+1;
        await sql.query('UPDATE account_mfa SET failed_attempts=$2,locked_until=$3,updated_at=$4 WHERE account_id=$1',[account.id,failures>=MAX_FAILURES?0:failures,failures>=MAX_FAILURES?new Date(now.getTime()+LOCK_MS):null,now]);
        return {error:new ApiError(401,'invalid_mfa_code','验证码无效或已使用。')};
      }
      await sql.query('UPDATE account_mfa SET enabled_at=COALESCE(enabled_at,$2),pending_expires_at=NULL,last_used_step=$3,failed_attempts=0,locked_until=NULL,updated_at=$2 WHERE account_id=$1',[account.id,now,matched.toString()]);
      const until=new Date(Math.min(now.getTime()+STEP_UP_MS,new Date(session.expires_at).getTime()));
      await sql.query('UPDATE sessions SET mfa_verified_until=$2 WHERE id=$1',[session.id,until]);
      return {view:this.view(account,{...session,mfa_verified_until:until},true,now)};
    });
    if(outcome.error)throw outcome.error;return outcome.view!;
  }
  confirmTotp(sessionToken:string,input:unknown){return this.verifyTotp(sessionToken,input,true);}
  challengeTotp(sessionToken:string,input:unknown){return this.verifyTotp(sessionToken,input,false);}
}
