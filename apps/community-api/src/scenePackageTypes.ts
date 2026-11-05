/** Inert package contracts shared by the community and the desktop importers. */
export interface SceneInteractionPackRef { id:string;version:string }
interface ManifestBase extends SceneInteractionPackRef {
  name:string;paradigm:'S2';paradigmApiVersion:1;
  requiredServices:Array<'execution'|'model'|'resources'>;
}
export type ScenePackMaterialMediaType='text/plain'|'application/json'|'image/png'|'image/jpeg'|'image/webp';
export interface ScenePackMaterialDescriptor {id:string;label:string;path:string;mediaType:ScenePackMaterialMediaType;bytes:number;sha256:string}
export interface SceneInteractionPackManifestV1 extends ManifestBase {protocolVersion:1}
export interface SceneInteractionPackManifestV2 extends ManifestBase {protocolVersion:2;materials:ScenePackMaterialDescriptor[]}
export type SceneInteractionPackManifest=SceneInteractionPackManifestV1|SceneInteractionPackManifestV2;
export interface H5pPackageDescriptor {id:string;title:string;mainLibrary:string;libraries:string[];missing:string[];bytes:number;importedAt:string}
export type ScenePackageSummary={
  kind:'scene-pack';name:string;packageId:string;packageVersion:string;protocolVersion:1|2;
  paradigm:'S2';paradigmApiVersion:1;requiredServices:Array<'execution'|'model'|'resources'>;materialCount:number;
  fileCount:number;expandedBytes:number;
}|{
  kind:'h5p';name:string;mainLibrary:string;libraries:string[];missing:string[];fileCount:number;expandedBytes:number;
};
export const isScenePackageFormat=(format:string)=>format==='scene-pack'||format==='h5p';
