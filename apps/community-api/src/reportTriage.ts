import {randomUUID} from 'node:crypto';
import type {Database,Sql} from './db.js';
import {AccessService,uuid} from './access.js';
import {object,onlyKeys,requireValue} from './errors.js';
import type {Actor,Clock} from './types.js';
import {systemClock} from './types.js';

type TriageRow={id:string;version:number;status:string;assignee_account_id:string|null;priority:'normal'|'urgent';next_feedback_at:Date|null};
/** Scheduling changes never inspect evidence or impose moderation actions. */
export class ReportTriageService {
  readonly access:AccessService;
  constructor(readonly db:Database,access?:AccessService,readonly clock:Clock=systemClock){this.access=access||new AccessService(db,clock);}
  async update(actor:Actor,id:string,value:unknown,sql:Sql){
    const input=object(value);onlyKeys(input,['expectedVersion','priority','nextFeedbackAt','reason']);uuid(id,'工单');
    requireValue(Number.isSafeInteger(input.expectedVersion)&&Number(input.expectedVersion)>0,400,'invalid_request','请提供当前工单版本。');requireValue(input.priority==='urgent'||input.priority==='normal',400,'invalid_request','工单分级不正确。');
    const reason=input.reason??'';requireValue(typeof reason==='string'&&reason.length<=500&&!reason.includes('\0'),400,'invalid_request','排期说明最多 500 字。');
    let next:Date|undefined;if(input.nextFeedbackAt!==undefined){const value=input.nextFeedbackAt;requireValue(typeof value==='string'&&/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?Z$/.test(value),400,'invalid_request','反馈目标时间应为 UTC ISO 格式。');next=new Date(value);requireValue(Number.isFinite(next.getTime())&&next.toISOString().slice(0,19)===value.slice(0,19)&&next>this.clock()&&next.getTime()-this.clock().getTime()<=365*86400000,400,'invalid_request','反馈目标应在未来一年内。');}
    await this.access.assertPlatformAdmin(actor,sql);
    // The existing governance mutations lock report -> account. Keep that
    // order, including version check and audit in the caller's transaction.
    const row=(await sql.query<TriageRow>('SELECT id,version,status,assignee_account_id,priority,next_feedback_at FROM reports WHERE id=$1 FOR UPDATE',[id])).rows[0];requireValue(row,404,'not_found','工单不存在。');requireValue(row.assignee_account_id===actor.accountId,403,'forbidden','此案件尚未分配给当前管理员。');await this.access.assertCapability(actor,'write',sql);await this.access.assertPlatformAdmin(actor,sql);requireValue(row.version===input.expectedVersion,409,'conflict','工单已更新，请重新读取后操作。');requireValue(row.status!=='closed',409,'conflict','已完成的工单不再调整排期。');
    const target=next??row.next_feedback_at,now=this.clock();await sql.query('UPDATE reports SET priority=$2,next_feedback_at=$3,version=version+1,updated_at=$4 WHERE id=$1',[id,input.priority,target,now]);
    await sql.query('INSERT INTO audit_events(id,actor_id,report_id,event_type,metadata,created_at) VALUES($1,$2,$3,\'report.triaged\',$4::jsonb,$5)',[randomUUID(),actor.accountId,id,JSON.stringify({fromPriority:row.priority,priority:input.priority,fromNextFeedbackAt:row.next_feedback_at?new Date(row.next_feedback_at).toISOString():null,nextFeedbackAt:target?new Date(target).toISOString():null,...(reason.trim()?{reason:reason.trim()}:{})}),now]);
    return {id:row.id,version:row.version+1,priority:input.priority,nextFeedbackAt:target?new Date(target).toISOString():null,updatedAt:now.toISOString()};
  }
}
