import type {Database,Sql} from './db.js';
import {AccessService,uuid,type ObjectScope} from './access.js';
import {object,onlyKeys,requireValue,text} from './errors.js';
import {systemClock,type Actor,type Clock} from './types.js';
import {lockPair,lockPeople,assertUnblocked} from './messages.js';

type Kind='post'|'question'|'resource';
type View='public'|'following'|'mine'|'participated'|'bookmarks'|'learning'|'group';
export interface PublicPerson {accountId:string;displayName:string;bio:string;interests:string[];followed:boolean;isMe:boolean}
export interface CommunityEntry {news?:boolean;id:string;kind:Kind;title:string;body:string;resourceType:string|null;topics:string[];scope:ObjectScope;groupId:string|null;author:PublicPerson;createdAt:string;updatedAt:string;state:string;bookmarked:boolean;inLearning:boolean;learningCount:number;commentCount:number;acceptedCommentId:string|null;canAcceptSolution:boolean}
export interface CommunityComment {id:string;entryId:string;replyToId:string|null;replyToName:string|null;body:string;author:PublicPerson;createdAt:string}
export interface EntryQuery {view?:string;kind?:string;resourceType?:string;q?:string;topic?:string;authorId?:string;groupId?:string;offset?:string;limit?:string}
const integer=(value:string|undefined,fallback:number,max:number)=>{if(value===undefined)return fallback;requireValue(/^\d+$/.test(value)&&Number(value)<=max,400,'invalid_request','分页参数不正确。');return Number(value);};
function topics(value:unknown):string[]{if(value===undefined)return [];requireValue(Array.isArray(value)&&value.length<=3,400,'invalid_request','每条内容最多选择三个话题。');for(const item of value)requireValue(typeof item==='string'&&item.length<=30&&!/[\u0000-\u001f\u007f]/.test(item),400,'invalid_request','话题格式不正确。');return [...new Set((value as string[]).map(item=>item.trim()).filter(Boolean))];}
function title(value:unknown):string {if(value===undefined||value==='')return '';requireValue(typeof value==='string'&&value.length<=160&&!/[\u0000-\u001f\u007f]/.test(value),400,'invalid_request','标题不能超过 160 个字符。');return value.trim();}
function bodyText(value:unknown,label:string,max:number){const result=text(value,label,max);requireValue(!result.includes('\u0000'),400,'invalid_request','正文包含不支持的字符。');return result;}
const person=(row:any,actor:Actor|null):PublicPerson=>({accountId:row.author_id,displayName:row.display_name,bio:row.bio||'',interests:row.interests||[],followed:!!row.followed,isMe:actor?.accountId===row.author_id});
const entry=(row:any,actor:Actor|null):CommunityEntry=>({id:row.object_id,news:!!row.news_article_id,...(Array.isArray(row.images)&&row.images.length?{images:row.images}:{}),kind:row.kind,title:row.title,body:row.body,resourceType:row.resource_type,topics:row.topics,scope:row.scope,groupId:row.group_id,author:person(row,actor),createdAt:new Date(row.created_at).toISOString(),updatedAt:new Date(row.updated_at).toISOString(),state:row.state,bookmarked:!!row.bookmarked,inLearning:!!row.in_learning,learningCount:Number(row.learning_count),commentCount:Number(row.comment_count),acceptedCommentId:row.solution_id||null,canAcceptSolution:row.kind==='question'&&!!actor&&(row.author_id===actor.accountId||!!row.group_manager||actor.role==='administrator'&&actor.mfaVerified)});
// These conditions apply before search, counting, ordering and pagination.
const visible=`(o.state='visible' OR (o.state='restricted' AND o.restricted_until<=$2) OR (o.owner_id=$1 AND o.state<>'withdrawn'))`;
const readable=`(o.scope='public' OR (o.scope='self' AND o.owner_id=$1) OR (o.scope='group' AND EXISTS(SELECT 1 FROM group_memberships gm JOIN groups g ON g.id=gm.group_id AND g.state<>'dissolved' JOIN protected_objects root ON root.id=g.id AND (root.state='visible' OR root.state='restricted' AND root.restricted_until<=$2) WHERE gm.group_id=o.group_id AND gm.account_id=$1 AND gm.state='active')))`;
const select=`SELECT e.*,COALESCE((SELECT json_agg(json_build_object('id',ia.id,'name',ia.name,'mime',ia.mime,'bytes',ia.bytes)) FROM private_attachments ia WHERE (ia.object_id=e.object_id OR EXISTS(SELECT 1 FROM news_revision_images ni JOIN news_articles na ON na.published_revision_id=ni.revision_id WHERE na.id=e.object_id AND ni.attachment_id=ia.id)) AND ia.state='ready' AND ia.mime IN ('image/png','image/jpeg','image/webp') AND strpos(e.body,'attachment:'||ia.id::text)>0),'[]'::json) AS images,o.owner_id AS author_id,o.scope,o.group_id,o.state,o.news_article_id,a.display_name,p.bio,p.interests,
  (SELECT c.object_id FROM community_comments c JOIN protected_objects co ON co.id=c.object_id WHERE c.object_id=e.accepted_comment_id AND c.entry_id=e.object_id AND (co.state='visible' OR co.state='restricted' AND co.restricted_until<=$2)) AS solution_id,
  EXISTS(SELECT 1 FROM group_memberships gm JOIN groups g ON g.id=gm.group_id AND g.state<>'dissolved' JOIN protected_objects root ON root.id=g.id AND (root.state='visible' OR root.state='restricted' AND root.restricted_until<=$2) WHERE gm.group_id=o.group_id AND gm.account_id=$1 AND gm.state='active' AND gm.role IN ('owner','administrator')) AS group_manager,
  EXISTS(SELECT 1 FROM account_follows f WHERE f.follower_id=$1 AND f.followed_id=o.owner_id) AS followed,
  EXISTS(SELECT 1 FROM account_bookmarks b WHERE b.account_id=$1 AND b.entry_id=e.object_id) AS bookmarked,
  EXISTS(SELECT 1 FROM account_learning_resources l WHERE l.account_id=$1 AND l.entry_id=e.object_id) AS in_learning,
  (SELECT count(*)::int FROM account_learning_resources l WHERE l.entry_id=e.object_id) AS learning_count,
  (SELECT count(*)::int FROM community_comments c JOIN protected_objects co ON co.id=c.object_id WHERE c.entry_id=e.object_id AND (co.state='visible' OR (co.state='restricted' AND co.restricted_until<=$2))) AS comment_count
  FROM community_entries e JOIN protected_objects o ON o.id=e.object_id JOIN accounts a ON a.id=o.owner_id LEFT JOIN account_profiles p ON p.account_id=a.id`;

