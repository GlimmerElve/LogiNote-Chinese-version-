import assert from 'node:assert/strict';
import test from 'node:test';
import {randomUUID} from 'node:crypto';
import {AttentionService,type DispatchEvent} from '../src/attention.js';
import {ApiError} from '../src/errors.js';
import type {Actor} from '../src/types.js';
import {createTestDatabase} from './helpers.js';

const code=(expected:string)=>(error:unknown)=>error instanceof ApiError&&error.code===expected;
test('recipient-owned attention policy and durable event decisions against PostgreSQL',async t=>{
  const fixture=await createTestDatabase('attention'),db=fixture.db;let now=new Date('2026-10-23T00:00:00Z');const clock=()=>new Date(now),delivered:DispatchEvent[]=[];
  const account=async(role:Actor['role']='member'):Promise<Actor>=>{const accountId=randomUUID();await db.query('INSERT INTO accounts(id,email,password_hash,role) VALUES($1,$2,$3,$4)',[accountId,`${accountId}@example.test`,'synthetic-domain-fixture',role]);return {accountId,role,mfaVerified:role==='administrator'};};
  const offline=new AttentionService(db,{clock}),live=new AttentionService(db,{clock,dispatcher:{configured:true,async deliver(event){delivered.push(event);return {receiptId:`provider-${event.eventId}`};}}});
  try{
    const sender=await account(),recipient=await account(),admin=await account('administrator');
    const event=(eventId:string,payload:unknown={body:'synthetic event'})=>({eventId,recipientAccountId:recipient.accountId,kind:'ordinary' as const,payload});
    await t.test('new account defaults are quiet; only actor preferences change and badge/replay flags stay false',async()=>{
      assert.deepEqual(await offline.getPreferences(recipient),{accountId:recipient.accountId,ordinaryAlertsEnabled:false,systemPushEnabled:false,soundEnabled:false,vibrationEnabled:false,showUnreadBadges:false,replayAfterFocus:false,focus:false,quietHours:null});
      await assert.rejects(offline.updatePreferences(sender,{accountId:recipient.accountId,ordinaryAlertsEnabled:true}),code('invalid_request'));
      await offline.updatePreferences(sender,{ordinaryAlertsEnabled:true,soundEnabled:true});assert.equal((await offline.getPreferences(recipient)).ordinaryAlertsEnabled,false);
      await assert.rejects(offline.updatePreferences(recipient,{showUnreadBadges:true}),code('invalid_request'));await assert.rejects(offline.updatePreferences(recipient,{replayAfterFocus:true}),code('invalid_request'));
      await assert.rejects(offline.updatePreferences(recipient,{quietHours:{start:'25:00',end:'07:00',timeZone:'Asia/Shanghai'}}),code('invalid_request'));
      await assert.rejects(offline.updatePreferences(recipient,{quietHours:{start:'22:00',end:'07:00',timeZone:'invalid/time-zone'}}),code('invalid_request'));
      await assert.rejects(offline.recordEvent(sender,{...event('forged-overrides'),ordinaryAlertsEnabled:true}),code('invalid_request'));
    });
    await t.test('event IDs deduplicate concurrently; sender cannot read recipient records or turn events into delivery',async()=>{
      const outcomes=await Promise.all(Array.from({length:16},()=>offline.recordEvent(sender,event('event-once'))));assert.ok(outcomes.every(result=>result.status==='suppressed'&&result.reason==='disabled'));
      assert.equal((await db.query('SELECT * FROM attention_events WHERE event_id=$1',['event-once'])).rowCount,1);assert.equal((await db.query('SELECT * FROM attention_deliveries')).rowCount,1);
      await assert.rejects(offline.recordEvent(sender,event('event-once',{body:'changed'})),code('idempotency_conflict'));await assert.rejects(offline.getEvent(sender,'event-once'),code('not_found'));
      await offline.updatePreferences(recipient,{ordinaryAlertsEnabled:true});assert.equal((await live.dispatch(recipient.accountId,'event-once')).status,'suppressed');assert.equal(delivered.length,0);
      assert.equal((await offline.recordEvent(sender,event('no-dispatcher'))).status,'not_configured');assert.equal((await live.dispatch(recipient.accountId,'no-dispatcher')).status,'not_configured');assert.equal(delivered.length,0);
    });
    await t.test('separate pending and delivered records need a provider receipt; concurrent dispatch calls deliver once',async()=>{
      const pending=await live.recordEvent(sender,event('deliver-once'));assert.equal(pending.status,'pending');assert.equal(pending.deliveredAt,null);assert.equal(delivered.length,0);
      const outcomes=await Promise.all(Array.from({length:12},()=>live.dispatch(recipient.accountId,'deliver-once')));assert.ok(outcomes.every(outcome=>outcome.status==='delivered'));assert.equal(delivered.length,1);assert.equal(delivered[0].idempotencyKey,`${recipient.accountId}:deliver-once`);assert.equal(delivered[0].soundEnabled,false);assert.equal(delivered[0].vibrationEnabled,false);assert.equal(delivered[0].showUnreadBadges,false);
      const persisted=await new AttentionService(db,{clock}).getEvent(recipient,'deliver-once');assert.equal(persisted.status,'delivered');assert.ok(persisted.providerReceiptId);assert.ok(persisted.deliveredAt);
    });
    await t.test('focus suppresses new and waiting events permanently without replay after focus ends',async()=>{
      const count=delivered.length;await live.recordEvent(sender,event('waiting-before-focus'));await live.setFocus(recipient,true);
      assert.equal((await live.recordEvent(sender,event('during-focus'))).reason,'focus');assert.equal((await live.dispatch(recipient.accountId,'waiting-before-focus')).reason,'focus');
      await live.setFocus(recipient,false);assert.equal((await live.dispatch(recipient.accountId,'during-focus')).status,'suppressed');assert.equal((await live.dispatch(recipient.accountId,'waiting-before-focus')).status,'suppressed');assert.equal(delivered.length,count);
    });
    await t.test('IANA quiet hours span midnight and suppressed events never catch up at the boundary',async()=>{
      const count=delivered.length;await live.updatePreferences(recipient,{quietHours:{start:'22:00',end:'07:00',timeZone:'Asia/Shanghai'}});now=new Date('2026-10-23T15:00:00Z');
      assert.equal((await live.recordEvent(sender,event('night-event'))).reason,'quiet_hours');now=new Date('2026-10-23T23:00:00Z');assert.equal((await live.dispatch(recipient.accountId,'night-event')).status,'suppressed');assert.equal(delivered.length,count);
      assert.equal((await live.recordEvent(sender,event('morning-event'))).status,'pending');assert.equal((await live.dispatch(recipient.accountId,'morning-event')).status,'delivered');assert.equal(delivered.length,count+1);
      await live.updatePreferences(recipient,{quietHours:null});
    });
    await t.test('system events require verified administration and recipient opt-in; dispatcher failure is not pushed',async()=>{
      await assert.rejects(live.recordEvent(sender,{...event('forged-system'),kind:'system'}),code('forbidden'));await assert.rejects(live.recordEvent({...admin,mfaVerified:false},{...event('unverified-system'),kind:'system'}),code('forbidden'));
      assert.equal((await live.recordEvent(admin,{...event('system-disabled'),kind:'system'})).reason,'disabled');await live.updatePreferences(recipient,{systemPushEnabled:true,soundEnabled:true,vibrationEnabled:true});
      assert.equal((await live.recordEvent(admin,{...event('system-enabled'),kind:'system'})).status,'pending');await live.dispatch(recipient.accountId,'system-enabled');assert.equal(delivered.at(-1)?.soundEnabled,true);assert.equal(delivered.at(-1)?.vibrationEnabled,true);
      const failing=new AttentionService(db,{clock,dispatcher:{configured:true,async deliver(){throw Error('synthetic provider unavailable');}}});await failing.recordEvent(sender,event('provider-failure'));const failed=await failing.dispatch(recipient.accountId,'provider-failure');assert.equal(failed.status,'failed');assert.equal(failed.deliveredAt,null);assert.equal(failed.providerReceiptId,null);assert.equal(failed.reason,'dispatch_failed');
    });
  }finally{await fixture.cleanup();}
});
