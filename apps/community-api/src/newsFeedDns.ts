import {isIP} from 'node:net';
import https from 'node:https';
import {ApiError} from './errors.js';
import {NEWS_SOURCE_PRESETS} from './newsFeed.js';
import type {NewsFeedFetchOptions} from './newsFeedFetch.js';

export type NewsFeedDnsMode='system'|'alidns';
export const ALIDNS_RESPONSE_BYTES=16*1024;
const ALIDNS_ENDPOINT='https://dns.alidns.com/resolve';
const ALIDNS_BOOTSTRAP='223.5.5.5';
const failure=(code='feed_dns',message='暂时无法通过所选 DNS 解析资讯原站。')=>new ApiError(502,code,message);
export function publicFeedAddress(address:string):boolean {
  if(isIP(address)===4){const p=address.split('.').map(Number);return !(p[0]===0||p[0]===10||p[0]===127||p[0]>=224||p[0]===169&&p[1]===254||p[0]===172&&p[1]>=16&&p[1]<=31||p[0]===192&&(p[1]===168||p[1]===0||p[1]===2)||p[0]===198&&(p[1]===18||p[1]===19||p[1]===51&&p[2]===100)||p[0]===203&&p[1]===0&&p[2]===113||p[0]===100&&p[1]>=64&&p[1]<=127);}
  return isIP(address)===6&&/^[23][\da-f]{3}:/i.test(address)&&!/^2001:(?:0*:|0?db8:|0?10:|0?20:)/i.test(address)&&!/^2002:|^3fff:/i.test(address);
}
const dnsName=(value:unknown)=>typeof value==='string'&&value.length<=254&&/^(?:[a-z\d](?:[a-z\d-]{0,61}[a-z\d])?\.)*[a-z\d](?:[a-z\d-]{0,61}[a-z\d])?\.?$/i.test(value)?value.toLowerCase().replace(/\.$/,''):null;
export function parseAliDnsAnswers(body:Buffer,hostname:string):{address:string;family:4}[]{
  if(body.length>ALIDNS_RESPONSE_BYTES)throw failure('feed_dns_size','DNS 响应过大，已停止读取。');
  let value:any;try{value=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(body));}catch{throw failure();}
  const expected=dnsName(hostname),questions=Array.isArray(value?.Question)?value.Question:[value?.Question],answers=value?.Answer;
  if(!expected||!value||typeof value!=='object'||value.Status!==0||value.TC===true||questions.length!==1||questions[0]?.type!==1||dnsName(questions[0]?.name)!==expected||!Array.isArray(answers)||answers.length<1||answers.length>64)throw failure();
  const names=new Set([expected]);
  for(const answer of answers)if(!answer||typeof answer!=='object'||![1,5].includes(answer.type)||!dnsName(answer.name)||answer.type===5&&!dnsName(answer.data))throw failure();
  // CDN CNAME chains are legitimate. Only A records reachable from the exact
  // requested name may be used; unrelated records never become destinations.
  for(let step=0;step<64;step++){let changed=false;for(const answer of answers)if(answer.type===5&&names.has(dnsName(answer.name)!)&&!names.has(dnsName(answer.data)!)){names.add(dnsName(answer.data)!);changed=true;}if(!changed)break;}
  const addresses:string[]=[];for(const answer of answers)if(answer.type===1){if(!names.has(dnsName(answer.name)!)||typeof answer.data!=='string'||isIP(answer.data)!==4||!publicFeedAddress(answer.data))throw failure('feed_destination','订阅原站解析到了不允许访问的网络地址。');addresses.push(answer.data);}
  if(!addresses.length)throw failure();return [...new Set(addresses)].map(address=>({address,family:4}));
}
export async function resolveAliDns(hostname:string,options:NewsFeedFetchOptions,signal:AbortSignal):Promise<{address:string;family:4}[]>{
  // This is an explicit application-local resolver choice, never an automatic
  // fallback or an OS DNS/proxy modification. No account/API key is sent.
  if(!NEWS_SOURCE_PRESETS.some(source=>(source.hosts as readonly string[]).includes(hostname)))throw failure('feed_destination','DNS 查询域名不在预设资讯源范围内。');
  if(signal.aborted)throw failure('feed_timeout','订阅读取已取消或超时。');
  const endpoint=new URL(ALIDNS_ENDPOINT);endpoint.searchParams.set('name',hostname);endpoint.searchParams.set('type','A');const settle=await options.reserve();let received=0;
  try{
    const body=await new Promise<Buffer>((resolve,reject)=>{
      // URL/SNI/certificate verification use dns.alidns.com while the socket
      // lookup is pinned to its public bootstrap IP, avoiding system fake DNS.
      const request=https.request(endpoint,{method:'GET',agent:false,family:4,signal,servername:'dns.alidns.com',lookup:(_host,options,callback)=>options.all?callback(null,[{address:ALIDNS_BOOTSTRAP,family:4}]):callback(null,ALIDNS_BOOTSTRAP,4),headers:{'Accept':'application/dns-json, application/json','Accept-Encoding':'identity','User-Agent':'LogiNote-Community-RSS/1.0'}},response=>{
        if(response.statusCode!==200){response.destroy();reject(failure());return;}
        if(response.headers['content-encoding']&&response.headers['content-encoding']!=='identity'||Number(response.headers['content-length'])>ALIDNS_RESPONSE_BYTES){response.destroy();reject(failure('feed_dns_size','DNS 响应过大或编码不受支持，已停止读取。'));return;}
        const chunks:Buffer[]=[];response.on('data',(chunk:Buffer)=>{received+=chunk.length;if(received>ALIDNS_RESPONSE_BYTES){response.destroy(failure('feed_dns_size','DNS 响应过大，已停止读取。'));return;}chunks.push(chunk);});response.on('end',()=>resolve(Buffer.concat(chunks)));response.on('error',reject);response.on('aborted',()=>reject(failure()));
      });request.on('error',()=>reject(signal.aborted?failure('feed_timeout','订阅读取已取消或超时。'):failure()));request.end();
    });
    return parseAliDnsAnswers(body,hostname);
  }finally{await settle(Math.min(received,ALIDNS_RESPONSE_BYTES));}
}
