import assert from 'node:assert/strict';
import test, {type TestContext} from 'node:test';
import {randomUUID} from 'node:crypto';
import {AccessService} from '../src/access.js';
import {GovernanceService} from '../src/governance.js';
import {ApiError} from '../src/errors.js';
import {createDatabase} from '../src/db.js';
import type {Actor} from '../src/types.js';
import {createTestDatabase} from './helpers.js';

const errorStatus=(status:number)=>(error:unknown)=>error instanceof ApiError&&error.status===status;
const errorCode=(code:string)=>(error:unknown)=>error instanceof ApiError&&error.code===code;

async function fixture(t:TestContext){
  const database=await createTestDatabase('governance');
  t.after(()=>database.cleanup());
  const {db}=database;
  const member=():Actor=>({accountId:randomUUID(),role:'member',mfaVerified:false});
  const actors={owner:member(),reporter:member(),outsider:member(),groupAdmin:member(),admin:{...member(),role:'administrator' as const,mfaVerified:true},admin2:{...member(),role:'administrator' as const,mfaVerified:true}};
  for(const [name,actor] of Object.entries(actors))await db.query('INSERT INTO accounts(id,email,password_hash,display_name,role,email_verified_at) VALUES($1,$2,$3,$4,$5,$6)',[actor.accountId,`${name.toLowerCase()}@example.test`,'not-a-login-fixture',name,actor.role,new Date('2026-10-23T00:00:00Z')]);
  const groupId=randomUUID(),otherGroupId=randomUUID();
  await db.query('INSERT INTO groups(id,owner_id) VALUES($1,$2),($3,$4)',[groupId,actors.owner.accountId,otherGroupId,actors.outsider.accountId]);
  for(const [group,actor,role] of [[groupId,actors.owner,'owner'],[groupId,actors.reporter,'member'],[groupId,actors.groupAdmin,'administrator'],[otherGroupId,actors.outsider,'owner']] as const)await db.query('INSERT INTO group_memberships(group_id,account_id,role) VALUES($1,$2,$3)',[group,actor.accountId,role]);
  let now=new Date('2026-10-23T00:00:00Z');
  const clock=()=>new Date(now),access=new AccessService(db,clock),governance=new GovernanceService(db,access,clock);
  const expiry=(hours=1)=>new Date(now.getTime()+hours*3600000).toISOString();
  const reportAccount=async(subject=actors.owner)=>{
    const report=await governance.submit(actors.reporter,{targetType:'account',targetId:subject.accountId,body:'账号问题'});
    await governance.assign(actors.admin,report.id);return report;
  };
  return {...database,...actors,groupId,otherGroupId,access,governance,clock,expiry,reportAccount,advance(ms:number){now=new Date(now.getTime()+ms);}};
}

