const { app, BrowserWindow, session } = require('electron');
require('node:fs').mkdirSync(process.env.DIAGRAM_FREEZE_STATE,{recursive:true});
app.setPath('userData',process.env.DIAGRAM_FREEZE_STATE);
if(process.env.DIAGRAM_FREEZE_GPU!=='1')app.disableHardwareAcceleration();
app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.commandLine.appendSwitch('disable-background-timer-throttling');
app.whenReady().then(async()=>{
  const win=new BrowserWindow({show:process.env.DIAGRAM_FREEZE_SHOW==='1',width:1440,height:1000,webPreferences:{contextIsolation:true,nodeIntegration:false,sandbox:true,backgroundThrottling:false}});
  const origin=new URL(process.env.DIAGRAM_FREEZE_URL).origin;
  session.defaultSession.webRequest.onBeforeRequest((request,callback)=>callback({cancel:!request.url.startsWith(origin)&&!/^(data|blob|devtools):/.test(request.url)}));
  win.webContents.on('render-process-gone',(_event,detail)=>console.error('RENDERER GONE '+JSON.stringify(detail)));
  win.webContents.on('console-message',(_event,_level,message)=>console.log('RENDERER '+message));
  // The runner attaches CDP while the window is still about:blank, then opens
  // the fixture; dependency optimization cannot delay browser attachment.
  await win.loadURL('about:blank');
});
app.on('window-all-closed',()=>app.quit());
