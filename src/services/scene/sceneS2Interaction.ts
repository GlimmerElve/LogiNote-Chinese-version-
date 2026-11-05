import type { SceneInteractionPack } from '../../types/sceneInteractionPack';
import type { S2CanvasDefinition, S2Document } from '../../types/sceneS2';
import type { S2InteractionResponse, S2InteractionScope } from '../../types/sceneS2Interaction';
import type { S2Json } from '../../types/sceneS2Plugin';
import type { S2PluginHost } from './sceneS2PluginHost';
import { projectS2PublicCanvas, publicS2Catalog, type S2PublicCanvas } from './sceneS2PublicAuthoring';
import { projectS2AgentComponents } from './sceneS2AgentCatalog';
import { readS2InteractionResponse, readS2InteractionScope, S2_INTERACTION_LIMITS, S2InteractionProtocolError } from './sceneS2InteractionProtocol';
import { prepareS2InteractionActions, S2InteractionActionError } from './sceneS2InteractionActions';
import { readS2ContextArtifact, readS2ContextOutputIds, readS2ContextTrial } from './sceneS2ArtifactAccess';
import type { S2Trial } from './sceneS2Trials';
import { snapshotS2CompositeData } from './sceneS2Composite';
import { parseJsonLenient } from '../reviewSegmentScoring';
import { S2InteractionDisclosure, S2InteractionDisclosureError } from './sceneS2InteractionDisclosure';
import { scenePackAllowsExecution } from './sceneInteractionPackProtocol';
import { availableS2InteractionReads, buildS2InteractionPrompt } from './sceneS2InteractionPrompt';

type HostContext = ReturnType<S2PluginHost['prepare']>;
type PublicResultBody = { resultId: string; nodeId: string; portId: string; type: string; text: string };
type UnavailableResult = { resultId: string; unavailable: true; reason: string };
export interface S2InteractionOptions {
  pack: SceneInteractionPack;
  definition: S2CanvasDefinition;
  document: S2Document;
  task: string;
  origin: 'user' | 'event';
  scope: S2InteractionScope;
  event?: { type: string; nodeId: string; data: S2Json };
  /** Local invocation identity for exact event evidence, never sent to the model. */
  eventInvocationId?: string;
  history?: Array<{ role: 'user' | 'assistant'; content: string }>;
  selectedNodeIds?: string[];
  pluginContext?: HostContext;
  readOnlyBaseline?: Pick<S2Document, 'nodes'>;
  signal?: AbortSignal;
  /** Transport owns provider configuration, truncation and context capacity.
   * A string is the complete model output, never a partial streaming buffer. */
  call(prompt: string, input: Record<string, unknown>, maxOutputTokens: number): Promise<unknown>;
}

const size = (value: unknown) => JSON.stringify(value).length;
const copy = <T>(value: T): T => snapshotS2CompositeData(value, { maxBytes: 256000, maxEntries: 32000 });
class InteractionContextError extends Error {
  constructor(readonly code: string, readonly path: string, readonly reason: string) { super(`S2 交互：${reason}`); }
}
const fail = (code: string, path: string, reason: string): never => { throw new InteractionContextError(code, path, reason); };
const check = (signal?: AbortSignal) => { if (signal?.aborted) throw new DOMException('已停止', 'AbortError'); };
function recentMessages(history: S2InteractionOptions['history']) {
  let remaining = 4000;
  const messages: Array<{ role: 'user' | 'assistant'; content: string }> = [];
  for (const message of [...(history ?? [])].reverse()) {
    if (messages.length >= 4) break;
    if (!['user', 'assistant'].includes(message.role) || typeof message.content !== 'string') continue;
    if (message.content.length > remaining) break;
    messages.unshift({ role: message.role, content: message.content }); remaining -= message.content.length;
  }
  return messages;
}
function canvasView(canvas: S2PublicCanvas) {
  return { canvas: { version: 1, representation: 'public-index',
    nodes: canvas.nodes.map(node => ({ id: node.id, componentId: node.componentId,
      ...(node.label === undefined ? {} : { label: node.label }), ...(node.readOnly === undefined ? {} : { readOnly: node.readOnly }),
      position: node.position,
      parameters: Object.entries(node.values ?? {}).map(([id, value]) => ({ id, chars: size(value) })) })),
    connections: canvas.connections } };
}

