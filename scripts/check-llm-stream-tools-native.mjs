// Production main/preload and built renderer; only supplier fetch is synthetic.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { spawn, execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { electronFiles } from './build-electron.mjs';
import { prepareElectronRuntime } from './start-electron.mjs';

const { chromium } = createRequire(path.join(process.env.LOGINOTE_BROWSER_MODULES || process.env.LOGINOTE_PLAYWRIGHT_MODULES || path.join(os.homedir(), '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules'), 'stream-tools-native.cjs'))('playwright');
const plotNotation = process.argv.includes('--plot-notation');
await fsp.mkdir('build', { recursive: true }); const root = await fsp.mkdtemp(path.resolve('build/llm-stream-tools-native-'));
const appRoot = path.join(root, 'app'), state = path.join(root, 'state');
for (const dir of ['app/dist-electron', 'state/vault/notes', 'state/user-state']) await fsp.mkdir(path.join(root, dir), { recursive: true });
const provider = { id: 'stream-tools-native', name: 'Synthetic GLM', apiType: 'openai-compatible', baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
  apiKey: '', selectedModel: 'glm-5.3', models: ['glm-5.3'], enabled: true, createdAt: '' };
await fsp.writeFile(path.join(state, 'vault/metadata.json'), JSON.stringify({ version: 1, notesMeta: {} }));
await fsp.writeFile(path.join(state, 'user-state/user-state.json'), JSON.stringify({ version: 1, noteStates: {} }));
await fsp.writeFile(path.join(state, 'user-state/settings.json'), JSON.stringify({ version: 1, appSettings: { theme: 'light', accentColor: 'emerald', localOnly: true, cloudSyncEnabled: false, autoAiSegment: false } }));
await fsp.writeFile(path.join(state, 'user-state/llm.json'), JSON.stringify({ version: 1, settings: { providers: [provider], defaultProviderId: provider.id, workflowBinding: {} } }));
await fsp.writeFile(path.join(appRoot, 'package.json'), JSON.stringify({ name: 'stream-tools-native-check', version: '1.0.0' }));
await fsp.symlink(path.resolve('dist'), path.join(appRoot, 'dist'), 'junction');
await fsp.symlink(path.resolve('python'), path.join(appRoot, 'python'), 'junction');
const nativeFiles = new Map(await Promise.all(electronFiles.map(async name => [name, await fsp.readFile(path.resolve('dist-electron', name))])));
for (const [name, buffer] of nativeFiles) await fsp.writeFile(path.join(appRoot, 'dist-electron', name), name === 'preload.cjs'
  ? Buffer.concat([buffer, Buffer.from("\nrequire('electron').contextBridge.exposeInMainWorld('streamToolsNative',{command:input=>require('electron').ipcRenderer.invoke('stream-tools-native:command',input),inspect:file=>require('electron').ipcRenderer.invoke('stream-tools-native:offline-plot',file)});\n")]) : buffer);
