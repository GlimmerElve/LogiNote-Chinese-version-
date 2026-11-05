import {createHash,randomUUID} from 'node:crypto';
import type {Database,Sql} from './db.js';
import {ApiError,requireValue,text} from './errors.js';
import {systemClock,type Actor,type Clock} from './types.js';
import {MAX_RESOURCE_FILE_BYTES,MAX_ACCOUNT_STORAGE_BYTES,FILE_TOO_LARGE_MESSAGE} from './uploadLimits.js';
export {MAX_ACCOUNT_STORAGE_BYTES} from './uploadLimits.js';

/** Stable JSON makes object key order irrelevant to retry matching. */
export function canonicalJson(value:unknown):string {
  const seen=new Set<object>();
  const normalize=(item:unknown):unknown=>{
    if(item===null||typeof item==='string'||typeof item==='boolean')return item;
    if(typeof item==='number'){requireValue(Number.isFinite(item),400,'invalid_request','JSON 数值必须有限。');return item;}
    if(item instanceof Date){requireValue(Number.isFinite(item.getTime()),400,'invalid_request','日期无效。');return item.toISOString();}
    requireValue(!!item&&typeof item==='object',400,'invalid_request','请求必须是可序列化的 JSON。');
    requireValue(!seen.has(item),400,'invalid_request','JSON 不能包含循环引用。');seen.add(item);
    let normalized:unknown;
    if(Array.isArray(item))normalized=item.map(normalize);
    else{
      requireValue(Object.getPrototypeOf(item)===Object.prototype||Object.getPrototypeOf(item)===null,400,'invalid_request','请求必须是普通 JSON 对象。');
      const record:Record<string,unknown>=Object.create(null);
      for(const key of Object.keys(item).sort())record[key]=normalize((item as Record<string,unknown>)[key]);
      normalized=record;
    }
    seen.delete(item);return normalized;
  };
  const encoded=JSON.stringify(normalize(value));
  requireValue(Buffer.byteLength(encoded,'utf8')<=1_000_000,413,'payload_too_large','请求内容过大。');return encoded;
}
export const payloadFingerprint=(value:unknown)=>createHash('sha256').update(canonicalJson(value),'utf8').digest('hex');
const timestamp=(value:Date|string)=>new Date(value).toISOString();
const duration=(value:number,max=86_400_000)=>requireValue(Number.isSafeInteger(value)&&value>0&&value<=max,400,'invalid_request','时间范围不正确。');

/** Work and its replay result commit together; work must use the supplied transaction. */
export async function runIdempotent<T>(db:Database,actorId:string,key:string,operation:string,payload:unknown,work:(sql:Sql)=>Promise<T>):Promise<T>{
  key=text(key,'幂等键',200);operation=text(operation,'操作名称',120);const fingerprint=payloadFingerprint(payload);
  return db.transaction(async sql=>{
    await sql.query("SELECT pg_advisory_xact_lock(hashtextextended(current_schema() || ':idempotency:' || $1 || ':' || $2,0))",[actorId,key]);
    const existing=await sql.query<{operation:string;payload_hash:string;result:T}>('SELECT operation,payload_hash,result FROM idempotency_results WHERE actor_id=$1 AND idempotency_key=$2',[actorId,key]);
    if(existing.rows[0]){
      requireValue(existing.rows[0].operation===operation&&existing.rows[0].payload_hash===fingerprint,409,'idempotency_conflict','同一个幂等键不能用于不同请求。');return existing.rows[0].result;
    }
    const encoded=canonicalJson(await work(sql));
    await sql.query('INSERT INTO idempotency_results(actor_id,idempotency_key,operation,payload_hash,result) VALUES($1,$2,$3,$4,$5::jsonb)',[actorId,key,operation,fingerprint,encoded]);
    return JSON.parse(encoded) as T;
  });
}