/** Both user messages and configured events use the same model-only public view.
 * No native graph, private binding/default, runtime manifest or executable package
 * code is serialized. This function never commits edits or starts execution. */
export async function interactS2PublicScene(options: S2InteractionOptions): Promise<S2InteractionResponse> {
  check(options.signal);
  if (!options.pack.authoring) fail('INTERACTION_LEGACY', '/', '当前包使用旧版交互适配');
  if (typeof options.task !== 'string' || !options.task.trim() || options.task.length > S2_INTERACTION_LIMITS.taskChars)
    fail('INTERACTION_TASK', '/task', '本轮任务超出公开长度范围');
  if (!['user', 'event'].includes(options.origin)) fail('INTERACTION_ORIGIN', '/origin', '响应来源无效');
  const scope = readS2InteractionScope(options.scope);
  const executable = scenePackAllowsExecution(options.pack);
  if (!executable) scope.actions = scope.actions.filter(action => action !== 'execute');
  if (!scope.actions.length) fail('PACK_EXECUTION_DISABLED', '/scope/actions', '当前插件包仅编辑，不提供执行流程');
  const fullCanvas = projectS2PublicCanvas(options.pack, options.definition, options.document);
  const allNodes = new Map(fullCanvas.nodes.map(node => [node.id, node]));
  if (scope.nodeIds?.some(id => !allNodes.has(id))) fail('INTERACTION_SCOPE', '/scope/nodeIds', '范围只能引用现有公开节点');
  const permitted = new Set(scope.nodeIds ?? [...allNodes.keys()]);
  const publicCanvas: S2PublicCanvas = { version: 1, nodes: fullCanvas.nodes.filter(node => permitted.has(node.id)),
    connections: fullCanvas.connections.filter(link => permitted.has(link.source.nodeId) && permitted.has(link.target.nodeId)) };
  const nodes = new Map(publicCanvas.nodes.map(node => [node.id, node]));
  const catalog = publicS2Catalog(options.pack)!;
  const components = projectS2AgentComponents(catalog.components);
  const allowedTypes = scope.nodeIds === undefined ? new Set(components.map(component => component.id)) : new Set(publicCanvas.nodes.map(node => node.componentId));
  const byComponent = new Map(components.filter(component => allowedTypes.has(component.id)).map(component => [component.id, component]));
  const selected = new Set((options.selectedNodeIds ?? []).filter(id => permitted.has(id)));
  if (options.origin === 'event' && (!options.event || !allNodes.has(options.event.nodeId)))
    fail('INTERACTION_EVENT', '/event', '自动响应必须绑定当前画布的真实公开节点');

  const portTypes = new Map<string, string>();
  for (const node of publicCanvas.nodes) for (const port of byComponent.get(node.componentId)!.outputs)
    portTypes.set(JSON.stringify([node.id, port.id]), port.type);
  const resultIndex: Array<{ resultId: string; nodeId: string; portId: string; type: string; state: string; publication: 'current' | 'event'; direction?: 'input' | 'output' }> = [];
  const resultNodes = new Map<string, { nodeId: string; portId: string; type: string; trialId?: string; direction?: 'input' | 'output' }>();
  const context = options.pluginContext;
  let eventTrial: S2Trial | undefined;
  const eventResultIds = options.event?.data && typeof options.event.data === 'object' && !Array.isArray(options.event.data)
    && Array.isArray(options.event.data.resultIds) ? options.event.data.resultIds.filter((id): id is string => typeof id === 'string') : [];
  if (context && options.origin === 'event' && options.event && permitted.has(options.event.nodeId)) {
    const invocationIds = options.eventInvocationId ? [options.eventInvocationId] : [...new Set(eventResultIds.flatMap(id => {
      const source = context.artifactCatalog.find(artifact => artifact.id === id)?.source;
      return source?.nodeId === options.event!.nodeId && source.invocationId ? [source.invocationId] : [];
    }))];
    // Never use the newest trial as a substitute for a delayed or failed event.
    if (invocationIds.length === 1) try {
      const trial = readS2ContextTrial(context, invocationIds[0]);
      if (trial.nodeId === options.event.nodeId && trial.revision === context.frame.revision
        && trial.sceneId === context.frame.sceneId && trial.runId === context.frame.runId) eventTrial = trial;
    } catch { /* Exact evidence remains unavailable. */ }
    if (eventTrial) {
      const component = catalog.components.find(component => component.id === nodes.get(eventTrial!.nodeId)!.componentId)!;
      const addTrialSlots = (direction: 'input' | 'output', ports: Array<{ id: string; type: { id: string; version: number } }>) => {
        for (const port of ports) for (const value of (direction === 'input' ? eventTrial!.inputs : eventTrial!.outputs)[port.id] ?? []) {
          const type = `${port.type.id}@${port.type.version}`;
          if (`${value.type.id}@${value.type.version}` !== type || resultNodes.has(value.artifactId) || resultIndex.length >= 24) continue;
          if (direction === 'output' && (value.source.nodeId !== eventTrial!.nodeId || value.source.invocationId !== eventTrial!.id)) continue;
          resultIndex.push({ resultId: value.artifactId, nodeId: eventTrial!.nodeId, portId: port.id, type,
            state: value.complete ? 'available' : 'unavailable', publication: 'event', direction });
          resultNodes.set(value.artifactId, { nodeId: eventTrial!.nodeId, portId: port.id, type, trialId: eventTrial!.id, direction });
        }
      };
      addTrialSlots('output', component.outputs);
      addTrialSlots('input', [...component.inputs, ...component.parameters]);
    }
  }
  if (context && options.origin !== 'event') for (const output of context.outputIndex ?? []) {
    const type = portTypes.get(JSON.stringify([output.nodeId, output.portId]));
    if (!type || `${output.type.id}@${output.type.version}` !== type) continue;
    let actualIds: string[];
    try { actualIds = readS2ContextOutputIds(context, output.nodeId, output.portId); } catch { continue; }
    for (const id of output.artifactIds.filter(id => actualIds.includes(id))) {
      const metadata = context.artifactCatalog.find(artifact => artifact.id === id);
      if (!metadata || metadata.source.nodeId !== output.nodeId || `${metadata.type.id}@${metadata.type.version}` !== type) continue;
      if (resultIndex.length >= 24) break;
      resultIndex.push({ resultId: id, nodeId: output.nodeId, portId: output.portId, type, state: output.state, publication: 'current' });
      resultNodes.set(id, { nodeId: output.nodeId, portId: output.portId, type });
    }
  }
  const readResult = (id: string): PublicResultBody | UnavailableResult => {
    const expected = resultNodes.get(id);
    if (!context || !expected) fail('INTERACTION_READ_SCOPE', '/read/resultIds', '只能读取已提供索引中的公开结果');
    if (expected.type === 'core.image@1') return { resultId: id, unavailable: true, reason: '当前接口没有提供原图像素，不能根据资源记录判断图像内容' };
    try {
      if (expected.trialId) {
        const trial = readS2ContextTrial(context, expected.trialId);
        const value = (expected.direction === 'input' ? trial.inputs : trial.outputs)[expected.portId]?.find(value => value.artifactId === id);
        if (trial.nodeId !== expected.nodeId || trial.revision !== context.frame.revision || !value?.complete || value.text === undefined
          || `${value.type.id}@${value.type.version}` !== expected.type) throw new Error('trial');
        return { resultId: id, nodeId: expected.nodeId, portId: expected.portId, type: expected.type, text: value.text };
      }
      const actual = readS2ContextOutputIds(context, expected.nodeId, expected.portId);
      if (!actual.includes(id)) throw new Error('stale');
      const body = readS2ContextArtifact(context, id);
      if (body.artifact.source.nodeId !== expected.nodeId || `${body.artifact.type.id}@${body.artifact.type.version}` !== expected.type) throw new Error('source');
      return { resultId: id, nodeId: expected.nodeId, portId: expected.portId, type: expected.type, text: body.text };
    } catch { return { resultId: id, unavailable: true, reason: '当前宿主没有可读取的完整结果' }; }
  };
  const executions = scope.actions.includes('execute') ? (context?.executionRuns ?? []).filter(run =>
    run.publication === 'current' && run.revision === context!.frame.revision && ['queued', 'running', 'waiting'].includes(run.status)
    && run.targets.length > 0 && run.targets.every(id => nodes.has(id)))
    .map(run => ({ runId: run.id, status: run.status, targetNodeIds: [...run.targets] })) : [];
  const description = options.pack.describe(), messages = recentMessages(options.history);
  const eventData: S2Json | undefined = options.event ? options.event.type.startsWith('s2.')
    ? { resultIds: resultIndex.filter(result => result.direction === 'output' && eventResultIds.includes(result.resultId)).map(result => result.resultId) }
    : options.event.data : undefined;
  const packagePurpose = description.purpose.length <= 160 ? description.purpose
    : { representation: 'package-index', name: options.pack.manifest.name, chars: description.purpose.length, read: 'packageInstructions' };
  const baseContext = { goal: options.definition.goal, instructions: copy(options.definition.instructions), packagePurpose, execution: executable ? 'on-demand' : 'none',
    ...canvasView(publicCanvas), ...(selected.size ? { selectedNodeIds: [...selected] } : {}), ...(messages.length ? { recentMessages: messages } : {}),
    ...(options.origin === 'event' ? { event: { type: options.event!.type, nodeId: options.event!.nodeId,
      data: options.event!.type.startsWith('s2.') ? eventData!
        : { representation: 'event-index', readable: permitted.has(options.event!.nodeId),
          ...(permitted.has(options.event!.nodeId) ? { chars: size(options.event!.data) } : {}) } },
      eventInputs: eventTrial ? { resultIds: resultIndex.filter(result => result.direction === 'input').map(result => result.resultId) }
        : { unavailable: true, reason: '未提供范围内该次执行的真实输入记录，不能用当前内容或其他次结果替代' },
      ...(eventTrial ? { eventExecution: { status: eventTrial.status,
        ...(eventTrial.status === 'succeeded' ? {} : { error: { unavailable: true, reason: '原始运行诊断未公开，不能仅凭输入断定失败原因' } }) } } : {}) } : {}),
    ...(executions.length ? { executions } : {}),
    ...(resultIndex.length ? { results: resultIndex } : {}) };

  const editable = scope.actions.includes('edit');
  const allowAdd = editable && scope.nodeIds === undefined && byComponent.size > 0;
  const compatible = (source: string, target: string) => byComponent.get(source)!.outputs.some(output =>
    byComponent.get(target)!.inputs.some(input => input.type === output.type));
  const allowConnect = editable && (publicCanvas.nodes.some(source => byComponent.get(source.componentId)!.outputs.length > 0
    && publicCanvas.nodes.some(target => target.id !== source.id && compatible(source.componentId, target.componentId)))
    || allowAdd && [...byComponent.keys()].some(source => [...byComponent.keys()].some(target => compatible(source, target))));
  const pinned = new Set((options.readOnlyBaseline ?? options.definition.initial).nodes.filter(node => 'readOnly' in node && node.readOnly).map(node => node.id));
  const executableTypes = new Set(options.pack.authoring.components.filter(component => component.implementation.kind === 'capability').map(component => component.id));
  const disclosure = new S2InteractionDisclosure({ components: byComponent, nodes, resultIds: new Set(resultNodes.keys()), readResult, description,
    editable, allowAdd, allowConnect,
    ...(options.event ? { event: { data: eventData!, readable: permitted.has(options.event.nodeId) } } : {}) });
  let calls = 0, reads = 0, repairUsed = false, repeatNoticeUsed = false;
  let repair: Record<string, unknown> | undefined;
  while (calls < S2_INTERACTION_LIMITS.modelCalls) {
    check(options.signal);
    const index = [...byComponent.values()].map(({ id, label, purpose }) => ({ id, label, purpose }));
    const disclosed = disclosure.context();
    const input = copy({ origin: options.origin, task: options.task, scope,
      context: { ...baseContext, ...(index.length ? { componentIndex: index } : {}),
        ...disclosed, ...(repair ? { repair } : {}) } });
    const discoveredTypes = ['components', 'interfaces', 'interfaceIndex'].flatMap(section =>
      (disclosed[section] as Array<{ id?: string; componentId?: string }> | undefined ?? []).map(value => value.componentId ?? value.id!));
    const prompt = buildS2InteractionPrompt({ reply: scope.actions.includes('reply'), edit: editable, executable,
      remainingReads: calls >= S2_INTERACTION_LIMITS.modelCalls - 1 ? 0 : Math.max(0, S2_INTERACTION_LIMITS.readBatches - reads),
      read: availableS2InteractionReads({ components: byComponent, nodes, resultIds: resultNodes.keys(), disclosed,
        guide: description.assistant.instructions.length > 0 || description.purpose.length > 160,
        event: options.origin === 'event' && !!options.event && !options.event.type.startsWith('s2.') && permitted.has(options.event.nodeId) }),
      actions: { add: allowAdd, remove: editable && publicCanvas.nodes.some(node => !pinned.has(node.id)),
        disconnect: editable && publicCanvas.connections.length > 0, connect: allowConnect,
        run: scope.actions.includes('execute') && executable && (publicCanvas.nodes.some(node => executableTypes.has(node.componentId))
          || allowAdd && discoveredTypes.some(id => executableTypes.has(id))),
        cancel: scope.actions.includes('execute') && executable && executions.length > 0 },
      actionGuide: typeof disclosed.actionGuide === 'string' ? disclosed.actionGuide : undefined, repair: !!repair }).system;
    const raw = await options.call(prompt, input, 4096); calls++; check(options.signal);
    let parsed: unknown = raw;
    try {
      if (typeof raw === 'string') parsed = parseJsonLenient(raw);
      const response = readS2InteractionResponse(parsed);
      if (response.read) {
        if (reads >= S2_INTERACTION_LIMITS.readBatches || calls >= S2_INTERACTION_LIMITS.modelCalls) fail('INTERACTION_READ_LIMIT', '/read', '本轮补读机会已用完');
        disclosure.read(response.read);
        reads++; repair = undefined; continue;
      }
      if ((response.reply || !response.actions?.length) && !scope.actions.includes('reply')) fail('INTERACTION_SCOPE', '/reply', '本轮范围不允许对话回复');
      disclosure.assertActions(response.actions ?? []);
      if (response.actions?.length) prepareS2InteractionActions(options.pack,
        { definition: options.definition, document: options.document }, response.actions, scope, options.readOnlyBaseline ?? options.definition.initial);
      return response;
    } catch (error) {
      if (calls >= S2_INTERACTION_LIMITS.modelCalls || (error instanceof InteractionContextError || error instanceof S2InteractionDisclosureError)
        && error.code === 'INTERACTION_READ_LIMIT') throw error;
      // A redundant read does not modify data or interfaces. Remind once using
      // the same four-call ceiling, without consuming the syntax/action repair.
      if (error instanceof S2InteractionDisclosureError && error.code === 'INTERACTION_READ_NO_PROGRESS') {
        if (repeatNoticeUsed || repairUsed) throw error;
        repeatNoticeUsed = true;
      } else {
        if (repairUsed) throw error;
        repairUsed = true;
      }
      const known = error instanceof InteractionContextError || error instanceof S2InteractionActionError || error instanceof S2InteractionDisclosureError
        || error instanceof S2InteractionProtocolError;
      repair = { issue: { code: known ? error.code : 'INTERACTION_RESPONSE',
        path: known && /^\/(actions|read|reply)(\/\d+)?(\/[A-Za-z][A-Za-z0-9_-]*)?$/.test(error.path) ? error.path : '/',
        reason: known ? error.reason : '输出不符合公开交互协议，仅使用reply、actions或read及已读接口' },
        previous: repairCandidate(parsed, byComponent, nodes) };
      if (error instanceof S2InteractionProtocolError && error.path.startsWith('/actions')) repair.syntax =
        '按本轮系统提示和context.actionGuide修复动作结构；语法说明不解锁字段。';
    }
  }
  return fail('INTERACTION_CALL_LIMIT', '/', '本轮交互达到请求上限');
}

