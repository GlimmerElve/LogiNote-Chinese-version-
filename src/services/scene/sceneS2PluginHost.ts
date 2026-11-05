import type { S2Document, S2CanvasDefinition, S2Field } from '../../types/sceneS2';
import type { S2Artifact, S2ExecutionReceipt, S2InteractionFrame, S2Json, S2PluginGrant, S2PluginInvocation, S2PluginObservation, S2PluginOutcome, S2PluginRequest } from '../../types/sceneS2Plugin';
import { assertS2ResourceAccess, canonicalS2Json, createS2Receipt, describeS2PluginOutcome, readS2Artifact, readS2PluginRequest, S2PluginProtocolError, validateS2Invocation, validateS2Outcome } from './sceneS2PluginProtocol';
import { readS2PluginBindings, s2BuiltinPluginRegistry, s2BuiltinPluginInstallation } from './sceneS2PluginRegistry';
import { selectS2Pointer, S2PointerAccessError, readS2StructuredFailureDiagnostic, type S2StructuredFailureDiagnostic } from './sceneS2Structured';
import { isS2ExclusiveMerge } from './sceneS2Merge';
import type { S2LocalAdapter } from './sceneS2PluginInstallation';
import { isRegisteredScenePackLocalAdapter } from './sceneS2PluginInstallation';
import { selectS2Execution, s2SemanticDocument } from './sceneS2Workflow';
import { isS2Human, s2HumanValue, type S2HumanWait } from './sceneS2Human';
import { S2ModelTestSession, type S2ModelTestClosure, type S2ModelTestParameterInput, type S2ModelTestParameters } from './sceneS2ModelTest';
import { bindS2ArtifactContext } from './sceneS2ArtifactAccess';
import { readS2ComputedAssessment, type S2AssessmentReport } from './sceneS2Assessment';
import type { S2Trial, S2TrialAssessment, S2TrialValue } from './sceneS2Trials';
import { readS2Field, validateS2FieldText } from './sceneS2Controls';
import { S2InteractionLog, type S2FieldControlState, type S2ArtifactViewSelection, type S2InteractionEvent, type S2ParameterControlState, type S2JsonTreeSelection, type S2CanvasAction } from './sceneS2Events';
import { s2TableToRecords, type S2Table } from './sceneS2Structured';
import { s2ParameterSource, s2ConditionSource, type S2DraftInputState, type S2SubmitVia, type S2ConditionState } from './sceneS2ControlDrafts';
import { S2TextResource, isS2TextResource, readS2TextSelectionFailure, type S2TextResourceInfo, type S2TextContentFailureReason, type S2TextSelectionFailureReason } from './sceneS2TextResource';
import { S2ProjectNoteSource, S2ProjectNoteResource, isS2ProjectNotes, type S2ProjectNoteResourceInfo, type S2NoteAvailabilityReason, type S2NoteContentFailureReason } from './sceneS2ProjectNotes';
import { S2ImageResource, isS2ImageResource, s2ImageResourceId, MAX_LLM_IMAGE_BYTES, type S2ImageResourceInfo, type S2ImageResourcePreview } from './sceneS2ImageResource';
import { assertS2ReadOnlyContent } from './sceneS2ReadOnly';
import { isS2ModelSessionImplementation } from './sceneS2ModelBridge';

const registry = s2BuiltinPluginRegistry();
const uuid = (prefix: string) => `${prefix}-${crypto.randomUUID()}`;
const isModelSession = (node: { pluginId: string; pluginVersion: string; capabilityId: string }) => {
  try { return isS2ModelSessionImplementation(s2BuiltinPluginInstallation().descriptor(node)); } catch { return false; }
};
type ModelAuthorization = { inputsKey: string; resourceId: string; revision: number; session: S2ModelTestSession; invocationId?: string };
export interface S2ModelWait { id: string; nodeId: string; workflowId: string; revision: number; prompt: string; input: string; model: string; providerLabel: string; maxOutputTokens: number; images?: S2ImageResourcePreview[];
  parameters: S2ModelTestParameters; reservationOutputTokens: number }
export const S2_LOCAL_RUN_LIMIT = 64;
export type S2ModelRequestDiagnostic = { kind: 'model-request'; reason: 'authorization-missing' | 'authorization-closed' | 'budget-exhausted' | 'user-declined' };
export type S2ResourceReadDiagnostic = { kind: 'resource-read'; source: 'file' | 'note'; reason: 'not-approved' | 'revoked' | S2NoteAvailabilityReason | S2TextContentFailureReason | S2NoteContentFailureReason };
export type S2FileSelectionDiagnostic = { kind: 'file-selection'; reason: S2TextSelectionFailureReason };
/** Host scheduling facts and configured condition paths only. No artifact IDs, values, comparison values, permissions or executable instructions. */
export type S2WorkflowDiagnostic =
  | { kind: 'merge-conflict'; candidateCount: number; sourceNodeIds: string[]; boundInput: boolean }
  | { kind: 'upstream-unavailable'; sourceNodeIds: string[] }
  | { kind: 'condition-unavailable'; reason: 'pointer-missing' | 'source-output-unavailable' | 'inline-data-unavailable';
    sourceNodeId: string; sourcePortId: string; pointer: string }
  | S2StructuredFailureDiagnostic | S2ModelRequestDiagnostic | S2ResourceReadDiagnostic;
const ARTIFACT_LIMIT = 1024;
export interface S2LocalExecution {
  request: S2PluginRequest;
  receipt: S2ExecutionReceipt;
  observation: S2PluginObservation;
  artifacts: S2Artifact[];
  resource?: S2TextResourceInfo | S2ProjectNoteResourceInfo | S2ImageResourceInfo;
}
/** Discovery metadata only, never a complete result, read grant or execution request. */
export interface S2OutputIndexEntry {
  nodeId: string; portId: string; type: S2Artifact['type'];
  state: 'not-attempted' | 'unavailable' | 'available'; artifactIds: string[];
}
type RecordEntry = { request: S2PluginRequest; invocation: S2PluginInvocation; outcome: S2PluginOutcome; receipt: S2ExecutionReceipt; sequence: number; model?: S2Trial['model']; resource?: S2TextResourceInfo | S2ProjectNoteResourceInfo | S2ImageResourceInfo; structuredDiagnostic?: S2StructuredFailureDiagnostic; resourceDiagnostic?: S2ResourceReadDiagnostic };
/** Backwards-compatible trusted test seam, never populated from scene/model data. */
export type { S2LocalAdapter } from './sceneS2PluginInstallation';
export { executeS2JsonCheck } from './sceneS2JsonCheck';
const executeBuiltin: S2LocalAdapter = (call, inputs, signal) => s2BuiltinPluginInstallation().execute(call, inputs, signal);
export interface S2WorkflowRun {
  id: string; revision: number; targets: string[];
  status: 'queued' | 'running' | 'waiting' | 'succeeded' | 'failed' | 'cancelled';
  publication: 'current' | 'stale';
  force?: boolean;
  waiting?: S2HumanWait[];
  /** Public identity only. Full approved request text is exposed separately to the local confirmation UI. */
  modelWaiting?: Array<{ id: string; nodeId: string }>;
  nodes: Array<{ nodeId: string; status: 'pending' | 'running' | 'waiting' | 'succeeded' | 'cached' | 'displayed' | 'skipped' | 'failed' | 'blocked' | 'cancelled'; artifactIds: string[]; invocationId?: string; cacheReuseId?: string; error?: string;
    diagnostic?: S2WorkflowDiagnostic;
    humanEvidence?: { waitId: string; artifactId: string; origin: 'user'; approved?: boolean };
    conditionEvidence?: { artifactId: string; type: S2Artifact['type']; pointer: string; matched: boolean; simulation: boolean };
    mergeEvidence?: { candidateArtifactIds: string[]; skippedNodeIds: string[]; blockedNodeIds: string[]; selectedArtifactId?: string; selectedNodeId?: string; simulation: boolean } }>;
  error?: string;
}

/** Per-run, bounded IN-MEMORY store and ledger. Never writes scene files or S4 state.
 * No generic external/resource APIs, dynamic adapter imports or automatic retries.
 * The separately authorized model session is the only model-test transport; explicit DAG requests schedule work.
 */