export class RateLimiter {
  constructor(private readonly db:Database,private readonly clock:Clock=systemClock){}
  async consume(bucket:string,limit:number,windowMs:number,cost=1):Promise<{remaining:number;resetAt:string}>{
    bucket=text(bucket,'限流范围',240);duration(windowMs);
    requireValue(Number.isSafeInteger(limit)&&limit>0&&limit<=1_000_000&&Number.isSafeInteger(cost)&&cost>0&&cost<=limit,400,'invalid_request','限流参数不正确。');
    const now=this.clock(),reset=new Date(now.getTime()+windowMs);
    const result=await this.db.query<{used:number;reset_at:Date}>(`INSERT INTO rate_limits(bucket,used,reset_at) VALUES($1,$2,$3)
      ON CONFLICT(bucket) DO UPDATE SET used=CASE WHEN rate_limits.reset_at<=$4 THEN EXCLUDED.used ELSE rate_limits.used+EXCLUDED.used END,
      reset_at=CASE WHEN rate_limits.reset_at<=$4 THEN EXCLUDED.reset_at ELSE rate_limits.reset_at END
      WHERE rate_limits.reset_at<=$4 OR rate_limits.used+EXCLUDED.used<=$5 RETURNING used,reset_at`,[bucket,cost,reset,now,limit]);
    if(!result.rows[0]){
      const current=(await this.db.query<{reset_at:Date}>('SELECT reset_at FROM rate_limits WHERE bucket=$1',[bucket])).rows[0];
      const seconds=Math.max(1,Math.min(86400,Math.ceil(((current?new Date(current.reset_at).getTime():reset.getTime())-now.getTime())/1000)));
      throw new ApiError(429,'rate_limited',`操作过于频繁，请在 ${seconds} 秒后重试。`,true,seconds,'community');
    }
    return {remaining:limit-result.rows[0].used,resetAt:timestamp(result.rows[0].reset_at)};
  }
}

export const MAX_FILE_BYTES=MAX_RESOURCE_FILE_BYTES;
export interface StorageReservation {id:string;bytes:number;state:'reserved'|'committed'|'released';expiresAt:string}
interface ReservationRow {id:string;account_id:string;bytes:string;state:StorageReservation['state'];expires_at:Date}
const reservation=(row:ReservationRow):StorageReservation=>({id:row.id,bytes:Number(row.bytes),state:row.state,expiresAt:timestamp(row.expires_at)});
export class QuotaService {
  private readonly ttl:number;
  constructor(private readonly db:Database,private readonly options:{globalLimitBytes:number;reservationTtlMs?:number},private readonly clock:Clock=systemClock){
    requireValue(Number.isSafeInteger(options.globalLimitBytes)&&options.globalLimitBytes>=0,500,'invalid_configuration','全站存储额度未正确配置。');
    this.ttl=options.reservationTtlMs??15*60_000;duration(this.ttl);
  }
  private lock(sql:Sql){return sql.query("SELECT pg_advisory_xact_lock(hashtextextended(current_schema() || ':storage-quota',0))");}
  private within<T>(sql:Sql|undefined,work:(transaction:Sql)=>Promise<T>):Promise<T>{return sql?work(sql):this.db.transaction(work);}
  async reserve(actor:Actor,bytes:number,key:string,transaction?:Sql):Promise<StorageReservation>{
    requireValue(Number.isSafeInteger(bytes)&&bytes>0,400,'invalid_request','文件大小不正确。');
    requireValue(bytes<=MAX_FILE_BYTES,413,'file_too_large',FILE_TOO_LARGE_MESSAGE);
    requireValue(this.options.globalLimitBytes>0,503,'not_configured','全站附件额度尚未配置。');key=text(key,'预留键',200);
    return this.within(transaction,async sql=>{
      await this.lock(sql);const now=this.clock();
      const existing=await sql.query<ReservationRow>('SELECT * FROM storage_reservations WHERE account_id=$1 AND reservation_key=$2 FOR UPDATE',[actor.accountId,key]);
      if(existing.rows[0]){
        requireValue(Number(existing.rows[0].bytes)===bytes,409,'idempotency_conflict','预留键已用于不同大小的文件。');
        requireValue(existing.rows[0].state!=='reserved'||new Date(existing.rows[0].expires_at)>now,409,'reservation_expired','文件额度预留已过期，请重新申请。');return reservation(existing.rows[0]);
      }
      const usage=await sql.query<{total:string;personal:string}>(`SELECT COALESCE(sum(bytes),0)::text AS total,
        COALESCE(sum(bytes) FILTER (WHERE account_id=$1),0)::text AS personal FROM storage_reservations
        WHERE state='committed' OR (state='reserved' AND expires_at>$2)`,[actor.accountId,now]);
      requireValue(Number(usage.rows[0].personal)+bytes<=MAX_ACCOUNT_STORAGE_BYTES&&Number(usage.rows[0].total)+bytes<=this.options.globalLimitBytes,429,'quota_exceeded','附件存储额度不足，请释放未完成的上传或减少文件大小。');
      const result=await sql.query<ReservationRow>(`INSERT INTO storage_reservations(id,account_id,reservation_key,bytes,state,expires_at) VALUES($1,$2,$3,$4,'reserved',$5) RETURNING *`,[randomUUID(),actor.accountId,key,bytes,new Date(now.getTime()+this.ttl)]);
      return reservation(result.rows[0]);
    });
  }
  async commit(actor:Actor,id:string,transaction?:Sql):Promise<StorageReservation>{
    return this.within(transaction,async sql=>{
      await this.lock(sql);const result=await sql.query<ReservationRow>('SELECT * FROM storage_reservations WHERE id=$1 AND account_id=$2 FOR UPDATE',[id,actor.accountId]);
      const row=result.rows[0];requireValue(row,404,'not_found','找不到这项文件额度预留。');if(row.state==='committed')return reservation(row);
      requireValue(row.state==='reserved',409,'reservation_released','文件额度预留已释放。');requireValue(new Date(row.expires_at)>this.clock(),409,'reservation_expired','文件额度预留已过期。');
      const updated=await sql.query<ReservationRow>("UPDATE storage_reservations SET state='committed',updated_at=$2 WHERE id=$1 RETURNING *",[id,this.clock()]);return reservation(updated.rows[0]);
    });
  }
  async release(actor:Actor,id:string,transaction?:Sql):Promise<StorageReservation>{
    return this.within(transaction,async sql=>{
      await this.lock(sql);const result=await sql.query<ReservationRow>('SELECT * FROM storage_reservations WHERE id=$1 AND account_id=$2 FOR UPDATE',[id,actor.accountId]);
      const row=result.rows[0];requireValue(row,404,'not_found','找不到这项文件额度预留。');
      requireValue(row.state!=='committed',409,'reservation_committed','已提交的存储必须随实际附件删除后回收。');if(row.state==='released')return reservation(row);
      const updated=await sql.query<ReservationRow>("UPDATE storage_reservations SET state='released',updated_at=$2 WHERE id=$1 RETURNING *",[id,this.clock()]);return reservation(updated.rows[0]);
    });
  }
}

