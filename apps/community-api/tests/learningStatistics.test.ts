import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createTestDatabase} from './helpers.js';
import {createCommunityServer} from '../src/http.js';
import type {MailMessage} from '../src/auth.js';
import type {AddressInfo} from 'node:net';
type Identity={id:string;cookie:string;csrf:string};
test('learning statistics are selected, consented, scoped and bound to one terminal',async t=>{
  const db=await createTestDatabase('learning_stats'),mail:MailMessage[]=[],origin='http://127.0.0.1:5174';let now=new Date('2026-10-25T04:00:00Z');
  const app=createCommunityServer({db:db.db,clock:()=>new Date(now),config:{databaseUrl:db.url,encryptionKey:db.encryptionKey,host:'127.0.0.1',port:0,webOrigin:origin,allowedOrigins:[origin],secureCookies:false,dataDirectory:'.ui-preview/statistics-api',globalStorageLimitBytes:0,authProvider:'local'},mailer:{configured:true,async send(value){mail.push(value);return 'sent';}}});
  await new Promise<void>(resolve=>app.server.listen(0,'127.0.0.1',resolve));const base=`http://127.0.0.1:${(app.server.address() as AddressInfo).port}/api/community/v1`;
  const req=async(route:string,who?:Identity,body?:unknown,method=body===undefined?'GET':'POST',token?:string)=>{const response=await fetch(base+route,{method,headers:{Origin:origin,Connection:'close','Idempotency-Key':randomUUID(),...(who?{Cookie:who.cookie,'X-CSRF-Token':who.csrf}:{}),...(token?{Authorization:'Bearer '+token}:{}),...(body===undefined?{}:{'Content-Type':'application/json'})},body:body===undefined?undefined:JSON.stringify(body)});return {status:response.status,...await response.json()};};
  const ok=async(...args:Parameters<typeof req>)=>{const r=await req(...args);assert.ok(r.status>=200&&r.status<300,JSON.stringify(r));return r.value;};
  const account=async(name:string):Promise<Identity>=>{const email=name+'@stats.example.test',created=await app.auth.register({email,password:'Learning statistics testing 2026!',displayName:name});await app.auth.verifyEmail({token:mail.at(-1)!.token});const login=await app.auth.login({email,password:'Learning statistics testing 2026!'});return {id:created.account.id,cookie:'loginote_community_session='+login.sessionToken,csrf:login.csrfToken};};
  const pair=async(who:Identity)=>{const p=await ok('/desktop/pairings',undefined,{targetKey:randomUUID(),label:'终端测试'});await ok('/me/devices/approve',who,{code:p.code});return await ok('/desktop/pairings/'+p.pairingId,undefined,{claimToken:p.claimToken});};
  const check=async(name:string,work:()=>Promise<void>)=>{now=new Date(now.getTime()+61000);await t.test(name,work);};
  try{
    const a=await account('甲'),b=await account('乙'),c=await account('丙'),da=await pair(a),other=await pair(a),dbb=await pair(b);let policy:any,group='';
    const read=()=>ok('/me/learning-statistics',a),publicRead=(who?:Identity)=>ok('/people/'+a.id,who);
    const settings=async(change:any={})=>{policy=(await ok('/me/learning-statistics',a,{...policy,...change},'PUT')).policy;};
    const snapshot=(values:any={streak:9,activeDaysThisMonth:18})=>({state:'ready',asOfDate:'2026-10-25',timeZone:'Asia/Shanghai',computedAt:now.toISOString(),calculationVersion:'loginote-learning-v1',values});
    const report=(device=da,raw:unknown=snapshot(),revision=policy.revision)=>req('/desktop/learning-statistics',undefined,{revision,snapshot:raw},'PUT',device.token);
    await check('off by default; profile and device session disclose no statistic or source details',async()=>{
      policy=(await read()).policy;assert.equal(policy.enabled,false);assert.equal((await publicRead()).learningStatistics,null);
      assert.equal((await ok('/desktop/session',undefined,undefined,'GET',da.token)).learningStatistics,null);
      assert.equal((await report()).status,400);assert.equal((await req('/me/learning-statistics')).status,401);
      assert.equal((await req('/me/learning-statistics',a,{...policy,streak:900},'PUT')).status,400);
    });
    await check('only an owned active terminal can be selected; values are never editable on web',async()=>{
      assert.equal((await req('/me/learning-statistics',a,{...policy,enabled:true,sourceDeviceId:dbb.deviceId},'PUT')).status,400);
      await settings({enabled:true,sourceDeviceId:da.deviceId});assert.equal((await report()).status,200);
      assert.equal((await report(other)).status,409);assert.equal((await report(dbb)).status,409);
      const exposed=(await publicRead()).learningStatistics;assert.deepEqual(exposed.values,{streak:9,activeDaysThisMonth:18});assert.equal(JSON.stringify(exposed).includes('sourceDeviceId'),false);
    });
    await check('whitelist rejects extra metrics, raw records, invalid states and times',async()=>{
      for(const raw of [snapshot({streak:9,activeDaysThisMonth:18,avgDailyMinutes:42}),{...snapshot(),timeline:[]},{...snapshot(),state:['ready']},{...snapshot(),computedAt:'2030-10-25T00:00:00Z'},snapshot({streak:-1,activeDaysThisMonth:18}),snapshot({streak:9,activeDaysThisMonth:32})])assert.equal((await report(da,raw)).status,400);
      assert.deepEqual((await publicRead()).learningStatistics.values,{streak:9,activeDaysThisMonth:18});
    });
    await check('unchanged reports are idempotent; older snapshots cannot replace newer ones',async()=>{
      const raw=snapshot();assert.equal((await report(da,raw)).status,200);const before=(await read()).snapshot.updatedAt;
      now=new Date(now.getTime()+1000);assert.equal((await report(da,raw)).status,200);assert.equal((await read()).snapshot.updatedAt,before);
      assert.equal((await report(da,{...raw,computedAt:new Date(now.getTime()-120000).toISOString()})).status,409);
    });
    await check('scope requires joined groups; outsiders and anonymous visitors cannot read group-only metrics',async()=>{
      group=(await ok('/groups',a,{name:'统计授权群',description:'测试',joinPolicy:'open'})).id;
      await ok('/groups/'+group+'/membership',b,{action:'join'});
      assert.equal((await req('/me/learning-statistics',a,{...policy,scope:'groups',groupIds:[randomUUID()]},'PUT')).status,403);
      await settings({scope:'groups',groupIds:[group]});assert.equal((await read()).snapshot,null);assert.equal((await report()).status,200);
      assert.ok((await publicRead(b)).learningStatistics);assert.equal((await publicRead(c)).learningStatistics,null);assert.equal((await publicRead()).learningStatistics,null);
      await ok('/groups/'+group+'/membership',b,{action:'leave'});assert.equal((await publicRead(b)).learningStatistics,null);
    });
    await check('changing fields invalidates old reports; revocation clears storage and prevents stale disclosure',async()=>{
      const old=policy.revision;await settings({scope:'public',groupIds:[],metrics:['streak']});assert.equal((await report(da,snapshot(),old)).status,409);assert.equal((await publicRead()).learningStatistics,null);
      assert.equal((await report(da,snapshot({streak:9}))).status,200);assert.deepEqual((await publicRead()).learningStatistics.values,{streak:9});
      await settings({enabled:false});assert.equal((await report(da,snapshot({streak:9}))).status,409);assert.equal((await publicRead()).learningStatistics,null);assert.equal((await read()).snapshot,null);
      assert.equal((await db.db.query('SELECT 1 FROM learning_statistics_snapshots WHERE account_id=$1',[a.id])).rowCount,0);
    });
    await check('restricted users can still withdraw disclosure without publishing permission',async()=>{
      await settings({enabled:true});assert.equal((await report(da,snapshot({streak:9}))).status,200);
      await db.db.query("UPDATE accounts SET role='administrator' WHERE id=$1",[c.id]);
      const admin={accountId:c.id,role:'administrator' as const,mfaVerified:true};
      const submitted=await app.governance.submit(admin,{targetType:'account',targetId:a.id,body:'合成权限测试'});
      await app.governance.assign(admin,submitted.id);
      await app.governance.decide(admin,submitted.id,{action:'restrict_account',reason:'合成测试限制',capabilities:['write'],expiresAt:new Date(now.getTime()+3600000).toISOString()});
      await settings({enabled:false});assert.equal((await publicRead()).learningStatistics,null);
      assert.equal((await req('/me/learning-statistics',a,{...policy,enabled:true},'PUT')).status,403);
      await app.governance.decide(admin,submitted.id,{action:'restore_account',reason:'合成测试完成'});
    });
    await check('missing/corrupt terminal data is never presented as zero; source revocation hides the last snapshot',async()=>{
      await settings({enabled:true});assert.equal((await report(da,{...snapshot({}),state:'unavailable'})).status,200);
      assert.equal((await read()).snapshot.state,'unavailable');assert.equal((await publicRead()).learningStatistics,null);
      assert.equal((await report(da,snapshot({streak:0}))).status,200);assert.deepEqual((await publicRead()).learningStatistics.values,{streak:0});
      await ok('/me/devices/'+da.deviceId,a,undefined,'DELETE');assert.equal((await publicRead()).learningStatistics,null);assert.equal((await read()).sourceConnected,false);assert.equal((await report(da,snapshot({streak:9}))).status,401);assert.equal((await read()).policy.enabled,false);const source=(await db.db.query<{target_key:string}>('SELECT target_key FROM community_devices WHERE id=$1',[da.deviceId])).rows[0];const fresh=await ok('/desktop/pairings',undefined,{targetKey:source.target_key,label:'重新连接'});await ok('/me/devices/approve',a,{code:fresh.code});const reconnected=await ok('/desktop/pairings/'+fresh.pairingId,undefined,{claimToken:fresh.claimToken});assert.equal(reconnected.deviceId,da.deviceId);assert.equal((await ok('/desktop/session',undefined,undefined,'GET',reconnected.token)).learningStatistics,null);assert.equal((await publicRead()).learningStatistics,null);
    });
  }finally{app.server.closeAllConnections();await new Promise<void>(resolve=>app.server.close(()=>resolve()));await db.cleanup();}
});
