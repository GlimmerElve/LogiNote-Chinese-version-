import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createTestDatabase} from './helpers.js';
import {AccessService} from '../src/access.js';
import {GovernanceService} from '../src/governance.js';
import {ReportTriageService} from '../src/reportTriage.js';
import type {Actor} from '../src/types.js';
import type {Sql} from '../src/db.js';

test('report triage provides Shanghai workday targets and audited assignee-only changes without punishment',async t=>{
  const fixture=await createTestDatabase('report_triage');let now=new Date('2026-10-23T08:00:00Z');const clock=()=>now,access=new AccessService(fixture.db,clock),governance=new GovernanceService(fixture.db,access,clock),triage=new ReportTriageService(fixture.db,access,clock);
  const account=async(name:string,role:'administrator'|'member'):Promise<Actor>=>{const id=randomUUID();await fixture.db.query('INSERT INTO accounts(id,email,display_name,role,password_hash,email_verified_at) VALUES($1,$2,$3,$4,$5,$6)',[id,name+'@report.example.test',name,role,'synthetic-isolated-test',now]);return {accountId:id,role,mfaVerified:role==='administrator'};};
  try{
    const reporter=await account('reporter','member'),subject=await account('subject','member'),admin=await account('admin','administrator'),otherAdmin=await account('otheradmin','administrator'),target=await access.createObject(subject,{scope:'public'});
    const submit=(kind:'report'|'suggestion',category='other')=>governance.submit(reporter,{kind,category,targetType:'object',targetId:target.id,body:'仅案件证据可读取的正文，不得复制到排期审计。'});
    let report:any,suggestion:any;
    await t.test('insert trigger assigns priority and two/five Shanghai weekdays at 18:00, including weekends',async()=>{
      report=await submit('report','serious_risk');suggestion=await submit('suggestion');assert.equal(report.priority,'urgent');assert.equal(report.nextFeedbackAt,'2026-10-27T10:00:00.000Z');assert.equal(suggestion.priority,'normal');assert.equal(suggestion.nextFeedbackAt,'2026-10-30T10:00:00.000Z');
      now=new Date('2026-10-23T16:30:00Z');const localSaturday:any=await submit('report');assert.equal(localSaturday.nextFeedbackAt,'2026-10-27T10:00:00.000Z');now=new Date('2026-10-25T02:00:00Z');const sunday:any=await submit('report');assert.equal(sunday.nextFeedbackAt,'2026-10-27T10:00:00.000Z');
      assert.equal((await fixture.db.query('SELECT state FROM protected_objects WHERE id=$1',[target.id])).rows[0].state,'visible');assert.equal((await fixture.db.query('SELECT count(*)::int AS n FROM governance_decisions')).rows[0].n,0);assert.equal((await fixture.db.query('SELECT count(*)::int AS n FROM account_restrictions')).rows[0].n,0);assert.equal((await fixture.db.query('SELECT count(*)::int AS n FROM attention_deliveries')).rows[0].n,0);
      const queue=await governance.listQueue(admin);assert.equal(queue[0].id,report.id);assert.equal('body' in queue[0],false);assert.equal(queue[0].priority,'urgent');
    });
    await t.test('only the assigned verified administrator with write authority can change a versioned schedule',async()=>{
      await assert.rejects(fixture.db.transaction(sql=>triage.update(admin,report.id,{expectedVersion:report.version,priority:'normal'},sql)),{status:403});report=await governance.assign(admin,report.id,{expectedVersion:report.version});
      for(const actor of [reporter,otherAdmin,{...admin,mfaVerified:false},{...reporter,role:'administrator' as const,mfaVerified:true}])await assert.rejects(fixture.db.transaction(sql=>triage.update(actor,report.id,{expectedVersion:report.version,priority:'normal'},sql)),{status:403});
      let restriction:any=await governance.submit(reporter,{kind:'report',targetType:'account',targetId:admin.accountId,body:'隔离验收：管理员写入限制。'});restriction=await governance.assign(otherAdmin,restriction.id,{expectedVersion:restriction.version});restriction=await governance.decide(otherAdmin,restriction.id,{expectedVersion:restriction.version,action:'restrict_account',capabilities:['write'],expiresAt:new Date(now.getTime()+3600000).toISOString(),reason:'隔离测试临时写入限制。'});await assert.rejects(fixture.db.transaction(sql=>triage.update(admin,report.id,{expectedVersion:report.version,priority:'normal'},sql)),{status:403});await governance.decide(otherAdmin,restriction.id,{expectedVersion:restriction.version,action:'restore_account',reason:'隔离测试恢复权限。'});
      await assert.rejects(fixture.db.transaction(sql=>triage.update(admin,report.id,{priority:'normal'},sql)),{status:400});await assert.rejects(fixture.db.transaction(sql=>triage.update(admin,report.id,{expectedVersion:report.version,priority:'automatic_ban'},sql)),{status:400});await assert.rejects(fixture.db.transaction(sql=>triage.update(admin,report.id,{expectedVersion:report.version,priority:'normal',nextFeedbackAt:null},sql)),{status:400});
      for(const value of ['2026-02-30T00:00:00Z','2026-10-24T00:00:00Z','2026-10-28 18:00','2030-10-28T00:00:00Z'])await assert.rejects(fixture.db.transaction(sql=>triage.update(admin,report.id,{expectedVersion:report.version,priority:'normal',nextFeedbackAt:value},sql)),{status:400});
      const updated=await fixture.db.transaction(sql=>triage.update(admin,report.id,{expectedVersion:report.version,priority:'normal'},sql));assert.equal(updated.nextFeedbackAt,report.nextFeedbackAt);assert.equal(updated.version,report.version+1);await assert.rejects(fixture.db.transaction(sql=>triage.update(admin,report.id,{expectedVersion:report.version,priority:'urgent'},sql)),{status:409});report={...report,...updated};
    });
    await t.test('rescheduling and audit commit atomically and never read evidence or copy private report bodies',async()=>{
      const statements:string[]=[],future='2026-10-29T10:00:00.000Z';const updated=await fixture.db.transaction(async sql=>{const guarded:Sql={async query<R>(statement:string,values?:readonly unknown[]){statements.push(statement);return sql.query<R>(statement,values);}};return triage.update(admin,report.id,{expectedVersion:report.version,priority:'urgent',nextFeedbackAt:future,reason:'需要进一步核实，届时反馈进展。'},guarded);});
      assert.equal(updated.nextFeedbackAt,future);assert.equal(statements.some(value=>value.includes('report_evidence')||/SELECT[^;]*\bbody\b/i.test(value)),false);const audit=await governance.listAudit(admin,report.id),event=audit.find(item=>item.eventType==='report.triaged'&&(item.metadata as any).nextFeedbackAt===future)!;assert.ok(event);assert.equal(JSON.stringify(event.metadata).includes('仅案件证据'),false);assert.equal((event.metadata as any).reason,'需要进一步核实，届时反馈进展。');report={...report,...updated};
      const before=(await fixture.db.query('SELECT priority,next_feedback_at,version FROM reports WHERE id=$1',[report.id])).rows[0];await assert.rejects(fixture.db.transaction(async sql=>{const failing:Sql={async query<R>(statement:string,values?:readonly unknown[]){if(statement.startsWith('INSERT INTO audit_events'))throw new Error('synthetic audit failure');return sql.query<R>(statement,values);}};return triage.update(admin,report.id,{expectedVersion:report.version,priority:'normal',reason:'不能部分保存。'},failing);}),/synthetic audit failure/);assert.deepEqual((await fixture.db.query('SELECT priority,next_feedback_at,version FROM reports WHERE id=$1',[report.id])).rows[0],before);
    });
    await t.test('concurrent identical-version updates have one winner and completed cases cannot be rescheduled',async()=>{
      const attempts=await Promise.allSettled([fixture.db.transaction(sql=>triage.update(admin,report.id,{expectedVersion:report.version,priority:'normal',reason:'并发甲'},sql)),fixture.db.transaction(sql=>triage.update(admin,report.id,{expectedVersion:report.version,priority:'urgent',reason:'并发乙'},sql))]);assert.equal(attempts.filter(value=>value.status==='fulfilled').length,1);assert.equal((attempts.find(value=>value.status==='rejected') as PromiseRejectedResult).reason.status,409);
      await fixture.db.query("UPDATE reports SET status='closed' WHERE id=$1",[report.id]);const current=(await fixture.db.query<{version:number}>('SELECT version FROM reports WHERE id=$1',[report.id])).rows[0];await assert.rejects(fixture.db.transaction(sql=>triage.update(admin,report.id,{expectedVersion:current.version,priority:'normal'},sql)),{status:409});
    });
  }finally{await fixture.cleanup();}
});
