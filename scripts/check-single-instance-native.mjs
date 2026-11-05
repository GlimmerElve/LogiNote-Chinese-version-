import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { build, stop } from 'esbuild';
import { prepareElectronRuntime } from './start-electron.mjs';

// Real OS single-instance locks, synthetic HTML/windows and counters only.
// Never imports the production app or starts its Python/index/model services.
const parent = await fs.realpath('build');
const fixture = await fs.mkdtemp(path.join(parent, 'single-instance-native-'));
const eventsFile = path.join(fixture, 'events.jsonl');
await fs.writeFile(eventsFile, '');
const compiled = await build({ entryPoints: ['src/electron/singleInstance.ts'], bundle: true, write: false,
  platform: 'node', format: 'cjs', logLevel: 'silent' });
stop();
await fs.writeFile(path.join(fixture, 'single-instance.cjs'), compiled.outputFiles[0].contents);
const bootstrap = path.join(fixture, 'bootstrap.cjs');
await fs.writeFile(bootstrap, `
const fs=require('node:fs'),path=require('node:path'),{app,BrowserWindow}=require('electron');
const root=${JSON.stringify(fixture)},role=process.env.LOGINOTE_SINGLE_INSTANCE_TEST_ROLE;
if(!/^run-[0-9]+$/.test(role||''))throw Error('Invalid synthetic role');
app.setPath('userData',path.join(root,'isolated-profile'));
const log=(type,extra={})=>fs.appendFileSync(path.join(root,'events.jsonl'),JSON.stringify({type,role,pid:process.pid,...extra})+'\\n');
let window=null,requestedMinimize=false;
const instance=require('./single-instance.cjs').acquireSingleInstance({
 app:{requestSingleInstanceLock(){const primary=app.requestSingleInstanceLock();log('lock',{primary});return primary;},
 on(name,listener){return app.on(name,()=>{log(name);listener();});},exit:code=>app.exit(code)},
 getWindow:()=>window?{isDestroyed:()=>window.isDestroyed(),isMinimized:()=>window.isMinimized(),
 restore(){log('restore');window.restore();},show(){log('show');window.show();},focus(){log('focus');window.focus();}}:null
});
if(instance.primary){
 const safety=setTimeout(()=>app.exit(42),45000);
 const control=setInterval(()=>{if(fs.existsSync(path.join(root,'stop-'+role))){clearInterval(control);clearTimeout(safety);app.exit(0);}
 if(window&&!window.isDestroyed()&&!requestedMinimize&&fs.existsSync(path.join(root,'minimize-'+role))){requestedMinimize=true;window.minimize();}},20);
 app.whenReady().then(async()=>{if(!instance.primary)return;log('services-start');
 while(!fs.existsSync(path.join(root,'create-window')))await new Promise(resolve=>setTimeout(resolve,20));
 window=new BrowserWindow({show:false,width:400,height:200});window.on('minimize',()=>log('minimized'));window.on('restore',()=>log('restored'));
 await window.loadURL('data:text/html,<h1>Isolated single-instance acceptance</h1>');log('window-created');instance.windowReady();
 });
}
`);
const runtime = await prepareElectronRuntime();
const processes = [];
const launch = role => {
  const env = { ...process.env, LOGINOTE_SINGLE_INSTANCE_TEST_ROLE: role }; delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(runtime, [bootstrap], { env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  child.stdout.on('data', value => { output += value; }); child.stderr.on('data', value => { output += value; });
  const exited = new Promise((resolve, reject) => { child.once('error', reject); child.once('close', code => resolve(code)); });
  const owned = { child, exited, role, output: () => output }; processes.push(owned); return owned;
};
const events = async () => (await fs.readFile(eventsFile, 'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse);
const wait = async (test, message) => {
  for (let i = 0; i < 200; i++) { const current = await events(); if (test(current)) return current; await new Promise(resolve => setTimeout(resolve, 50)); }
  throw new Error(message);
};
const exit = async owned => {
  let timer;
  try { return await Promise.race([owned.exited, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(owned.role + ' did not exit')), 15_000); })]); }
  finally { clearTimeout(timer); }
};
let passed = false;
try {
  const primary = launch('run-1');
  await wait(rows => rows.some(row => row.role === 'run-1' && row.type === 'services-start'), 'Primary did not initialize');
  const newcomers = [launch('run-2'), launch('run-3')];
  assert.deepEqual(await Promise.all(newcomers.map(exit)), [0, 0]);
  await wait(rows => rows.filter(row => row.type === 'second-instance').length >= 2, 'Primary did not receive early duplicates');
  let rows = await events();
  assert.equal(rows.filter(row => row.type === 'services-start').length, 1);
  assert.equal(rows.filter(row => row.type === 'lock' && row.primary === false).length, 2);
  await fs.writeFile(path.join(fixture, 'create-window'), '');
  rows = await wait(current => current.some(row => row.type === 'focus'), 'Early duplicate was not replayed after window creation');
  assert.deepEqual(rows.filter(row => ['show', 'focus', 'restore'].includes(row.type)).map(row => row.type), ['show', 'focus']);
  await fs.writeFile(path.join(fixture, 'minimize-run-1'), '');
  await wait(current => current.some(row => row.type === 'minimized'), 'Synthetic primary did not minimize');
  assert.equal(await exit(launch('run-4')), 0);
  rows = await wait(current => current.some(row => row.type === 'restored') && current.filter(row => row.type === 'focus').length === 2,
    'Repeated launch did not restore and refocus the original window');
  assert.deepEqual(rows.filter(row => ['show', 'focus', 'restore'].includes(row.type)).map(row => row.type), ['show', 'focus', 'restore', 'show', 'focus']);
  assert.equal(rows.filter(row => row.type === 'services-start').length, 1);
  await fs.writeFile(path.join(fixture, 'stop-run-1'), ''); assert.equal(await exit(primary), 0);
  const restarted = launch('run-5');
  rows = await wait(current => current.some(row => row.role === 'run-5' && row.type === 'window-created'), 'Lock was not released after a normal process exit');
  assert.equal(rows.find(row => row.role === 'run-5' && row.type === 'lock').primary, true);
  assert.equal(rows.filter(row => row.type === 'services-start').length, 2);
  await fs.writeFile(path.join(fixture, 'stop-run-5'), ''); assert.equal(await exit(restarted), 0);
  const proof = { ok: true, duplicateStartsRejected: 3, primaryInitializationsPerLifetime: 1,
    earlySignalsCoalesced: true, minimizedWindowRestored: true, restartLockReleased: true,
    productionAppStarted: false, networkCalls: 0, events: await events() };
  const evidence = path.resolve('output/single-instance-native'); await fs.mkdir(evidence, { recursive: true });
  await fs.writeFile(path.join(evidence, 'latest.json'), JSON.stringify(proof, null, 2));
  console.log('PASS real Electron locks: three duplicate processes exit 0, one initialization, early signals coalesce, minimized window restores, exit releases lock for restart. No production app, private vault or model services opened.');
  passed = true;
} finally {
  for (const owned of processes) if (owned.child.exitCode === null) owned.child.kill();
  await Promise.allSettled(processes.map(owned => owned.exited));
  if (passed && path.dirname(await fs.realpath(fixture)) === parent && !(await fs.lstat(fixture)).isSymbolicLink()) {
    await fs.rm(fixture, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  } else if (!passed) console.error(`Acceptance evidence retained at ${fixture}`);
}
