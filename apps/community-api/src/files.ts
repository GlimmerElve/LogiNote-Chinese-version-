import {createHash,createHmac,randomUUID} from 'node:crypto';
import {constants} from 'node:fs';
import {link,lstat,mkdir,open,realpath,unlink} from 'node:fs/promises';
import path from 'node:path';
import {AccessService,uuid} from './access.js';
import type {Database,Sql} from './db.js';
import {ApiError,object,onlyKeys,requireValue,text} from './errors.js';
import {MAX_FILE_BYTES,QuotaService,payloadFingerprint} from './operations.js';
import {FILE_TOO_LARGE_MESSAGE} from './uploadLimits.js';
import {constantTimeEqual,encryptionKey,isOpaqueToken,opaqueToken,tokenHash} from './security.js';
import {systemClock,type Actor,type Clock} from './types.js';

export interface UploadIntent {attachmentId:string;uploadToken:string;expiresAt:string;state:'pending'|'ready';bytes:number}
export interface StoredAttachment {attachmentId:string;state:'ready';bytes:number;contentHash:string}
export interface FileOptions {directory:string;grantKey:string;uploadTtlMs?:number;downloadTtlMs?:number}
interface AttachmentRow {id:string;object_id:string;owner_id:string;reservation_id:string;intent_hash:string;name:string;mime:string;bytes:string;state:'pending'|'ready'|'cancelled';upload_token_hash:string;upload_expires_at:Date;content_hash:string|null}
const contentHash=(bytes:Buffer)=>createHash('sha256').update(bytes).digest('hex');
const stored=(row:AttachmentRow):StoredAttachment=>({attachmentId:row.id,state:'ready',bytes:Number(row.bytes),contentHash:row.content_hash!});
const unavailable=()=>new ApiError(503,'storage_unavailable','私有文件存储暂不可用，请稍后重试。',true);
const lifetime=(value:number|undefined,fallback:number)=>{const duration=value??fallback;requireValue(Number.isSafeInteger(duration)&&duration>0&&duration<=60*60_000,500,'invalid_configuration','文件授权时限配置不正确。');return duration;};

