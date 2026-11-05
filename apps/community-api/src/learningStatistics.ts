import type {Database,Sql} from './db.js';
import {AccessService,uuid} from './access.js';
import {object,onlyKeys,requireValue} from './errors.js';
import {payloadFingerprint} from './operations.js';
import {systemClock,type Actor,type Clock} from './types.js';
import {LEARNING_METRICS,DEFAULT_LEARNING_METRICS,statisticsDate,type LearningMetric,type LearningStatisticsPolicy,type LearningStatisticsSnapshot,type DisplayedLearningStatistics,type OwnLearningStatistics} from './learningStatisticsContract.js';

type PolicyRow={account_id:string;enabled:boolean;metrics:LearningMetric[];scope:'public'|'groups';group_ids:string[];source_device_id:string|null;revision:number};
type Device={id:string;account_id:string;target_key:string};
const policy=(row:PolicyRow|undefined):LearningStatisticsPolicy=>row?{enabled:row.enabled,metrics:row.metrics,scope:row.scope,groupIds:row.group_ids,sourceDeviceId:row.source_device_id,revision:row.revision}:{enabled:false,metrics:[...DEFAULT_LEARNING_METRICS],scope:'public',groupIds:[],sourceDeviceId:null,revision:0};
export class LearningStatisticsService{
  constructor(private readonly db:Database,private readonly access:AccessService,private readonly clock:Clock=systemClock){}
  async own(actor:Actor,sql:Sql=this.db):Promise<OwnLearningStatistics>{
    const row=(await sql.query<PolicyRow>('SELECT * FROM learning_statistics_policies WHERE account_id=$1',[actor.accountId])).rows[0];
    const connected=!!row?.source_device_id&&!!(await sql.query('SELECT 1 FROM community_devices WHERE id=$1 AND account_id=$2 AND revoked_at IS NULL',[row.source_device_id,actor.accountId])).rowCount;
    return {policy:policy(row),snapshot:connected?await this.visible(actor,actor.accountId,sql):null,sourceConnected:connected};
  }
  async update(actor:Actor,value:unknown,sql:Sql):Promise<OwnLearningStatistics>{
    const input=object(value);onlyKeys(input,['enabled','metrics','scope','groupIds','sourceDeviceId','revision']);
    requireValue(typeof input.enabled==='boolean'&&Number.isSafeInteger(input.revision)&&Number(input.revision)>=0,400,'invalid_request','展示设置或版本不正确。');
    if(input.enabled)await this.access.assertCapability(actor,'write',sql);
    else{
      // A writing restriction must never prevent withdrawal of an existing disclosure.
      await this.access.assertAccount(actor,sql);
      await sql.query('SELECT id FROM accounts WHERE id=$1 FOR UPDATE',[actor.accountId]);
    }
    requireValue(Array.isArray(input.metrics)&&input.metrics.length>0&&input.metrics.length<=3&&input.metrics.every(item=>LEARNING_METRICS.includes(item as LearningMetric))&&new Set(input.metrics).size===input.metrics.length,400,'invalid_request','请选择有效的学习统计。');
    requireValue(input.scope==='public'||input.scope==='groups',400,'invalid_request','展示范围不正确。');
    requireValue(Array.isArray(input.groupIds)&&input.groupIds.length<=10,400,'invalid_request','展示群范围不正确。');
    const groups=[...new Set(input.groupIds.map(item=>uuid(item,'共学群')))];
    const source=input.sourceDeviceId?uuid(input.sourceDeviceId,'终端设备'):null;
    if(source)requireValue((await sql.query('SELECT 1 FROM community_devices WHERE id=$1 AND account_id=$2',[source,actor.accountId])).rowCount,400,'statistics_source_required','请选择自己的 LogiNote 终端。');
    const existing=(await sql.query<PolicyRow>('SELECT * FROM learning_statistics_policies WHERE account_id=$1 FOR UPDATE',[actor.accountId])).rows[0];
    requireValue((existing?.revision||0)===input.revision,409,'statistics_settings_changed','设置已在其他页面修改，请重新读取后再保存。');
    if(input.enabled){
      requireValue(source&&(await sql.query('SELECT 1 FROM community_devices WHERE id=$1 AND account_id=$2 AND revoked_at IS NULL',[source,actor.accountId])).rowCount,400,'statistics_source_required','请先连接并选择自己的 LogiNote 终端。');
      if(input.scope==='groups'){
        requireValue(groups.length>0,400,'statistics_groups_required','请选择可以查看统计的共学群。');
        for(const id of groups)requireValue(await this.access.membership(actor,id,sql),403,'forbidden','只能向自己当前加入的群展示统计。');
      }
    }
    const next={enabled:input.enabled,metrics:input.metrics as LearningMetric[],scope:input.scope,groupIds:input.scope==='groups'?groups:[],sourceDeviceId:source};
    const prior=policy(existing),unchanged=JSON.stringify({...prior,revision:undefined})===JSON.stringify({...next,revision:undefined});
    if(!unchanged||!existing){
      await sql.query(`INSERT INTO learning_statistics_policies(account_id,enabled,metrics,scope,group_ids,source_device_id,revision,updated_at) VALUES($1,$2,$3,$4,$5,$6,1,$7)
        ON CONFLICT(account_id) DO UPDATE SET enabled=EXCLUDED.enabled,metrics=EXCLUDED.metrics,scope=EXCLUDED.scope,group_ids=EXCLUDED.group_ids,source_device_id=EXCLUDED.source_device_id,revision=learning_statistics_policies.revision+1,updated_at=EXCLUDED.updated_at`,[actor.accountId,next.enabled,next.metrics,next.scope,next.groupIds,next.sourceDeviceId,this.clock()]);
      // A new disclosure grant always needs a fresh report under its new revision.
      await sql.query('DELETE FROM learning_statistics_snapshots WHERE account_id=$1',[actor.accountId]);
    }
    return this.own(actor,sql);
  }
  async visible(viewer:Actor|null,accountId:string,sql:Sql=this.db):Promise<DisplayedLearningStatistics|null>{
    const row=(await sql.query<PolicyRow&{snapshot:LearningStatisticsSnapshot;updated_at:Date}>(`SELECT p.*,s.snapshot,s.updated_at FROM learning_statistics_policies p
      JOIN learning_statistics_snapshots s ON s.account_id=p.account_id AND s.policy_revision=p.revision AND s.device_id=p.source_device_id
      JOIN community_devices d ON d.id=p.source_device_id AND d.account_id=p.account_id AND d.revoked_at IS NULL
      WHERE p.account_id=$1 AND p.enabled`,[accountId])).rows[0];
    if(!row)return null;
    if(viewer?.accountId!==accountId&&row.scope==='groups'){
      if(!viewer)return null;
      const shared=await sql.query(`SELECT 1 FROM group_memberships mine JOIN group_memberships author ON author.group_id=mine.group_id
        JOIN groups g ON g.id=mine.group_id AND g.state<>'dissolved'
        JOIN protected_objects root ON root.id=g.id AND (root.state='visible' OR root.state='restricted' AND root.restricted_until<=$4)
        WHERE mine.account_id=$1 AND author.account_id=$2 AND mine.state='active' AND author.state='active' AND mine.group_id=ANY($3::uuid[]) LIMIT 1`,[viewer.accountId,accountId,row.group_ids,this.clock()]);
      if(!shared.rowCount)return null;
    }
    if(viewer?.accountId!==accountId&&row.snapshot.state!=='ready')return null;
    const values=Object.fromEntries(row.metrics.filter(metric=>Object.hasOwn(row.snapshot.values,metric)).map(metric=>[metric,row.snapshot.values[metric]]));
    return {...row.snapshot,values,updatedAt:new Date(row.updated_at).toISOString()};
  }
  async accept(device:Device,value:unknown){
    const input=object(value);onlyKeys(input,['revision','snapshot']);
    requireValue(Number.isSafeInteger(input.revision)&&Number(input.revision)>0,400,'invalid_request','学习统计授权版本不正确。');
    const raw=object(input.snapshot);onlyKeys(raw,['state','asOfDate','timeZone','computedAt','calculationVersion','values']);
    requireValue(typeof raw.state==='string'&&['ready','empty','unavailable'].includes(raw.state)&&raw.calculationVersion==='loginote-learning-v1',400,'invalid_request','学习统计格式不正确。');
    requireValue(typeof raw.timeZone==='string'&&raw.timeZone.length<=100&&typeof raw.asOfDate==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(raw.asOfDate)&&typeof raw.computedAt==='string',400,'invalid_request','学习统计日期不正确。');
    const calculated=new Date(raw.computedAt as string),now=this.clock();let day='';
    try{day=statisticsDate(calculated,raw.timeZone as string);}catch{}
    requireValue(day===raw.asOfDate&&calculated.getTime()<=now.getTime()+300_000&&calculated.getTime()>=now.getTime()-7*86_400_000,400,'invalid_request','学习统计时间已失效或终端时钟不正确。');
    const values=object(raw.values);onlyKeys(values,[...LEARNING_METRICS]);
    for(const [key,val] of Object.entries(values))requireValue(Number.isSafeInteger(val)&&Number(val)>=0&&Number(val)<=(key==='activeDaysThisMonth'?31:key==='avgDailyMinutes'?44640:36500),400,'invalid_request','学习统计数值不正确。');
    const actor:Actor={accountId:device.account_id,role:'member',mfaVerified:false};
    return this.db.transaction(async sql=>{
      await this.access.assertCapability(actor,'write',sql);
      const row=(await sql.query<PolicyRow>('SELECT * FROM learning_statistics_policies WHERE account_id=$1 FOR UPDATE',[actor.accountId])).rows[0];
      requireValue(row?.enabled&&row.revision===input.revision&&row.source_device_id===device.id,409,'statistics_consent_changed','学习统计展示授权已变化，请重新读取设置。');
      requireValue((await sql.query('SELECT 1 FROM community_devices WHERE id=$1 AND account_id=$2 AND target_key=$3 AND revoked_at IS NULL',[device.id,actor.accountId,device.target_key])).rowCount,401,'device_revoked','终端授权已撤销。');
      requireValue(Object.keys(values).every(metric=>row.metrics.includes(metric as LearningMetric))&&(raw.state==='ready'?row.metrics.every(metric=>Object.hasOwn(values,metric)):Object.keys(values).length===0),400,'statistics_metrics_mismatch','终端只能提交本人选择展示的指标。');
      const snapshot=raw as unknown as LearningStatisticsSnapshot,fingerprint=payloadFingerprint(snapshot);
      const previous=(await sql.query<{snapshot:LearningStatisticsSnapshot;fingerprint:string}>('SELECT snapshot,fingerprint FROM learning_statistics_snapshots WHERE account_id=$1',[actor.accountId])).rows[0];
      requireValue(!previous||Date.parse(snapshot.computedAt)>=Date.parse(previous.snapshot.computedAt),409,'statistics_report_stale','已有更新的终端统计，本次旧报告未覆盖。');
      if(previous?.fingerprint!==fingerprint)await sql.query(`INSERT INTO learning_statistics_snapshots(account_id,device_id,policy_revision,snapshot,fingerprint,updated_at) VALUES($1,$2,$3,$4::jsonb,$5,$6)
        ON CONFLICT(account_id) DO UPDATE SET device_id=EXCLUDED.device_id,policy_revision=EXCLUDED.policy_revision,snapshot=EXCLUDED.snapshot,fingerprint=EXCLUDED.fingerprint,updated_at=EXCLUDED.updated_at`,[actor.accountId,device.id,row.revision,JSON.stringify(snapshot),fingerprint,now]);
      return {accepted:true};
    });
  }
}