const bootstrap = path.join(root, 'bootstrap.cjs'), eventsFile = path.join(root, 'events.jsonl'); await fsp.writeFile(eventsFile, '');
await fsp.writeFile(bootstrap, `const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {app,ipcMain,dialog,utilityProcess}=require('electron');const {EventEmitter}=require('node:events');
const root=${JSON.stringify(root)},secret='NATIVE_STREAM_REASONING_MAIN_ONLY_3819',runs=[];
const log=event=>fs.appendFileSync(path.join(root,'events.jsonl'),JSON.stringify(event)+'\\n');
const fatal=(phase,error)=>{log({phase,message:error?.message||String(error),stack:error?.stack||String(error)});process.exit(1)};
process.prependListener('uncaughtException',error=>fatal('main-error',error));process.prependListener('unhandledRejection',error=>fatal('main-error',error));dialog.showErrorBox=(title,body)=>fatal('dialog-error',Error(title+' '+body));
utilityProcess.fork=()=>{const worker=new EventEmitter();worker.postMessage=message=>setImmediate(()=>worker.emit('message',{id:message.id,ok:true,value:[]}));worker.kill=()=>{setImmediate(()=>worker.emit('exit',0));return true};return worker};
const inspectOffline=async file=>{file=path.resolve(file);assert.ok(file.startsWith(root+path.sep));const {BrowserWindow}=require('electron'),win=new BrowserWindow({show:false,width:1000,height:700,webPreferences:{sandbox:true,nodeIntegration:false,contextIsolation:true}});try{await win.loadFile(file);const result=await win.webContents.executeJavaScript("(async()=>{const images=[...document.images];await Promise.all(images.map(image=>image.decode()));return{images:images.length,failed:images.filter(image=>!image.naturalWidth).length,scripts:document.scripts.length,externalImages:images.filter(image=>!image.src.startsWith('data:')).length}})()");fs.writeFileSync(path.join(root,'polynomial-offline.png'),(await win.webContents.capturePage()).toPNG());return result}finally{win.destroy()}};
ipcMain.handle('stream-tools-native:offline-plot',(_event,file)=>inspectOffline(file));
globalThis.fetch=async(url,init)=>{assert.equal(String(url),'https://open.bigmodel.cn/api/paas/v4/chat/completions');const body=JSON.parse(init.body);assert.equal(body.stream,true);assert.equal(body.thinking?.type,'enabled');assert.equal(body.reasoning_effort,'max');assert.equal(body.max_tokens,10240);let output;const index=runs.length;const stream=new ReadableStream({start(controller){output=controller;init.signal.addEventListener('abort',()=>{log({phase:'abort',index});try{controller.error(new DOMException('Aborted','AbortError'))}catch{}},{once:true})}});runs.push({body,output,signal:init.signal});log({phase:'http',index,body});return new Response(stream,{headers:{'Content-Type':'text/event-stream'}})};
const send=(index,delta,finish)=>{const run=runs[index];assert.ok(run&&!run.signal.aborted);run.output.enqueue(new TextEncoder().encode('data: '+JSON.stringify({model:'glm-5.3',choices:[{delta,...(finish?{finish_reason:finish}:{})}]})+'\\n\\n'))};
ipcMain.handle('stream-tools-native:command',async(_event,input)=>{if(input.op==='exit'){setTimeout(()=>app.exit(0),30);return true}const index=input.index??runs.length-1;if(input.op==='tools'){send(index,{reasoning_content:secret});send(index,{content:'Synthetic tool preface.'});send(index,{tool_calls:[{index:0,id:'native-call',type:'function',function:{name:'read_synthetic_',arguments:'{"id":'}}]});send(index,{tool_calls:[{index:0,function:{name:'material',arguments:'"native-fixture"}'}}]});send(index,{},'tool_calls');runs[index].output.enqueue(new TextEncoder().encode('data: [DONE]\\n\\n'));runs[index].output.close();return true}if(input.op==='final'){send(index,{reasoning_content:secret+'_final'});send(index,{content:'Grounded final response.'},'stop');runs[index].output.enqueue(new TextEncoder().encode('data: [DONE]\\n\\n'));runs[index].output.close();return true}if(input.op==='partial'){send(index,{content:'Saved prefix.'});send(index,{tool_calls:[{index:0,id:'incomplete',type:'function',function:{name:'read_synthetic_material',arguments:'{"id":'}}]});return true}return false});
require(${JSON.stringify(path.resolve('scripts/note-save-native-bootstrap.cjs'))});`);
const renderer = (await fsp.readFile('dist/index.html', 'utf8')).match(/src="\.\/assets\/(main-[^"/]+\.js)"/u)?.[1];
assert.ok(renderer);
const hash = buffer => createHash('sha256').update(buffer).digest('hex');
const proof = { passed: false, root, checks: [], errors: [], realModelRequests: 0, networkCalls: 0,
  renderer: { entry: renderer, sha256: hash(await fsp.readFile(path.join('dist/assets', renderer))) }, nativeSha256: Object.fromEntries([...nativeFiles].map(([name, buffer]) => [name, hash(buffer)])) };
