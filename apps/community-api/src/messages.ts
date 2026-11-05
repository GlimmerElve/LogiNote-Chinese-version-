import {randomUUID} from 'node:crypto';
import {AccessService,uuid} from './access.js';
import type {Database,Sql} from './db.js';
import {object,onlyKeys,requireValue,text} from './errors.js';
import type {Actor,Clock} from './types.js';
import {systemClock} from './types.js';
import {messageCursor,validateMessageImages} from './messageMedia.js';
import type {FileService} from './files.js';
import type {AttentionService} from './attention.js';

// All relationship changes use the same pair lock before taking account locks.
export async function lockPeople(sql:Sql,ids:string[]){await sql.query('SELECT id FROM accounts WHERE id=ANY($1::uuid[]) ORDER BY id FOR UPDATE',[[...new Set(ids)].sort()]);}
export async function lockPair(sql:Sql,a:string,b:string){await lockPeople(sql,[a,b]);await sql.query("SELECT pg_advisory_xact_lock(hashtextextended(current_schema() || ':contact:' || $1,0))",[[a,b].sort().join(':')]);}
export async function assertUnblocked(sql:Sql,a:string,b:string){
  const blocked=await sql.query('SELECT 1 FROM account_blocks WHERE (blocker_id=$1 AND blocked_id=$2) OR (blocker_id=$2 AND blocked_id=$1)',[a,b]);
  requireValue(!blocked.rowCount,403,'contact_unavailable','暂时无法与这位用户互动。');
}
type ConversationRow={id:string;low_id:string;high_id:string;initiator_id:string;state:'pending'|'accepted'|'rejected';updated_at:Date};
const peer=(row:ConversationRow,actor:Actor)=>row.low_id===actor.accountId?row.high_id:row.low_id;
const cursor=messageCursor;
export class MessageService {
  constructor(readonly db:Database,readonly access:AccessService,readonly files:FileService,readonly attention:AttentionService,readonly clock:Clock=systemClock){}
  private async row(actor:Actor,id:string,sql:Sql=this.db){
    const row=(await sql.query<ConversationRow>('SELECT * FROM community_conversations WHERE id=$1 AND (low_id=$2 OR high_id=$2)',[uuid(id,'会话'),actor.accountId])).rows[0];
    requireValue(row,404,'not_found','没有找到你的会话。');return row;
  }
  private async writable(actor:Actor,id:string,sql:Sql){
    const row=await this.row(actor,id,sql);await lockPair(sql,row.low_id,row.high_id);await assertUnblocked(sql,row.low_id,row.high_id);await this.access.assertCapability(actor,'send_message',sql);
    return this.row(actor,id,sql);
  }
  async open(actor:Actor,value:unknown,sql:Sql){
    const input=object(value);onlyKeys(input,['peerId']);const target=uuid(input.peerId,'用户');requireValue(target!==actor.accountId,400,'invalid_request','请选择另一位用户。');
    await lockPair(sql,actor.accountId,target);await assertUnblocked(sql,actor.accountId,target);await this.access.assertCapability(actor,'send_message',sql);
    requireValue((await sql.query('SELECT 1 FROM accounts WHERE id=$1 AND email_verified_at IS NOT NULL',[target])).rowCount,404,'not_found','没有找到这位社区用户。');
    const [low,high]=[actor.accountId,target].sort(),now=this.clock();
    let row=(await sql.query<ConversationRow>('SELECT * FROM community_conversations WHERE low_id=$1 AND high_id=$2',[low,high])).rows[0];
    if(!row){row=(await sql.query<ConversationRow>('INSERT INTO community_conversations(id,low_id,high_id,initiator_id,created_at,updated_at) VALUES($1,$2,$3,$4,$5,$5) RETURNING *',[randomUUID(),low,high,actor.accountId,now])).rows[0];
      for(const accountId of [low,high])await sql.query('INSERT INTO community_conversation_members(conversation_id,account_id,hidden) VALUES($1,$2,$3)',[row.id,accountId,accountId!==actor.accountId]);
    }
    await sql.query('UPDATE community_conversation_members SET hidden=false WHERE conversation_id=$1 AND account_id=$2',[row.id,actor.accountId]);return this.detail(actor,row.id,sql);
  }
  async detail(actor:Actor,id:string,sql:Sql=this.db){
    const row=await this.row(actor,id,sql),other=peer(row,actor);
    const person=(await sql.query('SELECT a.id AS "accountId",a.display_name AS "displayName",COALESCE(p.bio,\'\') AS bio,COALESCE(p.interests,\'{}\') AS interests FROM accounts a LEFT JOIN account_profiles p ON p.account_id=a.id WHERE a.id=$1',[other])).rows[0];
    const blocks=await sql.query('SELECT blocker_id FROM account_blocks WHERE (blocker_id=$1 AND blocked_id=$2) OR (blocker_id=$2 AND blocked_id=$1)',[actor.accountId,other]);
    const sent=(await sql.query('SELECT 1 FROM community_messages WHERE conversation_id=$1 AND sender_id=$2 LIMIT 1',[id,actor.accountId])).rowCount!>0;
    return {id:row.id,person:{...person,isMe:false,followed:false},state:row.state,incoming:row.initiator_id!==actor.accountId,blockedByMe:blocks.rows.some(item=>item.blocker_id===actor.accountId),canSend:!blocks.rowCount&&row.state!=='rejected'&&(row.state==='accepted'||!sent&&row.initiator_id===actor.accountId),contactUnavailable:!!blocks.rowCount,updatedAt:new Date(row.updated_at).toISOString()};
  }
  async list(actor:Actor,input:{offset?:string;q?:string}={}){
    const offset=Number(input.offset||0);requireValue(Number.isSafeInteger(offset)&&offset>=0&&offset<=100000&&(!input.q||input.q.length<=100),400,'invalid_request','会话筛选参数不正确。');
    const rows=await this.db.query<ConversationRow&{peer_id:string;display_name:string;bio:string;interests:string[];blocked_by_me:boolean;blocked_by_peer:boolean;sent:boolean}>(`SELECT c.*,a.id AS peer_id,a.display_name,COALESCE(p.bio,'') AS bio,COALESCE(p.interests,'{}') AS interests,
      EXISTS(SELECT 1 FROM account_blocks b WHERE b.blocker_id=$1 AND b.blocked_id=a.id) AS blocked_by_me,
      EXISTS(SELECT 1 FROM account_blocks b WHERE b.blocker_id=a.id AND b.blocked_id=$1) AS blocked_by_peer,
      EXISTS(SELECT 1 FROM community_messages sent WHERE sent.conversation_id=c.id AND sent.sender_id=$1) AS sent
      FROM community_conversations c JOIN community_conversation_members m ON m.conversation_id=c.id JOIN accounts a ON a.id=CASE WHEN c.low_id=$1 THEN c.high_id ELSE c.low_id END
      LEFT JOIN account_profiles p ON p.account_id=a.id WHERE m.account_id=$1 AND (c.low_id=$1 OR c.high_id=$1) AND NOT m.hidden AND ($2='' OR a.display_name ILIKE '%' || $2 || '%') ORDER BY c.updated_at DESC,c.id LIMIT 31 OFFSET $3`,[actor.accountId,input.q||'',offset]);
    return {items:rows.rows.slice(0,30).map(row=>({id:row.id,person:{accountId:row.peer_id,displayName:row.display_name,bio:row.bio,interests:row.interests,isMe:false,followed:false},state:row.state,incoming:row.initiator_id!==actor.accountId,blockedByMe:row.blocked_by_me,canSend:!row.blocked_by_me&&!row.blocked_by_peer&&row.state!=='rejected'&&(row.state==='accepted'||!row.sent&&row.initiator_id===actor.accountId),contactUnavailable:row.blocked_by_me||row.blocked_by_peer,updatedAt:new Date(row.updated_at).toISOString()})),nextOffset:rows.rows.length>30?offset+30:null};
  }
  async sync(actor:Actor,id:string,input:{after?:string;before?:string}={}){
    const [conversation,history]=await Promise.all([this.detail(actor,id),this.history(actor,id,input)]);
    return {...history,conversation};
  }
  async change(actor:Actor,id:string,value:unknown,sql:Sql){
    const input=object(value);onlyKeys(input,['action']);requireValue(['accept','reject','hide'].includes(String(input.action)),400,'invalid_request','会话操作不正确。');
    if(input.action==='hide'){const row=await this.row(actor,id,sql);await lockPair(sql,row.low_id,row.high_id);await sql.query('UPDATE community_conversation_members SET hidden=true WHERE conversation_id=$1 AND account_id=$2',[id,actor.accountId]);return {hidden:true};}
    const row=await this.writable(actor,id,sql);requireValue(row.initiator_id!==actor.accountId,403,'forbidden','仅收到申请的人可以决定是否接受。');
    await sql.query('UPDATE community_conversations SET state=$2,updated_at=$3 WHERE id=$1',[id,input.action==='accept'?'accepted':'rejected',this.clock()]);return this.detail(actor,id,sql);
  }
  async block(actor:Actor,target:string,value:unknown,sql:Sql){
    const input=object(value);onlyKeys(input,['enabled']);target=uuid(target,'用户');requireValue(target!==actor.accountId&&typeof input.enabled==='boolean',400,'invalid_request','拉黑操作不正确。');
    await lockPair(sql,actor.accountId,target);await this.access.assertAccount(actor,sql);requireValue((await sql.query('SELECT 1 FROM accounts WHERE id=$1',[target])).rowCount,404,'not_found','没有找到这位用户。');
    if(input.enabled){await sql.query('INSERT INTO account_blocks(blocker_id,blocked_id,created_at) VALUES($1,$2,$3) ON CONFLICT DO NOTHING',[actor.accountId,target,this.clock()]);await sql.query('DELETE FROM account_follows WHERE (follower_id=$1 AND followed_id=$2) OR (follower_id=$2 AND followed_id=$1)',[actor.accountId,target]);}
    else await sql.query('DELETE FROM account_blocks WHERE blocker_id=$1 AND blocked_id=$2',[actor.accountId,target]);return {enabled:input.enabled};
  }
  async blocked(actor:Actor){return (await this.db.query('SELECT a.id AS "accountId",a.display_name AS "displayName" FROM account_blocks b JOIN accounts a ON a.id=b.blocked_id WHERE b.blocker_id=$1 ORDER BY b.created_at DESC LIMIT 200',[actor.accountId])).rows;}
  async stage(actor:Actor,id:string,sql:Sql){const row=await this.writable(actor,id,sql);requireValue((await this.detail(actor,id,sql)).canSend,403,'contact_pending','对方接受后才能继续发送。');const obj=await this.access.createObject(actor,{scope:'direct',recipientAccountIds:[peer(row,actor)]},sql);await sql.query('INSERT INTO community_message_stages(object_id,conversation_id,sender_id,created_at) VALUES($1,$2,$3,$4)',[obj.id,id,actor.accountId,this.clock()]);return {stageId:obj.id};}
  private async stageFiles(actor:Actor,id:string,stageId:string,sql:Sql){
    requireValue((await sql.query('SELECT 1 FROM community_message_stages WHERE object_id=$1 AND conversation_id=$2 AND sender_id=$3',[uuid(stageId),id,actor.accountId])).rowCount,403,'forbidden','图片不属于当前会话草稿。');
    return (await sql.query("SELECT id,name,mime,bytes::int AS bytes FROM private_attachments WHERE object_id=$1 AND state='ready' ORDER BY id",[stageId])).rows as {id:string;name:string;mime:string;bytes:number}[];
  }
  async removeImage(actor:Actor,id:string,stageId:string,fileId:string,sql:Sql){await this.row(actor,id,sql);await this.stageFiles(actor,id,stageId,sql);await this.files.discardDraft(actor,uuid(fileId),stageId,sql);return {removed:true};}
  async draft(actor:Actor,id:string,sql:Sql=this.db){
    await this.row(actor,id,sql);const value=(await sql.query<{draft:Record<string,unknown>}>('SELECT draft FROM community_conversation_members WHERE conversation_id=$1 AND account_id=$2',[id,actor.accountId])).rows[0].draft;
    return {...value,body:value.body||'',files:typeof value.stageId==='string'?await this.stageFiles(actor,id,value.stageId,sql):[]};
  }
  async saveDraft(actor:Actor,id:string,value:unknown,sql:Sql){
    const row=await this.row(actor,id,sql);await lockPair(sql,row.low_id,row.high_id);const input=object(value);onlyKeys(input,['body','clientId','stageId']);requireValue(typeof input.body==='string'&&input.body.length<=8000&&!input.body.includes('\0'),400,'invalid_request','消息不能超过 8000 字。');uuid(input.clientId,'消息');if(input.stageId)await this.stageFiles(actor,id,uuid(input.stageId),sql);
    if(!(await sql.query('SELECT 1 FROM community_messages WHERE conversation_id=$1 AND sender_id=$2 AND client_id=$3',[id,actor.accountId,input.clientId])).rowCount)await sql.query('UPDATE community_conversation_members SET draft=$3::jsonb WHERE conversation_id=$1 AND account_id=$2',[id,actor.accountId,JSON.stringify(input)]);
    return this.draft(actor,id,sql);
  }
  async send(actor:Actor,id:string,value:unknown,sql:Sql){
    const input=object(value);onlyKeys(input,['body','clientId','stageId']);const clientId=uuid(input.clientId,'消息');requireValue(typeof input.body==='string'&&input.body.length<=8000&&!input.body.includes('\0'),400,'invalid_request','消息不能超过 8000 字。');const body=input.body.trim();
    const row=await this.writable(actor,id,sql);
    const existing=(await sql.query<{object_id:string;body:string}>('SELECT object_id,body FROM community_messages WHERE conversation_id=$1 AND sender_id=$2 AND client_id=$3',[id,actor.accountId,clientId])).rows[0];
    if(existing){requireValue(existing.body===body&&(!input.stageId||input.stageId===existing.object_id),409,'idempotency_conflict','这条消息已经发送，不能替换内容。');return {id:existing.object_id};}
    requireValue((await this.detail(actor,id,sql)).canSend,403,'contact_pending','对方接受后才能继续发送。');
    if(row.state==='pending'){
      const count=(await sql.query<{n:number}>('SELECT count(DISTINCT c.id)::int AS n FROM community_conversations c JOIN community_messages m ON m.conversation_id=c.id WHERE c.initiator_id=$1 AND m.created_at>$2',[actor.accountId,new Date(this.clock().getTime()-86400000)])).rows[0].n;
      requireValue(count<5,429,'contact_limit','今天已向五位新用户发出介绍，请等待对方回应。');
    }
    let messageId:string;
    if(input.stageId){messageId=uuid(input.stageId);const files=await this.stageFiles(actor,id,messageId,sql);requireValue(files.length>0&&files.length<=4,400,'invalid_request','每条消息可附带一至四张图片。');requireValue(!(await sql.query("SELECT 1 FROM private_attachments WHERE object_id=$1 AND state='pending'",[messageId])).rowCount,409,'upload_pending','请等待图片上传完成。');
      requireValue(!(await sql.query('SELECT 1 FROM community_messages WHERE object_id=$1',[messageId])).rowCount,409,'conflict','这组图片已发送。');
      await validateMessageImages(actor,messageId,this.files,sql);
    }else{requireValue(body.length>0,400,'invalid_request','写点内容或附带图片后再发送。');messageId=(await this.access.createObject(actor,{scope:'direct',recipientAccountIds:[peer(row,actor)]},sql)).id;}
    const now=this.clock();await sql.query('INSERT INTO community_messages(object_id,conversation_id,sender_id,client_id,body,created_at) VALUES($1,$2,$3,$4,$5,$6)',[messageId,id,actor.accountId,clientId,body,now]);
    await sql.query('UPDATE community_conversations SET updated_at=$2 WHERE id=$1',[id,now]);await sql.query('UPDATE community_conversation_members SET hidden=false WHERE conversation_id=$1',[id]);
    await sql.query("UPDATE community_conversation_members SET draft='{}'::jsonb WHERE conversation_id=$1 AND account_id=$2 AND draft->>'clientId'=$3",[id,actor.accountId,clientId]);
    await this.attention.recordEvent(actor,{eventId:'message:'+messageId,recipientAccountId:peer(row,actor),kind:'ordinary',payload:{conversationId:id,messageId}},sql);return {id:messageId};
  }
  async history(actor:Actor,id:string,input:{after?:string;before?:string}={}){
    await this.row(actor,id);const after=cursor(input.after),before=cursor(input.before);requireValue(!after||!before,400,'invalid_request','只能选择一个消息方向。');
    const result=await this.db.query<any>(`SELECT m.*,o.state,o.restricted_until,COALESCE((SELECT jsonb_agg(jsonb_build_object('id',f.id,'name',f.name,'mime',f.mime,'bytes',f.bytes)) FROM private_attachments f WHERE f.object_id=m.object_id AND f.state='ready'),'[]'::jsonb) AS files FROM community_messages m JOIN protected_objects o ON o.id=m.object_id WHERE m.conversation_id=$1 AND ($2::bigint IS NULL OR m.position>$2::bigint) AND ($3::bigint IS NULL OR m.position<$3::bigint) ORDER BY m.position ${after?'ASC':'DESC'} LIMIT 31`,[id,after,before]);
    const rows=result.rows.slice(0,30);if(!after)rows.reverse();const items=rows.map(row=>{const visible=row.state==='visible'||row.state==='restricted'&&row.restricted_until&&new Date(row.restricted_until)<=this.clock();return {id:row.object_id,position:String(row.position),senderId:row.sender_id,clientId:row.sender_id===actor.accountId?row.client_id:undefined,body:visible?row.body:'',files:visible?row.files:[],visible,createdAt:new Date(row.created_at).toISOString()};});
    return {items,nextBefore:!after&&result.rows.length>30?String(rows[0].position):null,nextAfter:after&&result.rows.length>30?String(rows.at(-1)!.position):null};
  }
}
