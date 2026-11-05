import {randomUUID} from 'node:crypto';
import type {Database,Sql} from './db.js';
import {object,onlyKeys,requireValue,text} from './errors.js';
import {canonicalJson,payloadFingerprint} from './operations.js';
import {systemClock,type Actor,type Clock} from './types.js';
import {AccessService,uuid} from './access.js';

export interface QuietHours {start:string;end:string;timeZone:string}
export interface AttentionPreferences {
  accountId:string;ordinaryAlertsEnabled:boolean;systemPushEnabled:boolean;soundEnabled:boolean;vibrationEnabled:boolean;
  showUnreadBadges:false;replayAfterFocus:false;focus:boolean;quietHours:QuietHours|null;
}
export type DeliveryStatus='suppressed'|'not_configured'|'pending'|'delivered'|'failed';
export interface AttentionReceipt {eventId:string;recipientAccountId:string;status:DeliveryStatus;reason:string|null;deliveredAt:string|null;providerReceiptId:string|null}
export interface DispatchEvent {eventId:string;recipientAccountId:string;senderAccountId:string;kind:'ordinary'|'system';payload:unknown;idempotencyKey:string;soundEnabled:boolean;vibrationEnabled:boolean;showUnreadBadges:false}
export interface AttentionDispatcher {configured:boolean;deliver(event:DispatchEvent):Promise<{receiptId:string}>}
export const DEVICE_FOCUS_LEASE_MS=120_000;
export type DeviceFocus={enabled:boolean;expiresAt:string|null;focus:boolean};
interface PreferenceRow {account_id:string;ordinary_alerts_enabled:boolean;system_push_enabled:boolean;sound_enabled:boolean;vibration_enabled:boolean;focus:boolean;quiet_hours:QuietHours|null}
interface EventRow {id:string;event_id:string;sender_id:string;recipient_id:string;kind:'ordinary'|'system';payload:unknown;payload_hash:string;status:DeliveryStatus;reason:string|null;provider_receipt_id:string|null;delivered_at:Date|null}
const preferences=(row:PreferenceRow):AttentionPreferences=>({accountId:row.account_id,ordinaryAlertsEnabled:row.ordinary_alerts_enabled,systemPushEnabled:row.system_push_enabled,soundEnabled:row.sound_enabled,vibrationEnabled:row.vibration_enabled,showUnreadBadges:false,replayAfterFocus:false,focus:row.focus,quietHours:row.quiet_hours});
const receipt=(row:EventRow):AttentionReceipt=>({eventId:row.event_id,recipientAccountId:row.recipient_id,status:row.status,reason:row.reason,providerReceiptId:row.provider_receipt_id,deliveredAt:row.delivered_at?new Date(row.delivered_at).toISOString():null});
const eventSelect='SELECT e.*,d.status,d.reason,d.provider_receipt_id,d.delivered_at FROM attention_events e JOIN attention_deliveries d ON d.event_record_id=e.id';
const minute=(time:string)=>Number(time.slice(0,2))*60+Number(time.slice(3));

function quietHours(value:unknown):QuietHours|null {
  if(value===null)return null;
  const input=object(value);onlyKeys(input,['start','end','timeZone']);
  requireValue(typeof input.start==='string'&&typeof input.end==='string'&&/^([01]\d|2[0-3]):[0-5]\d$/.test(input.start)&&/^([01]\d|2[0-3]):[0-5]\d$/.test(input.end)&&input.start!==input.end,400,'invalid_request','免打扰时间应为不同的有效时分。');
  const timeZone=text(input.timeZone,'免打扰时区',100);
  try{new Intl.DateTimeFormat('en-US',{timeZone}).format(new Date());}catch{requireValue(false,400,'invalid_request','免打扰时区无效。');}
  return {start:input.start,end:input.end,timeZone};
}
function suppression(row:PreferenceRow,kind:EventRow['kind'],now:Date):string|null {
  if(row.focus)return 'focus';
  if(row.quiet_hours){
    const parts=new Intl.DateTimeFormat('en-US',{timeZone:row.quiet_hours.timeZone,hourCycle:'h23',hour:'2-digit',minute:'2-digit'}).formatToParts(now);
    const local=Number(parts.find(part=>part.type==='hour')!.value)*60+Number(parts.find(part=>part.type==='minute')!.value),start=minute(row.quiet_hours.start),end=minute(row.quiet_hours.end);
    if(start<end?local>=start&&local<end:local>=start||local<end)return 'quiet_hours';
  }
  return (kind==='system'?row.system_push_enabled:row.ordinary_alerts_enabled)?null:'disabled';
}