test('central access checks scope, ownership, group boundary, current membership and untrusted fields',async t=>{
  const f=await fixture(t),{access,owner,reporter,outsider,groupAdmin,admin,groupId,otherGroupId}=f;
  const publicObject=await access.createObject(owner,{scope:'public'});
  const groupObject=await access.createObject(owner,{scope:'group',groupId});
  const otherGroupObject=await access.createObject(outsider,{scope:'group',groupId:otherGroupId});
  const selfObject=await access.createObject(owner,{scope:'self'});
  const directObject=await access.createObject(owner,{scope:'direct',recipientAccountIds:[reporter.accountId]});
  assert.equal((await access.readObject(null,publicObject.id)).ownerId,owner.accountId);
  assert.equal((await access.authorizeObject(owner,publicObject.id,'write')).id,publicObject.id);
  for(const actor of [reporter,outsider,groupAdmin])await assert.rejects(access.authorizeObject(actor,publicObject.id,'write'),errorStatus(403));
  assert.equal((await access.readObject(reporter,groupObject.id)).id,groupObject.id);
  assert.equal((await access.authorizeObject(groupAdmin,groupObject.id,'manage')).id,groupObject.id);
  await assert.rejects(access.authorizeObject(groupAdmin,groupObject.id,'write'),errorStatus(403));
  await assert.rejects(access.authorizeObject(groupAdmin,otherGroupObject.id,'manage'),errorStatus(403));
  await assert.rejects(access.authorizeObject(groupAdmin,publicObject.id,'manage'),errorStatus(403));
  assert.equal((await access.authorizeObject(admin,otherGroupObject.id,'manage')).id,otherGroupObject.id);
  await assert.rejects(access.authorizeObject({...admin,mfaVerified:false},publicObject.id,'manage'),errorStatus(403));
  await assert.rejects(access.authorizeObject({...outsider,role:'administrator',mfaVerified:true},publicObject.id,'manage'),errorStatus(403));
  for(const actor of [null,reporter,outsider,admin])await assert.rejects(access.readObject(actor,selfObject.id),errorStatus(403));
  assert.equal((await access.readObject(owner,selfObject.id)).id,selfObject.id);
  assert.deepEqual((await access.readObject(owner,directObject.id)).recipientAccountIds,[reporter.accountId]);
  assert.deepEqual((await access.readObject(reporter,directObject.id)).recipientAccountIds,[]);
  await assert.rejects(access.readObject(outsider,directObject.id),errorStatus(403));
  await assert.rejects(access.readObject(admin,directObject.id),errorStatus(403));
  await f.db.query("UPDATE group_memberships SET state='left' WHERE group_id=$1 AND account_id=$2",[groupId,owner.accountId]);
  await assert.rejects(access.readObject(owner,groupObject.id),errorStatus(403));
  await assert.rejects(access.createObject(owner,{scope:'group',groupId}),errorStatus(403));
  await assert.rejects(access.readObject(admin,groupObject.id),errorStatus(403));
  for(const input of [
    {scope:'public',ownerId:outsider.accountId},{scope:'public',actorId:outsider.accountId},{scope:'public',role:'administrator'},
    {scope:'public',groupId},{scope:'self',recipientAccountIds:[reporter.accountId]},{scope:'direct'},
    {scope:'direct',recipientAccountIds:[reporter.accountId,reporter.accountId]},
    {scope:'direct',recipientAccountIds:[randomUUID()]},{scope:'direct',recipientAccountIds:['invalid']},
    {scope:'group',groupId:'invalid'},{scope:'unknown'},null,[],
  ])await assert.rejects(access.createObject(reporter,input),errorStatus(400));
  await f.db.query("UPDATE accounts SET role='member' WHERE id=$1",[admin.accountId]);
  await assert.rejects(access.assertPlatformAdmin(admin),errorStatus(403));
  await assert.rejects(access.createObject({...owner,accountId:randomUUID()},{scope:'public'}),errorStatus(401));
});

test('report, audited case evidence, object restriction and subject appeal restore actual authorization',async t=>{
  const f=await fixture(t),{access,governance,owner,reporter,outsider,admin,admin2}=f;
  const target=await access.createObject(owner,{scope:'public'});
  const body='private-report-text-9d44',evidence='private-evidence-text-38ba',reason='private-decision-reason-33ef';
  const report=await governance.submit(reporter,{targetType:'object',targetId:target.id,body,evidence});
  assert.equal((await governance.get(reporter,report.id)).body,body);
  assert.deepEqual(await governance.listMine(outsider),[]);
  assert.deepEqual(await governance.listMine(owner),[]);
  await assert.rejects(governance.get(outsider,report.id),errorStatus(403));
  await assert.rejects(governance.get(owner,report.id),errorStatus(403));
  for(const operation of [()=>governance.listQueue({...admin,mfaVerified:false}),()=>governance.assign({...admin,mfaVerified:false},report.id),()=>governance.readEvidence(admin,report.id)])await assert.rejects(operation(),errorStatus(403));
  const queue=await governance.listQueue(admin);
  assert.equal(queue.length,1);assert.equal(JSON.stringify(queue).includes(body),false);
  await governance.assign(admin,report.id,{expectedVersion:1});
  await assert.rejects(governance.assign(admin,report.id,{expectedVersion:1}),errorCode('conflict'));
  await assert.rejects(governance.readEvidence(admin2,report.id),errorStatus(403));
  assert.equal('body' in await governance.get(admin,report.id),false);
  const selected=await governance.readEvidence(admin,report.id);
  assert.equal(selected.body,body);assert.equal(selected.evidence[0].body,evidence);
  await governance.decide(admin,report.id,{action:'restrict_object',reason,expiresAt:f.expiry(),expectedVersion:2});
  assert.equal((await access.readObject(owner,target.id)).state,'restricted');
  await assert.rejects(access.readObject(reporter,target.id),errorStatus(403));
  await assert.rejects(access.authorizeObject(owner,target.id,'write'),errorStatus(403));
  assert.equal((await governance.listMine(owner)).length,1);
  assert.equal('body' in await governance.get(owner,report.id),false);
  await assert.rejects(governance.appeal(outsider,report.id,{body:'无关用户'}),errorStatus(403));
  const appeal=await governance.appeal(owner,report.id,{body:'private-appeal-text-5fbd'});
  await assert.rejects(governance.appeal(reporter,report.id,{body:'重复申诉'}),errorStatus(409));
  assert.equal('body' in (await governance.get(admin,report.id)).appeals[0],false);
  assert.equal((await governance.readEvidence(admin,report.id)).appeals[0].body,'private-appeal-text-5fbd');
  await assert.rejects(governance.reviewAppeal({...admin,mfaVerified:false},appeal.id,{outcome:'restore',reason:'复核'}),errorStatus(403));
  await governance.reviewAppeal(admin,appeal.id,{outcome:'restore',reason:'private-review-reason-74de'});
  assert.equal((await access.readObject(reporter,target.id)).state,'visible');
  assert.equal((await access.authorizeObject(owner,target.id,'write')).state,'visible');
  assert.equal((await governance.get(owner,report.id)).status,'closed');
  await assert.rejects(governance.reviewAppeal(admin,appeal.id,{outcome:'uphold',reason:'重复'}),errorStatus(409));
  const audit=await governance.listAudit(admin,report.id);
  assert.deepEqual(audit.map(row=>row.eventType),['report.submitted','report.assigned','evidence.read','report.decided','appeal.submitted','evidence.read','appeal.reviewed']);
  for(const secret of [body,evidence,reason,'private-appeal-text-5fbd','private-review-reason-74de'])assert.equal(JSON.stringify(audit).includes(secret),false);
  await assert.rejects(governance.listAudit(reporter,report.id),errorStatus(403));
  await assert.rejects(governance.listAudit(admin2,report.id),errorStatus(403));
});

