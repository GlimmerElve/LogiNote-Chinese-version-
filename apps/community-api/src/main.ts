import {readConfig} from './config.js';
import {createDatabase} from './db.js';
import {applyMigrations} from './migrations.js';
import {createMailer} from './mailer.js';
import {createCommunityServer} from './http.js';
import {startMaintenance,startNewsCollection} from './worker.js';
async function main(){
  const config=readConfig(),db=createDatabase(config.databaseUrl);
  try{await applyMigrations(db);}catch{await db.close();throw Error('Community migrations failed. Inspect configuration and database availability.');}
  const {server,files,newsSources}=createCommunityServer({db,config,mailer:createMailer(config),log:entry=>process.stdout.write(`${JSON.stringify(entry)}\n`)});
  const logJob=(entry:Record<string,unknown>)=>process.stdout.write(`${JSON.stringify(entry)}\n`);
  const stopMaintenance=startMaintenance(db,files,logJob),stopNews=startNewsCollection(newsSources,logJob);
  const stopJobs=async()=>{await Promise.all([stopMaintenance(),stopNews()]);};
  server.listen(config.port,config.host,()=>process.stdout.write(`${JSON.stringify({event:'community_ready',port:(server.address() as {port:number}).port,authentication:config.authProvider,authenticationConfigured:config.authProvider==='cloudbase'?!!config.cloudbase:true})}\n`));
  let stopping=false;
  const stop=()=>{if(stopping)return;stopping=true;newsSources.stop();server.close(()=>void stopJobs().then(()=>db.close()).then(()=>process.exit(0)));setTimeout(()=>process.exit(1),10_000).unref();};
  server.on('error',()=>{process.stderr.write('community_listen_failed\n');void stopJobs().then(()=>db.close()).finally(()=>process.exit(1));});
  process.on('SIGINT',stop);process.on('SIGTERM',stop);
}
main().catch(()=>{process.stderr.write('community_start_failed: check local configuration and database availability\n');process.exitCode=1;});
