import { app, BrowserWindow, WebContentsView } from 'electron';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { InteractiveFigureSandbox, preflightInteractiveFigure, diagnoseInteractiveFigure, figureSandboxDocument,
  portableFigureDocument, setInteractiveFigureTheme } from '../src/electron/interactiveFigureSandbox';
import { INTERACTIVE_TEACHING_MODE_FIXTURES } from './fixtures/interactive-teaching-modes';

const root = process.env.LOGINOTE_TEACHING_MODE_TEST_ROOT;
if (!root) throw Error('missing isolated teaching mode directory');
const delay = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
let externalRequests = 0;
app.on('session-created', session => session.webRequest.onCompleted({ urls: ['http://*/*', 'https://*/*'] }, () => { externalRequests++; }));
app.setPath('userData', root); app.setPath('sessionData', root);
app.disableHardwareAcceleration();
const deadline = setTimeout(() => { console.error('teaching mode native check exceeded 45 seconds'); app.exit(1); }, 45_000);

async function run() {
  await app.whenReady();
  const owner = new BrowserWindow({ show: false, width: 1000, height: 820,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } });
  let failures: string[] = [];
  const host = new InteractiveFigureSandbox(owner, reason => failures.push(reason));
  const evidence: Record<string, unknown> = { synthetic: true, realModel: false, fullApplicationPerformance: false, screenshots: [] };
  let guest: WebContentsView;
  const evaluate = <T = any>(code: string): Promise<T> => guest.webContents.executeJavaScript(code);
  const open = async (html: string) => {
    const state = await host.open(html, { x: 12, y: 12, width: 740, height: 650 });
    const found = owner.contentView.children.find(view => view instanceof WebContentsView);
    assert.ok(found); guest = found as WebContentsView;
    assert.notEqual(state.processId, owner.webContents.getOSProcessId(), 'figure runs in an isolated OS renderer process');
    return state.processId;
  };
  const carState = () => evaluate<{ t: number; position: number; cx: number; result: string }>(`(()=>({t:Number(document.querySelector('[data-figure="time"]').value),position:Number(document.querySelector('[data-car]').dataset.position),cx:Number(document.querySelector('[data-car]').getAttribute('cx')),result:document.querySelector('[data-figure="result"]').textContent}))()`);
  const assertCar = (state: { t: number; position: number; cx: number }) => {
    assert.ok(Math.abs(state.position - state.t) < .011, JSON.stringify(state));
    assert.ok(Math.abs(state.cx - (30 + 250 * state.position)) < 1e-7, JSON.stringify(state));
  };
  try {
    await owner.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent('<!doctype html><html><body><main>' + '<p>合成连续滚动宿主正文，不加载真实笔记。</p>'.repeat(500) + '</main></body></html>'));
    owner.showInactive();
    const dynamicSource = INTERACTIVE_TEACHING_MODE_FIXTURES.find(fixture => fixture.mode === 'dynamic')!.html;
    const stationaryCar = dynamicSource.replace("car.setAttribute('cx',String(30+250*t))", "car.setAttribute('cx','30')");
    assert.notEqual(stationaryCar, dynamicSource, 'counterexample freezes only SVG motion and retains changing time/readout');
    const falseDynamic = await diagnoseInteractiveFigure(stationaryCar);
    assert.equal(falseDynamic.interaction, 'inconclusive', 'changing time/readouts alone is not observed physical motion');
    evidence.falseDynamicInconclusive = true;
    evidence.falseDynamic = falseDynamic;
    for (const fixture of INTERACTIVE_TEACHING_MODE_FIXTURES) {
      assert.ok(!fixture.html.includes('data-figure="prediction"') && !fixture.html.includes('data-figure="check"'));
      const document = figureSandboxDocument(fixture.html);
      assert.ok(document.includes(`data-figure-mode="${fixture.mode}"`));
      await preflightInteractiveFigure(fixture.html);
      const diagnostic = await diagnoseInteractiveFigure(fixture.html);
      assert.equal(diagnostic.interaction, 'observed', `${fixture.mode} produces a visible state change`);
      assert.equal(diagnostic.reset, 'restored', `${fixture.mode} restores initial state`);
      const processId = await open(fixture.html);
      assert.equal(await evaluate('typeof process'), 'undefined');
      assert.equal(await evaluate('typeof electronAPI'), 'undefined');
      if (fixture.mode === 'dynamic') {
        assert.equal(await evaluate('typeof window.TeachingClock?.start'), 'function');
        // A hidden/occluded guest correctly refuses to animate. Bring this
        // synthetic owner forward and wait for Chromium visibility before Play.
        owner.show(); owner.focus();
        for (let count = 0; count < 20 && await evaluate('document.hidden'); count++) await delay(40);
        evidence.playbackVisibility = { ownerVisible: owner.isVisible(), ownerMinimized: owner.isMinimized(), ownerFocused: owner.isFocused(),
          guestVisible: guest.getVisible(), ownerBounds: owner.getContentBounds(), guestBounds: guest.getBounds(),
          document: await evaluate(`({hidden:document.hidden,state:document.visibilityState,clockRunning:window.TeachingClock.running,reduced:window.TeachingClock.reducedMotion})`) };
        assert.equal(await evaluate('document.hidden'), false, 'native playback begins only after the test figure is visible');
        const hostFrames = owner.webContents.executeJavaScript(`new Promise(resolve=>{const gaps=[];let count=0,last=performance.now(),start=last;function frame(now){gaps.push(now-last);last=now;window.scrollBy(0,6);if(++count===45)resolve({frames:count,elapsed:now-start,maxGap:Math.max(...gaps),scrollTop:window.scrollY});else requestAnimationFrame(frame)}requestAnimationFrame(frame)})`);
        await evaluate(`document.querySelector('[data-figure="play"]').click()`);
        const samples = [];
        for (let index = 0; index < 3; index++) { await delay(170); const sample = await carState(); assertCar(sample); samples.push(sample); }
        assert.ok(samples[0].t > 0 && samples[1].t > samples[0].t && samples[2].t > samples[1].t && samples[2].t < 2, JSON.stringify(samples));
        await evaluate(`document.querySelector('[data-figure="pause"]').click()`);
        const paused = await carState(); await delay(180); assert.deepEqual(await carState(), paused);
        await evaluate(`document.querySelector('[data-figure="play"]').click()`); await delay(100);
        host.setVisible(false); await delay(70); const hidden = await carState(); await delay(180); assert.deepEqual(await carState(), hidden);
        host.setVisible(true); await delay(170); assert.deepEqual(await carState(), hidden, 'showing a hidden figure does not resume autoplay');
        await evaluate(`(()=>{const time=document.querySelector('[data-figure="time"]');time.value='1.9';time.dispatchEvent(new Event('input',{bubbles:true}));document.querySelector('[data-figure="play"]').click()})()`);
        await delay(300); const end = await carState(); assertCar(end); assert.equal(end.t, 2); await delay(100); assert.deepEqual(await carState(), end);
        await evaluate(`document.querySelector('[data-figure="reset"]').click()`); const reset = await carState(); assert.equal(reset.t, 0); assertCar(reset);
        guest.webContents.debugger.attach('1.3');
        await guest.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
        await delay(60); assert.equal(await evaluate(`matchMedia('(prefers-reduced-motion: reduce)').matches`), true);
        await evaluate(`document.querySelector('[data-figure="play"]').click()`); await delay(150); assert.equal((await carState()).t, 0);
        await evaluate(`(()=>{const time=document.querySelector('[data-figure="time"]');time.value='1.25';time.dispatchEvent(new Event('input',{bubbles:true}))})()`);
        const reduced = await carState(); assertCar(reduced); assert.equal(reduced.t, 1.25);
        await guest.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', { features: [] }); guest.webContents.debugger.detach();
        const responsiveness = await hostFrames;
        assert.equal(responsiveness.frames, 45); assert.ok(responsiveness.scrollTop > 0); assert.ok(responsiveness.maxGap < 1500, JSON.stringify(responsiveness));
        evidence.dynamic = { processId, diagnostic, samples, paused, hidden, end, reset, reduced, responsiveness };
      } else if (fixture.mode === 'step') {
        const states = [];
        for (let index = 0; index < 3; index++) states.push(await evaluate(`(()=>{document.querySelector('[data-figure="step"]').click();return {queue:document.querySelector('#queue-items').dataset.queue,state:document.querySelector('[data-figure="state"]').textContent,disabled:document.querySelector('[data-figure="step"]').disabled}})()`));
        assert.deepEqual(states.map(state => state.queue), ['A', 'A,B', 'B']); assert.equal(states[2].disabled, true);
        for (let index = 0; index < 2; index++) {
          const reset = await evaluate(`(()=>{document.querySelector('[data-figure="reset"]').click();return {queue:document.querySelector('#queue-items').dataset.queue,disabled:document.querySelector('[data-figure="step"]').disabled}})()`);
          assert.deepEqual(reset, { queue: '', disabled: false });
        }
        evidence.step = { processId, diagnostic, states };
      } else {
        const values = await evaluate(`(()=>{const input=document.querySelector('[data-shared-input]'),read=()=>({ordered:document.querySelector('#ordered').textContent,grouped:document.querySelector('#grouped').textContent,result:document.querySelector('[data-figure="result"]').textContent});const initial=read();input.value='6';input.dispatchEvent(new Event('input',{bubbles:true}));const changed=read();document.querySelector('[data-figure="reset"]').click();return {initial,changed,reset:read(),cases:document.querySelectorAll('[data-figure="case"]').length}})()`);
        assert.equal(values.cases, 2); assert.equal(values.initial.ordered, 'A A B B'); assert.equal(values.changed.ordered, 'A A B B C C');
        assert.equal(values.changed.grouped, 'A:2 | B:2 | C:2'); assert.deepEqual(values.reset, values.initial);
        evidence.contrast = { processId, diagnostic, values };
      }
      host.setBounds({ x: 12, y: 12, width: 360, height: 640 });
      for (const theme of ['light', 'dark'] as const) {
        setInteractiveFigureTheme(theme); await delay(110);
        const viewport = await evaluate(`(()=>({theme:document.documentElement.dataset.theme,width:innerWidth,scrollWidth:document.documentElement.scrollWidth,bodyWidth:document.body.scrollWidth}))()`);
        assert.equal(viewport.theme, theme); assert.ok(viewport.scrollWidth <= viewport.width + 1 && viewport.bodyWidth <= viewport.width + 1, JSON.stringify(viewport));
        const filename = `${fixture.mode}-${theme}-narrow.png`;
        await writeFile(path.join(root, filename), (await guest.webContents.capturePage()).toPNG());
        (evidence.screenshots as string[]).push(filename);
      }
      host.close();
    }
    setInteractiveFigureTheme('light');
    const legacy = '<section><svg width="180" height="50"><circle id="legacy-dot" cx="20" cy="20" r="5"/></svg><input data-figure="prediction" aria-label="预测"><button data-figure="check">检查</button><button data-figure="reset">重置</button><p data-figure="transfer">换一个输入观察。</p><input type="range" min="0" max="10" value="0" aria-label="位置"><output data-figure="result">0</output><script>const slider=document.querySelector("input[type=range]"),dot=document.querySelector("#legacy-dot"),out=document.querySelector("output");slider.oninput=()=>{dot.setAttribute("cx",String(20+Number(slider.value)));out.textContent=slider.value};document.querySelector("[data-figure=reset]").onclick=()=>{slider.value="0";slider.oninput()};document.querySelector("[data-figure=check]").onclick=()=>{out.textContent="请结合图形检查预测"};</script></section>';
    await preflightInteractiveFigure(legacy); await open(legacy);
    assert.equal(await evaluate(`!!document.querySelector('[data-figure="prediction"]')`), true); host.close(); evidence.legacyPrediction = true;
    const portable = new BrowserWindow({ show: false, width: 500, height: 600, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } });
    try {
      const file = path.join(root, 'dynamic-offline.html'); await writeFile(file, portableFigureDocument(INTERACTIVE_TEACHING_MODE_FIXTURES[0].html).html);
      await portable.loadFile(file); const frame = portable.webContents.mainFrame.frames[0]; assert.ok(frame);
      const result = await frame.executeJavaScript(`(()=>{const time=document.querySelector('[data-figure="time"]');time.value='1.25';time.dispatchEvent(new Event('input',{bubbles:true}));return {clock:typeof window.TeachingClock?.start,t:Number(time.value),position:Number(document.querySelector('[data-car]').dataset.position),node:typeof process,bridge:typeof electronAPI}})()`);
      assert.deepEqual(result, { clock: 'function', t: 1.25, position: 1.25, node: 'undefined', bridge: 'undefined' }); evidence.offline = result;
    } finally { portable.destroy(); }
    assert.deepEqual(failures, []); assert.equal(externalRequests, 0);
    evidence.externalRequests = externalRequests; evidence.passed = true;
    await writeFile(path.join(root, 'result.json'), JSON.stringify(evidence, null, 2));
    console.log(JSON.stringify({ passed: true, synthetic: true, remoteRequests: 0, evidence: path.join(root, 'result.json') }, null, 2));
  } catch (error) {
    await writeFile(path.join(root, 'failure.json'), JSON.stringify({ ...evidence, failures, error: error instanceof Error ? error.stack : String(error) }, null, 2)); throw error;
  } finally { host.dispose(); owner.destroy(); clearTimeout(deadline); app.quit(); }
}
run().catch(error => { console.error(error); clearTimeout(deadline); app.exit(1); });