/** Local private storage adapter. This directory must never be mounted as static files. */
export class FileService {
  private readonly directory:string;
  private readonly key:Buffer;
  private readonly uploadTtl:number;
  private readonly downloadTtl:number;
  constructor(private readonly db:Database,private readonly access:AccessService,private readonly quota:QuotaService,options:FileOptions,private readonly clock:Clock=systemClock){
    requireValue(typeof options.directory==='string'&&!!options.directory.trim(),500,'invalid_configuration','私有文件目录未配置。');
    this.directory=path.resolve(options.directory);this.key=encryptionKey(options.grantKey);this.uploadTtl=lifetime(options.uploadTtlMs,15*60_000);this.downloadTtl=lifetime(options.downloadTtlMs,5*60_000);
  }
  private uploadToken(row:Pick<AttachmentRow,'id'|'owner_id'|'upload_expires_at'>):string{
    return createHmac('sha256',this.key).update(`loginote:private-upload:v1:${row.id}:${row.owner_id}:${new Date(row.upload_expires_at).toISOString()}`).digest('base64url');
  }
  private intent(row:AttachmentRow):UploadIntent{return {attachmentId:row.id,uploadToken:this.uploadToken(row),expiresAt:new Date(row.upload_expires_at).toISOString(),state:row.state as 'pending'|'ready',bytes:Number(row.bytes)};}
  private async directoryReady():Promise<void>{
    try{
      await mkdir(this.directory,{recursive:true,mode:0o700});const info=await lstat(this.directory);
      requireValue(info.isDirectory()&&!info.isSymbolicLink()&&path.relative(this.directory,await realpath(this.directory))==='',503,'storage_unavailable','私有文件目录不正确。');
    }catch{throw unavailable();}
  }
  private diskPath(id:string):string{return path.join(this.directory,uuid(id,'附件'));}
  private async authorizeRead(actor:Actor,id:string,sql:Sql,attachmentId:string){
    const item=await this.access.authorizeObject(actor,id,'read',sql,attachmentId);
    const parent=(await sql.query<{entry_id:string}>('SELECT entry_id FROM community_comments WHERE object_id=$1',[id])).rows[0];
    if(parent){const entry=await this.access.authorizeObject(actor,parent.entry_id,'read',sql);requireValue(entry.state==='visible',403,'resource_unavailable','原内容已下架或受到限制。');}
    return item;
  }
  private async readStored(id:string,expectedBytes:number,expectedHash?:string):Promise<Buffer>{
    await this.directoryReady();let handle;
    try{
      const target=this.diskPath(id),info=await lstat(target);if(!info.isFile()||info.isSymbolicLink()||info.size!==expectedBytes||info.size>MAX_FILE_BYTES)throw unavailable();
      handle=await open(target,constants.O_RDONLY|(constants.O_NOFOLLOW??0));const data=await handle.readFile();
      if(data.length!==expectedBytes||(expectedHash!==undefined&&contentHash(data)!==expectedHash))throw unavailable();return data;
    }catch{throw unavailable();}finally{await handle?.close();}
  }
  private async writeExclusive(id:string,data:Buffer,hash:string):Promise<boolean>{
    await this.directoryReady();let handle;const staging=this.diskPath(randomUUID());
    try{
      handle=await open(staging,'wx',0o600);await handle.writeFile(data);await handle.sync();await handle.close();handle=undefined;
      // An exclusive hard link publishes only fully flushed bytes, without rename's
      // overwrite behavior. A partial write never becomes the attachment UUID path.
      await link(staging,this.diskPath(id));return true;
    }catch(error){
      if((error as NodeJS.ErrnoException).code==='EEXIST'){const existing=await this.readStored(id,data.length);requireValue(contentHash(existing)===hash&&existing.equals(data),409,'upload_conflict','相同附件不能上传不同内容。');return false;}
      throw unavailable();
    }finally{await handle?.close();await unlink(staging).catch(error=>{if((error as NodeJS.ErrnoException).code!=='ENOENT')throw unavailable();});}
  }
  async createIntent(actor:Actor,value:unknown,key:string,transaction?:Sql):Promise<UploadIntent>{
    const input=object(value);onlyKeys(input,['objectId','name','mime','bytes']);const objectId=uuid(input.objectId,'所属对象'),name=text(input.name,'文件名',200),mime=text(input.mime,'文件类型',120).toLowerCase();key=text(key,'上传幂等键',200);
    requireValue(!/[\\/\x00-\x1f\x7f]/.test(name)&&name!=='.'&&name!=='..',400,'invalid_request','文件名不能包含路径或控制字符。');
    requireValue(/^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/.test(mime),400,'invalid_request','文件类型不正确。');
    requireValue(Number.isSafeInteger(input.bytes)&&Number(input.bytes)>0,400,'invalid_request','文件大小不正确。');const bytes=Number(input.bytes);requireValue(bytes<=MAX_FILE_BYTES,413,'file_too_large',FILE_TOO_LARGE_MESSAGE);
    const fingerprint=payloadFingerprint({objectId,name,mime,bytes});
    const work=async(sql:Sql)=>{
      await this.access.authorizeObject(actor,objectId,'write',sql);
      requireValue(!(await sql.query('SELECT 1 FROM community_messages WHERE object_id=$1 UNION ALL SELECT 1 FROM group_room_messages WHERE object_id=$1',[objectId])).rowCount,409,'message_sent','已发送的消息不能追加图片。');
      await sql.query("SELECT pg_advisory_xact_lock(hashtextextended(current_schema() || ':upload-intent:' || $1 || ':' || $2,0))",[actor.accountId,key]);
      const existing=await sql.query<AttachmentRow>('SELECT * FROM private_attachments WHERE owner_id=$1 AND intent_key=$2 FOR UPDATE',[actor.accountId,key]);
      if(existing.rows[0]){
        const row=existing.rows[0];requireValue(row.intent_hash===fingerprint,409,'idempotency_conflict','上传幂等键已用于不同文件。');requireValue(row.state!=='cancelled',409,'upload_cancelled','这项上传已取消。');
        requireValue(row.state==='ready'||new Date(row.upload_expires_at)>this.clock(),409,'upload_expired','上传授权已过期，请重新申请。');return this.intent(row);
      }
      const id=randomUUID(),reserved=await this.quota.reserve(actor,bytes,`attachment:${id}`,sql),expires=new Date(Math.min(this.clock().getTime()+this.uploadTtl,new Date(reserved.expiresAt).getTime()));
      const token=this.uploadToken({id,owner_id:actor.accountId,upload_expires_at:expires});
      const inserted=await sql.query<AttachmentRow>(`INSERT INTO private_attachments(id,object_id,owner_id,reservation_id,intent_key,intent_hash,name,mime,bytes,upload_token_hash,upload_expires_at)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,[id,objectId,actor.accountId,reserved.id,key,fingerprint,name,mime,bytes,tokenHash(token),expires]);return this.intent(inserted.rows[0]);
    };
    return transaction?work(transaction):this.db.transaction(work);
  }
  async put(actor:Actor,id:string,token:string,data:Buffer):Promise<StoredAttachment>{
    id=uuid(id,'附件');requireValue(isOpaqueToken(token),403,'invalid_upload_grant','上传授权无效。');requireValue(Buffer.isBuffer(data)&&data.length>0,400,'invalid_request','上传内容为空。');requireValue(data.length<=MAX_FILE_BYTES,413,'file_too_large',FILE_TOO_LARGE_MESSAGE);
    return this.db.transaction(async sql=>{
      const initial=await sql.query<AttachmentRow>('SELECT * FROM private_attachments WHERE id=$1 AND owner_id=$2',[id,actor.accountId]);requireValue(initial.rows[0],404,'not_found','找不到这项上传。');
      await this.access.authorizeObject(actor,initial.rows[0].object_id,'write',sql);
      requireValue(!(await sql.query('SELECT 1 FROM community_messages WHERE object_id=$1 UNION ALL SELECT 1 FROM group_room_messages WHERE object_id=$1',[initial.rows[0].object_id])).rowCount,409,'message_sent','已发送的消息不能修改图片。');
      const result=await sql.query<AttachmentRow>('SELECT * FROM private_attachments WHERE id=$1 AND owner_id=$2 FOR UPDATE',[id,actor.accountId]),row=result.rows[0];
      requireValue(row&&constantTimeEqual(row.upload_token_hash,tokenHash(token))&&new Date(row.upload_expires_at)>this.clock(),403,'invalid_upload_grant','上传授权无效或已过期。');requireValue(row.state!=='cancelled',409,'upload_cancelled','这项上传已取消。');
      requireValue(data.length===Number(row.bytes),409,'upload_conflict','上传大小与预留文件不一致。');const hash=contentHash(data);
      if(row.state==='ready'){requireValue(row.content_hash===hash,409,'upload_conflict','相同附件不能上传不同内容。');await this.readStored(id,data.length,hash);return stored(row);}
      let wrote=false;
      try{
        wrote=await this.writeExclusive(id,data,hash);await this.quota.commit(actor,row.reservation_id,sql);
        const ready=await sql.query<AttachmentRow>("UPDATE private_attachments SET state='ready',content_hash=$2,stored_at=$3 WHERE id=$1 RETURNING *",[id,hash,this.clock()]);return stored(ready.rows[0]);
      }catch(error){
        // Remove newly written bytes before transaction locks are released, so a retry
        // cannot race with rollback cleanup. Never remove an existing ready attachment.
        if(wrote)await unlink(this.diskPath(id)).catch(()=>{});throw error;
      }
    });
  }
  async cancel(actor:Actor,id:string):Promise<{attachmentId:string;state:'cancelled'}>{
    id=uuid(id,'附件');return this.db.transaction(async sql=>{
      await this.access.assertAccount(actor,sql);const result=await sql.query<AttachmentRow>('SELECT * FROM private_attachments WHERE id=$1 AND owner_id=$2 FOR UPDATE',[id,actor.accountId]);const row=result.rows[0];requireValue(row,404,'not_found','找不到这项上传。');requireValue(row.state!=='ready',409,'upload_complete','已保存的附件不能作为未完成上传取消。');
      if(row.state!=='cancelled'){await unlink(this.diskPath(id)).catch(error=>{if((error as NodeJS.ErrnoException).code!=='ENOENT')throw unavailable();});await this.quota.release(actor,row.reservation_id,sql);await sql.query("UPDATE private_attachments SET state='cancelled' WHERE id=$1",[id]);}
      return {attachmentId:id,state:'cancelled'};
    });
  }
  /** Internal maintenance only: never scans paths or applies user visibility rules. */
  async readReady(actor:Actor,id:string,sql:Sql=this.db):Promise<{buffer:Buffer;name:string;mime:string;bytes:number;hash:string;objectId:string}>{
    const row=(await sql.query<AttachmentRow>("SELECT * FROM private_attachments WHERE id=$1 AND state='ready'",[uuid(id,'附件')])).rows[0];
    requireValue(row,404,'not_found','附件尚不可用。');await this.access.authorizeObject(actor,row.object_id,'read',sql);
    return {buffer:await this.readStored(row.id,Number(row.bytes),row.content_hash!),name:row.name,mime:row.mime,bytes:Number(row.bytes),hash:row.content_hash!,objectId:row.object_id};
  }
  async discardDraft(actor:Actor,id:string,stageId:string,sql:Sql):Promise<void>{
    await this.access.authorizeObject(actor,stageId,'write',sql);
    requireValue(!(await sql.query('SELECT 1 FROM community_messages WHERE object_id=$1 UNION ALL SELECT 1 FROM group_room_messages WHERE object_id=$1',[stageId])).rowCount,409,'message_sent','已发送的消息不能删除图片。');
    const row=(await sql.query<AttachmentRow>('SELECT * FROM private_attachments WHERE id=$1 AND owner_id=$2 AND object_id=$3 FOR UPDATE',[uuid(id),actor.accountId,stageId])).rows[0];
    requireValue(row,404,'not_found','文件草稿不存在。');
    requireValue(!(await sql.query('SELECT 1 FROM community_resource_files WHERE attachment_id=$1',[id])).rowCount,409,'file_published','已发布文件不能从草稿移除。');
    if(row.state==='cancelled')return;
    // The caller still has business writes and its idempotency result to commit.
    // Deleting bytes here would make a later rollback restore a broken ready file.
    // Committed cancellation revokes reads immediately; maintenance deletes its
    // bytes before releasing the charged quota, and can safely retry either step.
    await sql.query("UPDATE private_attachments SET state='cancelled',content_hash=NULL,stored_at=NULL WHERE id=$1",[id]);
  }
  /** Internal maintenance only: never scans paths or applies user visibility rules. */
  async cleanupExpired(limit=100):Promise<{cleaned:number}>{
    requireValue(Number.isSafeInteger(limit)&&limit>=1&&limit<=1000,400,'invalid_request','清理数量不正确。');
    const candidates=await this.db.query<Pick<AttachmentRow,'id'|'owner_id'|'object_id'>>(`SELECT a.id,a.owner_id,a.object_id FROM private_attachments a JOIN storage_reservations r ON r.id=a.reservation_id
      WHERE a.state='pending' AND a.upload_expires_at<=$1 OR a.state='cancelled' AND r.state<>'released'
      ORDER BY a.upload_expires_at,a.id LIMIT $2`,[this.clock(),limit]);
    let cleaned=0;
    for(const candidate of candidates.rows){
      const removed=await this.db.transaction(async sql=>{
        // Match put's account -> object -> attachment -> quota lock order. The
        // attachment is rechecked after waiting so a completed upload is never removed.
        await sql.query('SELECT id FROM accounts WHERE id=$1 FOR UPDATE',[candidate.owner_id]);
        await sql.query('SELECT id FROM protected_objects WHERE id=$1 FOR UPDATE',[candidate.object_id]);
        const result=await sql.query<AttachmentRow>(`SELECT a.* FROM private_attachments a JOIN storage_reservations r ON r.id=a.reservation_id
          WHERE a.id=$1 AND (a.state='pending' AND a.upload_expires_at<=$2 OR a.state='cancelled' AND r.state<>'released') FOR UPDATE OF a`,[candidate.id,this.clock()]);
        const row=result.rows[0];if(!row)return false;
        await this.directoryReady();await unlink(this.diskPath(row.id)).catch(error=>{if((error as NodeJS.ErrnoException).code!=='ENOENT')throw unavailable();});
        if(row.state==='cancelled'){
          // Only committed draft cancellation may release committed storage, and
          // only after actual deletion. If this transaction fails, the already
          // cancelled file stays unreadable and ENOENT makes cleanup retryable.
          await sql.query("SELECT pg_advisory_xact_lock(hashtextextended(current_schema() || ':storage-quota',0))");
          await sql.query("UPDATE storage_reservations SET state='released',updated_at=$2 WHERE id=$1",[row.reservation_id,this.clock()]);
        }else await this.quota.release({accountId:row.owner_id,role:'member',mfaVerified:false},row.reservation_id,sql);
        await sql.query("UPDATE private_attachments SET state='cancelled' WHERE id=$1",[row.id]);return true;
      });
      if(removed)cleaned++;
    }
    return {cleaned};
  }
  async createDownload(actor:Actor,id:string):Promise<{token:string;expiresAt:string}>{
    id=uuid(id,'附件');return this.db.transaction(async sql=>{
      const result=await sql.query<AttachmentRow>("SELECT * FROM private_attachments WHERE id=$1 AND state='ready'",[id]);const row=result.rows[0];requireValue(row,404,'not_found','附件尚不可用。');const item=await this.authorizeRead(actor,row.object_id,sql,row.id);requireValue(item.state==='visible',403,'resource_unavailable','资源已下架或受到限制。');
      const token=opaqueToken(),expires=new Date(this.clock().getTime()+this.downloadTtl);await sql.query('INSERT INTO attachment_download_grants(token_hash,attachment_id,account_id,expires_at) VALUES($1,$2,$3,$4)',[tokenHash(token),id,actor.accountId,expires]);return {token,expiresAt:expires.toISOString()};
    });
  }
  async download(actor:Actor,id:string,token:string):Promise<{buffer:Buffer;name:string;mime:string}>{
    id=uuid(id,'附件');requireValue(isOpaqueToken(token),403,'invalid_download_grant','下载授权无效。');
    return this.db.transaction(async sql=>{
      const result=await sql.query<AttachmentRow>(`SELECT a.* FROM private_attachments a JOIN attachment_download_grants g ON g.attachment_id=a.id
        WHERE a.id=$1 AND a.state='ready' AND g.token_hash=$2 AND g.account_id=$3 AND g.expires_at>$4`,[id,tokenHash(token),actor.accountId,this.clock()]);
      const row=result.rows[0];requireValue(row,403,'invalid_download_grant','下载授权无效或已过期。');const item=await this.authorizeRead(actor,row.object_id,sql,row.id);requireValue(item.state==='visible',403,'resource_unavailable','资源已下架或受到限制。');
      return {buffer:await this.readStored(row.id,Number(row.bytes),row.content_hash!),name:row.name,mime:row.mime};
    });
  }
}
