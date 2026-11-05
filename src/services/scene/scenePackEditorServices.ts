import type { ScenePackEditorServices } from '../../types/sceneInteractionPack';
import { readS2Definition, readS2Document } from './sceneS2Canvas';
import { snapshotS2CompositeData } from './sceneS2Composite';
import { canonicalS2Json } from './sceneS2PluginProtocol';
import { s2NodeTitle } from './sceneS2Presentation';
import { s2ParameterSource } from './sceneS2ControlDrafts';

export const scenePackEditorServices: ScenePackEditorServices = Object.freeze({
  readDefinition: readS2Definition, readDocument: readS2Document, snapshot: snapshotS2CompositeData,
  canonicalJson: canonicalS2Json, nodeTitle: s2NodeTitle, parameterSource: s2ParameterSource,
});
