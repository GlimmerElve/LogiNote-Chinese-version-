import type {Sql} from './db.js';
import type {FileService} from './files.js';
import type {Actor} from './types.js';
import {requireValue} from './errors.js';

export function messageCursor(value:string|undefined){
  if(value===undefined)return null;
  requireValue(/^\d{1,19}$/.test(value)&&BigInt(value)<=9223372036854775807n,400,'invalid_request','消息位置不正确。');return value;
}
export async function validateMessageImages(actor:Actor,objectId:string,files:FileService,sql:Sql){
  const rows=(await sql.query<{id:string;mime:string;bytes:number}>("SELECT id,mime,bytes::int AS bytes FROM private_attachments WHERE object_id=$1 AND state='ready'",[objectId])).rows;
  requireValue(rows.length>0&&rows.length<=4,400,'invalid_request','每条消息可附带一至四张图片。');
  requireValue(!(await sql.query("SELECT 1 FROM private_attachments WHERE object_id=$1 AND state='pending'",[objectId])).rowCount,409,'upload_pending','请等待图片上传完成。');
  for(const file of rows){
    const bytes=(await files.readReady(actor,file.id,sql)).buffer;
    const valid=file.mime==='image/png'?bytes.subarray(0,8).equals(Buffer.from('89504e470d0a1a0a','hex')):file.mime==='image/jpeg'?bytes[0]===255&&bytes[1]===216:file.mime==='image/gif'?/^GIF8[79]a$/.test(bytes.subarray(0,6).toString()):file.mime==='image/webp'?bytes.subarray(0,4).toString()==='RIFF'&&bytes.subarray(8,12).toString()==='WEBP':false;
    requireValue(valid&&file.bytes<=1500000,400,'invalid_image','请选择有效的 PNG、JPG、GIF 或 WebP 小图片。');
  }
}