const executable = await prepareElectronRuntime(); const outputFile = path.join(root, 'process.log'); const fd = fs.openSync(outputFile, 'w');
const env = { ...process.env, LOGINOTE_SAVE_NATIVE_ROOT: root, SAVE_NATIVE_REAL_DIALOG: 'auto' }; delete env.ELECTRON_RUN_AS_NODE; delete env.NODE_OPTIONS;
const child = spawn(executable, [bootstrap, '--remote-debugging-port=0'], { cwd: process.cwd(), env, windowsHide: true, stdio: ['ignore', fd, fd] });
const exited = new Promise(resolve => child.once('exit', (code, signal) => resolve({ code, signal })));
let browser, page;
const pause = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
async function until(read, accepts, label, milliseconds = 30000) { const deadline = Date.now() + milliseconds; let value; while (Date.now() < deadline) { value = await read(); if (accepts(value)) return value; if (child.exitCode !== null) throw Error('Native exited: ' + (await fsp.readFile(outputFile, 'utf8')).slice(-2500)); await pause(50); } throw Error(label + ': ' + JSON.stringify(value)); }
const events = async () => (await fsp.readFile(eventsFile, 'utf8')).split('\n').filter(Boolean).map(line => JSON.parse(line));
const http = async () => (await events()).filter(event => event.phase === 'http');
const nativeState = async () => page.evaluate(() => { const state = window.__streamToolsState; return { id: state?.id, chunks: state?.chunks || [], done: state?.done, errors: state?.errors || [] }; });
async function start(request) { await page.evaluate(async input => {
  const state = window.__streamToolsState = { id: null, chunks: [], done: false, errors: [] }, api = window.electronAPI.llm;
  let release = () => {};
  const offChunk = api.onChunk(value => { if (value.streamId === state.id) state.chunks.push(value.chunk); });
  const offEnd = api.onEnd(value => { if (value.streamId === state.id) { state.done = true; release(); } });
  const offError = api.onError(value => { if (value.streamId === state.id) { state.errors.push(value); state.done = true; release(); } });
  release = () => { offChunk(); offEnd(); offError(); }; state.id = await api.stream(input);
}, request); }
const command = input => page.evaluate(value => window.streamToolsNative.command(value), input);
try {
  const endpoint = await until(async () => (await fsp.readFile(outputFile, 'utf8')).match(/DevTools listening on (ws:\/\/[^\s]+)/u)?.[1], Boolean, 'native startup', 45000);
  browser = await chromium.connectOverCDP(endpoint); page = browser.contexts()[0].pages()[0]; page.on('pageerror', error => proof.errors.push(error.message));
  await page.waitForFunction(() => Boolean(window.electronAPI?.llm && window.streamToolsNative), null, { timeout: 45000 });
  const tool = { name: 'read_synthetic_material', description: 'Read fixture only.', parameters: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] } };
  const request = { provider, systemPrompt: 'Synthetic stream tools.', userInput: 'Current request.', temperature: 0.2, maxTokens: 2048, thinkingMode: 'disabled', thinkingPreference: 'high',
    outputSchema: { type: 'object' }, includeActivity: true, tools: [tool], messages: [{ role: 'user', content: 'Earlier question.' }, { role: 'assistant', content: 'Earlier answer.' }] };
  await start(request); await until(http, rows => rows.length === 1, 'first actual request'); await command({ op: 'tools', index: 0 });
  const first = await until(nativeState, value => value.done, 'tool completion');
  assert.equal(first.errors.length, 0); const toolPacket = first.chunks.find(chunk => chunk.type === 'response');
  assert.deepEqual(toolPacket?.toolCalls, [{ id: 'native-call', name: tool.name, arguments: { id: 'native-fixture' } }]); assert.ok(toolPacket.toolContinuationId);
  assert.equal(first.chunks.filter(chunk => chunk.type === 'response').length, 1); assert.ok(!JSON.stringify(first).includes('NATIVE_STREAM_REASONING'));
  const firstHttp = (await http())[0].body; assert.deepEqual(firstHttp.messages.slice(1).map(message => message.content), ['Earlier question.', 'Earlier answer.', 'Current request.']);
  assert.equal(firstHttp.tools[0].function.name, tool.name); assert.equal(firstHttp.tool_choice, 'auto'); assert.deepEqual(firstHttp.response_format, { type: 'json_object' });
  proof.checks.push('Actual main/preload forwards history and tools; fragmented tools return once as complete structured metadata, not prose');
  await start({ ...request, agentMessages: [{ role: 'user', content: 'Current request.' }, { role: 'assistant', content: 'Synthetic tool preface.', toolCalls: toolPacket.toolCalls, toolContinuationId: toolPacket.toolContinuationId },
    { role: 'tool', content: 'Actual native fixture result.', toolCallId: 'native-call', toolName: tool.name }] });
  await until(http, rows => rows.length === 2, 'second actual request'); await command({ op: 'final', index: 1 });
  const final = await until(nativeState, value => value.done, 'final completion'); assert.equal(final.errors.length, 0);
  assert.equal((await http())[1].body.messages.find(message => message.role === 'assistant').reasoning_content, 'NATIVE_STREAM_REASONING_MAIN_ONLY_3819');
  assert.equal(final.chunks.filter(chunk => chunk.type === 'content').map(chunk => chunk.text).join(''), 'Grounded final response.');
  assert.ok(final.chunks.find(chunk => chunk.type === 'response')?.toolContinuationId); assert.ok(!JSON.stringify(final).includes('NATIVE_STREAM_REASONING'));
  proof.checks.push('The real main stream handler supplies window ownership: opaque reasoning continuation works on the next request while raw reasoning never crosses IPC');
  await start(request); await until(http, rows => rows.length === 3, 'third actual request'); await command({ op: 'partial', index: 2 });
  await until(nativeState, value => value.chunks.some(chunk => chunk.type === 'content'), 'partial prose');
  const id = (await nativeState()).id; await page.evaluate(value => window.electronAPI.llm.cancel(value), id);
  const cancelled = await until(nativeState, value => value.done, 'cancelled stream');
  assert.ok(cancelled.errors.some(error => error.cancelled)); assert.ok(!cancelled.chunks.some(chunk => chunk.type === 'response'));
  await until(events, rows => rows.some(event => event.phase === 'abort' && event.index === 2), 'actual transport abort');
  proof.checks.push('Actual preload cancellation aborts the supplier transport and never publishes incomplete tool arguments');
  if (plotNotation) {
    const code = (await fsp.readFile('scripts/fixtures/function-plot-notation.json', 'utf8')).trim();
    const rendered = await page.evaluate(input => window.electronAPI.mermaid.render({ id: 'notation-polynomial', requestId: 'notation-polynomial-request',
      visualKind: 'function-plot', width: 800, dark: false, code: input }), code);
    assert.ok(rendered.svg.length > 1000 && rendered.svg.includes('<path'));
    const svgFile = path.join(root, 'polynomial.svg'); await fsp.writeFile(svgFile, rendered.svg);
    await fsp.writeFile(path.join(root, 'plot-export.log'), execFileSync(process.execPath,
      ['scripts/run-tsx-safe.cjs', 'scripts/check-function-plot-notation.ts', '--svg', svgFile], { cwd: process.cwd(), encoding: 'utf8', windowsHide: true }));
    const exported = JSON.parse(await fsp.readFile(path.join(root, 'function-plot-result.json'), 'utf8'));
    assert.ok(exported.passed && exported.nativeSvgExported);
    proof.offlinePlot = await page.evaluate(file => window.streamToolsNative.inspect(file), path.join(root, 'polynomial-offline.html'));
    assert.deepEqual(proof.offlinePlot, { images: 1, failed: 0, scripts: 0, externalImages: 0 });
    proof.checks.push('The exact provided implicit-multiplication polynomial renders in the actual isolated drawing process and its production HTML export reopens offline with one decoded SVG and no scripts or external images');
  }
  await page.screenshot({ path: path.join(root, 'desktop.png') });
  await command({ op: 'exit' }); proof.exit = await exited; assert.equal(proof.exit.code, 0); await browser.close().catch(() => {}); browser = undefined;
  assert.deepEqual(proof.errors, []); assert.ok(!(await events()).some(event => event.phase === 'main-error' || event.phase === 'dialog-error'));
  proof.httpFixtures = (await http()).length;
  proof.buildIdentity = { rendererUnchanged: hash(await fsp.readFile(path.join('dist/assets', renderer))) === proof.renderer.sha256,
    electronUnchanged: (await Promise.all([...nativeFiles].map(async ([name, buffer]) => hash(await fsp.readFile(path.resolve('dist-electron', name))) === hash(buffer)))).every(Boolean) };
  assert.ok(proof.buildIdentity.rendererUnchanged && proof.buildIdentity.electronUnchanged); proof.passed = true;
} catch (error) { proof.failure = error?.stack || String(error); process.exitCode = 1; }
finally {
  if (browser) { await page?.evaluate(() => window.streamToolsNative?.command({ op: 'exit' })).catch(() => {}); await browser.close().catch(() => {}); }
  if (child.exitCode === null) child.kill(); fs.closeSync(fd);
  await fsp.writeFile(path.join(root, 'result.json'), JSON.stringify(proof, null, 2));
  console.log(JSON.stringify(proof, null, 2));
}
