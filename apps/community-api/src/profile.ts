import type {Database,Sql} from './db.js';
import type {AccessService} from './access.js';
import {object,onlyKeys,requireValue,text} from './errors.js';
import {systemClock,type Actor,type Clock} from './types.js';
import {avatarData,avatarPath} from './avatar.js';

export interface AccountProfile {accountId:string;displayName:string;bio:string;interests:string[];avatarUrl?:string}
export class ProfileService {
  constructor(private readonly db:Database,private readonly access:AccessService,private readonly clock:Clock=systemClock){}
  async get(actor:Actor,sql:Sql=this.db):Promise<AccountProfile>{
    const row=(await sql.query<AccountProfile&{has_avatar:boolean;avatar_version:string}>(`SELECT a.id AS "accountId",a.display_name AS "displayName",COALESCE(p.bio,'') AS bio,COALESCE(p.interests,'{}'::text[]) AS interests,p.avatar_data IS NOT NULL AS has_avatar,p.avatar_version FROM accounts a LEFT JOIN account_profiles p ON p.account_id=a.id WHERE a.id=$1`,[actor.accountId])).rows[0];
    requireValue(row,404,'not_found','找不到这个账号。');const {has_avatar,avatar_version,...profile}=row;return {...profile,...(has_avatar?{avatarUrl:avatarPath(row.accountId,avatar_version)}:{})};
  }
  async avatar(accountId:string,version:string){
    const row=(await this.db.query<{avatar_data:string}>(`SELECT p.avatar_data FROM account_profiles p JOIN accounts a ON a.id=p.account_id WHERE p.account_id=$1 AND p.avatar_version=$2 AND p.avatar_data IS NOT NULL`,[accountId,version])).rows[0];
    requireValue(row,404,'not_found','头像不存在。');return Buffer.from(row.avatar_data.slice('data:image/webp;base64,'.length),'base64');
  }
  async update(actor:Actor,value:unknown,sql:Sql):Promise<AccountProfile>{
    await this.access.assertCapability(actor,'write',sql);
    const input=object(value);onlyKeys(input,['displayName','bio','interests','avatarData']);
    const avatar=input.avatarData===undefined?undefined:avatarData(input.avatarData);
    const displayName=text(input.displayName,'昵称',80);
    requireValue(typeof input.bio==='string'&&input.bio.length<=160,400,'invalid_request','个人介绍不能超过 160 个字符。');
    requireValue(Array.isArray(input.interests)&&input.interests.length<=8,400,'invalid_request','兴趣最多填写 8 个。');
    const interests=[...new Set(input.interests.map(item=>text(item,'兴趣',20)))];
    for(const field of [displayName,input.bio,...interests])requireValue(!/[\u0000-\u001f\u007f]/.test(field),400,'invalid_request','资料中含有不支持的字符。');
    const now=this.clock();
    const account=await sql.query('UPDATE accounts SET display_name=$2,updated_at=$3 WHERE id=$1 RETURNING id',[actor.accountId,displayName,now]);
    requireValue(account.rows[0],404,'not_found','找不到这个账号。');
    await sql.query('INSERT INTO account_profiles(account_id,bio,interests,updated_at) VALUES($1,$2,$3,$4) ON CONFLICT(account_id) DO UPDATE SET bio=EXCLUDED.bio,interests=EXCLUDED.interests,updated_at=EXCLUDED.updated_at',[actor.accountId,input.bio.trim(),interests,now]);
    if(avatar!==undefined)await sql.query('UPDATE account_profiles SET avatar_data=$2,avatar_version=avatar_version+1 WHERE account_id=$1 AND avatar_data IS DISTINCT FROM $2',[actor.accountId,avatar]);
    return this.get(actor,sql);
  }
}
