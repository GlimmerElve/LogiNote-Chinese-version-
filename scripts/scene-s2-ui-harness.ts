import * as scenePackViews from '../src/components/scene/ScenePackView';
import { s2WorkflowAnchorKey, s2WorkflowVisibleInputs } from '../src/components/scene/S2WorkflowNodeView';
import * as packHostServices from '../src/services/scene/sceneInteractionHostServices';
import * as packLoader from '../src/services/scene/sceneInteractionPackLoader';
import * as packProtocol from '../src/services/scene/sceneInteractionPackProtocol';
import * as packMaterials from '../src/services/scene/sceneInteractionPackMaterials';
import * as packMaterialProtocol from '../src/services/scene/sceneInteractionPackMaterialProtocol';
import * as packUiHost from '../src/interaction-packs/prompt-lab/uiHost';
import { sceneInteractionPacks } from '../src/services/scene/sceneInteractionPacks';
import { scenePackEditorServices } from '../src/services/scene/scenePackEditorServices';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import * as canvas from '../src/services/scene/sceneS2Canvas';
import type { S2AgentReply, S2CanvasDefinition } from '../src/types/sceneS2';
import * as pluginHost from '../src/services/scene/sceneS2PluginHost';
import * as pluginProtocol from '../src/services/scene/sceneS2PluginProtocol';
import * as pluginRegistry from '../src/services/scene/sceneS2PluginRegistry';
import * as workflow from '../src/services/scene/sceneS2Workflow';
import * as layout from '../src/services/scene/sceneS2Layout';
import * as readOnlyContent from '../src/services/scene/sceneS2ReadOnly';
import * as memoryModule from '../src/services/scene/sceneS2Memory';
import * as assistantSnapshot from '../src/services/scene/sceneS2AssistantSnapshot';
import * as business from '../src/services/scene/sceneS2Business';
import * as controls from '../src/services/scene/sceneS2Controls';
import * as controlDrafts from '../src/services/scene/sceneS2ControlDrafts';
import * as presentation from '../src/services/scene/sceneS2Presentation';
import * as pluginHelp from '../src/services/scene/sceneS2PluginHelp';
import * as promptControls from '../src/interaction-packs/prompt-lab/promptControls';
import * as composeControls from '../src/interaction-packs/prompt-lab/composeControls';
import * as fieldChoices from '../src/services/scene/sceneS2FieldChoices';
import * as materials from '../src/services/scene/sceneS2Materials';
import * as textResource from '../src/services/scene/sceneS2TextResource';
import * as projectNoteResource from '../src/services/scene/sceneS2ProjectNotes';
import * as resourceUi from '../src/services/scene/sceneS2ResourceUi';
import * as sceneSave from '../src/services/scene/sceneS2SceneSave';
import * as canvasDelete from '../src/services/scene/sceneS2CanvasDelete';
import * as publicAuthoring from '../src/services/scene/sceneS2PublicAuthoring';
import * as publicSession from '../src/services/scene/sceneS2PublicSession';
import * as publicInteraction from '../src/services/scene/sceneS2Interaction';
import * as interactionActions from '../src/services/scene/sceneS2InteractionActions';
import * as interactionEvents from '../src/services/scene/sceneS2InteractionEvents';
import * as interactionMetadata from '../src/services/scene/sceneS2InteractionMetadata';
import * as interactionProtocol from '../src/services/scene/sceneS2InteractionProtocol';
import * as connections from '../src/services/scene/sceneS2Connections';
import * as connectionIssues from '../src/services/scene/sceneS2ConnectionIssues';
import * as runtimeIssues from '../src/services/scene/sceneS2RuntimeIssues';
import * as compositeCanvas from '../src/services/scene/sceneS2CompositeCanvas';
import * as compositeLibrary from '../src/services/scene/sceneS2CompositeLibrary';
import * as compositeComparison from '../src/services/scene/sceneS2CompositeComparison';
import * as compositeInstance from '../src/services/scene/sceneS2CompositeInstance';
import * as compositeMigration from '../src/services/scene/sceneS2CompositeMigration';