test('account capability restrictions gate writes and sends, overlap safely, expire and survive reconnect',async t=>{
  const f=await fixture(t),{governance,access,owner,reporter,admin}=f;
  const first=await f.reportAccount(),second=await f.reportAccount();
  await governance.decide(admin,first.id,{action:'restrict_account',reason:'首次处置',capabilities:['write'],expiresAt:f.expiry(1)});
  await governance.decide(admin,second.id,{action:'restrict_account',reason:'独立案件',capabilities:['send_message'],expiresAt:f.expiry(2)});
  await assert.rejects(access.createObject(owner,{scope:'public'}),errorStatus(403));
  for(const capability of ['write','send_message','create_group'] as const)await assert.rejects(access.assertCapability(owner,capability),errorStatus(403));
  // Restricted authors can still report and appeal their treatment.
  await governance.submit(owner,{kind:'suggestion',targetType:'account',targetId:owner.accountId,body:'仍可反馈'});
  const appeal=await governance.appeal(owner,first.id,{body:'请求恢复'});
  await governance.reviewAppeal(admin,appeal.id,{outcome:'restore',reason:'恢复此案'});
  await access.createObject(owner,{scope:'self'});
  await access.assertCapability(owner,'write');await access.assertCapability(owner,'create_group');
  await assert.rejects(access.assertCapability(owner,'send_message'),errorStatus(403));
  const reconnected=createDatabase(f.url);t.after(()=>reconnected.close());
  const reopened=new AccessService(reconnected,f.clock);
  await assert.rejects(reopened.assertCapability(owner,'send_message'),errorStatus(403));
  assert.equal((await new GovernanceService(reconnected,reopened,f.clock).get(reporter,second.id)).status,'decided');
  f.advance(2*3600000);
  await reopened.assertCapability(owner,'send_message');
  const restriction=await f.db.query<{revoked_at:Date|null}>('SELECT revoked_at FROM account_restrictions WHERE decision_id IN(SELECT id FROM governance_decisions WHERE report_id=$1)',[second.id]);
  assert.equal(restriction.rows[0].revoked_at,null,'expiry is enforced on use without relying on an async cleanup worker');
});

test('expired object restriction is effective immediately and an older appeal cannot erase a newer case',async t=>{
  const f=await fixture(t),{access,governance,owner,reporter,admin}=f;
  const target=await access.createObject(owner,{scope:'public'});
  const first=await governance.submit(reporter,{targetType:'object',targetId:target.id,body:'第一案'});
  await governance.assign(admin,first.id);
  await governance.decide(admin,first.id,{action:'restrict_object',reason:'第一案限制',expiresAt:f.expiry(1)});
  const appeal=await governance.appeal(owner,first.id,{body:'第一案申诉'});
  f.advance(3600000);
  assert.equal((await access.readObject(null,target.id)).state,'visible');
  await access.authorizeObject(owner,target.id,'write');
  const second=await governance.submit(reporter,{targetType:'object',targetId:target.id,body:'第二案'});
  await governance.assign(admin,second.id);
  const latest=await governance.decide(admin,second.id,{action:'restrict_object',reason:'新限制',expiresAt:f.expiry(2)});
  await assert.rejects(governance.reviewAppeal(admin,appeal.id,{outcome:'restore',reason:'旧案恢复'}),errorStatus(409));
  const raw=await f.db.query<{restriction_decision_id:string}>('SELECT restriction_decision_id FROM protected_objects WHERE id=$1',[target.id]);
  assert.equal(raw.rows[0].restriction_decision_id,latest.decisionId);
  assert.equal((await governance.get(owner,first.id)).status,'appealed');
  await governance.decide(admin,second.id,{action:'restore_object',reason:'恢复新案限制'});
  assert.equal((await access.readObject(reporter,target.id)).state,'visible');
});

