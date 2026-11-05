import type {Database,Sql} from './db.js';
import {AccessService,uuid} from './access.js';
import {object,onlyKeys,requireValue} from './errors.js';
import type {FileService} from './files.js';
import {inspectResource} from './resourceFormat.js';
import type {Actor,Clock} from './types.js';
import {systemClock} from './types.js';
import type {ContentService} from './content.js';
import {NEWS_SOURCE_PRESETS} from './newsFeed.js';

const page=(value:string|undefined)=>{const n=Number(value||0);requireValue(Number.isSafeInteger(n)&&n>=0&&n<=100000,400,'invalid_request','分页参数不正确。');return n;};
const images=(body:string)=>[...new Set(Array.from(body.matchAll(/!\[[^\]]*\]\(attachment:([\da-f-]{36})\)/gi),match=>uuid(match[1])))];
type NewsRow={id:string;kind:string;origin:string;version:number;latest_revision_id:string;published_revision_id:string|null;owner_id:string;object_state:string;withdrawn_by:string|null;withdrawn_action:'author'|'moderator'|null};
export class NewsService {
  constructor(readonly db:Database,readonly access:AccessService,readonly files:FileService,readonly content:ContentService,readonly clock:Clock=systemClock){}
  // Keep the parent state locked with the article: governance changes the same
  // protected_objects row and must not be overwritten by a stale publication read.
  private async row(id:string,sql:Sql=this.db,lock=false){const row=(await sql.query<NewsRow>(`SELECT n.*,o.owner_id,o.state AS object_state FROM news_articles n JOIN protected_objects o ON o.id=n.id WHERE n.id=$1${lock?' FOR UPDATE OF n,o':''}`,[uuid(id)])).rows[0];requireValue(row,404,'not_found','没有找到这篇稿件。');return row;}
  private version(row:NewsRow,input:Record<string,unknown>){requireValue(Number.isInteger(input.expectedVersion)&&input.expectedVersion===row.version,409,'version_conflict','稿件已经变化，请重新读取后再操作。');}
  private async author(actor:Actor,id:string,sql:Sql){await this.access.assertCapability(actor,'write',sql);const row=await this.row(id,sql,true);requireValue(row.owner_id===actor.accountId,403,'forbidden','只能编辑自己的稿件。');requireValue(row.origin!=='feed',409,'feed_snapshot_sealed','原站收录摘要为固定待审快照，请通过审核处理。');if(row.kind!=='news')await this.access.assertPlatformAdmin(actor,sql);return row;}
  private sourceFields(source:{source_id:string|null;source_published_at:Date|null;source_date_label:string|null}){return {sourceName:source.source_id?NEWS_SOURCE_PRESETS.find(p=>p.id===source.source_id)?.name||null:null,sourcePublishedAt:source.source_published_at?new Date(source.source_published_at).toISOString():null,sourceDateLabel:source.source_date_label};}
  private async sourceInfo(id:string,sql:Sql=this.db){return this.sourceFields((await sql.query<{source_id:string|null;source_published_at:Date|null;source_date_label:string|null}>('SELECT source_id,source_published_at,source_date_label FROM news_articles WHERE id=$1',[id])).rows[0]);}
  private async event(actor:Actor,row:NewsRow,action:string,sql:Sql,reason='',revisionId=row.latest_revision_id){await sql.query('INSERT INTO news_events(article_id,revision_id,actor_id,action,reason,created_at) VALUES($1,$2,$3,$4,$5,$6)',[row.id,revisionId,actor.accountId,action,reason,this.clock()]);}
  private fields(value:Record<string,unknown>){
    const body=value.body??'',title=value.title??'',topics=value.topics??[],source=value.sourceUrl??'';
    requireValue(typeof body==='string'&&body.length<=40000&&!body.includes('\0')&&typeof title==='string'&&title.length<=160&&!/[\u0000-\u001f\u007f]/.test(title),400,'invalid_request','标题最多 160 字，正文最多 40000 字。');
    requireValue(Array.isArray(topics)&&topics.length<=3&&topics.every(v=>typeof v==='string'&&v.length<=30&&!/[\u0000-\u001f\u007f]/.test(v)),400,'invalid_request','最多选择三个话题。');
    requireValue(typeof source==='string'&&source.length<=2000,400,'invalid_request','原文链接过长。');let sourceUrl=source.trim();if(!sourceUrl&&/^https?:\/\/\S+$/.test(body.trim()))sourceUrl=body.trim();
    if(sourceUrl){let url:URL;try{url=new URL(sourceUrl);}catch{requireValue(false,400,'invalid_request','请填写完整的原文链接。');}requireValue(['https:','http:'].includes(url!.protocol)&&!url!.username&&!url!.password,400,'invalid_request','原文仅支持不含账号密码的 HTTP(S) 链接。');sourceUrl=url!.href;}
    return {title:title.trim(),body,topics:[...new Set(topics.map(v=>String(v).trim()).filter(Boolean))],sourceUrl};
  }
  private async bindImages(actor:Actor,row:NewsRow,revisionId:string,stageValue:unknown,body:string,sql:Sql){
    const ids=images(body);requireValue(ids.length<=8,400,'file_limit','每篇最多插入 8 张图片。');const stageId=stageValue?uuid(stageValue):null;
    if(stageId){await this.access.authorizeObject(actor,stageId,'write',sql);requireValue((await sql.query('SELECT 1 FROM resource_upload_stages WHERE object_id=$1 AND owner_id=$2 AND published_entry_id IS NULL AND news_revision_id IS NULL FOR UPDATE',[stageId,actor.accountId])).rowCount,403,'forbidden','图片草稿不属于当前账号或已使用。');}
    const staged=stageId?(await sql.query('SELECT f.attachment_id AS id,f.role,a.state FROM resource_stage_files f JOIN private_attachments a ON a.id=f.attachment_id WHERE f.stage_id=$1 AND NOT f.removed',[stageId])).rows:[];
    requireValue(staged.every(file=>file.role==='image'&&file.state==='ready'),400,'invalid_image','请等待正文图片上传完成。');
    for(const id of ids){const saved=await this.files.readReady(actor,id,sql);const inherited=(await sql.query('SELECT 1 FROM news_revisions WHERE id=$1 AND article_id=$2',[saved.objectId,row.id])).rowCount;
      requireValue(!!inherited||!!stageId&&saved.objectId===stageId&&staged.some(file=>file.id===id),403,'forbidden','不能引用其他稿件或账号的私有图片。');requireValue(['image/png','image/jpeg','image/webp'].includes(saved.mime),400,'invalid_image','正文只支持 PNG、JPG、WebP 图片。');try{inspectResource(saved.buffer,saved.name,saved.mime);}catch{requireValue(false,400,'invalid_image','图片内容无法读取。');}
    }
    // Only a mutable draft's own, unshared images may be deleted. Images inherited
    // from a submitted/published revision remain available to its review history.
    const removed=(await sql.query<{id:string}>(`SELECT a.id FROM news_revision_images i JOIN private_attachments a ON a.id=i.attachment_id
      WHERE i.revision_id=$1 AND a.object_id=$1 AND a.owner_id=$2 AND a.state='ready' AND NOT a.id=ANY($3::uuid[])
      AND NOT EXISTS(SELECT 1 FROM news_revision_images other WHERE other.attachment_id=a.id AND other.revision_id<>$1)`,[revisionId,actor.accountId,ids])).rows;
    await sql.query('DELETE FROM news_revision_images WHERE revision_id=$1',[revisionId]);for(const id of ids)await sql.query('INSERT INTO news_revision_images(revision_id,attachment_id) VALUES($1,$2)',[revisionId,id]);
    for(const file of removed)await this.files.discardDraft(actor,file.id,revisionId,sql);
    if(stageId){for(const file of staged.filter(file=>!ids.includes(String(file.id))))await this.files.discardDraft(actor,String(file.id),stageId,sql);await sql.query('UPDATE private_attachments SET object_id=$1 WHERE object_id=$2 AND id=ANY($3::uuid[])',[revisionId,stageId,ids]);await sql.query('UPDATE resource_upload_stages SET news_revision_id=$2 WHERE object_id=$1',[stageId,revisionId]);}
  }
  async save(actor:Actor,id:string|undefined,value:unknown,sql:Sql){
    const input=object(value);onlyKeys(input,['expectedVersion','kind','title','body','topics','sourceUrl','stageId']);const fields=this.fields(input);let row:NewsRow;
    if(!id){const kind=input.kind??'news';requireValue(['news','article','announcement'].includes(String(kind)),400,'invalid_request','稿件类型不正确。');if(kind!=='news')await this.access.assertPlatformAdmin(actor,sql);await this.access.assertCapability(actor,'write',sql);if(kind!=='news')await this.access.assertPlatformAdmin(actor,sql);
      requireValue(Number((await sql.query("SELECT count(*)::int AS n FROM news_articles n JOIN protected_objects o ON o.id=n.id JOIN news_revisions r ON r.id=n.latest_revision_id WHERE o.owner_id=$1 AND n.origin<>'feed' AND r.state IN ('draft','pending','returned')",[actor.accountId])).rows[0].n)<20,409,'draft_limit','待处理稿件已达 20 篇，请先完成已有稿件。');
      const parent=await this.access.createObject(actor,{scope:'self'},sql);await sql.query('INSERT INTO news_articles(id,kind,origin,created_at,updated_at) VALUES($1,$2,$3,$4,$4)',[parent.id,kind,actor.role==='administrator'&&actor.mfaVerified?'manual':'user',this.clock()]);await sql.query('UPDATE protected_objects SET news_article_id=id WHERE id=$1',[parent.id]);row=await this.row(parent.id,sql,true);
    }else{row=await this.author(actor,id,sql);this.version(row,input);requireValue(input.kind===undefined||input.kind===row.kind,400,'invalid_request','修改稿件不能更换官方身份。');}
    let revisionId=row.latest_revision_id,previous=revisionId?(await sql.query('SELECT state,number FROM news_revisions WHERE id=$1',[revisionId])).rows[0]:undefined;
    requireValue(previous?.state!=='pending',409,'review_pending','请先撤回待审版本，再修改稿件。');
    if(!previous||previous.state!=='draft'){
      revisionId=(await this.access.createObject(actor,{scope:'self'},sql)).id;await sql.query('INSERT INTO news_revisions(id,article_id,number,state,created_at) VALUES($1,$2,$3,\'draft\',$4)',[revisionId,row.id,Number(previous?.number||0)+1,this.clock()]);await sql.query('UPDATE protected_objects SET news_article_id=$2 WHERE id=$1',[revisionId,row.id]);
    }
    await this.bindImages(actor,row,revisionId,input.stageId,fields.body,sql);await sql.query('UPDATE news_revisions SET title=$2,body=$3,topics=$4,source_url=$5 WHERE id=$1',[revisionId,fields.title,fields.body,fields.topics,fields.sourceUrl]);
    await sql.query('UPDATE news_articles SET latest_revision_id=$2,version=version+1,updated_at=$3 WHERE id=$1',[row.id,revisionId,this.clock()]);return this.privateDetail(actor,row.id,sql);
  }
  async privateDetail(actor:Actor,id:string,sql:Sql=this.db,review=false){
    const row=await this.row(id,sql);if(review||row.origin==='feed')await this.access.assertPlatformAdmin(actor,sql);else requireValue(row.owner_id===actor.accountId,403,'forbidden','只能查看自己的投稿。');
    let revision=(await sql.query('SELECT id,number,state,title,body,topics,source_url AS "sourceUrl",reason,submitted_at AS "submittedAt" FROM news_revisions WHERE id=$1',[row.latest_revision_id])).rows[0];
    if(review&&revision?.state==='draft'&&row.published_revision_id)revision=(await sql.query('SELECT id,number,state,title,body,topics,source_url AS "sourceUrl",reason,submitted_at AS "submittedAt" FROM news_revisions WHERE id=$1',[row.published_revision_id])).rows[0];
    requireValue(revision&&(!review||revision.state!=='draft'),403,'forbidden','私人草稿尚未提交审核。');
    const files=(await sql.query('SELECT a.id,a.name,a.mime,a.bytes::int AS bytes FROM news_revision_images i JOIN private_attachments a ON a.id=i.attachment_id AND a.state=\'ready\' WHERE i.revision_id=$1',[revision.id])).rows;
    const author=(await sql.query('SELECT display_name AS "displayName" FROM accounts WHERE id=$1',[row.owner_id])).rows[0];
    return {id:row.id,version:row.version,kind:row.kind,origin:row.origin,...await this.sourceInfo(row.id,sql),author:{accountId:row.owner_id,displayName:author.displayName},published:!!row.published_revision_id&&row.object_state==='visible',withdrawn:row.object_state==='withdrawn',revision:{...revision,images:files},events:(await sql.query('SELECT e.position::text,e.action,e.reason,e.created_at AS "createdAt",a.display_name AS "actorName" FROM news_events e JOIN accounts a ON a.id=e.actor_id WHERE e.article_id=$1 ORDER BY e.position DESC LIMIT 30',[row.id])).rows};
  }
  async list(actor:Actor|null,input:{view?:string;offset?:string;q?:string;kind?:string}){
    const view=input.view||'news',offset=page(input.offset),q=input.q||'';requireValue(q.length<=200&&['news','official','mine','queue'].includes(view),400,'invalid_request','资讯筛选不正确。');
    if(view==='queue'){requireValue(actor,401,'authentication_required','请先登录。');await this.access.assertPlatformAdmin(actor);}
    if(view==='mine')requireValue(actor,401,'authentication_required','请先登录。');
    const privateView=view==='mine'||view==='queue',size=privateView?10:3,params:unknown[]=[q,offset,size+1];
    let filter="r.state='pending'";
    if(view==='mine'){params.push(actor!.accountId);filter="o.owner_id=$4 AND n.origin<>'feed'";}
    if(!privateView){params.push(this.clock());filter="o.scope='public' AND (o.state='visible' OR o.state='restricted' AND o.restricted_until<=$4) AND "+(view==='official'?"n.kind IN ('article','announcement')":"n.kind='news'");}
    const rows=(await this.db.query(`SELECT n.id,n.kind,n.origin,n.version,n.source_id,n.source_published_at,n.source_date_label,n.published_at AS "publishedAt",r.title,r.body,r.state,r.reason,r.source_url AS "sourceUrl",r.topics,o.owner_id AS "authorId",a.display_name AS "authorName" FROM news_articles n JOIN protected_objects o ON o.id=n.id JOIN accounts a ON a.id=o.owner_id JOIN news_revisions r ON r.id=${privateView?'n.latest_revision_id':'n.published_revision_id'} WHERE ${filter} AND strpos(lower(r.title||' '||r.body||' '||a.display_name||' '||array_to_string(r.topics,' ')),lower($1))>0 ORDER BY ${privateView?'n.updated_at':'n.published_at'} DESC,n.id DESC LIMIT $3 OFFSET $2`,params)).rows;
    return {items:rows.slice(0,size).map(({body,reason,state,version,source_id,source_published_at,source_date_label,...row})=>({...row,...this.sourceFields({source_id:source_id as string|null,source_published_at:source_published_at as Date|null,source_date_label:source_date_label as string|null}),...(privateView?{reason,state,version}:{}),summary:String(body).replace(/!\[[^\]]*\]\([^)]*\)/g,'').replace(/[#*_`>\[\]]/g,'').slice(0,140)})),nextOffset:rows.length>size?offset+size:null};
  }
  async submit(actor:Actor,id:string,value:unknown,sql:Sql){const input=object(value);onlyKeys(input,['expectedVersion']);const row=await this.author(actor,id,sql);this.version(row,input);const revision=(await sql.query('SELECT * FROM news_revisions WHERE id=$1',[row.latest_revision_id])).rows[0];requireValue(revision.state==='draft'&&(String(revision.body).trim()||revision.source_url),400,'invalid_request','写下正文或粘贴原文链接后再提交。');const title=revision.title||String(revision.body).replace(/!\[[^\]]*\]\([^)]*\)/g,'').split('\n').find((s:string)=>s.trim())?.replace(/^[#*>\s]+/,'').slice(0,160)||(revision.source_url?new URL(String(revision.source_url)).hostname:'图文分享');await sql.query("UPDATE news_revisions SET state='pending',title=$2,submitted_at=$3,reason='' WHERE id=$1",[revision.id,title,this.clock()]);await sql.query('UPDATE news_articles SET version=version+1,updated_at=$2 WHERE id=$1',[id,this.clock()]);await this.event(actor,row,'submit',sql);return this.privateDetail(actor,id,sql);}
  async withdraw(actor:Actor,id:string,value:unknown,sql:Sql){
    const input=object(value);onlyKeys(input,['expectedVersion','target']);const row=await this.author(actor,id,sql);this.version(row,input);requireValue(input.target==='pending'||input.target==='published',400,'invalid_request','撤回对象不正确。');let latest=row.latest_revision_id;
    if(input.target==='pending'){
      requireValue((await sql.query("UPDATE news_revisions SET state='withdrawn' WHERE id=$1 AND state='pending'",[row.latest_revision_id])).rowCount,409,'conflict','当前没有待审核的版本。');
      // Submitted snapshots remain sealed, including their image references and
      // submission time. Editing continues in a separate numbered draft.
      latest=(await this.access.createObject(actor,{scope:'self'},sql)).id;
      await sql.query("INSERT INTO news_revisions(id,article_id,number,state,title,body,topics,source_url,created_at) SELECT $2,article_id,number+1,'draft',title,body,topics,source_url,$3 FROM news_revisions WHERE id=$1",[row.latest_revision_id,latest,this.clock()]);
      await sql.query('UPDATE protected_objects SET news_article_id=$2 WHERE id=$1',[latest,row.id]);
      await sql.query('INSERT INTO news_revision_images(revision_id,attachment_id) SELECT $2,attachment_id FROM news_revision_images WHERE revision_id=$1',[row.latest_revision_id,latest]);
      // Reusing a retained image in a later submission must not revive a grant
      // issued for this now-withdrawn review snapshot.
      await sql.query(`DELETE FROM attachment_download_grants g USING accounts a WHERE g.account_id=a.id AND a.role='administrator' AND g.account_id<>$2 AND g.attachment_id IN(SELECT attachment_id FROM news_revision_images WHERE revision_id=$1)`,[row.latest_revision_id,row.owner_id]);
    }else{
      requireValue(row.published_revision_id&&row.object_state==='visible',409,'conflict','当前没有可撤回的公开版本。');await sql.query("UPDATE protected_objects SET state='withdrawn',version=version+1 WHERE id=$1",[id]);await sql.query("UPDATE news_articles SET withdrawn_by=$2,withdrawn_action='author' WHERE id=$1",[id,actor.accountId]);
    }
    await sql.query('UPDATE news_articles SET latest_revision_id=$2,version=version+1,updated_at=$3 WHERE id=$1',[id,latest,this.clock()]);await this.event(actor,row,'withdraw_'+input.target,sql,'',input.target==='pending'?row.latest_revision_id:row.published_revision_id!);return this.privateDetail(actor,id,sql);
  }
  async review(actor:Actor,id:string,value:unknown,sql:Sql){
    const input=object(value);onlyKeys(input,['expectedVersion','revisionId','action','reason']);await this.access.assertPlatformAdmin(actor,sql);await this.access.assertCapability(actor,'write',sql);await this.access.assertPlatformAdmin(actor,sql);const row=await this.row(id,sql,true);this.version(row,input);requireValue(input.revisionId===row.latest_revision_id||['down','restore'].includes(String(input.action))&&input.revisionId===row.published_revision_id,409,'version_conflict','审核版本已经变化。');const action=input.action,reason=input.reason??'';requireValue(['publish','return','reject','down','restore'].includes(String(action))&&typeof reason==='string'&&reason.length<=2000,400,'invalid_request','审核操作或说明不正确。');if(action!=='publish')requireValue(reason.trim(),400,'invalid_request','请说明处理原因。');
    requireValue(row.origin!=='feed'||action!=='return',409,'feed_snapshot_sealed','原站摘要不能退回作者修改，请选择审核发布或不予采用。');
    const r=(await sql.query('SELECT * FROM news_revisions WHERE id=$1',[row.latest_revision_id])).rows[0];
    if(['publish','return','reject'].includes(String(action))){requireValue(r.state==='pending',409,'conflict','只有当前待审核的版本可以处理。');if(action==='publish'){
      requireValue(row.object_state!=='restricted',403,'forbidden','请先通过原治理工单解除限制。');
      await sql.query("INSERT INTO community_entries(object_id,kind,title,body,topics,created_at,updated_at) VALUES($1,'post',$2,$3,$4,$5,$5) ON CONFLICT(object_id) DO UPDATE SET title=EXCLUDED.title,body=EXCLUDED.body,topics=EXCLUDED.topics,updated_at=EXCLUDED.updated_at",[id,r.title,r.body,r.topics,this.clock()]);await sql.query("UPDATE protected_objects SET scope='public',state='visible',version=version+1 WHERE id=$1",[id]);await sql.query('UPDATE news_articles SET published_revision_id=$2,published_at=COALESCE(published_at,$3),withdrawn_by=NULL,withdrawn_action=NULL WHERE id=$1',[id,r.id,this.clock()]);
    }await sql.query('UPDATE news_revisions SET state=$2,reason=$3 WHERE id=$1',[r.id,action==='publish'?'approved':action==='return'?'returned':'rejected',reason.trim()]);
    }else{requireValue(row.published_revision_id,409,'conflict','这篇稿件尚未公开。');if(action==='down'){requireValue(row.object_state==='visible',409,'conflict','当前公开版本已不可见。');await sql.query("UPDATE protected_objects SET state='withdrawn',version=version+1 WHERE id=$1",[id]);await sql.query("UPDATE news_articles SET withdrawn_by=$2,withdrawn_action='moderator' WHERE id=$1",[id,actor.accountId]);}else{requireValue(row.object_state==='withdrawn'&&row.withdrawn_action==='moderator',409,'conflict','作者主动撤回的内容须由作者重新提交。');await sql.query("UPDATE protected_objects SET state='visible',version=version+1 WHERE id=$1",[id]);await sql.query('UPDATE news_articles SET withdrawn_by=NULL,withdrawn_action=NULL WHERE id=$1',[id]);}}
    await sql.query('UPDATE news_articles SET version=version+1,updated_at=$2 WHERE id=$1',[id,this.clock()]);await this.event(actor,row,String(action),sql,reason.trim(),['down','restore'].includes(String(action))?row.published_revision_id!:String(r.id));return this.privateDetail(actor,id,sql,true);
  }
  async publicDetail(actor:Actor|null,id:string){const row=await this.row(id);requireValue(row.published_revision_id,404,'not_found','这篇稿件尚未发布。');const parent=await this.access.authorizeObject(actor,id,'read');requireValue(parent.scope==='public'&&parent.state==='visible',403,'forbidden','这篇内容已撤回或暂不可见。');const revision=(await this.db.query('SELECT source_url AS "sourceUrl",number FROM news_revisions WHERE id=$1',[row.published_revision_id])).rows[0];return {kind:row.kind,origin:row.origin,...await this.sourceInfo(id),...revision,entry:await this.content.get(actor,id)};}
}
