import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { zipSync, strToU8 } from 'fflate';
import { H5pArchive, H5P_LIMITS } from '../src/electron/h5pPackage';
import { createH5pStore } from '../src/electron/h5pStore';
import { startH5pServer, H5P_CSP } from '../src/electron/h5pServer';
import { H5P_CONTENT_LAYOUT_CSS } from '../src/electron/h5pPlayerPage';

export function fixtureFiles() {
  return {
    'h5p.json': strToU8(JSON.stringify({ title: '合成本地场景', mainLibrary: 'H5P.Synthetic', embedTypes: ['iframe'], language: 'zh',
      preloadedDependencies: [{ machineName: 'H5P.Synthetic', majorVersion: 1, minorVersion: 0 }] })),
    'content/content.json': strToU8(JSON.stringify({ text: '合成示例' })),
    'H5P.Synthetic-1.0/library.json': strToU8(JSON.stringify({ title: 'Synthetic', machineName: 'H5P.Synthetic', majorVersion: 1, minorVersion: 0, patchVersion: 0,
      runnable: 1, coreApi: { majorVersion: 1, minorVersion: 28 }, preloadedJs: [{ path: 'test.js' }] })),
    'H5P.Synthetic-1.0/test.js': strToU8('window.synthetic=true;'),
  };
}

