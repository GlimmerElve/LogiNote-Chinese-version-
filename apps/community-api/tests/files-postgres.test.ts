import assert from 'node:assert/strict';
import test from 'node:test';
import {randomBytes,randomUUID} from 'node:crypto';
import {mkdir,mkdtemp,readFile,readdir,rm,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {AccessService} from '../src/access.js';
import {createDatabase} from '../src/db.js';
import {ApiError} from '../src/errors.js';
import {FileService} from '../src/files.js';
import {MAX_FILE_BYTES,QuotaService} from '../src/operations.js';
import {opaqueToken,tokenHash} from '../src/security.js';
import type {Actor} from '../src/types.js';
import {createTestDatabase} from './helpers.js';

const code=(expected:string)=>(error:unknown)=>error instanceof ApiError&&error.code===expected;
test('private files, quota transactions and expiring grants against PostgreSQL and isolated disk storage',async t=>{
  const fixture=await createTestDatabase('files'),db=fixture.db,peer=createDatabase(fixture.url);
  const base=fileURLToPath(new URL('../../../.ui-preview/community-phase2/',import.meta.url));await mkdir(base,{recursive:true});const directory=await mkdtemp(path.join(base,'files-test-'));
  const key=randomBytes(32).toString('base64url');let now=new Date('2026-10-23T00:00:00Z');const clock=()=>new Date(now),access=new AccessService(db,clock),quota=new QuotaService(db,{globalLimitBytes:100*1024*1024},clock),files=new FileService(db,access,quota,{directory,grantKey:key,uploadTtlMs:60_000,downloadTtlMs:10_000},clock);
  const account=async():Promise<Actor>=>{const accountId=randomUUID();await db.query('INSERT INTO accounts(id,email,password_hash) VALUES($1,$2,$3)',[accountId,`${accountId}@example.test`,'synthetic-domain-fixture']);return {accountId,role:'member',mfaVerified:false};};
  try{
    const owner=await account(),reader=await account(),outsider=await account(),body=Buffer.from('private synthetic file bytes'),self=await access.createObject(owner,{scope:'self'}),publicObject=await access.createObject(owner,{scope:'public'});
    const metadata={objectId:self.id,name:'学习笔记.txt',mime:'text/plain',bytes:body.length};
    let attachmentId='',uploadToken='';
    await t.test('concurrent intent retries return one attachment/token and one quota reservation; tokens are hash-only in storage',async()=>{
      const intents=await Promise.all(Array.from({length:10},()=>files.createIntent(owner,metadata,'same-intent')));assert.equal(new Set(intents.map(intent=>intent.attachmentId)).size,1);assert.equal(new Set(intents.map(intent=>intent.uploadToken)).size,1);attachmentId=intents[0].attachmentId;uploadToken=intents[0].uploadToken;
      assert.equal(intents[0].state,'pending');assert.equal((await db.query('SELECT * FROM storage_reservations')).rowCount,1);
      const row=(await db.query<{upload_token_hash:string}>('SELECT upload_token_hash FROM private_attachments WHERE id=$1',[attachmentId])).rows[0];assert.equal(row.upload_token_hash,tokenHash(uploadToken));assert.notEqual(row.upload_token_hash,uploadToken);assert.equal((await db.query('SELECT * FROM idempotency_results')).rowCount,0);
      await assert.rejects(files.createIntent(owner,{...metadata,name:'不同文件.txt'},'same-intent'),code('idempotency_conflict'));await assert.rejects(files.createIntent(reader,metadata,'not-owner'),code('forbidden'));
      await assert.rejects(files.createIntent(owner,{...metadata,name:'../vault.txt'},'path-name'),code('invalid_request'));await assert.rejects(files.createIntent(owner,{...metadata,name:'bad\r\nheader'},'header-name'),code('invalid_request'));await assert.rejects(files.createIntent(owner,{...metadata,bytes:MAX_FILE_BYTES+1},'over-size'),code('file_too_large'));
      await assert.rejects(db.transaction(async sql=>{await files.createIntent(owner,{...metadata,name:'回滚.txt'},'rolled-back-intent',sql);throw Error('synthetic intent rollback');}),/synthetic intent rollback/);assert.equal((await db.query('SELECT * FROM private_attachments WHERE intent_key=$1',['rolled-back-intent'])).rowCount,0);assert.equal((await db.query('SELECT * FROM storage_reservations')).rowCount,1);
    });
    await t.test('upload is private, bounded, authorized and idempotent for identical bytes, with one committed charge',async()=>{
      await assert.rejects(files.put(owner,'../../vault',uploadToken,body),code('invalid_request'));await assert.rejects(files.put(owner,attachmentId,opaqueToken(),body),code('invalid_upload_grant'));await assert.rejects(files.put(outsider,attachmentId,uploadToken,body),code('not_found'));
      await assert.rejects(files.put(owner,attachmentId,uploadToken,Buffer.alloc(MAX_FILE_BYTES+1)),code('file_too_large'));await assert.rejects(files.put(owner,attachmentId,uploadToken,Buffer.from('wrong length')),code('upload_conflict'));
      const outcomes=await Promise.all(Array.from({length:8},()=>files.put(owner,attachmentId,uploadToken,body)));assert.ok(outcomes.every(result=>result.state==='ready'&&result.attachmentId===attachmentId));assert.equal(new Set(outcomes.map(result=>result.contentHash)).size,1);
      assert.deepEqual(await readdir(directory),[attachmentId]);assert.equal((await db.query<{state:string}>('SELECT state FROM storage_reservations')).rows[0].state,'committed');
      await assert.rejects(files.put(owner,attachmentId,uploadToken,Buffer.alloc(body.length,0x42)),code('upload_conflict'));await assert.rejects(files.cancel(owner,attachmentId),code('upload_complete'));
      const pending=await files.createIntent(owner,{...metadata,name:'第二个文件.txt'},'second-intent');await assert.rejects(files.put(owner,pending.attachmentId,uploadToken,body),code('invalid_upload_grant'));await files.cancel(owner,pending.attachmentId);
    });
    await t.test('download grants are hashed, account/file bound, short-lived, and private to authorized readers',async()=>{
      await assert.rejects(files.createDownload(reader,attachmentId),code('forbidden'));const grant=await files.createDownload(owner,attachmentId),result=await files.download(owner,attachmentId,grant.token);assert.deepEqual(result.buffer,body);assert.equal(result.name,metadata.name);assert.equal(result.mime,'text/plain');
      const saved=(await db.query<{token_hash:string}>('SELECT token_hash FROM attachment_download_grants WHERE attachment_id=$1',[attachmentId])).rows[0];assert.equal(saved.token_hash,tokenHash(grant.token));assert.notEqual(saved.token_hash,grant.token);
      await assert.rejects(files.download(reader,attachmentId,grant.token),code('invalid_download_grant'));await assert.rejects(files.download(owner,randomUUID(),grant.token),code('invalid_download_grant'));await assert.rejects(files.download(owner,attachmentId,opaqueToken()),code('invalid_download_grant'));
      now=new Date(now.getTime()+10_001);await assert.rejects(files.download(owner,attachmentId,grant.token),code('invalid_download_grant'));
    });
    await t.test('a fully written pending upload can recover after interruption, while conflicting retry bytes remain rejected',async()=>{
      const intent=await files.createIntent(owner,{...metadata,name:'中断恢复.txt'},'interrupted-upload'),persisted=Buffer.alloc(body.length,0x43);await writeFile(path.join(directory,intent.attachmentId),persisted);
      await assert.rejects(files.put(owner,intent.attachmentId,intent.uploadToken,body),code('upload_conflict'));assert.equal((await files.put(owner,intent.attachmentId,intent.uploadToken,persisted)).state,'ready');const grant=await files.createDownload(owner,intent.attachmentId);assert.deepEqual((await files.download(owner,intent.attachmentId,grant.token)).buffer,persisted);
    });
    await t.test('membership and object visibility are rechecked after issuing a download grant',async()=>{
      const groupId=randomUUID();await db.query('INSERT INTO groups(id,owner_id) VALUES($1,$2)',[groupId,owner.accountId]);for(const actor of [owner,reader])await db.query("INSERT INTO group_memberships(group_id,account_id,role) VALUES($1,$2,$3)",[groupId,actor.accountId,actor.accountId===owner.accountId?'owner':'member']);
      const groupObject=await access.createObject(owner,{scope:'group',groupId}),intent=await files.createIntent(owner,{...metadata,objectId:groupObject.id,name:'群内.txt'},'group-intent');await files.put(owner,intent.attachmentId,intent.uploadToken,body);const grant=await files.createDownload(reader,intent.attachmentId);assert.deepEqual((await files.download(reader,intent.attachmentId,grant.token)).buffer,body);
      await db.query("UPDATE group_memberships SET state='left' WHERE group_id=$1 AND account_id=$2",[groupId,reader.accountId]);await assert.rejects(files.download(reader,intent.attachmentId,grant.token),code('forbidden'));await assert.rejects(files.createDownload(outsider,intent.attachmentId),code('forbidden'));
      const publicIntent=await files.createIntent(owner,{...metadata,objectId:publicObject.id,name:'公开.txt'},'public-intent');await files.put(owner,publicIntent.attachmentId,publicIntent.uploadToken,body);const beforeWithdraw=await files.createDownload(reader,publicIntent.attachmentId);await db.query("UPDATE protected_objects SET state='withdrawn' WHERE id=$1",[publicObject.id]);await assert.rejects(files.download(reader,publicIntent.attachmentId,beforeWithdraw.token),code('forbidden'));
    });
    await t.test('database failure after disk write cleans new bytes; cancelling pending or expired intents releases reservations',async()=>{
      const intent=await files.createIntent(owner,{...metadata,name:'上传失败.txt'},'failed-upload'),reservation=(await db.query<{reservation_id:string}>('SELECT reservation_id FROM private_attachments WHERE id=$1',[intent.attachmentId])).rows[0];await quota.release(owner,reservation.reservation_id);
      await assert.rejects(files.put(owner,intent.attachmentId,intent.uploadToken,body),code('reservation_released'));assert.equal((await readdir(directory)).includes(intent.attachmentId),false);assert.equal((await db.query<{state:string}>('SELECT state FROM private_attachments WHERE id=$1',[intent.attachmentId])).rows[0].state,'pending');assert.equal((await files.cancel(owner,intent.attachmentId)).state,'cancelled');
      const expiring=await files.createIntent(owner,{...metadata,name:'过期.txt'},'expired-upload');now=new Date(now.getTime()+60_001);await assert.rejects(files.put(owner,expiring.attachmentId,expiring.uploadToken,body),code('invalid_upload_grant'));await assert.rejects(files.createIntent(owner,{...metadata,name:'过期.txt'},'expired-upload'),code('upload_expired'));await files.cancel(owner,expiring.attachmentId);
      const released=(await db.query<{state:string}>(`SELECT r.state FROM storage_reservations r JOIN private_attachments a ON a.reservation_id=r.id WHERE a.id=$1`,[expiring.attachmentId])).rows[0];assert.equal(released.state,'released');
      const disabled=new FileService(db,access,new QuotaService(db,{globalLimitBytes:0},clock),{directory,grantKey:key},clock);await assert.rejects(disabled.createIntent(owner,{...metadata,name:'禁用.txt'},'disabled-intent'),code('not_configured'));assert.equal((await db.query('SELECT * FROM private_attachments WHERE intent_key=$1',['disabled-intent'])).rowCount,0);
    });
    await t.test('maintenance removes expired crash-orphan bytes and releases their reservation without touching ready files',async()=>{
      const orphan=await files.createIntent(owner,{...metadata,name:'崩溃遗留.txt'},'crash-orphan');await writeFile(path.join(directory,orphan.attachmentId),body);now=new Date(now.getTime()+16*60_000);
      const concurrent=await Promise.all([files.cleanupExpired(),files.cleanupExpired()]);assert.equal(concurrent.reduce((sum,result)=>sum+result.cleaned,0),1);const names=await readdir(directory);assert.equal(names.includes(orphan.attachmentId),false);assert.equal(names.includes(attachmentId),true);
      const row=(await db.query<{attachment_state:string;reservation_state:string}>(`SELECT a.state AS attachment_state,r.state AS reservation_state FROM private_attachments a JOIN storage_reservations r ON r.id=a.reservation_id WHERE a.id=$1`,[orphan.attachmentId])).rows[0];assert.deepEqual(row,{attachment_state:'cancelled',reservation_state:'released'});assert.equal((await files.cleanupExpired()).cleaned,0);
    });
    await t.test('service restart keeps file bytes/grants stable and detects corruption before returning content',async()=>{
      const restarted=new FileService(peer,new AccessService(peer,clock),new QuotaService(peer,{globalLimitBytes:100*1024*1024},clock),{directory,grantKey:key},clock),restored=await restarted.createIntent(owner,metadata,'same-intent');assert.equal(restored.attachmentId,attachmentId);assert.equal(restored.uploadToken,uploadToken);assert.equal(restored.state,'ready');
      const grant=await restarted.createDownload(owner,attachmentId);assert.deepEqual((await restarted.download(owner,attachmentId,grant.token)).buffer,body);await writeFile(path.join(directory,attachmentId),Buffer.alloc(body.length,0x21));await assert.rejects(restarted.download(owner,attachmentId,grant.token),code('storage_unavailable'));await writeFile(path.join(directory,attachmentId),body);assert.deepEqual((await restarted.download(owner,attachmentId,grant.token)).buffer,body);
      assert.ok((await readdir(directory)).every(name=>/^[0-9a-f-]{36}$/.test(name)));
    });
    await t.test('draft discard rolls back without losing bytes, and committed cancellation reclaims storage through retryable maintenance',async()=>{
      const draft=await access.createObject(owner,{scope:'self'});await db.query('INSERT INTO resource_upload_stages(object_id,owner_id) VALUES($1,$2)',[draft.id,owner.accountId]);
      const intent=await files.createIntent(owner,{...metadata,objectId:draft.id,name:'移除回滚.txt'},'discard-rollback');await files.put(owner,intent.attachmentId,intent.uploadToken,body);
      await db.query("INSERT INTO resource_stage_files(stage_id,attachment_id,role) VALUES($1,$2,'attachment')",[draft.id,intent.attachmentId]);
      const grant=await files.createDownload(owner,intent.attachmentId),saved=async()=>(await db.query<{state:string;quota:string;removed:boolean;reservation_id:string}>(`SELECT a.state,r.state AS quota,f.removed,a.reservation_id FROM private_attachments a JOIN storage_reservations r ON r.id=a.reservation_id JOIN resource_stage_files f ON f.attachment_id=a.id WHERE a.id=$1`,[intent.attachmentId])).rows[0];
      await assert.rejects(db.transaction(async sql=>{
        await files.discardDraft(owner,intent.attachmentId,draft.id,sql);await sql.query('UPDATE resource_stage_files SET removed=true WHERE attachment_id=$1',[intent.attachmentId]);await sql.query('SELECT 1/0');
      }),/division by zero/);
      assert.deepEqual({...await saved(),reservation_id:undefined},{state:'ready',quota:'committed',removed:false,reservation_id:undefined});assert.deepEqual(await readFile(path.join(directory,intent.attachmentId)),body);assert.deepEqual((await files.download(owner,intent.attachmentId,grant.token)).buffer,body);
      await db.transaction(async sql=>{await files.discardDraft(owner,intent.attachmentId,draft.id,sql);await sql.query('UPDATE resource_stage_files SET removed=true WHERE attachment_id=$1',[intent.attachmentId]);});
      const cancelled=await saved();assert.deepEqual({...cancelled,reservation_id:undefined},{state:'cancelled',quota:'committed',removed:true,reservation_id:undefined});assert.deepEqual(await readFile(path.join(directory,intent.attachmentId)),body);await assert.rejects(files.createDownload(owner,intent.attachmentId),code('not_found'));await assert.rejects(files.download(owner,intent.attachmentId,grant.token),code('invalid_download_grant'));
      await db.query(`CREATE FUNCTION reject_discard_release() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.id='${cancelled.reservation_id}'::uuid AND NEW.state='released' THEN RAISE EXCEPTION 'synthetic cleanup failure'; END IF; RETURN NEW; END $$`);
      await db.query('CREATE TRIGGER reject_discard_release BEFORE UPDATE ON storage_reservations FOR EACH ROW EXECUTE FUNCTION reject_discard_release()');
      await assert.rejects(files.cleanupExpired(1),/synthetic cleanup failure/);await assert.rejects(readFile(path.join(directory,intent.attachmentId)),{code:'ENOENT'});assert.equal((await saved()).state,'cancelled');assert.equal((await saved()).quota,'committed');
      await db.query('DROP TRIGGER reject_discard_release ON storage_reservations');await db.query('DROP FUNCTION reject_discard_release()');
      assert.equal((await files.cleanupExpired(1)).cleaned,1);assert.equal((await saved()).quota,'released');assert.equal((await files.cleanupExpired(1)).cleaned,0);assert.deepEqual(await readFile(path.join(directory,attachmentId)),body);
    });
  }finally{
    await peer.close();await fixture.cleanup();
    assert.equal(path.dirname(path.resolve(directory)),path.resolve(base));assert.ok(path.basename(directory).startsWith('files-test-'));await rm(directory,{recursive:true,force:true});
  }
});
