import {H5pArchive} from './scenePackageArchive.js';
import {inspectScenePackImport} from './scenePackageImport.js';
import {inspectResource,type ResourcePreview} from './resourceFormat.js';
import type {ScenePackageSummary} from './scenePackageTypes.js';

/** Server/desktop only. Reads metadata and verifies bytes, never imports executable entry points. */
export async function inspectSharedResource(bytes:Uint8Array,name:string,mime:string):Promise<ResourcePreview>{
  const generic=inspectResource(bytes,name,mime),extension=name.toLowerCase().split('.').at(-1);
  if(extension!=='zip'&&extension!=='h5p')return generic;
  const archive=new H5pArchive(Buffer.from(bytes.buffer,bytes.byteOffset,bytes.byteLength));
  const names=[...archive.entries.keys()];
  const expandedBytes=[...archive.entries.values()].reduce((sum,entry)=>sum+entry.size,0);
  let summary:ScenePackageSummary|undefined;
  if(extension==='h5p'){
    const {descriptor}=await archive.inspect();await archive.verifyAll();
    summary={kind:'h5p',name:descriptor.title,mainLibrary:descriptor.mainLibrary,libraries:descriptor.libraries,missing:descriptor.missing,fileCount:names.length,expandedBytes};
  }else{
    // Detect a real S2 identity or its fixed four-file layout. Arbitrary manifest.json
    // files remain ordinary ZIP resources; broken S2 candidates cannot downgrade.
    let candidate=false;
    for(const manifest of names.filter(file=>file==='manifest.json'||file.endsWith('/manifest.json'))){
      const prefix=manifest.slice(0,-'manifest.json'.length);
      const layout=['main.js','styles.css','agent.json'].every(file=>archive.entries.has(prefix+file));
      candidate ||= layout;
      if((archive.entries.get(manifest)?.size||0)<=8192){
        try{const value=await archive.json(manifest);candidate ||= value.paradigm==='S2'||value.paradigmApiVersion===1&&'requiredServices' in value;}catch(error){if(layout)throw error;}
      }
    }
    if(candidate){
      const {manifest,files}=await inspectScenePackImport(Buffer.from(bytes.buffer,bytes.byteOffset,bytes.byteLength));
      summary={kind:'scene-pack',name:manifest.name,packageId:manifest.id,packageVersion:manifest.version,protocolVersion:manifest.protocolVersion,paradigm:manifest.paradigm,paradigmApiVersion:manifest.paradigmApiVersion,requiredServices:manifest.requiredServices,materialCount:manifest.protocolVersion===2?manifest.materials.length:0,fileCount:files.size,expandedBytes};
    }
  }
  return summary?{format:summary.kind,title:summary.name,units:1,items:[],scenePackage:summary}:generic;
}