test('governance rejects forged identity, invalid decisions, inaccessible targets and stale versions',async t=>{
  const f=await fixture(t),{governance,access,owner,reporter,outsider,admin}=f;
  const privateObject=await access.createObject(owner,{scope:'self'});
  await assert.rejects(governance.submit(reporter,{targetType:'object',targetId:privateObject.id,body:'越权读取'}),errorStatus(403));
  for(const field of ['actorId','role','ownerId'])await assert.rejects(governance.submit(reporter,{targetType:'account',targetId:owner.accountId,body:'反馈',[field]:admin.accountId}),errorStatus(400));
  const report=await f.reportAccount();
  for(const input of [
    {action:'restrict_account',reason:'理由',capabilities:['write']},
    {action:'restrict_account',reason:'理由',capabilities:['write'],expiresAt:'2026-02-30T00:00:00Z'},
    {action:'restrict_account',reason:'理由',capabilities:['write'],expiresAt:f.expiry(24*366)},
    {action:'restrict_account',reason:'理由',capabilities:['read'],expiresAt:f.expiry()},
    {action:'restrict_account',reason:'理由',capabilities:['write','write'],expiresAt:f.expiry()},
    {action:'restrict_account',reason:'理由',capabilities:[],expiresAt:f.expiry()},
    {action:'no_action',reason:'理由',expiresAt:f.expiry()},
    {action:'no_action',reason:'理由',capabilities:['write']},
    {action:'no_action',reason:'   '},{action:'ban',reason:'理由'},
    {action:'restrict_object',reason:'类型不匹配',expiresAt:f.expiry()},
    {action:'no_action',reason:'伪造角色',role:'administrator'},
    {action:'no_action',reason:'版本必须是数值',expectedVersion:'2'},
  ])await assert.rejects(governance.decide(admin,report.id,input),errorStatus(400));
  await assert.rejects(governance.decide(outsider,report.id,{action:'no_action',reason:'非管理'}),errorStatus(403));
  await assert.rejects(governance.decide(admin,report.id,{action:'no_action',reason:'版本冲突',expectedVersion:1}),errorStatus(409));
  const counts=await f.db.query<{count:number}>('SELECT count(*)::int AS count FROM governance_decisions');assert.equal(counts.rows[0].count,0);
  await governance.decide(admin,report.id,{action:'no_action',reason:'无处置',expectedVersion:2});
  await assert.rejects(governance.decide(admin,report.id,{action:'no_action',reason:'重复'}),errorStatus(409));
  const appeal=await governance.appeal(reporter,report.id,{body:'举报者请求复核'});
  await assert.rejects(governance.reviewAppeal(admin,appeal.id,{outcome:'restore',reason:'无处置可恢复'}),errorStatus(400));
  await governance.reviewAppeal(admin,appeal.id,{outcome:'uphold',reason:'复核维持'});
});

test('PostgreSQL failure and caller rollback cannot commit effects without the matching audit',async t=>{
  const f=await fixture(t),{governance,access,owner,admin}=f;
  const report=await f.reportAccount();
  await f.db.query(`CREATE FUNCTION reject_decision_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
    IF NEW.event_type='report.decided' THEN RAISE EXCEPTION 'test audit storage unavailable'; END IF;
    RETURN NEW; END $$`);
  await f.db.query('CREATE TRIGGER reject_decision_audit BEFORE INSERT ON audit_events FOR EACH ROW EXECUTE FUNCTION reject_decision_audit()');
  await assert.rejects(governance.decide(admin,report.id,{action:'restrict_account',reason:'事务回滚',capabilities:['write','send_message'],expiresAt:f.expiry()}),/test audit storage unavailable/);
  const effects=await f.db.query<{decisions:number;restrictions:number;audits:number}>(`SELECT
    (SELECT count(*)::int FROM governance_decisions) AS decisions,
    (SELECT count(*)::int FROM account_restrictions) AS restrictions,
    (SELECT count(*)::int FROM audit_events WHERE event_type='report.decided') AS audits`);
  assert.deepEqual(effects.rows[0],{decisions:0,restrictions:0,audits:0});
  assert.equal((await governance.get(admin,report.id)).status,'assigned');
  await access.assertCapability(owner,'write');
  await f.db.query('DROP TRIGGER reject_decision_audit ON audit_events');
  await assert.rejects(f.db.transaction(async sql=>{
    await governance.decide(admin,report.id,{action:'restrict_account',reason:'外层回滚',capabilities:['write'],expiresAt:f.expiry()},sql);
    throw Error('rollback outer idempotency transaction');
  }),/rollback outer idempotency transaction/);
  assert.equal((await governance.get(admin,report.id)).status,'assigned');
  await access.createObject(owner,{scope:'public'});
  await governance.decide(admin,report.id,{action:'restrict_account',reason:'实际提交',capabilities:['write'],expiresAt:f.expiry()});
  await assert.rejects(access.createObject(owner,{scope:'public'}),errorStatus(403));
});