export class S2PluginHost {
  readonly runId = uuid('run');
  private interactionLog: S2InteractionLog;
  private fieldControlKeys = new Map<string, string>();
  private viewKeys = new Map<string, string>();
  private controlKeys = new Map<string, string>();
  private canvasSelectionKey = '';
  private canvasWriteSequence = 0;
  private canvasDocumentKey = '';
  private canvasOperations = new WeakMap<object, { document: S2Document; sequence: number; revision: number }>();
  private revision = 0;
  private active = true;
  private document: S2Document = { nodes: [], edges: [] };
  private authoredDocument?: S2Document;
  private documentKey = '';
  private artifacts = new Map<string, S2Artifact>();
  private fields = new Map<string, string>();
  private fieldSources = new Map<string, { nodeId: string; fieldId: string }>();
  private fieldPolicies?: Map<string, Map<string, S2Field>>;
  private latestOutputs = new Map<string, { token: string; outputs: Record<string, string[]> }>();
  private entries: RecordEntry[] = [];
  private trialAssessments = new Map<string, { records: S2TrialAssessment[]; omitted: number }>();
  private recordedAssessments = new WeakSet<object>();
  private assessmentStandards = new Map<string, string>();
  private jobs = new Map<string, { fingerprint: string; promise: Promise<S2LocalExecution> }>();
  private controllers = new Set<AbortController>();
  private reservedArtifacts = 0;
  private reservedInvocations = new Map<string, S2PluginInvocation>();
  private workflows: Array<{ record: S2WorkflowRun; controller: AbortController; activeSegment: boolean; schedule: () => void; finish: () => void; notify: () => void; outputs: Map<string, Record<string, string[]>>; modelApprovals: Map<string, ModelAuthorization> }> = [];
  private queueTail: Promise<void> = Promise.resolve();
  private workflowFrames = new WeakSet<S2InteractionFrame>();
  private modelFrames = new WeakMap<S2InteractionFrame, ModelAuthorization>();
  private modelSession: S2ModelTestSession | null = null;
  private modelPreflightEpoch = 0;
  private modelPreflights = new WeakMap<object, { revision: number; epoch: number; nodeId: string; diagnostic: S2ModelRequestDiagnostic }>();
  private textResources = new Map<string, S2TextResource>();
  private imageResources = new Map<string, S2ImageResource>();
  private imageSelectionEpoch = 0;
  private modelImageControllers = new Map<string, Set<AbortController>>();
  private projectNoteSource?: S2ProjectNoteSource;
  private projectNoteResources = new Map<string, S2ProjectNoteResource>();
  private resourceControllers = new Map<string, Set<AbortController>>();
  private resourceEpoch = 0;
  private revokedResources = new Map<string, 'file' | 'note'>();
  private resourceRevocations = new WeakSet<AbortController>();
  private resourceFailures = new WeakMap<object, { nodeId: string; revision: number; epoch: number; diagnostic: S2ResourceReadDiagnostic }>();
  private resourceDiagnosticEpochs = new WeakMap<object, number>();
  private fileSelectionEpoch = 0;
  private fileSelectionFailures = new WeakMap<object, { epoch: number; resourceEpoch: number; diagnostic: S2FileSelectionDiagnostic }>();
  private unsubscribeModelClosed?: () => void;
  private modelWaits = new Map<string, { view: S2ModelWait; inputs: Record<string, string[]>; inputsKey: string; session: S2ModelTestSession }>();
  private cache = new Map<string, RecordEntry>();
  private reuses: Array<{ id: string; revision: number; nodeId: string; signature: string; sourceInvocationId: string; outputs: Record<string, string[]> }> = [];
  private grant: S2PluginGrant;
  constructor(private sceneId: string, selection: S2CanvasDefinition['plugins'] | (Pick<S2CanvasDefinition, 'plugins' | 'blockTypes'> & Partial<Pick<S2CanvasDefinition, 'initial'>>), private adapter: S2LocalAdapter = executeBuiltin,
    private readonly validateCanvasDocument?: (document: S2Document) => void) {
    this.interactionLog = new S2InteractionLog(sceneId, this.runId);
    // Plugin-array callers are the legacy host seam (no field declarations). Production scenes supply their full frozen field policy.
    const definition = selection && !Array.isArray(selection) ? selection : undefined;
    if (definition) {
      if (definition.initial !== undefined) this.authoredDocument = structuredClone(definition.initial);
      if (!Array.isArray(definition.blockTypes) || !definition.blockTypes.length || definition.blockTypes.length > 8) throw new Error('执行宿主需要有效的块类型声明');
      this.fieldPolicies = new Map(definition.blockTypes.map(type => {
        if (typeof type.id !== 'string' || !/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(type.id) || ['__proto__', 'prototype', 'constructor'].includes(type.id)
          || !Array.isArray(type.fields) || !type.fields.length || type.fields.length > 8) throw new Error('执行宿主字段策略无效');
        const fields = type.fields.map(field => readS2Field(field));
        if (new Set(fields.map(field => field.id)).size !== fields.length) throw new Error('执行宿主字段重复');
        return [type.id, new Map(fields.map(field => [field.id, field]))];
      }));
      if (this.fieldPolicies.size !== definition.blockTypes.length) throw new Error('执行宿主块类型重复');
    }
    const plugins = definition ? definition.plugins : selection as S2CanvasDefinition['plugins'];
    this.grant = { sceneId, runId: this.runId, revision: 0, remainingCalls: S2_LOCAL_RUN_LIMIT,
      capabilities: readS2PluginBindings(plugins ?? []), permissions: [], resourceScopes: [], readableArtifactIds: [], confirmedInvocationIds: [] };
  }
  private context() { return { sceneId: this.sceneId, runId: this.runId, revision: this.revision, active: this.active }; }
  private requireActive() { if (!this.active) throw new S2PluginProtocolError('RUN_ENDED', 'run', '本局已结束，不能执行插件'); }
  /** Revision is monotonic, even after undo restores the same content. Ledger/budget never rewind. */
  setDocument(document: S2Document) {
    this.validateCanvasDocument?.(document);
    this.requireActive();
    const next = structuredClone(document);
    if (this.authoredDocument) assertS2ReadOnlyContent(this.authoredDocument, next, { requirePresence: true });
    assertS2ReadOnlyContent(this.document, next);
    const canvasKey = canonicalS2Json(next as unknown as S2Json);
    const key = canonicalS2Json(s2SemanticDocument(next));
    // Legacy plugin-array callers freeze their baseline only after the first document is accepted.
    this.authoredDocument ??= structuredClone(next);
    if (canvasKey !== this.canvasDocumentKey) { this.canvasWriteSequence++; this.canvasDocumentKey = canvasKey; }
    this.document = next;
    if (key === this.documentKey) return;
    this.documentKey = key; this.revision++; this.grant.revision = this.revision; this.fields.clear(); this.latestOutputs.clear();
    this.interactionLog.append({ kind: 'canvas-revised' }, this.revision, 'host');
    for (const job of this.workflows) this.cancelWorkflow(job.record.id);
  }
  close() { this.active = false; this.imageSelectionEpoch++; this.imageResources.clear(); this.textResources.clear(); this.projectNoteResources.clear(); this.projectNoteSource = undefined; this.unsubscribeModelClosed?.(); this.unsubscribeModelClosed = undefined; this.modelSession?.close(); this.modelWaits.clear(); this.grant.capabilities = []; this.grant.permissions = []; this.grant.resourceScopes = []; for (const controller of this.controllers) controller.abort(); for (const job of this.workflows) this.cancelWorkflow(job.record.id); }
  get remainingCalls() { return this.grant.remainingCalls; }
  get resourceSelectionVersion() { return this.resourceEpoch; }
  /** Local UI facts only. Neither selections nor operation tickets can authorize execution. */
  recordCanvasSelection(raw: string[]) {
    this.requireActive();
    const all = new Set([...this.document.nodes, ...(this.document.execution?.nodes ?? [])].map(node => node.id));
    if (!Array.isArray(raw) || raw.length > 80 || Reflect.ownKeys(raw).length !== raw.length + 1
      || Array.from({ length: raw.length }, (_, index) => Object.getOwnPropertyDescriptor(raw, String(index)))
        .some(property => !property || !property.enumerable || !('value' in property) || typeof property.value !== 'string' || !all.has(property.value))
      || new Set(raw).size !== raw.length) throw new Error('选区必须属于当前画布，不能包含组代理或结果节点');
    const nodeIds = [...raw].sort(), key = JSON.stringify([this.revision, nodeIds]);
    if (key === this.canvasSelectionKey) return;
    this.canvasSelectionKey = key;
    this.interactionLog.append({ kind: 'canvas-selection', nodeIds }, this.revision, 'user-control');
  }
  beginCanvasOperation(): object {
    this.requireActive();
    const ticket = Object.freeze({});
    this.canvasOperations.set(ticket, { document: structuredClone(this.document), sequence: this.canvasWriteSequence, revision: this.revision });
    return ticket;
  }
  recordCanvasOperation(ticket: object, action: S2CanvasAction, via: 'control' | 'canvas') {
    this.requireActive();
    const source = this.canvasOperations.get(ticket); this.canvasOperations.delete(ticket);
    if (!source || !['move', 'copy', 'delete', 'group', 'ungroup', 'collapse', 'expand', 'undo', 'redo'].includes(action)
      || !['control', 'canvas'].includes(via)) throw new Error('画布操作来源无效或已消费');
    if (source.sequence === this.canvasWriteSequence) return;
    // A gesture can contain many position updates; every other UI operation is one atomic document write.
    if (action !== 'move' && source.sequence + 1 !== this.canvasWriteSequence) throw new Error('画布操作期间已有其他变化，未归因于本次操作');
    const before = source.document, after = this.document, json = (value: unknown) => canonicalS2Json(value as S2Json);
    const effect = json(s2SemanticDocument(before)) === json(s2SemanticDocument(after)) ? 'layout' as const : 'content' as const;
    const oldNodes = new Map([...before.nodes, ...(before.execution?.nodes ?? [])].map(node => [node.id, node]));
    const newNodes = new Map([...after.nodes, ...(after.execution?.nodes ?? [])].map(node => [node.id, node]));
    const oldGroups = new Map((before.groups ?? []).map(group => [group.id, group])), newGroups = new Map((after.groups ?? []).map(group => [group.id, group]));
    const nodeIds = [...new Set([...oldNodes.keys(), ...newNodes.keys()])].filter(id => json(oldNodes.get(id) ?? null) !== json(newNodes.get(id) ?? null)).sort();
    const groupIds = [...new Set([...oldGroups.keys(), ...newGroups.keys()])].filter(id => json(oldGroups.get(id) ?? null) !== json(newGroups.get(id) ?? null)).sort();
    if (!nodeIds.length && !groupIds.length && json(before) === json(after)) return;
    if (['move', 'group', 'ungroup', 'collapse', 'expand'].includes(action) && (effect !== 'layout' || source.revision !== this.revision)) throw new Error('布局操作不能冒充执行语义变化');
    if (action === 'move' && (groupIds.length || !nodeIds.length)) throw new Error('移动操作需要真实位置变化');
    if (['group', 'ungroup', 'collapse', 'expand'].includes(action) && (nodeIds.length || !groupIds.length)) throw new Error('分组操作与当前变化不符');
    if (action === 'group' && groupIds.some(id => oldGroups.has(id) || !newGroups.has(id))
      || action === 'ungroup' && groupIds.some(id => !oldGroups.has(id) || newGroups.has(id))
      || ['collapse', 'expand'].includes(action) && groupIds.some(id => {
        const old = oldGroups.get(id), next = newGroups.get(id);
        return !old || !next || old.collapsed === next.collapsed || next.collapsed !== (action === 'collapse')
          || json({ ...old, collapsed: next.collapsed }) !== json(next);
      })
      || action === 'copy' && (!nodeIds.some(id => !oldNodes.has(id)) || nodeIds.some(id => oldNodes.has(id)))
      || action === 'delete' && (!nodeIds.some(id => !newNodes.has(id)) || nodeIds.some(id => !oldNodes.has(id)))) throw new Error('画布操作与实际提交结果不一致');
    this.interactionLog.append({ kind: 'canvas-operation', action, effect, nodeIds, groupIds, via }, this.revision, 'user-control');
  }
  /** Trusted local control callback only. Metadata never contains an unsubmitted draft body. */
  recordFieldControl(nodeId: string, fieldId: string, baseValue: string, state: S2FieldControlState) {
    this.requireActive();
    if (!['editing', 'invalid', 'conflict', 'reloaded', 'submitted', 'committed'].includes(state) || typeof baseValue !== 'string') throw new Error('字段控件状态无效');
    const node = this.document.nodes.find(node => node.id === nodeId), field = node && this.fieldPolicies?.get(node.type)?.get(fieldId);
    if (!node || !field || !Object.hasOwn(node.values, fieldId)) throw new Error('字段控件不属于当前声明');
    if (baseValue !== node.values[fieldId]) state = 'conflict';
    if (state === 'submitted') validateS2FieldText(field, node.values[fieldId], false);
    const key = JSON.stringify([nodeId, fieldId]), signature = JSON.stringify([this.revision, state]);
    if (this.fieldControlKeys.get(key) === signature) return;
    if (this.fieldControlKeys.size >= 320 && !this.fieldControlKeys.has(key)) this.fieldControlKeys.delete(this.fieldControlKeys.keys().next().value!);
    this.fieldControlKeys.set(key, signature);
    this.interactionLog.append({ kind: 'field-control', nodeId, fieldId, state }, this.revision, 'user-control');
  }
  private changedControl(key: string, state: string, via?: S2SubmitVia) {
    const signature = JSON.stringify([this.revision, state, via]);
    if (this.controlKeys.get(key) === signature) return false;
    if (this.controlKeys.size >= 320 && !this.controlKeys.has(key)) this.controlKeys.delete(this.controlKeys.keys().next().value!);
    this.controlKeys.set(key, signature); return true;
  }
  recordParameterControl(nodeId: string, portId: string, base: string, state: S2ParameterControlState, via?: S2SubmitVia) {
    this.requireActive();
    if (!['editing', 'invalid', 'conflict', 'reloaded', 'submitted', 'committed', 'referenced', 'cleared'].includes(state) || typeof base !== 'string'
      || via !== undefined && !['form', 'shortcut'].includes(via)) throw new Error('参数控件状态无效');
    const source = s2ParameterSource(this.document, nodeId, portId), node = this.document.execution!.nodes.find(node => node.id === nodeId)!;
    if (!this.grant.capabilities.some(cap => cap.pluginId === node.pluginId && cap.pluginVersion === node.pluginVersion && cap.capabilityId === node.capabilityId)) throw new Error('参数能力不在当前批准范围');
    // Selecting an output is a valid reference; multiple inputs may also retain
    // a literal alongside wires. Connected inputs still reject stale editor states.
    if (base !== source.key || source.connected && !['referenced', 'committed'].includes(state)) state = 'conflict';
    if (['submitted', 'committed'].includes(state) && node.bindings[portId]?.kind !== 'literal'
      || state === 'referenced' && !source.connected && node.bindings[portId]?.kind !== 'field'
      || state === 'cleared' && Object.hasOwn(node.bindings, portId)) throw new Error('参数状态与当前真实绑定不一致');
    if (!this.changedControl(JSON.stringify(['parameter', nodeId, portId]), state, via)) return;
    this.interactionLog.append({ kind: 'parameter-control', nodeId, portId, state, ...(via ? { via } : {}) }, this.revision, 'user-control');
  }
  recordConditionControl(nodeId: string, base: string, state: S2ConditionState, via?: S2SubmitVia) {
    this.requireActive();
    if (!['editing', 'invalid', 'conflict', 'reloaded', 'submitted', 'cleared'].includes(state) || typeof base !== 'string'
      || via !== undefined && !['form', 'shortcut'].includes(via)) throw new Error('条件控件状态无效');
    const source = s2ConditionSource(this.document, nodeId), node = this.document.execution!.nodes.find(node => node.id === nodeId)!;
    if (!this.grant.capabilities.some(cap => cap.pluginId === node.pluginId && cap.pluginVersion === node.pluginVersion && cap.capabilityId === node.capabilityId)) throw new Error('条件目标不在当前批准范围');
    if (source.key !== base) state = 'conflict';
    if (state === 'submitted' && !node.when || state === 'cleared' && node.when) throw new Error('条件状态与当前真实条件不一致');
    if (!this.changedControl(JSON.stringify(['condition', nodeId]), state, via)) return;
    this.interactionLog.append({ kind: 'condition-control', nodeId, state, ...(via ? { via } : {}) }, this.revision, 'user-control');
  }
  recordHumanControl(workflowId: string, waitId: string, state: S2DraftInputState, via?: S2SubmitVia) {
    this.requireActive();
    if (!['editing', 'invalid', 'reloaded'].includes(state) || via !== undefined && !['form', 'shortcut'].includes(via)) throw new Error('人工输入草稿状态无效');
    // Draft keystrokes inspect wait identity only, never clone/read complete upstream bodies.
    const job = this.workflows.find(job => job.record.id === workflowId && !job.controller.signal.aborted && job.record.revision === this.revision
      && ['queued', 'running', 'waiting'].includes(job.record.status));
    const wait = job?.record.waiting?.find(wait => wait.id === waitId);
    if (!wait) throw new Error('人工输入等待已失效，不能记录新的草稿动作');
    if (!this.changedControl(JSON.stringify(['human', workflowId, waitId]), state, via)) return;
    this.interactionLog.append({ kind: 'human-control', workflowId, waitId, nodeId: wait.nodeId, state, ...(via ? { via } : {}) }, this.revision, 'user-control');
  }
  private projectInteractionEvent(event: S2InteractionEvent): S2InteractionEvent {
    if (event.kind !== 'human-control') return event;
    return { ...event, waitActive: this.active && this.workflows.some(job => !job.controller.signal.aborted && job.record.revision === this.revision
      && job.record.id === event.workflowId && ['queued', 'running', 'waiting'].includes(job.record.status)
      && job.record.waiting?.some(wait => wait.id === event.waitId)) };
  }
  /** A view action only records a real current table's legal axes. It never reads another resource or runs a plugin. */
  recordArtifactView(artifactId: string, raw: S2ArtifactViewSelection) {
    this.requireActive();
    const artifact = this.currentArtifact(artifactId);
    if (artifact.type.id !== 'structured-data.table' || artifact.payload.kind !== 'inline') throw new Error('图表事件需要当前完整表格产物');
    if (!raw || typeof raw !== 'object' || ![Object.prototype, null].includes(Object.getPrototypeOf(raw))
      || Reflect.ownKeys(raw).length !== 3 || Reflect.ownKeys(raw).some(key => typeof key !== 'string' || !['kind', 'xKey', 'yKey'].includes(key))
      || Object.values(Object.getOwnPropertyDescriptors(raw)).some(property => !property.enumerable || !('value' in property))
      || !['none', 'bar', 'line'].includes(raw.kind)) throw new Error('图表选择无效');
    const table = artifact.payload.value as unknown as S2Table, rows = s2TableToRecords(table) as Array<Record<string, S2Json>>;
    if (!table.columns.includes(raw.xKey) || !table.columns.includes(raw.yKey)
      || !rows.some(row => Object.hasOwn(row, raw.yKey) && typeof row[raw.yKey] === 'number')
      || !rows.every(row => !Object.hasOwn(row, raw.yKey) || row[raw.yKey] === null || typeof row[raw.yKey] === 'number')) throw new Error('图表列不符合当前产物');
    const view = { kind: raw.kind, xKey: raw.xKey, yKey: raw.yKey }, signature = canonicalS2Json(view);
    if (this.viewKeys.get(artifactId) === signature) return;
    if (this.viewKeys.size >= 128 && !this.viewKeys.has(artifactId)) this.viewKeys.delete(this.viewKeys.keys().next().value!);
    this.viewKeys.set(artifactId, signature);
    this.interactionLog.append({ kind: 'artifact-view', artifactId, nodeId: artifact.source.nodeId, view }, this.revision, 'user-control');
  }
  recordJsonTreeView(artifactId: string, selection: S2JsonTreeSelection) {
    this.requireActive();
    const artifact = this.currentArtifact(artifactId);
    if (artifact.type.id !== 'structured-data.value' || artifact.payload.kind !== 'inline'
      || !selection || typeof selection !== 'object' || ![Object.prototype, null].includes(Object.getPrototypeOf(selection))
      || Reflect.ownKeys(selection).length !== 2 || Reflect.ownKeys(selection).some(key => typeof key !== 'string' || !['pointer', 'open'].includes(key))
      || Object.values(Object.getOwnPropertyDescriptors(selection)).some(property => !property.enumerable || !('value' in property))
      || typeof selection.pointer !== 'string' || selection.pointer.length > 2048 || typeof selection.open !== 'boolean') throw new Error('JSON 树事件需要当前完整产物和合法展开状态');
    const value = selectS2Pointer(artifact.payload.value, selection.pointer);
    if (!value || typeof value !== 'object') throw new Error('只能展开真实存在的对象或数组');
    const key = JSON.stringify(['tree', artifactId, selection.pointer]), signature = String(selection.open);
    if (this.viewKeys.get(key) === signature) return;
    if (this.viewKeys.size >= 128 && !this.viewKeys.has(key)) this.viewKeys.delete(this.viewKeys.keys().next().value!);
    this.viewKeys.set(key, signature);
    this.interactionLog.append({ kind: 'json-tree-view', artifactId, nodeId: artifact.source.nodeId, pointer: selection.pointer, open: selection.open }, this.revision, 'user-control');
  }
  /** Only the local user approval handler supplies a branded, frozen-provider session. Never scene JSON or an Agent command. */
  approveModelTestSession(session: S2ModelTestSession) {
    this.requireActive();
    if (this.modelSession) throw new Error('本局模型预算已设置，不能替换或重置；重新授权需开启新局');
    if (!(session instanceof S2ModelTestSession) || !session.summary().active || session.sceneId !== this.sceneId || session.runId !== this.runId) throw new Error('模型测试授权不属于本局或已经失效');
    if (!this.grant.capabilities.some(isModelSession)) throw new Error('本场景未装配模型测试能力，不能新增模型权限');
    session.bindImageResolver(refs => this.resolveModelImages(refs));
    this.modelSession = session; this.grant.permissions.push('model-call');
    this.grant.resourceScopes.push({ permission: 'model-call', resourceIds: [session.resourceId] });
    this.unsubscribeModelClosed = session.subscribeClosed(reason => this.settleClosedModelSession(session, reason));
  }
  modelTestSummary() { return this.modelSession?.summary() ?? null; }
  private refreshFileGrant() {
    const ids = [...this.textResources.keys(), ...this.imageResources.keys()];
    this.grant.resourceScopes = this.grant.resourceScopes.filter(scope => scope.permission !== 'file-read');
    this.grant.permissions = this.grant.permissions.filter(permission => permission !== 'file-read');
    if (ids.length) { this.grant.permissions.push('file-read'); this.grant.resourceScopes.push({ permission: 'file-read', resourceIds: ids }); }
  }
  /** Explicit native file-picker action. Finishing an old selection never grants access in a closed run. */
  async approveImageFile(file: File): Promise<S2ImageResourceInfo> {
    this.requireActive();
    if (!this.grant.capabilities.some(isS2ImageResource)) throw new Error('本场景未装配图片资料组件。');
    const epoch = ++this.imageSelectionEpoch, resource = await S2ImageResource.select(file);
    this.requireActive();
    if (epoch !== this.imageSelectionEpoch) throw new Error('图片选择已被后续选择或撤回取代，未接入本局。');
    const info = resource.info(), total = [...this.imageResources.values()].reduce((bytes, item) => bytes + item.info().bytes, info.bytes);
    if (this.imageResources.size >= 6 || total > MAX_LLM_IMAGE_BYTES) throw new Error('本局最多选择6张图片、合计4MiB，请先撤回不再使用的图片。');
    this.imageResources.set(info.id, resource); this.refreshFileGrant(); this.resourceEpoch++; return info;
  }
  imageResourceSummary(): S2ImageResourceInfo[] { return this.active ? [...this.imageResources.values()].map(resource => resource.info()) : []; }
  imageResourcePreview(id: string): S2ImageResourcePreview {
    this.requireActive(); const resource = this.imageResources.get(id);
    if (!resource) throw new Error('图片已撤回或不属于本局。');
    return resource.preview();
  }
  revokeImageFile(id: string) {
    this.requireActive();
    if (!this.imageResources.delete(id)) throw new Error('图片已经撤回或不属于本局。');
    this.imageSelectionEpoch++; this.resourceEpoch++; this.revokedResources.set(id, 'file'); this.refreshFileGrant();
    for (const controller of this.resourceControllers.get(id) ?? []) controller.abort();
    for (const controller of this.modelImageControllers.get(id) ?? []) controller.abort();
    for (const wait of [...this.modelWaits.values()]) if (wait.view.images?.some(image => image.id === id)) this.cancelWorkflow(wait.view.workflowId);
  }
  private resolveModelImages(refs: S2Json[]) {
    this.requireActive();
    if (refs.length > 1) throw new Error('一次模型试验只支持一张原始图片。');
    return refs.map(ref => {
      const id = s2ImageResourceId(ref), resource = this.imageResources.get(id);
      if (!resource || !this.grant.permissions.includes('file-read') || !this.grant.resourceScopes.some(scope => scope.permission === 'file-read' && scope.resourceIds.includes(id))) throw new Error('图片未选择、已经撤回或不属于本局；不使用旧模板或任意句柄发送。');
      return resource.image();
    });
  }
  private modelImages(inputs: Record<string, string[]>): S2Json[] {
    return (inputs.image ?? []).map(id => {
      const artifact = this.currentArtifact(id);
      if (artifact.type.id !== 'core.image' || artifact.type.version !== 1 || artifact.payload.kind !== 'inline') throw new Error('模型图片输入需要本局完整原图句柄。');
      return artifact.payload.value;
    });
  }
  private modelParameters(inputs: Record<string, string[]>): S2ModelTestParameterInput {
    return Object.fromEntries(['maxOutputTokens', 'temperature', 'thinkingMode'].flatMap(portId => {
      const ids = inputs[portId] ?? [];
      if (ids.length > 1) throw new Error('模型参数每项只能有一个完整值');
      return ids.map(id => {
        const artifact = this.currentArtifact(id), expectedType = portId === 'thinkingMode' ? 'core.text' : 'core.number';
        if (artifact.type.id !== expectedType || artifact.type.version !== 1 || artifact.payload.kind !== 'inline') throw new Error('模型参数必须是类型匹配的完整值');
        return [portId, artifact.payload.value];
      });
    })) as S2ModelTestParameterInput;
  }
  /** Local user file-picker approval only. No path interpretation and no read/dispatch here. */
  approveTextFile(file: File): S2TextResourceInfo {
    this.requireActive();
    this.fileSelectionEpoch++;
    if (!this.grant.capabilities.some(isS2TextResource)) throw new Error('本场景未装配文本资料读取能力。');
    if (this.textResources.size >= 4) throw new Error('本局最多同时提供4份资料，请先撤回不再使用的资料。');
    let resource: S2TextResource;
    try { resource = new S2TextResource(file); }
    catch (error) {
      const reason = readS2TextSelectionFailure(error);
      if (reason && error && typeof error === 'object') this.fileSelectionFailures.set(error,
        { epoch: this.fileSelectionEpoch, resourceEpoch: this.resourceEpoch, diagnostic: { kind: 'file-selection', reason } });
      throw error;
    }
    const info = resource.info(); this.textResources.set(info.id, resource);
    this.refreshFileGrant();
    this.resourceEpoch++; return info;
  }
  textResourceSummary(): S2TextResourceInfo[] { return this.active ? [...this.textResources.values()].map(resource => resource.info()) : []; }
  /** Exact local selection failure, never permission to open a picker, read or replace an input. */
  readTextFileSelectionDiagnostic(error: unknown): S2FileSelectionDiagnostic | null {
    const entry = error && typeof error === 'object' ? this.fileSelectionFailures.get(error) : undefined;
    return this.active && entry?.epoch === this.fileSelectionEpoch && entry.resourceEpoch === this.resourceEpoch ? structuredClone(entry.diagnostic) : null;
  }
  revokeTextFile(id: string) {
    this.requireActive();
    if (!this.textResources.delete(id)) throw new Error('资料已经撤回或不属于本局。');
    this.resourceEpoch++; this.revokedResources.set(id, 'file');
    for (const controller of this.resourceControllers.get(id) ?? []) { this.resourceRevocations.add(controller); controller.abort(); }
    this.refreshFileGrant();
  }
  /** A frozen app-issued project ceiling, not a grant. Bound once by the local start handler. */
  bindProjectNotes(source: S2ProjectNoteSource) {
    this.requireActive();
    if (this.projectNoteSource || this.entries.length || this.workflows.length) throw new Error('项目笔记入口必须在运行开始时绑定，不能在本局中替换范围。');
    if (!(source instanceof S2ProjectNoteSource) || !this.grant.capabilities.some(isS2ProjectNotes)) throw new Error('没有本地项目笔记入口或未装配笔记读取能力。');
    this.projectNoteSource = source;
  }
  projectNoteChoices() { return this.active ? this.projectNoteSource?.choices() ?? [] : []; }
  approveProjectNote(noteId: string): S2ProjectNoteResourceInfo {
    this.requireActive();
    if (!this.projectNoteSource || !this.grant.capabilities.some(isS2ProjectNotes)) throw new Error('本局没有已绑定的项目笔记入口。');
    if (this.projectNoteResources.size >= 4) throw new Error('本局最多同时允许4份笔记，请先撤回不再使用的笔记。');
    if ([...this.projectNoteResources.values()].some(resource => resource.info().noteId === noteId)) throw new Error('这份笔记已允许；如需新版本，请先撤回再选择。');
    const resource = new S2ProjectNoteResource(this.projectNoteSource, noteId), info = resource.info(); this.projectNoteResources.set(info.id, resource);
    if (!this.grant.permissions.includes('notes-read')) this.grant.permissions.push('notes-read');
    this.grant.resourceScopes = this.grant.resourceScopes.filter(scope => scope.permission !== 'notes-read');
    this.grant.resourceScopes.push({ permission: 'notes-read', resourceIds: [...this.projectNoteResources.keys()] });
    this.resourceEpoch++; return info;
  }
  projectNoteSummary(): Array<S2ProjectNoteResourceInfo & { available: boolean }> {
    return this.active ? [...this.projectNoteResources.values()].map(resource => {
      let available = true; try { resource.assertAvailable(); } catch { available = false; }
      return { ...resource.info(), available };
    }) : [];
  }
  revokeProjectNote(id: string) {
    this.requireActive();
    if (!this.projectNoteResources.delete(id)) throw new Error('笔记已经撤回或不属于本局。');
    this.resourceEpoch++; this.revokedResources.set(id, 'note');
    for (const controller of this.resourceControllers.get(id) ?? []) { this.resourceRevocations.add(controller); controller.abort(); }
    this.grant.resourceScopes = this.grant.resourceScopes.filter(scope => scope.permission !== 'notes-read');
    if (this.projectNoteResources.size) this.grant.resourceScopes.push({ permission: 'notes-read', resourceIds: [...this.projectNoteResources.keys()] });
    else this.grant.permissions = this.grant.permissions.filter(permission => permission !== 'notes-read');
  }
  revokeModelTests() {
    this.modelSession?.close();
  }
  /** Retire only unstarted model nodes. Running calls keep their real receipts;
   * unrelated local/human branches use the existing dependency scheduler. */
  private settleClosedModelSession(session: S2ModelTestSession, reason: S2ModelTestClosure) {
    if (session !== this.modelSession) return;
    this.grant.permissions = this.grant.permissions.filter(permission => permission !== 'model-call');
    this.grant.resourceScopes = this.grant.resourceScopes.filter(scope => scope.permission !== 'model-call');
    for (const [id, wait] of this.modelWaits) if (wait.session === session) this.modelWaits.delete(id);
    if (!this.active) return;
    for (const job of this.workflows) {
      if (!['queued', 'running', 'waiting'].includes(job.record.status) || job.controller.signal.aborted || job.record.revision !== this.revision) continue;
      let changed = false;
      for (const node of job.record.nodes) {
        const installed = this.document.execution?.nodes.find(item => item.id === node.nodeId);
        if (!installed || !isModelSession(installed)) continue;
        job.modelApprovals.delete(node.nodeId);
        if (['pending', 'waiting'].includes(node.status)) {
          node.status = 'failed'; node.error = reason.message; node.diagnostic = { kind: 'model-request', reason: 'authorization-closed' }; changed = true;
        }
      }
      job.record.modelWaiting = [];
      if (!changed) continue;
      job.record.error ??= reason.message;
      if (!job.activeSegment) job.schedule();
      job.notify();
    }
  }
  private store(artifact: S2Artifact) {
    const checked = readS2Artifact(registry, artifact);
    if (this.artifacts.has(checked.id) || this.artifacts.size + this.reservedArtifacts >= ARTIFACT_LIMIT) throw new S2PluginProtocolError('STORE_LIMIT', 'artifacts', '本局数据存储已达上限，请结束并开启新试验');
    this.artifacts.set(checked.id, structuredClone(checked)); this.grant.readableArtifactIds.push(checked.id);
  }
  /** Only the selected node's complete field snapshots are offered as tool input. */
  prepare(selectedId: string | null, strategy: S2InteractionFrame['strategy'], text: string) {
    this.requireActive();
    const node = this.document.nodes.find(item => item.id === selectedId);
    const bindings = node ? Object.entries(node.values).map(([fieldId, value]) => {
      const key = JSON.stringify([node.id, fieldId]);
      let artifactId = this.fields.get(key);
      if (!artifactId) {
        artifactId = uuid('artifact');
        this.store({ protocolVersion: 1, id: artifactId, type: { id: 'core.text', version: 1 }, complete: true,
          source: { sceneId: this.sceneId, runId: this.runId, nodeId: node.id, revision: this.revision, kind: 'host' }, payload: { kind: 'inline', value } });
        this.fields.set(key, artifactId);
        this.fieldSources.set(artifactId, { nodeId: node.id, fieldId });
      }
      return { nodeId: node.id, fieldId, artifactId };
    }) : [];
    const executionNode = this.document.execution?.nodes.find(node => node.id === selectedId);
    if (executionNode) for (const portId of Object.keys(executionNode.bindings)) bindings.push({ nodeId: executionNode.id, fieldId: portId, artifactId: this.boundInput(executionNode.id, portId) });
    const ledger = this.history(), workflowRecords = this.workflowHistory();
    const humanInputs = workflowRecords.filter(run => run.publication === 'current').flatMap(run => run.nodes.flatMap(node => {
      if (!node.humanEvidence) return [];
      const artifact = this.currentArtifact(node.humanEvidence.artifactId), full = artifact.payload.kind === 'inline' ? canonicalS2Json(artifact.payload.value) : '';
      return [{ workflowId: run.id, nodeId: node.nodeId, ...node.humanEvidence, type: artifact.type, preview: full.slice(0, 500), previewOmitted: full.length > 500 }];
    }));
    const observations = ledger.filter(item => item.receipt.publication === 'current').map(item => item.observation);
    const cacheReuses = [...new Map(this.reuses.filter(reuse => reuse.revision === this.revision).map(reuse => [reuse.nodeId, reuse])).values()].map(reuse => ({ ...structuredClone(reuse), kind: 'cache-reuse' as const,
      artifacts: Object.values(reuse.outputs).flat().map(id => {
        const artifact = this.currentArtifact(id), preview = artifact.payload.kind === 'inline' ? canonicalS2Json(artifact.payload.value) : '';
        return { id, type: artifact.type, artifactComplete: true as const, preview: preview.slice(0, 1200), previewOmitted: preview.length > 1200 };
      }) }));
    const frame: S2InteractionFrame = { protocolVersion: 1, sceneId: this.sceneId, runId: this.runId, revision: this.revision, event: { id: uuid('event'), kind: 'user-message', text },
      focusNodeIds: node || executionNode ? [selectedId!] : [], availableNodeIds: [...this.document.nodes, ...(this.document.execution?.nodes ?? [])].map(item => item.id),
      availableArtifactIds: [...bindings.map(item => item.artifactId), ...observations.flatMap(item => item.artifacts.map(artifact => artifact.id)), ...cacheReuses.flatMap(reuse => reuse.artifacts.map(artifact => artifact.id)), ...humanInputs.map(item => item.artifactId)], observations, strategy };
    // No grant, adapter function or mutable store escapes to the Agent.
    const model = this.modelSession?.summary();
    const modelTest = model ? { approved: model.active, providerLabel: model.providerLabel, model: model.model, limits: model.limits,
      usedRequests: model.usedRequests, reservedOutputTokens: model.reservedOutputTokens, waiting: this.waitingModelTests().map(({ id, nodeId, workflowId }) => ({ id, nodeId, workflowId })) } : { approved: false };
    const interactionSnapshot = this.interactionLog.snapshot(this.revision, this.active, frame.focusNodeIds);
    const interactions = { ...interactionSnapshot, recentEvents: interactionSnapshot.recentEvents.map(event => this.projectInteractionEvent(event)),
      controlStates: interactionSnapshot.controlStates.map(event => this.projectInteractionEvent(event)) };
    const readableEvents = new Set([...interactions.eventIndex, ...interactions.recentEvents, ...interactions.fieldStates, ...interactions.controlStates].map(event => event.id));
    const prepared = { frame: structuredClone(frame), bindings, remainingCalls: this.remainingCalls, approvedCapabilities: structuredClone(this.grant.capabilities), humanInputs, modelTest,
      ...(this.grant.capabilities.some(isS2TextResource) ? { textResources: this.textResourceSummary() } : {}), interactions,
      ...(this.grant.capabilities.some(isS2ProjectNotes) ? { projectNotes: this.projectNoteSummary() } : {}),
      artifactCatalog: frame.availableArtifactIds.map(id => { const artifact = this.artifacts.get(id)!; return { id, type: structuredClone(artifact.type), source: structuredClone(artifact.source) }; }),
      trialIndex: [...this.entries].sort((a, b) => a.sequence - b.sequence).map(entry => ({ id: entry.invocation.id, sequence: entry.sequence,
        nodeId: entry.invocation.nodeId, revision: entry.invocation.revision, status: entry.outcome.status, capability: { pluginId: entry.invocation.pluginId, pluginVersion: entry.invocation.pluginVersion, capabilityId: entry.invocation.capabilityId },
        assessmentCount: this.trialAssessments.get(entry.invocation.id)?.records.length ?? 0, historicalOnly: true as const })),
      outputIndex: (this.document.execution?.nodes ?? []).flatMap(node => registry.capability(node).outputs.map((port): S2OutputIndexEntry => {
        const latest = this.latestOutputs.get(node.id), artifactIds = [...(latest?.outputs[port.id] ?? [])];
        return { nodeId: node.id, portId: port.id, type: structuredClone(port.type), artifactIds,
          state: !latest ? 'not-attempted' : artifactIds.length ? 'available' : 'unavailable' };
      })),
      receiptIndex: ledger.map(item => ({ invocationId: item.receipt.invocationId, nodeId: item.request.nodeId, revision: item.receipt.revision,
        status: item.receipt.status, publication: item.receipt.publication, pluginId: item.request.pluginId, capabilityId: item.request.capabilityId,
        ...(item.receipt.error ? { error: structuredClone(item.receipt.error) } : {}) })),
      workflowIndex: workflowRecords.map(({ nodes: _, ...record }) => record),
      workflowArchive: workflowRecords, // Local recall source only; model projection explicitly excludes the archive.
      executionRuns: workflowRecords.slice(-8), executionRunsOmitted: Math.max(0, this.workflows.length - 8), cacheReuses };
    const preparedRevision = this.revision, readable = new Set(frame.availableArtifactIds), readableTrials = new Set(prepared.trialIndex.map(item => item.id));
    const check = () => {
      this.requireActive();
      if (preparedRevision !== this.revision || prepared.frame.sceneId !== this.sceneId || prepared.frame.runId !== this.runId || prepared.frame.revision !== preparedRevision)
        throw new Error('完整产物上下文已失效；不能跨局或修订读取');
    };
    bindS2ArtifactContext(prepared, {
      event: id => { check(); if (!readableEvents.has(id)) throw new Error('互动事件不在本轮提供的索引范围'); return this.projectInteractionEvent(this.interactionLog.read(id, this.revision, this.active)); },
      trial: id => { check(); if (!readableTrials.has(id)) throw new Error('试验不在本轮宿主档案范围'); return this.readTrial(id); },
      read: id => { check(); if (!readable.has(id) || !this.grant.readableArtifactIds.includes(id)) throw new Error('产物不在本轮宿主可读范围'); return this.currentArtifact(id); },
      output: (nodeId, portId) => {
        check();
        const node = this.document.execution?.nodes.find(node => node.id === nodeId), port = node && registry.capability(node).outputs.find(port => port.id === portId);
        if (!port || port.multiple) return [];
        return [...(this.latestOutputs.get(nodeId)?.outputs[portId] ?? [])];
      },
      outputs: (nodeId, portId) => {
        check();
        const node = this.document.execution?.nodes.find(node => node.id === nodeId), port = node && registry.capability(node).outputs.find(port => port.id === portId);
        if (!port) return [];
        return [...(this.latestOutputs.get(nodeId)?.outputs[portId] ?? [])];
      },
    });
    return prepared;
  }
  private snapshot(entry: RecordEntry): S2LocalExecution {
    const current = this.context(), observation = describeS2PluginOutcome(registry, entry.invocation, entry.outcome, current);
    return { request: structuredClone(entry.request), receipt: { ...structuredClone(entry.receipt), publication: observation.publication }, observation: structuredClone(observation),
      artifacts: observation.publication === 'current' && entry.outcome.status === 'succeeded' ? structuredClone(Object.values(entry.outcome.outputs).flat()) : [],
      ...(entry.resource ? { resource: structuredClone(entry.resource) } : {}) };
  }
  history(): S2LocalExecution[] { return this.entries.map(entry => this.snapshot(entry)); }
  /** Explicit user confirmation invokes this method. Intent, frame, key and adapter output are all rechecked. */
  execute(raw: unknown, frame: S2InteractionFrame, idempotencyKey: string, signal?: AbortSignal): Promise<S2LocalExecution> {
    this.requireActive();
    const fingerprint = canonicalS2Json({ raw, sceneId: frame.sceneId, runId: frame.runId, revision: frame.revision } as S2Json);
    const prior = this.jobs.get(idempotencyKey);
    if (prior) {
      if (prior.fingerprint !== fingerprint) throw new S2PluginProtocolError('IDEMPOTENCY_CONFLICT', 'idempotencyKey', '同一幂等键不能更换输入或修订号');
      return prior.promise.then(result => this.history().find(item => item.receipt.invocationId === result.receipt.invocationId)!);
    }
    if (this.jobs.size >= S2_LOCAL_RUN_LIMIT) throw new S2PluginProtocolError('BUDGET_EXHAUSTED', 'run', '本局调用次数已达上限');
    // Defer validation so the pending idempotency entry is installed BEFORE any adapter executes.
    // Snapshot caller-owned data now; a later mutation must not change a confirmed intention.
    const frozenRequest = structuredClone(raw), frozenFrame = structuredClone(frame);
    const requestedNodeId = (frozenRequest as S2PluginRequest)?.nodeId;
    const parent = this.workflows.find(job => `${job.record.id}-${requestedNodeId}` === idempotencyKey);
    const outputToken = parent?.record.id ?? uuid('attempt');
    if (!parent && typeof requestedNodeId === 'string') this.latestOutputs.set(requestedNodeId, { token: outputToken, outputs: {} });
    const workflowAuthorized = this.workflowFrames.delete(frame);
    const modelAuthorization = this.modelFrames.get(frame); this.modelFrames.delete(frame);
    const promise = Promise.resolve().then(async () => {
      try {
        const result = await this.run(frozenRequest, frozenFrame, idempotencyKey, signal, workflowAuthorized, modelAuthorization);
        if (result.receipt.status === 'succeeded' && result.receipt.publication === 'current' && this.latestOutputs.get(result.request.nodeId)?.token === outputToken)
          this.latestOutputs.set(result.request.nodeId, { token: outputToken, outputs: structuredClone(result.receipt.outputArtifactIds) });
        return result;
      }
      finally { if (modelAuthorization?.invocationId) this.grant.confirmedInvocationIds = this.grant.confirmedInvocationIds.filter(id => id !== modelAuthorization.invocationId); }
    });
    this.jobs.set(idempotencyKey, { fingerprint, promise });
    return promise;
  }
  private async run(raw: unknown, frame: S2InteractionFrame, key: string, signal?: AbortSignal, workflowAuthorized = false, modelAuthorization?: ModelAuthorization): Promise<S2LocalExecution> {
    this.requireActive();
    if (frame.sceneId !== this.sceneId || frame.runId !== this.runId || frame.revision !== this.revision) throw new S2PluginProtocolError('STALE_REVISION', 'frame', '画布已变化，请重新请求插件');
    if (signal?.aborted) throw new DOMException('已停止', 'AbortError');
    const { request } = readS2PluginRequest(registry, frame, raw);
    const implementation = s2BuiltinPluginInstallation().descriptor(request);
    if (implementation.kind !== 'local' && implementation.kind !== 'model' && implementation.kind !== 'resource') throw new S2PluginProtocolError('NOT_CALLABLE', 'capability', '此能力没有工具执行适配器');
    const executionNode = this.document.execution?.nodes.find(node => node.id === request.nodeId);
    const modelCall = isModelSession(request);
    if (modelCall && (!workflowAuthorized || !modelAuthorization || modelAuthorization.inputsKey !== canonicalS2Json(request.inputs)
      || modelAuthorization.revision !== frame.revision || modelAuthorization.session !== this.modelSession
      || modelAuthorization.resourceId !== this.modelSession?.resourceId || !this.modelSession?.summary().active)) throw new S2PluginProtocolError('WORKFLOW_REQUIRED', 'nodeId', '模型测试须通过执行图中的明确用户操作授权实际提示词和输入，不能由单次调用或场景声明绕过');
    if ((executionNode?.when || isS2ExclusiveMerge(request)) && !workflowAuthorized) throw new S2PluginProtocolError('WORKFLOW_REQUIRED', 'nodeId', '带条件节点及互斥合流须通过执行图调度，不能用单次调用绕过条件或候选检查');
    if (!this.document.nodes.some(node => node.id === request.nodeId) && !executionNode) throw new S2PluginProtocolError('SCOPE_DENIED', 'nodeId', '目标块不存在');
    if (executionNode && (executionNode.pluginId !== request.pluginId || executionNode.pluginVersion !== request.pluginVersion || executionNode.capabilityId !== request.capabilityId)) throw new S2PluginProtocolError('SCOPE_DENIED', 'nodeId', '不能冒用其他执行节点的能力');
    this.validateInputFields(Object.values(request.inputs).flat());
    const call = { protocolVersion: 1, id: uuid('invocation'), sceneId: this.sceneId, runId: this.runId, revision: this.revision, nodeId: request.nodeId,
      pluginId: request.pluginId, pluginVersion: request.pluginVersion, capabilityId: request.capabilityId, idempotencyKey: key, inputs: request.inputs };
    if (modelCall && modelAuthorization) { modelAuthorization.invocationId = call.id; this.grant.confirmedInvocationIds.push(call.id); }
    const resourceFailure = (error: unknown, diagnostic: S2ResourceReadDiagnostic) => {
      if (error && typeof error === 'object') this.resourceFailures.set(error, { nodeId: request.nodeId, revision: this.revision, epoch: this.resourceEpoch, diagnostic });
      return error;
    };
    let checked: Awaited<ReturnType<typeof validateS2Invocation>>;
    try { checked = await validateS2Invocation(registry, call, this.grant, [...this.artifacts.values()]); }
    catch (error) {
      const source = isS2TextResource(request) || isS2ImageResource(request) ? 'file' : isS2ProjectNotes(request) ? 'note' : null;
      if (source && error instanceof S2PluginProtocolError && error.code === 'PERMISSION_DENIED' && error.field === 'capability'
        && this.grant.capabilities.some(cap => cap.pluginId === request.pluginId && cap.pluginVersion === request.pluginVersion && cap.capabilityId === request.capabilityId)
        && !this.grant.permissions.includes(source === 'file' ? 'file-read' : 'notes-read')) {
        const input = this.artifacts.get(request.inputs.resource?.[0]), id = input?.payload.kind === 'inline' ? input.payload.value : undefined;
        resourceFailure(error, { kind: 'resource-read', source, reason: typeof id === 'string' && this.revokedResources.get(id) === source ? 'revoked' : 'not-approved' });
      }
      throw error;
    }
    let hostResource: S2TextResource | S2ProjectNoteResource | S2ImageResource | undefined, resourcePermission: 'file-read' | 'notes-read' = 'file-read';
    if (isS2ImageResource(request)) {
      const id = checked.inputs.resource[0];
      if (typeof id !== 'string' || !this.imageResources.has(id)) throw resourceFailure(new S2PluginProtocolError('SCOPE_DENIED', 'resource', '图片未选择、已经撤回或不属于本局；不能使用路径、URL或旧模板句柄。'),
        { kind: 'resource-read', source: 'file', reason: typeof id === 'string' && this.revokedResources.get(id) === 'file' ? 'revoked' : 'not-approved' });
      assertS2ResourceAccess(registry, checked.invocation, this.grant, 'file-read', id);
      hostResource = this.imageResources.get(id)!;
    } else if (isS2TextResource(request)) {
      const id = checked.inputs.resource[0];
      if (typeof id !== 'string' || !this.textResources.has(id)) throw resourceFailure(new S2PluginProtocolError('SCOPE_DENIED', 'resource', '资料未选择、已经撤回或不属于本局；不能使用路径或旧模板句柄。'),
        { kind: 'resource-read', source: 'file', reason: typeof id === 'string' && this.revokedResources.get(id) === 'file' ? 'revoked' : 'not-approved' });
      assertS2ResourceAccess(registry, checked.invocation, this.grant, 'file-read', id);
      hostResource = this.textResources.get(id)!;
    } else if (isS2ProjectNotes(request)) {
      const id = checked.inputs.resource[0];
      if (typeof id !== 'string' || !this.projectNoteResources.has(id)) throw resourceFailure(new S2PluginProtocolError('SCOPE_DENIED', 'resource', '笔记未允许、已撤回或不属于本局，不能使用旧模板或任意笔记ID。'),
        { kind: 'resource-read', source: 'note', reason: typeof id === 'string' && this.revokedResources.get(id) === 'note' ? 'revoked' : 'not-approved' });
      assertS2ResourceAccess(registry, checked.invocation, this.grant, 'notes-read', id);
      const noteResource = this.projectNoteResources.get(id)!;
      try { noteResource.assertAvailable(); }
      catch (error) {
        const reason = noteResource.availabilityFailure(error);
        if (reason) resourceFailure(error, { kind: 'resource-read', source: 'note', reason }); throw error;
      }
      hostResource = noteResource; resourcePermission = 'notes-read';
    }
    this.requireActive();
    if (signal?.aborted) throw new DOMException('已停止', 'AbortError');
    if (checked.invocation.revision !== this.revision) throw new S2PluginProtocolError('STALE_REVISION', 'invocation', '执行前画布已变化');
    if (modelCall) {
      const prompt = checked.inputs.prompt[0], input = checked.inputs.input[0];
      if (typeof prompt !== 'string' || input !== undefined && typeof input !== 'string') throw new Error('模型测试只能接收完整的提示词和输入文本');
      this.modelSession!.preview(prompt, input as string | undefined, this.modelImages(request.inputs), this.modelParameters(request.inputs));
      assertS2ResourceAccess(registry, checked.invocation, this.grant, 'model-call', this.modelSession!.resourceId);
    }
    // No await between this final check, reservation and registration. Concurrent validation cannot overspend.
    if (this.grant.remainingCalls <= 0) throw new S2PluginProtocolError('BUDGET_EXHAUSTED', 'run', '本局额度已用尽');
    if (this.artifacts.size + this.reservedArtifacts + checked.capability.outputs.length > ARTIFACT_LIMIT) throw new S2PluginProtocolError('STORE_LIMIT', 'artifacts', '本局存储已满');
    this.grant.remainingCalls--;
    const sequence = S2_LOCAL_RUN_LIMIT - this.grant.remainingCalls;
    this.reservedArtifacts += checked.capability.outputs.length;
    this.reservedInvocations.set(key, structuredClone(checked.invocation));
    this.interactionLog.append({ kind: 'plugin-state', nodeId: request.nodeId, invocationId: checked.invocation.id, status: 'running' }, checked.invocation.revision, 'host');
    const controller = new AbortController(); this.controllers.add(controller);
    const modelImageIds = modelCall ? this.modelImages(request.inputs).map(s2ImageResourceId) : [];
    for (const id of modelImageIds) {
      const controllers = this.modelImageControllers.get(id) ?? new Set<AbortController>();
      controllers.add(controller); this.modelImageControllers.set(id, controllers);
    }
    if (hostResource) {
      const id = hostResource.info().id, controllers = this.resourceControllers.get(id) ?? new Set<AbortController>();
      controllers.add(controller); this.resourceControllers.set(id, controllers);
    }
    const abort = () => controller.abort(); signal?.addEventListener('abort', abort, { once: true });
    let timer: ReturnType<typeof setTimeout> | undefined;
    let timedOut = false;
    let receivedOutput = false;
    const failure = (code: string, message: string): S2PluginOutcome => ({ status: timedOut ? 'unknown' : controller.signal.aborted ? 'cancelled' : 'failed', outputs: {}, error: { code, message } });
    let outcome: S2PluginOutcome;
    let structuredDiagnostic: S2StructuredFailureDiagnostic | null = null;
    let resourceDiagnostic: S2ResourceReadDiagnostic | null = null;
    try {
      const stopped = new Promise<never>((_, reject) => {
        controller.signal.addEventListener('abort', () => reject(new Error(timedOut ? '本地插件超时，未发布结果' : '本地插件已停止')), { once: true });
        timer = setTimeout(() => { timedOut = true; controller.abort(); }, checked.capability.timeoutMs);
      });
      const rawOutcome = await Promise.race([Promise.resolve().then(() => {
        if (modelCall) {
          assertS2ResourceAccess(registry, checked.invocation, this.grant, 'model-call', this.modelSession!.resourceId);
          const operation = this.modelSession!.execute(structuredClone(checked.invocation), structuredClone(checked.inputs), controller.signal);
          this.workflows.find(job => `${job.record.id}-${request.nodeId}` === key)?.notify(); // Show the reservation while a request is still pending.
          return operation;
        }
        if (hostResource) {
          const id = hostResource.info().id;
          assertS2ResourceAccess(registry, checked.invocation, this.grant, resourcePermission, id);
          if ((resourcePermission === 'file-read' ? this.textResources.get(id) ?? this.imageResources.get(id) : this.projectNoteResources.get(id)) !== hostResource) throw new Error('资料已经撤回，未读取。');
          return hostResource.read(structuredClone(checked.invocation), controller.signal);
        }
        return this.adapter(structuredClone(checked.invocation), structuredClone(checked.inputs), controller.signal);
      }), stopped]);
      receivedOutput = true;
      // Validate every output before storing ANY output. Invalid adapter data never reaches Agent/UI as success.
      outcome = await validateS2Outcome(registry, checked.invocation, rawOutcome, [...this.artifacts.keys()]);
      if (controller.signal.aborted) throw new Error('执行已停止');
      if (outcome.status === 'failed') structuredDiagnostic = await readS2StructuredFailureDiagnostic(checked.invocation, checked.inputs, rawOutcome, outcome);
      if (controller.signal.aborted) throw new Error('执行已停止');
    } catch (e) {
      structuredDiagnostic = null;
      if (hostResource && !timedOut) {
        const source = resourcePermission === 'file-read' ? 'file' : 'note';
        const reason = this.resourceRevocations.has(controller) ? 'revoked'
          : !controller.signal.aborted ? (hostResource instanceof S2ProjectNoteResource ? hostResource.availabilityFailure(e) : null)
            ?? (hostResource instanceof S2ImageResource ? null : hostResource.contentFailure(e, checked.invocation)) : null;
        if (reason) resourceDiagnostic = { kind: 'resource-read', source, reason };
      }
      const message = e instanceof Error ? e.message : typeof e === 'string' ? e : '插件适配器异常';
      outcome = await validateS2Outcome(registry, checked.invocation, failure(timedOut ? 'TIMEOUT' : controller.signal.aborted ? 'CANCELLED' : receivedOutput ? 'INVALID_OUTPUT' : 'ADAPTER_FAILURE', message.slice(0, 1000) || '插件执行失败'));
    } finally {
      clearTimeout(timer); signal?.removeEventListener('abort', abort); this.controllers.delete(controller);
      for (const id of modelImageIds) {
        const controllers = this.modelImageControllers.get(id); controllers?.delete(controller);
        if (!controllers?.size) this.modelImageControllers.delete(id);
      }
      if (hostResource) {
        const id = hostResource.info().id, controllers = this.resourceControllers.get(id);
        controllers?.delete(controller); if (!controllers?.size) this.resourceControllers.delete(id);
      }
    }
    // Output validation can await; another completed call may have claimed an ID meanwhile.
    if (outcome.status === 'succeeded' && Object.values(outcome.outputs).flat().some(artifact => this.artifacts.has(artifact.id))) {
      outcome = await validateS2Outcome(registry, checked.invocation, { status: 'failed', outputs: {}, error: { code: 'OUTPUT_CONFLICT', message: '插件输出标识符已被其他调用使用；未保存任何冲突输出' } });
    }
    const receipt = createS2Receipt(checked.invocation, outcome, this.context());
    this.reservedArtifacts -= checked.capability.outputs.length;
    if (outcome.status === 'succeeded') for (const artifact of Object.values(outcome.outputs).flat()) this.store(artifact);
    const model = modelCall ? this.modelSession!.summary() : undefined;
    const modelRecord = model?.records.find(record => record.id === checked.invocation.id);
    const entry: RecordEntry = { request, invocation: checked.invocation, outcome, receipt, sequence,
      ...(structuredDiagnostic && this.active && !controller.signal.aborted && !timedOut && receipt.publication === 'current' && receipt.status === 'failed' ? { structuredDiagnostic } : {}),
      ...(resourceDiagnostic && this.active && !signal?.aborted && !timedOut && receipt.publication === 'current' && ['failed', 'cancelled'].includes(receipt.status) ? { resourceDiagnostic } : {}),
      ...(hostResource ? { resource: hostResource.info() } : {}),
      ...(model ? { model: { providerLabel: model.providerLabel, model: model.model, maxOutputTokens: modelRecord?.parameters.maxOutputTokens ?? model.limits.maxOutputTokens,
        ...(modelRecord ? { parameters: structuredClone(modelRecord.parameters) } : {}), reservationOutputTokens: model.limits.maxOutputTokens } } : {}) }; this.entries.push(entry);
    this.interactionLog.append({ kind: 'plugin-state', nodeId: request.nodeId, invocationId: checked.invocation.id, status: receipt.status }, checked.invocation.revision, 'host');
    return this.snapshot(entry);
  }
  /** Returns only a complete current artifact; never an old receipt's preview as an input. */
  currentArtifact(id: string): S2Artifact {
    const artifact = this.artifacts.get(id);
    if (!this.active || !artifact || artifact.source.revision !== this.revision) throw new S2PluginProtocolError('STALE_REVISION', 'artifact', '产物不属于当前修订号');
    return structuredClone(artifact);
  }
  /** Local user-requested field inspection. Never creates an input artifact, runs a node or reads a resource. */
  readCurrentStructuredOutput(nodeId: string, portId: string): S2Artifact {
    return this.readCurrentInspectableOutput(nodeId, portId, ['structured-data.value']);
  }
  /** Same current-output boundary for the exact types already accepted by workflow conditions. */
  readCurrentConditionOutput(nodeId: string, portId: string): S2Artifact {
    return this.readCurrentInspectableOutput(nodeId, portId, ['structured-data.value', 'core.assessment', 'workflow-simulation.result', 'human-input.decision']);
  }
  private readCurrentInspectableOutput(nodeId: string, portId: string, types: string[]): S2Artifact {
    this.requireActive();
    const node = this.document.execution?.nodes.find(node => node.id === nodeId), port = node && registry.capability(node).outputs.find(port => port.id === portId);
    if (!node || !port || !port.required || port.multiple || !types.includes(port.type.id) || port.type.version !== 1
      || !this.grant.capabilities.some(binding => binding.pluginId === node.pluginId && binding.pluginVersion === node.pluginVersion && binding.capabilityId === node.capabilityId)) throw new Error('字段查看只支持本场景允许的单值结构化输出。');
    const ids = this.latestOutputs.get(nodeId)?.outputs[portId];
    if (ids?.length !== 1) throw new Error('上游尚无当前有效结果，请单独运行上游；查看字段不会自动运行。');
    const artifact = this.currentArtifact(ids[0]);
    if (!artifact.complete || artifact.source.nodeId !== nodeId || artifact.source.sceneId !== this.sceneId || artifact.source.runId !== this.runId
      || !this.grant.readableArtifactIds.includes(artifact.id) || artifact.type.id !== port.type.id || artifact.type.version !== port.type.version || artifact.payload.kind !== 'inline') throw new Error('当前输出不完整或已失效，不能从历史结果猜字段。');
    return artifact;
  }
  private readTrial(id: string): S2Trial {
    this.requireActive();
    const entry = this.entries.find(entry => entry.invocation.id === id);
    if (!entry) throw new Error('本局不存在该真实调用记录');
    const call = entry.invocation;
    const value = (artifactId: string): S2TrialValue => {
      const artifact = this.artifacts.get(artifactId);
      if (!artifact || artifact.source.runId !== this.runId || artifact.source.sceneId !== this.sceneId) throw new Error('试验来源已不可用');
      const complete = artifact.complete && artifact.payload.kind === 'inline';
      return { artifactId, type: structuredClone(artifact.type), source: structuredClone(artifact.source), complete,
        ...(complete && artifact.payload.kind === 'inline' ? { text: artifact.type.id === 'core.text' && typeof artifact.payload.value === 'string'
          ? artifact.payload.value : canonicalS2Json(artifact.payload.value) } : {}) };
    };
    const saved = this.trialAssessments.get(id);
    return { id, sceneId: call.sceneId, runId: call.runId, revision: call.revision, nodeId: call.nodeId,
      capability: { pluginId: call.pluginId, pluginVersion: call.pluginVersion, capabilityId: call.capabilityId }, ...(entry.model ? { model: structuredClone(entry.model) } : {}),
      status: entry.outcome.status, ...(entry.outcome.status === 'succeeded' ? {} : { error: structuredClone(entry.outcome.error) }),
      inputs: Object.fromEntries(Object.entries(call.inputs).map(([port, ids]) => [port, ids.map(value)])),
      outputs: Object.fromEntries(Object.entries(entry.receipt.outputArtifactIds).map(([port, ids]) => [port, ids.map(value)])),
      assessments: structuredClone(saved?.records ?? []), assessmentsOmitted: saved?.omitted ?? 0, historicalOnly: true };
  }
  /** Called only after the UI accepts a fresh reply. Never records model claims
   * or field-only checks as proof of an output from a previous experiment. */
  recordAssessment(raw: S2AssessmentReport) {
    this.requireActive();
    if (this.recordedAssessments.has(raw)) return;
    const { report, criterionKeys } = readS2ComputedAssessment(raw);
    const matched = new Map<string, S2TrialAssessment['checks']>();
    for (const check of report.checks) {
      const source = check.source;
      if (!source) continue;
      if (source.source.kind !== 'plugin' || !source.source.invocationId) continue; // Cache and human data are not new actual calls.
      const entry = this.entries.find(entry => entry.invocation.id === source.source.invocationId);
      if (!entry || entry.invocation.revision !== this.revision || source.source.runId !== this.runId
        || !entry.receipt.outputArtifactIds[source.portId]?.includes(source.artifactId)
        || !this.latestOutputs.get(entry.invocation.nodeId)?.outputs[source.portId]?.includes(source.artifactId)) throw new Error('评价来源已过期或不是当前真实调用输出，未写入试验历史');
      const key = criterionKeys[check.criterionId];
      if (!key) throw new Error('评价标准来源不可用');
      if (!this.assessmentStandards.has(key)) {
        if (this.assessmentStandards.size >= 512) throw new Error('本局评价标准历史已满，未写入新记录');
        this.assessmentStandards.set(key, uuid('standard'));
      }
      const checks = matched.get(entry.invocation.id) ?? [];
      checks.push({ ...structuredClone(check), standardId: this.assessmentStandards.get(key)! }); matched.set(entry.invocation.id, checks);
    }
    const id = uuid('evaluation');
    for (const [trialId, checks] of matched) {
      const prior = this.trialAssessments.get(trialId) ?? { records: [], omitted: 0 };
      const records = [...prior.records, { id, revision: this.revision, checks }];
      this.trialAssessments.set(trialId, { records: records.slice(-8), omitted: prior.omitted + Math.max(0, records.length - 8) });
    }
    this.recordedAssessments.add(raw);
  }
  private validateInputFields(artifactIds: string[]) {
    // Drafts and read-only Agent context may be incomplete. Validate only consumed
    // field snapshots, before calls/cache reuse/waits; generated plugin outputs are not editable fields.
    if (!this.fieldPolicies) return;
    for (const id of new Set(artifactIds)) {
      const source = this.fieldSources.get(id); if (!source) continue;
      const node = this.document.nodes.find(node => node.id === source.nodeId), field = node && this.fieldPolicies.get(node.type)?.get(source.fieldId);
      if (!field) throw new S2PluginProtocolError('FIELD_SCHEMA_MISSING', 'input', '输入字段没有当前场景的声明');
      const artifact = this.currentArtifact(id);
      if (artifact.payload.kind !== 'inline' || typeof artifact.payload.value !== 'string') throw new S2PluginProtocolError('FIELD_INPUT_INVALID', 'input', '输入字段没有完整原文');
      try { validateS2FieldText(field, artifact.payload.value, false); }
      catch (error) { throw new S2PluginProtocolError('FIELD_INPUT_INVALID', `${node!.id}.${field.id}`, `输入字段未通过校验：${error instanceof Error ? error.message : '字段无效'}`); }
    }
  }
  private boundInput(nodeId: string, portId: string): string {
    const node = this.document.execution?.nodes.find(node => node.id === nodeId), binding = node?.bindings[portId];
    if (!node || !binding) throw new Error('执行节点缺少输入绑定');
    const key = JSON.stringify(['execution', nodeId, portId]);
    const prior = this.fields.get(key); if (prior) return prior;
    const port = registry.capability(node).inputs.find(port => port.id === portId);
    if (!port) throw new Error('执行输入端口不存在');
    const source = binding.kind === 'field' ? this.document.nodes.find(node => node.id === binding.nodeId) : null;
    if (binding.kind === 'field' && (port.type.id !== 'core.text' || !source || !Object.hasOwn(source.values, binding.fieldId))) throw new Error('输入字段不存在或类型不匹配');
    const id = uuid('artifact');
    this.store({ protocolVersion: 1, id, type: port.type, complete: true, source: { sceneId: this.sceneId, runId: this.runId, nodeId, revision: this.revision, kind: 'host' },
      payload: { kind: 'inline', value: binding.kind === 'literal' ? binding.value : source!.values[binding.fieldId] } });
    if (binding.kind === 'field') this.fieldSources.set(id, { nodeId: binding.nodeId, fieldId: binding.fieldId });
    this.fields.set(key, id); return id;
  }
  workflowHistory(): S2WorkflowRun[] {
    return this.workflows.map(({ record }) => ({ ...structuredClone(record), publication: this.active && record.revision === this.revision ? 'current' : 'stale' }));
  }
  /** Fresh navigation metadata, never a read of artifacts/materials. A newer attempt anywhere in this job retires its navigation. */
  readWorkflowDiagnostic(workflowId: string, nodeId: string): S2WorkflowDiagnostic | null {
    if (!this.active) return null;
    const job = this.workflows.find(item => item.record.id === workflowId);
    if (!job || job.controller.signal.aborted || job.record.revision !== this.revision || job.record.publication !== 'current'
      || job.record.nodes.some(node => this.latestOutputs.get(node.nodeId)?.token !== workflowId)) return null;
    const node = job.record.nodes.find(item => item.nodeId === nodeId);
    if (node?.diagnostic?.kind === 'resource-read' && this.resourceDiagnosticEpochs.get(node) !== this.resourceEpoch) return null;
    return node && (['failed', 'blocked'].includes(node.status) || node.status === 'cancelled' && node.diagnostic?.kind === 'model-request' && node.diagnostic.reason === 'user-declined')
      && node.diagnostic ? structuredClone(node.diagnostic) : null;
  }
  /** Current host-issued enqueue rejection; no request, material resolution or budget mutation. */
  readWorkflowPreflightDiagnostic(error: unknown): { nodeId: string; diagnostic: S2ModelRequestDiagnostic } | null {
    if (!this.active || !error || typeof error !== 'object') return null;
    const entry = this.modelPreflights.get(error);
    if (!entry || entry.revision !== this.revision || entry.epoch !== this.modelPreflightEpoch
      || entry.diagnostic.reason !== (this.modelSession ? 'authorization-closed' : 'authorization-missing') || this.modelSession?.summary().active) return null;
    return structuredClone({ nodeId: entry.nodeId, diagnostic: entry.diagnostic });
  }
  cancelWorkflow(id: string) {
    const job = this.workflows.find(job => job.record.id === id);
    if (!job || !['queued', 'running', 'waiting'].includes(job.record.status)) return;
    job.controller.abort();
    for (const [id, wait] of this.modelWaits) if (wait.view.workflowId === job.record.id) this.modelWaits.delete(id);
    job.modelApprovals.clear(); job.record.modelWaiting = [];
    if (!job.activeSegment) {
      job.record.status = 'cancelled'; job.record.waiting = [];
      job.record.nodes.forEach(node => { if (['pending', 'running', 'waiting'].includes(node.status)) node.status = 'cancelled'; });
      job.notify(); job.finish();
    }
  }
  /** Live, immutable input snapshots for the UI; no model/adapter can answer a human wait. */
  waitingHumanInputs() {
    return this.workflows.filter(job => this.active && !job.controller.signal.aborted && job.record.revision === this.revision)
      .flatMap(job => (job.record.waiting ?? []).map(wait => ({ ...structuredClone(wait), workflowId: job.record.id, revision: job.record.revision,
        artifacts: wait.contextArtifactIds.map(id => structuredClone(this.currentArtifact(id))) })));
  }
  submitHumanInput(workflowId: string, waitId: string, raw: unknown, via?: S2SubmitVia) {
    this.requireActive();
    if (via !== undefined && !['form', 'shortcut'].includes(via)) throw new Error('人工输入提交方式无效');
    const job = this.workflows.find(job => job.record.id === workflowId), wait = job?.record.waiting?.find(wait => wait.id === waitId);
    if (!job || !wait || job.controller.signal.aborted || job.record.revision !== this.revision || !['queued', 'running', 'waiting'].includes(job.record.status)) throw new Error('人工输入等待已失效、已提交或不属于本局当前修订');
    const node = this.document.execution?.nodes.find(node => node.id === wait.nodeId);
    if (!node || !isS2Human(node) || !this.grant.capabilities.some(cap => cap.pluginId === node.pluginId && cap.pluginVersion === node.pluginVersion && cap.capabilityId === node.capabilityId)) throw new Error('人工输入节点不在当前批准范围');
    wait.contextArtifactIds.forEach(id => this.currentArtifact(id));
    const port = registry.capability(node).outputs[0], value = s2HumanValue(node.capabilityId, raw), artifact = readS2Artifact(registry, {
      protocolVersion: 1, id: uuid('artifact'), type: port.type, complete: true,
      source: { sceneId: this.sceneId, runId: this.runId, nodeId: node.id, revision: this.revision, kind: 'user' }, payload: { kind: 'inline', value },
    });
    // Validate before committing. Invalid/oversized JSON leaves the wait and its user's draft intact.
    this.store(artifact);
    const progress = job.record.nodes.find(item => item.nodeId === node.id)!;
    progress.status = 'succeeded'; progress.artifactIds = [artifact.id];
    progress.humanEvidence = { waitId, artifactId: artifact.id, origin: 'user', ...(node.capabilityId === 'confirm' ? { approved: raw as boolean } : {}) };
    this.interactionLog.append({ kind: 'human-submit', workflowId, waitId, nodeId: node.id, artifactId: artifact.id,
      ...(node.capabilityId === 'confirm' ? { approved: raw as boolean } : {}) }, this.revision, 'user-control');
    this.interactionLog.append({ kind: 'human-control', workflowId, waitId, nodeId: node.id, state: 'submitted', ...(via ? { via } : {}) }, this.revision, 'user-control');
    job.outputs.set(node.id, { [port.id]: [artifact.id] }); job.record.waiting = job.record.waiting!.filter(item => item.id !== waitId);
    if (this.latestOutputs.get(node.id)?.token === job.record.id) this.latestOutputs.set(node.id, { token: job.record.id, outputs: { [port.id]: [artifact.id] } });
    job.notify(); if (!job.activeSegment) job.schedule();
  }
  /** Model/scene text never answers these waits: local UI must confirm the exact materialized request. */
  waitingModelTests(): S2ModelWait[] {
    if (!this.active) return [];
    return [...this.modelWaits.values()].filter(wait => wait.view.revision === this.revision && wait.session === this.modelSession && wait.session.summary().active
      && this.workflows.some(job => job.record.id === wait.view.workflowId && !job.controller.signal.aborted && ['queued', 'running', 'waiting'].includes(job.record.status)))
      .map(wait => structuredClone(wait.view));
  }
  confirmModelTest(workflowId: string, waitId: string, approved: boolean) {
    this.requireActive();
    if (typeof approved !== 'boolean') throw new Error('必须明确提交布尔同意或拒绝，不能由文本猜测授权');
    const wait = this.modelWaits.get(waitId), job = this.workflows.find(job => job.record.id === workflowId);
    if (typeof approved !== 'boolean' || !wait || !job || wait.view.workflowId !== workflowId || wait.view.revision !== this.revision
      || job.controller.signal.aborted || !['queued', 'running', 'waiting'].includes(job.record.status) || wait.session !== this.modelSession || !wait.session.summary().active) throw new Error('模型请求等待已失效、已确认或不属于本局当前修订');
    const progress = job.record.nodes.find(node => node.nodeId === wait.view.nodeId);
    const node = this.document.execution?.nodes.find(node => node.id === wait.view.nodeId);
    if (!progress || progress.status !== 'waiting' || !node || !isModelSession(node) || !this.grant.capabilities.some(isModelSession)) throw new Error('模型请求节点或权限已失效');
    Object.values(wait.inputs).flat().forEach(id => this.currentArtifact(id));
    if (approved) {
      const preview = wait.session.preview(wait.view.prompt, wait.view.input, this.modelImages(wait.inputs), this.modelParameters(wait.inputs));
      if (canonicalS2Json(preview.parameters as unknown as S2Json) !== canonicalS2Json(wait.view.parameters as unknown as S2Json)) throw new Error('实际模型参数与待确认请求不一致，未发送');
      job.modelApprovals.set(node.id, { inputsKey: wait.inputsKey, resourceId: wait.session.resourceId, revision: wait.view.revision, session: wait.session });
      progress.status = 'pending';
    } else { progress.status = 'cancelled'; progress.error = '用户拒绝本次模型请求；未发送、不扣模型预算'; progress.diagnostic = { kind: 'model-request', reason: 'user-declined' }; }
    this.modelWaits.delete(waitId); job.record.modelWaiting = job.record.modelWaiting?.filter(item => item.id !== waitId);
    this.interactionLog.append({ kind: 'model-confirm', workflowId, waitId, nodeId: node.id, approved }, this.revision, 'user-control');
    job.notify(); if (!job.activeSegment) job.schedule();
  }
  clearCache() { this.requireActive(); this.cache.clear(); } // Never clears receipts, reuse provenance or refunds budget.
  private async cacheSignature(nodeId: string, inputs: Record<string, string[]>): Promise<string | null> {
    const node = this.document.execution?.nodes.find(node => node.id === nodeId);
    if (!node || this.adapter !== executeBuiltin && !isRegisteredScenePackLocalAdapter(this.adapter)) return null; // Unregistered test/custom adapters do not inherit purity guarantees.
    const cap = registry.capability(node);
    if (cap.effect !== 'pure' || cap.permissions.length || cap.kind === 'renderer' || cap.kind === 'human') return null;
    if (!this.grant.capabilities.some(binding => binding.pluginId === node.pluginId && binding.pluginVersion === node.pluginVersion && binding.capabilityId === node.capabilityId)) throw new Error('缓存复用也必须在本局批准范围内');
    const values: Record<string, S2Json[]> = {};
    for (const port of cap.inputs) {
      const ids = inputs[port.id] ?? [];
      if (port.required && !ids.length || !port.multiple && ids.length > 1) throw new Error('缓存输入数量不匹配');
      values[port.id] = ids.map(id => {
        const artifact = readS2Artifact(registry, this.currentArtifact(id));
        if (!registry.compatible(artifact.type, port.type) || artifact.payload.kind !== 'inline') throw new Error('缓存只接受完整、当前、类型匹配的内联产物');
        return artifact.payload.value;
      });
    }
    const bytes = new TextEncoder().encode(canonicalS2Json({ nodeId, pluginId: node.pluginId, pluginVersion: node.pluginVersion, capabilityId: node.capabilityId, inputs: values }));
    return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))).map(byte => byte.toString(16).padStart(2, '0')).join('');
  }
  private reuseCached(signature: string, nodeId: string) {
    const entry = this.cache.get(signature);
    if (!entry || entry.outcome.status !== 'succeeded') return null;
    // Verifies the privately retained, branded invocation/outcome; imported data can never become a cache entry.
    describeS2PluginOutcome(registry, entry.invocation, entry.outcome, this.context());
    const artifacts = Object.entries(entry.outcome.outputs).map(([port, items]) => [port, items.map(item => readS2Artifact(registry, { ...item, id: uuid('artifact'),
      source: { sceneId: this.sceneId, runId: this.runId, nodeId, revision: this.revision, kind: 'host' } }))] as const);
    const count = artifacts.reduce((sum, [, items]) => sum + items.length, 0);
    if (this.artifacts.size + this.reservedArtifacts + count > ARTIFACT_LIMIT) throw new Error('本局产物存储已满，缓存未部分发布');
    const outputs = Object.fromEntries(artifacts.map(([port, items]) => [port, items.map(item => item.id)]));
    artifacts.forEach(([, items]) => items.forEach(item => this.store(item)));
    const reuse = { id: uuid('reuse'), revision: this.revision, nodeId, signature, sourceInvocationId: entry.invocation.id, outputs };
    this.reuses.push(reuse); return reuse;
  }
  /** User/Agent chooses the subgraph. Host only schedules its typed dependencies, never a teaching workflow. */
  enqueueWorkflow(targets?: string[], onUpdate?: () => void, options: { force?: boolean; modelConfirmation?: 'request' | 'user-action' } = {}): { id: string; completion: Promise<S2WorkflowRun> } {
    this.requireActive();
    // A terminal-owned explicit user action may bind the actual request directly.
    // The default remains request confirmation; never infer this mode from scene data.
    const mode = Object.getOwnPropertyDescriptor(options, 'modelConfirmation');
    if (mode && (!Object.hasOwn(mode, 'value') || mode.value !== undefined && !['request', 'user-action'].includes(mode.value))) throw new Error('模型确认模式无效');
    const userAction = mode?.value === 'user-action';
    this.modelPreflightEpoch++;
    if (this.workflows.length >= 64 || this.workflows.filter(job => ['queued', 'running', 'waiting'].includes(job.record.status)).length >= 8) throw new Error('执行队列已满；本局最多64个任务，同时等待最多8个');
    const { graph, order } = selectS2Execution(this.document, this.grant.capabilities, targets);
    const firstModel = order.map(id => graph.nodes.find(node => node.id === id)!).find(isModelSession);
    if (firstModel && !this.modelSession?.summary().active) {
      const error = new Error('本局尚未单独批准模型测试资源和预算；可先运行纯本地子图');
      this.modelPreflights.set(error, { revision: this.revision, epoch: this.modelPreflightEpoch, nodeId: firstModel.id,
        diagnostic: { kind: 'model-request', reason: this.modelSession ? 'authorization-closed' : 'authorization-missing' } }); throw error;
    }
    const force = options.force === true;
    const controller = new AbortController(), record: S2WorkflowRun = { id: uuid('queue'), revision: this.revision, targets: targets ? [...targets] : graph.nodes.map(node => node.id),
      status: 'queued', publication: 'current', force, nodes: order.map(nodeId => ({ nodeId, status: 'pending', artifactIds: [] })) };
    let lastStatus: S2WorkflowRun['status'] | undefined;
    const nodeStates = new Map<string, string>();
    const notify = () => {
      if (record.status !== lastStatus) {
        lastStatus = record.status;
        this.interactionLog.append({ kind: 'workflow-state', workflowId: record.id, status: record.status }, record.revision, 'host');
      }
      for (const node of record.nodes) {
        const waitId = record.waiting?.find(wait => wait.nodeId === node.nodeId)?.id ?? record.modelWaiting?.find(wait => wait.nodeId === node.nodeId)?.id;
        const stateKey = JSON.stringify([node.status, waitId]);
        if (nodeStates.get(node.nodeId) === stateKey) continue;
        nodeStates.set(node.nodeId, stateKey);
        this.interactionLog.append({ kind: 'node-state', workflowId: record.id, nodeId: node.nodeId, status: node.status, ...(waitId ? { waitId } : {}) }, record.revision, 'host');
      }
      try { onUpdate?.(); } catch { /* Display subscriber must not break an execution or its ledger. */ }
    };
    let resolveCompletion!: (run: S2WorkflowRun) => void, settled = false, scheduled = false;
    const completion = new Promise<S2WorkflowRun>(resolve => { resolveCompletion = resolve; });
    const outputs = new Map<string, Record<string, string[]>>();
    const job = { record, controller, activeSegment: false, schedule: () => {}, notify, outputs, modelApprovals: new Map<string, ModelAuthorization>(), finish: () => {
      if (!settled) { settled = true; resolveCompletion(this.workflowHistory().find(item => item.id === record.id)!); }
    } };
    const runSegment = async () => {
      scheduled = false; if (settled) return; job.activeSegment = true;
      const stopped = () => !this.active || controller.signal.aborted || this.revision !== record.revision;
      try {
        if (stopped()) { record.status = 'cancelled'; record.error = '队列已取消或画布已变化，未按新内容重放'; return; }
        record.status = 'running'; notify();
        for (const nodeId of order) {
          const progress = record.nodes.find(node => node.nodeId === nodeId)!, node = graph.nodes.find(node => node.id === nodeId)!;
          if (stopped()) { record.status = 'cancelled'; break; }
          if (progress.status !== 'pending') continue; // Completed upstream nodes are never replayed after human input.
          const links = graph.links.filter(link => link.target.nodeId === nodeId);
          const dependencies = [...links.map(link => link.source.nodeId), ...(node.when ? [node.when.nodeId] : [])];
          if (dependencies.some(id => ['pending', 'running', 'waiting'].includes(record.nodes.find(item => item.nodeId === id)!.status))) continue;
          if (node.when) {
            const when = node.when, upstream = record.nodes.find(item => item.nodeId === when.nodeId)!;
            if (upstream.status === 'skipped') { progress.status = 'skipped'; progress.error = '条件来源所在分支已跳过；未执行'; notify(); continue; }
            const conditionDiagnostic = (reason: Extract<S2WorkflowDiagnostic, { kind: 'condition-unavailable' }>['reason']) => {
              progress.diagnostic = { kind: 'condition-unavailable', reason, sourceNodeId: when.nodeId, sourcePortId: when.portId, pointer: when.pointer };
            };
            try {
              const ids = outputs.get(when.nodeId)?.[when.portId];
              if (ids?.length !== 1) {
                conditionDiagnostic('source-output-unavailable');
                throw new Error('条件来源没有完整单值输出；不能猜测条件结果');
              }
              const artifact = this.currentArtifact(ids[0]);
              if (artifact.payload.kind !== 'inline') {
                conditionDiagnostic('inline-data-unavailable');
                throw new Error('条件需要完整内联数据，不能拿预览或引用摘要代替');
              }
              let actual: S2Json;
              try { actual = selectS2Pointer(artifact.payload.value, when.pointer); }
              catch (error) {
                if (error instanceof S2PointerAccessError && error.reason === 'missing' && error.pointer === when.pointer) conditionDiagnostic('pointer-missing');
                throw error;
              }
              const matched = canonicalS2Json(actual) === canonicalS2Json(when.equals);
              progress.conditionEvidence = { artifactId: artifact.id, type: artifact.type, pointer: when.pointer, matched, simulation: artifact.type.id === 'workflow-simulation.result' };
              if (matched !== when.match) { progress.status = 'skipped'; progress.error = '条件未命中本分支；未执行、不扣次数'; notify(); continue; }
            } catch (error) { progress.status = 'blocked'; progress.error = error instanceof Error ? error.message : '条件不可判定'; notify(); continue; }
          }
          const merge = isS2ExclusiveMerge(node), skipped = links.filter(link => record.nodes.find(item => item.nodeId === link.source.nodeId)?.status === 'skipped');
          const unavailable = links.filter(link => !outputs.has(link.source.nodeId) && (!merge || !skipped.includes(link)));
          if (!merge && skipped.length) { progress.status = 'skipped'; progress.error = '数据上游分支已跳过；未执行'; notify(); continue; }
          if (unavailable.length) { progress.status = 'blocked'; progress.error = '上游没有完整成功输出；未猜测或继续转换';
            progress.diagnostic = { kind: 'upstream-unavailable', sourceNodeIds: [...new Set(unavailable.map(link => link.source.nodeId))] };
            if (merge) progress.mergeEvidence = { candidateArtifactIds: links.flatMap(link => outputs.get(link.source.nodeId)?.[link.source.portId] ?? []), skippedNodeIds: [...new Set(skipped.map(link => link.source.nodeId))], blockedNodeIds: [...new Set(unavailable.map(link => link.source.nodeId))], simulation: node.capabilityId === 'merge-simulation' };
            notify(); continue;
          }
          progress.status = 'running'; notify();
          try {
            const cap = registry.capability(node), inputs: Record<string, string[]> = {};
            for (const port of cap.inputs) inputs[port.id] = [...(node.bindings[port.id] ? [this.boundInput(nodeId, port.id)] : []), ...links.filter(link => link.target.portId === port.id).flatMap(link => outputs.get(link.source.nodeId)?.[link.source.portId] ?? [])];
            this.validateInputFields(Object.values(inputs).flat());
            if (isModelSession(node) && !job.modelApprovals.has(nodeId)) {
              const session = this.modelSession;
              if (!session || !session.summary().active) { progress.diagnostic = { kind: 'model-request', reason: session ? 'authorization-closed' : 'authorization-missing' }; throw new Error('模型测试授权已撤回或本局未授权'); }
              if (inputs.prompt.length !== 1 || inputs.input.length > 1 || (inputs.image?.length ?? 0) > 1) throw new Error('模型测试需要一个完整提示词、最多一个输入文本和一张本局原图');
              const prompt = this.currentArtifact(inputs.prompt[0]), input = inputs.input[0] ? this.currentArtifact(inputs.input[0]) : undefined;
              if (prompt.type.id !== 'core.text' || prompt.payload.kind !== 'inline' || typeof prompt.payload.value !== 'string'
                || input && (input.type.id !== 'core.text' || input.payload.kind !== 'inline' || typeof input.payload.value !== 'string')) throw new Error('模型测试需要完整原文，不读取摘要或其他类型');
              const inputText = input?.payload.kind === 'inline' ? input.payload.value as string : '';
              let preview: ReturnType<S2ModelTestSession['preview']>;
              const imageRefs = this.modelImages(inputs);
              try { preview = session.preview(prompt.payload.value, inputText, imageRefs, this.modelParameters(inputs)); }
              catch (error) { if (session.ownsBudgetFailure(error)) progress.diagnostic = { kind: 'model-request', reason: 'budget-exhausted' }; throw error; }
              if (userAction) {
                job.modelApprovals.set(nodeId, { inputsKey: canonicalS2Json(inputs), resourceId: session.resourceId, revision: record.revision, session });
              } else {
                const view: S2ModelWait = { id: uuid('modelwait'), workflowId: record.id, revision: record.revision, nodeId,
                  prompt: prompt.payload.value, input: inputText, providerLabel: preview.providerLabel, model: preview.model, maxOutputTokens: preview.maxOutputTokens,
                  parameters: preview.parameters, reservationOutputTokens: preview.reservationOutputTokens,
                  ...(imageRefs.length ? { images: imageRefs.map(ref => this.imageResourcePreview(s2ImageResourceId(ref))) } : {}) };
                this.modelWaits.set(view.id, { view, inputs: structuredClone(inputs), inputsKey: canonicalS2Json(inputs), session });
                (record.modelWaiting ??= []).push({ id: view.id, nodeId }); progress.status = 'waiting'; notify(); continue;
              }
            }
            if (merge) {
              const candidates = inputs.candidates;
              progress.mergeEvidence = { candidateArtifactIds: [...candidates], skippedNodeIds: [...new Set(skipped.map(link => link.source.nodeId))], blockedNodeIds: [], simulation: node.capabilityId === 'merge-simulation' };
              if (!candidates.length) { progress.status = 'skipped'; progress.error = '所有候选分支均跳过；合流未执行、不扣次数'; notify(); continue; }
              if (candidates.length !== 1) {
                progress.diagnostic = { kind: 'merge-conflict', candidateCount: candidates.length,
                  sourceNodeIds: [...new Set(links.filter(link => link.target.portId === 'candidates'
                    && (outputs.get(link.source.nodeId)?.[link.source.portId]?.length ?? 0) > 0).map(link => link.source.nodeId))],
                  boundInput: Object.hasOwn(node.bindings, 'candidates') };
                throw new Error('互斥合流冲突：多路候选同时命中，未自动选择或拼接；合流未执行');
              }
              progress.mergeEvidence.selectedArtifactId = candidates[0];
              progress.mergeEvidence.selectedNodeId = this.currentArtifact(candidates[0]).source.nodeId;
            }
            if (cap.kind === 'human' || cap.kind === 'renderer') {
              const implementation = s2BuiltinPluginInstallation().descriptor(node);
              if (implementation.kind !== cap.kind) throw new Error('交互或展示实现与声明不一致');
              if (!this.grant.capabilities.some(granted => granted.pluginId === node.pluginId && granted.pluginVersion === node.pluginVersion && granted.capabilityId === node.capabilityId)) throw new Error('展示能力不在本局批准范围');
              for (const port of cap.inputs) {
                if (port.required && !inputs[port.id].length || !port.multiple && inputs[port.id].length > 1) throw new Error('展示端口数据数量不匹配');
                for (const id of inputs[port.id]) if (!registry.compatible(this.currentArtifact(id).type, port.type)) throw new Error('展示端口语义类型不匹配');
              }
              if (cap.kind === 'human') {
                if (!isS2Human(node)) throw new Error('人工节点未安装宿主交互适配器');
                const prompt = this.currentArtifact(inputs.prompt[0]);
                if (prompt.payload.kind !== 'inline' || typeof prompt.payload.value !== 'string' || !prompt.payload.value.trim()) throw new Error('人工输入节点需要明确、非空的用户提示');
                const wait: S2HumanWait = { id: uuid('wait'), nodeId, capabilityId: node.capabilityId as S2HumanWait['capabilityId'], prompt: prompt.payload.value,
                  contextArtifactIds: [...(inputs.context ?? []), ...(inputs.simulation ?? [])],
                  ...(node.presentation?.responseForm ? { responseForm: structuredClone(node.presentation.responseForm) } : {}) };
                (record.waiting ??= []).push(wait); progress.status = 'waiting';
              } else {
                if (implementation.kind !== 'renderer') throw new Error('未安装展示适配器');
                progress.status = 'displayed'; progress.artifactIds = [...inputs[implementation.portId]]; outputs.set(nodeId, {});
              }
            } else {
              const signature = await this.cacheSignature(nodeId, inputs);
              if (stopped()) throw new Error('缓存检查期间任务已取消或画布已变化');
              if (force && signature) this.cache.delete(signature);
              const reused = !force && signature ? this.reuseCached(signature, nodeId) : null;
              if (reused) {
                outputs.set(nodeId, reused.outputs); progress.artifactIds = Object.values(reused.outputs).flat(); progress.status = 'cached'; progress.cacheReuseId = reused.id;
                if (this.latestOutputs.get(nodeId)?.token === record.id) this.latestOutputs.set(nodeId, { token: record.id, outputs: structuredClone(reused.outputs) });
                notify(); continue;
              }
              const frame: S2InteractionFrame = { protocolVersion: 1, sceneId: this.sceneId, runId: this.runId, revision: record.revision,
                event: { id: uuid('event'), kind: 'node-submit', nodeId }, focusNodeIds: [nodeId], availableNodeIds: graph.nodes.map(node => node.id), availableArtifactIds: Object.values(inputs).flat(), observations: [],
                strategy: { goal: '用户确认的执行范围', understanding: '仅执行所选数据依赖', planning: '不推导教学阶段', response: '返回真实数据和凭据' } };
              if (node.when || merge || isModelSession(node)) this.workflowFrames.add(frame);
              if (isModelSession(node)) {
                const approval = job.modelApprovals.get(nodeId); job.modelApprovals.delete(nodeId);
                if (!approval || approval.inputsKey !== canonicalS2Json(inputs) || approval.revision !== record.revision || approval.session !== this.modelSession
                  || approval.resourceId !== this.modelSession?.resourceId || !approval.session.summary().active) throw new Error('模型请求的实际输入与用户操作授权不一致，未发送');
                this.modelFrames.set(frame, approval);
              }
              const execution = await this.execute({ nodeId, pluginId: node.pluginId, pluginVersion: node.pluginVersion, capabilityId: node.capabilityId, inputs, reason: `用户确认执行 ${record.id}` }, frame, `${record.id}-${nodeId}`, controller.signal);
              progress.invocationId = execution.receipt.invocationId;
              if (!stopped() && ['failed', 'cancelled'].includes(execution.receipt.status) && execution.receipt.publication === 'current') {
                const entry = this.entries.find(entry => entry.invocation.id === execution.receipt.invocationId
                  && entry.invocation.idempotencyKey === `${record.id}-${nodeId}` && entry.invocation.nodeId === nodeId && entry.invocation.revision === record.revision);
                if (entry?.structuredDiagnostic) progress.diagnostic = structuredClone(entry.structuredDiagnostic);
                if (entry?.resourceDiagnostic) { progress.diagnostic = structuredClone(entry.resourceDiagnostic); this.resourceDiagnosticEpochs.set(progress, this.resourceEpoch); }
              }
              if (stopped() || execution.receipt.status !== 'succeeded' || execution.receipt.publication !== 'current') throw new Error(execution.receipt.error?.message ?? '执行结果已过期');
              outputs.set(nodeId, execution.receipt.outputArtifactIds); progress.artifactIds = Object.values(execution.receipt.outputArtifactIds).flat(); progress.status = 'succeeded';
              if (signature) {
                const entry = this.entries.find(entry => entry.invocation.id === execution.receipt.invocationId)!;
                if (this.cache.size >= 128) this.cache.delete(this.cache.keys().next().value!);
                this.cache.set(signature, entry);
              }
            }
          } catch (error) {
            progress.status = stopped() ? 'cancelled' : 'failed'; progress.error = error instanceof Error ? error.message : '执行节点失败';
            const resourceFailure = error && typeof error === 'object' ? this.resourceFailures.get(error) : undefined;
            if (!stopped() && resourceFailure?.nodeId === nodeId && resourceFailure.revision === record.revision && resourceFailure.epoch === this.resourceEpoch) {
              progress.diagnostic = structuredClone(resourceFailure.diagnostic); this.resourceDiagnosticEpochs.set(progress, this.resourceEpoch);
            }
          }
          notify();
        }
        record.status = stopped() ? 'cancelled' : record.nodes.some(node => node.status === 'waiting') ? 'waiting' : record.nodes.some(node => node.status === 'pending') ? 'queued' : record.nodes.some(node => ['failed', 'blocked', 'cancelled'].includes(node.status)) ? 'failed' : 'succeeded';
      } catch (error) { record.status = stopped() ? 'cancelled' : 'failed'; record.error = error instanceof Error ? error.message : '执行队列失败'; }
      finally {
        job.activeSegment = false;
        if (['succeeded', 'failed', 'cancelled'].includes(record.status)) {
          for (const [id, wait] of this.modelWaits) if (wait.view.workflowId === record.id) this.modelWaits.delete(id);
          record.modelWaiting = []; job.modelApprovals.clear();
          record.waiting = []; record.nodes.forEach(node => { if (['pending', 'running', 'waiting'].includes(node.status)) node.status = 'cancelled'; });
          notify(); job.finish();
        } else {
          notify();
          // A user may have responded while an independent branch was executing. Drain any newly ready nodes.
          const ready = record.nodes.some(progress => progress.status === 'pending' && [...graph.links.filter(link => link.target.nodeId === progress.nodeId).map(link => link.source.nodeId), ...(graph.nodes.find(node => node.id === progress.nodeId)!.when ? [graph.nodes.find(node => node.id === progress.nodeId)!.when!.nodeId] : [])]
            .every(id => !['pending', 'running', 'waiting'].includes(record.nodes.find(node => node.nodeId === id)!.status)));
          if (ready) job.schedule();
        }
      }
    };
    job.schedule = () => {
      if (settled || scheduled || job.activeSegment) return;
      scheduled = true; record.status = 'queued';
      const segment = this.queueTail.then(runSegment);
      this.queueTail = segment.then(() => {}, () => { record.status = 'failed'; record.error = '执行调度异常，未重放已完成节点'; job.activeSegment = false; job.finish(); notify(); });
    };
    this.workflows.push(job);
    for (const nodeId of order) this.latestOutputs.set(nodeId, { token: record.id, outputs: {} });
    job.schedule(); notify();
    return { id: record.id, completion };
  }
}
