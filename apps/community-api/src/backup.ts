import path from 'node:path';
import {spawn} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {mkdir,stat,writeFile} from 'node:fs/promises';
import {readConfig} from './config.js';
import {createDatabase} from './db.js';
import {requireValue} from './errors.js';
import {pgConnection,assertEmptyRestoreDatabase} from './pgConnection.js';
async function pg(name:string,args:string[],connection:ReturnType<typeof pgConnection>){
  const executable=process.env.COMMUNITY_PG_BIN?path.join(process.env.COMMUNITY_PG_BIN,`${name}${process.platform==='win32'?'.exe':''}`):name;
  const environment:NodeJS.ProcessEnv={...process.env,PGHOST:connection.host,PGPORT:connection.port,PGDATABASE:connection.database,PGUSER:connection.user,PGPASSWORD:connection.password,PGOPTIONS:connection.options,PGSSLMODE:connection.sslmode,PGCONNECT_TIMEOUT:'10'};
  for(const key of ['PGHOSTADDR','PGSERVICE','PGSERVICEFILE'])delete environment[key];
  const child=spawn(executable,args,{windowsHide:true,stdio:['ignore','ignore','pipe'],env:environment});
  // Credentials and SQL dumps must never reach application logs.
  child.stderr.resume();await new Promise<void>((resolve,reject)=>{child.once('error',()=>reject(Error('PostgreSQL tool unavailable.')));child.once('exit',code=>code===0?resolve():reject(Error('PostgreSQL backup/restore failed.')));});
}
async function main(){
  const [action,archiveArg,...extra]=process.argv.slice(2),config=readConfig(),source=pgConnection(config.databaseUrl);
  requireValue(extra.length===0,400,'usage','Too many arguments.');
  if(action==='backup'){
    requireValue(!archiveArg,400,'usage','Backup generates a unique destination automatically.');
    const directory=path.join(config.dataDirectory,'backups');await mkdir(directory,{recursive:true,mode:0o700});
    const archive=path.join(directory,`${new Date().toISOString().replaceAll(':','-')}-${randomUUID()}.dump`);
    await pg('pg_dump',['--format=custom','--no-owner','--no-privileges',`--file=${archive}`],source);
    await writeFile(`${archive}.json`,JSON.stringify({format:'postgresql-custom',createdAt:new Date().toISOString(),bytes:(await stat(archive)).size,attachments:'Back up the dedicated attachments directory separately while writes are paused.',encryptionKey:'Keep the encryption key in separate protected configuration; it is not in this archive.'},null,2),{flag:'wx',mode:0o600});
    process.stdout.write(`${JSON.stringify({status:'database_backup_complete',archive})}\n`);return;
  }
  requireValue(action==='restore'&&!!archiveArg,400,'usage','Usage: restore <custom-dump-file>');
  const raw=process.env.COMMUNITY_RESTORE_DATABASE_URL;requireValue(raw,400,'configuration','Set a separate empty COMMUNITY_RESTORE_DATABASE_URL.');
  const destination=pgConnection(raw);
  requireValue(destination.identity!==source.identity,400,'unsafe_destination','Restore cannot target the source database.');
  const archive=path.resolve(archiveArg);requireValue((await stat(archive)).isFile(),400,'invalid_archive','Archive not found.');
  const db=createDatabase(destination.url.href);
  try{
    await assertEmptyRestoreDatabase(db);
  }finally{await db.close();}
  await pg('pg_restore',['--single-transaction','--exit-on-error','--no-owner','--no-privileges',`--dbname=${destination.database}`,archive],destination);
  process.stdout.write(`${JSON.stringify({status:'database_restored',attachments:'Restore the matching private attachments snapshot and encryption key before starting the API.'})}\n`);
}
main().catch(()=>{process.stderr.write('Backup/restore failed. Check isolated destination, configuration, archive and PostgreSQL tools. No existing tables are deleted by this script.\n');process.exitCode=1;});
