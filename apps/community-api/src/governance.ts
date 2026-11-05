import {randomUUID} from 'node:crypto';
import type {Database,Sql} from './db.js';
import {object,onlyKeys,requireValue,text} from './errors.js';
import type {Actor,Clock} from './types.js';
import {systemClock} from './types.js';
import {AccessService,uuid,type Capability} from './access.js';

type Action='restrict_object'|'restore_object'|'restrict_account'|'restore_account'|'no_action';
type Category='copyright'|'harassment'|'knowledge_error'|'serious_risk'|'other';
type SuggestionOutcome='adopted'|'evaluating'|'duplicate'|'declined';
interface ReportRow {id:string;reporterId:string;subjectAccountId:string;kind:'report'|'suggestion';category:Category;priority:'urgent'|'normal';nextFeedbackAt:Date|null;targetType:'object'|'account';targetId:string;body:string;status:string;assigneeAccountId:string|null;version:number;createdAt:Date;updatedAt:Date}
interface DecisionRow {id:string;reportId:string;action:Action;reason:string;capabilities:Capability[];expiresAt:Date|null;createdAt:Date}
interface AppealRow {id:string;reportId:string;decisionId:string;appellantId:string;body:string;status:string;reviewReason:string|null;createdAt:Date}
const reportColumns=`id,reporter_id AS "reporterId",subject_account_id AS "subjectAccountId",kind,category,priority,next_feedback_at AS "nextFeedbackAt",target_type AS "targetType",
 COALESCE(target_object_id,target_account_id)::text AS "targetId",body,status,assignee_account_id AS "assigneeAccountId",version,created_at AS "createdAt",updated_at AS "updatedAt"`;
const decisionColumns=`id,report_id AS "reportId",action,reason,capabilities,expires_at AS "expiresAt",created_at AS "createdAt"`;
const appealColumns=`id,report_id AS "reportId",decision_id AS "decisionId",appellant_id AS "appellantId",body,status,review_reason AS "reviewReason",created_at AS "createdAt"`;

