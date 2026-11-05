import assert from 'node:assert/strict';
import test from 'node:test';
import {randomUUID} from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {AccessService} from '../src/access.js';
import {ContentService} from '../src/content.js';
import {FileService} from '../src/files.js';
import {GovernanceService} from '../src/governance.js';
import {GroupService} from '../src/groups.js';
import {GroupTaskService} from '../src/groupTasks.js';
import {ApiError} from '../src/errors.js';
import {QuotaService} from '../src/operations.js';
import {ResourceService} from '../src/resources.js';
import type {Actor} from '../src/types.js';
import {createTestDatabase} from './helpers.js';

const forbidden=(error:unknown)=>error instanceof ApiError&&error.status===403;

test('group-root reports govern the whole room through existing object cases and appeals',async t=>{
  const fixture=await createTestDatabase('phase6_group_governance'),directory=await fs.mkdtemp(path.join(os.tmpdir(),'loginote-group-governance-'));
  t.after(async()=>{await fixture.cleanup();assert.equal(path.dirname(path.resolve(directory)),path.resolve(os.tmpdir()));assert.ok(path.basename(directory).startsWith('loginote-group-governance-'));await fs.rm(directory,{recursive:true,force:true});});
  const {db}=fixture;let now=new Date('2026-10-25T07:00:00Z');const clock=()=>new Date(now),access=new AccessService(db,clock),content=new ContentService(db,access,clock),files=new FileService(db,access,new QuotaService(db,{globalLimitBytes:10000000},clock),{directory,grantKey:fixture.encryptionKey},clock),groups=new GroupService(db,access,files,clock),tasks=new GroupTaskService(db,access,groups,clock),resources=new ResourceService(db,access,files,clock),governance=new GovernanceService(db,access,clock);
  const account=async(name:string,role:Actor['role']='member'):Promise<Actor>=>{const accountId=randomUUID();await db.query('INSERT INTO accounts(id,email,password_hash,display_name,role,email_verified_at) VALUES($1,$2,$3,$4,$5,$6)',[accountId,`${accountId}@group-governance.example.test`,'synthetic-test-not-a-password',name,role,clock()]);return {accountId,role,mfaVerified:role==='administrator'};};
  const owner=await account('群主'),member=await account('成员'),reporter=await account('举报者'),outsider=await account('无关用户'),admin=await account('受理管理员','administrator'),admin2=await account('其他管理员','administrator');
  const create=(who:Actor,name:string)=>db.transaction(sql=>groups.create(who,{name},sql));
  const join=(who:Actor,id:string)=>db.transaction(sql=>groups.membership(who,id,{action:'join'},sql));
  const room=await create(owner,'群本体治理验证');await join(member,room.id);
  const message=await db.transaction(sql=>groups.send(member,room.id,{body:'仅本群可读的聊天',clientId:randomUUID()},sql));
  const task=await db.transaction(sql=>tasks.create(owner,room.id,{title:'仅本群可读的任务'},sql));
  const entry=await db.transaction(sql=>content.create(member,{kind:'post',body:'仅本群可读的学习记录',scope:'group',groupId:room.id},sql));
  const stage=await db.transaction(sql=>resources.stage(owner,sql)),bytes=Buffer.from('private group material\n','utf8'),intent=await resources.intent(owner,stage.stageId,{name:'群资料.txt',mime:'text/plain',bytes:bytes.length,role:'main'},randomUUID());
  await files.put(owner,intent.attachmentId,intent.uploadToken,bytes);
  const resource=await db.transaction(async sql=>{const item=await content.create(owner,{kind:'resource',title:'群内资料',body:bytes.toString('utf8'),scope:'group',groupId:room.id},sql);await resources.publish(owner,item.id,stage.stageId,undefined,sql);return item;});
  const version=await resources.version(member,resource.id);assert.ok(version);
  const grant=await files.createDownload(member,intent.attachmentId);
  await db.transaction(sql=>content.relation(member,resource.id,'bookmark',{enabled:true},sql));
  const publicResource=await db.transaction(async sql=>{const item=await content.create(owner,{kind:'resource',title:'独立公开资料',body:'群外独立公开的正文',scope:'public'},sql);await resources.publish(owner,item.id,undefined,undefined,sql);return item;});
  const reportRoom=async(id=room.id)=>{const item=await governance.submit(reporter,{targetType:'object',targetId:id,category:'serious_risk',body:'对共学群整体行为的合成投诉',evidence:'举报者主动提交的相关上下文'});return governance.assign(admin,item.id,{expectedVersion:item.version});};
  const restrict=async(report:{id:string;version:number},minutes=60)=>governance.decide(admin,report.id,{action:'restrict_object',reason:'人工核实后暂时限制本群访问',expiresAt:new Date(now.getTime()+minutes*60000).toISOString(),expectedVersion:report.version});
  let originalReport:Awaited<ReturnType<typeof reportRoom>>;

  await t.test('new groups automatically have a public report identity owned by their creator',async()=>{
    const root=await access.readObject(reporter,room.id);
    assert.equal(root.scope,'public');assert.equal(root.groupId,null);assert.equal(root.ownerId,owner.accountId);
    await assert.rejects(groups.history(outsider,room.id),forbidden);
    const rawId=randomUUID();await db.query('INSERT INTO groups(id,owner_id) VALUES($1,$2)',[rawId,outsider.accountId]);
    assert.equal((await access.readObject(reporter,rawId)).ownerId,outsider.accountId,'the invariant also covers internal group creation paths');
  });

  await t.test('restricting a room blocks chat, tasks, group resources, lists and already-issued file grants for every member',async()=>{
    originalReport=await reportRoom();await restrict(originalReport);
    for(const who of [owner,member,admin]){
      await assert.rejects(groups.detail(who,room.id),forbidden);
      await assert.rejects(groups.history(who,room.id),forbidden);
      await assert.rejects(groups.members(who,room.id),forbidden);
      await assert.rejects(groups.pins(who,room.id),forbidden);
      await assert.rejects(tasks.list(who,room.id),forbidden);
      await assert.rejects(tasks.get(who,room.id,task.id),forbidden);
      await assert.rejects(content.get(who,entry.id),forbidden);
      await assert.rejects(resources.version(who,resource.id),forbidden);
      await assert.rejects(files.createDownload(who,intent.attachmentId),forbidden);
    }
    await assert.rejects(files.download(member,intent.attachmentId,grant.token),forbidden);
    await assert.rejects(resources.previewUnit(member,resource.id,version.id,'document'),forbidden);
    await assert.rejects(groups.draft(member,room.id),forbidden);
    await assert.rejects(groups.contentDraft(member,room.id,'post'),forbidden);
    await assert.rejects(content.list(member,{view:'group',groupId:room.id}),forbidden);
    assert.equal((await content.list(owner,{view:'mine'})).items.some(item=>item.id===resource.id),false);
    assert.equal((await content.list(member,{view:'mine'})).items.some(item=>item.id===entry.id),false);
    assert.equal((await content.list(member,{view:'bookmarks'})).items.some(item=>item.id===resource.id),false);
    assert.equal((await groups.list(owner,{view:'mine'})).items.some(item=>item.id===room.id),false);
    assert.equal((await groups.list(null,{view:'discover'})).items.some(item=>item.id===room.id),false);
    assert.equal((await resources.version(null,publicResource.id))?.body,'群外独立公开的正文');
    await access.assertCapability(owner,'write');
  });

  await t.test('the owner cannot evade room moderation through rename, archive, transfer, dissolution or direct content actions',async()=>{
    await assert.rejects(db.transaction(sql=>groups.update(owner,room.id,{name:'换个名字继续'},sql)),forbidden);
    await assert.rejects(db.transaction(sql=>groups.update(owner,room.id,{state:'archived'},sql)),forbidden);
    await assert.rejects(db.transaction(sql=>groups.manage(owner,room.id,member.accountId,{action:'transfer'},sql)),forbidden);
    await assert.rejects(db.transaction(sql=>groups.dissolve(owner,room.id,sql)),forbidden);
    await assert.rejects(db.transaction(sql=>groups.membership(outsider,room.id,{action:'join'},sql)),forbidden);
    await assert.rejects(db.transaction(sql=>groups.send(owner,room.id,{body:'被限制后不能再发送',clientId:randomUUID()},sql)),forbidden);
    await assert.rejects(db.transaction(sql=>content.update(member,entry.id,{body:'尝试修改群记录'},sql)),forbidden);
    await assert.rejects(db.transaction(sql=>tasks.create(owner,room.id,{title:'尝试新建任务'},sql)),forbidden);
    assert.equal((await db.query('SELECT owner_id,state FROM groups WHERE id=$1',[room.id])).rows[0].owner_id,owner.accountId);
    assert.equal((await db.query('SELECT state FROM groups WHERE id=$1',[room.id])).rows[0].state,'active');
  });

  await t.test('evidence is still limited to the assigned MFA administrator and owner appeal restores the same room',async()=>{
    await assert.rejects(governance.readEvidence(admin2,originalReport.id),forbidden);
    await assert.rejects(governance.readEvidence({...admin,mfaVerified:false},originalReport.id),forbidden);
    assert.equal((await governance.readEvidence(admin,originalReport.id)).evidence[0].body,'举报者主动提交的相关上下文');
    const appeal=await governance.appeal(owner,originalReport.id,{body:'请求复核对整个群的限制'});
    await governance.reviewAppeal(admin,appeal.id,{outcome:'restore',reason:'合成复核完成，恢复本群'});
    assert.equal((await groups.detail(member,room.id)).membership,'active');
    assert.equal((await groups.history(member,room.id)).items[0].id,message.id);
    assert.equal((await tasks.get(member,room.id,task.id)).title,'仅本群可读的任务');
    assert.deepEqual((await files.download(member,intent.attachmentId,grant.token)).buffer,bytes);
    assert.equal((await resources.version(member,resource.id))?.id,version.id);
    const audit=await governance.listAudit(admin,originalReport.id);
    assert.ok(audit.some(row=>row.eventType==='report.decided'));assert.ok(audit.some(row=>row.eventType==='appeal.reviewed'));
  });

  await t.test('transfer updates the moderation owner and a report decided afterwards is appealable by the current owner',async()=>{
    const second=await create(owner,'转让后的投诉');await join(member,second.id);
    const report=await reportRoom(second.id);
    await db.transaction(sql=>groups.manage(owner,second.id,member.accountId,{action:'transfer'},sql));
    assert.equal((await access.readObject(reporter,second.id)).ownerId,member.accountId);
    await restrict(report);
    await assert.rejects(governance.appeal(owner,report.id,{body:'原群主不能代替新群主申诉'}),forbidden);
    const appeal=await governance.appeal(member,report.id,{body:'现任群主申请复核'});
    await governance.reviewAppeal(admin,appeal.id,{outcome:'restore',reason:'恢复新群主负责的原群'});
    assert.equal((await groups.detail(member,second.id)).role,'owner');
  });

  await t.test('temporary root restrictions expire on access without a background cleanup job',async()=>{
    const report=await reportRoom();await restrict(report,1);
    await assert.rejects(content.get(member,entry.id),forbidden);
    now=new Date(now.getTime()+61000);
    assert.equal((await content.get(member,entry.id)).id,entry.id);
    assert.equal((await groups.detail(member,room.id)).membership,'active');
    assert.equal((await tasks.get(member,room.id,task.id)).id,task.id);
    assert.equal((await groups.list(null,{view:'discover'})).items.some(item=>item.id===room.id),true);
    await governance.decide(admin,report.id,{action:'restore_object',reason:'明确结束已到期的限制'});
  });

  await t.test('moderation and send share the room lock so a send waiting behind the decision cannot commit',async()=>{
    const report=await reportRoom();let release!:()=>void,ready!:()=>void;
    const gate=new Promise<void>(resolve=>{release=resolve;}),started=new Promise<void>(resolve=>{ready=resolve;});
    const decision=db.transaction(async sql=>{await governance.decide(admin,report.id,{action:'restrict_object',reason:'并发限制整个房间',expiresAt:new Date(now.getTime()+60000).toISOString(),expectedVersion:report.version},sql);ready();await gate;});
    await started;const clientId=randomUUID(),sending=db.transaction(sql=>groups.send(member,room.id,{body:'不应在限制提交后写入',clientId},sql));release();
    await decision;await assert.rejects(sending,forbidden);
    assert.equal((await db.query('SELECT object_id FROM group_room_messages WHERE group_id=$1 AND client_id=$2',[room.id,clientId])).rowCount,0);
    await governance.decide(admin,report.id,{action:'restore_object',reason:'并发验证完成'});
  });
});
