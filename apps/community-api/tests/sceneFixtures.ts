import {zipSync,strToU8} from 'fflate';
export function sceneFiles(version='1.0.0'):Record<string,Uint8Array>{return {
  'manifest.json':strToU8(JSON.stringify({protocolVersion:1,id:'community-scene-probe',version,name:'向量变换实验',paradigm:'S2',paradigmApiVersion:1,requiredServices:['execution']})),
  'main.js':strToU8('globalThis.__communityPackageExecuted=true; throw Error("PACKAGE_CODE_MUST_NOT_RUN");'),
  'styles.css':strToU8('.synthetic{color:green}'),'agent.json':strToU8('{}'),
};}
export function h5pFiles():Record<string,Uint8Array>{return {
  'h5p.json':strToU8(JSON.stringify({title:'认识向量的互动练习',mainLibrary:'H5P.CommunitySynthetic',preloadedDependencies:[{machineName:'H5P.CommunitySynthetic',majorVersion:1,minorVersion:0}]})),
  'content/content.json':strToU8(JSON.stringify({text:'只用于隔离上传下载验证'})),
  'content/example.txt':strToU8('SYNTHETIC_PAYLOAD_SENTINEL'),
  'H5P.CommunitySynthetic-1.0/library.json':strToU8(JSON.stringify({machineName:'H5P.CommunitySynthetic',majorVersion:1,minorVersion:0,patchVersion:0,coreApi:{majorVersion:1,minorVersion:28},preloadedJs:[{path:'main.js'}]})),
  'H5P.CommunitySynthetic-1.0/main.js':strToU8('globalThis.__communityPackageExecuted=true; throw Error("PACKAGE_CODE_MUST_NOT_RUN");'),
};}
export const sceneFixture=(version='1.0.0')=>Buffer.from(zipSync(sceneFiles(version)));
export const h5pFixture=()=>Buffer.from(zipSync(h5pFiles()));
