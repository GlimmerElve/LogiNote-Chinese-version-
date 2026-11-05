import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {spawn} from 'node:child_process';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {mkdir,rm} from 'node:fs/promises';
import {createTestDatabase} from './helpers.js';
import {createDatabase} from '../src/db.js';
import {applyMigrations} from '../src/migrations.js';
test('backup and restore CLI operate on isolated databases and refuse a nonempty destination',async t=>{
  const fixture=await createTestDatabase('backup_cli');t.after(()=>fixture.cleanup());
  const base=new URL(fixture.url);assert.ok(base.pathname==='/community_phase2'||process.env.COMMUNITY_TEST_ALLOW_RECOVERY==='true');base.search='';
  const sourceName=`community_backup_${randomUUID().replaceAll('-','')}`,targetName=`community_restore_${randomUUID().replaceAll('-','')}`,control=createDatabase(base.href);
  const sourceUrl=new URL(base),targetUrl=new URL(base);sourceUrl.pathname=`/${sourceName}`;targetUrl.pathname=`/${targetName}`;
  const directory=fileURLToPath(new URL(`.ui-preview/community-phase2/backup-cli/${randomUUID()}/`,fixture.root));await mkdir(directory,{recursive:true});
  let source:ReturnType<typeof createDatabase>|undefined,target:ReturnType<typeof createDatabase>|undefined,sourceCreated=false,targetCreated=false;
  const env={...process.env,COMMUNITY_DATABASE_URL:sourceUrl.href,COMMUNITY_RESTORE_DATABASE_URL:targetUrl.href,COMMUNITY_ENCRYPTION_KEY:fixture.encryptionKey,COMMUNITY_DATA_DIRECTORY:directory,COMMUNITY_WEB_ORIGIN:'http://127.0.0.1:5174',COMMUNITY_PG_BIN:process.env.COMMUNITY_PG_BIN||'D:/postgreSQL/bin'};
  const app=fileURLToPath(new URL('apps/community-api/',fixture.root)),shim=fileURLToPath(new URL('scripts/node-os-userinfo-fallback.cjs',fixture.root));
  async function cli(args:string[]){const child=spawn(process.execPath,['--require',shim,'--import','tsx','src/backup.ts',...args],{cwd:app,env,windowsHide:true,stdio:['ignore','pipe','pipe']});let output='';child.stdout.on('data',chunk=>{output+=chunk;});child.stderr.resume();const status=await new Promise<number|null>((resolve,reject)=>{child.once('error',reject);child.once('exit',resolve);});return {status,output};}
  try{
    await control.query(`CREATE DATABASE "${sourceName}"`);sourceCreated=true;await control.query(`CREATE DATABASE "${targetName}"`);targetCreated=true;
    source=createDatabase(sourceUrl.href);target=createDatabase(targetUrl.href);await applyMigrations(source);
    await source.query('INSERT INTO accounts(id,email,password_hash,email_verified_at) VALUES($1,$2,$3,now())',[randomUUID(),'backup@example.test','synthetic-not-a-login']);
    const backup=await cli(['backup']);assert.equal(backup.status,0,'backup CLI');const result=JSON.parse(backup.output.trim()) as {status:string;archive:string};assert.equal(result.status,'database_backup_complete');assert.ok(result.archive.startsWith(directory));
    const restored=await cli(['restore',result.archive]);assert.equal(restored.status,0,'restore CLI');assert.equal((await target.query<{n:string}>('SELECT count(*)::text AS n FROM accounts')).rows[0].n,'1');assert.deepEqual(await applyMigrations(target),[]);
    assert.equal((await cli(['restore',result.archive])).status,1,'nonempty destination must be refused');assert.equal((await target.query<{n:string}>('SELECT count(*)::text AS n FROM accounts')).rows[0].n,'1');
  }finally{
    await source?.close();await target?.close();if(targetCreated)await control.query(`DROP DATABASE "${targetName}"`);if(sourceCreated)await control.query(`DROP DATABASE "${sourceName}"`);await control.close();
    const allowed=fileURLToPath(new URL('.ui-preview/community-phase2/backup-cli/',fixture.root));assert.ok(path.resolve(directory).startsWith(`${path.resolve(allowed)}${path.sep}`));await rm(directory,{recursive:true,force:true});
  }
});