export class ContentService {
  constructor(private readonly db:Database,private readonly access:AccessService,private readonly clock:Clock=systemClock){}
  async list(actor:Actor|null,input:EntryQuery){
    const view=(input.view||'public') as View,kind=input.kind||'all';
    requireValue(['public','following','mine','participated','bookmarks','learning','group'].includes(view)&&['all','post','question','resource','discussion'].includes(kind),400,'invalid_request','内容筛选不正确。');
    if(view!=='public')requireValue(actor,401,'authentication_required','请先登录。');
    const limit=integer(input.limit,3,20);requireValue(limit>0,400,'invalid_request','每页至少一条内容。');const offset=integer(input.offset,0,100000);
    requireValue(!input.q||input.q.length<=200,400,'invalid_request','搜索内容过长。');requireValue(!input.topic||input.topic.length<=30,400,'invalid_request','话题过长。');
    const params:unknown[]=[actor?.accountId||null,this.clock()],where=[visible,readable];const bind=(value:unknown)=>{params.push(value);return `$${params.length}`;};
    if(['public','following','mine'].includes(view))where.push('o.news_article_id IS NULL');
    if(view==='public'||view==='following')where.push("o.scope='public'");
    if(view==='following')where.push('EXISTS(SELECT 1 FROM account_follows f WHERE f.follower_id=$1 AND f.followed_id=o.owner_id)');
    if(view==='mine')where.push('o.owner_id=$1');
    if(view==='participated')where.push('(o.owner_id=$1 OR EXISTS(SELECT 1 FROM community_comments c JOIN protected_objects co ON co.id=c.object_id WHERE c.entry_id=e.object_id AND co.owner_id=$1))');
    if(view==='bookmarks')where.push('EXISTS(SELECT 1 FROM account_bookmarks b WHERE b.account_id=$1 AND b.entry_id=e.object_id)');
    if(view==='learning')where.push("e.kind='resource' AND EXISTS(SELECT 1 FROM account_learning_resources l WHERE l.account_id=$1 AND l.entry_id=e.object_id)");
    if(view==='group'){const id=uuid(input.groupId,'共学群');requireValue(await this.access.membership(actor!,id),403,'forbidden','仅当前群成员可查看。');where.push(`o.scope='group' AND o.group_id=${bind(id)}`);}
    else requireValue(input.groupId===undefined,400,'invalid_request','此列表不能指定共学群。');
    if(kind==='discussion')where.push("e.kind IN ('post','question')");else if(kind!=='all')where.push(`e.kind=${bind(kind)}`);
    if(input.resourceType){requireValue(['note','route','exercise','link','scene'].includes(input.resourceType),400,'invalid_request','资源类型不正确。');where.push(`e.resource_type=${bind(input.resourceType)}`);}
    if(input.authorId)where.push(`o.owner_id=${bind(uuid(input.authorId,'作者'))}`);
    if(input.topic)where.push(`${bind(input.topic)}=ANY(e.topics)`);
    for(const token of (input.q||'').trim().toLowerCase().split(/\s+/).filter(Boolean).slice(0,10))where.push(`strpos(lower(e.title||' '||e.body||' '||a.display_name||' '||array_to_string(e.topics,' ')),${bind(token)})>0`);
    const take=bind(limit+1),skip=bind(offset),rows=await this.db.query(`${select} WHERE ${where.join(' AND ')} ORDER BY e.created_at DESC,e.object_id DESC LIMIT ${take} OFFSET ${skip}`,params);
    return {items:rows.rows.slice(0,limit).map(row=>entry(row,actor)),nextOffset:rows.rows.length>limit?offset+limit:null};
  }
  async get(actor:Actor|null,id:string,sql:Sql=this.db){
    await this.access.authorizeObject(actor,id,'read',sql);
    const row=(await sql.query(`${select} WHERE e.object_id=$3 AND (${visible} OR (o.owner_id=$1 AND o.state='withdrawn')) AND ${readable}`,[actor?.accountId||null,this.clock(),uuid(id)])).rows[0];requireValue(row,404,'not_found','没有找到这条内容或已失去访问权限。');return entry(row,actor);
  }
  async create(actor:Actor,value:unknown,sql:Sql){
    const input=object(value);onlyKeys(input,['kind','title','body','resourceType','topics','scope','groupId']);
    requireValue(typeof input.kind==='string'&&['post','question','resource'].includes(input.kind),400,'invalid_request','内容类型不正确。');
    const kind=input.kind as Kind,body=bodyText(input.body,'正文',50000),scope=input.scope||'public';
    requireValue(typeof scope==='string'&&['public','self','group'].includes(scope),400,'invalid_request','发布范围不正确。');
    requireValue(kind==='resource'||input.resourceType===undefined,400,'invalid_request','普通动态无需资源类型。');
    const resourceType=kind==='resource'?(input.resourceType||'note'):null;requireValue(resourceType===null||typeof resourceType==='string'&&['note','route','exercise','link','scene'].includes(resourceType),400,'invalid_request','资源类型不正确。');
    const heading=title(input.title)||(kind==='resource'?body.split(/\r?\n/).find(line=>line.trim())!.replace(/^#+\s*/,'').slice(0,100):'');
    const item=await this.access.createObject(actor,{scope,...(input.groupId!==undefined?{groupId:input.groupId}:{})},sql),now=this.clock();
    await sql.query('INSERT INTO community_entries(object_id,kind,title,body,resource_type,topics,created_at,updated_at) VALUES($1,$2,$3,$4,$5,$6,$7,$7)',[item.id,kind,heading,body,resourceType,topics(input.topics),now]);
    if(item.groupId)await sql.query('DELETE FROM group_room_drafts WHERE account_id=$1 AND group_id=$2 AND context=$3',[actor.accountId,item.groupId,'content:'+(kind==='resource'?'resource':'post')]);
    else await sql.query('DELETE FROM account_content_drafts WHERE account_id=$1 AND kind=$2',[actor.accountId,kind==='resource'?'resource':'post']);
    return this.get(actor,item.id,sql);
  }
  async update(actor:Actor,id:string,value:unknown,sql:Sql){
    await this.access.authorizeObject(actor,id,'write',sql);const input=object(value);onlyKeys(input,['title','body','topics']);
    const current=await this.get(actor,id,sql),heading=title(input.title),body=bodyText(input.body,'正文',50000);
    await sql.query('UPDATE community_entries SET title=$2,body=$3,topics=$4,updated_at=$5 WHERE object_id=$1',[id,heading||(current.kind==='resource'?current.title:''),body,topics(input.topics),this.clock()]);
    await sql.query('UPDATE protected_objects SET version=version+1 WHERE id=$1',[id]);return this.get(actor,id,sql);
  }
  async solution(actor:Actor,id:string,value:unknown,sql:Sql){
    const input=object(value);onlyKeys(input,['commentId']);requireValue(input.commentId===null||typeof input.commentId==='string',400,'invalid_request','请选择当前问题的一条解答。');await this.access.assertCapability(actor,'write',sql);
    const current=await this.get(actor,id,sql),item=await this.access.loadObject(id,sql,true);requireValue(current.kind==='question'&&item.state==='visible',400,'invalid_request','只有可见的求助问题可以采纳解答。');
    const role=item.groupId?await this.access.membership(actor,item.groupId,sql):undefined;
    if(item.ownerId!==actor.accountId&&role!=='owner'&&role!=='administrator')await this.access.assertPlatformAdmin(actor,sql);
    if(item.groupId)await this.access.assertGroupWrite(actor,item.groupId,sql);
    const commentId=input.commentId===null?null:uuid(input.commentId,'解答');if(commentId){requireValue((await sql.query('SELECT 1 FROM community_comments WHERE object_id=$1 AND entry_id=$2',[commentId,id])).rowCount,400,'invalid_request','只能采纳当前问题中的解答。');const comment=await this.access.loadObject(commentId,sql,true);requireValue(comment.state==='visible',400,'invalid_request','只能采纳当前问题中可见的解答。');}
    await sql.query('UPDATE community_entries SET accepted_comment_id=$2,accepted_by=$3,solved_at=$4,updated_at=$5 WHERE object_id=$1',[id,commentId,commentId?actor.accountId:null,commentId?this.clock():null,this.clock()]);return this.get(actor,id,sql);
  }
  async withdraw(actor:Actor,id:string,sql:Sql){await this.access.authorizeObject(actor,id,'write',sql);await this.get(actor,id,sql);await sql.query("UPDATE protected_objects SET state='withdrawn',version=version+1 WHERE id=$1",[id]);return {withdrawn:true};}
  async restore(actor:Actor,id:string,sql:Sql){await this.access.assertCapability(actor,'write',sql);const item=await this.access.loadObject(id,sql,true);requireValue(!item.newsArticleId,409,'news_review_required','资讯须通过审核恢复。');requireValue(item.ownerId===actor.accountId&&item.state==='withdrawn',403,'forbidden','只能恢复自己撤回的内容。');if(item.scope==='group')requireValue(await this.access.membership(actor,item.groupId!,sql),403,'forbidden','仅当前群成员可以恢复群内内容。');await sql.query("UPDATE protected_objects SET state='visible',version=version+1 WHERE id=$1",[id]);return this.get(actor,id,sql);}
  async relation(actor:Actor,id:string,kind:'bookmark'|'learning',value:unknown,sql:Sql){
    const input=object(value);onlyKeys(input,['enabled']);requireValue(typeof input.enabled==='boolean',400,'invalid_request','操作状态不正确。');await this.access.assertCapability(actor,'write',sql);
    if(input.enabled){const resource=await this.get(actor,id,sql);requireValue(kind!=='learning'||resource.kind==='resource',400,'invalid_request','仅资源可以加入学习。');}
    const table=kind==='bookmark'?'account_bookmarks':'account_learning_resources';
    if(input.enabled)await sql.query(`INSERT INTO ${table}(account_id,entry_id,created_at) VALUES($1,$2,$3) ON CONFLICT DO NOTHING`,[actor.accountId,uuid(id),this.clock()]);
    else await sql.query(`DELETE FROM ${table} WHERE account_id=$1 AND entry_id=$2`,[actor.accountId,uuid(id)]);
    return {enabled:input.enabled};
  }
  async removeComment(actor:Actor,id:string,sql:Sql){
    await this.access.assertCapability(actor,'write',sql);
    const comment=(await sql.query<{entry_id:string}>('SELECT entry_id FROM community_comments WHERE object_id=$1',[uuid(id,'回应')])).rows[0];requireValue(comment,404,'not_found','没有找到这条回应。');
    const parent=await this.access.authorizeObject(actor,comment.entry_id,'read',sql);requireValue(parent.state==='visible',403,'forbidden','原帖当前不可见，不能继续操作回应。');
    const item=await this.access.loadObject(id,sql,true);requireValue(item.ownerId===actor.accountId,403,'forbidden','只能删除自己的回应。');
    requireValue(item.state==='visible'||item.state==='withdrawn',403,'forbidden','这条回应正在治理处理中。');
    if(item.state!=='withdrawn')await sql.query("UPDATE protected_objects SET state='withdrawn',version=version+1 WHERE id=$1",[id]);
    return {withdrawn:true};
  }
  async comments(actor:Actor|null,id:string,input:{offset?:string;limit?:string}={}){
    await this.get(actor,id);const limit=integer(input.limit,3,50),offset=integer(input.offset,0,100000);requireValue(limit>0,400,'invalid_request','每页至少一条回应。');
    const rows=await this.db.query(`SELECT c.*,COALESCE((SELECT json_agg(json_build_object('id',ia.id,'name',ia.name,'mime',ia.mime,'bytes',ia.bytes)) FROM private_attachments ia WHERE ia.object_id=c.object_id AND ia.state='ready' AND ia.mime IN ('image/png','image/jpeg','image/webp') AND strpos(c.body,'attachment:'||ia.id::text)>0),'[]'::json) AS images,o.owner_id AS author_id,a.display_name,p.bio,p.interests,ra.display_name AS reply_name,false AS followed FROM community_comments c JOIN protected_objects o ON o.id=c.object_id JOIN accounts a ON a.id=o.owner_id LEFT JOIN account_profiles p ON p.account_id=a.id LEFT JOIN community_comments rc ON rc.object_id=c.reply_to_id LEFT JOIN protected_objects ro ON ro.id=rc.object_id LEFT JOIN accounts ra ON ra.id=ro.owner_id WHERE c.entry_id=$3 AND ${visible} AND EXISTS(SELECT 1 FROM protected_objects po WHERE po.id=c.entry_id AND ${visible.replaceAll('o.','po.')} AND ${readable.replaceAll('o.','po.')}) ORDER BY c.created_at,c.position LIMIT $4 OFFSET $5`,[actor?.accountId||null,this.clock(),id,limit+1,offset]);
    return {items:rows.rows.slice(0,limit).map(row=>({id:row.object_id,news:!!row.news_article_id,...(Array.isArray(row.images)&&row.images.length?{images:row.images}:{}),entryId:row.entry_id,replyToId:row.reply_to_id,replyToName:row.reply_name,body:row.body,author:person(row,actor),createdAt:new Date(row.created_at as Date).toISOString()}) as CommunityComment),nextOffset:rows.rows.length>limit?offset+limit:null};
  }
  async comment(actor:Actor,id:string,value:unknown,sql:Sql){
    const input=object(value);onlyKeys(input,['body','replyToId']);const parent=await this.get(actor,id,sql),body=bodyText(input.body,'回应',8000);
    let replyToId:string|null=null;if(input.replyToId){replyToId=uuid(input.replyToId,'回应');await this.access.authorizeObject(actor,replyToId,'read',sql);const reply=(await sql.query('SELECT entry_id FROM community_comments WHERE object_id=$1',[replyToId])).rows[0];requireValue(reply?.entry_id===id,400,'invalid_request','只能回应当前讨论中的评论。');}
    const targets=[...new Set([parent.author.accountId,...(replyToId?[(await sql.query<{owner_id:string}>('SELECT owner_id FROM protected_objects WHERE id=$1',[replyToId])).rows[0].owner_id]:[])])].filter(id=>id!==actor.accountId).sort();
    await lockPeople(sql,[actor.accountId,...targets]);for(const target of targets){await lockPair(sql,actor.accountId,target);await assertUnblocked(sql,actor.accountId,target);}
    const item=await this.access.createObject(actor,{scope:parent.scope,...(parent.groupId?{groupId:parent.groupId}:{})},sql);
    await sql.query('INSERT INTO community_comments(object_id,entry_id,reply_to_id,body,created_at) VALUES($1,$2,$3,$4,$5)',[item.id,id,replyToId,body,this.clock()]);return {id:item.id};
  }
  async people(actor:Actor|null,input:{q?:string;offset?:string;limit?:string;following?:string}={}){
    const limit=integer(input.limit,6,20),offset=integer(input.offset,0,100000);requireValue(limit>0&&(!input.q||input.q.length<=200),400,'invalid_request','搜索参数不正确。');
    requireValue(input.following===undefined||input.following==='true',400,'invalid_request','关注条件不正确。');if(input.following)requireValue(actor,401,'authentication_required','请先登录。');
    const rows=await this.db.query(`SELECT a.id AS author_id,a.display_name,p.bio,p.interests,EXISTS(SELECT 1 FROM account_follows f WHERE f.follower_id=$1 AND f.followed_id=a.id) AS followed FROM accounts a LEFT JOIN account_profiles p ON p.account_id=a.id WHERE ($1::uuid IS NULL OR a.id<>$1) AND strpos(lower(a.display_name||' '||COALESCE(p.bio,'')||' '||COALESCE(array_to_string(p.interests,' '),'')),lower($2))>0 AND (NOT $3 OR EXISTS(SELECT 1 FROM account_follows f WHERE f.follower_id=$1 AND f.followed_id=a.id)) ORDER BY a.created_at DESC,a.id LIMIT $4 OFFSET $5`,[actor?.accountId||null,input.q||'',!!input.following,limit+1,offset]);
    return {items:rows.rows.slice(0,limit).map(row=>person(row,actor)),nextOffset:rows.rows.length>limit?offset+limit:null};
  }
  async publicProfile(actor:Actor|null,id:string){const row=(await this.db.query(`SELECT a.id AS author_id,a.display_name,p.bio,p.interests,EXISTS(SELECT 1 FROM account_follows f WHERE f.follower_id=$1 AND f.followed_id=a.id) AS followed FROM accounts a LEFT JOIN account_profiles p ON p.account_id=a.id WHERE a.id=$2`,[actor?.accountId||null,uuid(id,'用户')])).rows[0];requireValue(row,404,'not_found','没有找到这位用户。');return person(row,actor);}
  async follow(actor:Actor,id:string,value:unknown,sql:Sql){const input=object(value);onlyKeys(input,['enabled']);requireValue(typeof input.enabled==='boolean'&&uuid(id)!==actor.accountId,400,'invalid_request','关注操作不正确。');await lockPair(sql,actor.accountId,id);if(input.enabled)await assertUnblocked(sql,actor.accountId,id);await this.access.assertCapability(actor,'write',sql);requireValue((await sql.query('SELECT id FROM accounts WHERE id=$1',[id])).rows[0],404,'not_found','没有找到这位用户。');if(input.enabled)await sql.query('INSERT INTO account_follows(follower_id,followed_id,created_at) VALUES($1,$2,$3) ON CONFLICT DO NOTHING',[actor.accountId,id,this.clock()]);else await sql.query('DELETE FROM account_follows WHERE follower_id=$1 AND followed_id=$2',[actor.accountId,id]);return {enabled:input.enabled};}
  async draft(actor:Actor,kind:string,sql:Sql=this.db){requireValue(['post','resource'].includes(kind),400,'invalid_request','草稿类型不正确。');const row=(await sql.query('SELECT title,body,topics,scope,resource_type AS "resourceType",stage_id AS "stageId" FROM account_content_drafts WHERE account_id=$1 AND kind=$2',[actor.accountId,kind])).rows[0];if(!row)return {title:'',body:'',topics:[],scope:'public',resourceType:'note'};if(!row.stageId)delete row.stageId;return row;}
  async saveDraft(actor:Actor,kind:string,value:unknown,sql:Sql){await this.access.assertCapability(actor,'write',sql);requireValue(['post','resource'].includes(kind),400,'invalid_request','草稿类型不正确。');const input=object(value);onlyKeys(input,['title','body','topics','scope','resourceType','stageId']);requireValue(typeof input.body==='string'&&input.body.length<=50000&&!input.body.includes('\u0000'),400,'invalid_request','草稿正文过长。');const scope=input.scope??'public',resourceType=input.resourceType??'note';const stageId=input.stageId?uuid(input.stageId):null;if(stageId)requireValue((await sql.query('SELECT 1 FROM resource_upload_stages WHERE object_id=$1 AND owner_id=$2 AND published_entry_id IS NULL',[stageId,actor.accountId])).rowCount,403,'forbidden','文件草稿不属于当前账号。');requireValue(scope==='public'||scope==='self',400,'invalid_request','草稿范围不正确。');requireValue(typeof resourceType==='string'&&['note','route','exercise','link','scene'].includes(resourceType),400,'invalid_request','资源类型不正确。');await sql.query('INSERT INTO account_content_drafts(account_id,kind,title,body,topics,scope,resource_type,stage_id,updated_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT(account_id,kind) DO UPDATE SET title=EXCLUDED.title,body=EXCLUDED.body,topics=EXCLUDED.topics,scope=EXCLUDED.scope,resource_type=EXCLUDED.resource_type,stage_id=EXCLUDED.stage_id,updated_at=EXCLUDED.updated_at',[actor.accountId,kind,title(input.title),input.body,topics(input.topics),scope,resourceType,stageId,this.clock()]);return this.draft(actor,kind,sql);}
}
