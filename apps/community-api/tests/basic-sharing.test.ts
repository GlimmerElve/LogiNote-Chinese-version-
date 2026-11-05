import test from 'node:test';
import assert from 'node:assert/strict';
import {basicResourceDelivery,publicResourceUrl} from '../src/basicSharing.js';
import {inspectResource} from '../src/resourceFormat.js';

test('basic links preserve public HTTP(S) addresses and reject local paths, credentials and executable schemes',()=>{
  assert.equal(publicResourceUrl('https://example.org/read?q=matrix'),'https://example.org/read?q=matrix');
  for(const value of ['javascript:alert(1)','data:text/html,unsafe','file:///C:/private','https://user:secret@example.org/','http://127.0.0.1/','http://2130706433/','http://10.1.2.3/','http://localhost/','http://[::1]/','https://example.org/\npath'])assert.equal(publicResourceUrl(value),null,value);
  assert.equal(inspectResource(new TextEncoder().encode('阅读 https://example.org/material'),'正文.md','text/markdown').format,'markdown');
  for(const body of ['C:/private/file','路径 D:\\private\\file','file:///private'])assert.throws(()=>inspectResource(new TextEncoder().encode(body),'正文.md','text/markdown'));
});

test('basic delivery separates single readonly content, material files and original video links from preserved complex packages',()=>{
  const base={body:'只读正文',preview:{format:'markdown'},files:[]};
  assert.equal(basicResourceDelivery(base).kind,'snapshot');
  assert.deepEqual(basicResourceDelivery({...base,body:'https://www.bilibili.com/video/BVfixture'}),{kind:'video-link',url:'https://www.bilibili.com/video/BVfixture'});
  assert.equal(basicResourceDelivery({...base,preview:{format:'pdf'},files:[{name:'file.pdf',role:'main'}]}).kind,'file');
  assert.equal(basicResourceDelivery({...base,preview:{format:'notes'}}).kind,'unsupported');
  assert.equal(basicResourceDelivery({...base,files:[{name:'plan.lnresource',role:'main'}]}).kind,'unsupported');
  assert.equal(basicResourceDelivery({...base,files:[{name:'clip.mp4',role:'main'}]}).kind,'unsupported');
  assert.equal(basicResourceDelivery({...base,preview:{format:'file'},files:[{name:'opaque.zip',role:'main'}]}).kind,'file');
});
