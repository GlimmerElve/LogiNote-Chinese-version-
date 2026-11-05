import assert from 'node:assert/strict';
import test from 'node:test';
import {randomUUID} from 'node:crypto';
import path from 'node:path';
import os from 'node:os';
import {AccessService} from '../src/access.js';
import type {Database} from '../src/db.js';
import {ApiError} from '../src/errors.js';
import {FileService} from '../src/files.js';
import {GroupLimitsService} from '../src/groupLimits.js';
import {GroupService} from '../src/groups.js';
import {QuotaService} from '../src/operations.js';
import type {Actor} from '../src/types.js';
import {createTestDatabase} from './helpers.js';

const code=(expected:string)=>(error:unknown)=>error instanceof ApiError&&error.code===expected;
const forbidden=(error:unknown)=>error instanceof ApiError&&error.status===403;

test('phase 6 administrator group limits govern real group operations without evicting existing members',async t=>{
  const fixture=await createTestDatabase('phase6_group_limits');t.after(()=>fixture.cleanup());
  const {db}=fixture,clock=()=>new Date('2026-10-25T06:00:00Z'),access=new AccessService(db,clock);
  // These cases never upload files; constructing the normal dependency creates no directory or process.
  const files=new FileService(db,access,new QuotaService(db,{globalLimitBytes:1000000},clock),{directory:path.join(os.tmpdir(),'unused-group-limit-'+randomUUID()),grantKey:fixture.encryptionKey},clock),groups=new GroupService(db,access,files,clock),settings=new GroupLimitsService(db,access,clock);
  const account=async(name:string,role:Actor['role']='member'):Promise<Actor>=>{const accountId=randomUUID();await db.query('INSERT INTO accounts(id,email,password_hash,display_name,role,email_verified_at) VALUES($1,$2,$3,$4,$5,$6)',[accountId,`${accountId}@limits.example.test`,'synthetic-test-not-a-password',name,role,clock()]);return {accountId,role,mfaVerified:role==='administrator'};};
  const admin=await account('平台管理员','administrator'),member=await account('普通用户');
  const update=async(memberLimit=50,createdGroupLimit=3,joinedGroupLimit=10)=>settings.update(admin,{expectedVersion:(await settings.get(admin)).version,memberLimit,createdGroupLimit,joinedGroupLimit});
  const create=(who:Actor,name:string,joinPolicy='open')=>db.transaction(sql=>groups.create(who,{name,joinPolicy},sql));
  const join=(who:Actor,id:string)=>db.transaction(sql=>groups.membership(who,id,{action:'join'},sql));
  const leave=(who:Actor,id:string)=>db.transaction(sql=>groups.membership(who,id,{action:'leave'},sql));
  const manage=(who:Actor,id:string,target:Actor,action:string)=>db.transaction(sql=>groups.manage(who,id,target.accountId,{action},sql));
  const archive=(who:Actor,id:string,state='archived')=>db.transaction(sql=>groups.update(who,id,{state},sql));

  await t.test('default values persist; reads and changes require current administrator role and MFA',async()=>{
    assert.deepEqual(await settings.get(admin),{version:1,memberLimit:50,createdGroupLimit:3,joinedGroupLimit:10});
    for(const actor of [member,{...member,role:'administrator' as const,mfaVerified:true},{...admin,mfaVerified:false}]){
      await assert.rejects(settings.get(actor),forbidden);
      await assert.rejects(settings.update(actor,{expectedVersion:1,memberLimit:20,createdGroupLimit:2,joinedGroupLimit:5}),forbidden);
    }
    const before=await settings.get(admin);
    for(const change of [{memberLimit:1},{memberLimit:501},{memberLimit:2.5},{createdGroupLimit:0},{createdGroupLimit:21},{joinedGroupLimit:0},{joinedGroupLimit:101},{createdGroupLimit:4,joinedGroupLimit:3},{memberLimit:'50'},{expectedVersion:undefined},{actorId:member.accountId}])await assert.rejects(settings.update(admin,{expectedVersion:before.version,memberLimit:50,createdGroupLimit:3,joinedGroupLimit:10,...change}),code('invalid_request'));
    assert.equal((await settings.get(admin)).version,before.version);
    assert.equal((await db.query('SELECT id FROM group_limit_changes')).rowCount,0);
  });

  await t.test('group size, creation, invitation, transfer and archive recovery all use current limits',async()=>{
    await update(3,2,4);
    const owner=await account('容量群主'),b=await account('第二群主'),c=await account('成员丙'),d=await account('成员丁');
    const one=await create(owner,'容量群一'),two=await create(owner,'容量群二'),other=await create(b,'第二人的群');
    await assert.rejects(create(owner,'超出动态创建上限'),code('group_limit'));
    await join(b,one.id);await join(c,one.id);
    await assert.rejects(join(d,one.id),code('group_full'));
    await assert.rejects(manage(owner,one.id,d,'invite'),code('group_full'));
    await update(2,1,4);
    assert.equal((await groups.detail(owner,one.id)).memberCount,3);
    assert.equal((await groups.detail(owner,one.id)).memberLimit,2);
    await access.assertGroupWrite(c,one.id,db);
    await leave(b,one.id);await assert.rejects(join(d,one.id),code('group_full'));
    await leave(c,one.id);await join(d,one.id);
    assert.equal((await groups.detail(d,one.id)).membership,'active');
    await assert.rejects(create(owner,'降限后不再新增群'),code('group_limit'));
    await archive(owner,two.id);
    await assert.rejects(archive(owner,two.id,'active'),code('group_limit'));
    await archive(owner,one.id);await archive(owner,two.id,'active');
    await join(b,two.id);
    await assert.rejects(manage(owner,two.id,b,'transfer'),code('group_limit'));
    await archive(b,other.id);await manage(owner,two.id,b,'transfer');
    assert.equal((await groups.detail(b,two.id)).role,'owner');
    assert.equal((await groups.detail(d,one.id)).membership,'active','lowering limits or archiving does not remove existing members');
  });

  await t.test('participation counts applications, approval rechecks lowered limits and invite acceptance rechecks capacity',async()=>{
    await update(5,1,2);
    const x=await account('参与群主甲'),y=await account('参与群主乙'),z=await account('参与群主丙'),learner=await account('参与者');
    const one=await create(x,'参与一'),two=await create(y,'参与二','request'),three=await create(z,'参与三');
    await join(learner,one.id);assert.equal((await join(learner,two.id) as {membership:string}).membership,'requested');
    await assert.rejects(join(learner,three.id),code('joined_group_limit'));
    await update(5,1,1);
    await assert.rejects(manage(y,two.id,learner,'approve'),code('joined_group_limit'));
    assert.equal((await groups.detail(learner,one.id)).membership,'active');
    assert.equal((await groups.detail(learner,two.id)).membership,'requested');
    await leave(learner,two.id);await assert.rejects(join(learner,three.id),code('joined_group_limit'));
    await leave(learner,one.id);await join(learner,two.id);await manage(y,two.id,learner,'approve');
    await assert.rejects(manage(z,three.id,learner,'invite'),code('joined_group_limit'));
    await leave(learner,two.id);await manage(z,three.id,learner,'invite');
    assert.equal((await groups.detail(learner,three.id)).membership,'invited');
    await join(learner,one.id);await assert.rejects(join(learner,three.id),code('joined_group_limit'));
    await leave(learner,one.id);await join(learner,three.id);
    assert.equal((await groups.detail(learner,three.id)).membership,'active');
  });

  await t.test('concurrent admissions serialize against the current member limit',async()=>{
    await update(2,1,2);
    const owner=await account('并发群主'),a=await account('并发申请甲'),b=await account('并发申请乙'),group=await create(owner,'只能再进一人');
    const admissions=await Promise.allSettled([join(a,group.id),join(b,group.id)]);
    assert.equal(admissions.filter(item=>item.status==='fulfilled').length,1);
    const rejected=admissions.find(item=>item.status==='rejected');assert.ok(rejected?.status==='rejected'&&code('group_full')(rejected.reason));
    assert.equal((await groups.detail(owner,group.id)).memberCount,2);
  });

  await t.test('a group list reads the shared limit once and every visible ratio reflects it',async()=>{
    let reads=0;
    const counted:Database={...db,async query<R>(query:string,values?:readonly unknown[]){if(query.includes('FROM group_limits'))reads++;return db.query<R>(query,values);}};
    const listed=await new GroupService(counted,access,files,clock).list(null,{view:'discover'});
    assert.ok(listed.items.length>1);assert.equal(reads,1);
    assert.ok(listed.items.every(item=>item.memberLimit===2));
  });

  await t.test('configuration updates are versioned and cannot commit without their audit',async()=>{
    const before=await settings.get(admin);
    await db.query(`CREATE FUNCTION phase6_reject_limit_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic group limit audit unavailable'; END $$`);
    await db.query('CREATE TRIGGER phase6_reject_limit BEFORE INSERT ON group_limit_changes FOR EACH ROW EXECUTE FUNCTION phase6_reject_limit_audit()');
    await assert.rejects(settings.update(admin,{expectedVersion:before.version,memberLimit:20,createdGroupLimit:2,joinedGroupLimit:5}),/synthetic group limit audit unavailable/);
    assert.deepEqual(await settings.get(admin),before);
    await db.query('DROP TRIGGER phase6_reject_limit ON group_limit_changes');
    const changes=await Promise.allSettled([20,30].map(memberLimit=>settings.update(admin,{expectedVersion:before.version,memberLimit,createdGroupLimit:2,joinedGroupLimit:5})));
    assert.equal(changes.filter(item=>item.status==='fulfilled').length,1);
    const rejected=changes.find(item=>item.status==='rejected');assert.ok(rejected?.status==='rejected'&&code('conflict')(rejected.reason));
    const after=await settings.get(admin);assert.equal(after.version,before.version+1);
    const recorded=(await db.query<{previous_limits:unknown;new_limits:unknown}>('SELECT previous_limits,new_limits FROM group_limit_changes ORDER BY sequence DESC LIMIT 1')).rows[0];
    assert.deepEqual(recorded.previous_limits,before);assert.deepEqual(recorded.new_limits,after);
  });

  await t.test('an administrator demoted while waiting for the account lock cannot change group limits',async()=>{
    const before=await settings.get(admin);let release!:()=>void,locked!:()=>void,waiting!:()=>void;
    const gate=new Promise<void>(resolve=>{release=resolve;}),ready=new Promise<void>(resolve=>{locked=resolve;}),atAccountLock=new Promise<void>(resolve=>{waiting=resolve;});
    const demotion=db.transaction(async sql=>{await sql.query("UPDATE accounts SET role='member' WHERE id=$1",[admin.accountId]);locked();await gate;});
    await ready;
    const changing=db.transaction(sql=>settings.update(admin,{expectedVersion:before.version,memberLimit:40,createdGroupLimit:2,joinedGroupLimit:5},{async query<R>(statement:string,values?:readonly unknown[]){if(statement==='SELECT id FROM accounts WHERE id=$1 FOR UPDATE')waiting();return sql.query<R>(statement,values);}}));
    try{await atAccountLock;release();await demotion;await assert.rejects(changing,forbidden);assert.deepEqual((await db.query('SELECT version,member_limit AS "memberLimit",created_group_limit AS "createdGroupLimit",joined_group_limit AS "joinedGroupLimit" FROM group_limits WHERE singleton')).rows[0],before);}
    finally{release();await Promise.allSettled([demotion,changing]);await db.query("UPDATE accounts SET role='administrator' WHERE id=$1",[admin.accountId]);}
  });
});
