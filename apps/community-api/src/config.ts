import path from 'node:path';
import { ApiError } from './errors.js';
export interface ApiConfig {
  databaseUrl:string;host:string;port:number;webOrigin:string;allowedOrigins:string[];encryptionKey:string;secureCookies:boolean;dataDirectory:string;globalStorageLimitBytes:number;globalDownloadLimitBytes?:number;
  authProvider?:'cloudbase'|'local';
  cloudbase?:{environment:string;region:string};
  newsDnsMode?:'system'|'alidns';
  smtp?:{host:string;port:number;secure:boolean;user:string;password:string;from:string};
}
function origin(value:string){const url=new URL(value);if(url.username||url.password||url.origin!==value||(!['https:'].includes(url.protocol)&&!(url.protocol==='http:'&&['127.0.0.1','localhost','[::1]'].includes(url.hostname))))throw Error('Community origins require HTTPS or loopback HTTP');return url.origin;}
export function readConfig(env:NodeJS.ProcessEnv=process.env):ApiConfig {
  if(!env.COMMUNITY_DATABASE_URL)throw new ApiError(503,'not_configured','社区数据库尚未配置。');
  const databaseUrl=new URL(env.COMMUNITY_DATABASE_URL);if(!['postgres:','postgresql:'].includes(databaseUrl.protocol))throw Error('Community database must use PostgreSQL');
  const encryptionKey=env.COMMUNITY_ENCRYPTION_KEY||'';if(Buffer.from(encryptionKey,'base64url').length!==32)throw Error('COMMUNITY_ENCRYPTION_KEY must encode exactly 32 random bytes');
  const webOrigin=origin(env.COMMUNITY_WEB_ORIGIN||'http://127.0.0.1:5174');
  const allowedOrigins=[...new Set([webOrigin,...(env.COMMUNITY_ALLOWED_ORIGINS||'').split(',').map(value=>value.trim()).filter(Boolean).map(origin)])];
  const port=Number(env.COMMUNITY_PORT||5180);if(!Number.isInteger(port)||port<0||port>65535)throw Error('Invalid community API port');
  const secureCookies=env.NODE_ENV==='production'||webOrigin.startsWith('https:');
  if(env.NODE_ENV==='production'&&!webOrigin.startsWith('https:'))throw Error('Production community requires HTTPS');
  const authProvider=env.COMMUNITY_AUTH_PROVIDER||'cloudbase';
  if(!['cloudbase','local'].includes(authProvider))throw Error('Invalid community authentication provider');
  const environment=env.COMMUNITY_CLOUDBASE_ENV_ID?.trim()||'';
  if(environment&&!/^[a-z0-9][a-z0-9-]{0,126}$/.test(environment))throw Error('Invalid CloudBase environment identifier');
  const region=env.COMMUNITY_CLOUDBASE_REGION||'ap-shanghai';
  if(!/^ap-[a-z]+(?:-[a-z]+)?$/.test(region))throw Error('Invalid CloudBase region');
  const cloudbase=environment?{environment,region}:undefined;
  const smtp=env.COMMUNITY_SMTP_HOST?{host:env.COMMUNITY_SMTP_HOST,port:Number(env.COMMUNITY_SMTP_PORT||587),secure:env.COMMUNITY_SMTP_SECURE==='true',user:env.COMMUNITY_SMTP_USER||'',password:env.COMMUNITY_SMTP_PASSWORD||'',from:env.COMMUNITY_SMTP_FROM||''}:undefined;
  if(smtp&&(!Number.isInteger(smtp.port)||smtp.port<1||smtp.port>65535||!smtp.from))throw Error('Incomplete SMTP configuration');
  const globalStorageLimitBytes=Number(env.COMMUNITY_GLOBAL_STORAGE_LIMIT_BYTES||0);
  if(!Number.isSafeInteger(globalStorageLimitBytes)||globalStorageLimitBytes<0)throw Error('Invalid community storage budget');
  const globalDownloadLimitBytes=Number(env.COMMUNITY_MONTHLY_DOWNLOAD_LIMIT_BYTES||0);
  if(!Number.isSafeInteger(globalDownloadLimitBytes)||globalDownloadLimitBytes<0)throw Error('Invalid community download budget');
  const newsDnsMode=env.COMMUNITY_RSS_DNS||'system';if(!['system','alidns'].includes(newsDnsMode))throw Error('Invalid RSS DNS mode');
  return {databaseUrl:databaseUrl.href,host:env.COMMUNITY_HOST||'127.0.0.1',port,webOrigin,allowedOrigins,encryptionKey,secureCookies,dataDirectory:path.resolve(env.COMMUNITY_DATA_DIRECTORY||'.data'),globalStorageLimitBytes,globalDownloadLimitBytes,smtp,authProvider:authProvider as 'cloudbase'|'local',cloudbase,newsDnsMode:newsDnsMode as 'system'|'alidns'};
}
