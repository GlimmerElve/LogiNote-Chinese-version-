import {randomUUID} from 'node:crypto';
import type {Database,Sql} from './db.js';
import {object,onlyKeys,requireValue} from './errors.js';
import type {Actor,Clock} from './types.js';
import {systemClock} from './types.js';

export type Capability='write'|'send_message'|'create_group';
export type ObjectScope='public'|'group'|'direct'|'self';
export interface ProtectedObject {id:string;ownerId:string;scope:ObjectScope;groupId:string|null;state:'visible'|'restricted'|'withdrawn';version:number;recipientAccountIds:string[];restrictedUntil:Date|null;newsArticleId?:string|null}
export function uuid(value:unknown,label='标识'):string {
  requireValue(typeof value==='string'&&/^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/i.test(value),400,'invalid_request',`${label}格式不正确。`);return value.toLowerCase();
}

/** The actor is supplied by verified server authentication, never by request JSON. */
export class AccessService {
  constructor(readonly db:Database,readonly clock:Clock=systemClock){}
  async lockGroup(groupId:string,sql:Sql){await sql.query("SELECT pg_advisory_xact_lock(hashtextextended(current_schema() || ':group:' || $1,0))",[uuid(groupId,'共学群')]);}
  async assertAccount(actor:Actor,sql:Sql=this.db):Promise<void>{
    uuid(actor.accountId,'账号');const result=await sql.query('SELECT id FROM accounts WHERE id=$1',[actor.accountId]);
    requireValue(result.rowCount,401,'authentication_required','请重新登录。');
  }
  async assertPlatformAdmin(actor:Actor,sql:Sql=this.db):Promise<void>{
    await this.assertAccount(actor,sql);const result=await sql.query<{role:string}>('SELECT role FROM accounts WHERE id=$1',[actor.accountId]);
    requireValue(actor.role==='administrator'&&result.rows[0]?.role==='administrator'&&actor.mfaVerified,403,'forbidden','需要管理员身份及有效的多因素验证。');
  }
  async assertCapability(actor:Actor,capability:Capability,sql:Sql=this.db):Promise<void>{
    requireValue(['write','send_message','create_group'].includes(capability),400,'invalid_request','操作类型不正确。');
    uuid(actor.accountId,'账号');
    // Governance locks the same account before imposing a restriction. Passing the
    // operation's transaction keeps this lock until its actual business write.
    const account=await sql.query('SELECT id FROM accounts WHERE id=$1 FOR UPDATE',[actor.accountId]);
    requireValue(account.rowCount,401,'authentication_required','请重新登录。');
    const blocked=await sql.query(`SELECT id FROM account_restrictions
      WHERE account_id=$1 AND capability=ANY($2::text[]) AND revoked_at IS NULL
      AND starts_at<=$3 AND expires_at>$3 LIMIT 1`,[actor.accountId,capability==='write'?['write']:['write',capability],this.clock()]);
    requireValue(!blocked.rowCount,403,'forbidden','当前账号的这项操作受到限制。');
  }
  async membership(actor:Actor,groupId:string,sql:Sql=this.db):Promise<string|undefined>{
    const result=await sql.query<{role:string}>(`SELECT m.role FROM group_memberships m JOIN groups g ON g.id=m.group_id AND g.state<>'dissolved'
      JOIN protected_objects root ON root.id=g.id AND (root.state='visible' OR root.state='restricted' AND root.restricted_until<=$3)
      WHERE m.group_id=$1 AND m.account_id=$2 AND m.state='active'`,[groupId,actor.accountId,this.clock()]);return result.rows[0]?.role;
  }
  async assertGroupAvailable(groupId:string,sql:Sql=this.db):Promise<void>{
    const row=(await sql.query<{state:string;root_state:string;restricted_until:Date|null}>(`SELECT g.state,root.state AS root_state,root.restricted_until FROM groups g
      JOIN protected_objects root ON root.id=g.id WHERE g.id=$1`,[uuid(groupId,'共学群')])).rows[0];
    requireValue(row&&row.state!=='dissolved',403,'forbidden','这个共学群当前不可访问。');
    requireValue(row.root_state==='visible'||row.root_state==='restricted'&&row.restricted_until&&new Date(row.restricted_until)<=this.clock(),403,'forbidden','这个共学群已被平台限制，可在相关工单查看处理和申诉进度。');
  }
  async assertGroupWrite(actor:Actor,groupId:string,sql:Sql){
    await sql.query("SELECT pg_advisory_xact_lock(hashtextextended(current_schema() || ':group:' || $1,0))",[uuid(groupId,'共学群')]);
    await this.assertGroupAvailable(groupId,sql);
    const row=(await sql.query<{state:string;muted_until:Date|null}>("SELECT g.state,m.muted_until FROM groups g JOIN group_memberships m ON m.group_id=g.id AND m.account_id=$2 AND m.state='active' WHERE g.id=$1",[groupId,actor.accountId])).rows[0];
    requireValue(row,403,'forbidden','仅当前群成员可以参与。');requireValue(row.state==='active',403,'group_archived','这个共学群已归档，只能阅读。');requireValue(!row.muted_until||new Date(row.muted_until)<=this.clock(),403,'group_muted','你暂时不能在这个群发送内容。');
  }
  async loadObject(id:string,sql:Sql=this.db,lock=false):Promise<ProtectedObject>{
    uuid(id,'对象');if(lock){const row=(await sql.query<{group_id:string|null}>(`SELECT COALESCE(p.group_id,g.id) AS group_id FROM protected_objects p LEFT JOIN groups g ON g.id=p.id WHERE p.id=$1`,[id])).rows[0];if(row?.group_id)await this.lockGroup(row.group_id,sql);}const result=await sql.query<ProtectedObject>(`SELECT id,owner_id AS "ownerId",scope,group_id AS "groupId",
      CASE WHEN state='restricted' AND restricted_until<=$2 THEN 'visible' ELSE state END AS state,
      version,news_article_id AS "newsArticleId",restricted_until AS "restrictedUntil",ARRAY(SELECT account_id::text FROM direct_object_recipients WHERE object_id=protected_objects.id ORDER BY account_id) AS "recipientAccountIds"
      FROM protected_objects WHERE id=$1${lock?' FOR UPDATE':''}`,[id,this.clock()]);
    requireValue(result.rows[0],404,'not_found','对象不存在。');return result.rows[0];
  }
  async authorizeObject(actor:Actor|null,id:string,action:'read'|'write'|'manage',sql:Sql=this.db,attachmentId?:string):Promise<ProtectedObject>{
    requireValue(['read','write','manage'].includes(action),400,'invalid_request','操作类型不正确。');
    if(action!=='read'){requireValue(actor,401,'authentication_required','请先登录。');await this.assertCapability(actor,'write',sql);}
    else if(actor)await this.assertAccount(actor,sql);
    const initial=await this.loadObject(id,sql);
    if(initial.scope==='group')await this.assertGroupAvailable(initial.groupId!,sql);
    if(action==='write'&&initial.scope==='group')await this.assertGroupWrite(actor!,initial.groupId!,sql);
    const item=action==='read'?initial:await this.loadObject(id,sql,true);
    let newsRead=false;
    if(item.newsArticleId){
      if(item.newsArticleId===id)requireValue(action!=='write',409,'news_review_required','资讯须通过投稿编辑与审核更新。');
      else{
        const revision=(await sql.query<{state:string;published:boolean;reviewable:boolean}>(`SELECT r.state,EXISTS(SELECT 1 FROM news_revision_images i JOIN news_articles n ON n.published_revision_id=i.revision_id JOIN protected_objects p ON p.id=n.id WHERE i.attachment_id=$2 AND n.id=r.article_id AND p.scope='public' AND (p.state='visible' OR p.state='restricted' AND p.restricted_until<=$3)) AS published,
          EXISTS(SELECT 1 FROM news_revision_images i JOIN news_articles n ON n.latest_revision_id=i.revision_id JOIN news_revisions active ON active.id=i.revision_id WHERE i.attachment_id=$2 AND n.id=r.article_id AND active.state NOT IN ('draft','withdrawn')) AS reviewable
          FROM news_revisions r WHERE r.id=$1`,[id,attachmentId||null,this.clock()])).rows[0];
        requireValue(revision,404,'not_found','稿件版本不存在。');
        if(action==='write')requireValue(revision.state==='draft',409,'news_revision_sealed','待审和历史版本不可直接改写。');
        if(action==='read'){
          newsRead=!!attachmentId&&revision.published;
          if(!newsRead&&(revision.state!=='draft'&&revision.state!=='withdrawn'||!!attachmentId&&revision.reviewable)&&actor?.role==='administrator'&&actor.mfaVerified){await this.assertPlatformAdmin(actor,sql);newsRead=true;}
        }
      }
    }
    const member=actor&&item.scope==='group'?await this.membership(actor,item.groupId!,sql):undefined;
    const withinScope=newsRead||item.scope==='public'||!!actor&&(item.scope==='self'?item.ownerId===actor.accountId:item.scope==='direct'?item.ownerId===actor.accountId||item.recipientAccountIds.includes(actor.accountId):!!member);
    if(action==='manage'){
      const groupManager=item.scope==='group'&&(member==='owner'||member==='administrator');
      if(!groupManager){requireValue(actor,401,'authentication_required','请先登录。');await this.assertPlatformAdmin(actor,sql);}
      return item;
    }
    requireValue(withinScope,403,'forbidden','没有访问此对象的权限。');
    const owner=!!actor&&item.ownerId===actor.accountId;
    if(action==='read')requireValue(item.state==='visible'||owner,403,'forbidden','此对象当前不可见。');
    else{requireValue(owner,403,'forbidden','只能修改自己的对象。');requireValue(item.state==='visible',403,'forbidden','此对象当前受到限制或已撤回。');}
    return item;
  }
  async readObject(actor:Actor|null,id:string,sql:Sql=this.db):Promise<ProtectedObject>{
    const item=await this.authorizeObject(actor,id,'read',sql);return {...item,recipientAccountIds:actor?.accountId===item.ownerId?item.recipientAccountIds:[]};
  }
  async createObject(actor:Actor,input:unknown,sql?:Sql):Promise<ProtectedObject>{
    const data=object(input);onlyKeys(data,['scope','groupId','recipientAccountIds']);
    requireValue(typeof data.scope==='string'&&['public','group','direct','self'].includes(data.scope),400,'invalid_request','访问范围不正确。');
    const scope=data.scope as ObjectScope;
    requireValue(scope==='group'||data.groupId===undefined,400,'invalid_request','此范围不能指定群。');
    requireValue(scope==='direct'||data.recipientAccountIds===undefined,400,'invalid_request','此范围不能指定接收者。');
    const groupId=scope==='group'?uuid(data.groupId,'共学群'):null;
    let recipients:string[]=[];
    if(scope==='direct'){
      requireValue(Array.isArray(data.recipientAccountIds)&&data.recipientAccountIds.length>0&&data.recipientAccountIds.length<=50,400,'invalid_request','指定接收者应为 1 至 50 个账号。');
      recipients=data.recipientAccountIds.map(value=>uuid(value,'接收者'));requireValue(new Set(recipients).size===recipients.length,400,'invalid_request','接收者不能重复。');
    }
    const work=async(tx:Sql)=>{
      await this.assertCapability(actor,'write',tx);
      if(groupId)await this.assertGroupWrite(actor,groupId,tx);
      if(recipients.length){const found=await tx.query('SELECT id FROM accounts WHERE id=ANY($1::uuid[])',[recipients]);requireValue(found.rowCount===recipients.length,400,'invalid_request','接收者无效。');}
      const id=randomUUID();await tx.query('INSERT INTO protected_objects(id,owner_id,scope,group_id,created_at) VALUES($1,$2,$3,$4,$5)',[id,actor.accountId,scope,groupId,this.clock()]);
      for(const recipient of recipients)await tx.query('INSERT INTO direct_object_recipients(object_id,account_id) VALUES($1,$2)',[id,recipient]);
      return this.loadObject(id,tx);
    };
    return sql?work(sql):this.db.transaction(work);
  }
}
