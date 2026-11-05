import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,createHash} from 'node:crypto';
import {mkdtemp,rm} from 'node:fs/promises';
import path from 'node:path';
import type {AddressInfo} from 'node:net';
import type {MailMessage} from '../src/auth.js';
import {zipSync,strToU8} from 'fflate';
import {inspectSharedResource} from '../src/sceneResources.js';
import {inspectResource} from '../src/resourceFormat.js';
import {createCommunityServer} from '../src/http.js';
import {createTestDatabase} from './helpers.js';
import {sceneFiles,h5pFiles,sceneFixture,h5pFixture} from './sceneFixtures.js';

test('package inspection shares native format contracts, exposes inert metadata and never runs code',async()=>{
  const scene=await inspectSharedResource(sceneFixture(),'实验.ZIP','application/zip');assert.equal(scene.format,'scene-pack');assert.equal(scene.title,'向量变换实验');assert.equal(scene.scenePackage?.kind,'scene-pack');
  if(scene.scenePackage?.kind==='scene-pack'){assert.equal(scene.scenePackage.packageVersion,'1.0.0');assert.deepEqual(scene.scenePackage.requiredServices,['execution']);}
  const h5p=await inspectSharedResource(h5pFixture(),'练习.h5p','application/x-h5p');assert.equal(h5p.format,'h5p');if(h5p.scenePackage?.kind==='h5p')assert.deepEqual(h5p.scenePackage.missing,[]);
  assert.equal((globalThis as any).__communityPackageExecuted,undefined);assert.equal(JSON.stringify([scene,h5p]).includes('PACKAGE_CODE_MUST_NOT_RUN'),false);
  assert.equal(inspectResource(h5pFixture(),'练习.h5p','application/x-h5p').format,'file','browser preflight does not pretend to validate a package');
  const generic=zipSync({'manifest.json':strToU8('{"name":"ordinary data"}'),'report.txt':strToU8('普通资料')});assert.equal((await inspectSharedResource(generic,'普通资料.zip','application/zip')).format,'file');
  const nested=zipSync(Object.fromEntries(Object.entries(sceneFiles()).map(([name,data])=>['release/'+name,data])));assert.equal((await inspectSharedResource(nested,'嵌套.zip','application/zip')).format,'scene-pack');
  const material=strToU8('包内静态物料'),v2=sceneFiles(),manifest=JSON.parse(Buffer.from(v2['manifest.json']).toString());manifest.protocolVersion=2;manifest.materials=[{id:'example',label:'示例',path:'materials/example.txt',mediaType:'text/plain',bytes:material.length,sha256:createHash('sha256').update(material).digest('hex')}];v2['manifest.json']=strToU8(JSON.stringify(manifest));v2['materials/example.txt']=material;
  const v2Preview=await inspectSharedResource(zipSync(v2),'物料包.zip','application/zip');assert.equal(v2Preview.scenePackage?.kind==='scene-pack'&&v2Preview.scenePackage.materialCount,1);
  v2['materials/example.txt']=strToU8('改写后的物料');await assert.rejects(inspectSharedResource(zipSync(v2),'错物料.zip','application/zip'),/物料/);
});
test('invalid packages cannot downgrade to normal files or pass path, hash and expansion checks',async()=>{
  const missing=sceneFiles();delete missing['main.js'];await assert.rejects(inspectSharedResource(zipSync(missing),'缺文件.zip','application/zip'));
  await assert.rejects(inspectSharedResource(Buffer.from('not a zip'),'假包.h5p','application/octet-stream'));
  await assert.rejects(inspectSharedResource(zipSync({...h5pFiles(),'../escape.txt':strToU8('no')}),'越界.h5p','application/octet-stream'));
  await assert.rejects(inspectSharedResource(zipSync({...sceneFiles(),'MAIN.JS':strToU8('duplicate')}),'重名.zip','application/zip'));
  const corrupt=Buffer.from(zipSync(h5pFiles(),{level:0})),offset=corrupt.indexOf('SYNTHETIC_PAYLOAD_SENTINEL');assert.ok(offset>0);corrupt[offset]^=1;await assert.rejects(inspectSharedResource(corrupt,'损坏媒体.h5p','application/octet-stream'),/校验/);
  const large=zipSync({...sceneFiles(),'padding.bin':new Uint8Array(17*1024*1024)},{level:0});await assert.rejects(inspectSharedResource(large,'过大.zip','application/zip'),/16 MiB/);
  const incomplete=h5pFiles();delete incomplete['H5P.CommunitySynthetic-1.0/main.js'];const preview=await inspectSharedResource(zipSync(incomplete),'缺依赖.h5p','application/octet-stream');assert.equal(preview.format,'h5p');assert.ok(preview.scenePackage?.kind==='h5p'&&preview.scenePackage.missing.length>0);
});
test('scene files use real authenticated upload, server-derived metadata, original downloads and version permissions',async t=>{
  const fixture=await createTestDatabase('scene_resources'),directory=await mkdtemp(path.resolve('.ui-preview-scene-resource-')),mail:MailMessage[]=[],origin='http://127.0.0.1:5174';
  const api=createCommunityServer({db:fixture.db,config:{databaseUrl:fixture.url,encryptionKey:fixture.encryptionKey,host:'127.0.0.1',port:0,webOrigin:origin,allowedOrigins:[origin],secureCookies:false,dataDirectory:directory,globalStorageLimitBytes:1e9,globalDownloadLimitBytes:1e9,authProvider:'local'},mailer:{configured:true,async send(value){mail.push(value);return 'sent';}}});
  await new Promise<void>(resolve=>api.server.listen(0,'127.0.0.1',resolve));const base=`http://127.0.0.1:${(api.server.address() as AddressInfo).port}/api/community/v1`;
  type Who={cookie:string;csrf:string;id:string};
  const request=async(route:string,who?:Who,body?:unknown,method=body===undefined?'GET':'POST',headers:Record<string,string>={})=>{const response=await fetch(base+route,{method,headers:{Origin:origin,...(who?{Cookie:who.cookie,'X-CSRF-Token':who.csrf}:{}),'Idempotency-Key':randomUUID(),...(body!==undefined?{'Content-Type':'application/json'}:{}),...headers},body:body instanceof Uint8Array?Buffer.from(body):body===undefined?undefined:JSON.stringify(body)});return {status:response.status,headers:response.headers,...(response.headers.get('content-type')?.includes('application/json')?await response.json():{bytes:Buffer.from(await response.arrayBuffer())})} as any;};
  const account=async(label:string):Promise<Who>=>{const email=label+'@scene.test',created=await api.auth.register({email,password:'Scene resource synthetic 2026!',displayName:label});await api.auth.verifyEmail({token:mail.at(-1)!.token});const login=await api.auth.login({email,password:'Scene resource synthetic 2026!'});return {cookie:'loginote_community_session='+login.sessionToken,csrf:login.csrfToken,id:created.account.id};};
  const upload=async(who:Who,name:string,bytes:Buffer)=>{const stageId=(await request('/resource-stages',who,{})).value.stageId,intent=await request(`/resource-stages/${stageId}/files`,who,{name,mime:'application/octet-stream',bytes:bytes.length,role:'main'});assert.equal(intent.status,201,JSON.stringify(intent.error));const id=intent.value.attachmentId;assert.equal((await request(`/attachments/${id}/content`,who,bytes,'PUT',{'Content-Type':'application/octet-stream','X-Upload-Token':intent.value.uploadToken})).status,200);return {stageId,id};};
  const download=async(who:Who,id:string)=>{const grant=await request(`/attachments/${id}/download`,who,{});assert.equal(grant.status,200);return request(`/attachments/${id}/content`,who,undefined,'GET',{'X-Download-Token':grant.value.token});};
  try{
    const owner=await account('作者'),reader=await account('读者');
    for(const [name,bytes,format] of [['scene.zip',sceneFixture(),'scene-pack'],['exercise.h5p',h5pFixture(),'h5p']] as const){
      const staged=await upload(owner,name,bytes),url=`/resource-stages/${staged.stageId}/files/${staged.id}/inspection`;
      assert.equal((await request(url)).status,401);assert.equal((await request(url,reader)).status,403);const inspection=await request(url,owner);assert.equal(inspection.status,200);assert.equal(inspection.value.format,format);
      const published=await request('/entries',owner,{kind:'resource',title:inspection.value.title,body:'作者填写的用途说明',resourceType:'note',scope:'public',stageId:staged.stageId});assert.equal(published.status,201,JSON.stringify(published.error));const id=published.value.id;assert.equal(published.value.resourceType,'scene');
      const current=(await request(`/entries/${id}/versions`,reader)).value.current;assert.equal(current.preview.format,format);assert.equal(current.delivery.kind,'package');assert.equal(current.files[0].hash,createHash('sha256').update(bytes).digest('hex'));assert.equal(current.preview.scenePackage.kind,format);
      const result=await download(reader,staged.id);assert.equal(result.status,200);assert.equal(result.headers.get('content-type'),'application/octet-stream');assert.match(result.headers.get('content-disposition'),/^attachment/);assert.deepEqual(result.bytes,bytes);
      assert.equal((await request(`/entries/${id}/receive`,reader,{versionId:current.id})).error.code,'package_download_only');assert.equal((await request('/me/receipts',reader)).value.length,0);
      const comment=await request(`/entries/${id}/comments`,reader,{body:'这个版本的使用反馈'});assert.equal(comment.status,201);
      assert.equal((await request(`/entries/${id}`,owner,{title:'补充介绍',body:'新版说明，原包不变',topics:[]},'PUT')).status,200);const next=(await request(`/entries/${id}/versions`,reader)).value;assert.equal(next.versions.length,2);assert.equal(next.current.preview.format,format);assert.equal(next.current.preview.scenePackage.kind,format);assert.equal((await request(`/entries/${id}/comments`,reader)).value.items.length,1);assert.deepEqual((await download(reader,staged.id)).bytes,bytes);
      const oldGrant=(await request(`/attachments/${staged.id}/download`,reader,{})).value.token;await request(`/entries/${id}`,owner,undefined,'DELETE');assert.equal((await request(`/attachments/${staged.id}/content`,reader,undefined,'GET',{'X-Download-Token':oldGrant})).status,403);
      await request(`/entries/${id}/restore`,owner,{});assert.deepEqual((await download(reader,staged.id)).bytes,bytes);
    }
    const malformed=await upload(owner,'invalid.h5p',Buffer.from('not an archive'));assert.equal((await request(`/resource-stages/${malformed.stageId}/files/${malformed.id}/inspection`,owner)).status,400);
    const before=(await fixture.db.query('SELECT count(*)::int n FROM community_entries')).rows[0].n;assert.equal((await request('/entries',owner,{kind:'resource',body:'禁止绕过检查',stageId:malformed.stageId})).status,400);assert.equal((await fixture.db.query('SELECT count(*)::int n FROM community_entries')).rows[0].n,before);
    assert.equal((await request('/entries?view=public&kind=resource&resourceType=scene',reader)).value.items.length,2);
    assert.equal((globalThis as any).__communityPackageExecuted,undefined);
  }finally{api.server.closeAllConnections();await new Promise<void>(resolve=>api.server.close(()=>resolve()));await fixture.cleanup();await rm(directory,{recursive:true,force:true});}
});