/** All mutations can participate in the HTTP idempotency transaction via sql. */
export class GovernanceService {
  readonly access:AccessService;
  constructor(readonly db:Database,access?:AccessService,readonly clock:Clock=systemClock){this.access=access||new AccessService(db,clock);}
  private transact<T>(sql:Sql|undefined,work:(tx:Sql)=>Promise<T>):Promise<T>{return sql?work(sql):this.db.transaction(work);}
  private async report(id:string,sql:Sql,lock=false):Promise<ReportRow>{
    uuid(id,'工单');const result=await sql.query<ReportRow>(`SELECT ${reportColumns} FROM reports WHERE id=$1${lock?' FOR UPDATE':''}`,[id]);requireValue(result.rows[0],404,'not_found','工单不存在。');return result.rows[0];
  }
  private async audit(actor:Actor,reportId:string,event:string,metadata:Record<string,unknown>,sql:Sql):Promise<void>{
    // Metadata is constructed here, never copied from user bodies, credentials,
    // evidence or arbitrary request JSON.
    await sql.query('INSERT INTO audit_events(id,actor_id,report_id,event_type,metadata,created_at) VALUES($1,$2,$3,$4,$5::jsonb,$6)',[randomUUID(),actor.accountId,reportId,event,JSON.stringify(metadata),this.clock()]);
  }
  private async assigned(actor:Actor,report:ReportRow,sql:Sql):Promise<void>{await this.access.assertPlatformAdmin(actor,sql);requireValue(report.assigneeAccountId===actor.accountId,403,'forbidden','此案件尚未分配给当前管理员。');}
  private async lockTargetGroup(id:string,sql:Sql){
    const target=(await sql.query<{groupId:string|null;root:boolean}>(`SELECT COALESCE(p.group_id,g.id) AS "groupId",g.id IS NOT NULL AS root FROM protected_objects p LEFT JOIN groups g ON g.id=p.id WHERE p.id=$1`,[id])).rows[0];
    if(target?.groupId)await this.access.lockGroup(target.groupId,sql);return target?.root||false;
  }
  private version(data:Record<string,unknown>,report:ReportRow):void{
    if(data.expectedVersion!==undefined){requireValue(Number.isSafeInteger(data.expectedVersion)&&Number(data.expectedVersion)>0,400,'invalid_request','工单版本应为正整数。');requireValue(data.expectedVersion===report.version,409,'conflict','工单已更新，请重新读取后操作。');}
  }
  private expiry(value:unknown):Date{
    requireValue(typeof value==='string'&&/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?Z$/.test(value),400,'invalid_request','限制操作必须提供 UTC ISO 格式的截止时间。');const expires=new Date(value);
    requireValue(Number.isFinite(expires.getTime())&&expires.toISOString().slice(0,19)===value.slice(0,19)&&expires>this.clock()&&expires.getTime()-this.clock().getTime()<=365*86400000,400,'invalid_request','截止时间必须在未来一年内。');return expires;
  }
  private summary(report:ReportRow){return {id:report.id,kind:report.kind,category:report.category,priority:report.priority,nextFeedbackAt:report.nextFeedbackAt?new Date(report.nextFeedbackAt).toISOString():null,assigneeAccountId:report.assigneeAccountId,targetType:report.targetType,targetId:report.targetId,status:report.status,version:report.version,createdAt:report.createdAt,updatedAt:report.updatedAt};}
  async submit(actor:Actor,input:unknown,sql?:Sql){
    const data=object(input);onlyKeys(data,['kind','category','targetType','targetId','body','evidence']);const kind=data.kind??'report';requireValue(kind==='report'||kind==='suggestion',400,'invalid_request','工单类型不正确。');requireValue(data.targetType==='object'||data.targetType==='account',400,'invalid_request','举报对象类型不正确。');
    const category=data.category??'other';requireValue(typeof category==='string'&&['copyright','harassment','knowledge_error','serious_risk','other'].includes(category),400,'invalid_request','问题类型不正确。');requireValue(kind==='report'||category==='other',400,'invalid_request','建议无需选择举报类型。');
    const targetId=uuid(data.targetId,'举报对象'),body=text(data.body,'反馈内容',8000),evidence=data.evidence===undefined?undefined:text(data.evidence,'补充证据',16000);
    return this.transact(sql,async tx=>{
      // Reporting and appealing remain available to a user whose publishing or
      // messaging capability is restricted.
      await this.access.assertAccount(actor,tx);let subject:string;
      if(data.targetType==='object')subject=(await this.access.authorizeObject(actor,targetId,'read',tx)).ownerId;
      else{const found=await tx.query<{id:string}>('SELECT id FROM accounts WHERE id=$1',[targetId]);requireValue(found.rows[0],404,'not_found','举报对象不存在。');subject=found.rows[0].id;}
      const id=randomUUID(),now=this.clock();await tx.query(`INSERT INTO reports(id,reporter_id,kind,target_type,target_object_id,target_account_id,subject_account_id,body,category,created_at,updated_at)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$10)`,[id,actor.accountId,kind,data.targetType,data.targetType==='object'?targetId:null,data.targetType==='account'?targetId:null,subject,body,category,now]);
      if(evidence)await tx.query('INSERT INTO report_evidence(id,report_id,submitted_by,body,created_at) VALUES($1,$2,$3,$4,$5)',[randomUUID(),id,actor.accountId,evidence,now]);
      await this.audit(actor,id,'report.submitted',{kind,category,targetType:data.targetType,targetId},tx);return this.summary(await this.report(id,tx));
    });
  }
  async listMine(actor:Actor,sql:Sql=this.db){
    await this.access.assertAccount(actor,sql);const result=await sql.query<ReportRow>(`SELECT ${reportColumns} FROM reports WHERE reporter_id=$1 OR
      (subject_account_id=$1 AND EXISTS(SELECT 1 FROM governance_decisions WHERE report_id=reports.id)) ORDER BY created_at DESC,id LIMIT 100`,[actor.accountId]);return result.rows.map(report=>({...this.summary(report),...(report.reporterId===actor.accountId?{body:report.body}:{})}));
  }
  async listQueue(actor:Actor,sql:Sql=this.db){await this.access.assertPlatformAdmin(actor,sql);const result=await sql.query<ReportRow>(`SELECT ${reportColumns} FROM reports WHERE status<>'closed' ORDER BY CASE priority WHEN 'urgent' THEN 0 ELSE 1 END,next_feedback_at NULLS LAST,created_at,id LIMIT 100`);return result.rows.map(report=>this.summary(report));}
  async get(actor:Actor,id:string,sql:Sql=this.db){
    await this.access.assertAccount(actor,sql);const report=await this.report(id,sql);const decisions=await sql.query<DecisionRow>(`SELECT ${decisionColumns} FROM governance_decisions WHERE report_id=$1 ORDER BY sequence`,[id]);
    const reporter=report.reporterId===actor.accountId,subject=report.subjectAccountId===actor.accountId&&decisions.rows.length>0;
    if(!reporter&&!subject)await this.assigned(actor,report,sql);
    const appeals=await sql.query<AppealRow>(`SELECT ${appealColumns} FROM appeals WHERE report_id=$1 ORDER BY created_at,id`,[id]);
    const feedback=await sql.query(`SELECT id,outcome,reason,release_version AS "releaseVersion",created_at AS "createdAt" FROM suggestion_feedback WHERE report_id=$1 ORDER BY sequence`,[id]);
    return {...this.summary(report),...(reporter?{body:report.body}:{}),decisions:decisions.rows,suggestionFeedback:feedback.rows,appeals:appeals.rows.map(appeal=>({id:appeal.id,decisionId:appeal.decisionId,status:appeal.status,reviewReason:appeal.reviewReason,...(appeal.appellantId===actor.accountId?{body:appeal.body}:{})}))};
  }
  async assign(actor:Actor,id:string,input:unknown={},sql?:Sql){
    const data=object(input);onlyKeys(data,['assigneeAccountId','expectedVersion']);const assignee=data.assigneeAccountId===undefined?actor.accountId:uuid(data.assigneeAccountId,'管理员');
    return this.transact(sql,async tx=>{await this.access.assertPlatformAdmin(actor,tx);const report=await this.report(id,tx,true);await this.access.assertCapability(actor,'write',tx);await this.access.assertPlatformAdmin(actor,tx);this.version(data,report);requireValue(report.status!=='closed',409,'conflict','已关闭的工单不能重新分配。');
      const found=await tx.query<{role:string}>('SELECT role FROM accounts WHERE id=$1',[assignee]);requireValue(found.rows[0]?.role==='administrator',400,'invalid_request','只能分配给平台管理员。');
      await tx.query(`UPDATE reports SET assignee_account_id=$2,status=CASE WHEN status='submitted' THEN 'assigned' ELSE status END,version=version+1,updated_at=$3 WHERE id=$1`,[id,assignee,this.clock()]);await this.audit(actor,id,'report.assigned',{assigneeAccountId:assignee},tx);return this.summary(await this.report(id,tx));});
  }
  async readEvidence(actor:Actor,id:string,sql?:Sql){
    return this.transact(sql,async tx=>{const report=await this.report(id,tx,true);await this.assigned(actor,report,tx);const evidence=await tx.query<{id:string;body:string}>('SELECT id,body FROM report_evidence WHERE report_id=$1 ORDER BY created_at,id',[id]);
      const appeals=await tx.query<{id:string;decisionId:string;body:string;status:string}>('SELECT id,decision_id AS "decisionId",body,status FROM appeals WHERE report_id=$1 ORDER BY created_at,id',[id]);
      await this.audit(actor,id,'evidence.read',{evidenceIds:evidence.rows.map(item=>item.id),appealIds:appeals.rows.map(item=>item.id)},tx);return {reportId:id,body:report.body,evidence:evidence.rows,appeals:appeals.rows};});
  }
  async decide(actor:Actor,id:string,input:unknown,sql?:Sql){
    const data=object(input);onlyKeys(data,['action','reason','expiresAt','capabilities','expectedVersion']);requireValue(typeof data.action==='string'&&['restrict_object','restore_object','restrict_account','restore_account','no_action'].includes(data.action),400,'invalid_request','处置类型不正确。');const action=data.action as Action,reason=text(data.reason,'处理依据',4000),restrict=action==='restrict_object'||action==='restrict_account';const expiresAt=restrict?this.expiry(data.expiresAt):null;
    if(!restrict)requireValue(data.expiresAt===undefined,400,'invalid_request','恢复或无处置操作不接受截止时间。');let capabilities:Capability[]=[];
    if(action==='restrict_account'){requireValue(Array.isArray(data.capabilities)&&data.capabilities.length>0&&data.capabilities.length<=3,400,'invalid_request','请选择受限操作。');requireValue(data.capabilities.every(value=>typeof value==='string'&&['write','send_message','create_group'].includes(value))&&new Set(data.capabilities).size===data.capabilities.length,400,'invalid_request','受限操作不正确或重复。');capabilities=data.capabilities as Capability[];}
    else requireValue(data.capabilities===undefined,400,'invalid_request','此处置不接受账号能力字段。');
    return this.transact(sql,async tx=>{
      const report=await this.report(id,tx,true);await this.assigned(actor,report,tx);await this.access.assertCapability(actor,'write',tx);await this.access.assertPlatformAdmin(actor,tx);this.version(data,report);
      requireValue(report.kind!=='suggestion'||action==='no_action',400,'invalid_request','建议通过反馈结果处理，不能据此处罚账号或内容。');
      requireValue(report.status==='assigned'||report.status==='decided'&&(action==='restore_object'||action==='restore_account'),409,'conflict','当前工单状态不能重复处置。');
      if(action.endsWith('_object'))requireValue(report.targetType==='object',400,'invalid_request','此工单不是对象举报。');
      if(action.endsWith('_object')){
        const groupRoot=await this.lockTargetGroup(report.targetId,tx);
        // A report may be pending while the room is transferred. The current
        // owner must receive and be able to appeal the actual group restriction.
        if(groupRoot&&action==='restrict_object')await tx.query('UPDATE reports SET subject_account_id=(SELECT owner_id FROM protected_objects WHERE id=$2) WHERE id=$1',[id,report.targetId]);
      }
      const decisionId=randomUUID(),now=this.clock();await tx.query('INSERT INTO governance_decisions(id,report_id,actor_id,action,reason,capabilities,expires_at,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',[decisionId,id,actor.accountId,action,reason,capabilities,expiresAt,now]);
      if(action==='restrict_object'){
        const target=await this.access.loadObject(report.targetId,tx,true);requireValue(target.state==='visible',409,'conflict','对象已撤回或已有未结束的限制。');
        await tx.query(`UPDATE protected_objects SET state='restricted',restricted_until=$2,restriction_decision_id=$3,version=version+1 WHERE id=$1`,[report.targetId,expiresAt,decisionId]);
      }else if(action==='restore_object'){
        const changed=await tx.query(`UPDATE protected_objects SET state='visible',restricted_until=NULL,restriction_decision_id=NULL,version=version+1 WHERE id=$1 AND state='restricted' AND restriction_decision_id IN(SELECT id FROM governance_decisions WHERE report_id=$2)`,[report.targetId,id]);requireValue(changed.rowCount,409,'conflict','本工单没有可恢复的对象限制。');
      }else if(action==='restrict_account'){
        await tx.query('SELECT id FROM accounts WHERE id=$1 FOR UPDATE',[report.subjectAccountId]);for(const capability of capabilities)await tx.query('INSERT INTO account_restrictions(id,account_id,capability,decision_id,starts_at,expires_at) VALUES($1,$2,$3,$4,$5,$6)',[randomUUID(),report.subjectAccountId,capability,decisionId,now,expiresAt]);
      }else if(action==='restore_account'){
        await tx.query('SELECT id FROM accounts WHERE id=$1 FOR UPDATE',[report.subjectAccountId]);const changed=await tx.query('UPDATE account_restrictions SET revoked_at=$3 WHERE account_id=$1 AND revoked_at IS NULL AND decision_id IN(SELECT id FROM governance_decisions WHERE report_id=$2)',[report.subjectAccountId,id,now]);requireValue(changed.rowCount,409,'conflict','本工单没有可恢复的账号限制。');
      }
      await tx.query(`UPDATE reports SET status='decided',version=version+1,updated_at=$2 WHERE id=$1`,[id,now]);await this.audit(actor,id,'report.decided',{decisionId,action,capabilities,expiresAt:expiresAt?.toISOString()||null},tx);return {decisionId,...this.summary(await this.report(id,tx))};
    });
  }
  async respondSuggestion(actor:Actor,id:string,input:unknown,sql?:Sql){
    const data=object(input);onlyKeys(data,['outcome','reason','expectedVersion','releaseVersion']);
    requireValue(typeof data.outcome==='string'&&['adopted','evaluating','duplicate','declined'].includes(data.outcome),400,'invalid_request','建议处理结果不正确。');
    const outcome=data.outcome as SuggestionOutcome,reason=text(data.reason,'反馈说明',4000),releaseVersion=data.releaseVersion===undefined?null:text(data.releaseVersion,'关联版本',120);
    requireValue(!releaseVersion||outcome==='adopted',400,'invalid_request','只有采纳的建议可以关联版本。');
    requireValue(Number.isSafeInteger(data.expectedVersion)&&Number(data.expectedVersion)>0,400,'invalid_request','请提供当前工单版本。');
    return this.transact(sql,async tx=>{
      const report=await this.report(id,tx,true);await this.assigned(actor,report,tx);await this.access.assertCapability(actor,'write',tx);await this.access.assertPlatformAdmin(actor,tx);this.version(data,report);
      requireValue(report.kind==='suggestion',400,'invalid_request','此工单不是建议。');
      requireValue(report.status==='assigned'||report.status==='decided',409,'conflict','建议已经完成或正在复核，不能重复处理。');
      const feedbackId=randomUUID(),now=this.clock();await tx.query('INSERT INTO suggestion_feedback(id,report_id,actor_id,outcome,reason,release_version,created_at) VALUES($1,$2,$3,$4,$5,$6,$7)',[feedbackId,id,actor.accountId,outcome,reason,releaseVersion,now]);
      await tx.query('UPDATE reports SET status=$2,version=version+1,updated_at=$3 WHERE id=$1',[id,outcome==='evaluating'?'assigned':'closed',now]);
      await this.audit(actor,id,'suggestion.responded',{feedbackId,outcome,releaseVersion},tx);
      return {feedbackId,...this.summary(await this.report(id,tx))};
    });
  }
  async appeal(actor:Actor,id:string,input:unknown,sql?:Sql){
    const data=object(input);onlyKeys(data,['body']);const body=text(data.body,'申诉说明',8000);
    return this.transact(sql,async tx=>{await this.access.assertAccount(actor,tx);const report=await this.report(id,tx,true);requireValue(report.reporterId===actor.accountId||report.subjectAccountId===actor.accountId,403,'forbidden','只能对与自己有关的处置申诉。');requireValue(report.status==='decided',409,'conflict','当前工单尚无可申诉处置，或已进入复核。');
      const latest=await tx.query<DecisionRow>(`SELECT ${decisionColumns} FROM governance_decisions WHERE report_id=$1 ORDER BY sequence DESC LIMIT 1`,[id]);requireValue(latest.rows[0],409,'conflict','尚无可申诉处置。');const appealId=randomUUID();await tx.query('INSERT INTO appeals(id,report_id,decision_id,appellant_id,body,created_at) VALUES($1,$2,$3,$4,$5,$6)',[appealId,id,latest.rows[0].id,actor.accountId,body,this.clock()]);
      await tx.query(`UPDATE reports SET status='appealed',version=version+1,updated_at=$2 WHERE id=$1`,[id,this.clock()]);await this.audit(actor,id,'appeal.submitted',{appealId,decisionId:latest.rows[0].id},tx);return {id:appealId,reportId:id,status:'pending'};});
  }
  async reviewAppeal(actor:Actor,appealId:string,input:unknown,sql?:Sql){
    uuid(appealId,'申诉');const data=object(input);onlyKeys(data,['outcome','reason']);requireValue(data.outcome==='restore'||data.outcome==='uphold',400,'invalid_request','复核结果不正确。');const reason=text(data.reason,'复核依据',4000);
    return this.transact(sql,async tx=>{
      const locate=await tx.query<{reportId:string}>('SELECT report_id AS "reportId" FROM appeals WHERE id=$1',[appealId]);requireValue(locate.rows[0],404,'not_found','申诉不存在。');
      // Always lock the report before its appeal, matching submission's order.
      const report=await this.report(locate.rows[0].reportId,tx,true);await this.assigned(actor,report,tx);await this.access.assertCapability(actor,'write',tx);await this.access.assertPlatformAdmin(actor,tx);const found=await tx.query<AppealRow>(`SELECT ${appealColumns} FROM appeals WHERE id=$1 FOR UPDATE`,[appealId]),appeal=found.rows[0];requireValue(appeal&&appeal.status==='pending',409,'conflict','申诉已复核。');
      const decisions=await tx.query<DecisionRow>(`SELECT ${decisionColumns} FROM governance_decisions WHERE id=$1`,[appeal.decisionId]),decision=decisions.rows[0];requireValue(decision,409,'conflict','处置记录不可用。');
      if(data.outcome==='restore'){
        if(decision.action==='restrict_account'){
          await tx.query('SELECT id FROM accounts WHERE id=$1 FOR UPDATE',[report.subjectAccountId]);await tx.query('UPDATE account_restrictions SET revoked_at=$2 WHERE decision_id=$1 AND revoked_at IS NULL',[decision.id,this.clock()]);
        }else if(decision.action==='restrict_object'){
          await this.lockTargetGroup(report.targetId,tx);
          const target=await tx.query<{state:string;decisionId:string|null}>('SELECT state,restriction_decision_id AS "decisionId" FROM protected_objects WHERE id=$1 FOR UPDATE',[report.targetId]);requireValue(target.rows[0]&&(target.rows[0].state==='visible'||target.rows[0].state==='restricted'&&target.rows[0].decisionId===decision.id),409,'conflict','对象已撤回或已有其他处置，不能覆盖恢复。');
          // Expiry can allow an author to withdraw the content while an appeal
          // remains pending. An old decision ID must never republish that choice.
          // Already-visible content needs no object write to close its appeal.
          await tx.query(`UPDATE protected_objects SET state='visible',restricted_until=NULL,restriction_decision_id=NULL,version=version+1 WHERE id=$1 AND state='restricted' AND restriction_decision_id=$2`,[report.targetId,decision.id]);
        }else requireValue(false,400,'invalid_request','这项决定没有可恢复的限制。');
      }
      const status=data.outcome==='restore'?'restored':'upheld';await tx.query('UPDATE appeals SET status=$2,reviewer_id=$3,review_reason=$4,reviewed_at=$5 WHERE id=$1',[appealId,status,actor.accountId,reason,this.clock()]);await tx.query(`UPDATE reports SET status='closed',version=version+1,updated_at=$2 WHERE id=$1`,[report.id,this.clock()]);await this.audit(actor,report.id,'appeal.reviewed',{appealId,decisionId:decision.id,outcome:data.outcome},tx);return {id:appealId,reportId:report.id,status};
    });
  }
  async listAudit(actor:Actor,id:string,sql:Sql=this.db){const report=await this.report(id,sql);await this.assigned(actor,report,sql);const result=await sql.query('SELECT id,actor_id AS "actorId",event_type AS "eventType",metadata,created_at AS "createdAt" FROM audit_events WHERE report_id=$1 ORDER BY sequence',[id]);return result.rows;}
}