export interface Job {id:string;kind:string;dedupKey:string;payload:unknown;state:'queued'|'running'|'completed'|'failed';attempts:number;maxAttempts:number;availableAt:string;leaseToken:string|null;leaseUntil:string|null;result:unknown;lastError:string|null}
interface JobRow {id:string;kind:string;dedup_key:string;payload:unknown;payload_hash:string;state:Job['state'];attempts:number;max_attempts:number;available_at:Date;lease_token:string|null;lease_until:Date|null;result:unknown;last_error:string|null}
const job=(row:JobRow):Job=>({id:row.id,kind:row.kind,dedupKey:row.dedup_key,payload:row.payload,state:row.state,attempts:row.attempts,maxAttempts:row.max_attempts,availableAt:timestamp(row.available_at),leaseToken:row.lease_token,leaseUntil:row.lease_until?timestamp(row.lease_until):null,result:row.result,lastError:row.last_error});
export class JobQueue {
  constructor(private readonly db:Database,private readonly clock:Clock=systemClock){}
  async enqueue(kind:string,dedupKey:string,payload:unknown,options:{runAt?:Date;maxAttempts?:number}={}):Promise<Job>{
    kind=text(kind,'任务类型',120);dedupKey=text(dedupKey,'任务去重键',200);const encoded=canonicalJson(payload),fingerprint=payloadFingerprint(payload),maxAttempts=options.maxAttempts??5,runAt=options.runAt??this.clock();
    requireValue(Number.isInteger(maxAttempts)&&maxAttempts>=1&&maxAttempts<=100&&Number.isFinite(runAt.getTime()),400,'invalid_request','任务参数不正确。');
    return this.db.transaction(async sql=>{
      await sql.query("SELECT pg_advisory_xact_lock(hashtextextended(current_schema() || ':job:' || $1 || ':' || $2,0))",[kind,dedupKey]);
      const existing=await sql.query<JobRow>('SELECT * FROM background_jobs WHERE kind=$1 AND dedup_key=$2',[kind,dedupKey]);
      if(existing.rows[0]){requireValue(existing.rows[0].payload_hash===fingerprint,409,'idempotency_conflict','任务去重键已用于不同内容。');return job(existing.rows[0]);}
      const inserted=await sql.query<JobRow>(`INSERT INTO background_jobs(id,kind,dedup_key,payload,payload_hash,max_attempts,available_at) VALUES($1,$2,$3,$4::jsonb,$5,$6,$7) RETURNING *`,[randomUUID(),kind,dedupKey,encoded,fingerprint,maxAttempts,runAt]);return job(inserted.rows[0]);
    });
  }
  async claim(workerId:string,leaseMs=30_000):Promise<Job|null>{
    workerId=text(workerId,'工作进程',120);duration(leaseMs,900_000);const now=this.clock();
    return this.db.transaction(async sql=>{
      await sql.query("UPDATE background_jobs SET state='failed',lease_until=NULL,last_error='lease_exhausted',updated_at=$1 WHERE state='running' AND lease_until<=$1 AND attempts>=max_attempts",[now]);
      const selected=await sql.query<JobRow>(`SELECT * FROM background_jobs WHERE attempts<max_attempts AND
        ((state='queued' AND available_at<=$1) OR (state='running' AND lease_until<=$1)) ORDER BY available_at,id FOR UPDATE SKIP LOCKED LIMIT 1`,[now]);
      if(!selected.rows[0])return null;
      const updated=await sql.query<JobRow>(`UPDATE background_jobs SET state='running',attempts=attempts+1,worker_id=$2,lease_token=$3,lease_until=$4,updated_at=$5 WHERE id=$1 RETURNING *`,[selected.rows[0].id,workerId,randomUUID(),new Date(now.getTime()+leaseMs),now]);return job(updated.rows[0]);
    });
  }
  async heartbeat(id:string,leaseToken:string,leaseMs=30_000):Promise<Job>{
    duration(leaseMs,900_000);const now=this.clock();
    const result=await this.db.query<JobRow>(`UPDATE background_jobs SET lease_until=$3,updated_at=$4 WHERE id=$1 AND lease_token=$2 AND state='running' AND lease_until>$4 RETURNING *`,[id,leaseToken,new Date(now.getTime()+leaseMs),now]);
    requireValue(result.rows[0],409,'lease_lost','任务租约已失效。');return job(result.rows[0]);
  }
  async complete(id:string,leaseToken:string,result:unknown=null):Promise<Job>{
    const now=this.clock(),encoded=canonicalJson(result);
    const updated=await this.db.query<JobRow>(`UPDATE background_jobs SET state='completed',lease_until=NULL,result=CASE WHEN state='completed' THEN result ELSE $3::jsonb END,updated_at=$4 WHERE id=$1 AND lease_token=$2
      AND ((state='running' AND lease_until>$4) OR state='completed') RETURNING *`,[id,leaseToken,encoded,now]);
    requireValue(updated.rows[0],409,'lease_lost','任务租约已失效。');return job(updated.rows[0]);
  }
  async fail(id:string,leaseToken:string,errorCode:string,retryDelayMs=1000):Promise<Job>{
    errorCode=text(errorCode,'任务错误代码',200);requireValue(Number.isSafeInteger(retryDelayMs)&&retryDelayMs>=0&&retryDelayMs<=86_400_000,400,'invalid_request','重试等待时间不正确。');const now=this.clock();
    const updated=await this.db.query<JobRow>(`UPDATE background_jobs SET state=CASE WHEN attempts>=max_attempts THEN 'failed' ELSE 'queued' END,
      available_at=$3,lease_until=NULL,lease_token=NULL,last_error=$4,updated_at=$5 WHERE id=$1 AND lease_token=$2 AND state='running' AND lease_until>$5 RETURNING *`,[id,leaseToken,new Date(now.getTime()+retryDelayMs),errorCode,now]);
    requireValue(updated.rows[0],409,'lease_lost','任务租约已失效。');return job(updated.rows[0]);
  }
  async get(id:string):Promise<Job|null>{const result=await this.db.query<JobRow>('SELECT * FROM background_jobs WHERE id=$1',[id]);return result.rows[0]?job(result.rows[0]):null;}
}
