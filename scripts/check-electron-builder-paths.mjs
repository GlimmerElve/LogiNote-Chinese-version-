import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {createRequire} from 'node:module';
import {spawn} from 'node:child_process';

const require=createRequire(import.meta.url);
const {executeAppBuilder}=require('builder-util');
// Use the real, large flattened dependency JSON: it crosses output-chunk
// boundaries inside Chinese project paths with the affected builder version.
const raw=await executeAppBuilder(['node-dep-tree','--dir',process.cwd(),'--flatten']);
assert.equal(raw.includes('\uFFFD'),false,'A dependency path was corrupted while decoding app-builder output');
const dependencies=JSON.parse(raw);
for(const dependency of dependencies)assert.ok((await fs.stat(dependency.dir)).isDirectory(),dependency.dir);
assert.ok(dependencies.some(dependency=>dependency.name==='mdast-util-to-markdown'));

// The compatibility hook must leave unrelated/binary subprocess streams alone.
const child=spawn(process.execPath,['-e','process.stdout.write(Buffer.from([0,128,255]))'],{windowsHide:true,stdio:['ignore','pipe','pipe']});
const chunks=[];child.stdout.on('data',chunk=>{assert.ok(Buffer.isBuffer(chunk));chunks.push(chunk);});
await new Promise((resolve,reject)=>{child.once('error',reject);child.once('close',code=>code===0?resolve():reject(Error('Binary subprocess failed: '+code)));});
assert.deepEqual(Buffer.concat(chunks),Buffer.from([0,128,255]));
console.log(`PASS ${dependencies.length} real dependency directories preserve Unicode; unrelated binary stdout is unchanged.`);