const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'loginote-h5p-check-'));
let groups = 0;
const pass = (message: string) => { groups++; console.log(`PASS ${message}`); };
try {
  const bytes = Buffer.from(zipSync(fixtureFiles())), archive = new H5pArchive(bytes), inspected = await archive.inspect();
  assert.equal(inspected.descriptor.missing.length, 0); assert.equal(inspected.descriptor.libraries[0], 'H5P.Synthetic-1.0');
  assert.equal((await archive.read('H5P.Synthetic-1.0/test.js')).toString(), 'window.synthetic=true;');
  pass('标准 H5P ZIP、元数据、嵌套库清单、哈希与 CRC 校验；仅解析数据，不执行包代码');
  {
    const files = fixtureFiles();
    const metadata = JSON.parse(Buffer.from(files['h5p.json']).toString());
    const definition = JSON.parse(Buffer.from(files['H5P.Synthetic-1.0/library.json']).toString());
    metadata.preloadedDependencies[0].majorVersion = '1'; metadata.preloadedDependencies[0].minorVersion = '0';
    definition.majorVersion = '1'; definition.minorVersion = '0'; definition.patchVersion = '2';
    definition.coreApi = { majorVersion: '1', minorVersion: '28' };
    definition.preloadedDependencies = [{ machineName: 'H5P.Child', majorVersion: '2', minorVersion: '3' }];
    (files as Record<string, Uint8Array>)['H5P.Child-2.3/library.json'] = strToU8(JSON.stringify({ machineName: 'H5P.Child', majorVersion: 2, minorVersion: 3, patchVersion: 0 }));
    files['h5p.json'] = strToU8(JSON.stringify(metadata));
    files['H5P.Synthetic-1.0/library.json'] = strToU8(JSON.stringify(definition));
    const compatible = await new H5pArchive(Buffer.from(zipSync(files))).inspect();
    assert.deepEqual(compatible.descriptor.missing, []);
    assert.deepEqual(compatible.descriptor.libraries, ['H5P.Child-2.3', 'H5P.Synthetic-1.0']);
    for (const invalid of ['', ' ', '1.0', '1e0', '+1', '-1', '01', '0x1', 'Infinity', true, null, {}, 1.5, -1, 10000, '10000']) {
      for (const field of ['majorVersion', 'minorVersion']) {
        metadata.preloadedDependencies[0][field] = invalid;
        files['h5p.json'] = strToU8(JSON.stringify(metadata));
        await assert.rejects(new H5pArchive(Buffer.from(zipSync(files))).inspect(), /依赖库名称或版本无效/);
        metadata.preloadedDependencies[0][field] = field === 'majorVersion' ? '1' : '0';
      }
    }
    metadata.preloadedDependencies[0].majorVersion = '1'; files['h5p.json'] = strToU8(JSON.stringify(metadata));
    definition.patchVersion = '1e0'; files['H5P.Synthetic-1.0/library.json'] = strToU8(JSON.stringify(definition));
    await assert.rejects(new H5pArchive(Buffer.from(zipSync(files))).inspect(), /库补丁版本无效/);
    definition.patchVersion = '2'; definition.coreApi.minorVersion = '29';
    files['H5P.Synthetic-1.0/library.json'] = strToU8(JSON.stringify(definition));
    assert.match((await new H5pArchive(Buffer.from(zipSync(files))).inspect()).descriptor.missing.join(' '), /核心 API/);
    pass('兼容官方数字字符串版本、混合格式及嵌套依赖；拒绝宽松强转，保留核心 API 版本上限');
  }
  {
    const files = fixtureFiles(); delete (files as any)['H5P.Synthetic-1.0/library.json'];
    assert.deepEqual((await new H5pArchive(Buffer.from(zipSync(files))).inspect()).descriptor.missing, ['H5P.Synthetic-1.0']);
    const broken = fixtureFiles(); delete (broken as any)['H5P.Synthetic-1.0/test.js'];
    assert.match((await new H5pArchive(Buffer.from(zipSync(broken))).inspect()).descriptor.missing.join(' '), /test.js/);
    pass('缺失库和缺失运行脚本明确列出，不联网补装或悄悄换版本');
  }
  {
    for (const name of ['../evil.js', 'C:/evil.js', 'content/../evil.js', 'content/%2e%2e/x', 'content/CON.txt', 'content/x\\evil.js']) {
      assert.throws(() => new H5pArchive(Buffer.from(zipSync({ ...fixtureFiles(), [name]: strToU8('bad') }))), /路径/);
    }
    assert.throws(() => new H5pArchive(Buffer.from(zipSync({ ...fixtureFiles(), 'H5P.JSON': strToU8('{}') }))), /重复/);
    const huge = Buffer.from(bytes); const central = huge.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
    huge.writeUInt32LE(H5P_LIMITS.file + 1, central + 24);
    assert.throws(() => new H5pArchive(huge), /超限/);
    const changed = Buffer.from(bytes); changed[40] ^= 1;
    await assert.rejects(async () => { const file = new H5pArchive(changed); await file.inspect(); });
    pass('路径穿越、盘符、编码路径、Windows 保留名、大小写冲突、解压炸弹及损坏数据均拒绝');
  }
  {
    const files = fixtureFiles(), json = JSON.parse(Buffer.from(files['H5P.Synthetic-1.0/library.json']).toString());
    json.preloadedDependencies = [{ machineName: 'FontAwesome', majorVersion: 4, minorVersion: 5 }];
    files['H5P.Synthetic-1.0/library.json'] = strToU8(JSON.stringify(json));
    assert.deepEqual((await new H5pArchive(Buffer.from(zipSync(files))).inspect()).descriptor.missing, ['FontAwesome-4.5']);
    json.preloadedDependencies = [];
    json.coreApi.minorVersion = 999;
    files['H5P.Synthetic-1.0/library.json'] = strToU8(JSON.stringify(json));
    assert.match((await new H5pArchive(Buffer.from(zipSync(files))).inspect()).descriptor.missing[0], /核心 API/);
    pass('递归依赖与核心版本兼容检查');
  }
  {
    const dep = (machineName: string) => ({ machineName, majorVersion: 1, minorVersion: 0 });
    const files: Record<string, Uint8Array> = fixtureFiles();
    const main = JSON.parse(Buffer.from(files['H5P.Synthetic-1.0/library.json']).toString());
    const add = (name: string, dependencies: string[] = [], dynamic: string[] = []) => {
      files[`${name}-1.0/library.json`] = strToU8(JSON.stringify({ ...dep(name), patchVersion: 0,
        preloadedDependencies: dependencies.map(dep), dynamicDependencies: dynamic.map(dep) }));
    };
    main.preloadedDependencies = [dep('H5P.Synthetic')];
    files['H5P.Synthetic-1.0/library.json'] = strToU8(JSON.stringify(main));
    await assert.rejects(new H5pArchive(Buffer.from(zipSync(files))).inspect(), /循环依赖/);
    main.preloadedDependencies = [dep('H5P.B')]; add('H5P.B', ['H5P.Synthetic']);
    files['H5P.Synthetic-1.0/library.json'] = strToU8(JSON.stringify(main));
    await assert.rejects(new H5pArchive(Buffer.from(zipSync(files))).inspect(), /循环依赖/);
    main.preloadedDependencies = [dep('H5P.B'), dep('H5P.C')]; add('H5P.B', ['H5P.D']); add('H5P.C', ['H5P.D']); add('H5P.D');
    files['H5P.Synthetic-1.0/library.json'] = strToU8(JSON.stringify(main));
    assert.equal((await new H5pArchive(Buffer.from(zipSync(files))).inspect()).descriptor.missing.length, 0, 'shared diamond dependency is not a cycle');
    add('H5P.B', [], ['H5P.Synthetic']);
    assert.equal((await new H5pArchive(Buffer.from(zipSync(files))).inspect()).descriptor.missing.length, 0, 'a dynamic back-reference is not a preloaded cycle');
    pass('提前拒绝自引用及跨库循环预加载依赖；共享子依赖和动态回指不会被误伤');
  }
  {
    const files: Record<string, Uint8Array> = fixtureFiles();
    const definition = JSON.parse(Buffer.from(files['H5P.Synthetic-1.0/library.json']).toString());
    definition.preloadedCss = [{ path: 'theme.css' }];
    files['H5P.Synthetic-1.0/library.json'] = strToU8(JSON.stringify(definition));
    files['H5P.Synthetic-1.0/theme.css'] = strToU8('body{color:green}');
    const invalidRoot = path.join(temporary, 'reject-runtime'); await fs.mkdir(invalidRoot);
    const rejectedStore = createH5pStore(invalidRoot);
    for (const name of ['H5P.Synthetic-1.0/test.js', 'H5P.Synthetic-1.0/theme.css']) {
      const packed = Buffer.from(zipSync(files, { level: 0 })), entry = new H5pArchive(packed).entries.get(name)!;
      packed[entry.start] ^= 1; // Only runtime payload changes: JSON and ZIP directory remain valid.
      await assert.rejects(new H5pArchive(packed).inspect(), error => error instanceof Error && error.message.includes(name) && /校验失败/.test(error.message));
      await assert.rejects(rejectedStore.importBytes(packed), /运行文件损坏或校验失败/);
    }
    await assert.rejects(fs.access(path.join(invalidRoot, 'h5p', 'packages')), { code: 'ENOENT' });
    pass('损坏脚本和样式在导入前完成 CRC 检验并拒绝落库，不留到播放时失败');
  }
  const store = createH5pStore(temporary);
  await assert.rejects(store.importBytes(bytes, () => false), /未导入/);
  await store.importBytes(bytes); await store.importBytes(bytes);
  assert.equal((await store.list()).packages.length, 1);
  await store.saveProgress(archive.id, { state: { position: 2 }, reportedCompleted: true, reportedScore: { raw: 2, max: 3 } });
  const state = await store.progress(archive.id);
  assert.deepEqual(state?.state, { position: 2 }); assert.equal(state?.reportedCompleted, true);
  const list = await store.list(); assert.equal(list.packages[0].resumeAvailable, true);
  await assert.rejects(async () => store.saveProgress('../unsafe', {}), /编号/);
  await assert.rejects(async () => store.saveProgress(archive.id, { state: 'x'.repeat(1_000_000) }), /上限|限制/);
  const mutable = { state: { position: 5 } }; const frozenWrite = store.saveProgress(archive.id, mutable); mutable.state.position = 999;
  await frozenWrite; assert.deepEqual((await store.progress(archive.id))?.state, { position: 5 });
  pass('内容哈希去重、独立个人进度、受限大小、非法 ID 拒绝；与笔记/掌握度/认知库没有写入通道');
  const runtime = await startH5pServer({ archive, files: inspected.files, assets: path.resolve('node_modules/h5p-standalone/dist'), progress: state,
    readProgress: () => store.progress(archive.id), save: input => store.saveProgress(archive.id, input) });
  try {
    const page = await fetch(runtime.url); assert.equal(page.status, 200); assert.equal(page.headers.get('content-security-policy'), H5P_CSP);
    assert.match(await page.text(), /H5P 本地场景/);
    assert.equal((await fetch(runtime.origin + '/package/h5p.json')).status, 403);
    assert.equal((await fetch(runtime.url + 'player/../h5pStore.ts')).status, 404);
    assert.equal((await fetch(runtime.url + 'package/content/content.json')).status, 200);
    assert.equal((await fetch(runtime.url + 'player/main.bundle.js')).status, 200);
    assert.equal((await fetch(runtime.url + 'checkpoint', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'https://other.example' }, body: '{}' })).status, 403);
    const bootstrap = await (await fetch(runtime.url + 'bootstrap.js')).text();
    assert.match(bootstrap, /customCss:base\+'content-layout\.css'/);
    const layoutResponse = await fetch(runtime.url + 'content-layout.css');
    assert.equal(layoutResponse.status, 200); assert.match(layoutResponse.headers.get('content-type')!, /^text\/css/);
    assert.equal(await layoutResponse.text(), H5P_CONTENT_LAYOUT_CSS);
    assert.equal(layoutResponse.headers.get('content-security-policy'), H5P_CSP);
    const generation = JSON.parse(/const pageGeneration=("[a-f0-9]+");/u.exec(bootstrap)![1]);
    const headers = { 'Content-Type': 'application/json', Origin: runtime.origin, 'X-H5P-Page': generation };
    assert.equal((await fetch(runtime.url + 'bootstrap.js', { method: 'HEAD' })).status, 200, 'asset metadata checks cannot invalidate the active page');
    assert.equal((await fetch(runtime.url + 'checkpoint', { method: 'POST', headers, body: JSON.stringify({ state: { position: 3 } }) })).status, 200);
    assert.deepEqual((await store.progress(archive.id))?.state, { position: 3 });
    const reloaded = await (await fetch(runtime.url + 'bootstrap.js')).text();
    assert.match(reloaded, /"state":\{"position":3\}/u, 'reload restores committed state, not opening state');
    assert.equal((await fetch(runtime.url + 'checkpoint', { method: 'POST', headers, body: JSON.stringify({ state: { position: 0 } }) })).status, 409);
    assert.deepEqual((await store.progress(archive.id))?.state, { position: 3 }, 'late old-page requests cannot roll back the new page');
    const ranged = await fetch(runtime.url + 'package/H5P.Synthetic-1.0/test.js', { headers: { Range: 'bytes=0-5' } });
    assert.equal(ranged.status, 206); assert.equal((await ranged.arrayBuffer()).byteLength, 6);
    pass('真实 loopback 服务：随机窗口令牌、Host/Origin/方法校验、只读包资源、受限进度写入及媒体 Range');
  } finally { await runtime.close(); }
  await assert.rejects(fetch(runtime.url));
  pass('窗口服务可终止，不保留后台监听');
  {
    let stored = state, release!: () => void, accepted!: () => void;
    const entered = new Promise<void>(resolve => { accepted = resolve; });
    const blocked = new Promise<void>(resolve => { release = resolve; });
    const deferred = await startH5pServer({ archive, files: inspected.files, assets: path.resolve('node_modules/h5p-standalone/dist'), progress: state,
      readProgress: async () => stored, save: async input => { accepted(); await blocked; stored = input as typeof stored; } });
    try {
      const initial = await (await fetch(deferred.url + 'bootstrap.js')).text();
      const generation = JSON.parse(/const pageGeneration=("[a-f0-9]+");/u.exec(initial)![1]);
      const posting = fetch(deferred.url + 'checkpoint', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: deferred.origin, 'X-H5P-Page': generation }, body: JSON.stringify({ state: { position: 9 } }) });
      await entered;
      let loaded = false;
      const reloading = fetch(deferred.url + 'bootstrap.js').then(async response => { const script = await response.text(); loaded = true; return script; });
      await new Promise(resolve => setTimeout(resolve, 30)); assert.equal(loaded, false, 'reload must join an accepted in-flight write');
      release(); assert.equal((await posting).status, 200);
      assert.match(await reloading, /"state":\{"position":9\}/u);
    } finally { release(); await deferred.close(); }
    pass('重载等待已接受写入完成，再读取最新进度；HEAD 不改变页面代次');
  }
  const progressFile = path.join(temporary, 'user-state', 'h5p', archive.id + '.json');
  await fs.rename(progressFile, progressFile + '.backup'); await fs.mkdir(progressFile);
  await assert.rejects(store.saveProgress(archive.id, { state: { position: 6 } }));
  await assert.rejects(store.flush());
  store.acknowledgeSaveFailure(archive.id); await store.flush();
  await fs.rmdir(progressFile); await fs.rename(progressFile + '.backup', progressFile);
  assert.deepEqual((await store.progress(archive.id))?.state, { position: 3 }, 'discarding a failed save retains the previous checkpoint');
  pass('保存快照冻结；失败不伪报成功，明确放弃后可收尾且原检查点保留');
  await fs.writeFile(path.join(temporary, 'h5p', 'packages', archive.id + '.h5p'), 'tampered');
  await assert.rejects(store.load(archive.id));
  assert.equal((await store.list()).packages.length, 0);
  pass('安装后的包被改写时拒绝运行并显示错误，不把坏包当空数据覆盖');
  console.log(`${groups} H5P groups passed; only synthetic packages and temp user data, no model or external network.`);
} finally {
  const target = path.resolve(temporary);
  assert.equal(path.dirname(target), path.resolve(os.tmpdir())); assert.ok(path.basename(target).startsWith('loginote-h5p-check-'));
  await fs.rm(target, { recursive: true, force: true });
}
