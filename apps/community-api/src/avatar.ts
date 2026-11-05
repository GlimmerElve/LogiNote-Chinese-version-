import {requireValue} from './errors.js';

export const AVATAR_MAX_BYTES=32*1024;
const invalid=()=>requireValue(false,400,'invalid_avatar','头像图片无法读取，请重新选择 PNG、JPG 或 WebP 图片。');
/** The browser re-encodes selected raster photos as a small, static WebP thumbnail. */
export function avatarData(value:unknown):string|null {
  if(value===null)return null;
  requireValue(typeof value==='string'&&value.length<=44000,400,'invalid_avatar','头像图片过大，请重新选择。');
  const match=/^data:image\/webp;base64,([A-Za-z0-9+/]+={0,2})$/.exec(value);if(!match)invalid();
  const data=Buffer.from(match![1],'base64');
  if(data.length>AVATAR_MAX_BYTES||data.length<30||data.toString('base64')!==match![1]||data.toString('ascii',0,4)!=='RIFF'||data.toString('ascii',8,12)!=='WEBP'||data.readUInt32LE(4)!==data.length-8)invalid();
  const kind=data.toString('ascii',12,16);let width=0,height=0;
  if(kind==='VP8 '&&data.length>=30&&data.subarray(23,26).equals(Buffer.from([0x9d,0x01,0x2a]))){width=data.readUInt16LE(26)&0x3fff;height=data.readUInt16LE(28)&0x3fff;}
  else if(kind==='VP8L'&&data[20]===0x2f){const bits=data.readUInt32LE(21);width=(bits&0x3fff)+1;height=((bits>>>14)&0x3fff)+1;}
  else if(kind==='VP8X'&&data.length>=38&&(data[20]&0x02)===0){width=data.readUIntLE(24,3)+1;height=data.readUIntLE(27,3)+1;}
  if(width<1||height<1||width>256||height>256)invalid();
  return value;
}
export function avatarPath(accountId:string,version:string|number):string{return `/profiles/${accountId}/avatar/${version}`;}
