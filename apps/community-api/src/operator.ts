import {randomUUID} from 'node:crypto';
import {readConfig} from './config.js';
import {createDatabase} from './db.js';
import {requireValue} from './errors.js';
// Local operator CLI; there is deliberately no public bootstrap/admin endpoint.
async function main(){
  const [action,flag,accountId,...extra]=process.argv.slice(2);
  requireValue(['grant-admin','revoke-admin'].includes(action)&&flag==='--account-id'&&typeof accountId==='string'&&/^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i.test(accountId)&&!extra.length,400,'usage','Usage: operator grant-admin|revoke-admin --account-id COMMUNITY_ACCOUNT_UUID');
  const db=createDatabase(readConfig().databaseUrl);
  try{
    const result=await db.transaction(async sql=>{
      const found=await sql.query<{id:string;email_verified_at:Date|null}>('SELECT id,email_verified_at FROM accounts WHERE id=$1 FOR UPDATE',[accountId]);
      requireValue(found.rows[0]?.email_verified_at,400,'account_unavailable','A verified community account is required.');
      const id=found.rows[0].id;
      await sql.query('UPDATE accounts SET role=$2,updated_at=now() WHERE id=$1',[id,action==='grant-admin'?'administrator':'member']);
      await sql.query('UPDATE sessions SET revoked_at=now(),mfa_verified_until=NULL WHERE account_id=$1 AND revoked_at IS NULL',[id]);
      await sql.query('DELETE FROM hosted_sessions WHERE session_id IN (SELECT id FROM sessions WHERE account_id=$1)',[id]);
      await sql.query('INSERT INTO operator_audit(id,target_account_id,event_type) VALUES($1,$2,$3)',[randomUUID(),id,action==='grant-admin'?'administrator.granted':'administrator.revoked']);
      return {accountId:id,action,sessionsRevoked:true};
    });
    process.stdout.write(`${JSON.stringify(result)}\n`);
  }finally{await db.close();}
}
main().catch(()=>{process.stderr.write('Operator action failed. Check command syntax, verified account and database access.\n');process.exitCode=1;});
