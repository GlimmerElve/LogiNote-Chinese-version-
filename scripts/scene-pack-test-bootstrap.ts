import React from 'react';
import { activate } from '../src/interaction-packs/prompt-lab/entry';
import { scenePackEditorServices } from '../src/services/scene/scenePackEditorServices';
import { sceneInteractionPacks } from '../src/services/scene/sceneInteractionPacks';
import { installSceneInteractionCapabilities } from '../src/services/scene/sceneS2PluginRegistry';

// Explicit fixture installation for old scene checks. This module is never imported by production.
const pack = activate({ editor: scenePackEditorServices, ui: { react: React } });
installSceneInteractionCapabilities(pack);
sceneInteractionPacks.register(pack);
