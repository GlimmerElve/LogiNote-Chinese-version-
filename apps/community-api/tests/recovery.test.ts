import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import {mkdir,stat} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {createTestDatabase} from './helpers.js';
import {createDatabase} from '../src/db.js';
import {AccessService} from '../src/access.js';
import {GovernanceService} from '../src/governance.js';
import {applyMigrations} from '../src/migrations.js';

test('real PostgreSQL custom dump restores an isolated database with decisions, permissions and sequences',async t=>{
  const fixture=await createTestDatabase('recovery');t.after(()=>fixture.cleanup());
  const {db,schema,url,root}=fixture,source=new URL(url);
  // Only the explicitly isolated test database may be backed up/restored here.
  assert.ok(source.pathname==='/community_phase2'||process.env.COMMUNITY_TEST_ALLOW_RECOVERY==='true','Recovery test requires the isolated test database');
  const accountId=randomUUID(),reporterId=randomUUID(),adminId=randomUUID(),passwordHash='synthetic-fixture-no-login';
  for(const [id,name,role] of [[accountId,'owner','member'],[reporterId,'reporter','member'],[adminId,'admin','administrator']] as const)await db.query('INSERT INTO accounts(id,email,password_hash,role,email_verified_at) VALUES($1,$2,$3,$4,now())',[id,`${name}@example.test`,passwordHash,role]);
  const actor={accountId,role:'member' as const,mfaVerified:false},admin={accountId:adminId,role:'administrator' as const,mfaVerified:true},reporter={...actor,accountId:reporterId};
  const access=new AccessService(db),governance=new GovernanceService(db,access),item=await access.createObject(actor,{scope:'public'});
  const report=await governance.submit(reporter,{targetType:'object',targetId:item.id,body:'synthetic recovery report'});
  await governance.assign(admin,report.id);
  await governance.decide(admin,report.id,{action:'restrict_object',reason:'synthetic recovery decision',expiresAt:new Date(Date.now()+3_600_000).toISOString()});
  const directory=fileURLToPath(new URL('.ui-preview/community-phase2/recovery/',root));await mkdir(directory,{recursive:true});
  const archive=path.join(directory,`${schema}.dump`),destination=`community_restore_${randomUUID().replaceAll('-','')}`;
  const bin=process.env.COMMUNITY_PG_BIN||'D:/postgreSQL/bin';
  const env={...process.env,PGHOST:source.hostname,PGPORT:source.port||'5432',PGDATABASE:decodeURIComponent(source.pathname.slice(1)),PGUSER:decodeURIComponent(source.username),PGPASSWORD:decodeURIComponent(source.password),PGOPTIONS:''};
  function command(name:string,args:string[],database=env.PGDATABASE){
    const result=spawnSync(path.join(bin,`${name}${process.platform==='win32'?'.exe':''}`),args,{env:{...env,PGDATABASE:database},encoding:'utf8',windowsHide:true,timeout:60_000});
    // Never print CLI stderr or connection arguments: a failed tool may include credentials.
    assert.equal(result.status,0,`${name} failed (${result.error?.name||'inspect isolated PG availability'})`);
  }
  command('pg_dump',['--format=custom',`--schema=${schema}`,`--file=${archive}`]);assert.ok((await stat(archive)).size>0);
  const connection=createDatabase(source.href);let restored:ReturnType<typeof createDatabase>|undefined,created=false;
  try{
    await connection.query(`CREATE DATABASE "${destination}"`);created=true;
    command('pg_restore',['--no-owner','--no-privileges','--exit-on-error',`--dbname=${destination}`,archive],destination);
    const target=new URL(source);target.pathname=`/${destination}`;target.searchParams.set('options',`-csearch_path=${schema}`);restored=createDatabase(target.href);
    assert.deepEqual(await applyMigrations(restored),[]);
    for(const table of ['accounts','reports','governance_decisions','audit_events','protected_objects']){
      const beforeCount=await db.query<{n:string}>(`SELECT count(*)::text AS n FROM ${table}`);
      const afterCount:{rows:{n:string}[]}=await restored.query<{n:string}>(`SELECT count(*)::text AS n FROM ${table}`);assert.equal(afterCount.rows[0].n,beforeCount.rows[0].n,table);
    }
    const recoveredAccess=new AccessService(restored),recoveredGovernance=new GovernanceService(restored,recoveredAccess);
    await assert.rejects(recoveredAccess.readObject(reporter,item.id),{code:'forbidden'});
    const appeal=await recoveredGovernance.appeal(actor,report.id,{body:'synthetic appeal after restore'});
    await recoveredGovernance.reviewAppeal(admin,appeal.id,{outcome:'restore',reason:'synthetic restored decision'});
    assert.equal((await recoveredAccess.readObject(null,item.id)).state,'visible');
    assert.equal((await recoveredGovernance.listAudit(admin,report.id)).length,5);
  }finally{await restored?.close();if(created)await connection.query(`DROP DATABASE "${destination}"`);await connection.close();}
});
