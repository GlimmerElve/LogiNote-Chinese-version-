import {randomUUID} from 'node:crypto';
import type {Database,Sql} from './db.js';
import {AccessService} from './access.js';
import {ApiError,object,onlyKeys,requireValue} from './errors.js';
import type {Actor,Clock} from './types.js';
import {systemClock} from './types.js';
import type {NewsService} from './news.js';
import {NEWS_FEED_LIMITS,NEWS_SOURCE_PRESETS,parseNewsFeed,type NewsSourcePreset,type ParsedFeedItem} from './newsFeed.js';
import {fetchNewsFeed,type NewsFeedFetcher} from './newsFeedFetch.js';

type SourceRow={id:string;enabled:boolean;interval_minutes:number;version:number;authorized_by:string|null;authorized_at:Date|null;last_attempt_at:Date|null;last_success_at:Date|null;next_check_at:Date|null;last_status:string;last_error:string;consecutive_failures:number;imported_count:number;etag:string|null;last_modified:string|null;backlog:ParsedFeedItem[];lease_token:string|null;lease_until:Date|null};
export type NewsSourceView={id:string;name:string;url:string;description:string;recommended:boolean;enabled:boolean;intervalMinutes:number;version:number;lastAttemptAt:string|null;lastSuccessAt:string|null;nextCheckAt:string|null;lastStatus:string;lastError:string;consecutiveFailures:number;importedCount:number;authorizedBy:string|null;authorizedAt:string|null;lastRun?:{status:string;imported:number;duplicates:number;ignored:number;message:string;finishedAt:string|null}|null};
export type NewsCollectResult={status:'collected'|'not_modified'|'skipped'|'failed';reason?:string;imported:number;duplicates:number;ignored:number;nextCheckAt:string|null};
const iso=(value:Date|null)=>value?new Date(value).toISOString():null;
const result=(reason:string,next:Date|null=null):NewsCollectResult=>({status:'skipped',reason,imported:0,duplicates:0,ignored:0,nextCheckAt:iso(next)});
const escapeMarkdown=(value:string)=>value.replace(/[\\`*_{}\[\]()#+.!<>|~-]/g,'\\$&');
export class NewsSourceService {
  private active=new Map<string,AbortController>();
  private jobs=new Set<Promise<NewsCollectResult>>();
  private stopped=false;
  constructor(readonly db:Database,readonly access:AccessService,readonly news:NewsService,readonly clock:Clock=systemClock,readonly fetcher:NewsFeedFetcher=fetchNewsFeed){}
  private preset(id:string):NewsSourcePreset {const source=NEWS_SOURCE_PRESETS.find(value=>value.id===id);requireValue(source,404,'not_found','没有找到这个预设资讯源。');return source;}
  private async row(id:string,sql:Sql=this.db,lock=false){this.preset(id);const row=(await sql.query<SourceRow>('SELECT * FROM news_sources WHERE id=$1'+(lock?' FOR UPDATE':''),[id])).rows[0];requireValue(row,404,'not_found','资讯源配置不存在，请先完成数据库更新。');return row;}
  private view(row:SourceRow):NewsSourceView {const source=this.preset(row.id);return {id:row.id,name:source.name,url:source.url,description:source.description,recommended:source.recommended,enabled:row.enabled,intervalMinutes:row.interval_minutes,version:row.version,lastAttemptAt:iso(row.last_attempt_at),lastSuccessAt:iso(row.last_success_at),nextCheckAt:iso(row.next_check_at),lastStatus:row.last_status,lastError:row.last_error,consecutiveFailures:row.consecutive_failures,importedCount:row.imported_count,authorizedBy:row.authorized_by,authorizedAt:iso(row.authorized_at)};}
  private day(){return this.clock().toISOString().slice(0,10);}
  async list(actor:Actor){await this.access.assertPlatformAdmin(actor);const rows=(await this.db.query<SourceRow>('SELECT * FROM news_sources ORDER BY id')).rows,usage=(await this.db.query<{day:string;requests:number;bytes:string}>('SELECT day::text,requests,bytes::text FROM news_source_usage WHERE day=$1',[this.day()])).rows[0],runs=(await this.db.query<{source_id:string;status:string;imported:number;duplicates:number;ignored:number;message:string;finished_at:Date|null}>('SELECT DISTINCT ON(source_id) source_id,status,imported,duplicates,ignored,message,finished_at FROM news_source_runs ORDER BY source_id,started_at DESC,id DESC')).rows;return {items:NEWS_SOURCE_PRESETS.flatMap(p=>{const row=rows.find(r=>r.id===p.id),run=runs.find(r=>r.source_id===p.id);return row?[{...this.view(row),lastRun:run?{status:run.status,imported:run.imported,duplicates:run.duplicates,ignored:run.ignored,message:run.message,finishedAt:iso(run.finished_at)}:null}]:[];}),limits:NEWS_FEED_LIMITS,usage:{day:this.day(),requests:usage?.requests||0,bytes:Number(usage?.bytes||0)}};}
  async save(actor:Actor,id:string,value:unknown,sql:Sql){
    const input=object(value);onlyKeys(input,['expectedVersion','enabled','intervalMinutes']);requireValue(typeof input.enabled==='boolean'&&Number.isSafeInteger(input.expectedVersion),400,'invalid_request','资讯源启停或版本不正确。');const minutes=input.intervalMinutes??360;requireValue(Number.isSafeInteger(minutes)&&Number(minutes)>=60&&Number(minutes)<=10080,400,'invalid_request','采集间隔应为 60 至 10080 分钟。');
    await this.access.assertPlatformAdmin(actor,sql);await this.access.assertCapability(actor,'write',sql);await this.access.assertPlatformAdmin(actor,sql);const row=await this.row(id,sql,true);requireValue(row.version===input.expectedVersion,409,'version_conflict','来源配置已变化，请重新读取。');
    // Pausing, resuming and lowering the interval must not reset an already
    // established request deadline or a failed source's retry backoff.
    const now=this.clock(),next=input.enabled?new Date(Math.max(now.getTime(),row.next_check_at?new Date(row.next_check_at).getTime():0,row.last_attempt_at?new Date(row.last_attempt_at).getTime()+Number(minutes)*60000:0)):row.next_check_at;
    await sql.query(`UPDATE news_sources SET enabled=$2,interval_minutes=$3,version=version+1,authorized_by=CASE WHEN $2 THEN $4 ELSE authorized_by END,authorized_at=CASE WHEN $2 THEN $5 ELSE authorized_at END,next_check_at=$6,last_status=CASE WHEN $2 THEN 'idle' ELSE 'paused' END,last_error='' WHERE id=$1`,[id,input.enabled,minutes,actor.accountId,now,next]);
    await sql.query('INSERT INTO news_source_events(source_id,actor_id,enabled,interval_minutes,created_at) VALUES($1,$2,$3,$4,$5)',[id,actor.accountId,input.enabled,minutes,now]);return this.view(await this.row(id,sql));
  }
  /** Persistent authorization is separate from a live browser session. It was
   * granted by an MFA-verified administrator, but every run rechecks that the
   * account still has administrator/write authority. No synthetic MFA actor. */
  private async authorized(row:SourceRow,sql:Sql,lock=false):Promise<boolean>{if(!row.authorized_by||!row.authorized_at)return false;const account=(await sql.query<{role:string}>('SELECT role FROM accounts WHERE id=$1'+(lock?' FOR UPDATE':''),[row.authorized_by])).rows[0];if(account?.role!=='administrator')return false;return !(await sql.query("SELECT 1 FROM account_restrictions WHERE account_id=$1 AND capability='write' AND revoked_at IS NULL AND starts_at<=$2 AND expires_at>$2 LIMIT 1",[row.authorized_by,this.clock()])).rowCount;}
  private async reserve(){
    const day=this.day(),max=NEWS_FEED_LIMITS.maxFeedBytes;
    await this.db.transaction(async sql=>{await sql.query('INSERT INTO news_source_usage(day) VALUES($1) ON CONFLICT DO NOTHING',[day]);const usage=(await sql.query<{requests:number;bytes:string}>('SELECT requests,bytes::text FROM news_source_usage WHERE day=$1 FOR UPDATE',[day])).rows[0];requireValue(usage.requests<NEWS_FEED_LIMITS.maxRequestsPerDay&&Number(usage.bytes)+max<=NEWS_FEED_LIMITS.maxBytesPerDay,429,'feed_budget','今日资讯采集请求或流量已达上限，稍后自动恢复。');await sql.query('UPDATE news_source_usage SET requests=requests+1,bytes=bytes+$2 WHERE day=$1',[day,max]);});
    let settled=false;return async(actualBytes:number)=>{if(settled)return;settled=true;await this.db.query('UPDATE news_source_usage SET bytes=bytes-$2 WHERE day=$1',[day,Math.max(0,max-Math.max(0,Math.min(max,actualBytes)))]);};
  }
  async collect(actor:Actor,id:string):Promise<NewsCollectResult>{await this.access.assertPlatformAdmin(actor);await this.access.assertCapability(actor,'write');return this.run(id,actor);}
  async tick():Promise<NewsCollectResult[]>{if(this.stopped)return [];const due=(await this.db.query<{id:string}>('SELECT id FROM news_sources WHERE enabled AND (next_check_at IS NULL OR next_check_at<=$1) AND (lease_until IS NULL OR lease_until<=$1) ORDER BY next_check_at NULLS FIRST,id LIMIT 2',[this.clock()])).rows;const results:NewsCollectResult[]=[];for(const row of due){if(this.stopped)break;results.push(await this.run(row.id));}return results;}
  async stop(){this.stopped=true;for(const controller of this.active.values())controller.abort();await Promise.allSettled([...this.jobs]);}
  private async claim(id:string,actor?:Actor):Promise<{row:SourceRow;token:string}|NewsCollectResult>{
    const initial=await this.row(id),token=randomUUID();return this.db.transaction(async sql=>{
      // Lock accounts before the source, matching configuration and governance.
      const valid=await this.authorized(initial,sql,true);if(actor)await this.access.assertPlatformAdmin(actor,sql);const row=await this.row(id,sql,true),now=this.clock();
      if(!row.enabled)return result('此来源已暂停，请先启用。',row.next_check_at);
      if(row.authorized_by!==initial.authorized_by)return result('来源授权已变化，请重试。',row.next_check_at);
      if(!valid){await sql.query("UPDATE news_sources SET enabled=false,version=version+1,last_status='authorization_expired',last_error='授权管理员已失去管理或写入权限，请由管理员重新启用。' WHERE id=$1",[id]);return result('来源授权已失效，请由管理员重新启用。');}
      if(row.lease_until&&new Date(row.lease_until)>now)return result('此来源正在采集。',row.next_check_at);
      if(row.next_check_at&&new Date(row.next_check_at)>now)return result('尚未到下次采集时间。',row.next_check_at);
      if(row.lease_token)await sql.query("UPDATE news_source_runs SET status='interrupted',finished_at=$2,message='上次采集已中断，已重新尝试。' WHERE id=$1 AND finished_at IS NULL",[row.lease_token,now]);
      const next=new Date(now.getTime()+row.interval_minutes*60000);await sql.query("UPDATE news_sources SET lease_token=$2,lease_until=$3,last_attempt_at=$4,next_check_at=$5,last_status='collecting',last_error='' WHERE id=$1",[id,token,new Date(now.getTime()+5*60000),now,next]);await sql.query('INSERT INTO news_source_runs(id,source_id,actor_id,started_at) VALUES($1,$2,$3,$4)',[token,id,actor?.accountId||row.authorized_by,now]);return {row:{...row,next_check_at:next},token};
    });
  }
  private async importItem(row:SourceRow,item:ParsedFeedItem,sql:Sql){
    // Reserve *both* independently, even if either was already seen. In
    // particular a cross-source URL collision still creates its GUID alias,
    // and a known GUID's changed URL is still tombstoned across all sources.
    const guid=await sql.query('INSERT INTO news_source_guids(source_id,guid_hash,first_seen_at) VALUES($1,$2,$3) ON CONFLICT DO NOTHING RETURNING guid_hash',[row.id,item.guidHash,this.clock()]);
    const itemId=randomUUID(),insert=await sql.query('INSERT INTO news_source_items(id,source_id,guid_hash,url_hash,first_seen_at) VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING RETURNING id',[itemId,row.id,item.guidHash,item.urlHash,this.clock()]);if(!guid.rowCount||!insert.rowCount)return false;
    const actor:Actor={accountId:row.authorized_by!,role:'administrator',mfaVerified:false},article=await this.access.createObject(actor,{scope:'self'},sql),revision=await this.access.createObject(actor,{scope:'self'},sql),preset=this.preset(row.id),now=this.clock();
    await sql.query("INSERT INTO news_articles(id,kind,origin,created_at,updated_at,source_id,source_published_at,source_date_label) VALUES($1,'news','feed',$2,$2,$3,$4,$5)",[article.id,now,row.id,item.publishedAt,item.dateLabel]);
    await sql.query("INSERT INTO news_revisions(id,article_id,number,state,title,body,topics,source_url,created_at,submitted_at) VALUES($1,$2,1,'pending',$3,$4,$5,$6,$7,$7)",[revision.id,article.id,item.title,escapeMarkdown(item.summary||'原站未提供摘要，请通过原文入口阅读。'),[...preset.topics],item.url,now]);
    await sql.query('UPDATE news_articles SET latest_revision_id=$2 WHERE id=$1',[article.id,revision.id]);await sql.query('UPDATE protected_objects SET news_article_id=$2 WHERE id=ANY($1::uuid[])',[[article.id,revision.id],article.id]);await sql.query('UPDATE news_source_items SET article_id=$2 WHERE id=$1',[itemId,article.id]);await sql.query("INSERT INTO news_events(article_id,revision_id,actor_id,action,reason,created_at) VALUES($1,$2,$3,'feed_collect',$4,$5)",[article.id,revision.id,row.authorized_by,'原站 RSS 摘要，须经人工审核。',now]);return true;
  }
  private run(id:string,actor?:Actor):Promise<NewsCollectResult>{const job=this.performRun(id,actor).finally(()=>this.jobs.delete(job));this.jobs.add(job);return job;}
  private async performRun(id:string,actor?:Actor):Promise<NewsCollectResult>{
    this.preset(id);if(this.stopped)return result('服务正在关闭。');const claimed=await this.claim(id,actor);if('status' in claimed)return claimed;
    const {row,token}=claimed,controller=new AbortController();this.active.set(token,controller);let outcome:NewsCollectResult;
    try{
      if(this.stopped)controller.abort();
      // Keep only parsed, bounded summary candidates. Conditional caching is
      // safe even when a feed has more than ten new items: subsequent due runs
      // consume this bounded backlog before sending another HTTP request.
      const response=row.backlog.length?null:await this.fetcher(this.preset(id),{etag:row.etag,lastModified:row.last_modified,signal:controller.signal,reserve:()=>this.reserve()});if(response){requireValue(response.status===200||response.status===304,502,'feed_http','订阅原站暂时无法提供内容。');requireValue(response.body.length<=NEWS_FEED_LIMITS.maxFeedBytes,502,'feed_size','订阅响应超过 2 MB。');}
      const parsed=response?response.status===304?{items:[],ignored:0}:parseNewsFeed(response.body,this.preset(id).url):{items:row.backlog,ignored:0};
      outcome=await this.db.transaction(async sql=>{
        // Serialize only the short enqueue transaction, never the HTTP fetch.
        // Global import -> owner account -> source is the fixed lock order;
        // different administrators cannot deadlock on reversed URL batches.
        await sql.query("SELECT pg_advisory_xact_lock(hashtextextended(current_schema() || ':news-source-import',0))");
        const valid=await this.authorized(row,sql,true),current=await this.row(id,sql,true);if(!current.enabled||current.version!==row.version||current.lease_token!==token||!valid||controller.signal.aborted){if(current.lease_token===token){if(!valid&&current.version===row.version)await sql.query("UPDATE news_sources SET enabled=false,version=version+1,lease_token=NULL,lease_until=NULL,last_status='authorization_expired',last_error='授权管理员已失去管理或写入权限，请由管理员重新启用。' WHERE id=$1",[id]);else await sql.query("UPDATE news_sources SET lease_token=NULL,lease_until=NULL,last_status=CASE WHEN enabled THEN 'idle' ELSE 'paused' END WHERE id=$1",[id]);}return result('来源配置或授权已变化，本次未收录。',current.next_check_at);}
        let imported=0,duplicates=0,index=0;for(;index<parsed.items.length&&imported<NEWS_FEED_LIMITS.maxItemsPerRun;index++){if(await this.importItem(row,parsed.items[index],sql))imported++;else duplicates++;}
        const status=response?.status===304?'not_modified':'collected';await sql.query("UPDATE news_sources SET lease_token=NULL,lease_until=NULL,last_success_at=$2,last_status=$3,last_error='',consecutive_failures=0,imported_count=imported_count+$4,etag=$5,last_modified=$6,backlog=$7::jsonb WHERE id=$1",[id,this.clock(),status,imported,response?response.etag:row.etag,response?response.lastModified:row.last_modified,JSON.stringify(parsed.items.slice(index))]);return {status,imported,duplicates,ignored:parsed.ignored,nextCheckAt:iso(current.next_check_at)} as NewsCollectResult;
      });
    }catch(error){
      const reason=error instanceof ApiError?error.message:'暂时无法读取这个资讯源，请稍后重试。',budget=error instanceof ApiError&&error.code==='feed_budget';outcome=await this.db.transaction(async sql=>{const current=await this.row(id,sql,true);if(current.lease_token!==token||current.version!==row.version){if(current.lease_token===token)await sql.query('UPDATE news_sources SET lease_token=NULL,lease_until=NULL WHERE id=$1',[id]);return result('来源配置已变化，保留当前配置。',current.next_check_at);}
        const next=new Date(Math.max(current.next_check_at?new Date(current.next_check_at).getTime():0,budget?Date.parse(this.day()+'T00:00:00.000Z')+86400000:this.clock().getTime()+Math.min(10080,Math.max(current.interval_minutes,60*2**Math.min(current.consecutive_failures+1,7)))*60000));await sql.query("UPDATE news_sources SET lease_token=NULL,lease_until=NULL,last_status=CASE WHEN enabled THEN 'error' ELSE 'paused' END,last_error=$2,consecutive_failures=consecutive_failures+$4,next_check_at=$3 WHERE id=$1",[id,reason,next,budget?0:1]);return {status:'failed',reason,imported:0,duplicates:0,ignored:0,nextCheckAt:current.enabled?iso(next):null};});
    }finally{this.active.delete(token);}
    await this.db.query('UPDATE news_source_runs SET finished_at=$2,status=$3,imported=$4,duplicates=$5,ignored=$6,message=$7 WHERE id=$1',[token,this.clock(),outcome.status,outcome.imported,outcome.duplicates,outcome.ignored,outcome.reason||'']);return outcome;
  }
}
