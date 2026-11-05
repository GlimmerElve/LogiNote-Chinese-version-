/** Inspect only the synthetic generated artifact in a disposable Electron guest. */
import { app, BrowserWindow, WebContentsView } from 'electron';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { InteractiveFigureSandbox, diagnoseInteractiveFigure, preflightInteractiveFigure, portableFigureDocument } from '../src/electron/interactiveFigureSandbox';

async function run() {
  const root=process.env.LOGINOTE_FIGURE_TEST_ROOT, folder=process.env.LOGINOTE_FIGURE_OUTPUT;
  if(!root||!folder)throw Error('missing synthetic test paths');
  app.setPath('userData',root); app.setPath('sessionData',root); app.disableHardwareAcceleration(); await app.whenReady();
  const owner=new BrowserWindow({show:false,width:960,height:780,webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false}});
  await owner.loadURL('data:text/html,<p>synthetic acceptance</p>'); const host=new InteractiveFigureSandbox(owner);
  try {
    const html=await readFile(path.join(folder,'figure.html'),'utf8');
    let preflight:'passed'|'failed'='passed'; try {await preflightInteractiveFigure(html)}catch{preflight='failed'}
    let diagnostics:unknown; try{diagnostics=await diagnoseInteractiveFigure(html)}catch{diagnostics='unavailable'}
    await writeFile(path.join(folder,'figure-portable.html'),portableFigureDocument(html).html,'utf8');
    await host.open(html,{x:0,y:0,width:850,height:700});
    const guest=owner.contentView.children.find(view=>view instanceof WebContentsView) as WebContentsView | undefined;
    if(!guest)throw Error('missing isolated figure');
    owner.showInactive(); await new Promise(resolve=>setTimeout(resolve,350));
    if(html.includes('data-local-prediction-disclosure')) {
      const image=await guest.webContents.capturePage();
      if(!image.isEmpty())await writeFile(path.join(folder,'figure-before-prediction.png'),image.toPNG());
    }
    const gate = await guest.webContents.executeJavaScript(`(() => {
      const details=document.querySelector('[data-local-prediction-disclosure]');
      if(!details)return {present:false};
      const visible=node=>!!node && node.getClientRects().length>0 && getComputedStyle(node).visibility!=='hidden';
      const summary=details.querySelector('summary');
      const before={closed:!details.open, summaryVisible:visible(summary), answerContentVisible:[...details.children].filter(n=>n!==summary).some(visible)};
      summary.click();
      const after={open:details.open, visualVisible:[...details.querySelectorAll('svg,canvas,[data-figure="visual"]')].some(visible), predictionVisible:[...details.querySelectorAll('[data-figure="prediction"]')].some(visible)};
      return {present:true,before,after};
    })()`);
    if(gate.present && (!gate.before.closed || !gate.before.summaryVisible || gate.before.answerContentVisible || !gate.after.open || !gate.after.visualVisible || !gate.after.predictionVisible))throw Error(`prediction disclosure failed: ${JSON.stringify(gate)}`);
    if(gate.present) {
      const portable=new BrowserWindow({show:false,width:850,height:700,webPreferences:{sandbox:true,nodeIntegration:false,contextIsolation:true}});
      try {
        await portable.loadFile(path.join(folder,'figure-portable.html'));
        const frame=portable.webContents.mainFrame.frames[0]; assert.ok(frame);
        const result=await frame.executeJavaScript(`(()=>{const d=document.querySelector('[data-local-prediction-disclosure]'),visual=d.querySelector('svg,canvas,[data-figure="visual"]');const before=!d.open&&visual.getClientRects().length===0;d.querySelector('summary').click();return {before,after:d.open&&visual.getClientRects().length>0,node:typeof process,bridge:typeof electronAPI}})()`);
        assert.deepEqual(result,{before:true,after:true,node:'undefined',bridge:'undefined'});
      } finally {portable.destroy()}
    }
    let spring:unknown;
    let electrolysis:unknown;
    if(path.basename(folder).startsWith('chemistry-')) {
      electrolysis=await guest.webContents.executeJavaScript(`(()=>{const p=document.querySelector('#progress'),h=document.querySelector('#valH2'),o=document.querySelector('#valO2'),f=document.querySelector('#feedback'),select=document.querySelector('#prediction'),check=document.querySelector('#check'),reply=document.querySelector('#predFeedback');if(!p||!h||!o||!f||!select||!check||!reply)return null;const samples=[];for(const v of [0,3,5]){p.value=String(v);p.dispatchEvent(new Event('input',{bubbles:true}));samples.push({p:Number(p.value),h:Number(h.textContent),o:Number(o.textContent),feedback:getComputedStyle(f).display==='none'?'':f.textContent})}select.value='2';check.click();const right=reply.textContent;select.value='1';check.click();const wrong=reply.textContent;const outer=document.querySelector('[data-local-prediction-gate]>p')?.textContent||'',inner=document.querySelector('label[for="prediction"]')?.textContent||'';document.querySelector('[data-figure="reset"]').click();return {samples,right,wrong,outer,inner,reset:Number(p.value),resetAnswer:select.value,resetFeedback:reply.textContent};})()`);
      if(electrolysis) {
        const result=electrolysis as {samples:Array<{p:number;h:number;o:number;feedback:string}>;right:string;wrong:string;outer:string;inner:string;reset:number;resetAnswer:string;resetFeedback:string};
        for(const item of result.samples){assert.equal(item.h,2*item.p);assert.equal(item.o,item.p)}
        assert.equal(result.samples[0].feedback,''); assert.match(result.right,/正确/u); assert.doesNotMatch(result.wrong,/正确|2\s*[:：]\s*1|2\s*倍/u);
        assert.ok(result.outer.replace(/^先思考：/u,'').trim() === result.inner.replace(/^预测：/u,'').trim(),'outer and inner prediction should match');
        assert.equal(result.reset,0);assert.equal(result.resetAnswer,'');assert.equal(result.resetFeedback,'');
      }
      if(!electrolysis) {
        const radioResult=await guest.webContents.executeJavaScript(`(()=>{const slider=document.querySelector('#waterSlider'),h=document.querySelector('#h2Vol'),o=document.querySelector('#o2Vol'),ratio=document.querySelector('#ratio'),feedback=document.querySelector('#feedback'),check=document.querySelector('[data-figure="check"]'),reset=document.querySelector('[data-figure="reset"]'),group=document.querySelector('[data-figure="prediction"]');if(!slider||!h||!o||!ratio||!feedback||!check||!reset||!group||!group.querySelector('input[value="2:1"]')||!group.querySelector('input[value="1:1"]'))return null;const samples=[];for(const v of [0,2,6]){slider.value=String(v);slider.dispatchEvent(new Event('input',{bubbles:true}));samples.push({water:Number(slider.value),h:Number(h.textContent),o:Number(o.textContent),ratio:ratio.textContent})}const outer=document.querySelector('[data-local-prediction-gate]>p')?.textContent||'',inner=group.parentElement.querySelector('p')?.textContent||'';group.querySelector('input[value="2:1"]').click();check.click();const right=feedback.textContent;group.querySelector('input[value="1:1"]').click();check.click();const wrong=feedback.textContent;reset.click();return {samples,outer,inner,right,wrong,resetAnswer:!!group.querySelector('input:checked'),resetFeedback:feedback.textContent}})()`);
        if(radioResult) {
          assert.equal(radioResult.samples[0].ratio,'—');
          for(const item of radioResult.samples.slice(1))assert.ok(Math.abs(item.h-2*item.o)<0.11);
          assert.equal(radioResult.outer.replace(/^先思考：/u,'').trim(),radioResult.inner.replace(/^预测：/u,'').trim());
          assert.match(radioResult.right,/正确/u);assert.doesNotMatch(radioResult.wrong,/正确|2\s*[:：]\s*1|2\s*倍/u);
          assert.equal(radioResult.resetAnswer,false);assert.equal(radioResult.resetFeedback,'');electrolysis=radioResult;
        }
      }
    }
    if(path.basename(folder).startsWith('motion-')) {
      const response=JSON.parse(await readFile(path.join(folder,'model-response.json'),'utf8'));
      const [xmin,xmax]=response.plot.xDomain as number[],[ymin,ymax]=response.plot.yDomain as number[];
      assert.ok([xmin,xmax,ymin,ymax].every(value=>typeof value==='number'&&Number.isFinite(value)) && xmin<xmax && ymin<ymax);
      assert.ok(xmin<=0.02&&xmax>=0.02,'spring figure must cover the sourced 0.02 m example');
      spring=await guest.webContents.executeJavaScript(`(()=>{const root=document.querySelector('.local-function-figure'), slider=root.querySelector('input[type=range]'), samples=[];
        for(const value of [0,Math.round((0.02-${xmin})/(${xmax}-${xmin})*Number(slider.max)),Number(slider.max)]){slider.value=String(value);slider.dispatchEvent(new Event('input',{bubbles:true}));samples.push({x:Number(root.querySelector('[data-x]').textContent),force:Number(root.querySelector('[data-readout-value]').textContent),point:root.querySelector('[data-local-point]').getAttribute('cy')});}
        root.querySelector('[data-figure=reset]').click();return {samples,math:root.querySelectorAll('.katex').length};})()`);
      const observed=spring as {samples:Array<{x:number;force:number;point:string}>;math:number};
      assert.equal(observed.samples.length,3);
      assert.ok(Math.abs(observed.samples[1].x-0.02)<=(xmax-xmin)/600+1e-9);
      for(const sample of observed.samples) {
        assert.ok(Math.abs(sample.force-100*sample.x)<1e-6);
        if(sample.force>=ymin&&sample.force<=ymax)assert.ok(Math.abs(Number(sample.point)-(346-(sample.force-ymin)/(ymax-ymin)*322))<0.02);
      }
      assert.ok(observed.math>0,'formula rendering must work');
    }
    let screenshot=false, size={width:0,height:0};
    try { const image=await guest.webContents.capturePage();size=image.getSize();screenshot=!image.isEmpty();
      if(screenshot)await writeFile(path.join(folder,'figure-native.png'),image.toPNG());
    } catch { /* No display surface: keep the diagnostic, mark the image unverified. */ }
    const result={preflight,diagnostics,gate,...(spring ? {spring} : {}),...(electrolysis ? {electrolysis} : {}),screenshot,size,teachingReview:'not-reviewed',visualReview:'not-reviewed'};
    await writeFile(path.join(folder,'inspection-general.json'),JSON.stringify(result,null,2),'utf8');
    console.log(JSON.stringify(result));
    if(preflight!=='passed')throw Error('interactive preflight failed');
  } finally {host.dispose();owner.destroy();app.quit()}
}
run().catch(error=>{console.error(error instanceof Error ? error.message : 'inspection failed');app.exit(1)});