// Execute the real production component/handlers with deterministic hooks and synthetic IO.
// This tests lifecycle/state transitions, not DOM layout or browser pointer behavior.
type Element = { type: unknown; props: Record<string, any>; children: any[] };
type Slot = { value?: any; deps?: unknown[]; cleanup?: () => void };
const request = { source: 'custom', subject: 'Synthetic S2', knowledgePoints: [], sceneSkill: 'S2' } as const;
export function harness(options: { initialDraft?: unknown; failSave?: boolean; initialRequest?: import('../src/types').SceneInitialRequest;
  /** Old complete-catalogue fixtures are legacy protocol tests, not public authoring packs. */
  legacyCatalogue?: boolean;
  deferStateUpdates?: boolean;
  projectNoteSource?: import('../src/services/scene/sceneS2ProjectNotes').S2ProjectNoteSource;
  loadScene?: (id: string) => Promise<import('../src/types').SceneSpec | null>;
  loadInteractionPack?: typeof packLoader.loadSceneInteractionPack;
  controllers?: { design: typeof canvas.designS2Canvas; interact: typeof canvas.interactS2Canvas };
  publicModel?: publicInteraction.S2InteractionOptions['call'];
  onHost?: (host: pluginHost.S2PluginHost) => void;
  modelProvider?: typeof import('../src/services/scene/sceneS2ModelTransport')['prepareS2ModelTestProvider'] } = {}) {
  const slots: Slot[] = []; let cursor = 0, tree: Element, effects: Array<() => void> = [], changed = false;
  const legacyReference = { id: 'synthetic-legacy-catalogue', version: '1.0.0' };
  if (options.legacyCatalogue && !sceneInteractionPacks.catalog().some(pack => pack.id === legacyReference.id)) {
    const { authoring: _publicDirectory, ...legacy } = sceneInteractionPacks.resolve({ id: 'prompt-lab', version: '0.1.0' });
    sceneInteractionPacks.register({ ...legacy, manifest: { ...legacy.manifest, ...legacyReference },
      canvas: { contentEditing: 'panel', openSettingsOnSelect: true } });
  }
  let hookSlots = slots, componentPath = '';
  const viewSlots = new Map<string, Slot[]>(), viewComponents = new Set<unknown>();
  // Preserve the actual production createElement arguments for resource-slot
  // boundary checks, even when the text component is executed by this harness.
  const resourceElements = new Map<string, Element>();
  const viewContexts = new Map<string, import('../src/types/sceneInteractionPack').ScenePackViewContext>();
  let resourceSourceDocument: import('../src/types/sceneS2').S2Document | undefined;
  const keyboardTarget = { tagName: 'DIV', getAttribute: () => null };
  const toolbarTarget = { tagName: 'NAV', getAttribute: () => null };
  let stateUpdates: Array<() => void> = [];
  let invocation: { resolve: (r: S2AgentReply) => void; reject: (error: Error) => void; signal?: AbortSignal; pluginContext?: any; memory?: memoryModule.S2ConversationMemory;
    memoryFrame?: memoryModule.S2MemoryFrame; origin?: string; history?: any[] } | null = null;
  let designInvocation: { resolve: (r: S2CanvasDefinition) => void; signal?: AbortSignal; onProgress?: (stage: string, attempt: number) => void } | null = null;
  let modelCalls = 0, stateWrites = 0;
  type PublicInvocation = { prompt: string; input: Record<string, unknown>; maxOutputTokens: number; signal?: AbortSignal };
  const publicInvocations: PublicInvocation[] = [];
  let publicPending: { resolve: (raw: unknown) => void; reject: (error: Error) => void } | undefined;
  const publicCall = (signal?: AbortSignal): publicInteraction.S2InteractionOptions['call'] => (prompt, input, maxOutputTokens) => {
    publicInvocations.push({ prompt, input: structuredClone(input), maxOutputTokens, signal });
    if (options.publicModel) return options.publicModel(prompt, input, maxOutputTokens);
    return new Promise((resolve, reject) => { assert.ok(!publicPending, 'One pending public model request'); publicPending = { resolve, reject }; });
  };
  const statuses: string[] = [], drafts: any[] = [], saved: any[] = [], anchorUpdates: string[] = [];
  const refreshAnchors = (id: string) => { anchorUpdates.push(id); };
  const React = {
    Component: class {},
    createElement: (type: unknown, props: any, ...children: any[]) => {
      if (props?.ref && typeof props.ref === 'object' && typeof props.className === 'string') {
        if (props.className.split(/\s+/).includes('s2-canvas-shell')) props.ref.current = { contains: (target: unknown) => target === keyboardTarget };
        if (props.className.split(/\s+/).includes('s2-toolbar')) props.ref.current = { contains: (target: unknown) => target === toolbarTarget };
      }
      if (props?.selectedNodeId && (type === 'image-materials' || typeof type === 'function' && ['S2TextMaterialInput', 'S2ProjectNoteInput'].includes(type.name)))
        resourceElements.set(props.selectedNodeId, { type, props, children });
      if (!viewComponents.has(type)) return { type, props: props || {}, children };
      const previous = { cursor, hookSlots, componentPath };
      componentPath += `/${(type as Function).name}:${props?.context?.node.id ?? props?.node?.id ?? props?.nodeId ?? props?.selectedNodeId ?? ''}:${props?.slot ?? ''}`;
      if (!viewSlots.has(componentPath)) viewSlots.set(componentPath, []);
      hookSlots = viewSlots.get(componentPath)!; cursor = 0;
      try { return (type as Function)({ ...props, children }); }
      finally { cursor = previous.cursor; hookSlots = previous.hookSlots; componentPath = previous.componentPath; }
    },
    useState(initial: any) { const index = cursor++, storage = hookSlots; storage[index] ??= { value: typeof initial === 'function' ? initial() : initial };
      return [storage[index].value, (value: any) => {
        stateWrites++;
        const update = () => { storage[index].value = typeof value === 'function' ? value(storage[index].value) : value; };
        if (options.deferStateUpdates) stateUpdates.push(update); else update();
        changed = true;
      }]; },
    useRef(initial: any) { const index = cursor++, storage = hookSlots; storage[index] ??= { value: { current: initial } }; return storage[index].value; },
    useEffect(effect: () => void | (() => void), deps: unknown[]) {
      const index = cursor++, storage = hookSlots, prior = storage[index];
      if (!prior || deps.some((value, i) => !Object.is(value, prior.deps?.[i]))) {
        storage[index] = { deps, cleanup: prior?.cleanup };
        effects.push(() => { storage[index].cleanup?.(); const cleanup = effect(); storage[index].cleanup = typeof cleanup === 'function' ? cleanup : undefined; });
      }
    },
  };
  const clonedPromptControls = { ...promptControls,
    applyS2PromptSections: (definition: any, document: any, nodeId: string, rows: any, base: string) => promptControls.applyS2PromptSections(definition, document, nodeId, structuredClone(rows), base),
    applyS2PromptParts: (definition: any, document: any, nodeId: string, parts: any, base: string) => promptControls.applyS2PromptParts(definition, document, nodeId, structuredClone(parts), base),
    compileS2PromptParts: (parts: any, available: any) => promptControls.compileS2PromptParts(structuredClone(parts), available),
    compileS2PromptSections: (rows: any, available: any) => promptControls.compileS2PromptSections(structuredClone(rows), available) };
  const moduleCache = new Map<string, any>(); let activatedPack: any;
  // The browser bundle and validator share one realm. VM view fixtures need a
  // descriptor-preserving transfer before the same real validator runs here.
  // Keep holes/getters/symbols/cycles invalid; never invoke action callbacks.
  function transferViewPolicy(raw: unknown, seen = new WeakMap<object, any>()): any {
    if (!raw || typeof raw !== 'object') return raw;
    if (seen.has(raw)) return seen.get(raw);
    const prototype = Object.getPrototypeOf(raw);
    if (!Array.isArray(raw) && prototype && Object.getPrototypeOf(prototype) !== null) return raw;
    const result = Array.isArray(raw) ? [] : Object.create(prototype === null ? null : Object.prototype);
    seen.set(raw, result);
    const descriptors = Object.getOwnPropertyDescriptors(raw);
    for (const key of Reflect.ownKeys(descriptors)) {
      const descriptor = descriptors[key as keyof typeof descriptors];
      if (Object.hasOwn(descriptor, 'value')) descriptor.value = typeof descriptor.value === 'function'
        ? descriptor.value.bind(raw) : transferViewPolicy(descriptor.value, seen);
      Object.defineProperty(result, key, descriptor);
    }
    return result;
  }
  function viewModule(file: string) {
    if (moduleCache.has(file)) return moduleCache.get(file);
    const exports: any = {}; moduleCache.set(file, exports);
    const source = ts.transpileModule(readFileSync(file, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.React, esModuleInterop: true } }).outputText;
    vm.runInNewContext(source, { exports, structuredClone, console, require(name: string) {
      if (name === 'react') return React;
      if (name === '@xyflow/react') return { Handle: 'handle', Position: { Left: 'left', Right: 'right' } };
      if (name.endsWith('S2ArtifactView')) return { S2ArtifactView: 'artifact-view' };
      if (name.endsWith('S2FieldPreview')) return { S2FieldPreview: 'field-preview' };
      if (name.endsWith('sceneS2TextResource')) return textResource;
      if (name.endsWith('sceneS2ProjectNotes')) return projectNoteResource;
      if (name.endsWith('sceneS2ResourceUi')) return resourceUi;
      if (name === './index') return { promptLabPack: sceneInteractionPacks.resolve({ id: 'prompt-lab', version: '0.1.0' }) };
      if (name === './reactBridge') return { bindPromptLabReact() {} };
      if (name === './uiHost') return packUiHost;
      if (name === './help') return { promptLabHelp: sceneInteractionPacks.resolve({ id: 'prompt-lab', version: '0.1.0' }).help };
      if (name === './ComposeEditor') return { S2ComposeEditor: 'compose-editor' };
      if (name === './ModelParameters') return { S2ModelParameters: 'model-parameters' };
      if (name === './TemplateControls') return viewModule('src/interaction-packs/prompt-lab/TemplateControls.tsx');
      if (name === './promptControls') return clonedPromptControls;
      if (name === './composeControls') return { ...composeControls,
        applyS2ComposeStructure: (definition: any, document: any, nodeId: string, config: any, base: string) => composeControls.applyS2ComposeStructure(definition, document, nodeId, structuredClone(config), base),
        applyS2ComposeControls: (definition: any, document: any, nodeId: string, rows: any, separator: any, base: string) => composeControls.applyS2ComposeControls(definition, document, nodeId, structuredClone(rows), separator, base) };
      if (name.endsWith('sceneInteractionPackProtocol')) return { ...packProtocol,
        readScenePackViewPolicy: (raw: unknown, capability: Parameters<typeof packProtocol.readScenePackViewPolicy>[1]) => packProtocol.readScenePackViewPolicy(transferViewPolicy(raw), capability) };
      if (name.endsWith('sceneInteractionPackMaterialProtocol')) return packMaterialProtocol;
      if (name.endsWith('sceneInteractionPackMaterials')) return packMaterials;
      if (name.endsWith('sceneS2PluginRegistry')) return pluginRegistry;
      if (name.endsWith('sceneInteractionPacks')) return { sceneInteractionPacks: { resolve(ref: any) { const original = sceneInteractionPacks.resolve(ref); return ref.id === 'prompt-lab' ? packViews() : original; } } };
      throw new Error(`Unexpected pack view dependency ${name}`);
    } }, { filename: file });
    Object.values(exports).filter(value => typeof value === 'function').forEach(value => viewComponents.add(value));
    return exports;
  }
  function packViews() {
    if (!activatedPack) {
      activatedPack = viewModule('src/interaction-packs/prompt-lab/entry.ts').activate({ editor: scenePackEditorServices, ui: { react: React } });
      Object.values(activatedPack.views).forEach((view: any) => { if (view.inline) viewComponents.add(view.inline); if (view.settings) viewComponents.add(view.settings); });
    }
    return activatedPack;
  }
  const packViewModule = viewModule('src/components/scene/ScenePackView.tsx');
  const output = ts.transpileModule(readFileSync('src/components/scene/SceneS2CanvasTrial.tsx', 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.React, esModuleInterop: true },
  }).outputText;
  const exports: any = {};
  const sandbox = { exports, crypto, structuredClone, AbortController, console,
    require(name: string) {
      if (name === 'react') return React;
      if (name.endsWith('S2ContentNodeView')) return viewModule('src/components/scene/S2ContentNodeView.tsx');
      if (name.endsWith('S2TextMaterialInput')) return viewModule('src/components/scene/S2TextMaterialInput.tsx');
      if (name.endsWith('S2ProjectNoteInput')) return viewModule('src/components/scene/S2ProjectNoteInput.tsx');
      if (name.endsWith('sceneInteractionPacks')) return { sceneInteractionPacks };
      if (name.endsWith('sceneS2ResourceUi')) return { ...resourceUi, s2ResourceUiDocument(document: import('../src/types/sceneS2').S2Document) {
        // Observe the real boundary argument without exporting it to a package view.
        resourceSourceDocument = document; return resourceUi.s2ResourceUiDocument(document);
      } };
      if (name.endsWith('sceneS2CanvasDelete')) return canvasDelete;
      if (name.endsWith('sceneS2SceneSave')) return sceneSave;
      if (name.endsWith('ScenePackView')) return { ...packViewModule,
        scenePackViewPolicy: (...args: Parameters<typeof scenePackViews.scenePackViewPolicy>) => {
          viewContexts.set(args[1].node.id, args[1]);
          return packViewModule.scenePackViewPolicy(...args);
        } };
      if (name.endsWith('sceneInteractionPackLoader')) return { ...packLoader, loadSceneInteractionPack: options.loadInteractionPack ?? packLoader.loadSceneInteractionPack };
      if (name.endsWith('sceneInteractionHostServices')) return { ...packHostServices,
        enqueueSceneInteractionWorkflow: (host: any, config: any, ...rest: any[]) => (packHostServices.enqueueSceneInteractionWorkflow as any)(host, structuredClone(config), ...rest),
        // Typed terminal UI arrays cross the VM realm here; hostile descriptor
        // checks remain exercised against the native service in its own unit.
        enqueueSceneInteractionUserWorkflow: (host: any, config: any, ref: any, targets: any, ...rest: any[]) =>
          (packHostServices.enqueueSceneInteractionUserWorkflow as any)(host, structuredClone(config), ref, structuredClone(targets), ...rest),
      };
      if (name === '@xyflow/react') return { ReactFlow: 'flow', Background: 'background', Controls: 'controls', Handle: 'handle', Position: { Left: 'left', Right: 'right' }, useUpdateNodeInternals: () => refreshAnchors };
      if (name.endsWith('.css')) return {};
      if (name.endsWith('sceneS2Canvas')) return { ...canvas,
        designS2Canvas: (...args: any[]) => options.controllers ? (options.controllers.design as any)(...args) : new Promise<S2CanvasDefinition>(resolve => { designInvocation = { resolve, ...args[1] }; }),
        interactS2Canvas: (...args: any[]) => options.controllers ? (options.controllers.interact as any)(...args) : new Promise<S2AgentReply>((resolve, reject) => { modelCalls++; invocation = { resolve, reject, signal: args[5]?.signal, pluginContext: args[5]?.pluginContext,
          memory: args[5]?.memory, origin: args[5]?.origin, history: args[4], memoryFrame: args[5]?.memory?.begin(args[0].sceneId, args[5]?.pluginContext?.frame.runId, args[2], args[5]?.origin ?? 'user', args[1]) }; }) };
      // Production UI and services share a realm. Transfer only typed JSON at
      // the VM seam; the real host context keeps its WeakMap-backed readers.
      if (name.endsWith('sceneS2Interaction')) return { ...publicInteraction,
        interactS2PublicScene: (args: publicInteraction.S2InteractionOptions) => publicInteraction.interactS2PublicScene({ ...args,
          definition: structuredClone(args.definition), document: structuredClone(args.document), scope: structuredClone(args.scope),
          ...(args.history === undefined ? {} : { history: structuredClone(args.history) }),
          ...(args.event === undefined ? {} : { event: structuredClone(args.event) }),
          ...(args.selectedNodeIds === undefined ? {} : { selectedNodeIds: structuredClone(args.selectedNodeIds) }),
          ...(args.readOnlyBaseline === undefined ? {} : { readOnlyBaseline: structuredClone(args.readOnlyBaseline) }),
          call: publicCall(args.signal),
        }),
      };
      if (name.endsWith('sceneS2InteractionActions')) return { ...interactionActions,
        prepareS2InteractionActions: (pack: any, config: any, actions: unknown, scope: any, baseline?: any) =>
          interactionActions.prepareS2InteractionActions(pack, structuredClone(config), structuredClone(actions), structuredClone(scope), structuredClone(baseline)),
        executeS2InteractionActions: (prepared: any, services: interactionActions.S2InteractionActionServices) =>
          interactionActions.executeS2InteractionActions(prepared, { ...services, readConfig: () => structuredClone(services.readConfig()) }),
      };
      if (name.endsWith('sceneS2InteractionProtocol')) return { ...interactionProtocol,
        readS2InteractionScope: (raw: unknown) => interactionProtocol.readS2InteractionScope(structuredClone(raw)),
        readS2InteractionConfig: (raw: unknown, document: any) => interactionProtocol.readS2InteractionConfig(structuredClone(raw), structuredClone(document)),
      };
      if (name.endsWith('sceneS2InteractionMetadata')) return interactionMetadata;
      if (name.endsWith('sceneS2InteractionEvents')) return { ...interactionEvents,
        validateS2PublicInteraction: (pack: any, definition: any, document?: any) =>
          interactionEvents.validateS2PublicInteraction(pack, structuredClone(definition), structuredClone(document)),
        S2InteractionEventRouter: class extends interactionEvents.S2InteractionEventRouter {
          constructor(args: ConstructorParameters<typeof interactionEvents.S2InteractionEventRouter>[0]) {
            super({ ...args, readConfig: () => structuredClone(args.readConfig()) });
          }
          publish(...args: Parameters<interactionEvents.S2InteractionEventRouter['publish']>) {
            super.publish(args[0], args[1], structuredClone(args[2]), structuredClone(args[3]), args[4], args[5]);
          }
        },
      };
      if (name.endsWith('sceneS2PluginHost')) return { ...pluginHost, S2PluginHost: class extends pluginHost.S2PluginHost {
        constructor(...args: ConstructorParameters<typeof pluginHost.S2PluginHost>) { super(...args); options.onHost?.(this); }
      } };
      if (name.endsWith('sceneS2PluginRegistry')) return pluginRegistry;
      if (name.endsWith('sceneS2Workflow')) return workflow;
      if (name.endsWith('sceneS2Layout')) return layout;
      if (name.endsWith('sceneS2ReadOnly')) return readOnlyContent;
      if (name.endsWith('sceneS2Memory')) return memoryModule;
      if (name.endsWith('sceneS2AssistantSnapshot')) return assistantSnapshot;
      if (name.endsWith('sceneS2Business')) return business;
      if (name.endsWith('sceneS2ModelTransport')) return { prepareS2ModelTestProvider: options.modelProvider ?? (async () => { throw new Error('Synthetic UI fixture has no approved model provider'); }) };
      if (name.endsWith('S2ArtifactView')) return { S2ArtifactView: 'artifact-view' };
      if (name.endsWith('S2ImageMaterials')) return { S2ImageMaterials: 'image-materials' };
      if (name.endsWith('S2ComposeEditor')) return { S2ComposeEditor: 'compose-editor' };
      if (name.endsWith('S2ModelParameters')) return { S2ModelParameters: 'model-parameters' };
      if (name.endsWith('S2WorkflowNodeView')) return { S2WorkflowNodeView: 'execution-view', s2WorkflowAnchorKey, s2WorkflowVisibleInputs };
      if (name.endsWith('S2JsonParameter')) return { S2JsonParameter: 'json-parameter' };
      if (name.endsWith('S2ConditionEditor')) return { S2ConditionEditor: 'condition-editor' };
      if (name.endsWith('S2HumanInput')) return { S2HumanInput: 'human-input' };
      if (name.endsWith('S2RunSummary')) return { S2RunSummary: 'run-summary' };
      if (name.endsWith('S2FieldEditor')) return { S2FieldEditor: 'field-editor' };
      if (name.endsWith('S2FieldPreview')) return { S2FieldPreview: 'field-preview' };
      if (name.endsWith('sceneS2Controls')) return controls;
      if (name.endsWith('sceneS2PluginProtocol')) return pluginProtocol;
      if (name.endsWith('sceneInteractionPackProtocol')) return packProtocol;
      if (name.endsWith('sceneS2ControlDrafts')) return controlDrafts;
      if (name.endsWith('sceneS2Presentation')) return presentation;
      if (name.endsWith('sceneS2PluginHelp')) return pluginHelp;
      if (name.endsWith('sceneS2FieldChoices')) return fieldChoices;
      if (name.endsWith('sceneS2ComposeControls')) return { ...composeControls,
        applyS2ComposeControls: (definition: any, document: any, nodeId: string, rows: any, separator: any, base: string) =>
          composeControls.applyS2ComposeControls(definition, document, nodeId, structuredClone(rows), separator, base),
      };
      if (name.endsWith('sceneS2PromptControls')) return { ...promptControls,
        // Only typed UI-created section rows cross the VM seam; native hostile-input checks use the real service.
        applyS2PromptSections: (definition: any, document: any, nodeId: string, rows: any, base: string) => promptControls.applyS2PromptSections(definition, document, nodeId, structuredClone(rows), base),
        applyS2PromptParts: (definition: any, document: any, nodeId: string, parts: any, base: string) => promptControls.applyS2PromptParts(definition, document, nodeId, structuredClone(parts), base),
        compileS2PromptParts: (parts: any, available: any) => promptControls.compileS2PromptParts(structuredClone(parts), available),
        compileS2PromptSections: (rows: any, available: any) => promptControls.compileS2PromptSections(structuredClone(rows), available),
      };
      if (name.endsWith('sceneS2Materials')) return materials;
      if (name.endsWith('sceneS2Connections')) return connections;
      if (name.endsWith('sceneS2ConnectionIssues')) return connectionIssues;
      if (name.endsWith('sceneS2RuntimeIssues')) return runtimeIssues;
      if (name.endsWith('sceneS2CompositeCanvas')) return compositeCanvas;
      if (name.endsWith('sceneS2CompositeComparison')) return compositeComparison;
      if (name.endsWith('sceneS2CompositeInstance')) return compositeInstance;
      if (name.endsWith('sceneS2CompositeMigration')) return { ...compositeMigration,
        // Only UI-created typed choices cross this VM seam; hostile inputs are tested against the native service.
        prepareS2CompositeCopy: (preview: any, document: any, definition: any, choices: any) => compositeMigration.prepareS2CompositeCopy(preview, document, definition, structuredClone(choices)),
        checkS2CompositeOutputPlan: (preview: any, document: any, definition: any, choices: any) => compositeMigration.checkS2CompositeOutputPlan(preview, document, definition, structuredClone(choices)),
      };
      if (name.endsWith('sceneS2CompositeLibrary')) return { ...compositeLibrary,
        // Production UI and services share one realm. Normalize only these UI-created typed arguments in the VM harness;
        // untrusted transport/descriptor rejection is tested directly against the unchanged strict service.
        createS2CompositeDesign: (document: any, plugins: any, id: string, publication: any) => compositeLibrary.createS2CompositeDesign(document, plugins, id, structuredClone(publication)),
        instantiateS2CompositeDesign: (document: any, plugins: any, id: string, version: string, values: any, parentId?: string) => compositeLibrary.instantiateS2CompositeDesign(document, plugins, id, version, structuredClone(values), parentId),
      };
      if (name.endsWith('sceneSkillStore')) return { loadManifest: async () => ({}), loadScene: options.loadScene ?? (async () => null),
        saveScene: async (scene: any) => { if (options.failSave) throw new Error('synthetic save failure'); saved.push(scene); return scene; } };
      if (name.endsWith('sceneS2PublicAuthoring')) return { ...publicAuthoring,
        assertS2PublicEdit: (pack: any, before: any, after: any, baseline?: any) => publicAuthoring.assertS2PublicEdit(pack, structuredClone(before), structuredClone(after), structuredClone(baseline)) };
      if (name.endsWith('sceneS2PublicSession')) return {
        prepareS2PublicDefinition: (pack: any, definition: any, options: any) => publicSession.prepareS2PublicDefinition(pack, structuredClone(definition), options),
        appendS2PublicComponent: (pack: any, before: any, componentId: string, id: string, position: any) => publicSession.appendS2PublicComponent(pack, structuredClone(before), componentId, id, structuredClone(position)),
      };
      throw new Error(`Unexpected UI dependency ${name}`);
    },
  };
  vm.runInNewContext(output, sandbox, { filename: 'SceneS2CanvasTrial.test.cjs' });
  function render() {
    let rounds = 0;
    do {
      assert.ok(++rounds < 15, 'No update loop'); changed = false; cursor = 0;
      const updates = stateUpdates; stateUpdates = []; updates.forEach(update => update());
      tree = exports.SceneS2CanvasTrial({ initialRequest: options.initialRequest ?? request, initialDraft: options.initialDraft,
        // Mirror the production boundary's legacy package selection. Explicit null remains a plain generic canvas.
        interactionPackRef: options.legacyCatalogue ? legacyReference : (options.initialDraft as any)?.interactionPack !== undefined || options.initialRequest?.interactionPack !== undefined
          ? undefined : { id: 'prompt-lab', version: '0.1.0' },
        projectNoteSource: options.projectNoteSource,
        onExit: () => {}, onDraftChange: (draft: any) => drafts.push(draft), onSessionStatusChange: (s: string) => statuses.push(s) });
      const pending = effects; effects = []; pending.forEach(effect => effect());
    } while (changed);
    return tree!;
  }
  function elements(root?: any): Element[] {
    if (!arguments.length) root = tree;
    if (Array.isArray(root)) return root.flatMap(elements);
    if (!root || typeof root !== 'object') return [];
    return [root, ...elements(root.children || root.props?.children || [])];
  }
  function text(root?: any): string {
    if (!arguments.length) root = tree;
    if (Array.isArray(root)) return root.map(text).join('');
    return root && typeof root === 'object' ? text(root.children || root.props?.children || []) : String(root ?? '');
  }
  function button(label: string) { const found = elements().find(item => item.type === 'button' && text(item) === label); assert.ok(found, label); return found; }
  function labelControl(label: string, type: string) {
    const group = elements().find(item => item.type === 'label' && item.children[0] === label); assert.ok(group, label);
    const control = elements(group).find(item => item.type === type); assert.ok(control); return control;
  }
  function captureKeyShortcut(action: 'undo' | 'redo' | 'delete') {
    const section = elements().find(item => item.props['aria-label'] === 'S2 通用画布试验'); assert.ok(section?.props.onKeyDown, 'Production canvas keyboard handler');
    const handler = section.props.onKeyDown;
    return () => {
      let prevented = false, stopped = false;
      handler({ key: action === 'delete' ? 'Delete' : 'z', ctrlKey: action !== 'delete', shiftKey: action === 'redo',
        target: keyboardTarget, currentTarget: { ownerDocument: { activeElement: keyboardTarget } }, nativeEvent: { isComposing: false },
        preventDefault() { prevented = true; }, stopPropagation() { stopped = true; } });
      return { prevented, stopped };
    };
  }
  const keyShortcut = (action: 'undo' | 'redo' | 'delete') => captureKeyShortcut(action)();
  const flow = () => { const found = elements().find(item => item.type === 'flow'); assert.ok(found, text().slice(0, 700)); return found; };
  // Node controls live in ReactFlow data, outside the ordinary component children.
  // Inspect that scope explicitly. Native <details> open/closed visibility is left to browser checks.
  function inline(nodeId: string) {
    const root = () => { const node = flow().props.nodes.find((item: any) => item.id === nodeId); assert.ok(node, nodeId); return [node.data.nodeControls, !node.data.interactionInputInView && node.data.nodeInteractionInput]; };
    const scopedElements = () => elements(root());
    return {
      elements: scopedElements,
      text: () => text(root()),
      button(label: string) { const found = scopedElements().find(item => item.type === 'button' && text(item) === label); assert.ok(found, `${nodeId}: ${label}`); return found; },
      labelControl(label: string, type: string) {
        const group = scopedElements().find(item => item.type === 'label' && item.children[0] === label); assert.ok(group, `${nodeId}: ${label}`);
        const control = elements(group).find(item => item.type === type); assert.ok(control); return control;
      },
    };
  }
  const nodeSlots = new Map<string, number>();
  function renderComposite(id: string) {
    const node = flow().props.nodes.find((node: any) => node.id === id && node.type === 'composite'); assert.ok(node);
    const parentCursor = cursor; cursor = nodeSlots.get(id) ?? slots.length; nodeSlots.set(id, cursor);
    try { const view = flow().props.nodeTypes.composite(node); const pending = effects; effects = []; pending.forEach(effect => effect()); return view; }
    finally { cursor = parentCursor; }
  }
  render();
  return { render, elements, text, button, labelControl, keyShortcut, captureKeyShortcut, flow, inline, drafts, statuses, saved, renderComposite, anchorUpdates,
    // A real explicit user message lazily acquires the session. The one synthetic
    // assistant request remains counted; no graph run/save/private Start hook.
    async openConversationSession() {
      for (let i = 0; i < 200 && !elements().some(item => item.type === 'button' && text(item) === '发送'); i++) { await new Promise(resolve => setImmediate(resolve)); render(); }
      labelControl('向 Agent 提出要求', 'textarea').props.onChange({ target: { value: '只说明当前画布，不修改、不执行。' } }); render();
      button('发送').props.onClick(); render();
      assert.ok(invocation, 'Explicit message reaches the synthetic legacy assistant');
      invocation.resolve({ understanding: '只说明', plan: '不修改不执行', reply: '当前画布可直接编辑。', commands: [] });
      for (let i = 0; i < 200 && elements().some(item => item.type === 'button' && text(item) === '停止助手请求'); i++) { await new Promise(resolve => setImmediate(resolve)); render(); }
      assert.ok(!elements().some(item => item.type === 'button' && text(item) === '停止助手请求'), 'Baseline conversation finishes before further UI actions');
      if (options.legacyCatalogue) {
        // These legacy suites intentionally inspect low-level bindings. Opt in
        // through the real diagnostic control instead of restoring old panels.
        const label = elements().find(item => item.type === 'label' && text(item) === '开发诊断（显示技术信息）'); assert.ok(label);
        const toggle = elements(label).find(item => item.type === 'input' && item.props.type === 'checkbox'); assert.ok(toggle);
        toggle.props.onChange({ target: { checked: true } }); render();
      }
    },
    viewContext(nodeId: string) { const context = viewContexts.get(nodeId); assert.ok(context, `Production view context: ${nodeId}`); return context; },
    documentSnapshot() { const context = [...viewContexts.values()].at(-1); assert.ok(context, 'Production document facade'); return context.readCurrent().document; },
    resourceSourceDocument() { assert.ok(resourceSourceDocument, 'Production resource document boundary'); return resourceSourceDocument; },
    resourceElement(nodeId: string) { const element = resourceElements.get(nodeId); assert.ok(element, `Resource element: ${nodeId}`); return element; },
    resolve(result: S2AgentReply) { assert.ok(invocation); invocation.resolve(result); },
    reject(error: Error) { assert.ok(invocation); invocation.reject(error); },
    resolveMemory(result: S2AgentReply, update: unknown) {
      assert.ok(invocation?.memory && invocation.memoryFrame);
      invocation.memory.stage(result, invocation.memoryFrame, invocation.memory.propose(invocation.memoryFrame, update)); invocation.resolve(result);
    },
    memory: () => invocation?.memory,
    origin: () => invocation?.origin,
    history: () => invocation?.history,
    publicInvocations,
    publicInvocation: () => publicInvocations.at(-1),
    resolvePublicModel(raw: unknown) { assert.ok(publicPending, 'Pending public model call'); const pending = publicPending; publicPending = undefined; pending.resolve(raw); },
    rejectPublicModel(error: Error) { assert.ok(publicPending, 'Pending public model call'); const pending = publicPending; publicPending = undefined; pending.reject(error); },
    publicModelCalls: () => publicInvocations.length,
    resolveDesign(result: S2CanvasDefinition) { assert.ok(designInvocation); designInvocation.resolve(result); },
    designProgress(stage: string, attempt = 1) { assert.ok(designInvocation); designInvocation.onProgress?.(stage, attempt); },
    designSignal: () => designInvocation?.signal,
    signal: () => invocation?.signal,
    pluginContext: () => invocation?.pluginContext,
    modelCalls: () => modelCalls + publicInvocations.length,
    stateWrites: () => stateWrites,
    dispose() { [...slots, ...[...viewSlots.values()].flat()].forEach(slot => slot.cleanup?.()); },
  };
}

