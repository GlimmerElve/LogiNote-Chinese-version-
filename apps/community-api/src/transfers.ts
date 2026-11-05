import type {Database} from './db.js';
import {requireValue} from './errors.js';
import {systemClock,type Clock} from './types.js';
/** Conservative accounting: a permitted response consumes its full size even if the client disconnects. */
export class TransferQuota {
  constructor(private readonly db:Database,readonly limit:number,private readonly clock:Clock=systemClock){requireValue(Number.isSafeInteger(limit)&&limit>=0,500,'invalid_configuration','下载额度配置不正确。');}
  assertConfigured(){requireValue(this.limit>0,503,'not_configured','附件下载额度尚未配置。');}
  async consume(bytes:number){
    this.assertConfigured();requireValue(Number.isSafeInteger(bytes)&&bytes>0,400,'invalid_request','下载大小不正确。');
    requireValue(bytes<=this.limit,429,'quota_exceeded','本月附件下载额度不足。');const now=this.clock(),period=now.toISOString().slice(0,7);
    const result=await this.db.query<{bytes:string}>(`INSERT INTO transfer_usage(period,bytes,updated_at) VALUES($1,$2,$3)
      ON CONFLICT(period) DO UPDATE SET bytes=transfer_usage.bytes+EXCLUDED.bytes,updated_at=EXCLUDED.updated_at
      WHERE transfer_usage.bytes+EXCLUDED.bytes<=$4 RETURNING bytes`,[period,bytes,now,this.limit]);
    requireValue(result.rows[0],429,'quota_exceeded','本月附件下载额度已用完。');return {period,usedBytes:Number(result.rows[0].bytes),limitBytes:this.limit};
  }
  async usage(){const period=this.clock().toISOString().slice(0,7),result=await this.db.query<{bytes:string}>('SELECT bytes FROM transfer_usage WHERE period=$1',[period]);return {period,usedBytes:Number(result.rows[0]?.bytes||0),limitBytes:this.limit};}
}