/** Only repeat model-proposed public fields. Never echo an arbitrary error,
 * native command, runtime metadata or unbounded output into another request. */
function repairCandidate(raw: unknown, components: Map<string, ReturnType<typeof projectS2AgentComponents>[number]>, nodes: Map<string, S2PublicCanvas['nodes'][number]>) {
  try {
    const value = copy(raw) as Record<string, unknown>;
    if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
    const result: Record<string, unknown> = {};
    const types = new Map([...nodes].map(([id, node]) => [id, node.componentId]));
    if (typeof value.reply === 'string' && value.reply.length <= 6000) result.reply = value.reply;
    const keys: Record<string, string[]> = { addNode: ['type', 'node'], setValues: ['type', 'nodeId', 'values'], removeNode: ['type', 'nodeId'],
      connect: ['type', 'connection'], disconnect: ['type', 'connection'], run: ['type', 'targetNodeIds'], cancel: ['type', 'runId'] };
    if (Array.isArray(value.actions) && value.actions.length <= 12) result.actions = value.actions.flatMap(rawAction => {
      if (!rawAction || typeof rawAction !== 'object' || Array.isArray(rawAction) || typeof rawAction.type !== 'string' || !Object.hasOwn(keys, rawAction.type)) return [];
      const action: Record<string, any> = Object.fromEntries(keys[rawAction.type].filter(key => Object.hasOwn(rawAction, key)).map(key => [key, rawAction[key]]));
      const component = components.get(action.type === 'addNode' ? action.node?.componentId : types.get(action.nodeId) ?? '');
      const values = action.type === 'addNode' ? action.node?.values : action.type === 'setValues' ? action.values : undefined;
      if (values && typeof values === 'object' && !Array.isArray(values)) {
        const filtered = Object.fromEntries(Object.entries(values).filter(([id]) => component?.parameters.some(parameter => parameter.id === id)));
        if (action.type === 'addNode') action.node = { ...action.node, values: filtered }; else action.values = filtered;
      }
      if (action.type === 'addNode' && action.node && typeof action.node === 'object') action.node = Object.fromEntries(
        ['id', 'componentId', 'position', 'label', 'readOnly', 'values'].filter(key => Object.hasOwn(action.node, key)).map(key => [key, action.node[key]]));
      if (action.type === 'addNode' && component && typeof action.node?.id === 'string') types.set(action.node.id, component.id);
      if (action.type === 'removeNode') types.delete(action.nodeId);
      if (action.connection && typeof action.connection === 'object') action.connection = Object.fromEntries(['source', 'target'].filter(key => Object.hasOwn(action.connection, key)).map(key => [key,
        action.connection[key] && typeof action.connection[key] === 'object' ? Object.fromEntries(['nodeId', 'portId'].filter(field => Object.hasOwn(action.connection[key], field)).map(field => [field, action.connection[key][field]])) : action.connection[key]]));
      return [action];
    });
    return size(result) <= 24000 ? result : {};
  } catch { return {}; }
}