test('concurrent decisions serialize and capability check holds the subject lock until business commit',async t=>{
  const f=await fixture(t),{governance,access,owner,admin}=f;
  const report=await f.reportAccount();
  const attempts=await Promise.allSettled([
    governance.decide(admin,report.id,{action:'restrict_account',reason:'并发一',capabilities:['send_message'],expiresAt:f.expiry()}),
    governance.decide(admin,report.id,{action:'restrict_account',reason:'并发二',capabilities:['send_message'],expiresAt:f.expiry()}),
  ]);
  assert.equal(attempts.filter(result=>result.status==='fulfilled').length,1);
  const failed=attempts.find(result=>result.status==='rejected');assert.ok(failed?.status==='rejected'&&errorStatus(409)(failed.reason));
  const count=await f.db.query<{count:number}>('SELECT count(*)::int AS count FROM governance_decisions WHERE report_id=$1',[report.id]);assert.equal(count.rows[0].count,1);
  await governance.decide(admin,report.id,{action:'restore_account',reason:'恢复并发测试限制'});
  const next=await f.reportAccount();
  let unlock!:()=>void,checked!:()=>void;
  const gate=new Promise<void>(resolve=>{unlock=resolve;}),ready=new Promise<void>(resolve=>{checked=resolve;});
  const write=f.db.transaction(async sql=>{await access.assertCapability(owner,'write',sql);checked();await gate;return access.createObject(owner,{scope:'public'},sql);});
  await ready;
  const decision=governance.decide(admin,next.id,{action:'restrict_account',reason:'与写入串行',capabilities:['write'],expiresAt:f.expiry()});
  // The restriction waits on the same subject row; no time-based assertion or fake DB is needed.
  unlock();const item=await write;await decision;
  assert.equal((await access.readObject(owner,item.id)).id,item.id);
  await assert.rejects(access.createObject(owner,{scope:'public'}),errorStatus(403));
});

test('a write restriction also gates administrator mutations while preserving report and appeal access',async t=>{
  const f=await fixture(t),{governance,owner,reporter,admin,admin2}=f;
  const assigned=await f.reportAccount(),reviewed=await f.reportAccount();
  await governance.decide(admin,reviewed.id,{action:'restrict_account',reason:'待复核案件',capabilities:['send_message'],expiresAt:f.expiry()});
  const pending=await governance.appeal(owner,reviewed.id,{body:'请求复核'});
  const restriction=await governance.submit(reporter,{targetType:'account',targetId:admin.accountId,body:'管理员也受账号权限限制'});
  await governance.assign(admin2,restriction.id);
  await governance.decide(admin2,restriction.id,{action:'restrict_account',reason:'限制管理写入',capabilities:['write'],expiresAt:f.expiry()});
  await assert.rejects(governance.assign(admin,assigned.id),errorStatus(403));
  await assert.rejects(governance.decide(admin,assigned.id,{action:'no_action',reason:'不能绕过账号限制'}),errorStatus(403));
  await assert.rejects(governance.reviewAppeal(admin,pending.id,{outcome:'restore',reason:'不能绕过账号限制'}),errorStatus(403));
  await governance.readEvidence(admin,assigned.id);
  const appeal=await governance.appeal(admin,restriction.id,{body:'仍可申诉'});
  await governance.reviewAppeal(admin2,appeal.id,{outcome:'restore',reason:'恢复此管理员本案写入限制'});
  await governance.decide(admin,assigned.id,{action:'no_action',reason:'恢复后可处理'});
  assert.equal((await governance.get(admin,assigned.id)).status,'decided');
});
