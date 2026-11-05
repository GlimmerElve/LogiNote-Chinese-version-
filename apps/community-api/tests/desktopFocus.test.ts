import assert from 'node:assert/strict';
import test from 'node:test';
import {randomUUID} from 'node:crypto';
import {AttentionService,DEVICE_FOCUS_LEASE_MS} from '../src/attention.js';
import {ApiError} from '../src/errors.js';
import type {Actor} from '../src/types.js';
import {createTestDatabase} from './helpers.js';

test('private per-device focus leases preserve manual policy and quiet delivery across terminals',async t=>{
  const fixture=await createTestDatabase('desktop_focus'),db=fixture.db;let now=new Date('2026-10-25T02:00:00Z');const clock=()=>new Date(now),delivered:string[]=[];
  const service=new AttentionService(db,{clock,dispatcher:{configured:true,async deliver(event){delivered.push(event.eventId);return {receiptId:'synthetic-'+event.eventId};}}});
  const account=async():Promise<Actor>=>{const accountId=randomUUID();await db.query('INSERT INTO accounts(id,email,password_hash) VALUES($1,$2,$3)',[accountId,accountId+'@focus.test','synthetic-focus-fixture']);return {accountId,role:'member',mfaVerified:false};};
  const device=async(actor:Actor)=>{const value={id:randomUUID(),account_id:actor.accountId,target_key:randomUUID()};await db.query('INSERT INTO community_devices(id,account_id,target_key,label,token_hash,is_default) VALUES($1,$2,$3,$4,$5,false)',[value.id,value.account_id,value.target_key,'合成终端',randomUUID()]);return value;};
  try{
    const recipient=await account(),sender=await account(),other=await account(),a=await device(recipient),b=await device(recipient),c=await device(other);
    const event=(eventId:string)=>({eventId,recipientAccountId:recipient.accountId,kind:'ordinary',payload:{body:'synthetic quiet event'}});
    await service.updatePreferences(recipient,{ordinaryAlertsEnabled:true});
    await t.test('entering focus creates a bounded private lease without rewriting the account preference',async()=>{
      const started=await service.setDeviceFocus(a,true);assert.deepEqual(started,{enabled:true,expiresAt:new Date(now.getTime()+DEVICE_FOCUS_LEASE_MS).toISOString(),focus:true});assert.equal((await service.getPreferences(recipient)).focus,true);
      assert.equal((await db.query('SELECT focus FROM attention_preferences WHERE account_id=$1',[recipient.accountId])).rows[0].focus,false);
      assert.equal((await service.getPreferences(other)).focus,false);assert.equal((await db.query('SELECT count(*)::int AS n FROM community_device_focus')).rows[0].n,1);
    });
    await t.test('first preference reads and device renewals serialize without taking account/device locks in reverse order',async()=>{
      const fresh=await account(),terminal=await device(fresh);await Promise.all(Array.from({length:12},(_,index)=>index%2?service.getPreferences(fresh):service.setDeviceFocus(terminal,true)));assert.equal((await service.getPreferences(fresh)).focus,true);await service.setDeviceFocus(terminal,false);
    });
    await t.test('one terminal exiting cannot clear another terminal or a manually enabled focus preference',async()=>{
      await service.setDeviceFocus(b,true);await service.setDeviceFocus(a,false);assert.equal((await service.getPreferences(recipient)).focus,true);assert.equal((await db.query('SELECT count(*)::int AS n FROM community_device_focus')).rows[0].n,1);
      await service.setFocus(recipient,true);await service.setDeviceFocus(b,false);assert.equal((await service.getPreferences(recipient)).focus,true);
      await service.setDeviceFocus(a,true);assert.equal((await service.setFocus(recipient,false)).focus,true);await service.setDeviceFocus(a,false);assert.equal((await service.getPreferences(recipient)).focus,false);
    });
    await t.test('leases are renewed independently and expire without a cleanup worker or reconnecting the desktop',async()=>{
      await service.setDeviceFocus(a,true);now=new Date(now.getTime()+90_000);await service.setDeviceFocus(b,true);now=new Date(now.getTime()+31_000);assert.equal((await service.getPreferences(recipient)).focus,true);
      await service.setDeviceFocus(b,false);assert.equal((await service.getPreferences(recipient)).focus,false);assert.ok((await db.query<{expires_at:Date}>('SELECT expires_at FROM community_device_focus WHERE device_id=$1',[a.id])).rows[0].expires_at<=now);
      await service.setDeviceFocus(a,true);now=new Date(now.getTime()+121_000);assert.equal((await service.getPreferences(recipient)).focus,false);
    });
    await t.test('revocation immediately excludes a lease and forged device/account/library combinations are rejected',async()=>{
      await service.setDeviceFocus(a,true);await db.query('UPDATE community_devices SET revoked_at=$2 WHERE id=$1',[a.id,now]);assert.equal((await service.getPreferences(recipient)).focus,false);
      await assert.rejects(service.setDeviceFocus(a,true),error=>error instanceof ApiError&&error.code==='device_revoked');
      await assert.rejects(service.setDeviceFocus({...b,account_id:other.accountId},true),error=>error instanceof ApiError&&error.code==='device_revoked');
      await assert.rejects(service.setDeviceFocus({...b,target_key:c.target_key},true),error=>error instanceof ApiError&&error.code==='device_revoked');
      await service.setDeviceFocus(c,true);assert.equal((await service.getPreferences(recipient)).focus,false);assert.equal((await service.getPreferences(other)).focus,true);
    });
    await t.test('focus suppresses incoming and pending notifications permanently without replay when all leases finish',async()=>{
      await service.recordEvent(sender,event('waiting'));await service.setDeviceFocus(b,true);
      assert.equal((await service.recordEvent(sender,event('during-device-focus'))).reason,'focus');assert.equal((await service.dispatch(recipient.accountId,'waiting')).reason,'focus');await service.setDeviceFocus(b,false);
      assert.equal((await service.dispatch(recipient.accountId,'during-device-focus')).status,'suppressed');assert.equal((await service.dispatch(recipient.accountId,'waiting')).status,'suppressed');assert.deepEqual(delivered,[]);
      assert.equal((await service.recordEvent(sender,event('after-focus'))).status,'pending');assert.equal((await service.dispatch(recipient.accountId,'after-focus')).status,'delivered');assert.deepEqual(delivered,['after-focus']);
    });
  }finally{await fixture.cleanup();}
});
