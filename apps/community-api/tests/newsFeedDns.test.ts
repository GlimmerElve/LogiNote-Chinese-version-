import test from 'node:test';
import assert from 'node:assert/strict';
import https from 'node:https';
import {EventEmitter} from 'node:events';
import {Readable} from 'node:stream';
import {parseAliDnsAnswers,resolveAliDns,ALIDNS_RESPONSE_BYTES} from '../src/newsFeedDns.js';
import {createNewsFeedFetcher} from '../src/newsFeedFetch.js';
import {NEWS_SOURCE_PRESETS} from '../src/newsFeed.js';
import {ApiError} from '../src/errors.js';
const hostname='www.ruanyifeng.com';
const answer=(data='114.114.114.114')=>({Status:0,TC:false,Question:{name:hostname+'.',type:1},Answer:[{name:hostname+'.',type:5,data:'origin.cdn.example.'},{name:'origin.cdn.example.',type:1,data}]});
test('AliDNS response validation preserves exact query and public A-only CNAME chains',()=>{
  assert.deepEqual(parseAliDnsAnswers(Buffer.from(JSON.stringify(answer())),hostname),[{address:'114.114.114.114',family:4}]);
  const list=answer() as any;list.Question=[list.Question];list.Answer.push({...list.Answer[1]});assert.equal(parseAliDnsAnswers(Buffer.from(JSON.stringify(list)),hostname).length,1);
  for(const data of ['198.18.0.1','127.0.0.1','169.254.169.254','192.168.0.1','::ffff:8.8.8.8','8.8.8.8 extra'])assert.throws(()=>parseAliDnsAnswers(Buffer.from(JSON.stringify(answer(data))),hostname),ApiError);
  const invalid:any[]=[{...answer(),Status:3},{...answer(),TC:true},{...answer(),Question:{name:'other.example.',type:1}},{...answer(),Answer:[]},{...answer(),Answer:[{name:hostname,type:28,data:'2606:4700:4700::1111'}]},{...answer(),Answer:[{name:'unrelated.example.',type:1,data:'8.8.8.8'}]},{...answer(),Answer:[...answer().Answer,{name:hostname,type:1,data:'10.0.0.1'}]},{...answer(),Answer:Array.from({length:65},()=>answer().Answer[1])}];
  for(const value of invalid)assert.throws(()=>parseAliDnsAnswers(Buffer.from(JSON.stringify(value)),hostname),ApiError);
  assert.throws(()=>parseAliDnsAnswers(Buffer.alloc(ALIDNS_RESPONSE_BYTES+1),hostname),ApiError);assert.throws(()=>parseAliDnsAnswers(Buffer.from('{bad json'),hostname),ApiError);
});
test('optional AliDNS uses pinned verified HTTPS, charges DNS plus feed, and never follows DNS redirects',async t=>{
  const dnsBody=Buffer.from(JSON.stringify(answer())),feedBody=Buffer.from('<rss><channel><item><title>Safe</title><link>https://example.org/one</link></item></channel></rss>'),requests:{url:URL;options:any}[]=[];let dnsStatus=200,dnsPayload=dnsBody;
  t.mock.method(https,'request',((url:URL,options:any,callback:(response:any)=>void)=>{
    requests.push({url,options});const request=new EventEmitter() as EventEmitter&{end:()=>void};request.end=()=>{queueMicrotask(()=>{const dns=url.hostname==='dns.alidns.com',response=Readable.from([dns?dnsPayload:feedBody]) as Readable&{statusCode:number;headers:Record<string,string>};response.statusCode=dns?dnsStatus:200;response.headers={'content-type':dns?'application/json':'application/xml',...(dnsStatus===302?{location:'https://evil.example/resolve'}:{})};callback(response);});};return request;
  }) as any);
  let reserved=0;const settled:number[]=[],controller=new AbortController(),options={signal:controller.signal,reserve:async()=>{reserved++;return async(bytes:number)=>{settled.push(bytes);};}};
  const response=await createNewsFeedFetcher('alidns')(NEWS_SOURCE_PRESETS[0],options);assert.equal(response.status,200);assert.deepEqual(response.body,feedBody);assert.equal(reserved,2);assert.deepEqual(settled,[dnsBody.length,feedBody.length]);assert.equal(requests.length,2);const dns=requests[0];assert.equal(dns.url.href,'https://dns.alidns.com/resolve?name=www.ruanyifeng.com&type=A');assert.equal(dns.options.servername,'dns.alidns.com');assert.notEqual(dns.options.rejectUnauthorized,false);assert.equal(dns.options.headers.Authorization,undefined);assert.equal(dns.options.headers.Cookie,undefined);dns.options.lookup('dns.alidns.com',{},(_error:unknown,address:string,family:number)=>{assert.equal(address,'223.5.5.5');assert.equal(family,4);});requests[1].options.lookup(hostname,{},(_error:unknown,address:string)=>assert.equal(address,'114.114.114.114'));
  dnsStatus=302;const before=requests.length;await assert.rejects(resolveAliDns(hostname,options,controller.signal),ApiError);assert.equal(requests.length,before+1);assert.equal(settled.at(-1),0);
  dnsStatus=200;dnsPayload=Buffer.alloc(ALIDNS_RESPONSE_BYTES+1);await assert.rejects(resolveAliDns(hostname,options,controller.signal),ApiError);assert.equal(settled.at(-1),ALIDNS_RESPONSE_BYTES);
  const prior=reserved;await assert.rejects(resolveAliDns('evil.example',options,controller.signal),{code:'feed_destination'});assert.equal(reserved,prior);controller.abort();await assert.rejects(resolveAliDns(hostname,options,controller.signal),{code:'feed_timeout'});assert.equal(reserved,prior);
});
