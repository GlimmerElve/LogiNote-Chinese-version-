import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {AccessService} from '../src/access.js';
import {ContentService} from '../src/content.js';
import {GovernanceService} from '../src/governance.js';
import {createTestDatabase} from './helpers.js';
import type {Actor} from '../src/types.js';

test('comment removal is author-only, keeps evidence and replies, and respects parent visibility and moderation',async t=>{
  const fixture=await createTestDatabase('comment_remove'),db=fixture.db,access=new AccessService(db),content=new ContentService(db,access);
  t.after(()=>fixture.cleanup());
  const account=async():Promise<Actor>=>{const accountId=randomUUID();await db.query('INSERT INTO accounts(id,email,password_hash) VALUES($1,$2,$3)',[accountId,accountId+'@comment.test','synthetic-test-only']);return {accountId,role:'member',mfaVerified:false};};
  const a=await account(),b=await account();
  const post=await db.transaction(sql=>content.create(a,{kind:'question',body:'An isolated public question',scope:'public'},sql));
  const first=await db.transaction(sql=>content.comment(a,post.id,{body:'Original comment evidence'},sql));
  const reply=await db.transaction(sql=>content.comment(b,post.id,{body:'Independent reply',replyToId:first.id},sql));
  await assert.rejects(db.transaction(sql=>content.removeComment(b,first.id,sql)),{status:403});
  await db.transaction(sql=>content.solution(a,post.id,{commentId:first.id},sql));
  await db.transaction(sql=>content.removeComment(a,first.id,sql));
  assert.deepEqual((await content.comments(b,post.id)).items.map(item=>item.id),[reply.id]);
  const detail=await content.get(b,post.id);assert.equal(detail.commentCount,1);assert.equal(detail.acceptedCommentId,null);
  assert.equal((await db.query('SELECT body FROM community_comments WHERE object_id=$1',[first.id])).rows[0].body,'Original comment evidence');
  assert.deepEqual(await db.transaction(sql=>content.removeComment(a,first.id,sql)),{withdrawn:true});
  await assert.rejects(db.transaction(sql=>content.removeComment(a,post.id,sql)),{status:404});
  const pending=await db.transaction(sql=>content.comment(a,post.id,{body:'Moderated comment'},sql));
  await db.query("UPDATE protected_objects SET state='restricted',restricted_until=now()+interval '1 day' WHERE id=$1",[pending.id]);
  await assert.rejects(db.transaction(sql=>content.removeComment(a,pending.id,sql)),{status:403});
  await db.query("UPDATE protected_objects SET state='withdrawn' WHERE id=$1",[post.id]);
  await assert.rejects(db.transaction(sql=>content.removeComment(b,reply.id,sql)),{status:403});
  assert.equal((await db.query('SELECT state FROM protected_objects WHERE id=$1',[reply.id])).rows[0].state,'visible');
});

test('expired moderation appeals cannot revive author-deleted comments or withdrawn posts',async t=>{
  const fixture=await createTestDatabase('comment_appeal_expiry'),db=fixture.db;let now=new Date('2026-10-25T09:00:00Z');
  t.after(()=>fixture.cleanup());const clock=()=>new Date(now),access=new AccessService(db,clock),content=new ContentService(db,access,clock),governance=new GovernanceService(db,access,clock);
  const account=async(role:Actor['role']='member'):Promise<Actor>=>{const accountId=randomUUID();await db.query('INSERT INTO accounts(id,email,password_hash,role) VALUES($1,$2,$3,$4)',[accountId,`${accountId}@comment-appeal.example.test`,'synthetic-test-only',role]);return {accountId,role,mfaVerified:role==='administrator'};};
  const author=await account(),reporter=await account(),admin=await account('administrator');
  const question=await db.transaction(sql=>content.create(author,{kind:'question',body:'Public parent for evidence retention',scope:'public'},sql));
  const pendingAppeal=async(targetId:string)=>{
    const report=await governance.submit(reporter,{targetType:'object',targetId,body:'Synthetic temporary moderation dispute'}),assigned=await governance.assign(admin,report.id);
    await governance.decide(admin,report.id,{action:'restrict_object',reason:'Temporary restriction for the isolated regression',expiresAt:new Date(now.getTime()+60000).toISOString(),expectedVersion:assigned.version});
    const appeal=await governance.appeal(author,report.id,{body:'Please review the temporary restriction'});now=new Date(now.getTime()+61000);return {reportId:report.id,appealId:appeal.id};
  };
  await t.test('deleted comment stays hidden, original evidence survives and a failed restore commits no appeal result',async()=>{
    const comment=await db.transaction(sql=>content.comment(author,question.id,{body:'Retained comment evidence after deliberate deletion'},sql)),item=await pendingAppeal(comment.id);
    await db.transaction(sql=>content.removeComment(author,comment.id,sql));
    await assert.rejects(governance.reviewAppeal(admin,item.appealId,{outcome:'restore',reason:'An old appeal must not undo deliberate deletion'}),{status:409});
    assert.equal((await db.query('SELECT state FROM protected_objects WHERE id=$1',[comment.id])).rows[0].state,'withdrawn');
    assert.equal((await db.query('SELECT body FROM community_comments WHERE object_id=$1',[comment.id])).rows[0].body,'Retained comment evidence after deliberate deletion');
    assert.equal((await content.comments(reporter,question.id)).items.some(row=>row.id===comment.id),false);
    assert.equal((await db.query('SELECT status FROM appeals WHERE id=$1',[item.appealId])).rows[0].status,'pending');
    assert.equal((await governance.listAudit(admin,item.reportId)).filter(event=>event.eventType==='appeal.reviewed').length,0);
    await governance.reviewAppeal(admin,item.appealId,{outcome:'uphold',reason:'Content remains withdrawn by its author; evidence is retained'});
  });
  await t.test('withdrawn post is not republished; an author-restored visible post closes the appeal without another object write',async()=>{
    const post=await db.transaction(sql=>content.create(author,{kind:'post',body:'Post body retained after withdrawal',scope:'public'},sql)),item=await pendingAppeal(post.id);
    await db.transaction(sql=>content.withdraw(author,post.id,sql));
    await assert.rejects(governance.reviewAppeal(admin,item.appealId,{outcome:'restore',reason:'The old case cannot republish a withdrawn post'}),{status:409});
    assert.equal((await db.query('SELECT state FROM protected_objects WHERE id=$1',[post.id])).rows[0].state,'withdrawn');
    await assert.rejects(content.get(reporter,post.id),{status:403});
    assert.equal((await db.query('SELECT body FROM community_entries WHERE object_id=$1',[post.id])).rows[0].body,'Post body retained after withdrawal');
    await db.transaction(sql=>content.restore(author,post.id,sql));
    const before=(await db.query('SELECT state,version,restriction_decision_id FROM protected_objects WHERE id=$1',[post.id])).rows[0];
    assert.equal((await governance.reviewAppeal(admin,item.appealId,{outcome:'restore',reason:'Author already restored visibility; close review without rewriting content'})).status,'restored');
    assert.deepEqual((await db.query('SELECT state,version,restriction_decision_id FROM protected_objects WHERE id=$1',[post.id])).rows[0],before);
    assert.equal((await content.get(reporter,post.id)).body,'Post body retained after withdrawal');
  });
});
