import assert from 'node:assert/strict';
import test from 'node:test';
import {randomUUID} from 'node:crypto';
import {AccessService} from '../src/access.js';
import {AttentionService,type DispatchEvent} from '../src/attention.js';
import type {Sql} from '../src/db.js';
import {ApiError} from '../src/errors.js';
import {GovernanceService} from '../src/governance.js';
import type {Actor} from '../src/types.js';
import {createTestDatabase} from './helpers.js';

const status=(expected:number)=>(error:unknown)=>error instanceof ApiError&&error.status===expected;
const code=(expected:string)=>(error:unknown)=>error instanceof ApiError&&error.code===expected;

test('phase 6 governance cases, private evidence and quiet delivery stay independent',async t=>{
  const fixture=await createTestDatabase('phase6_governance');
  t.after(()=>fixture.cleanup());
  const {db}=fixture;
  let now=new Date('2026-10-25T04:00:00Z');
  const clock=()=>new Date(now),access=new AccessService(db,clock),governance=new GovernanceService(db,access,clock);
  const account=async(name:string,role:Actor['role']='member'):Promise<Actor>=>{
    const accountId=randomUUID();
    await db.query('INSERT INTO accounts(id,email,password_hash,display_name,role,email_verified_at) VALUES($1,$2,$3,$4,$5,$6)',[accountId,`${accountId}@phase6.example.test`,'synthetic-fixture-not-a-password',name,role,clock()]);
    return {accountId,role,mfaVerified:role==='administrator'};
  };
  const author=await account('作者'),reporter=await account('反馈者'),outsider=await account('无关用户'),groupAdmin=await account('群管理员'),admin=await account('平台管理员','administrator'),admin2=await account('另一管理员','administrator');
  const groupId=randomUUID();
  await db.query('INSERT INTO groups(id,owner_id) VALUES($1,$2)',[groupId,author.accountId]);
  await db.query("INSERT INTO group_memberships(group_id,account_id,role) VALUES($1,$2,'administrator')",[groupId,groupAdmin.accountId]);
  const expiry=()=>new Date(now.getTime()+86400000).toISOString();
  const assignedReport=async(targetId:string,category:string,targetType='object')=>{
    const report=await governance.submit(reporter,{targetType,targetId,category,body:'合成案件说明'});
    return governance.assign(admin,report.id,{expectedVersion:report.version});
  };

  await t.test('category is optional, explicit and cannot turn a suggestion into a misconduct report',async()=>{
    const report=await governance.submit(reporter,{targetType:'account',targetId:author.accountId,body:'只写一句话即可反馈'});
    assert.equal(report.category,'other');
    for(const category of ['copyright','harassment','knowledge_error','serious_risk','other']){
      const item=await governance.submit(reporter,{targetType:'account',targetId:author.accountId,body:'合成分类反馈',category});
      assert.equal((await governance.get(reporter,item.id)).category,category);
    }
    await assert.rejects(governance.submit(reporter,{targetType:'account',targetId:author.accountId,body:'错误分类',category:'urgent'}),code('invalid_request'));
    await assert.rejects(governance.submit(reporter,{kind:'suggestion',targetType:'account',targetId:author.accountId,body:'建议不是处罚依据',category:'serious_risk'}),code('invalid_request'));
    await assert.rejects(governance.submit(reporter,{targetType:'account',targetId:author.accountId,body:'客户端不能指定结果',category:'other',status:'closed'}),code('invalid_request'));
  });

  await t.test('copyright disputes pause distribution and an upheld authorization appeal restores this case only',async()=>{
    const target=await access.createObject(author,{scope:'public'});
    const report=await assignedReport(target.id,'copyright');
    await governance.decide(admin,report.id,{action:'restrict_object',reason:'争议期间暂停传播，待核对授权材料',expiresAt:expiry(),expectedVersion:report.version});
    await assert.rejects(access.readObject(reporter,target.id),status(403));
    await assert.rejects(access.readObject(null,target.id),status(403));
    assert.equal((await access.readObject(author,target.id)).state,'restricted');
    await access.assertCapability(author,'send_message');
    const appeal=await governance.appeal(author,report.id,{body:'合成权利材料：作者本人，补充授权说明'});
    await governance.readEvidence(admin,report.id);
    await governance.reviewAppeal(admin,appeal.id,{outcome:'restore',reason:'人工核对授权后恢复争议分发'});
    assert.equal((await access.readObject(reporter,target.id)).state,'visible');
    assert.equal((await governance.get(author,report.id)).status,'closed');
    assert.ok((await governance.listAudit(admin,report.id)).some(row=>row.eventType==='appeal.reviewed'));
  });

  await t.test('harassment restricts messaging while preserving learning, feedback and the right to appeal',async()=>{
    const report=await assignedReport(author.accountId,'harassment','account');
    await governance.decide(admin,report.id,{action:'restrict_account',reason:'人工核实骚扰，暂时限制私信',capabilities:['send_message'],expiresAt:expiry(),expectedVersion:report.version});
    await assert.rejects(access.assertCapability(author,'send_message'),status(403));
    await access.createObject(author,{scope:'self'});
    await access.assertCapability(author,'create_group');
    const feedback=await governance.submit(author,{kind:'suggestion',targetType:'account',targetId:author.accountId,body:'受限后仍能反馈'});
    assert.equal(feedback.kind,'suggestion');
    const appeal=await governance.appeal(author,report.id,{body:'请求核查是否误判'});
    await governance.reviewAppeal(admin,appeal.id,{outcome:'restore',reason:'复核确认误判，撤销本案私信限制'});
    await access.assertCapability(author,'send_message');
  });

  await t.test('knowledge disagreement can receive a correction response without any account punishment',async()=>{
    const target=await access.createObject(author,{scope:'public'}),report=await assignedReport(target.id,'knowledge_error');
    await governance.decide(admin,report.id,{action:'no_action',reason:'属于知识分歧，请在原讨论补充可靠来源并由作者修订',expectedVersion:report.version});
    const detail=await governance.get(reporter,report.id);
    assert.equal(detail.category,'knowledge_error');
    assert.match(detail.decisions[0].reason,/补充可靠来源/);
    assert.equal((await access.readObject(null,target.id)).state,'visible');
    for(const capability of ['write','send_message','create_group'] as const)await access.assertCapability(author,capability);
    assert.equal((await db.query('SELECT id FROM account_restrictions WHERE decision_id=$1',[detail.decisions[0].id])).rowCount,0);
  });

  await t.test('serious-risk classification does not automatically punish; an authorized human can restrict capabilities with an audit',async()=>{
    const report=await assignedReport(author.accountId,'serious_risk','account');
    await access.assertCapability(author,'write');
    await assert.rejects(governance.decide(groupAdmin,report.id,{action:'restrict_account',reason:'群角色不能处罚全站账号',capabilities:['write'],expiresAt:expiry(),expectedVersion:report.version}),status(403));
    await governance.decide(admin,report.id,{action:'restrict_account',reason:'人工核实合成诈骗风险，限制发文、私信及建群一天',capabilities:['write','send_message','create_group'],expiresAt:expiry(),expectedVersion:report.version});
    for(const capability of ['write','send_message','create_group'] as const)await assert.rejects(access.assertCapability(author,capability),status(403));
    const appeal=await governance.appeal(author,report.id,{body:'合成复核申请'});
    await governance.reviewAppeal(admin,appeal.id,{outcome:'restore',reason:'合成复核完成，恢复本案权限'});
    for(const capability of ['write','send_message','create_group'] as const)await access.assertCapability(author,capability);
    const audit=await governance.listAudit(admin,report.id);
    assert.ok(audit.some(row=>row.eventType==='report.decided'));
    assert.ok(audit.some(row=>row.eventType==='appeal.reviewed'));
  });

  await t.test('suggestions have reasoned outcomes and continuing evaluation, never content or account sanctions',async()=>{
    const target=await access.createObject(author,{scope:'public'});
    const suggestion=await governance.submit(reporter,{kind:'suggestion',targetType:'object',targetId:target.id,body:'希望改进资料阅读体验'});
    let assigned=await governance.assign(admin,suggestion.id,{expectedVersion:suggestion.version});
    for(const action of ['restrict_object','restrict_account'])await assert.rejects(governance.decide(admin,suggestion.id,{action,reason:'不应把建议变处罚',expiresAt:expiry(),...(action==='restrict_account'?{capabilities:['write']}:{})}),code('invalid_request'));
    await assert.rejects(governance.respondSuggestion(admin,suggestion.id,{outcome:'evaluating',reason:'缺版本'}),code('invalid_request'));
    await assert.rejects(governance.respondSuggestion(admin,suggestion.id,{outcome:'evaluating',reason:' ',expectedVersion:assigned.version}),code('invalid_request'));
    await assert.rejects(governance.respondSuggestion(groupAdmin,suggestion.id,{outcome:'evaluating',reason:'越权',expectedVersion:assigned.version}),status(403));
    const staleVersion=assigned.version;
    assigned=await governance.respondSuggestion(admin,suggestion.id,{outcome:'evaluating',reason:'先评估兼容性与阅读需求',expectedVersion:assigned.version});
    assert.equal(assigned.status,'assigned');
    await assert.rejects(governance.respondSuggestion(admin,suggestion.id,{outcome:'adopted',reason:'使用旧版本重复提交',expectedVersion:staleVersion}),code('conflict'));
    const complete=await governance.respondSuggestion(admin,suggestion.id,{outcome:'adopted',reason:'已完成并纳入本次更新',releaseVersion:'2026.10.1',expectedVersion:assigned.version});
    assert.equal(complete.status,'closed');
    const detail=await governance.get(reporter,suggestion.id);
    assert.deepEqual(detail.suggestionFeedback.map(item=>item.outcome),['evaluating','adopted']);
    assert.equal(detail.suggestionFeedback[1].releaseVersion,'2026.10.1');
    assert.equal(detail.decisions.length,0);
    await assert.rejects(governance.respondSuggestion(admin,suggestion.id,{outcome:'declined',reason:'重复完成',expectedVersion:complete.version}),code('conflict'));
    await assert.rejects(governance.get(outsider,suggestion.id),status(403));
    assert.equal((await access.readObject(null,target.id)).state,'visible');
    await access.assertCapability(author,'write');
    const audit=await governance.listAudit(admin,suggestion.id);
    assert.deepEqual(audit.filter(item=>item.eventType==='suggestion.responded').map(item=>(item.metadata as {outcome:string}).outcome),['evaluating','adopted']);
    assert.equal(JSON.stringify(audit).includes('先评估兼容性'),false);
    for(const outcome of ['duplicate','declined']){
      const item=await governance.submit(reporter,{kind:'suggestion',targetType:'account',targetId:reporter.accountId,body:'其他合成建议'}),received=await governance.assign(admin,item.id);
      const response=await governance.respondSuggestion(admin,item.id,{outcome,reason:outcome==='duplicate'?'与已受理的建议重复，沿用已有结果':'当前不适合，已说明替代办法',expectedVersion:received.version});
      assert.equal(response.status,'closed');
      assert.equal((await governance.get(reporter,item.id)).suggestionFeedback[0].outcome,outcome);
    }
  });

  await t.test('suggestion feedback, report version and audit commit atomically and concurrent feedback cannot overwrite',async()=>{
    const report=await governance.submit(reporter,{kind:'suggestion',targetType:'account',targetId:reporter.accountId,body:'验证反馈不会无审计落库'}),assigned=await governance.assign(admin,report.id);
    await db.query(`CREATE FUNCTION phase6_reject_feedback_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.event_type='suggestion.responded' THEN RAISE EXCEPTION 'synthetic feedback audit unavailable'; END IF; RETURN NEW; END $$`);
    await db.query('CREATE TRIGGER phase6_reject_feedback BEFORE INSERT ON audit_events FOR EACH ROW EXECUTE FUNCTION phase6_reject_feedback_audit()');
    await assert.rejects(governance.respondSuggestion(admin,report.id,{outcome:'evaluating',reason:'审计失败时不得写入',expectedVersion:assigned.version}),/synthetic feedback audit unavailable/);
    assert.equal((await governance.get(reporter,report.id)).version,assigned.version);
    assert.equal((await db.query('SELECT id FROM suggestion_feedback WHERE report_id=$1',[report.id])).rowCount,0);
    await db.query('DROP TRIGGER phase6_reject_feedback ON audit_events');
    const responses=await Promise.allSettled(['evaluating','adopted'].map(outcome=>governance.respondSuggestion(admin,report.id,{outcome,reason:'并发人工反馈',expectedVersion:assigned.version})));
    assert.equal(responses.filter(item=>item.status==='fulfilled').length,1);
    const failed=responses.find(item=>item.status==='rejected');assert.ok(failed?.status==='rejected'&&code('conflict')(failed.reason));
    assert.equal((await db.query('SELECT id FROM suggestion_feedback WHERE report_id=$1',[report.id])).rowCount,1);
  });

  await t.test('case assignment is required for private evidence and reassignment immediately revokes the old assignee',async()=>{
    const privateTarget=await access.createObject(author,{scope:'direct',recipientAccountIds:[reporter.accountId]}),privateEvidence='reporter-selected-context-only-7b31';
    const report=await governance.submit(reporter,{targetType:'object',targetId:privateTarget.id,category:'harassment',body:'用户选择的私信上下文',evidence:privateEvidence});
    for(const actor of [admin,admin2,groupAdmin])await assert.rejects(access.readObject(actor,privateTarget.id),status(403));
    await assert.rejects(governance.readEvidence(admin,report.id),status(403));
    const assigned=await governance.assign(admin,report.id);
    assert.equal((await governance.readEvidence(admin,report.id)).evidence[0].body,privateEvidence);
    assert.equal('body' in await governance.get(admin,report.id),false);
    await governance.assign(admin,report.id,{assigneeAccountId:admin2.accountId,expectedVersion:assigned.version});
    await assert.rejects(governance.readEvidence(admin,report.id),status(403));
    await assert.rejects(governance.listAudit(admin,report.id),status(403));
    await assert.rejects(governance.readEvidence({...admin2,mfaVerified:false},report.id),status(403));
    assert.equal((await governance.readEvidence(admin2,report.id)).evidence[0].body,privateEvidence);
    const audit=await governance.listAudit(admin2,report.id);
    assert.equal(audit.filter(item=>item.eventType==='evidence.read').length,2);
    assert.equal(JSON.stringify(audit).includes(privateEvidence),false);
    await db.query("UPDATE accounts SET role='member' WHERE id=$1",[admin2.accountId]);
    await assert.rejects(governance.readEvidence(admin2,report.id),status(403));
    await db.query("UPDATE accounts SET role='administrator' WHERE id=$1",[admin2.accountId]);
  });

  await t.test('failed evidence audit never returns private evidence to the caller',async()=>{
    const report=await governance.submit(reporter,{targetType:'account',targetId:author.accountId,body:'private-body-audit-must-commit',evidence:'private-evidence-audit-must-commit'});
    await governance.assign(admin,report.id);
    await db.query(`CREATE FUNCTION phase6_reject_evidence_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.event_type='evidence.read' THEN RAISE EXCEPTION 'synthetic evidence audit unavailable'; END IF; RETURN NEW; END $$`);
    await db.query('CREATE TRIGGER phase6_reject_evidence BEFORE INSERT ON audit_events FOR EACH ROW EXECUTE FUNCTION phase6_reject_evidence_audit()');
    await assert.rejects(governance.readEvidence(admin,report.id),/synthetic evidence audit unavailable/);
    assert.equal((await db.query("SELECT id FROM audit_events WHERE report_id=$1 AND event_type='evidence.read'",[report.id])).rowCount,0);
    await db.query('DROP TRIGGER phase6_reject_evidence ON audit_events');
    assert.equal((await governance.readEvidence(admin,report.id)).body,'private-body-audit-must-commit');
    assert.equal((await db.query("SELECT id FROM audit_events WHERE report_id=$1 AND event_type='evidence.read'",[report.id])).rowCount,1);
  });

  await t.test('administrator demotion during an account-lock wait prevents every governance write without partial effects',async t=>{
    const snapshot=async(reportId:string,targetId:string)=>({
      detail:await governance.get(reporter,reportId),
      target:(await db.query('SELECT * FROM protected_objects WHERE id=$1',[targetId])).rows,
      restrictions:(await db.query('SELECT * FROM account_restrictions WHERE decision_id IN(SELECT id FROM governance_decisions WHERE report_id=$1) ORDER BY id',[reportId])).rows,
      audit:(await db.query('SELECT * FROM audit_events WHERE report_id=$1 ORDER BY sequence',[reportId])).rows
    });
    for(const operation of ['assign','decide','suggestion','appeal'] as const)await t.test(operation,async()=>{
      const raceAdmin=await account('等待锁时被降权的管理员-'+operation,'administrator'),target=await access.createObject(author,{scope:'public'});
      const report=await governance.submit(reporter,{kind:operation==='suggestion'?'suggestion':'report',targetType:'object',targetId:target.id,body:'合成角色撤销竞争案件'});
      let version=report.version,appealId:string|undefined;
      if(operation!=='assign')version=(await governance.assign(raceAdmin,report.id,{expectedVersion:version})).version;
      if(operation==='appeal'){
        await governance.decide(raceAdmin,report.id,{action:'restrict_object',reason:'合成待复核限制',expiresAt:expiry(),expectedVersion:version});
        appealId=(await governance.appeal(author,report.id,{body:'合成恢复申诉'})).id;
      }
      const before=await snapshot(report.id,target.id);
      let release!:()=>void,locked!:()=>void,waiting!:()=>void;
      const gate=new Promise<void>(resolve=>{release=resolve;}),ready=new Promise<void>(resolve=>{locked=resolve;}),atAccountLock=new Promise<void>(resolve=>{waiting=resolve;});
      // The initial role read sees the committed administrator, then the actual
      // capability SELECT waits for this uncommitted role change on the same row.
      const demotion=db.transaction(async sql=>{await sql.query("UPDATE accounts SET role='member' WHERE id=$1",[raceAdmin.accountId]);locked();await gate;});
      await ready;
      const mutation=db.transaction<unknown>(sql=>{
        const observed:Sql={async query<R>(statement:string,values?:readonly unknown[]){if(statement==='SELECT id FROM accounts WHERE id=$1 FOR UPDATE'&&values?.[0]===raceAdmin.accountId)waiting();return sql.query<R>(statement,values);}};
        switch(operation){
          case 'assign':return governance.assign(raceAdmin,report.id,{expectedVersion:version},observed);
          case 'decide':return governance.decide(raceAdmin,report.id,{action:'restrict_object',reason:'降权后不能处罚',expiresAt:expiry(),expectedVersion:version},observed);
          case 'suggestion':return governance.respondSuggestion(raceAdmin,report.id,{outcome:'adopted',reason:'降权后不能反馈',expectedVersion:version},observed);
          case 'appeal':return governance.reviewAppeal(raceAdmin,appealId!,{outcome:'restore',reason:'降权后不能恢复'},observed);
        }
      }).then(value=>({status:'fulfilled' as const,value}),reason=>({status:'rejected' as const,reason}));
      try{
        await Promise.race([atAccountLock,mutation.then(()=>{throw Error('governance write finished before waiting for its account lock');})]);
        release();await demotion;
        const result=await mutation;assert.equal(result.status,'rejected');
        if(result.status==='rejected')assert.ok(status(403)(result.reason));
        assert.equal((await db.query<{role:string}>('SELECT role FROM accounts WHERE id=$1',[raceAdmin.accountId])).rows[0].role,'member');
        assert.deepEqual(await snapshot(report.id,target.id),before);
      }finally{release();await Promise.allSettled([demotion,mutation]);}
    });
  });

  await t.test('ordinary mentions and announcements cannot escalate through payload, focus is account-wide and suppression never replays',async()=>{
    const delivered:DispatchEvent[]=[],firstSession=new AttentionService(db,{clock,dispatcher:{configured:true,async deliver(event){delivered.push(event);return {receiptId:'synthetic-'+event.eventId};}}}),secondSession=new AttentionService(db,{clock});
    const ordinary=(eventId:string,payload:unknown)=>({eventId,recipientAccountId:reporter.accountId,kind:'ordinary',payload});
    await firstSession.updatePreferences(reporter,{systemPushEnabled:true});
    for(const payload of [{type:'group_mention',urgent:true,priority:'emergency'},{type:'announcement',kind:'system',urgent:true}]){
      const eventId=randomUUID();
      assert.equal((await firstSession.recordEvent(admin,ordinary(eventId,payload))).reason,'disabled');
      assert.equal((await firstSession.dispatch(reporter.accountId,eventId)).status,'suppressed');
    }
    await assert.rejects(firstSession.recordEvent(groupAdmin,{...ordinary('cannot-send-system',{type:'group_mention'}),kind:'system'}),status(403));
    await assert.rejects(firstSession.recordEvent(reporter,{...ordinary('cannot-send-urgent',{}),kind:'urgent'}),code('invalid_request'));
    await assert.rejects(firstSession.recordEvent(reporter,{...ordinary('cannot-add-priority',{}),priority:'emergency'}),code('invalid_request'));
    await firstSession.recordEvent(admin,{...ordinary('system-role-recheck',{type:'security'}),kind:'system'});
    await db.query("UPDATE accounts SET role='member' WHERE id=$1",[admin.accountId]);
    await assert.rejects(firstSession.recordEvent(admin,{...ordinary('stale-admin-system',{type:'security'}),kind:'system'}),status(403));
    await assert.rejects(firstSession.recordEvent(admin,{...ordinary('system-role-recheck',{type:'security'}),kind:'system'}),status(403));
    await db.query("UPDATE accounts SET role='administrator' WHERE id=$1",[admin.accountId]);
    await firstSession.updatePreferences(reporter,{ordinaryAlertsEnabled:true});
    await firstSession.recordEvent(author,ordinary('waiting-prior-to-focus',{type:'reply'}));
    await secondSession.setFocus(reporter,true);
    assert.equal((await firstSession.getPreferences(reporter)).focus,true);
    assert.equal((await firstSession.dispatch(reporter.accountId,'waiting-prior-to-focus')).reason,'focus');
    assert.equal((await firstSession.recordEvent(groupAdmin,ordinary('mention-in-focus',{type:'group_mention',urgent:true}))).reason,'focus');
    await secondSession.setFocus(reporter,false);now=new Date(now.getTime()+60000);
    for(const id of ['waiting-prior-to-focus','mention-in-focus'])assert.equal((await firstSession.dispatch(reporter.accountId,id)).status,'suppressed');
    assert.equal(delivered.length,0);
    assert.equal((await firstSession.getPreferences(reporter)).replayAfterFocus,false);
    assert.equal((await firstSession.getPreferences(reporter)).showUnreadBadges,false);
  });
});
