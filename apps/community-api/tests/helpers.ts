import { randomBytes, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createDatabase } from '../src/db.js';
import { applyMigrations } from '../src/migrations.js';
export async function createTestDatabase(prefix='community_test'){
  if(!/^[a-z][a-z0-9_]{0,30}$/.test(prefix))throw Error('Invalid test schema prefix');
  const root=existsSync(new URL('../package.json',import.meta.url))?new URL('../../../',import.meta.url):new URL('../../../../',import.meta.url);
  const runtime=process.env.COMMUNITY_TEST_DATABASE_URL?{databaseUrl:process.env.COMMUNITY_TEST_DATABASE_URL,encryptionKey:process.env.COMMUNITY_TEST_ENCRYPTION_KEY}:JSON.parse(await readFile(new URL('.ui-preview/community-phase2/runtime.json',root),'utf8')) as {databaseUrl:string;encryptionKey:string};
  const schema=`${prefix}_${randomUUID().replaceAll('-','')}`,admin=createDatabase(runtime.databaseUrl);
  await admin.query(`CREATE SCHEMA "${schema}"`);
  const url=new URL(runtime.databaseUrl);url.searchParams.set('options',`-csearch_path=${schema}`);
  const db=createDatabase(url.href);
  try{await applyMigrations(db);}catch(error){await db.close();await admin.query(`DROP SCHEMA "${schema}" CASCADE`);await admin.close();throw error;}
  return {db,schema,url:url.href,encryptionKey:runtime.encryptionKey||randomBytes(32).toString('base64url'),root,async cleanup(){await db.close();await admin.query(`DROP SCHEMA "${schema}" CASCADE`);await admin.close();}};
}
