import {randomUUID} from 'node:crypto';
import {AccessService} from './access.js';
import type {Database,Sql} from './db.js';
import {object,onlyKeys,requireValue} from './errors.js';
import {systemClock,type Actor,type Clock} from './types.js';

export interface GroupLimits {version:number;memberLimit:number;createdGroupLimit:number;joinedGroupLimit:number}
const columns='version,member_limit AS "memberLimit",created_group_limit AS "createdGroupLimit",joined_group_limit AS "joinedGroupLimit"';

/** A list reads once; write transactions hold a shared settings lock until commit. */
export async function loadGroupLimits(sql:Sql,lock=false):Promise<GroupLimits>{
  const result=await sql.query<GroupLimits>(`SELECT ${columns} FROM group_limits WHERE singleton${lock?' FOR SHARE':''}`);
  requireValue(result.rows[0],503,'not_configured','群容量配置尚未完成，请联系管理员。');
  return result.rows[0];
}

export class GroupLimitsService {
  constructor(readonly db:Database,readonly access=new AccessService(db),readonly clock:Clock=systemClock){}
  async get(actor:Actor,sql:Sql=this.db):Promise<GroupLimits>{await this.access.assertPlatformAdmin(actor,sql);return loadGroupLimits(sql);}
  async update(actor:Actor,input:unknown,transaction?:Sql):Promise<GroupLimits>{
    const data=object(input);onlyKeys(data,['expectedVersion','memberLimit','createdGroupLimit','joinedGroupLimit']);
    requireValue(Number.isSafeInteger(data.expectedVersion)&&Number(data.expectedVersion)>0,400,'invalid_request','请提供当前群容量配置版本。');
    for(const [key,min,max] of [['memberLimit',2,500],['createdGroupLimit',1,20],['joinedGroupLimit',1,100]] as const)requireValue(Number.isSafeInteger(data[key])&&Number(data[key])>=min&&Number(data[key])<=max,400,'invalid_request',`群容量配置 ${key} 应为 ${min} 至 ${max} 的整数。`);
    requireValue(Number(data.createdGroupLimit)<=Number(data.joinedGroupLimit),400,'invalid_request','创建群上限不能超过参与群上限。');
    const work=async(sql:Sql)=>{
      await this.access.assertPlatformAdmin(actor,sql);await this.access.assertCapability(actor,'write',sql);await this.access.assertPlatformAdmin(actor,sql);
      const current=(await sql.query<GroupLimits>(`SELECT ${columns} FROM group_limits WHERE singleton FOR UPDATE`)).rows[0];
      requireValue(current,503,'not_configured','群容量配置尚未完成。');requireValue(current.version===data.expectedVersion,409,'conflict','群容量配置已更新，请重新读取后操作。');
      const changed=(await sql.query<GroupLimits>(`UPDATE group_limits SET member_limit=$1,created_group_limit=$2,joined_group_limit=$3,version=version+1,updated_at=$4 WHERE singleton RETURNING ${columns}`,[data.memberLimit,data.createdGroupLimit,data.joinedGroupLimit,this.clock()])).rows[0];
      await sql.query('INSERT INTO group_limit_changes(id,actor_id,previous_limits,new_limits,created_at) VALUES($1,$2,$3::jsonb,$4::jsonb,$5)',[randomUUID(),actor.accountId,JSON.stringify(current),JSON.stringify(changed),this.clock()]);
      return changed;
    };
    return transaction?work(transaction):this.db.transaction(work);
  }
}
