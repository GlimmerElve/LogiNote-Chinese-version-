import {lookup} from 'node:dns/promises';
import https from 'node:https';
import type {NewsSourcePreset} from './newsFeed.js';
import {NEWS_FEED_LIMITS} from './newsFeed.js';
import {ApiError} from './errors.js';
import {publicFeedAddress,resolveAliDns,type NewsFeedDnsMode} from './newsFeedDns.js';
export {publicFeedAddress} from './newsFeedDns.js';

export interface NewsFeedFetchOptions {
  etag?:string|null;lastModified?:string|null;signal:AbortSignal;
  /** Durable budget is acquired before *each* request, including redirects. */
  reserve:()=>Promise<(actualBytes:number)=>Promise<void>>;
}
export type NewsFeedResponse={status:number;body:Buffer;etag:string|null;lastModified:string|null};
export type NewsFeedFetcher=(source:NewsSourcePreset,options:NewsFeedFetchOptions)=>Promise<NewsFeedResponse>;
const failure=(code:string,message:string)=>new ApiError(502,code,message);
export function assertFeedTarget(value:string,source:NewsSourcePreset):URL {
  let url:URL;try{url=new URL(value);}catch{throw failure('feed_destination','订阅目标地址不正确。');}
  if(url!.protocol!=='https:'||url!.username||url!.password||url!.port&&url!.port!=='443'||!(source.hosts as readonly string[]).includes(url!.hostname)||url!.hash)throw failure('feed_destination','订阅重定向目标不在允许的原站范围内。');
  return url!;
}
const header=(value:string|string[]|undefined)=>typeof value==='string'&&value.length<=512&&!/[\r\n]/.test(value)?value:null;
export function createNewsFeedFetcher(mode:NewsFeedDnsMode='system'):NewsFeedFetcher {
  if(!['system','alidns'].includes(mode))throw new Error('Unsupported RSS DNS mode');
  return async(source,options)=>{
  // This uses Node HTTPS directly: no proxy variables, ambient browser cookies,
  // bearer credentials, JavaScript rendering or arbitrary article fetching.
  const timeout=AbortSignal.timeout(15000),signal=AbortSignal.any([timeout,options.signal]);let target:string=source.url;
  for(let redirects=0;redirects<=2;redirects++){
    if(signal.aborted)throw failure('feed_timeout','订阅读取已取消或超时。');
    const url=assertFeedTarget(target,source);let addresses:{address:string;family:number}[];
    try{addresses=mode==='alidns'?await resolveAliDns(url.hostname,options,signal):await Promise.race([lookup(url.hostname,{all:true,verbatim:true}),new Promise<never>((_,reject)=>{signal.addEventListener('abort',()=>reject(failure('feed_timeout','订阅读取已取消或超时。')),{once:true});})]);}catch(error){if(error instanceof ApiError)throw error;throw failure('feed_network','暂时无法解析订阅原站，请稍后重试。');}
    if(!addresses.length||addresses.some(item=>!publicFeedAddress(item.address)))throw failure('feed_destination','订阅原站解析到了不允许访问的网络地址。');
    const selected=addresses.find(item=>item.family===4)||addresses[0],settle=await options.reserve();let received=0;
    try{
      const response=await new Promise<{status:number;body:Buffer;location?:string;etag:string|null;lastModified:string|null}>((resolve,reject)=>{
        const request=https.request(url,{method:'GET',agent:false,signal,family:selected.family,lookup:(_hostname,options,callback)=>options.all?callback(null,[selected]):callback(null,selected.address,selected.family),headers:{'User-Agent':'LogiNote-Community-RSS/1.0','Accept':'application/rss+xml, application/atom+xml, application/xml, text/xml;q=0.9','Accept-Encoding':'identity',...(options.etag?{'If-None-Match':options.etag}:{}),...(options.lastModified?{'If-Modified-Since':options.lastModified}:{})}},res=>{
          const status=res.statusCode||0,redirect=[301,302,303,307,308].includes(status);
          if(redirect){const location=header(res.headers.location);res.destroy();resolve({status,body:Buffer.alloc(0),location:location||undefined,etag:null,lastModified:null});return;}
          if(status===304){res.destroy();resolve({status,body:Buffer.alloc(0),etag:header(res.headers.etag),lastModified:header(res.headers['last-modified'])});return;}
          if(status!==200){res.destroy();reject(failure('feed_http','订阅原站暂时无法提供内容，请稍后重试。'));return;}
          if(res.headers['content-encoding']&&res.headers['content-encoding']!=='identity'||String(res.headers['content-type']||'').includes('text/html')){res.destroy();reject(failure('feed_format','原站未返回可读取的 XML 订阅。'));return;}
          if(Number(res.headers['content-length'])>NEWS_FEED_LIMITS.maxFeedBytes){res.destroy();reject(failure('feed_size','订阅响应超过 2 MB，已停止读取。'));return;}
          const chunks:Buffer[]=[];res.on('data',(chunk:Buffer)=>{received+=chunk.length;if(received>NEWS_FEED_LIMITS.maxFeedBytes){res.destroy(failure('feed_size','订阅响应超过 2 MB，已停止读取。'));return;}chunks.push(chunk);});res.on('end',()=>resolve({status,body:Buffer.concat(chunks),etag:header(res.headers.etag),lastModified:header(res.headers['last-modified'])}));res.on('error',reject);res.on('aborted',()=>reject(failure('feed_network','订阅读取中断，请稍后重试。')));
        });request.on('error',()=>reject(failure(signal.aborted?'feed_timeout':'feed_network',signal.aborted?'订阅读取已取消或超时。':'暂时无法连接订阅原站，请稍后重试。')));request.end();
      });
      if([301,302,303,307,308].includes(response.status)){
        if(redirects===2||!response.location)throw failure('feed_redirect','订阅原站重定向次数过多或缺少目标。');target=assertFeedTarget(new URL(response.location,url).href,source).href;continue;
      }
      return {status:response.status,body:response.body,etag:response.etag,lastModified:response.lastModified};
    }finally{await settle(Math.min(received,NEWS_FEED_LIMITS.maxFeedBytes));}
  }
  throw failure('feed_redirect','订阅原站重定向次数过多。');
  };
}
export const fetchNewsFeed:NewsFeedFetcher=createNewsFeedFetcher('system');