export class AttentionService {
  private readonly clock:Clock;
  constructor(private readonly db:Database,private readonly options:{clock?:Clock;dispatcher?:AttentionDispatcher}={}){this.clock=options.clock??systemClock;}
  private async preferenceRow(sql:Sql,accountId:string):Promise<PreferenceRow>{
    await sql.query('INSERT INTO attention_preferences(account_id) SELECT id FROM accounts WHERE id=$1 ON CONFLICT DO NOTHING',[accountId]);
    const result=await sql.query<PreferenceRow>('SELECT * FROM attention_preferences WHERE account_id=$1 FOR UPDATE',[accountId]);requireValue(result.rows[0],404,'not_found','找不到这个账号。');return result.rows[0];
  }
  private async effectivePreferences(sql:Sql,row:PreferenceRow):Promise<AttentionPreferences>{
    if(row.focus)return preferences(row);
    const active=await sql.query('SELECT 1 FROM community_device_focus f JOIN community_devices d ON d.id=f.device_id WHERE d.account_id=$1 AND d.revoked_at IS NULL AND f.expires_at>$2 LIMIT 1',[row.account_id,this.clock()]);
    return preferences({...row,focus:!!active.rowCount});
  }
  async getPreferences(actor:Actor):Promise<AttentionPreferences>{return this.db.transaction(async sql=>this.effectivePreferences(sql,await this.preferenceRow(sql,actor.accountId)));}
  async updatePreferences(actor:Actor,value:unknown):Promise<AttentionPreferences>{
    const input=object(value);onlyKeys(input,['ordinaryAlertsEnabled','systemPushEnabled','soundEnabled','vibrationEnabled','showUnreadBadges','replayAfterFocus','quietHours']);
    for(const key of ['ordinaryAlertsEnabled','systemPushEnabled','soundEnabled','vibrationEnabled'] as const)if(Object.hasOwn(input,key))requireValue(typeof input[key]==='boolean',400,'invalid_request','提醒开关必须是布尔值。');
    for(const key of ['showUnreadBadges','replayAfterFocus'] as const)if(Object.hasOwn(input,key))requireValue(input[key]===false,400,'invalid_request','社区不启用未读角标或专注后补发。');
    const hours=Object.hasOwn(input,'quietHours')?quietHours(input.quietHours):undefined;
    return this.db.transaction(async sql=>{
      const current=await this.preferenceRow(sql,actor.accountId);
      const result=await sql.query<PreferenceRow>(`UPDATE attention_preferences SET ordinary_alerts_enabled=$2,system_push_enabled=$3,sound_enabled=$4,vibration_enabled=$5,quiet_hours=$6::jsonb,updated_at=$7 WHERE account_id=$1 RETURNING *`,[
        actor.accountId,Object.hasOwn(input,'ordinaryAlertsEnabled')?input.ordinaryAlertsEnabled:current.ordinary_alerts_enabled,Object.hasOwn(input,'systemPushEnabled')?input.systemPushEnabled:current.system_push_enabled,Object.hasOwn(input,'soundEnabled')?input.soundEnabled:current.sound_enabled,Object.hasOwn(input,'vibrationEnabled')?input.vibrationEnabled:current.vibration_enabled,hours===undefined?(current.quiet_hours?canonicalJson(current.quiet_hours):null):(hours?canonicalJson(hours):null),this.clock(),
      ]);return this.effectivePreferences(sql,result.rows[0]);
    });
  }
  async setFocus(actor:Actor,enabled:boolean):Promise<AttentionPreferences>{
    requireValue(typeof enabled==='boolean',400,'invalid_request','专注状态必须是布尔值。');
    return this.db.transaction(async sql=>{await this.preferenceRow(sql,actor.accountId);const result=await sql.query<PreferenceRow>('UPDATE attention_preferences SET focus=$2,updated_at=$3 WHERE account_id=$1 RETURNING *',[actor.accountId,enabled,this.clock()]);return this.effectivePreferences(sql,result.rows[0]);});
  }
  async setDeviceFocus(device:{id:string;account_id:string;target_key:string},enabled:boolean):Promise<DeviceFocus>{
    requireValue(typeof enabled==='boolean',400,'invalid_request','专注状态必须是布尔值。');
    return this.db.transaction(async sql=>{
      const accountId=uuid(device.account_id),deviceId=uuid(device.id),targetKey=uuid(device.target_key),preference=await this.preferenceRow(sql,accountId);
      await new AccessService(this.db,this.clock).assertAccount({accountId:device.account_id,role:'member',mfaVerified:false},sql);
      // Delivery policy is serialized by the existing preference lock. Device
      // revocation need not wait for it: every effective read joins the live,
      // non-revoked device, so a racing renewal cannot resurrect a revoked grant.
      const current=await sql.query('SELECT id FROM community_devices WHERE id=$1 AND account_id=$2 AND target_key=$3 AND revoked_at IS NULL',[deviceId,accountId,targetKey]);
      requireValue(current.rowCount,401,'device_revoked','桌面授权已撤销，请重新连接。');const now=this.clock(),expires=enabled?new Date(now.getTime()+DEVICE_FOCUS_LEASE_MS):null;
      if(expires)await sql.query('INSERT INTO community_device_focus(device_id,expires_at,updated_at) VALUES($1,$2,$3) ON CONFLICT(device_id) DO UPDATE SET expires_at=EXCLUDED.expires_at,updated_at=EXCLUDED.updated_at',[device.id,expires,now]);
      else await sql.query('DELETE FROM community_device_focus WHERE device_id=$1',[device.id]);
      const policy=await this.effectivePreferences(sql,preference);return {enabled,expiresAt:expires?.toISOString()||null,focus:policy.focus};
    });
  }
  /** Internal event ingress; authorization to message this recipient belongs to its caller. */
  async recordEvent(actor:Actor,value:unknown,transaction?:Sql):Promise<AttentionReceipt>{
    const input=object(value);onlyKeys(input,['eventId','recipientAccountId','kind','payload']);
    const eventId=text(input.eventId,'事件标识',200),recipient=text(input.recipientAccountId,'接收账号',80);
    requireValue(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(recipient),400,'invalid_request','接收账号格式不正确。');
    requireValue(input.kind==='ordinary'||input.kind==='system',400,'invalid_request','事件类型不正确。');
    const kind=input.kind;
    requireValue(input.kind!=='system'||(actor.role==='administrator'&&actor.mfaVerified),403,'forbidden','系统提醒仅允许已验证的管理服务发起。');
    const encoded=canonicalJson(input.payload),fingerprint=payloadFingerprint({sender:actor.accountId,kind:input.kind,payload:input.payload});
    const work=async(sql:Sql)=>{
      if(kind==='system')await new AccessService(this.db,this.clock).assertPlatformAdmin(actor,sql);
      await sql.query("SELECT pg_advisory_xact_lock(hashtextextended(current_schema() || ':attention:' || $1 || ':' || $2,0))",[recipient,eventId]);
      const existing=await sql.query<EventRow>(`${eventSelect} WHERE e.recipient_id=$1 AND e.event_id=$2`,[recipient,eventId]);
      if(existing.rows[0]){requireValue(existing.rows[0].payload_hash===fingerprint,409,'idempotency_conflict','事件标识已用于不同内容。');return receipt(existing.rows[0]);}
      const pref=await this.preferenceRow(sql,recipient),effective=await this.effectivePreferences(sql,pref),now=this.clock(),reason=suppression({...pref,focus:effective.focus},kind,now),status:DeliveryStatus=reason?'suppressed':this.options.dispatcher?.configured?'pending':'not_configured',id=randomUUID();
      await sql.query('INSERT INTO attention_events(id,event_id,sender_id,recipient_id,kind,payload,payload_hash,created_at) VALUES($1,$2,$3,$4,$5,$6::jsonb,$7,$8)',[id,eventId,actor.accountId,recipient,input.kind,encoded,fingerprint,now]);
      await sql.query('INSERT INTO attention_deliveries(event_record_id,status,reason,updated_at) VALUES($1,$2,$3,$4)',[id,status,reason??(status==='not_configured'?'dispatcher_not_configured':null),now]);
      const result=await sql.query<EventRow>(`${eventSelect} WHERE e.id=$1`,[id]);return receipt(result.rows[0]);
    };
    return transaction?work(transaction):this.db.transaction(work);
  }
  async getEvent(actor:Actor,eventId:string):Promise<AttentionReceipt>{
    eventId=text(eventId,'事件标识',200);const result=await this.db.query<EventRow>(`${eventSelect} WHERE e.recipient_id=$1 AND e.event_id=$2`,[actor.accountId,eventId]);requireValue(result.rows[0],404,'not_found','找不到这项提醒事件。');return receipt(result.rows[0]);
  }
  /** Internal dispatcher entry; terminal suppressed/unconfigured events are never replayed. */
  async dispatch(recipientAccountId:string,eventId:string):Promise<AttentionReceipt>{
    return this.db.transaction(async sql=>{
      const result=await sql.query<EventRow>(`${eventSelect} WHERE e.recipient_id=$1 AND e.event_id=$2 FOR UPDATE OF d`,[recipientAccountId,eventId]);
      const event=result.rows[0];requireValue(event,404,'not_found','找不到这项提醒事件。');if(event.status!=='pending')return receipt(event);
      const pref=await this.preferenceRow(sql,event.recipient_id),effective=await this.effectivePreferences(sql,pref),reason=suppression({...pref,focus:effective.focus},event.kind,this.clock());
      let status:DeliveryStatus,providerReceiptId:string|null=null;
      if(reason)status='suppressed';else if(!this.options.dispatcher?.configured)status='not_configured';else{
        try{
          const delivered=await this.options.dispatcher.deliver({eventId:event.event_id,recipientAccountId:event.recipient_id,senderAccountId:event.sender_id,kind:event.kind,payload:event.payload,idempotencyKey:`${event.recipient_id}:${event.event_id}`,soundEnabled:pref.sound_enabled,vibrationEnabled:pref.vibration_enabled,showUnreadBadges:false});
          providerReceiptId=text(delivered.receiptId,'投递回执',200);status='delivered';
        }catch{status='failed';}
      }
      const now=this.clock();await sql.query('UPDATE attention_deliveries SET status=$2,reason=$3,provider_receipt_id=$4,delivered_at=$5,updated_at=$6 WHERE event_record_id=$1',[event.id,status,reason??(status==='not_configured'?'dispatcher_not_configured':status==='failed'?'dispatch_failed':null),providerReceiptId,status==='delivered'?now:null,now]);
      const updated=await sql.query<EventRow>(`${eventSelect} WHERE e.id=$1`,[event.id]);return receipt(updated.rows[0]);
    });
  }
}
