import { ScenePackView, scenePackView, scenePackViewPolicy, scenePackNodeDoubleClick, scenePackHasCustomView } from './ScenePackView';
import { closeSceneInteractionHost, enqueueSceneInteractionUserWorkflow, scenePackLocalAdapter } from '../../services/scene/sceneInteractionHostServices';
import { loadSceneInteractionPack } from '../../services/scene/sceneInteractionPackLoader';
import { sceneInteractionPacks } from '../../services/scene/sceneInteractionPacks';
import { assertS2ReadOnlyContent } from '../../services/scene/sceneS2ReadOnly';
import React, { useEffect, useRef, useState } from 'react';
import { Background, Controls, Handle, Position, ReactFlow, useUpdateNodeInternals, type NodeProps, type Node, type Edge } from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import type { SceneInitialRequest, SceneSpec } from '../../types';
import type { ScenePackNavigationTarget } from '../../types/sceneInteractionPack';
import type { S2AgentReply, S2BatchAction, S2Document, S2Field, S2InputBinding, S2WorkflowCondition, S2WorkflowNode } from '../../types/sceneS2';
import { applyS2Commands, createS2Scene, designS2Canvas, interactS2Canvas, invokeS2InteractionModel, readS2Document, readS2Scene } from '../../services/scene/sceneS2Canvas';
import { interactS2PublicScene } from '../../services/scene/sceneS2Interaction';
import { prepareS2InteractionActions, executeS2InteractionActions } from '../../services/scene/sceneS2InteractionActions';
import { S2InteractionEventRouter, bindS2PackageInteractionEvents, validateS2PublicInteraction, type S2InteractionCause } from '../../services/scene/sceneS2InteractionEvents';
import { s2InteractionDocumentSnapshot } from '../../services/scene/sceneS2InteractionMetadata';
import type { S2InteractionEvent, S2InteractionScope } from '../../types/sceneS2Interaction';
import { loadManifest, loadScene, saveScene } from '../../services/scene/sceneSkillStore';
import { S2PluginHost, type S2LocalExecution, type S2WorkflowRun } from '../../services/scene/sceneS2PluginHost';
import { S2_JSON_CHECK_BINDING, s2BuiltinPluginRegistry, s2CapabilityKey, s2ComposableCapabilities } from '../../services/scene/sceneS2PluginRegistry';
import type { S2Artifact, S2ExecutionLink, S2InteractionFrame, S2PluginRequest } from '../../types/sceneS2Plugin';
import { s2ExecutionLinkKey, s2SemanticDocument, selectS2Execution } from '../../services/scene/sceneS2Workflow';
import { deleteS2CanvasSelection, resolveS2CanvasShortcut } from '../../services/scene/sceneS2CanvasDelete';
import { assertS2PublicEdit, projectS2PublicCanvas, publicS2Catalog, findS2PublicComponent } from '../../services/scene/sceneS2PublicAuthoring';
import { appendS2PublicComponent, prepareS2PublicDefinition } from '../../services/scene/sceneS2PublicSession';
import { S2ArtifactView } from './S2ArtifactView';
import { scenePackAllowsExecution } from '../../services/scene/sceneInteractionPackProtocol';
import { S2ImageMaterials } from './S2ImageMaterials';
import { S2TextMaterialInput } from './S2TextMaterialInput';
import { S2ProjectNoteInput } from './S2ProjectNoteInput';
import { s2LazyResourceUi, s2ResourceUiDocument } from '../../services/scene/sceneS2ResourceUi';
import { reusableS2Document, unselectedS2Resources, s2SessionResourceKind } from '../../services/scene/sceneS2SceneSave';
import { S2WorkflowNodeView, s2WorkflowAnchorKey, type S2WorkflowNodeData } from './S2WorkflowNodeView';
import { s2PluginHelp, s2PluginHelpMatches } from '../../services/scene/sceneS2PluginHelp';
import { prepareS2FieldChoices, readS2FieldChoices, applyS2FieldChoice, listS2ValueFields, type S2FieldChoicesReport } from '../../services/scene/sceneS2FieldChoices';
import { S2JsonParameter } from './S2JsonParameter';
import { S2ConditionEditor } from './S2ConditionEditor';
import { readS2Definition, exportS2Workspace, readS2WorkspaceReference, importS2WorkspaceWithPack, exportS2Subgraph, importS2Subgraph } from '../../services/scene/sceneS2Canvas';
import { s2AllNodes, s2GroupBounds, mutateS2Batch } from '../../services/scene/sceneS2Layout';
import type { S2DesignStage } from '../../services/scene/sceneS2Design';
import { S2ConversationMemory } from '../../services/scene/sceneS2Memory';
import { snapshotS2AssistantContext } from '../../services/scene/sceneS2AssistantSnapshot';
import { s2Criteria } from '../../services/scene/sceneS2Business';
import { S2HumanInput } from './S2HumanInput';
import { S2FieldEditor, type S2FieldDrafts } from './S2FieldEditor';
import { S2ContentNodeView, type S2ContentNodeField } from './S2ContentNodeView';
import { S2FieldPreview } from './S2FieldPreview';
import { s2NodeTitle, s2NodeDescription, s2PortLabel, s2StatusLabel, s2IsHumanConfirmationOutput } from '../../services/scene/sceneS2Presentation';
import { s2MaterialInput, planS2MaterialInput, s2MaterialTypeLabel } from '../../services/scene/sceneS2Materials';
import { s2ConnectionDescriptions, s2ConnectionNodeLabel, s2ConnectionPortLabel, s2ConnectionFieldLabel } from '../../services/scene/sceneS2Connections';
import { s2ConnectionIssue } from '../../services/scene/sceneS2ConnectionIssues';
import { s2RuntimeIssue, s2WorkflowPreflightIssue, s2TextFileSelectionIssue } from '../../services/scene/sceneS2RuntimeIssues';
import { s2ControlDraft, s2DefaultFieldText, readS2FieldSubmission, type S2FieldSubmission } from '../../services/scene/sceneS2Controls';
import { S2PluginProtocolError } from '../../services/scene/sceneS2PluginProtocol';
import type { S2ArtifactViewSelection, S2JsonTreeSelection } from '../../services/scene/sceneS2Events';
import { s2ParameterSource, s2HumanDraftKey, s2ConditionSource, type S2ParameterDrafts, type S2HumanDrafts, type S2SubmitVia, type S2ConditionDrafts } from '../../services/scene/sceneS2ControlDrafts';
import { prepareS2ModelTestProvider } from '../../services/scene/sceneS2ModelTransport';
import type { S2ProjectNoteSource } from '../../services/scene/sceneS2ProjectNotes';
import { s2CanvasCompositeBlueprint, s2CompositePosition, wrapS2CanvasComposite, s2CompositePath, placeS2NewStepsInComposite } from '../../services/scene/sceneS2CompositeCanvas';
import type { S2CompositeBlueprint } from '../../types/sceneS2Composite';
import { createS2CompositeDesign, addS2CompositeDesign, instantiateS2CompositeDesign, importS2CompositeDesign, exportS2CompositeDesign, removeS2CompositeDesign } from '../../services/scene/sceneS2CompositeLibrary';
import type { S2CompositeDesign } from '../../types/sceneS2Composite';
import { compareS2CompositeDesigns, type S2CompositeComparison } from '../../services/scene/sceneS2CompositeComparison';
import { inspectS2CompositeInstance, type S2CompositeInstanceInspection } from '../../services/scene/sceneS2CompositeInstance';
import { previewS2CompositeMigration, readS2CompositeMigrationDetail, prepareS2CompositeCopy, acceptS2CompositeCopy, readS2CompositeCopyDesign, discardS2CompositeCopy,
  previewS2CompositeOutputs, checkS2CompositeOutputPlan, isS2CompositeOutputPreviewCurrent, discardS2CompositeOutputPreview,
  acceptS2CompositeOutputPlan, isS2CompositeOutputPlanCurrent, discardS2CompositeOutputPlan,
  type S2CompositeMigrationPreview, type S2CompositeCopyCandidate, type S2CompositeCopyChoice } from '../../services/scene/sceneS2CompositeMigration';
import './sceneS2Canvas.css';

interface Props {
  interactionPackRef?: import('../../types/sceneInteractionPack').SceneInteractionPackRef | null;
  initialRequest: SceneInitialRequest;
  initialDraft?: SceneSpec | null;
  projectNoteSource?: S2ProjectNoteSource;
  projectNoteSourceError?: string;
  onDraftChange?: (draft: SceneSpec | null) => void;
  onSessionStatusChange?: (status: 'idle' | 'running' | 'finished') => void;
  onExit: () => void;
}
function GroupView({ data }: NodeProps) {
  const value = data as { label: string; count: number; collapsed: boolean; toggle: () => void };
  return <article className="s2-group-frame"><header><strong>{value.label} · {value.count} 个节点</strong><button className="nodrag" aria-expanded={!value.collapsed} onClick={value.toggle}>{value.collapsed ? '展开组' : '折叠组'}</button></header>
    {value.collapsed && <p>仅折叠展示，不改变执行图。</p>}
    {/* Keep proxy anchors measurable before edges switch to the group; never expose editable group ports. */}
    <Handle type="source" position={Position.Right} isConnectable={false} aria-hidden="true" style={{ visibility: value.collapsed ? 'visible' : 'hidden' }} />
    <Handle type="target" position={Position.Left} isConnectable={false} aria-hidden="true" style={{ visibility: value.collapsed ? 'visible' : 'hidden' }} /></article>;
}
function CompositeView({ id, data }: NodeProps) {
  const value = data as { label: string; referenceLabel: string; count: number; blueprint: S2CompositeBlueprint; disabled: boolean; enter: () => void };
  const refreshAnchors = useUpdateNodeInternals();
  const anchors = JSON.stringify([value.count, value.blueprint.inputs.map(port => [port.id, port.label]), value.blueprint.outputs.map(port => [port.id, port.label]), value.blueprint.parameters.map(port => port.label)]);
  // Reparenting/editing can change public ports without resizing the shell. Refresh real handle bounds explicitly.
  useEffect(() => { refreshAnchors(id); }, [id, anchors, refreshAnchors]);
  return <article className="s2-block s2-composite"><strong>{value.label}</strong><p>组合 · {value.count} 个处理步骤</p>
    <small>{value.referenceLabel}</small>
    <p>执行状态与结果请进入内部查看；封装本身不代表运行成功。</p>
    {!!value.blueprint.inputs.length && <div><b>需要的材料</b>{value.blueprint.inputs.map(input => <div key={input.id} className="s2-composite-port"><Handle type="target" position={Position.Left} id={`in:${input.id}`} /><small>{input.label}</small></div>)}</div>}
    {!!value.blueprint.outputs.length && <div><b>输出结果</b>{value.blueprint.outputs.map(output => <div key={output.id} className="s2-composite-port"><small>{output.label}</small><Handle type="source" position={Position.Right} id={`out:${output.id}`} /></div>)}</div>}
    {!!value.blueprint.parameters.length && <p>可调项：{value.blueprint.parameters.map(parameter => parameter.label).join('、')}</p>}
    <button className="nodrag nopan" disabled={value.disabled} onClick={event => { event.stopPropagation(); value.enter(); }}>进入组合</button></article>;
}
/** Dynamic UI slots can change IDs without changing card height. Refresh the
 * real handle bounds explicitly, keeping the pure view usable in offline SSR. */
function WorkflowView(props: NodeProps) {
  const update = useUpdateNodeInternals(), value = props.data as S2WorkflowNodeData;
  const anchors = s2WorkflowAnchorKey(value), element = useRef<HTMLDivElement>(null);
  useEffect(() => { update(props.id); }, [props.id, anchors, update]);
  useEffect(() => {
    if (!element.current || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() => update(props.id));
    observer.observe(element.current);
    return () => observer.disconnect();
  }, [props.id, update]);
  return <div ref={element} className="s2-workflow-view"><S2WorkflowNodeView {...props} /></div>;
}
const nodeTypes = { block: S2ContentNodeView, execution: WorkflowView, group: GroupView, composite: CompositeView };
const registry = s2BuiltinPluginRegistry();
function pluginGuide(ref: Parameters<typeof s2PluginHelp>[0], allowed: Parameters<typeof s2PluginHelp>[1], context: string, compact = false) {
  const guide = s2PluginHelp(ref, allowed);
  return <section className={`s2-plugin-help${compact ? ' s2-plugin-help-compact' : ''}`} aria-label={context}>
    {!compact && <><strong>{guide.title}</strong><small>{guide.category}</small><p>{guide.when}</p>
      <p>需要：{guide.inputs.filter(input => input.required).map(input => input.label).join('、') || '无必填材料'}。得到：{guide.outputs.map(output => output.type).join('、') || '屏幕上的展示，不产生新输出'}。</p></>}
    <p className="s2-help-boundary">{guide.boundary}</p>
    <details key={compact && 'id' in ref ? String(ref.id) : context} aria-label={compact ? '所选步骤详细帮助' : undefined}><summary>{compact ? '用途、材料与示例（按需查看）' : '怎么使用、需要什么材料'}</summary>
      {compact && <><strong>{guide.title}</strong><small>{guide.category}</small><p>{guide.when}</p></>}
      <h4>需要提供</h4>{guide.inputs.length ? <ul>{guide.inputs.map((input, index) => <li key={index}>{input.label} · {input.type}（{input.required ? '必需' : '可选'}{input.multiple ? '，可选多路来源' : ''}）</li>)}</ul> : <p>无需输入材料。</p>}
      <h4>完成后得到</h4>{guide.outputs.length ? <ul>{guide.outputs.map((output, index) => <li key={index}>{output.label} · {output.type}
        <small>{output.consumers.length ? `本场景类型匹配的接收步骤：${output.consumers.join('、')}。` : '本场景暂未选择能直接接收此输出的步骤。'}</small></li>)}</ul> : <p>只展示已有结果，不产生新的处理输出。</p>}
      {!!guide.outputs.length && <p>接收步骤仅按真实类型与接收方式列出；不代表已接线、已授权、输入齐全或可以直接运行。</p>}
      {guide.example && <><h4>使用示例（仅说明，不填入画布）</h4><p>{guide.example}</p></>}
      <h4>与相似步骤的区别</h4><p>{guide.difference}</p>
    </details>
  </section>;
}
type Message = { role: 'user' | 'assistant'; content: string; experiment?: string };
const semanticDocumentKey = (document: S2Document) => JSON.stringify(s2SemanticDocument(document));
const migrationValueText = (value: unknown) => typeof value === 'string' ? value || '（空文本，已填写）' : JSON.stringify(value, null, 2);
class S2CanvasDisplayBoundary extends React.Component<{ children: React.ReactNode; onExit: () => void }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  componentDidCatch() { console.error('[s2-render]', { code: 'canvas-render-error' }); }
  render() {
    if (!this.state.failed) return this.props.children;
    return <section className="s2-trial" role="alert"><h2>S2 画布显示异常</h2><p>当前画布数据仍保留在会话中；重试显示不会重新请求模型。</p>
      <div><button onClick={() => this.setState({ failed: false })}>重试显示</button><button onClick={this.props.onExit}>返回搭建面板</button></div></section>;
  }
}

/** Isolated S2 host. Does not mount SceneMode, S4 stores, validators or engine sessions. */
export function SceneS2CanvasTrial({ initialRequest, initialDraft, interactionPackRef, projectNoteSource, projectNoteSourceError, onDraftChange, onSessionStatusChange, onExit }: Props) {
  const projectSourceRef = useRef(projectNoteSource); projectSourceRef.current = projectNoteSource;
  const [scene, setScene] = useState<SceneSpec | null>(null);
  const capabilityLibrary = s2ComposableCapabilities(scene ? scene.interactionPack : interactionPackRef);
  const selectedPack = scene?.interactionPack ? sceneInteractionPacks.resolve(scene.interactionPack) : undefined;
  const canvasPolicy = selectedPack?.canvas;
  const publicCatalog = selectedPack?.authoring ? publicS2Catalog(selectedPack) : undefined;
  const publicGroups = publicCatalog?.components.reduce<Array<{ id: string; label: string; componentIds: string[] }>>((groups, component) => {
    const identity = component.group ?? { id: component.id, label: component.label };
    let group = groups.find(item => item.id === identity.id);
    if (!group) { group = { ...identity, componentIds: [] }; groups.push(group); }
    group.componentIds.push(component.id); return groups;
  }, []);
  const [inlineField, setInlineField] = useState<{ sceneId: string; nodeId: string; fieldId: string } | null>(null);
  const [document, setDocument] = useState<S2Document>({ nodes: [], edges: [] });
  const documentRef = useRef(document), sceneRef = useRef(scene);
  // Keep authored anchors outside replaceable scene configs; imports cannot redefine these locks.
  const readOnlyBaseline = useRef<{ sceneId: string; document: S2Document } | null>(null);
  const documentSceneId = useRef<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [selection, setSelection] = useState<string[]>([]), selectionRef = useRef<string[]>([]);
  const [workspacePanel, setWorkspacePanel] = useState<'node' | 'add' | 'more' | 'diagnostics' | null>(null);
  const [developerDiagnostics, setDeveloperDiagnostics] = useState(false);
  const workspacePanelRef = useRef<HTMLDivElement | null>(null);
  const [groupLabel, setGroupLabel] = useState('处理分组'), [subgraphJson, setSubgraphJson] = useState('');
  const [compositeLabel, setCompositeLabel] = useState('我的处理组合'), [openComposite, setOpenComposite] = useState<string | null>(null);
  const openCompositeRef = useRef<string | null>(null);
  function showComposite(id: string | null) { if (openCompositeRef.current !== id) { clearRuntimeProblem(); setConnectionProblem(null); setOutputPreview(null); } openCompositeRef.current = id; setOpenComposite(id); }
  const [publishDraft, setPublishDraft] = useState({ source: '', family: '', name: '', version: '1.0.0', description: '' }), publishDraftRef = useRef(publishDraft);
  const { source: publishSource, family: publishFamily, name: publishName, version: publishVersion, description: publishDescription } = publishDraft;
  function editPublication(field: keyof typeof publishDraft, value: string) { publishDraftRef.current = { ...publishDraftRef.current, [field]: value }; setPublishDraft(publishDraftRef.current); setPublication(null); }
  const [publication, setPublicationState] = useState<{ design: S2CompositeDesign; base: string; scene: SceneSpec; view: string | null } | null>(null);
  const publicationRef = useRef<typeof publication>(null);
  function setPublication(value: typeof publication) { publicationRef.current = value; setPublicationState(value); }
  const [blueprintKey, setBlueprintKey] = useState(''), blueprintKeyRef = useRef('');
  const [blueprintJson, setBlueprintJson] = useState(''), blueprintJsonRef = useRef('');
  function editBlueprintJson(text: string) { blueprintJsonRef.current = text; setBlueprintJson(text); }
  const [compareVersion, setCompareVersion] = useState(''), compareVersionRef = useRef('');
  const [comparison, setComparison] = useState<{ report: S2CompositeComparison; base: string; scene: SceneSpec; view: string | null; source: string; target: string } | null>(null);
  const [instanceInspection, setInstanceInspection] = useState<{ id: string; report: S2CompositeInstanceInspection; base: string; scene: SceneSpec; view: string | null } | null>(null);
  const [migrationTargets, setMigrationTargets] = useState<Record<string, string>>({}), migrationTargetsRef = useRef(migrationTargets);
  const [migrationPreview, setMigrationPreviewState] = useState<{ id: string; version: string; report: S2CompositeMigrationPreview; base: string; configuration: string; scene: SceneSpec; view: string | null } | null>(null);
  const migrationPreviewRef = useRef<typeof migrationPreview>(null);
  const [migrationDetail, setMigrationDetail] = useState<{ key: string; result: ReturnType<typeof readS2CompositeMigrationDetail> } | null>(null);
  const [copyChoices, setCopyChoices] = useState<Record<string, S2CompositeCopyChoice>>({}), copyChoicesRef = useRef(copyChoices);
  const [copyCandidate, setCopyCandidateState] = useState<{ report: S2CompositeCopyCandidate; preview: NonNullable<typeof migrationPreview>; choicesKey: string } | null>(null);
  const copyCandidateRef = useRef<typeof copyCandidate>(null);
  const [copyDesign, setCopyDesign] = useState<ReturnType<typeof readS2CompositeCopyDesign> | null>(null);
  function setCopyCandidate(value: typeof copyCandidate) { setOutputPreview(null); discardS2CompositeCopy(copyCandidateRef.current?.report); copyCandidateRef.current = value; setCopyCandidateState(value); setCopyDesign(null); }
  function setMigrationPreview(value: typeof migrationPreview) { migrationPreviewRef.current = value; setMigrationPreviewState(value); setMigrationDetail(null); setCopyCandidate(null); copyChoicesRef.current = {}; setCopyChoices({}); }
  type OutputPreview = { report: ReturnType<typeof previewS2CompositeOutputs>; copy: NonNullable<typeof copyCandidate>; scene: SceneSpec; phase: string; view: string | null; version: number; selection: string };
  const [outputPreview, setOutputPreviewState] = useState<OutputPreview | null>(null), outputPreviewRef = useRef<OutputPreview | null>(null);
  const outputPreviewEpoch = useRef(0);
  const [outputChoices, setOutputChoices] = useState<Record<string, string>>({}), outputChoicesRef = useRef(outputChoices);
  const [outputCheck, setOutputCheckState] = useState<ReturnType<typeof checkS2CompositeOutputPlan> | null>(null);
  const outputCheckRef = useRef<typeof outputCheck>(null);
  function setOutputCheck(value: typeof outputCheck) { discardS2CompositeOutputPlan(outputCheckRef.current); outputCheckRef.current = value; setOutputCheckState(value); }
  function setOutputPreview(value: OutputPreview | null) {
    outputPreviewEpoch.current++;
    discardS2CompositeOutputPreview(outputPreviewRef.current?.report); outputPreviewRef.current = value; setOutputPreviewState(value);
    const empty: Record<string, string> = {}; outputChoicesRef.current = empty; setOutputChoices(empty); setOutputCheck(null);
  }
  const [phase, setPhase] = useState<'preview' | 'running' | 'finished'>('preview');
  const [busy, setBusy] = useState('正在准备 S2…');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [query, setQuery] = useState('');
  const [assistantBusy, setAssistantBusy] = useState(''), [assistantError, setAssistantError] = useState('');
  const assistantActive = useRef<AbortController | null>(null), assistantEpoch = useRef(0);
  const assistantEvidence = useRef(new AbortController());
  type Analysis = { scene: SceneSpec; host: S2PluginHost; document: S2Document; context: ReturnType<typeof snapshotS2AssistantContext>; selectedId: string | null; label: string };
  const [analysis, setAnalysis] = useState<Analysis | null>(null), analysisRef = useRef<Analysis | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const messagesRef = useRef(messages); messagesRef.current = messages;
  const controlDrafts = useRef<S2FieldDrafts>(new Map());
  const parameterDrafts = useRef<S2ParameterDrafts>(new Map()), humanDrafts = useRef<S2HumanDrafts>(new Map());
  const conditionDrafts = useRef<S2ConditionDrafts>(new Map());
  const packViewStates = useRef(new Map<string, Map<string, unknown>>());
  const [, refreshPackViews] = useState(0);
  const fieldChoiceDrafts = useRef(new Map<string, { report: S2FieldChoicesReport; choice: string | null; version: number; scene: SceneSpec | null; host: S2PluginHost | null; phase: string; view: string | null }>());
  const [, refreshFieldChoices] = useState(0);
  const phaseRef = useRef(phase); phaseRef.current = phase;
  const conversationMemory = useRef<S2ConversationMemory | null>(null);
  const [proposal, setProposalState] = useState<{ result: S2AgentReply; inputKey: string } | null>(null);
  const proposalRef = useRef<typeof proposal>(null);
  function setProposal(value: typeof proposal) { proposalRef.current = value; setProposalState(value); }
  const [past, setPast] = useState<S2Document[]>([]), [future, setFuture] = useState<S2Document[]>([]);
  const [edgeLabel, setEdgeLabel] = useState('关联');
  const [edgeTarget, setEdgeTarget] = useState('');
  const [connectionSelection, setConnectionSelection] = useState<{ id: string; scene: SceneSpec | null; view: string | null } | null>(null);
  const [edgeSelection, setEdgeSelection] = useState<string[]>([]), edgeSelectionRef = useRef<string[]>([]);
  const canvasKeyboardScope = useRef<HTMLDivElement | null>(null), canvasToolbar = useRef<HTMLElement | null>(null);
  function selectEdges(ids: string[]) { edgeSelectionRef.current = [...new Set(ids)]; setEdgeSelection(edgeSelectionRef.current); }
  const connectionHelp = useRef<HTMLElement | null>(null);
  type ConnectionProblem = { issue: NonNullable<ReturnType<typeof s2ConnectionIssue>>; scene: SceneSpec; document: string; version: number; phase: string; view: string | null; selection: string };
  const [connectionProblem, setConnectionProblemState] = useState<ConnectionProblem | null>(null);
  const connectionProblemRef = useRef<ConnectionProblem | null>(null);
  function setConnectionProblem(value: ConnectionProblem | null) { connectionProblemRef.current = value; setConnectionProblemState(value); }
  type RuntimeProblem = { issue: NonNullable<ReturnType<typeof s2RuntimeIssue>>; scene: SceneSpec; host: S2PluginHost;
    document: string; version: number; phase: string; view: string | null; selection: string; epoch: number; resourceVersion: number;
    evidence: { kind: 'preflight' } | { kind: 'model-preflight'; error: unknown; nodeId: string; diagnostic: string }
      | { kind: 'file-selection'; error: unknown; diagnostic: string }
      | { kind: 'runtime'; workflowId: string; nodeId: string; diagnostic: string } };
  const [runtimeProblem, setRuntimeProblemState] = useState<RuntimeProblem | null>(null);
  const runtimeProblemRef = useRef<RuntimeProblem | null>(null), runtimeProblemEpoch = useRef(0);
  const runtimeHelp = useRef<HTMLElement | null>(null);
  function setRuntimeProblem(value: RuntimeProblem | null) { runtimeProblemRef.current = value; setRuntimeProblemState(value); }
  function clearRuntimeProblem() { runtimeProblemEpoch.current++; setRuntimeProblem(null); }
  function offerRuntimeProblem(issue: RuntimeProblem['issue'], host: S2PluginHost, evidence: RuntimeProblem['evidence']) {
    setWorkspacePanel('diagnostics');
    clearRuntimeProblem();
    setRuntimeProblem({ issue, host, evidence, scene: sceneRef.current!, document: JSON.stringify(documentRef.current),
      version: historyVersion.current, phase: phaseRef.current, view: openCompositeRef.current, selection: JSON.stringify(selectionRef.current), epoch: runtimeProblemEpoch.current, resourceVersion: host.resourceSelectionVersion });
  }
  useEffect(() => { if (runtimeProblem) runtimeHelp.current?.scrollIntoView({ block: 'nearest' }); }, [runtimeProblem]);
  const recoveryPanel = useRef<HTMLElement | null>(null), recoveryFocus = useRef(false);
  const recoveryConditionPanel = useRef<HTMLDetailsElement | null>(null), recoveryConditionTarget = useRef<string | null>(null);
  const recoveryFieldPanel = useRef<HTMLElement | null>(null), recoveryFieldTarget = useRef<string | null>(null);
  const viewPanels = useRef(new Map<string, HTMLElement>()), viewPanelOwner = useRef<object | null>(null);
  const viewPanelRenderOwner = {}; viewPanelOwner.current = viewPanelRenderOwner;
  const [viewFocusRequest, setViewFocusRequest] = useState<{ target: ScenePackNavigationTarget; scene: SceneSpec; phase: typeof phase;
    version: number; document: string; view: string | null; selection: string } | null>(null);
  const pendingViewFocus = useRef<typeof viewFocusRequest>(null);
  function viewTargetKey(target: ScenePackNavigationTarget) { return JSON.stringify([target.kind, target.nodeId, 'portId' in target ? target.portId : 'fieldId' in target ? target.fieldId : null, 'sectionId' in target ? target.sectionId : null]); }
  function registerViewPanel(target: ScenePackNavigationTarget, element: HTMLElement | null) {
    const key = viewTargetKey(target); if (element) viewPanels.current.set(key, element); else viewPanels.current.delete(key);
  }
  useEffect(() => {
    const request = viewFocusRequest;
    if (!request || pendingViewFocus.current !== request) return;
    pendingViewFocus.current = null;
    if (sceneRef.current !== request.scene || phaseRef.current !== request.phase || request.phase === 'finished'
      || historyVersion.current !== request.version || openCompositeRef.current !== request.view
      || selected !== request.target.nodeId || JSON.stringify(selectionRef.current) !== request.selection
      || JSON.stringify(documentRef.current) !== request.document) return;
    const panel = viewPanels.current.get(viewTargetKey(request.target));
    if (!panel?.isConnected) return;
    for (let parent = panel.parentElement; parent; parent = parent.parentElement) if (parent.tagName === 'DETAILS') (parent as HTMLDetailsElement).open = true;
    const canvasContent = request.target.kind === 'content' && canvasPolicy?.contentSettings === 'hide';
    if (canvasContent) {
      const details = panel.querySelector<HTMLDetailsElement>(':scope > details');
      if (details) details.open = true;
    }
    panel.scrollIntoView({ block: 'center', behavior: 'auto' });
    // Keep navigation inside the editor: focusing its wrapper would trigger blur-save and immediately close it.
    const control = canvasContent ? panel.querySelector<HTMLElement>('form textarea:not(:disabled),form input:not(:disabled),form select:not(:disabled)') : null;
    (control ?? panel).focus({ preventScroll: true });
  }, [viewFocusRequest, selected, openComposite, document]);
  const humanPanels = useRef(new Map<string, HTMLElement>());
  const modelAuthorizationPanel = useRef<HTMLElement | null>(null), modelPanels = useRef(new Map<string, HTMLFieldSetElement>());
  const resourcePanels = useRef(new Map<string, HTMLElement>());
  const [resourceFocusRequest, setResourceFocusRequest] = useState<RuntimeProblem | null>(null);
  useEffect(() => {
    const request = resourceFocusRequest;
    if (!request || phaseRef.current !== 'running' || pluginHost.current !== request.host || sceneRef.current !== request.scene
      || historyVersion.current !== request.version || JSON.stringify(documentRef.current) !== request.document
      || request.host.resourceSelectionVersion !== request.resourceVersion) return;
    const nodeId = request.issue.nodeIds.find(id => resourcePanels.current.has(id));
    if (nodeId) focusCanvasControl(resourcePanels.current.get(nodeId));
  }, [resourceFocusRequest]);
  const [modelFocusRequest, setModelFocusRequest] = useState<{ host: S2PluginHost; scene: SceneSpec; waitId?: string } | null>(null);
  useEffect(() => {
    if (!modelFocusRequest || phaseRef.current !== 'running' || pluginHost.current !== modelFocusRequest.host || sceneRef.current !== modelFocusRequest.scene) return;
    if (modelFocusRequest.waitId && !modelFocusRequest.host.waitingModelTests().some(wait => wait.id === modelFocusRequest.waitId)) return;
    const panel = modelFocusRequest.waitId ? modelPanels.current.get(modelFocusRequest.waitId) : modelAuthorizationPanel.current;
    if (modelFocusRequest.waitId) focusCanvasControl(panel); else focusSidebar(panel, 'diagnostics');
  }, [modelFocusRequest]);
  const [humanFocusRequest, setHumanFocusRequest] = useState<{ waitId: string; host: S2PluginHost; scene: SceneSpec } | null>(null);
  useEffect(() => {
    if (!humanFocusRequest || phaseRef.current !== 'running' || pluginHost.current !== humanFocusRequest.host || sceneRef.current !== humanFocusRequest.scene) return;
    if (!humanFocusRequest.host.workflowHistory().some(run => run.publication === 'current' && ['queued', 'running', 'waiting'].includes(run.status)
      && run.waiting?.some(wait => wait.id === humanFocusRequest.waitId))) return;
    const panel = humanPanels.current.get(humanFocusRequest.waitId);
    focusCanvasControl(panel);
  }, [humanFocusRequest]);
  useEffect(() => {
    if (!recoveryFocus.current) return;
    recoveryFocus.current = false;
    const conditionTarget = recoveryConditionTarget.current; recoveryConditionTarget.current = null;
    const fieldTarget = recoveryFieldTarget.current; recoveryFieldTarget.current = null;
    if (conditionTarget !== null && conditionTarget === selected && recoveryConditionPanel.current) {
      // Navigation only: leave source inspection, drafts, applying and execution to explicit user actions.
      recoveryConditionPanel.current.open = true;
      focusSidebar(recoveryConditionPanel.current);
      return;
    }
    if (fieldTarget !== null && fieldTarget === selected && recoveryFieldPanel.current) {
      focusSidebar(recoveryFieldPanel.current);
      return;
    }
    focusSidebar(recoveryPanel.current);
  }, [selected, openComposite, connectionProblem, runtimeProblem]);
  const pluginHost = useRef<S2PluginHost | null>(null);
  const resourceUiScopes = useRef(new WeakMap<SceneSpec, ReturnType<typeof s2LazyResourceUi>>());
  const sceneLifetime = useRef(0);
  type UserExecution = { host: S2PluginHost; scene: SceneSpec; controller: AbortController; preparing: boolean; workflowId?: string; causeId?: string; error?: string; status?: string };
  const userExecutions = useRef(new Map<string, UserExecution>());
  function clearUserExecutions() { for (const operation of userExecutions.current.values()) operation.controller.abort(); userExecutions.current.clear(); }
  const [pluginResults, setPluginResults] = useState<S2LocalExecution[]>([]);
  const [pluginProposal, setPluginProposalState] = useState<{ request: S2PluginRequest; frame: S2InteractionFrame; originatingUserMessageId?: string } | null>(null);
  const pluginProposalRef = useRef<typeof pluginProposal>(null);
  function setPluginProposal(value: typeof pluginProposal) { pluginProposalRef.current = value; setPluginProposalState(value);  }
  const [pluginField, setPluginField] = useState('');
  const [workflowRuns, setWorkflowRuns] = useState<S2WorkflowRun[]>([]);
  const [reading, setReading] = useState<{ host: S2PluginHost; scene: SceneSpec; workflowId: string; nodeId: string } | null>(null);
  const resultDialog = useRef<HTMLDialogElement | null>(null);
  const resultOpener = useRef<HTMLElement | null>(null);
  const libraryPanel = useRef<HTMLHeadingElement | null>(null);
  const libraryDisclosure = useRef<HTMLDetailsElement | null>(null);
  const agentPanel = useRef<HTMLHeadingElement | null>(null);
  function focusCanvasControl(panel: HTMLElement | null | undefined) {
    if (!panel) return;
    setWorkspacePanel(null); panel.scrollIntoView({ block: 'center' });
    (panel.querySelector<HTMLElement>('input:not(:disabled),select:not(:disabled),textarea:not(:disabled),button:not(:disabled)') ?? panel).focus({ preventScroll: true });
  }
  function focusSidebar(panel: HTMLElement | null, destination?: 'add' | 'more' | 'node' | 'diagnostics') {
    if (panel === agentPanel.current) { panel?.focus({ preventScroll: true }); return; }
    setWorkspacePanel(destination ?? (panel === libraryPanel.current ? 'add' : panel === modelAuthorizationPanel.current ? 'diagnostics' : 'node'));
    panel?.scrollIntoView({ block: 'start' }); panel?.focus({ preventScroll: true });
  }
  useEffect(() => {
    const panel = workspacePanelRef.current;
    if (!workspacePanel || !panel || panel.contains(panel.ownerDocument.activeElement)) return;
    panel.focus({ preventScroll: true });
  }, [workspacePanel]);
  useEffect(() => {
    const dialog = resultDialog.current, opener = resultOpener.current;
    if (!reading || reading.scene !== scene || !dialog) return;
    dialog.showModal();
    return () => { dialog.close(); if (opener?.isConnected) opener.focus(); };
  }, [reading, scene]);
  const [executionProposal, setExecutionProposalState] = useState<{ request: NonNullable<S2AgentReply['executionRequest']>; semanticKey: string; originatingUserMessageId?: string } | null>(null);
  const executionProposalRef = useRef<typeof executionProposal>(null);
  function setExecutionProposal(value: typeof executionProposal) { executionProposalRef.current = value; setExecutionProposalState(value);  }
  const [libraryQuery, setLibraryQuery] = useState(''), [libraryKey, setLibraryKey] = useState('');
  const [libraryCategory, setLibraryCategory] = useState('');
  const [wireSource, setWireSource] = useState(''), [wireOutput, setWireOutput] = useState(''), [wireInput, setWireInput] = useState('');
  const [workspaceJson, setWorkspaceJson] = useState('');
  const workspaceJsonRef = useRef(workspaceJson); workspaceJsonRef.current = workspaceJson;
  const active = useRef<AbortController | null>(null);
  const saving = useRef(false), saveSequence = useRef(0);
  const dragStart = useRef<{ document: S2Document; scene: SceneSpec | null; host: S2PluginHost | null; ticket?: object } | null>(null);
  const historyVersion = useRef(0);
  // React Flow's controlled nodes must retain measured sizes or adoptUserNodes clears handle bounds.
  // This is presentation-only state, never part of the document, host revision or saved template.
  const measuredNodes = useRef(new Map<string, { width: number; height: number }>());
  const [, setMeasurementRevision] = useState(0);
  const draftCallback = useRef(onDraftChange); draftCallback.current = onDraftChange;
  const statusCallback = useRef(onSessionStatusChange); statusCallback.current = onSessionStatusChange;
  function showDesignProgress(controller: AbortController, stage: S2DesignStage, attempt: number) {
    if (controller.signal.aborted || active.current !== controller) return;
    const labels = { understand: '理解目标与互动分工', assemble: '选择组件并搭建画布', review: '审查目标覆盖与交互闭环' };
    setBusy(`S2 搭建 Agent：${labels[stage]}${attempt > 1 ? '（重新装配后）' : ''}…`);
  }
  function assertContentEdit(next: S2Document) {
    const baseline = readOnlyBaseline.current;
    if (baseline && baseline.sceneId === sceneRef.current?.sceneId)
      assertS2ReadOnlyContent(baseline.document, next, { requirePresence: true });
    if (documentSceneId.current === sceneRef.current?.sceneId) assertS2ReadOnlyContent(documentRef.current, next);
    const reference = sceneRef.current?.interactionPack;
    if (reference && sceneRef.current) {
      const definition = readS2Scene(sceneRef.current);
      const currentDocument = documentSceneId.current === sceneRef.current.sceneId ? documentRef.current : definition.initial;
      assertS2PublicEdit(sceneInteractionPacks.resolve(reference), { definition, document: currentDocument }, { definition, document: next });
    }
  }
  function assertSceneReplacement(next: SceneSpec) {
    const definition = readS2Scene(next);
    const originalReference = sceneRef.current?.interactionPack;
    const originalInternal = originalReference ? sceneInteractionPacks.resolve(originalReference).authoring?.internal?.document : undefined;
    if (originalReference && originalInternal && (originalInternal.nodes.length || originalInternal.execution?.nodes.length)
      && JSON.stringify(originalReference) !== JSON.stringify(next.interactionPack))
      throw new Error('当前公开画布不能通过更换包引用解除内部组件保护，请退出后打开新的场景');
    if (next.interactionPack) {
      const pack = sceneInteractionPacks.resolve(next.interactionPack);
      const beforeDefinition = sceneRef.current ? readS2Scene(sceneRef.current) : definition;
      assertS2PublicEdit(pack, { definition: beforeDefinition, document: documentRef.current }, { definition, document: definition.initial });
    }
    if (readOnlyBaseline.current?.sceneId === next.sceneId) {
      assertS2ReadOnlyContent(readOnlyBaseline.current.document, definition.initial, { requirePresence: true });
      if (documentSceneId.current === next.sceneId) assertS2ReadOnlyContent(documentRef.current, definition.initial);
    }
  }
  function write(next: S2Document) {
    assertContentEdit(next);
    pluginHost.current?.setDocument(next);
    clearRuntimeProblem();
    setConnectionProblem(null);
    // Retire actual-add confirmations monotonically, including edit→undo and same-content workspace replacement.
    setCopyCandidate(null);
    const semanticChanged = semanticDocumentKey(documentRef.current) !== semanticDocumentKey(next);
    documentSceneId.current = sceneRef.current?.sceneId ?? null;
    documentRef.current = next; setDocument(next);
    if (openCompositeRef.current && !next.composites?.some(composite => composite.id === openCompositeRef.current)) showComposite(null);
    if (semanticChanged) {
      for (const operation of userExecutions.current.values()) if (operation.preparing) {
        operation.controller.abort(); operation.preparing = false; operation.status = '内容已变化，请重新测试。';
      }
      setPluginProposal(null); setExecutionProposal(null);
    }
    if (proposalRef.current && proposalRef.current.inputKey !== JSON.stringify(next)) {
      setProposal(null);
      setNotice(semanticChanged ? '画布内容已变化，修改建议已过期；请重新请求。' : '布局已变化，已保留解释，但修改建议已过期；请基于当前布局重新请求。');
    }
    setPluginResults(pluginHost.current?.history() ?? []);
    setWorkflowRuns(pluginHost.current?.workflowHistory() ?? []);
    const existing = new Set(s2AllNodes(next).map(node => node.id));
    selectNodes(selectionRef.current.filter(id => existing.has(id)), false);
  }
  function selectNodes(ids: string[], observe = true) {
    if (observe && (phaseRef.current === 'finished' || sceneRef.current !== scene)) return;
    const existing = new Set(s2AllNodes(documentRef.current).map(node => node.id));
    const next = [...new Set(ids)].filter(id => existing.has(id));
    setSelected(current => current && next.includes(current) ? current : null);
    if (JSON.stringify(next) === JSON.stringify(selectionRef.current)) return;
    clearRuntimeProblem();
    setConnectionProblem(null);
    setOutputPreview(null);
    selectionRef.current = next; setSelection(next);
    if (observe && phaseRef.current === 'running') pluginHost.current?.recordCanvasSelection(next);
  }
  function startContentEdit(nodeId: string, field: S2Field) {
    act(() => {
      if (!scene || phaseRef.current === 'finished' || sceneRef.current !== scene) throw new Error('编辑入口已过期，请在当前画布重新打开。');
      const node = documentRef.current.nodes.find(item => item.id === nodeId);
      const pack = scene.interactionPack ? sceneInteractionPacks.resolve(scene.interactionPack) : undefined;
      if (pack?.authoring && (!node || !findS2PublicComponent(pack, node, documentRef.current)?.parameters.includes(field.id))) throw new Error('这个包内字段未公开，不能编辑');
      const current = readS2Scene(scene).blockTypes.find(type => type.id === node?.type)?.fields.find(item => item.id === field.id);
      if (!node || node.readOnly || JSON.stringify(current) !== JSON.stringify(field)) throw new Error('内容已变化或只读，请在当前画布重新选择。');
      setSelected(nodeId); selectNodes([nodeId]); setWorkspacePanel(null);
      setInlineField({ sceneId: scene.sceneId, nodeId, fieldId: field.id });
    });
  }
  function focusNode(id: string | null) {
    if (phaseRef.current === 'finished' || sceneRef.current !== scene) return;
    setSelected(id); selectNodes(id ? [id] : []);
    if (!id) return;
    const content = documentRef.current.nodes.find(node => node.id === id);
    if (content && canvasPolicy?.contentSettings === 'hide') {
      const field = readS2Scene(scene!).blockTypes.find(type => type.id === content.type)?.fields[0];
      if (field && !content.readOnly && canvasPolicy.contentEditing !== 'panel') startContentEdit(id, field);
      else setWorkspacePanel(null);
      return;
    }
    setWorkspacePanel(shouldOpenSettings(id) ? 'node' : null);
  }
  function shouldOpenSettings(id: string) {
    if (canvasPolicy?.openSettingsOnSelect !== undefined) return canvasPolicy.openSettingsOnSelect;
    const step = documentRef.current.execution?.nodes.find(node => node.id === id);
    if (step) return !scenePackHasCustomView(scene?.interactionPack, step);
    return !['inline', 'double-click'].includes(canvasPolicy?.contentEditing ?? 'panel');
  }
  /** Successful whole-workspace replacement, not a user callback or a user-selection event.
   * putScene has already advanced sceneRef; the normal stale-callback/finished guards must stay intact. */
  function resetCanvasSelection() { setInlineField(null); setSelected(null); selectNodes([], false); selectEdges([]); showComposite(null); setPublication(null); setComparison(null); setInstanceInspection(null); setMigrationPreview(null); migrationTargetsRef.current = {}; setMigrationTargets({}); packViewStates.current.clear(); fieldChoiceDrafts.current.clear(); }
  function compositeOperation(id: string, action: 'enter' | 'leave' | 'unwrap' | 'select', expectedScene: SceneSpec, base: string) {
    act(() => {
      if (phaseRef.current === 'finished' || sceneRef.current !== expectedScene || openCompositeRef.current !== openComposite || JSON.stringify(documentRef.current) !== base) throw new Error('组合或画布已变化，请在当前页面重新操作。');
      const composite = documentRef.current.composites?.find(item => item.id === id); if (!composite) throw new Error('组合已不存在');
      if (action === 'unwrap') { patch([{ op: 'remove-composite', id }]); showComposite(composite.parentId ?? null); selectNodes(composite.nodeIds); return; }
      if (action === 'select') { selectNodes(composite.nodeIds); return; }
      showComposite(action === 'enter' ? id : composite.parentId ?? null); focusNode(null);
    });
  }
  function batch(action: S2BatchAction['kind'], delta?: { x: number; y: number }) {
    act(() => {
      if (phaseRef.current === 'finished' || sceneRef.current !== scene || openCompositeRef.current !== openComposite) throw new Error('选区操作已过期');
      finishDrag();
      const host = pluginHost.current, ticket = host?.beginCanvasOperation();
      const before = new Set(s2AllNodes(documentRef.current).map(node => node.id));
      patch([{ op: 'batch-nodes', action: { kind: action, nodeIds: selectionRef.current, ...(delta ? { delta } : {}), ...(openComposite ? { compositeId: openComposite } : {}) } }]);
      if (ticket) host!.recordCanvasOperation(ticket, action, 'control');
      if (action === 'copy') selectNodes(s2AllNodes(documentRef.current).filter(node => !before.has(node.id)).map(node => node.id));
      if (action === 'delete') focusNode(null);
    });
  }
  function putScene(next: SceneSpec, options: { initialize?: boolean; authoredReplacement?: boolean } = {}) {
    if (!options.initialize) assertSceneReplacement(next);
    if (options.initialize || options.authoredReplacement || readOnlyBaseline.current?.sceneId !== next.sceneId) {
      readOnlyBaseline.current = { sceneId: next.sceneId, document: structuredClone(readS2Scene(next).initial) };
    }
    if (options.initialize || sceneRef.current?.sceneId !== next.sceneId) {
      documentSceneId.current = null;
    }
    if (sceneRef.current?.sceneId !== next.sceneId) packViewStates.current.clear();
    setInlineField(null); clearRuntimeProblem(); sceneRef.current = next; setScene(next);
  }
  function commit(next: S2Document) {
    if (!sceneRef.current) return;
    const checked = readS2Document(next, readS2Scene(sceneRef.current));
    assertContentEdit(checked);
    finishDrag();
    if (JSON.stringify(checked) === JSON.stringify(documentRef.current)) return;
    // React may defer updater functions until after write() advances documentRef.
    const previous = structuredClone(documentRef.current);
    historyVersion.current++;
    setPast(old => [...old, previous].slice(-50)); setFuture([]); write(checked);
  }
  function act(action: () => void) { try { setError(''); action(); } catch (e) { setError((e as Error).message); } }
  function rejectConnection(issue: ConnectionProblem['issue']): never {
    setWorkspacePanel('node');
    setConnectionProblem({ issue, scene: sceneRef.current!, document: JSON.stringify(documentRef.current), version: historyVersion.current,
      phase: phaseRef.current, view: openCompositeRef.current, selection: JSON.stringify(selectionRef.current) });
    connectionHelp.current?.scrollIntoView({ block: 'nearest' });
    throw new Error(`${issue.title}：${issue.summary} ${issue.detail}`);
  }
  function patch(commands: unknown) {
    if (!sceneRef.current) return;
    setConnectionProblem(null);
    const definition = readS2Scene(sceneRef.current);
    let next: S2Document;
    try { next = applyS2Commands(definition, documentRef.current, commands, readOnlyBaseline.current?.document, sceneRef.current?.interactionPack); }
    catch (error) {
      // Diagnostics explain a native rejection; they never replace validation or apply a partial graph.
      const issue = s2ConnectionIssue(definition, documentRef.current, commands, error);
      if (!issue) throw error;
      rejectConnection(issue);
    }
    commit(next);
  }
  /** New steps belong to the displayed container; Agent proposals use their explicit hierarchy instead. */
  function patchHere(commands: unknown) {
    if (phaseRef.current === 'finished' || sceneRef.current !== scene || openCompositeRef.current !== openComposite || JSON.stringify(documentRef.current) !== JSON.stringify(document)) throw new Error('当前组合或画布已变化，请重新添加。');
    const next = applyS2Commands(readS2Scene(sceneRef.current!), documentRef.current, commands, readOnlyBaseline.current?.document, sceneRef.current?.interactionPack);
    commit(openComposite ? placeS2NewStepsInComposite(documentRef.current, next, openComposite) : next);
  }
  function finishDrag() {
    const gesture = dragStart.current; dragStart.current = null;
    if (!gesture || phaseRef.current === 'finished' || gesture.scene !== sceneRef.current || gesture.host !== pluginHost.current
      || JSON.stringify(gesture.document) === JSON.stringify(documentRef.current)) return;
    // Never put an older content snapshot into position history after an intervening semantic edit.
    if (semanticDocumentKey(gesture.document) !== semanticDocumentKey(documentRef.current)
      || JSON.stringify(gesture.document.groups ?? []) !== JSON.stringify(documentRef.current.groups ?? [])
      || JSON.stringify(gesture.document.composites ?? []) !== JSON.stringify(documentRef.current.composites ?? [])) return;
    setPast(old => [...old, gesture.document].slice(-50)); setFuture([]); historyVersion.current++;
    if (gesture.ticket) gesture.host!.recordCanvasOperation(gesture.ticket, 'move', 'canvas');
  }
  function beginDrag() {
    if (phaseRef.current === 'finished') return;
    if (!dragStart.current) dragStart.current = { document: structuredClone(documentRef.current), scene: sceneRef.current,
      host: pluginHost.current, ticket: pluginHost.current?.beginCanvasOperation() };
  }
  function groupOperation(group: NonNullable<S2Document['groups']>[number], action: 'select' | 'toggle' | 'ungroup', expectedScene: SceneSpec) {
    act(() => {
      if (phaseRef.current === 'finished' || sceneRef.current !== expectedScene) throw new Error('分组操作已过期');
      const current = documentRef.current.groups?.find(item => item.id === group.id);
      if (!current || JSON.stringify(current) !== JSON.stringify(group)) throw new Error('分组已变化，未使用旧成员或旧状态');
      if (action === 'select') { setSelected(current.nodeIds[0]); selectNodes(current.nodeIds); return; }
      finishDrag(); const host = pluginHost.current, ticket = host?.beginCanvasOperation();
      patch(action === 'ungroup' ? [{ op: 'remove-group', id: current.id }]
        : [{ op: 'set-group', group: { ...current, collapsed: !current.collapsed } }]);
      if (ticket) host!.recordCanvasOperation(ticket, action === 'ungroup' ? 'ungroup' : current.collapsed ? 'expand' : 'collapse', 'control');
    });
  }
  function changeHistory(action: 'undo' | 'redo', version: number, expectedScene: SceneSpec) {
    let applied = false;
    act(() => {
      if (phaseRef.current === 'finished' || sceneRef.current !== expectedScene || version !== historyVersion.current) throw new Error('历史操作已过期，未覆盖当前画布');
      if (dragStart.current) { finishDrag(); throw new Error('移动已保存，请基于当前历史重新操作'); }
      const stack = action === 'undo' ? past : future, next = stack.at(-1);
      if (!next) return;
      assertContentEdit(next);
      const previous = structuredClone(documentRef.current);
      const host = pluginHost.current, ticket = host?.beginCanvasOperation(); historyVersion.current++;
      if (action === 'undo') { setPast(past.slice(0, -1)); setFuture(old => [...old, previous]); }
      else { setFuture(future.slice(0, -1)); setPast(old => [...old, previous].slice(-50)); }
      write(next); applied = true; if (ticket) host!.recordCanvasOperation(ticket, action, 'control');
      setNotice(scenePackAllowsExecution(selectedPack) ? `已${action === 'undo' ? '撤销' : '重做'}本次设计修改，没有运行。历史记录和已用额度保留；不会恢复旧等待或把旧结果作为当前结果。` : `已${action === 'undo' ? '撤销' : '重做'}本次设计修改。`);
    });
    return applied;
  }
  function syncControlStates(host: S2PluginHost) {
    if (!sceneRef.current) return;
    const def = readS2Scene(sceneRef.current);
    for (const node of documentRef.current.nodes) for (const field of def.blockTypes.find(type => type.id === node.type)!.fields) {
      const draft = controlDrafts.current.get(JSON.stringify([node.id, field.id]));
      if (!draft?.state) continue;
      host.recordFieldControl(node.id, field.id, draft.base, draft.schema !== JSON.stringify(field) ? 'conflict' : draft.state);
    }
    for (const node of documentRef.current.execution?.nodes ?? []) for (const port of registry.capability(node).inputs) {
      const draft = parameterDrafts.current.get(JSON.stringify([node.id, port.id]));
      if (draft?.state) host.recordParameterControl(node.id, port.id, draft.base, draft.state);
    }
    for (const node of documentRef.current.execution?.nodes ?? []) {
      const draft = conditionDrafts.current.get(node.id);
      if (draft?.state) host.recordConditionControl(node.id, draft.base, draft.state);
    }
    for (const wait of host.waitingHumanInputs()) {
      const draft = humanDrafts.current.get(s2HumanDraftKey(wait));
      if (draft?.state) host.recordHumanControl(wait.workflowId, wait.id, draft.state);
    }
  }
  function commitParameter(nodeId: string, portId: string, value: import('../../types/sceneS2Plugin').S2Json, base: string, expectedScene: SceneSpec, via?: S2SubmitVia) {
    if (phaseRef.current === 'finished' || sceneRef.current !== expectedScene) throw new Error('参数提交已过期，草稿已保留');
    const source = s2ParameterSource(documentRef.current, nodeId, portId);
    if (source.key !== base || source.connected) throw new Error('参数来源或接线已变化，请载入当前参数后重新编辑');
    patch([{ op: 'update-execution-node', id: nodeId, bindings: { [portId]: { kind: 'literal', value } } }]);
    const nextSource = s2ParameterSource(documentRef.current, nodeId, portId).key;
    pluginHost.current?.recordParameterControl(nodeId, portId, nextSource, 'submitted', via);
    return nextSource;
  }
  function commitInputBinding(nodeId: string, portId: string, binding: S2InputBinding | null, base: string, expectedScene: SceneSpec) {
    if (phaseRef.current === 'finished' || sceneRef.current !== expectedScene) throw new Error('参数操作已过期，未修改当前绑定');
    const source = s2ParameterSource(documentRef.current, nodeId, portId);
    if (source.key !== base || source.connected) throw new Error('参数来源或接线已变化，未覆盖当前绑定');
    patch(binding ? [{ op: 'update-execution-node', id: nodeId, bindings: { [portId]: binding } }] : [{ op: 'unbind-input', id: nodeId, portId }]);
    const next = s2ParameterSource(documentRef.current, nodeId, portId).key;
    pluginHost.current?.recordParameterControl(nodeId, portId, next, !binding ? 'cleared' : binding.kind === 'field' ? 'referenced' : 'committed');
    return next;
  }
  function commitCondition(nodeId: string, when: S2WorkflowCondition | null, base: string, expectedScene: SceneSpec, via?: S2SubmitVia) {
    if (phaseRef.current === 'finished' || sceneRef.current !== expectedScene) throw new Error('条件操作已过期，草稿已保留');
    if (s2ConditionSource(documentRef.current, nodeId).key !== base) throw new Error('条件或来源已变化，请载入当前条件后重新编辑');
    patch([{ op: 'set-execution-condition', id: nodeId, when }]);
    const next = s2ConditionSource(documentRef.current, nodeId).key;
    pluginHost.current?.recordConditionControl(nodeId, next, when ? 'submitted' : 'cleared', via);
    return next;
  }
  function renderFieldChoices(node: NonNullable<S2Document['execution']>['nodes'][number]) {
    if (node.pluginId !== 'structured-data' || node.pluginVersion !== '1.0.0' || node.capabilityId !== 'select') return null;
    const version = historyVersion.current, host = pluginHost.current, view = openCompositeRef.current;
    const guard = () => {
      if (phaseRef.current !== phase || phaseRef.current === 'finished' || sceneRef.current !== scene || historyVersion.current !== version
        || pluginHost.current !== host || openCompositeRef.current !== view || !selectionRef.current.includes(node.id)) throw new Error('字段选择操作已过期，请在当前步骤重新查看。');
    };
    const readOutput = host ? (nodeId: string, portId: string) => host.readCurrentStructuredOutput(nodeId, portId) : undefined;
    const saved = fieldChoiceDrafts.current.get(node.id);
    let shown: S2FieldChoicesReport | undefined, unavailable = '';
    if (saved) try {
      if (saved.version !== version || saved.scene !== scene || saved.host !== host || saved.phase !== phase || saved.view !== view) throw new Error('画布或会话已变化，草稿保留但未应用；请重新查看字段。');
      shown = readS2FieldChoices(saved.report, definition!, document, readOutput);
    } catch (error) { unavailable = (error as Error).message; }
    const current = saved;
    return <section ref={recoveryFieldPanel} tabIndex={-1} className="s2-control-editor" aria-label="按字段选择要提取的内容"><h4>选择要提取的内容</h4>
      <p>从已填写的固定材料或已运行的当前结果中按名称选择；只查看字段，不解析原文、不读取资料，也不运行上游。</p>
      <button type="button" disabled={finished} onClick={() => act(() => {
        guard(); const report = prepareS2FieldChoices(definition!, documentRef.current, node.id, readOutput);
        if (!fieldChoiceDrafts.current.has(node.id) && fieldChoiceDrafts.current.size >= 40) fieldChoiceDrafts.current.delete(fieldChoiceDrafts.current.keys().next().value!);
        fieldChoiceDrafts.current.set(node.id, { report, choice: report.current, version, scene, host, phase, view }); refreshFieldChoices(value => value + 1);
        setNotice('已查看当前材料的字段；没有修改材料、应用提取位置或运行步骤。');
      })}>查看当前材料的字段（不运行）</button>
      {unavailable && <p role="status">{unavailable}</p>}
      {shown && current && <form aria-label="设置提取字段" onSubmit={event => { event.preventDefault(); act(() => {
        guard(); if (fieldChoiceDrafts.current.get(node.id) !== current || current.choice === null) throw new Error('字段草稿已变化或尚未选择，请重新确认。');
        const next = applyS2FieldChoice(current.report, definition!, documentRef.current, current.choice, readOutput);
        commit(next); fieldChoiceDrafts.current.delete(node.id); refreshFieldChoices(value => value + 1);
        pluginHost.current?.recordParameterControl(node.id, 'pointer', s2ParameterSource(documentRef.current, node.id, 'pointer').key, 'submitted');
        setNotice('已应用提取字段；原材料、其他参数和连线保留，没有运行。新设计可能使旧运行结果失效，执行仍需单独确认。');
      }); }}><p>字段来自：{shown.sourceLabel}</p>
        <label>要提取哪一部分<select disabled={finished || !shown.canApply} value={current.choice === null ? '' : JSON.stringify(current.choice)} onChange={event => act(() => {
          guard(); if (fieldChoiceDrafts.current.get(node.id) !== current) throw new Error('字段草稿已变化，请重新选择。');
          readS2FieldChoices(current.report, definition!, documentRef.current, readOutput);
          const chosen = shown!.options.find(option => JSON.stringify(option.pointer) === event.target.value);
          if (!chosen) throw new Error('请选择当前列表中的内容。');
          fieldChoiceDrafts.current.set(node.id, { ...current, choice: chosen.pointer }); refreshFieldChoices(value => value + 1);
        })}><option value="">请选择要提取的内容</option>{shown.options.map(option => <option key={option.pointer} value={JSON.stringify(option.pointer)}>{option.label}（{option.type}）</option>)}</select></label>
        {!shown.canApply && <p>提取位置由内容块或上游提供，保留原引用；请在原来源或高级设置修改，不用字段选择覆盖。</p>}
        {shown.canApply && shown.current === null && <p>当前提取位置尚未设置或不在这份材料中；查看和选择不会修改原设置。</p>}
        <button type="submit" disabled={finished || !shown.canApply || current.choice === null}>应用提取字段（不运行）</button>
      </form>}
      <small>只提取一个明确位置，不筛选记录、不猜业务含义。高级设置仍可查看或编辑完整提取位置；材料或当前结果变化后须重新查看。</small>
    </section>;
  }
  function renderConditionControls(node: NonNullable<S2Document['execution']>['nodes'][number]) {
    const source = s2ConditionSource(document, node.id), version = historyVersion.current, host = pluginHost.current, view = openCompositeRef.current;
    const guard = () => {
      if (phaseRef.current !== phase || phaseRef.current === 'finished' || sceneRef.current !== scene || historyVersion.current !== version
        || pluginHost.current !== host || openCompositeRef.current !== view || !selectionRef.current.includes(node.id)) throw new Error('条件操作已过期，请在当前步骤重新编辑。');
    };
    return <details key={`condition-${node.id}`} ref={recoveryConditionPanel} tabIndex={-1} aria-label="运行条件设置"><summary>何时运行这个步骤（可选）{node.when ? ' · 已设置条件' : ''}</summary>
      <S2ConditionEditor nodeId={node.id} when={node.when} disabled={finished} drafts={conditionDrafts.current} sourceKey={source.key}
        sources={source.sources.map(item => {
          const producer = document.execution!.nodes.find(node => node.id === item.nodeId)!;
          const port = s2BuiltinPluginRegistry().capability(producer).outputs.find(port => port.id === item.portId)!;
          return { ...item, confirmation: s2IsHumanConfirmationOutput(producer, item.portId), label: `${s2NodeTitle(producer)} · ${s2PortLabel(producer, port, 'outputs')}（步骤 ${document.execution!.nodes.indexOf(producer) + 1}）` };
        })}
        onInspectSource={(sourceId, portId) => {
          guard();
          if (!source.sources.some(item => item.nodeId === sourceId && item.portId === portId)) throw new Error('请选择本场景可用的条件来源。');
          if (!host) throw new Error('请先运行来源步骤，再查看字段；查看不会替你运行。');
          const artifact = host.readCurrentConditionOutput(sourceId, portId);
          if (artifact.payload.kind !== 'inline') throw new Error('没有完整的当前结果，不能猜测字段。');
          const producer = document.execution!.nodes.find(item => item.id === sourceId);
          const confirmation = s2IsHumanConfirmationOutput(producer, portId);
          const options = listS2ValueFields(artifact.payload.value).map(item => confirmation && item.pointer === '/approved' && item.type === '布尔值'
            ? { ...item, label: '是否同意' } : item), identity = JSON.stringify(artifact);
          if (options.some(item => item.pointer.length > 500)) throw new Error('结果中存在过长字段路径，未截断；请使用高级编辑。');
          const pointers = new Set(options.map(item => item.pointer));
          return { options, check: pointer => {
            guard();
            if (JSON.stringify(host.readCurrentConditionOutput(sourceId, portId)) !== identity) throw new Error('来源结果已变化，旧字段列表未应用。');
            if (pointer !== undefined && !pointers.has(pointer)) throw new Error('请选择当前结果中实际存在的字段。');
          } };
        }}
        onApply={(when, base = source.key, via) => { guard(); return commitCondition(node.id, when, base, scene!, via); }}
        onStateChange={(state, base, via) => {
          if (phaseRef.current === 'running' && pluginHost.current === host && sceneRef.current === scene) host?.recordConditionControl(node.id, base, state, via);
        }} />
    </details>;
  }
  function prepareHostContext(host: S2PluginHost, selectedId: string | null, strategy: S2InteractionFrame['strategy'], text: string) {
    finishDrag(); syncControlStates(host); return host.prepare(selectedId, strategy, text);
  }
  function recordView(artifactId: string, view: S2ArtifactViewSelection) {
    if (phaseRef.current === 'running') act(() => pluginHost.current?.recordArtifactView(artifactId, view));
  }
  function recordTreeView(artifactId: string, view: S2JsonTreeSelection) {
    if (phaseRef.current === 'running') act(() => pluginHost.current?.recordJsonTreeView(artifactId, view));
  }
  function editPlainField(nodeId: string, fieldId: string, value: string) {
    if (phaseRef.current === 'finished' || sceneRef.current !== scene) throw new Error('本次编辑已过期，未修改当前画布');
    patch([{ op: 'update-node', id: nodeId, values: { [fieldId]: value } }]);
    pluginHost.current?.recordFieldControl(nodeId, fieldId, value, 'committed');
  }
  function submitField(event: S2FieldSubmission, expectedScene: SceneSpec, expectedSchema: string) {
    if (phaseRef.current === 'finished' || sceneRef.current !== expectedScene) throw new Error('本次字段提交已过期，草稿已保留');
    const def = readS2Scene(expectedScene), node = documentRef.current.nodes.find(node => node.id === event.nodeId);
    const field = def.blockTypes.find(type => type.id === node?.type)?.fields.find(field => field.id === event.fieldId);
    if (!node || !field || JSON.stringify(field) !== expectedSchema || node.values[field.id] !== event.previousValue) throw new Error('字段已变化，请载入当前值后重新编辑');
    if (node.readOnly) throw new Error('只读内容块是场景固定内容，不能提交修改');
    event = readS2FieldSubmission(event, node.id, field, node.values[field.id]);
    if (event.value !== event.previousValue) patch([{ op: 'update-node', id: node.id, values: { [field.id]: event.value } }]);
    controlDrafts.current.set(JSON.stringify([node.id, field.id]), { base: event.value, schema: JSON.stringify(field), draft: s2ControlDraft(field, event.value), state: 'submitted' });
    pluginHost.current?.recordFieldControl(node.id, field.id, event.value, 'submitted');
  }
  function offerEdits(result: S2AgentReply, inputKey: string) {
    if (!result.commands.length) return;
    // Editing remains bound to the complete snapshot: never rebase position commands onto a newer layout.
    if (inputKey === JSON.stringify(documentRef.current)) setProposal({ result, inputKey });
    else setNotice('布局已变化，已保留解释，但修改建议已过期；请基于当前布局重新请求。');
  }
  const interactionEvents = useRef<S2InteractionEventRouter | null>(null);
  useEffect(() => () => interactionEvents.current?.close(), []);
  useEffect(() => { if (phase === 'finished') interactionEvents.current?.close(); }, [phase]);
  useEffect(() => { void interactionEvents.current?.flush(); }, [busy, assistantBusy]);
  function stopAssistant() {
    assistantEpoch.current++; assistantActive.current?.abort(); assistantActive.current = null;
    setAssistantBusy('');
  }
  /** End the local lifetime before releasing services, so retained callbacks cannot revive it. */
  function releaseSceneSession() {
    interactionEvents.current?.close(); interactionEvents.current = null;
    const hadScene = !!sceneRef.current;
    phaseRef.current = 'finished'; sceneRef.current = null; historyVersion.current++; sceneLifetime.current++;
    resourceUiScopes.current = new WeakMap();
    clearUserExecutions(); active.current?.abort(); active.current = null;
    assistantEpoch.current++; assistantActive.current?.abort(); assistantActive.current = null;
    assistantEvidence.current.abort(); analysisRef.current = null;
    conversationMemory.current?.close(); conversationMemory.current = null;
    const host = pluginHost.current; pluginHost.current = null; closeSceneInteractionHost(host);
    discardS2CompositeOutputPlan(outputCheckRef.current); outputCheckRef.current = null;
    discardS2CompositeOutputPreview(outputPreviewRef.current?.report); outputPreviewRef.current = null; outputPreviewEpoch.current++;
    discardS2CompositeCopy(copyCandidateRef.current?.report); copyCandidateRef.current = null;
    saveSequence.current++;
    if (hadScene) statusCallback.current?.('finished');
  }
  function leaveScene() {
    releaseSceneSession(); setPhase('finished'); onExit();
  }
  function captureAnalysis(host: S2PluginHost, selectedId: string | null, event: S2InteractionFrame['event'], label: string, remember = true): Analysis {
    const original = sceneRef.current!;
    const context = prepareHostContext(host, selectedId, { goal: readS2Scene(original).goal, ...readS2Scene(original).instructions }, '只读分析本次实验');
    context.frame.event = event;
    const evidence = { host, scene: original, document: structuredClone(documentRef.current), selectedId, label,
      context: snapshotS2AssistantContext(context, assistantEvidence.current.signal) };
    if (remember) { analysisRef.current = evidence; setAnalysis(evidence); }
    return evidence;
  }
  async function analyze(evidence: Analysis, content = '请对照本次实验的真实输入、完整返回与场景预期，指出偏差、依据和可以调整的部分。没有明确标准时只给建议；正文不可用时说明不确定。不得改图、申请插件或运行，也不自动重试。', originatingUserMessageId?: string) {
    if (assistantActive.current || phaseRef.current !== 'running' || sceneRef.current !== evidence.scene || pluginHost.current !== evidence.host) return;
    const controller = new AbortController(), epoch = ++assistantEpoch.current; assistantActive.current = controller;
    setAssistantBusy(`助手正在分析${evidence.label}；可继续编辑和运行`); setAssistantError('');
    try {
      const result = await interactS2Canvas(evidence.scene, evidence.document, content, evidence.selectedId, messagesRef.current, {
        readOnlyBaseline: readOnlyBaseline.current?.document,
        signal: controller.signal, pluginContext: evidence.context, origin: 'host-event', originatingUserMessageId });
      if (controller.signal.aborted || epoch !== assistantEpoch.current || phaseRef.current !== 'running'
        || pluginHost.current !== evidence.host || sceneRef.current !== evidence.scene) return;
      // Defensive UI boundary as well as the service-side read-only protocol.
      if (result.commands.length || result.pluginRequests?.length || result.executionRequest) throw new Error('只读分析不能修改画布、调用插件或申请运行');
      const stillCurrent = semanticDocumentKey(evidence.document) === semanticDocumentKey(documentRef.current);
      if (result.assessment && stillCurrent) evidence.host.recordAssessment(result.assessment);
      setMessages(old => [...old, { role: 'assistant', content: result.reply,
        experiment: `${evidence.label}${stillCurrent ? '' : ' · 历史结果，不代表当前配置达标'}` }]);
    } catch (error) {
      if (!controller.signal.aborted && epoch === assistantEpoch.current) setAssistantError(`实验结果已保留，助手分析失败：${(error as Error).message}`);
    } finally { if (assistantActive.current === controller) { assistantActive.current = null; setAssistantBusy(''); } }
  }
  const requestKey = JSON.stringify(initialRequest);
  async function importWorkspace() {
    if (phaseRef.current !== 'preview' || active.current || saving.current || !sceneRef.current) {
      setError('只允许在空闲的预览阶段导入'); return;
    }
    const original = sceneRef.current, base = JSON.stringify(documentRef.current), version = historyVersion.current;
    const text = workspaceJsonRef.current, controller = new AbortController();
    active.current = controller; setBusy('正在读取工作区及所需交互包…'); setError('');
    try {
      const reference = readS2WorkspaceReference(text);
      const selectedPack = reference === undefined ? original.interactionPack : reference;
      if (selectedPack) await loadSceneInteractionPack(selectedPack);
      if (controller.signal.aborted) return;
      if (active.current !== controller || phaseRef.current !== 'preview' || sceneRef.current !== original
        || historyVersion.current !== version || JSON.stringify(documentRef.current) !== base || workspaceJsonRef.current !== text)
        throw new Error('导入期间画布或文件已变化，请基于当前内容重新导入');
      const { definition: next } = importS2WorkspaceWithPack(text);
      if (selectedPack) {
        const allowed = new Set(s2ComposableCapabilities(selectedPack).map(s2CapabilityKey));
        if (next.plugins?.some(capability => !allowed.has(s2CapabilityKey(capability))))
          throw new Error('工作区包含所选交互包范围之外的能力，请核对包引用；当前画布已保留');
      }
      const updated = { ...original, ...(selectedPack === undefined ? {} : { interactionPack: selectedPack }),
        task: next.goal, meta: { ...original.meta, goal: next.goal }, canvasWorkspace: next };
      readS2Scene(updated);
      assertSceneReplacement(updated);
      measuredNodes.current.clear(); historyVersion.current++;
      controlDrafts.current.clear(); parameterDrafts.current.clear(); humanDrafts.current.clear(); conditionDrafts.current.clear();
      putScene(updated, { authoredReplacement: true }); write(next.initial);
      setPast([]); setFuture([]); resetCanvasSelection(); setProposal(null);
      setNotice('已导入交互包引用和画布预览；尚未授予执行或模型权限。');
    } catch (error) {
      if (!controller.signal.aborted) setError(error instanceof Error ? error.message : '工作区导入失败，原画布已保留');
    } finally {
      if (active.current === controller) { active.current = null; setBusy(''); }
    }
  }
  useEffect(() => {
    releaseSceneSession(); setScene(null);
    setInlineField(null);
    setAssistantBusy(''); assistantEvidence.current = new AbortController();
    analysisRef.current = null; setAnalysis(null); setAssistantError('');
    controlDrafts.current.clear();
    parameterDrafts.current.clear(); humanDrafts.current.clear();
    conditionDrafts.current.clear();
    packViewStates.current.clear(); fieldChoiceDrafts.current.clear();
    dragStart.current = null;
    setPluginResults([]); setPluginProposal(null); setWorkflowRuns([]); setExecutionProposal(null);
    const controller = new AbortController(); active.current = controller;
    statusCallback.current?.('idle');
    void (async () => {
      try {
        setBusy('正在准备 S2…'); setError('');
        let next = initialDraft ?? (initialRequest.source === 'existing'
          ? await loadScene(initialRequest.sceneId || '') : createS2Scene(initialRequest));
        if (controller.signal.aborted) return;
        if (!next) throw new Error('S2 场景不存在，请返回场景库重新选择');
        if (interactionPackRef) next = { ...next, interactionPack: { ...interactionPackRef } };
        else if (interactionPackRef === null) next = { ...next, interactionPack: null };
        const storedDefinition = readS2Scene(next); // Reject S4 and historical S2 placeholders; never migrate implicitly.
        // New lifetimes cannot revive handles, including those in older saved scenes.
        next = { ...next, canvasWorkspace: { ...storedDefinition, initial: reusableS2Document(storedDefinition.initial) } };
        if (next.interactionPack) next = { ...next, canvasWorkspace: prepareS2PublicDefinition(sceneInteractionPacks.resolve(next.interactionPack), readS2Scene(next),
          { fresh: !initialDraft && initialRequest.source !== 'existing' }) };
        if (!initialDraft && ['build', 'auto'].includes(initialRequest.source)) {
          setBusy('S2 搭建 Agent 正在设计画布…');
          next = { ...next, canvasWorkspace: await designS2Canvas(next, { signal: controller.signal, onProgress: (stage, attempt) => showDesignProgress(controller, stage, attempt) }) };
        }
        if (controller.signal.aborted) return;
        const definition = readS2Scene(next);
        measuredNodes.current.clear();
        putScene(next, { initialize: true }); write(structuredClone(definition.initial)); resetCanvasSelection();
        const reselect = unselectedS2Resources(definition.initial);
        setNotice(reselect.length ? `画布配置已载入；${reselect.length} 个资料入口需要重新选择本局资料，选择后可直接使用包内入口。` : '画布配置已载入，可直接编辑或使用包内入口。');
        setMessages([]); setProposal(null); setPast([]); setFuture([]); phaseRef.current = 'preview'; setPhase('preview');
      } catch (e) { if (!controller.signal.aborted) setError((e as Error).message); }
      finally { if (active.current === controller) { active.current = null; setBusy(''); } }
    })();
    return () => { controller.abort(); releaseSceneSession(); };
  }, [requestKey]);
  useEffect(() => {
    if (phase === 'preview' && scene) draftCallback.current?.({ ...scene, canvasWorkspace: s2InteractionDocumentSnapshot(readS2Scene(scene), document) });
  }, [scene, document, phase]);

  async function redesign() {
    if (active.current || saving.current || !sceneRef.current || phase !== 'preview') return;
    const controller = new AbortController(); active.current = controller; setBusy('S2 搭建 Agent 正在重新设计…'); setError('');
    try {
      const current = sceneRef.current, inputKey = JSON.stringify(documentRef.current);
      const definition = await designS2Canvas({ ...current, canvasWorkspace: s2InteractionDocumentSnapshot(readS2Scene(current), documentRef.current) }, { signal: controller.signal, onProgress: (stage, attempt) => showDesignProgress(controller, stage, attempt) });
      if (controller.signal.aborted) return;
      if (inputKey !== JSON.stringify(documentRef.current) || sceneRef.current !== current) throw new Error('设计期间内容已变化，未覆盖当前画布；请重新设计');
      // Explicit replacement action is preview-only; existing saved scenes are never overwritten.
      const updated = { ...current, canvasWorkspace: definition };
      assertSceneReplacement(updated);
      measuredNodes.current.clear();
      putScene(updated, { authoredReplacement: true }); write(structuredClone(definition.initial));
      setPast([]); setFuture([]); resetCanvasSelection();
    } catch (e) { if (!controller.signal.aborted) setError((e as Error).message); }
    finally { if (active.current === controller) { active.current = null; setBusy(''); } }
  }
  function publicInteractionConfig() {
    const owner = sceneRef.current;
    if (!owner) throw new Error('当前场景尚未就绪');
    return { definition: readS2Definition(s2InteractionDocumentSnapshot(readS2Scene(owner), documentRef.current)), document: documentRef.current };
  }
  async function runPublicInteraction(task: string, origin: 'user' | 'event', scope: S2InteractionScope,
    event?: S2InteractionEvent, cause?: S2InteractionCause) {
    if (assistantActive.current || phaseRef.current === 'finished' || !sceneRef.current) return;
    let host: S2PluginHost, pack: ReturnType<typeof sceneInteractionPacks.resolve>;
    try {
      const reference = sceneRef.current.interactionPack;
      if (!reference) throw new Error('公开交互需要已加载的交互包');
      pack = sceneInteractionPacks.resolve(reference); host = ensureSession();
    } catch (error) { setAssistantError((error as Error).message); return; }
    const ownerId = sceneRef.current!.sceneId, controller = new AbortController(), epoch = ++assistantEpoch.current;
    assistantActive.current = controller; setAssistantBusy(origin === 'event' ? '助手正在处理场景事件…' : '助手正在回应…'); setAssistantError('');
    let expected = semanticDocumentKey(documentRef.current), resources = host.resourceSelectionVersion;
    const guard = () => {
      if (controller.signal.aborted || epoch !== assistantEpoch.current) throw new DOMException('本次交互已停止', 'AbortError');
      if (phaseRef.current === 'finished' || pluginHost.current !== host || sceneRef.current?.sceneId !== ownerId
        || expected !== semanticDocumentKey(documentRef.current) || resources !== host.resourceSelectionVersion) throw new Error('交互期间场景或资料已变化，旧操作未应用');
    };
    const source = cause ?? (event ? { id: event.causeId, chain: event.chain } : interactionEvents.current?.newCause()) ?? { id: crypto.randomUUID(), chain: [] };
    const cancelCause = () => interactionEvents.current?.cancelCause(source.id);
    controller.signal.addEventListener('abort', cancelCause, { once: true });
    try {
      const config = publicInteractionConfig();
      const selectedNodeIds = selectionRef.current.filter(id => s2AllNodes(config.document).some(node => node.id === id));
      const focus = event?.nodeId ?? (selected && selectedNodeIds.includes(selected) ? selected : null);
      const context = prepareHostContext(host, focus, { goal: config.definition.goal, ...config.definition.instructions }, task);
      const response = await interactS2PublicScene({ pack, ...config, task, origin, scope,
        ...(event ? { event: { type: event.type, nodeId: event.nodeId, data: event.data }, eventInvocationId: event.invocationId } : {}),
        history: messagesRef.current, selectedNodeIds, pluginContext: context, readOnlyBaseline: readOnlyBaseline.current?.document,
        signal: controller.signal, call: (prompt, input, tokens) => invokeS2InteractionModel(prompt, input, undefined, controller.signal, tokens) });
      guard();
      const plan = prepareS2InteractionActions(pack, publicInteractionConfig(), response.actions ?? [], scope, readOnlyBaseline.current?.document);
      const report = await executeS2InteractionActions(plan, { guard, readConfig: publicInteractionConfig,
        applyConfig(next) {
          guard();
          // Keep the live trigger configuration/history; portable snapshots prune
          // dangling references, and undo can restore a removed trigger source.
          commit(next.document); expected = semanticDocumentKey(documentRef.current); resources = host.resourceSelectionVersion;
        },
        async run(targets) {
          guard();
          const abort = () => {
            const operation = userExecutions.current.get(targets[0]);
            if (operation?.host === host && operation.causeId === source.id) cancelUserExecution(operation);
          };
          controller.signal.addEventListener('abort', abort, { once: true });
          try { const result = await runUserWorkflow(targets[0], targets, source); guard(); return result; }
          finally { controller.signal.removeEventListener('abort', abort); }
        },
        cancel(runId) {
          guard();
          const run = host.workflowHistory().find(item => item.id === runId && item.publication === 'current');
          const allowed = new Set(scope.nodeIds ?? projectS2PublicCanvas(pack, readS2Scene(sceneRef.current!), documentRef.current).nodes.map(node => node.id));
          if (!run || !run.targets.every(id => allowed.has(id))) throw new Error('取消目标不属于本轮公开范围');
          const operation = [...userExecutions.current.entries()].find(([, item]) => item.host === host && item.workflowId === runId);
          if (operation) cancelUserExecution(operation[1]); else host.cancelWorkflow(runId);
          refreshWorkflow(host);
        },
      });
      if (controller.signal.aborted || epoch !== assistantEpoch.current || pluginHost.current !== host || sceneRef.current?.sceneId !== ownerId) return;
      const message = report.status === 'completed' ? response.reply ?? (plan.actionCount ? '操作已完成。' : '')
        : `${report.error?.reason ?? '操作未完成'}；已完成的操作和结果已保留，后续动作已停止。`;
      if (message) setMessages(old => [...old, { role: 'assistant', content: message }]);
    } catch (error) {
      if (!controller.signal.aborted && epoch === assistantEpoch.current) setAssistantError((error as Error).message);
    } finally {
      controller.signal.removeEventListener('abort', cancelCause);
      if (assistantActive.current === controller) { assistantActive.current = null; setAssistantBusy(''); }
      void interactionEvents.current?.flush();
    }
  }
  async function ask() {
    if (assistantActive.current || phaseRef.current === 'finished' || !sceneRef.current || !query.trim()) return;
    const reference = sceneRef.current.interactionPack;
    let publicPackage = false;
    try { publicPackage = !!(reference && sceneInteractionPacks.resolve(reference).authoring); }
    catch (error) { setAssistantError((error as Error).message); return; }
    if (publicPackage) {
      const content = query; setQuery(''); setMessages(old => [...old, { role: 'user', content }]);
      await runPublicInteraction(content, 'user', { actions: ['reply', 'edit', 'execute'] }); return;
    }
    try { ensureSession(); } catch (error) { setAssistantError((error).message); return; }
    const controller = new AbortController(), epoch = ++assistantEpoch.current; assistantActive.current = controller;
    const content = query; setQuery(''); setAssistantError(''); setProposal(null); setPluginProposal(null); setExecutionProposal(null); setAssistantBusy('助手正在理解你的要求；可继续编辑和运行');
    const previousMessages = messagesRef.current, history = [...previousMessages, { role: 'user' as const, content }]; setMessages(history);
    const original = sceneRef.current, snapshot = structuredClone(documentRef.current), inputKey = JSON.stringify(snapshot), semanticKey = semanticDocumentKey(snapshot);
    const memory = conversationMemory.current;
    try {
      const selectedNodeIds = selectionRef.current.filter(id => s2AllNodes(snapshot).some(node => node.id === id));
      const selectedFocus = selected && selectedNodeIds.includes(selected) ? selected : null;
      // The selection is discussion context only; prepare still snapshots inputs for one explicit focus.
      const pluginContext = pluginHost.current ? prepareHostContext(pluginHost.current, selectedFocus, { goal: readS2Scene(original).goal, ...readS2Scene(original).instructions }, content) : undefined;
      const result = await interactS2Canvas(original, snapshot, content, selectedFocus, previousMessages, { signal: controller.signal, pluginContext, memory: memory ?? undefined, origin: 'user', selectedNodeIds,
        readOnlyBaseline: readOnlyBaseline.current?.document,
        ...(openCompositeRef.current ? { viewCompositeId: openCompositeRef.current } : {}) });
      if (controller.signal.aborted || epoch !== assistantEpoch.current || phaseRef.current !== 'running' || sceneRef.current !== original) return;
      if (semanticKey !== semanticDocumentKey(documentRef.current)) { setAssistantError('回应期间画布已变化，修改建议已丢弃；现有内容未覆盖。'); return; }
      if (result.assessment) pluginHost.current?.recordAssessment(result.assessment);
      setMessages(old => [...old, { role: 'assistant', content: result.reply }]);
      if (conversationMemory.current === memory) memory?.accept(result);
      offerEdits(result, inputKey);
      if (result.pluginRequests?.length || result.executionRequest) setAssistantError('当前包尚未提供公开交互动作接口，请通过包内入口执行；助手的解释与画布修改建议已保留。');
    } catch (e) {
      if (!controller.signal.aborted && epoch === assistantEpoch.current) { setAssistantError((e as Error).message); setQuery(content); }
    } finally { if (assistantActive.current === controller) { assistantActive.current = null; setAssistantBusy(''); } }
  }
  async function runPlugin(request: S2PluginRequest, frame: S2InteractionFrame, originatingUserMessageId?: string) {
    const host = pluginHost.current, original = sceneRef.current;
    if (!host || !original || active.current || saving.current || phaseRef.current !== 'running') return;
    if (original.interactionPack && !scenePackAllowsExecution(sceneInteractionPacks.resolve(original.interactionPack))) { setError('当前插件包仅编辑，修改后直接生效'); return; }
    const controller = new AbortController(); active.current = controller; setBusy('正在执行本地插件…'); setError(''); setPluginProposal(null); setProposal(null); setExecutionProposal(null);
    const semanticKey = semanticDocumentKey(documentRef.current);
    let completedAnalysis: Analysis | undefined;
    try {
      const execution = await host.execute(request, frame, `call-${crypto.randomUUID()}`, controller.signal);
      if (pluginHost.current !== host) return;
      setPluginResults(host.history());
      if (controller.signal.aborted) return;
      if (execution.receipt.publication !== 'current' || semanticKey !== semanticDocumentKey(documentRef.current)) {
        setNotice('检查期间画布已变化，结果只保留为过期记录，未交给 Agent 或覆盖画布。'); return;
      }
      if (execution.receipt.status !== 'succeeded') { setError(execution.receipt.error?.message || '本地插件未成功执行'); return; }
      setNotice('本地检查完成，结果已保留；可按需请助手分析，未自动运行其他步骤。');
      try { completedAnalysis = captureAnalysis(host, request.nodeId,
        { id: `event-${crypto.randomUUID()}`, kind: 'plugin-completed', invocationId: execution.receipt.invocationId, nodeId: request.nodeId }, `第 ${host.history().length} 次插件检查 · 修订 ${execution.receipt.revision}`); }
      catch (error) { setAssistantError(`检查结果已保留，未能准备分析：${(error as Error).message}`); }
    } catch (e) { if (!controller.signal.aborted) setError(`插件执行未完成：${(e as Error).message}；已有本地记录不会重试或清除。`); }
    finally {
      if (pluginHost.current === host) setPluginResults(host.history());
      if (active.current === controller) { active.current = null; setBusy(''); }
    }
    if (completedAnalysis && originatingUserMessageId) void analyze(completedAnalysis, undefined, originatingUserMessageId);
  }
  function checkSelectedField() {
    act(() => {
      if (!sceneRef.current || !selectedNode) throw new Error('请选择待检查块');
      ensureSession();
      const context = prepareHostContext(pluginHost.current, selectedNode.id, { goal: definition!.goal, ...definition!.instructions }, '检查所选字段');
      const binding = context.bindings.find(item => item.fieldId === pluginField) ?? context.bindings[0];
      if (!binding) throw new Error('所选字段不存在');
      void runPlugin({ ...S2_JSON_CHECK_BINDING, nodeId: selectedNode.id, inputs: { text: [binding.artifactId] }, reason: `用户检查字段 ${binding.fieldId} 的 JSON 格式` }, context.frame);
    });
  }
  function refreshWorkflow(host: S2PluginHost) {
    if (pluginHost.current !== host) return;
    setWorkflowRuns(host.workflowHistory()); setPluginResults(host.history());
  }
  /** Synchronous, user-action-only acquisition. Rendering and editing never create a host or call a model. */
  function ensureSession() {
    const owner = sceneRef.current;
    if (!owner || phaseRef.current === 'finished') throw new Error('当前场景已结束或尚未就绪');
    if (pluginHost.current) return pluginHost.current;
    if (active.current || saving.current) throw new Error('场景正在准备或保存，请稍后重试');
    const currentDefinition = readS2Scene(owner);
    const host = new S2PluginHost(owner.sceneId, { ...currentDefinition, initial: readOnlyBaseline.current?.document ?? currentDefinition.initial }, scenePackLocalAdapter(owner.interactionPack), next => {
      if (owner.interactionPack) assertS2PublicEdit(sceneInteractionPacks.resolve(owner.interactionPack),
        { definition: readS2Scene(owner), document: documentRef.current }, { definition: readS2Scene(owner), document: next });
    });
    try {
      host.setDocument(documentRef.current);
      const notes = projectSourceRef.current;
      if (notes && notes.projectId === initialRequest.taskBinding?.noteId && currentDefinition.plugins?.some(cap => cap.pluginId === 'project-notes')) host.bindProjectNotes(notes);
      syncControlStates(host);
      if (owner.interactionPack) validateS2PublicInteraction(sceneInteractionPacks.resolve(owner.interactionPack),
        s2InteractionDocumentSnapshot(currentDefinition, documentRef.current));
    } catch (error) { closeSceneInteractionHost(host); throw error; }
    pluginHost.current = host;
    conversationMemory.current?.close(); conversationMemory.current = new S2ConversationMemory(owner.sceneId, host.runId);
    setConnectionProblem(null); phaseRef.current = 'running'; setPhase('running'); statusCallback.current?.('running');
    if (owner.interactionPack) {
      const pack = sceneInteractionPacks.resolve(owner.interactionPack);
      if (pack.authoring) {
        const router = new S2InteractionEventRouter({ pack, readConfig: publicInteractionConfig,
          revision: () => historyVersion.current,
          current: () => pluginHost.current === host && sceneRef.current?.sceneId === owner.sceneId && phaseRef.current === 'running',
          canRun: () => !assistantActive.current && !active.current && !saving.current
            && ![...userExecutions.current.values()].some(item => item.host === host && (item.preparing
              || host.workflowHistory().some(run => run.id === item.workflowId && ['queued', 'running', 'waiting'].includes(run.status)))),
          run: ({ trigger, scope, event }) => runPublicInteraction(trigger.task, 'event', scope, event),
          onError: error => setAssistantError((error as Error).message),
        });
        interactionEvents.current = router;
        bindS2PackageInteractionEvents(host, (nodeId, event, data) => router.publish(event, nodeId, data));
      }
    }
    return host;
  }
  function sceneResourceUi() {
    const owner = scene;
    if (!owner) return null;
    let facade = resourceUiScopes.current.get(owner);
    if (!facade) {
      const lifetime = sceneLifetime.current;
      facade = s2LazyResourceUi(() => sceneLifetime.current === lifetime && sceneRef.current === owner && phaseRef.current !== 'finished' ? pluginHost.current : null,
        () => { if (sceneLifetime.current !== lifetime || sceneRef.current !== owner || phaseRef.current === 'finished') throw new S2PluginProtocolError('RUN_ENDED', 'resource', '资料所属场景已变化'); return ensureSession(); },
        () => {
          if (sceneLifetime.current !== lifetime || sceneRef.current !== owner || phaseRef.current === 'finished') return [];
          if (projectNoteSourceError) throw new Error(projectNoteSourceError);
          const source = projectSourceRef.current;
          return source?.projectId === initialRequest.taskBinding?.noteId ? source?.choices() ?? [] : [];
        });
      resourceUiScopes.current.set(owner, facade);
    }
    return facade;
  }
  async function runUserWorkflow(nodeId: string, targets: string[], cause?: S2InteractionCause): Promise<S2WorkflowRun | { status: 'failed' | 'cancelled'; error?: string }> {
    const currentScene = sceneRef.current;
    if (!currentScene || phaseRef.current === 'finished') return { status: 'failed', error: '当前场景已结束或尚未就绪' };
    if (currentScene.interactionPack && !scenePackAllowsExecution(sceneInteractionPacks.resolve(currentScene.interactionPack)))
      return { status: 'failed', error: '当前插件包仅编辑，修改后直接生效' };
    let host: S2PluginHost;
    try { host = ensureSession(); } catch (error) { setError((error as Error).message); return { status: 'failed', error: (error as Error).message }; }
    const prior = userExecutions.current.get(nodeId);
    if (prior?.preparing || host.workflowHistory().some(run => run.publication === 'current' && ['queued', 'running', 'waiting'].includes(run.status)
      && run.nodes.some(item => item.nodeId === nodeId))) return { status: 'failed', error: '该步骤已经在执行' };
    const base = semanticDocumentKey(documentRef.current), resources = host.resourceSelectionVersion;
    const operation: UserExecution = { host, scene: currentScene, controller: new AbortController(), preparing: true, status: '准备测试…' };
    userExecutions.current.set(nodeId, operation); refreshPackViews(value => value + 1);
    const current = () => userExecutions.current.get(nodeId) === operation && !operation.controller.signal.aborted
      && pluginHost.current === host && phaseRef.current === 'running' && sceneRef.current === currentScene;
    const source = cause ?? interactionEvents.current?.newCause();
    operation.causeId = source?.id;
    let releaseCause: (() => void) | undefined;
    try {
      const selected = selectS2Execution(documentRef.current, readS2Scene(currentScene).plugins, targets);
      if (source) releaseCause = interactionEvents.current?.bindCause(selected.graph.nodes.map(node => node.id), source);
      if (selected.graph.nodes.some(node => registry.capability(node).permissions.includes('model-call'))) {
        if (!host.modelTestSummary()) {
          if ([...userExecutions.current.values()].some(item => item !== operation && item.preparing)) throw new Error('模型正在准备，请稍后再测试。');
          const prepared = await prepareS2ModelTestProvider(operation.controller.signal);
          if (!current()) return { status: 'cancelled' };
          if (semanticDocumentKey(documentRef.current) !== base || host.resourceSelectionVersion !== resources) throw new Error('内容或资料已变化，请重新点击测试。');
          const session = prepared.createSession(currentScene.sceneId, host.runId,
            { maxRequests: 24, maxOutputTokens: 2048, maxReservedOutputTokens: 48000 });
          host.approveModelTestSession(session);
        }
      }
      if (!current()) return { status: 'cancelled' };
      if (semanticDocumentKey(documentRef.current) !== base || host.resourceSelectionVersion !== resources) throw new Error('内容或资料已变化，请重新点击测试。');
      const scheduled = enqueueSceneInteractionUserWorkflow(host,
        { definition: s2InteractionDocumentSnapshot(readS2Scene(currentScene), documentRef.current), document: documentRef.current },
        currentScene.interactionPack, targets, () => refreshWorkflow(host));
      operation.workflowId = scheduled.id; operation.preparing = false; operation.status = undefined;
      refreshWorkflow(host); refreshPackViews(value => value + 1);
      const record = await scheduled.completion;
      if (!current()) return { status: 'cancelled' };
      operation.status = record.publication !== 'current' ? '内容已变化，请重新测试。'
        : record.status === 'cancelled' ? '已停止' : record.status === 'succeeded' ? '测试完成' : undefined;
      operation.error = record.error;
      refreshWorkflow(host);
      if (record.publication === 'current' && currentScene.interactionPack && interactionEvents.current) {
        const pack = sceneInteractionPacks.resolve(currentScene.interactionPack);
        const publicIds = new Set(projectS2PublicCanvas(pack, readS2Scene(currentScene), documentRef.current).nodes.map(node => node.id));
        for (const member of record.nodes) if (publicIds.has(member.nodeId) && ['succeeded', 'failed'].includes(member.status)) {
          interactionEvents.current.publish(`s2.node.${member.status}`, member.nodeId,
            { resultIds: member.artifactIds.slice(0, 128), ...(member.status === 'failed' ? { error: '该步骤执行失败，可按需读取本次执行资料。' } : {}) },
            source, `${record.id}:${member.nodeId}`, member.invocationId);
        }
      }
      return record;
    } catch (error) {
      if (current()) { operation.error = (error as Error).message; operation.status = undefined; }
      return { status: operation.controller.signal.aborted ? 'cancelled' : 'failed', error: (error as Error).message };
    } finally {
      releaseCause?.();
      operation.preparing = false;
      if (userExecutions.current.get(nodeId) === operation && pluginHost.current === host && phaseRef.current === 'running') refreshPackViews(value => value + 1);
      void interactionEvents.current?.flush();
    }
  }
  function cancelUserExecution(operation: UserExecution) {
    if (operation.causeId) interactionEvents.current?.cancelCause(operation.causeId);
    operation.controller.abort(); operation.preparing = false; operation.status = '已停止'; operation.error = undefined;
    if (operation.workflowId) operation.host.cancelWorkflow(operation.workflowId);
    if (pluginHost.current === operation.host) { refreshWorkflow(operation.host); refreshPackViews(value => value + 1); }
  }
  function stopUserWorkflow(nodeId: string) {
    const operation = userExecutions.current.get(nodeId), host = pluginHost.current;
    if (!host || phaseRef.current !== 'running') return;
    if (operation && operation.host === host && operation.scene === sceneRef.current) {
      if (operation.causeId) interactionEvents.current?.cancelCause(operation.causeId);
      operation.controller.abort(); operation.preparing = false; operation.status = '已停止'; operation.error = undefined;
    }
    for (const run of host.workflowHistory()) if (run.publication === 'current' && ['queued', 'running', 'waiting'].includes(run.status)
      && run.nodes.some(item => item.nodeId === nodeId)) host.cancelWorkflow(run.id);
    refreshWorkflow(host); refreshPackViews(value => value + 1);
  }
  function guardConnectionAction() {
    if (phaseRef.current === 'finished' || phaseRef.current !== phase || sceneRef.current !== scene || openCompositeRef.current !== openComposite
      || historyVersion.current !== renderedHistoryVersion || JSON.stringify(documentRef.current) !== JSON.stringify(document)) {
      throw new Error('连接操作已过期，未改变画布；请在当前画布重新操作。');
    }
  }
  function checkMaterialConnection(source: { nodeId: string; portId: string } | { nodeId: string; fieldId: string }, target: { nodeId: string; portId: string }) {
    const targetNode = documentRef.current.execution?.nodes.find(node => node.id === target.nodeId);
    const input = targetNode && registry.capability(targetNode).inputs.find(port => port.id === target.portId);
    if (!input) throw new Error('接收材料的位置已不存在，请重新选择步骤。');
    const sourceNode = 'portId' in source && documentRef.current.execution?.nodes.find(node => node.id === source.nodeId);
    const output = sourceNode && registry.capability(sourceNode).outputs.find(port => port.id === (source as { portId: string }).portId);
    const type = 'fieldId' in source ? { id: 'core.text', version: 1 } : output ? output.type : undefined;
    if (!type) throw new Error('来源结果已不存在，请重新选择。');
    if (!registry.compatible(type, input.type) || output && output.multiple && !input.multiple) {
      const from = 'fieldId' in source ? s2ConnectionFieldLabel(definition!, documentRef.current, source.nodeId, source.fieldId)
        : s2ConnectionPortLabel(definition!, documentRef.current, source, 'outputs');
      throw new Error(`不能直接连接：${from}提供${s2MaterialTypeLabel(type)}，${s2ConnectionPortLabel(definition!, documentRef.current, target, 'inputs')}需要${s2MaterialTypeLabel(input.type)}${output && output.multiple && !input.multiple ? '且只能接收一份结果' : ''}。未修改连接；请查看步骤用途，明确选择本场景允许的转换方式，系统不会自动转换或运行。`);
    }
  }
  function connect(source: string, sourceHandle: string | null, target: string, targetHandle: string | null) {
    guardConnectionAction();
    setConnectionProblem(null);
    const checkFieldReplacement = (endpoint: { nodeId: string; portId: string }) => {
      const receiver = documentRef.current.execution?.nodes.find(node => node.id === endpoint.nodeId);
      const binding = receiver?.bindings[endpoint.portId];
      if (!binding) return;
      const existing = binding.kind === 'literal' ? '已经填写的固定材料'
        : s2ConnectionFieldLabel(definition!, documentRef.current, binding.nodeId, binding.fieldId);
      rejectConnection({ kind: 'occupied-input', title: '这个位置已经有材料',
        summary: `${s2ConnectionPortLabel(definition!, documentRef.current, endpoint, 'inputs')}正在使用${existing}，拖入内容引用不会替换它。`,
        detail: '若要更换，请打开该步骤的材料来源，明确选用新的内容；只想查看时无需修改。',
        nodeIds: [endpoint.nodeId], connectionIds: binding.kind === 'field' ? [JSON.stringify([endpoint.nodeId, endpoint.portId, binding])] : [],
        technical: JSON.stringify({ target: endpoint, existingBindingKind: binding.kind }, null, 2) });
    };
    const sourceComposite = documentRef.current.composites?.find(composite => composite.id === source), targetComposite = documentRef.current.composites?.find(composite => composite.id === target);
    if (sourceComposite || targetComposite) {
      if (phaseRef.current === 'finished' || sceneRef.current !== scene || openCompositeRef.current !== openComposite || JSON.stringify(documentRef.current) !== JSON.stringify(document)) throw new Error('组合接线已过期');
      const sourceEndpoint = sourceComposite ? s2CanvasCompositeBlueprint(documentRef.current, sourceComposite, definition!.plugins).outputs.find(port => `out:${port.id}` === sourceHandle)?.source
        : sourceHandle?.startsWith('out:') ? { nodeId: source, portId: sourceHandle.slice(4) } : undefined;
      const targets = targetComposite ? s2CanvasCompositeBlueprint(documentRef.current, targetComposite, definition!.plugins).inputs.find(port => `in:${port.id}` === targetHandle)?.targets
        : targetHandle?.startsWith('in:') ? [{ nodeId: target, portId: targetHandle.slice(3) }] : undefined;
      if (!targets || !targets.length) throw new Error('请选择组合的真实材料入口');
      if (sourceEndpoint) { targets.forEach(target => checkMaterialConnection(sourceEndpoint, target)); patch(targets.map(target => ({ op: 'connect-ports', link: { source: sourceEndpoint, target } }))); }
      else if (!sourceComposite && sourceHandle?.startsWith('field:')) {
        targets.forEach(target => checkMaterialConnection({ nodeId: source, fieldId: sourceHandle.slice(6) }, target));
        targets.forEach(checkFieldReplacement);
        patch(targets.map(target => ({ op: 'update-execution-node', id: target.nodeId, bindings: { [target.portId]: { kind: 'field', nodeId: source, fieldId: sourceHandle.slice(6) } } })));
      }
      else throw new Error('组合只接受匹配的材料端口，不是普通关联线');
      setNotice('已更新组合的材料连接，没有运行；实际材料仍交给组合内对应步骤。');
      return;
    }
    if (targetHandle?.startsWith('in:') && sourceHandle?.startsWith('out:')) {
      checkMaterialConnection({ nodeId: source, portId: sourceHandle.slice(4) }, { nodeId: target, portId: targetHandle.slice(3) });
      patch([{ op: 'connect-ports', link: { source: { nodeId: source, portId: sourceHandle.slice(4) }, target: { nodeId: target, portId: targetHandle.slice(3) } } }]);
    } else if (targetHandle?.startsWith('in:') && sourceHandle?.startsWith('field:')) {
      checkMaterialConnection({ nodeId: source, fieldId: sourceHandle.slice(6) }, { nodeId: target, portId: targetHandle.slice(3) });
      checkFieldReplacement({ nodeId: target, portId: targetHandle.slice(3) });
      patch([{ op: 'update-execution-node', id: target, bindings: { [targetHandle.slice(3)]: { kind: 'field', nodeId: source, fieldId: sourceHandle.slice(6) } } }]);
    } else {
      if (!documentRef.current.nodes.some(node => node.id === source) || !documentRef.current.nodes.some(node => node.id === target) || sourceHandle?.startsWith('out:')) throw new Error('执行节点必须按输入/输出端口连接，不能当作语义关联');
      patch([{ op: 'add-edge', edge: { id: `edge-${crypto.randomUUID()}`, source, target, label: edgeLabel } }]);
    }
    setNotice('已更新连接，画布修改已生效。');
  }
  async function saveSceneSnapshot() {
    if (saving.current || active.current || !sceneRef.current) return;
    saving.current = true; const sequence = ++saveSequence.current; setBusy('正在保存场景…'); setError('');
    try {
      const current = sceneRef.current, definition = readS2Scene(current), snapshot = reusableS2Document(readS2Document(documentRef.current, definition));
      await loadManifest({ strict: true });
      if (sequence !== saveSequence.current) return;
      const saved = await saveScene({ ...current, sceneId: `scene-s2-${crypto.randomUUID()}`, canvasWorkspace: s2InteractionDocumentSnapshot(definition, snapshot),
        sourceSceneId: current.sceneId, origin: 'adapted', createdAt: new Date().toISOString() });
      if (sequence !== saveSequence.current) return;
      setNotice(`已保存场景「${saved.meta.name}」；可从“场景模拟 → 复用已有场景”打开。画布配置已保留，本局临时资料引用已清理；重新打开后请选择资料。未应用草稿、对话、本局授权和执行结果不随场景保存，原场景及当前资料选择保持不变。`);
    } catch (e) { if (sequence === saveSequence.current) setError((e as Error).message); }
    finally { saving.current = false; if (sequence === saveSequence.current) setBusy(''); }
  }
  const definition = scene ? readS2Scene(scene) : null;
  const selectedNode = document.nodes.find(node => node.id === selected);
  const selectedType = definition?.blockTypes.find(type => type.id === selectedNode?.type);
  const selectedWorkflow = document.execution?.nodes.find(node => node.id === selected);
  const selectedCapability = selectedWorkflow ? registry.capability(selectedWorkflow) : null;
  const allowedCapabilities = capabilityLibrary.filter(cap => definition?.plugins?.some(binding => s2CapabilityKey(binding) === s2CapabilityKey(cap)));
  const componentMenu = canvasPolicy?.addMenu;
  const groupedCapabilityKeys = new Set(componentMenu?.groups.flatMap(group => group.capabilities.map(s2CapabilityKey)) ?? []);
  const componentGroups = componentMenu ? [
    ...componentMenu.groups.map(group => ({ id: group.id, label: group.label,
      capabilities: group.capabilities.flatMap(ref => capabilityLibrary.filter(cap => s2CapabilityKey(cap) === s2CapabilityKey(ref))) })),
    ...(componentMenu.otherCapabilities !== 'hide' ? [{ id: 'other', label: '其他组件', capabilities: capabilityLibrary.filter(cap => !groupedCapabilityKeys.has(s2CapabilityKey(cap))) }] : []),
  ].filter(group => group.capabilities.length) : [];
  function addCapability(capability: typeof capabilityLibrary[number]) {
    if (selectedPack?.authoring) throw new Error('请通过公开组件目录添加组件');
    if (!scene || phaseRef.current === 'finished' || sceneRef.current !== scene || openCompositeRef.current !== openComposite
      || JSON.stringify(documentRef.current) !== JSON.stringify(document)) throw new Error('画布已变化，请重新选择要添加的组件。');
    const ref = { pluginId: capability.pluginId, pluginVersion: capability.pluginVersion, capabilityId: capability.capabilityId };
    if (!capabilityLibrary.some(cap => s2CapabilityKey(cap) === s2CapabilityKey(ref))) throw new Error('组件不在当前交互包范围内。');
    const current = readS2Scene(scene), approved = current.plugins?.some(cap => s2CapabilityKey(cap) === s2CapabilityKey(ref));
    if (!approved && phaseRef.current !== 'preview') throw new Error('本局未选择此组件，请重新进入场景后添加。');
    const nextDefinition = approved ? current : readS2Definition({ ...current, initial: documentRef.current, plugins: [...(current.plugins ?? []), ref] });
    const nodeId = `exec-${crypto.randomUUID()}`;
    const x = Math.max(420, ...s2AllNodes(documentRef.current).map(node => node.position.x + (measuredNodes.current.get(node.id)?.width ?? 330) + 60));
    const defaults = componentMenu?.groups.flatMap(group => group.capabilities).find(item => s2CapabilityKey(item) === s2CapabilityKey(ref))?.defaults;
    const bindings = Object.fromEntries(Object.entries(defaults ?? {}).map(([id, value]) => [id, { kind: 'literal', value: structuredClone(value) }]));
    const next = applyS2Commands(nextDefinition, documentRef.current, [{ op: 'add-execution-node', node: { ...ref, id: nodeId, position: { x, y: 100 }, bindings } }], readOnlyBaseline.current?.document, scene.interactionPack);
    const placed = openComposite ? placeS2NewStepsInComposite(documentRef.current, next, openComposite) : next;
    // Validate the complete result before extending preview composition. The running host's frozen grant never changes here.
    readS2Document(placed, nextDefinition); assertContentEdit(placed);
    if (!approved) putScene({ ...scene, canvasWorkspace: nextDefinition });
    commit(placed); setSelected(nodeId); selectNodes([nodeId], false);
    setWorkspacePanel(shouldOpenSettings(nodeId) ? 'node' : null);
  }
  function addPublicComponent(componentId: string) {
    guardConnectionAction();
    if (!selectedPack?.authoring || !scene || !definition) throw new Error('公开组件目录尚未就绪');
    const nodeId = `node-${crypto.randomUUID()}`;
    const position = { x: Math.max(100, ...s2AllNodes(documentRef.current).map(node => node.position.x + 330)), y: 120 };
    const next = appendS2PublicComponent(selectedPack, { definition, document: documentRef.current }, componentId, nodeId, position);
    if (JSON.stringify(definition.blockTypes) !== JSON.stringify(next.definition.blockTypes) || JSON.stringify(definition.plugins) !== JSON.stringify(next.definition.plugins))
      putScene({ ...scene, canvasWorkspace: { ...next.definition, initial: documentRef.current } });
    commit(next.document); focusNode(nodeId);
    setWorkspacePanel(null);
  }
  function contentNodeField(node: S2Document['nodes'][number], field: S2Field): S2ContentNodeField {
    const publicComponent = selectedPack?.authoring ? findS2PublicComponent(selectedPack, node, document) : undefined;
    const common = { id: field.id, label: field.label, value: node.values[field.id], definition: field,
      ...(selectedPack?.authoring ? { connectable: publicComponent?.outputs.includes(field.id) === true } : {}) };
    if (selectedPack?.authoring && !publicComponent?.parameters.includes(field.id)) return common;
    const mode = canvasPolicy?.contentEditing;
    if (mode === 'double-click' || mode === 'inline') {
      const editing = mode === 'inline' || inlineField?.sceneId === scene?.sceneId && inlineField?.nodeId === node.id && inlineField.fieldId === field.id;
      return { ...common, startEdit: () => startContentEdit(node.id, field),
        panelRef: element => registerViewPanel({ kind: 'content', nodeId: node.id, fieldId: field.id }, element),
        ...(editing && !node.readOnly ? { editor: <S2FieldEditor key={`${scene!.sceneId}-${node.id}-${field.id}`} variant="inline"
          nodeId={node.id} field={field} value={node.values[field.id]} drafts={controlDrafts.current} disabled={phase === 'finished'} autoFocus={mode === 'double-click'}
          onDone={() => setInlineField(current => current?.nodeId === node.id && current.fieldId === field.id ? null : current)}
          onSubmit={event => submitField(event, scene!, JSON.stringify(field))}
          onStateChange={(state, base) => {
            if (phaseRef.current === 'running' && sceneRef.current === scene) pluginHost.current?.recordFieldControl(node.id, field.id, base, state);
          }} /> } : {}) };
    }
    return { ...common, ...(mode !== 'panel' && ['text', 'multiline'].includes(field.kind) && field.required === undefined && field.maxLength === undefined && field.defaultValue === undefined
      ? { edit: (value: string) => act(() => editPlainField(node.id, field.id, value)) } : {}) };
  }
  const sourceWorkflow = document.execution?.nodes.find(node => node.id === wireSource);
  const sourcePublicComponent = selectedPack?.authoring && sourceWorkflow ? findS2PublicComponent(selectedPack, sourceWorkflow, document) : undefined;
  const sourcePorts = sourceWorkflow ? registry.capability(sourceWorkflow).outputs.filter(port => !selectedPack?.authoring || sourcePublicComponent?.outputs.includes(port.id)) : [];
  const addableCapabilities = phase === 'preview' ? capabilityLibrary : allowedCapabilities;
  const categories = [...new Set(addableCapabilities.map(cap => s2PluginHelp(cap, []).category))];
  const activeCategory = categories.includes(libraryCategory) ? libraryCategory : '';
  const filteredLibrary = addableCapabilities.filter(cap => (!activeCategory || s2PluginHelp(cap, []).category === activeCategory) && s2PluginHelpMatches(cap, libraryQuery));
  const chosenLibrary = filteredLibrary.find(cap => s2CapabilityKey(cap) === libraryKey) ?? filteredLibrary[0];
  const hasJsonCheck = definition?.plugins?.some(cap => s2CapabilityKey(cap) === s2CapabilityKey(S2_JSON_CHECK_BINDING));
  const visibleResults = pluginResults.filter(item => item.receipt.publication === 'current' && item.receipt.status === 'succeeded' && !document.execution?.nodes.some(node => node.id === item.request.nodeId)).slice(-6);
  const humanWaits = pluginHost.current?.waitingHumanInputs() ?? [];
  const displayedHost = pluginHost.current;
  function resultArtifacts(runId: string, nodeId: string, host = displayedHost): S2Artifact[] {
    if (!host || host !== pluginHost.current || phaseRef.current !== 'running' || sceneRef.current !== scene) return [];
    const run = host.workflowHistory().find(item => item.id === runId && item.publication === 'current');
    const progress = run?.nodes.find(item => item.nodeId === nodeId && ['succeeded', 'cached', 'displayed'].includes(item.status));
    if (!progress?.artifactIds.length) return [];
    try { return progress.artifactIds.map(id => host.currentArtifact(id)); } catch { return []; }
  }
  function openResult(runId: string, nodeId: string, opener: HTMLElement) {
    if (!resultArtifacts(runId, nodeId).length || !scene || !displayedHost) throw new Error('结果已过期或本局已结束，请核对当前运行；没有重新执行。');
    resultOpener.current = opener;
    setReading({ host: displayedHost, scene, workflowId: runId, nodeId });
  }
  const readingArtifacts = reading?.scene === scene ? resultArtifacts(reading.workflowId, reading.nodeId, reading.host) : [];
  const selectedResultRun = [...workflowRuns].reverse().find(run => run.nodes.some(item => item.nodeId === selectedWorkflow?.id));
  const runLabel = (id: string) => { const index = workflowRuns.findIndex(run => run.id === id); return index < 0 ? '本次运行' : `第 ${index + 1} 次运行`; };
  const humanWaitLabel = (wait: { workflowId: string; nodeId: string }) => `${s2ConnectionNodeLabel(definition!, document, wait.nodeId)} · ${runLabel(wait.workflowId)}`;
  const executionTitle = (id: string) => {
    const node = document.execution?.nodes.find(item => item.id === id);
    if (!node) return '处理步骤';
    const label = s2NodeTitle(node), same = document.execution!.nodes.filter(item => s2NodeTitle(item) === label);
    return same.length > 1 ? `${label}（第 ${same.findIndex(item => item.id === id) + 1} 个）` : label;
  };
  const modelWaits = pluginHost.current?.waitingModelTests() ?? [];
  const modelSummary = pluginHost.current?.modelTestSummary();
  const modelBudgetExhausted = !!modelSummary?.active && (modelSummary.usedRequests >= modelSummary.limits.maxRequests
    || modelSummary.reservedOutputTokens + modelSummary.limits.maxOutputTokens > modelSummary.limits.maxReservedOutputTokens);
  const hasModelAccess = definition?.plugins?.some(cap => registry.capability(cap).permissions.includes('model-call'));
  const projectNotes = displayedHost?.projectNoteSummary() ?? [];
  const textResources = displayedHost?.textResourceSummary() ?? [];
  const imageResources = displayedHost?.imageResourceSummary() ?? [];
  const collapsed = new Map((document.groups ?? []).filter(group => group.collapsed).flatMap(group => group.nodeIds.map(id => [id, group.id] as const)));
  const currentComposite = document.composites?.find(composite => composite.id === openComposite);
  const renderedRuntimeEpoch = runtimeProblemEpoch.current;
  const compositePath = currentComposite ? s2CompositePath(document, currentComposite.id) : [];
  const visibleComposites = (document.composites ?? []).filter(composite => composite.parentId === (currentComposite?.id ?? undefined));
  const compositeOwners = new Map(visibleComposites.flatMap(composite => composite.nodeIds.map(id => [id, composite.id] as const)));
  const directSteps = (document.execution?.nodes ?? []).filter(node => (!currentComposite || currentComposite.nodeIds.includes(node.id)) && !compositeOwners.has(node.id));
  const compositeBlueprints = new Map((document.composites ?? []).map(composite => [composite.id, s2CanvasCompositeBlueprint(document, composite, definition?.plugins)]));
  const blueprintEntries = document.blueprints ?? [];
  const publicationSource = document.composites?.find(item => item.id === publishSource) ?? currentComposite ?? visibleComposites[0];
  const entryKey = (entry: S2CompositeDesign) => JSON.stringify([entry.blueprint.id, entry.blueprint.version]);
  const chosenBlueprint = blueprintEntries.find(entry => entryKey(entry) === blueprintKey) ?? blueprintEntries[0];
  const compareVersions = blueprintEntries.filter(entry => entry.blueprint.id === chosenBlueprint?.blueprint.id && entryKey(entry) !== entryKey(chosenBlueprint!));
  const comparisonCurrent = comparison && comparison.scene === scene && comparison.view === openComposite && comparison.base === JSON.stringify(document)
    && comparison.source === (chosenBlueprint ? entryKey(chosenBlueprint) : '') && comparison.target === compareVersion;
  function guardBlueprintAction() {
    if (phaseRef.current === 'finished' || sceneRef.current !== scene || openCompositeRef.current !== openComposite || JSON.stringify(documentRef.current) !== JSON.stringify(document)) throw new Error('蓝图或当前画布已变化，请在当前页面重新操作。');
  }
  function outputPreviewCurrent(value: OutputPreview) {
    return outputPreviewRef.current === value && copyCandidateRef.current === value.copy && migrationPreviewRef.current === value.copy.preview
      && phaseRef.current !== 'finished' && phaseRef.current === value.phase && sceneRef.current === value.scene
      && openCompositeRef.current === value.view && historyVersion.current === value.version && JSON.stringify(selectionRef.current) === value.selection;
  }
  function guardOutputPreview(value: OutputPreview) {
    guardBlueprintAction();
    if (!outputPreviewCurrent(value) || !isS2CompositeOutputPreviewCurrent(value.report, documentRef.current, definition!)) throw new Error('下游影响预览已过期，请重新查看；没有改变任何连线。');
  }
  function renderOutputPreview(copy: NonNullable<typeof copyCandidate>) {
    const renderedPhase = phaseRef.current, renderedVersion = historyVersion.current, renderedSelection = JSON.stringify(selectionRef.current), renderedEpoch = outputPreviewEpoch.current;
    const shown = outputPreview?.copy === copy && outputPreviewCurrent(outputPreview) ? outputPreview : null;
    return <section aria-label="下游输出影响">
      <button disabled={finished || !!busy} onClick={() => act(() => {
        guardBlueprintAction();
        if (phaseRef.current !== renderedPhase || historyVersion.current !== renderedVersion || JSON.stringify(selectionRef.current) !== renderedSelection || outputPreviewEpoch.current !== renderedEpoch) throw new Error('当前操作位置已变化，请在当前页面重新查看下游影响。');
        if (copyCandidateRef.current !== copy || migrationPreviewRef.current !== copy.preview || copy.choicesKey !== JSON.stringify(copyChoicesRef.current)) throw new Error('新版副本已变化，请重新预览后查看下游影响。');
        const report = previewS2CompositeOutputs(copy.report, documentRef.current, definition!);
        setOutputPreview({ report, copy, scene: scene!, phase: phaseRef.current, view: openCompositeRef.current, version: historyVersion.current, selection: JSON.stringify(selectionRef.current) });
      })}>查看下游输出影响（不改线）</button>
      {shown && <section aria-label="下游输出重接预览" aria-live="polite">
        <h4>哪些地方仍在使用原组合的结果</h4>
        <p>原组合：{shown.report.source.label} · {shown.report.source.version}；待添加新版：{shown.report.target.label} · {shown.report.target.version}。</p>
        <p>逐项选择保留原连接，或由新版结果接替。这里只检查方案，不改线、不运行；格式兼容不代表内容适合。</p>
        {!shown.report.items.length && <p>当前没有使用原组合输出的外部数据线或运行条件，无需选择重接方案。</p>}
        {shown.report.items.map((item, index) => <fieldset key={item.key}><legend>{index + 1}. {item.kind === 'data' ? '材料传递' : '运行条件'}</legend>
          <p>现在从：{item.sourceLabel}</p><p>交给：{item.targetLabel}</p><p>{item.description}</p>
          <label>{`为「${item.targetLabel}」选择${item.kind === 'data' ? '材料' : '条件'}方案（第${index + 1}项）`}<select disabled={finished} value={outputChoices[item.key] ?? ''} onChange={event => act(() => {
            guardOutputPreview(shown);
            if (outputChoicesRef.current !== outputChoices) throw new Error('方案草稿已变化，请在当前预览中重新选择。');
            const choice = event.target.value;
            if (choice && !item.options.some(option => option.id === choice && option.eligible)) throw new Error('该输出不能作为当前项的重接候选，未改变设计。');
            const next = { ...outputChoicesRef.current }; if (choice) next[item.key] = choice; else delete next[item.key];
            outputChoicesRef.current = next; setOutputChoices(next); setOutputCheck(null);
          })}><option value="">请选择方案，不自动代选</option>{item.options.map(option => <option key={option.id} value={option.id} disabled={!option.eligible}>{option.label}{option.eligible ? '' : '（不可选）'}</option>)}</select></label>
          <details><summary>查看候选依据与限制</summary><ul>{item.options.map(option => <li key={option.id}>{option.label}：{option.reason}</li>)}</ul></details>
          <details><summary>这项引用的技术详情</summary><pre>{item.technical}</pre></details>
        </fieldset>)}
        <details><summary>检查范围与注意事项</summary>{shown.report.warnings.map((warning, index) => <p key={index}>{warning}</p>)}<p>{shown.report.note}</p></details>
        <button disabled={finished || !!busy || !shown.report.items.length || shown.report.items.some(item => !outputChoices[item.key])} onClick={() => act(() => {
          guardOutputPreview(shown);
          if (outputChoicesRef.current !== outputChoices) throw new Error('方案草稿已变化，请重新检查。');
          setOutputCheck(null);
          setOutputCheck(checkS2CompositeOutputPlan(shown.report, documentRef.current, definition!, shown.report.items.map(item => ({ key: item.key, choice: outputChoicesRef.current[item.key] }))));
        })}>检查所选重接方案（不应用）</button>
        {outputCheck && <section aria-label="重接方案检查结果" role="status"><h4>{outputCheck.compatible ? '所选方案通过结构检查，尚未应用' : '所选方案存在冲突，未应用'}</h4>
          <ul>{outputCheck.changes.map(item => <li key={item.key}>{item.targetLabel}：{item.kept ? '计划保留原连接' : `计划改用${item.choiceLabel}`}</li>)}</ul>
          {outputCheck.reasons.map((reason, index) => <p key={index}>{reason}</p>)}
          {outputCheck.canApply && <section aria-label="确认重接的影响">
            <p>确认后新增 {copy.report.nodeCount} 个处理步骤，并改接 {outputCheck.changes.filter(item => !item.kept).length} 项下游引用；原组合和选择保留的连接不变。只应用设计，不运行，可撤销。</p>
            <p>当前尚未完成的运行和人工等待会取消，旧结果不能作为新图的当前结果；历史记录和已用额度保留。撤销只恢复设计，不恢复等待或返还额度。</p>
            <button disabled={finished || !!busy || outputCheckRef.current !== outputCheck} onClick={() => act(() => {
              guardOutputPreview(shown);
              if (active.current || saving.current || dragStart.current) throw new Error('当前还有请求、保存或移动未完成，请结束后再确认；没有改线。');
              if (outputCheckRef.current !== outputCheck || outputChoicesRef.current !== outputChoices || !isS2CompositeOutputPlanCurrent(outputCheck, documentRef.current, definition!)) throw new Error('检查结果已过期，请重新检查当前方案；没有改线。');
              const changed = outputCheck.changes.filter(item => !item.kept).length;
              const accepted = acceptS2CompositeOutputPlan(outputCheck, documentRef.current, definition!);
              commit(accepted.document); setMigrationPreview(null);
              setNotice(`已添加独立新版并重接 ${changed} 项下游引用；原组合和保留项未变，没有运行。可撤销本次整批修改；旧等待不会恢复，运行仍需另行确认。`);
            })}>确认添加新版并应用所选重接（不运行）</button>
          </section>}
          {outputCheck.compatible && !outputCheck.canApply && <p>本方案没有需要重接的项目。如需添加新版，请使用下方的“确认添加独立新版副本”。</p>}
        </section>}
        <p>检查不会修改画布。下方“确认添加独立新版副本”仍仅添加副本，不应用重接方案；重接必须使用上方独立的确认按钮。</p>
        <button disabled={finished} onClick={() => act(() => { guardOutputPreview(shown); setOutputPreview(null); })}>收起并清除本次重接方案</button>
      </section>}
    </section>;
  }
  const inputSource = (node: NonNullable<S2Document['execution']>['nodes'][number], portId: string): string => {
    const links = document.execution?.links.filter(link => link.target.nodeId === node.id && link.target.portId === portId) ?? [];
    if (links.length) return links.map(link => `来自${s2ConnectionPortLabel(definition!, document, link.source, 'outputs')}`).join('、');
    if (['local-material', 'project-notes'].includes(node.pluginId) && portId === 'resource') {
      const binding = node.bindings.resource;
      if (binding?.kind === 'field') return `引用${s2ConnectionFieldLabel(definition!, document, binding.nodeId, binding.fieldId)}`;
      const isImage = node.pluginId === 'local-material' && node.capabilityId === 'read-image';
      const resources = node.pluginId === 'project-notes' ? projectNotes : isImage ? imageResources : textResources;
      if (binding?.kind !== 'literal') return isImage ? '请选择本局图片' : '请选择本局资料';
      const resource = resources.find(item => item.id === binding.value);
      return resource ? `${resource.label}${'available' in resource && !resource.available ? '（已失效，请撤回后重新选择）' : ''}` : isImage ? '请重新选择本局图片' : '请重新选择本局资料';
    }
    const binding = node.bindings[portId];
    if (binding?.kind === 'field') {
      return `引用${s2ConnectionFieldLabel(definition!, document, binding.nodeId, binding.fieldId)}`;
    }
    return binding ? '已填写' : registry.capability(node).inputs.find(port => port.id === portId)?.required ? '尚未连接或填写' : '可不提供';
  };
  function imageNodeControls(nodeId: string) {
    const base = s2ParameterSource(document, nodeId, 'resource').key, owner = scene;
    return <S2ImageMaterials key={nodeId} compact autoBind host={sceneResourceUi()?.image ?? null} active={phase !== 'finished' && !busy} document={s2ResourceUiDocument(document)} selectedNodeId={nodeId}
      isCurrent={() => sceneRef.current === owner && phaseRef.current !== 'finished'
        && !!documentRef.current.execution?.nodes.some(node => node.id === nodeId && node.pluginId === 'local-material' && node.capabilityId === 'read-image')}
      onError={message => setError(message)} onChange={() => { const host = pluginHost.current; if (host && sceneRef.current === owner) refreshWorkflow(host); }}
      onBind={resourceId => {
        const host = pluginHost.current;
        if (!host || sceneRef.current !== owner || phaseRef.current === 'finished'
          || resourceId && !host.imageResourceSummary().some(item => item.id === resourceId)) throw new Error('图片入口已变化，请在当前节点重新选择。');
        const source = s2ParameterSource(documentRef.current, nodeId, 'resource');
        if (source.connected || source.key !== base) throw new Error('图片入口来源已变化，未覆盖原材料；请在当前节点重新选择。');
        commitInputBinding(nodeId, 'resource', resourceId ? { kind: 'literal', value: resourceId } : null, base, owner!);
      }} />;
  }
  function textNodeControls(nodeId: string) {
    const base = s2ParameterSource(document, nodeId, 'resource').key, owner = scene;
    return <S2TextMaterialInput key={nodeId} host={sceneResourceUi()?.text ?? null} active={phase !== 'finished' && !busy} document={s2ResourceUiDocument(document)} selectedNodeId={nodeId}
      isCurrent={() => sceneRef.current === owner && phaseRef.current !== 'finished'
        && !!documentRef.current.execution?.nodes.some(node => node.id === nodeId && node.pluginId === 'local-material' && node.capabilityId === 'read-text')}
      onError={setError} onChange={() => { const host = pluginHost.current; if (host && sceneRef.current === owner) refreshWorkflow(host); }}
      onBind={resourceId => {
        const host = pluginHost.current;
        if (!host || sceneRef.current !== owner || phaseRef.current === 'finished'
          || resourceId && !host.textResourceSummary().some(item => item.id === resourceId)) throw new Error('资料入口已变化，请在当前节点重新选择。');
        const source = s2ParameterSource(documentRef.current, nodeId, 'resource');
        if (source.connected || source.key !== base) throw new Error('资料来源已变化，请在当前节点重新选择。');
        commitInputBinding(nodeId, 'resource', resourceId ? { kind: 'literal', value: resourceId } : null, base, owner!);
      }} />;
  }
  function nodeInteractionInput(node: S2WorkflowNode) {
    if (!humanWaits.some(wait => wait.nodeId === node.id) && !modelWaits.some(wait => wait.nodeId === node.id)) return undefined;
    return <div className="s2-node-interactions nodrag nopan nowheel" onClick={event => event.stopPropagation()}>
        {humanWaits.filter(wait => wait.nodeId === node.id).map(wait => <S2HumanInput key={wait.id} wait={wait} nodeLabel={humanWaitLabel(wait)} drafts={humanDrafts.current} disabled={phase !== 'running'}
          panelRef={element => { if (element) humanPanels.current.set(wait.id, element); else humanPanels.current.delete(wait.id); }}
          onStateChange={(state, via) => {
            if (phaseRef.current === 'running' && pluginHost.current === displayedHost) displayedHost?.recordHumanControl(wait.workflowId, wait.id, state, via);
          }} onSubmit={(value, via) => {
            const host = pluginHost.current; if (!host || host !== displayedHost || phaseRef.current !== 'running') throw new Error('本局已结束，等待输入无效');
            host.submitHumanInput(wait.workflowId, wait.id, value, via); refreshWorkflow(host);
            setNotice(`已接收${humanWaitLabel(wait)}的${wait.capabilityId === 'confirm' ? '确认选择' : '输入'}；所属运行会继续处理，已完成的前置步骤不重做。请查看后续状态，提交不代表全部步骤已成功。`);
          }} onCancel={() => {
            const host = pluginHost.current;
            const run = workflowRuns.find(run => run.id === wait.workflowId);
            if (!host || host !== displayedHost || phaseRef.current !== 'running' || !run || run.revision !== wait.revision
              || !host.workflowHistory().some(current => current.id === wait.workflowId && current.publication === 'current' && current.revision === wait.revision
                && current.waiting?.some(item => item.id === wait.id && item.nodeId === wait.nodeId))) throw new Error('人工等待已失效，未取消其他运行');
            cancelCurrentRun(run);
          }} />)}

          {modelWaits.filter(wait => wait.nodeId === node.id).map(wait => <fieldset key={wait.id} ref={element => { if (element) modelPanels.current.set(wait.id, element); else modelPanels.current.delete(wait.id); }} tabIndex={-1}
            aria-label={`确认模型请求 ${humanWaitLabel(wait)}`}><legend>准备测试 · {humanWaitLabel(wait)}</legend>
            <p>{wait.providerLabel} · {wait.model}；实际输出上限 {wait.parameters.maxOutputTokens} tokens，随机性 {wait.parameters.temperature ?? '沿用模型默认'}{wait.parameters.thinkingMode ? `，思考模式${wait.parameters.thinkingMode === 'enabled' ? '开启' : '关闭'}` : '，思考模式沿用模型默认'}。预算仍按本局上限预留 {wait.reservationOutputTokens} tokens。确认后才发送，可能产生费用。</p>
            <h4>完整待测提示词</h4><pre>{wait.prompt}</pre><h4>待处理文本／资料（原文）</h4><p>这是让模型处理的内容，不是另一份提示词；图片在下方单独核对。</p><pre>{wait.input || '（本次未提供文本资料）'}</pre>
            {!!wait.images?.length && <section aria-label="本次将发送的原始图片"><h4>待处理图片</h4><p>以下原图仅随你确认的本次请求发送，不自动加入其他请求。</p>
              {wait.images.map(image => <figure key={image.id}><img src={image.dataUrl} alt={`本次待发送原图：${image.label}`} style={{ maxWidth: '100%', maxHeight: 260, objectFit: 'contain' }} /><figcaption>{image.label} · {(image.bytes / 1024).toFixed(1)} KiB</figcaption></figure>)}
            </section>}
            {developerDiagnostics && <details><summary>请求技术详情</summary><p>步骤：{wait.nodeId}；运行：{wait.workflowId}。提示词发送为 system，待处理文本／资料发送为 user。</p></details>}
            {modelBudgetExhausted && <p>这项请求尚未发送，但本局预算已不足；现在不能确认发送。可拒绝这项请求或取消所属运行，不会自动重新排队。</p>}
            <button disabled={!!busy || phase !== 'running' || modelBudgetExhausted || !modelSummary?.active} onClick={() => act(() => chooseModelRequest(wait, true))}>确认发送本次模型请求</button>
            <button disabled={phase !== 'running'} onClick={() => act(() => chooseModelRequest(wait, false))}>拒绝本次模型请求</button>
          </fieldset>)}
    </div>;
  }
  function nodeResourceInput(node: S2WorkflowNode) {
    if (!s2SessionResourceKind(node)) return undefined;
    const base = s2ParameterSource(document, node.id, 'resource').key, owner = scene;
    const content = node.pluginId === 'local-material' ? node.capabilityId === 'read-image' ? imageNodeControls(node.id)
      : node.capabilityId === 'read-text' ? textNodeControls(node.id) : undefined
      : node.pluginId === 'project-notes' && node.capabilityId === 'read-text' ? <S2ProjectNoteInput host={sceneResourceUi()?.note ?? null}
        active={phase !== 'finished' && !busy} document={s2ResourceUiDocument(document)} selectedNodeId={node.id}
        isCurrent={() => sceneRef.current === owner && phaseRef.current !== 'finished' && documentRef.current === document}
        onError={setError} onChange={() => { const host = pluginHost.current; if (host && sceneRef.current === owner) refreshWorkflow(host); }}
        onBind={resourceId => {
          const host = pluginHost.current;
          if (!host || sceneRef.current !== owner || phaseRef.current === 'finished'
            || resourceId && !host.projectNoteSummary().some(item => item.id === resourceId && item.available)) throw new Error('笔记入口已变化，请在当前节点重新选择。');
          const source = s2ParameterSource(documentRef.current, node.id, 'resource');
          if (source.connected || source.key !== base) throw new Error('笔记来源已变化，未覆盖原输入。');
          commitInputBinding(node.id, 'resource', resourceId ? { kind: 'literal', value: resourceId } : null, base, owner!);
        }} /> : undefined;
    return content ? <div ref={element => { if (element) resourcePanels.current.set(node.id, element); else resourcePanels.current.delete(node.id); }} tabIndex={-1}>{content}</div> : undefined;
  }
  function packViewContext(node: S2WorkflowNode): import('../../types/sceneInteractionPack').ScenePackViewContext {
    const capturedScene = scene, capturedPhase = phase, version = historyVersion.current, base = JSON.stringify(document), view = openComposite;
    const selectedKey = JSON.stringify(selection), owner = viewPanelRenderOwner;
    const assertCurrent = () => {
      if (phaseRef.current === 'finished' || phaseRef.current !== capturedPhase || sceneRef.current !== capturedScene || historyVersion.current !== version || openCompositeRef.current !== view
        || JSON.stringify(selectionRef.current) !== selectedKey || JSON.stringify(documentRef.current) !== base)
        throw new Error('组件设置已过期，请在当前画布重新操作');
    };
    const scope = JSON.stringify([scene?.interactionPack, scene?.sceneId, node.id]);
    if (!packViewStates.current.has(scope)) {
      if (packViewStates.current.size >= 40) packViewStates.current.delete(packViewStates.current.keys().next().value!);
      packViewStates.current.set(scope, new Map());
    }
    const state = packViewStates.current.get(scope)!;
    const pending = () => userExecutions.current.get(node.id)?.preparing || pluginHost.current?.workflowHistory().some(run => run.publication === 'current'
      && ['queued', 'running', 'waiting'].includes(run.status) && run.nodes.some(item => item.nodeId === node.id));
    const stateCurrent = () => { if (sceneRef.current !== capturedScene || phaseRef.current === 'finished' || packViewStates.current.get(scope) !== state) throw new Error('组件草稿所属场景已变化'); };
    const editable = !selectedPack?.authoring || !!findS2PublicComponent(selectedPack, node, document);
    const resultRun = [...workflowRuns].reverse().find(run => run.nodes.some(item => item.nodeId === node.id));
    const resultProgress = resultRun?.nodes.find(item => item.nodeId === node.id);
    const resultArtifacts = resultRun?.publication === 'current' ? (resultProgress?.artifactIds ?? []).flatMap(id => {
      try { const artifact = pluginHost.current?.currentArtifact(id); return artifact ? [structuredClone(artifact)] : []; } catch { return []; }
    }) : [];
    return { definition: structuredClone(definition!), document: structuredClone(document), node: structuredClone(node), active: phase !== 'finished', editable,
      results: { status: resultRun?.publication === 'stale' ? 'stale' : resultProgress?.status ?? 'idle', stale: resultRun?.publication === 'stale', artifacts: resultArtifacts },
      resourceInput: nodeResourceInput(node), interactionInput: nodeInteractionInput(node),
      execution: { enabled: scenePackAllowsExecution(selectedPack) && phase !== 'finished' && !busy && !pending(), running: !!pending(),
        status: userExecutions.current.get(node.id)?.status, error: userExecutions.current.get(node.id)?.error,
        cancel: () => { assertCurrent(); stopUserWorkflow(node.id); }, run: targets => {
        assertCurrent();
        if (!scenePackAllowsExecution(selectedPack)) throw new Error('当前插件包仅编辑，修改后直接生效');
        if (phaseRef.current === 'finished') throw new Error('当前场景已结束。');
        if (pending()) throw new Error('这个步骤正在运行，请等待本次结束。');
        const selectedTargets = targets ?? [node.id];
        if (!selectedTargets.length || selectedTargets.length > 40 || new Set(selectedTargets).size !== selectedTargets.length
          || selectedTargets.some(id => !documentRef.current.execution?.nodes.some(item => item.id === id))) throw new Error('运行目标已变化。');
        void runUserWorkflow(node.id, selectedTargets);
      } },
      materialScopeKey: JSON.stringify([scene?.sceneId, phase === 'finished', node.id]),
      model: { supportsThinking: modelSummary?.supportsThinking, maxOutputTokens: modelSummary?.limits.maxOutputTokens },
      state: { get: key => state.get(key) as any, initialize: (key, create) => { if (!state.has(key)) { if (state.size >= 16) throw new Error('组件临时状态超过上限'); state.set(key, create()); } return state.get(key) as any; },
        set: (key, value) => { stateCurrent(); if (!state.has(key) && state.size >= 16) throw new Error('组件临时状态超过上限'); state.set(key, value); refreshPackViews(value => value + 1); },
        delete: key => { stateCurrent(); state.delete(key); refreshPackViews(value => value + 1); } },
      guard: assertCurrent,
      readCurrent: () => ({ definition: structuredClone(readS2Scene(sceneRef.current!)), document: structuredClone(documentRef.current) }),
      registerPanel: registerViewPanel,
      navigate: target => {
        assertCurrent(); if (viewPanelOwner.current !== owner) throw new Error('说明入口已过期，请在当前步骤重新查看');
        const current = documentRef.current, step = current.execution?.nodes.find(item => item.id === target.nodeId);
        if (target.kind === 'content' ? !Object.hasOwn(current.nodes.find(item => item.id === target.nodeId)?.values ?? {}, target.fieldId)
          : !step || target.kind === 'input' && !registry.capability(step).inputs.some(port => port.id === target.portId)) throw new Error('原设置已不存在');
        const composite = (current.composites ?? []).filter(item => item.nodeIds.includes(target.nodeId)).sort((a, b) => s2CompositePath(current, b.id).length - s2CompositePath(current, a.id).length)[0];
        const request = { target: { ...target }, scene: capturedScene!, phase: capturedPhase, version, document: JSON.stringify(current), view: composite?.id ?? null, selection: JSON.stringify([target.nodeId]) };
        showComposite(request.view); focusNode(target.nodeId);
        if (target.kind !== 'content' || canvasPolicy?.contentSettings !== 'hide') setWorkspacePanel('node');
        if (target.kind === 'content' && canvasPolicy?.contentSettings === 'hide' && canvasPolicy.contentEditing !== 'panel') {
          const content = current.nodes.find(item => item.id === target.nodeId);
          const field = definition!.blockTypes.find(type => type.id === content?.type)?.fields.find(item => item.id === target.fieldId);
          if (field && !content?.readOnly) startContentEdit(target.nodeId, field);
        }
        pendingViewFocus.current = request; setViewFocusRequest(request);
      },
      focusSettings: () => { assertCurrent(); focusNode(node.id); setWorkspacePanel('node'); },
      nodeLabel: id => s2ConnectionNodeLabel(definition!, document, id),
      inputLabel: (id, portId) => { const step = document.execution?.nodes.find(item => item.id === id); const port = step && registry.capability(step).inputs.find(item => item.id === portId); return step && port ? s2PortLabel(step, port, 'inputs') : portId; },
      onNotice: setNotice,
      onDocumentChange: next => { assertCurrent(); commit(readS2Document(next, definition!)); },
      onInputChange: (portId, binding, sourceKey) => { assertCurrent(); commitInputBinding(node.id, portId, binding, sourceKey, capturedScene!); },
      onError: message => setError(message) };
  }
  const selectedViewPolicy = selectedWorkflow && definition ? scenePackViewPolicy(scene?.interactionPack, packViewContext(selectedWorkflow)) : undefined;
  const customSettings = !!selectedWorkflow && !!(scenePackView(scene?.interactionPack, selectedWorkflow, 'node') || scenePackView(scene?.interactionPack, selectedWorkflow, 'settings'));
  const genericSettings = selectedViewPolicy?.genericSettings ?? !customSettings;
  const selectedPublicComponent = selectedPack?.authoring && selectedWorkflow ? findS2PublicComponent(selectedPack, selectedWorkflow, document) : undefined;
  const selectedPublicContent = selectedPack?.authoring && selectedNode ? findS2PublicComponent(selectedPack, selectedNode, document) : undefined;
  const ordinaryInputs = selectedCapability?.inputs.filter(port => genericSettings && !(selectedWorkflow && s2SessionResourceKind(selectedWorkflow) && port.id === 'resource') && (!selectedPack?.authoring || selectedPublicComponent?.parameters.includes(port.id)) && !(selectedWorkflow?.pluginId === 'structured-data' && selectedWorkflow.pluginVersion === '1.0.0'
      && selectedWorkflow.capabilityId === 'select' && port.id === 'pointer'
      && (!selectedWorkflow.bindings.pointer || selectedWorkflow.bindings.pointer.kind === 'literal')
      && !document.execution?.links.some(link => link.target.nodeId === selectedWorkflow.id && link.target.portId === 'pointer'))
    && !selectedViewPolicy?.hiddenSettingsInputs?.includes(port.id)) ?? [];
  const finished = phase === 'finished';
  const flowNodes: Node[] = definition ? [
    ...visibleComposites.map(composite => ({ id: composite.id, type: 'composite', position: s2CompositePosition(document, composite), zIndex: 2,
      selected: composite.nodeIds.every(id => selection.includes(id)), data: { label: composite.label, referenceLabel: `组合 ${document.composites!.findIndex(item => item.id === composite.id) + 1}${composite.blueprint ? ` · 来源 ${composite.blueprint.version}` : ''}`, count: composite.nodeIds.length, blueprint: compositeBlueprints.get(composite.id)!, disabled: phase === 'finished',
        enter: () => compositeOperation(composite.id, 'enter', scene!, JSON.stringify(document)) } })),
    ...(document.groups ?? []).map(group => {
      const bounds = s2GroupBounds(group, document);
      return { id: group.id, type: 'group', position: { x: bounds.x, y: bounds.y }, style: { width: bounds.width, height: bounds.height }, draggable: false, selectable: false, connectable: false, zIndex: 0,
        hidden: !!currentComposite, data: { label: group.label, count: group.nodeIds.length, collapsed: group.collapsed, toggle: () => groupOperation(group, 'toggle', scene!) } };
    }),
    ...document.nodes.map((node, index) => {
      const type = definition.blockTypes.find(type => type.id === node.type)!;
      const editable = !selectedPack?.authoring || !!findS2PublicComponent(selectedPack, node, document);
      return { id: node.id, type: 'block', position: node.position, selected: selection.includes(node.id), hidden: !currentComposite && collapsed.has(node.id), zIndex: 1,
        draggable: editable && !finished, connectable: editable && !finished,
        data: { title: node.label?.trim() || type.label, semanticIn: developerDiagnostics || document.edges.some(edge => edge.target === node.id),
          semanticOut: developerDiagnostics || document.edges.some(edge => edge.source === node.id), advanced: type.advanced, readOnly: node.readOnly === true || !editable, disabled: phase === 'finished', fields: type.fields.map(field => contentNodeField(node, field)) } };
    }),
    ...(document.execution?.nodes ?? []).map((node, index) => {
      const run = [...workflowRuns].reverse().find(run => run.nodes.some(item => item.nodeId === node.id));
      const progress = run?.nodes.find(item => item.nodeId === node.id);
      const artifacts = run?.publication === 'current' ? (progress?.artifactIds ?? []).flatMap(id => { try { return [pluginHost.current!.currentArtifact(id)]; } catch { return []; } }) : [];
      const capability = registry.capability(node);
      const diagnostic = run && displayedHost?.readWorkflowDiagnostic(run.id, node.id);
      const runtimeIssue = diagnostic ? s2RuntimeIssue(definition!, document, node.id, diagnostic) : null;
      const hidden = compositeOwners.has(node.id) || (currentComposite ? !currentComposite.nodeIds.includes(node.id) : collapsed.has(node.id));
      const viewContext = packViewContext(node), packagePolicy = scenePackViewPolicy(scene?.interactionPack, viewContext);
      const hasNodeView = !!scenePackView(scene?.interactionPack, node, 'node');
      const component = selectedPack?.authoring ? findS2PublicComponent(selectedPack, node, document) : undefined;
      const editable = !selectedPack?.authoring || !!component;
      const viewPolicy = selectedPack?.authoring ? { ...packagePolicy,
        visibleNodeInputs: (packagePolicy?.visibleNodeInputs ?? capability.inputs.map(port => port.id)).filter(port => component?.inputs.includes(port)),
        hiddenSettingsInputs: [...new Set([...(packagePolicy?.hiddenSettingsInputs ?? []), ...capability.inputs.filter(port => !component?.parameters.includes(port.id) && !component?.inputs.includes(port.id)).map(port => port.id)])] } : packagePolicy;
      return { id: node.id, type: 'execution', position: node.position, selected: !hidden && selection.includes(node.id), hidden, zIndex: 1,
        draggable: editable && !finished, connectable: editable && !finished,
        data: { title: s2NodeTitle(node), referenceLabel: developerDiagnostics ? `步骤 ${index + 1}` : undefined, description: s2NodeDescription(node), node, inputSources: Object.fromEntries(capability.inputs.map(port => [port.id, inputSource(node, port.id)])), capability, developerDiagnostics, viewPolicy,
          ...(selectedPack?.authoring ? { publicInputs: component?.inputs ?? [], publicOutputs: component?.outputs ?? [] } : {}),
          ...(hasNodeView ? { nodeView: <ScenePackView reference={scene?.interactionPack} slot="node" context={viewContext} />,
            viewIdentity: JSON.stringify([scene?.interactionPack, scene?.sceneId, node.id]) } : {}),
          onNodeDoubleClick: scenePackNodeDoubleClick(scene?.interactionPack, viewContext), onViewError: setError,
          nodeResourceInput: !(viewPolicy?.resourceInputInView === true) ? viewContext.resourceInput as React.ReactNode : undefined,
          resourceInputFallback: viewContext.resourceInput as React.ReactNode,
          nodeInteractionInput: viewContext.interactionInput as React.ReactNode,
          interactionInputInView: viewPolicy?.interactionInputInView === true && !!(scenePackView(scene?.interactionPack, node, 'node') || scenePackView(scene?.interactionPack, node, 'inline')),
          nodeControls: <><ScenePackView reference={scene?.interactionPack} slot="inline" context={viewContext} />{!(viewPolicy?.resourceInputInView === true && scenePackView(scene?.interactionPack, node, 'inline')) && viewContext.resourceInput as React.ReactNode}</>,
          status: run?.publication === 'stale' ? 'stale' : progress?.status ?? 'idle', artifacts, when: node.when, reason: runtimeIssue?.summary ?? progress?.error,
          ...(run && resultArtifacts(run.id, node.id).length ? { onReadResult: (opener: HTMLElement) => act(() => openResult(run.id, node.id, opener)) } : {}),
          ...(runtimeIssue ? { onInspectIssue: () => act(() => viewRuntimeProblem(run!, node.id)) } : {}),
          mergeEvidence: progress?.mergeEvidence, humanEvidence: progress?.humanEvidence, onViewChange: recordView, onTreeToggle: recordTreeView } };
    }),
    ...visibleResults.map((item, index) => {
      const source = document.nodes.find(node => node.id === item.request.nodeId);
      return { id: item.receipt.id, type: 'block', position: { x: (source?.position.x ?? 0) + 370, y: (source?.position.y ?? 0) + index * 230 }, selected: false, draggable: false, connectable: false, selectable: false, hidden: !!currentComposite,
        data: { title: `${registry.plugin(item.request.pluginId, item.request.pluginVersion).label} · 只读结果`, fields: [], artifacts: item.artifacts } };
    }),
  ] : [];
  const flowNodeIds = new Set(flowNodes.map(node => node.id));
  for (const id of measuredNodes.current.keys()) if (!flowNodeIds.has(id)) measuredNodes.current.delete(id);
  for (const node of flowNodes) {
    const measured = measuredNodes.current.get(node.id);
    if (measured) node.measured = measured;
  }
  const connectionDescriptions = definition ? s2ConnectionDescriptions(definition, document) : [];
  const connectionById = new Map(connectionDescriptions.map(item => [item.id, item]));
  const flowEdges: Edge[] = [
    ...document.edges,
    ...(document.execution?.links ?? []).map(link => ({ id: s2ExecutionLinkKey(link), source: link.source.nodeId, target: link.target.nodeId, sourceHandle: `out:${link.source.portId}`, targetHandle: `in:${link.target.portId}`, animated: false, className: 's2-data-edge' })),
    ...(document.execution?.nodes ?? []).flatMap(node => node.when ? [{ id: JSON.stringify(['condition', node.id]), source: node.when.nodeId, target: node.id, sourceHandle: `out:${node.when.portId}`, targetHandle: 'condition',
      className: 's2-condition-edge' }] : []),
    ...(document.execution?.nodes ?? []).flatMap(node => Object.entries(node.bindings).flatMap(([portId, binding]) => binding.kind === 'field' ? [{ id: JSON.stringify([node.id, portId, binding]), source: binding.nodeId, sourceHandle: `field:${binding.fieldId}`, target: node.id, targetHandle: `in:${portId}`, label: `使用${s2PortLabel(node, registry.capability(node).inputs.find(port => port.id === portId)!, 'inputs')}`, className: 's2-field-edge' }] : [])),
    ...visibleResults.map(item => ({ id: `result-edge-${item.receipt.id}`, source: item.request.nodeId, target: item.receipt.id, label: '本局结果（非执行连线）' })),
  ].flatMap((edge: Edge) => {
    const explanation = connectionById.get(edge.id);
    if (explanation) edge = { ...edge, label: developerDiagnostics ? explanation.shortLabel : undefined, ariaLabel: explanation.summary, selectable: !finished,
      selected: edgeSelection.includes(edge.id) };
    if (currentComposite && [edge.source, edge.target].some(id => !currentComposite.nodeIds.includes(id) && !document.nodes.some(node => node.id === id))) return [];
    const sourceComposite = compositeOwners.get(edge.source), targetComposite = compositeOwners.get(edge.target);
    if (sourceComposite && sourceComposite === targetComposite) return [];
    if (sourceComposite || targetComposite) {
      const output = sourceComposite ? compositeBlueprints.get(sourceComposite)!.outputs.find(output => output.source.nodeId === edge.source && `out:${output.source.portId}` === edge.sourceHandle) : undefined;
      const input = targetComposite ? compositeBlueprints.get(targetComposite)!.inputs.find(input => input.targets.some(target => target.nodeId === edge.target && `in:${target.portId}` === edge.targetHandle)) : undefined;
      if (sourceComposite && !output || targetComposite && !input) return [];
      edge = { ...edge, source: sourceComposite ?? edge.source, target: targetComposite ?? edge.target,
        ...(output ? { sourceHandle: `out:${output.id}` } : {}), ...(input ? { targetHandle: `in:${input.id}` } : {}) };
    }
    const sourceGroup = collapsed.get(edge.source), targetGroup = collapsed.get(edge.target);
    if (sourceGroup && sourceGroup === targetGroup) return [];
    return [{ ...edge, source: sourceGroup ?? edge.source, target: targetGroup ?? edge.target, ...(sourceGroup ? { sourceHandle: undefined } : {}), ...(targetGroup ? { targetHandle: undefined } : {}) }];
  });
  const renderedHistoryVersion = historyVersion.current;
  const visibleConnectionIds = new Set(flowEdges.map(edge => edge.id));
  function handleCanvasShortcut(event: React.KeyboardEvent<HTMLElement>) {
    if (finished || phaseRef.current !== phase || sceneRef.current !== scene || !scene || historyVersion.current !== renderedHistoryVersion) return;
    const scope = { contains: (target: unknown) => {
      try { return !!target && (canvasKeyboardScope.current?.contains(target as globalThis.Node) === true || canvasToolbar.current?.contains(target as globalThis.Node) === true); }
      catch { return false; }
    } };
    const action = resolveS2CanvasShortcut(event, { scope, activeElement: event.currentTarget.ownerDocument?.activeElement,
      canDelete: !!(selectionRef.current.length || edgeSelectionRef.current.some(id => visibleConnectionIds.has(id))), canUndo: !!past.length, canRedo: !!future.length });
    if (!action) return;
    if (action !== 'delete') {
      if (changeHistory(action, renderedHistoryVersion, scene)) { event.preventDefault(); event.stopPropagation(); }
      return;
    }
    act(() => {
      guardConnectionAction();
      const next = deleteS2CanvasSelection(documentRef.current, { nodeIds: selectionRef.current,
        edgeIds: edgeSelectionRef.current.filter(id => visibleConnectionIds.has(id)) });
      if (next === documentRef.current) return;
      commit(next); focusNode(null); selectEdges([]); setConnectionSelection(null);
      event.preventDefault(); event.stopPropagation();
    });
  }
  function currentConnectionProblem(problem: ConnectionProblem) {
    return connectionProblemRef.current === problem && phaseRef.current !== 'finished' && phaseRef.current === problem.phase
      && sceneRef.current === problem.scene && openCompositeRef.current === problem.view && historyVersion.current === problem.version
      && JSON.stringify(documentRef.current) === problem.document && JSON.stringify(selectionRef.current) === problem.selection;
  }
  const visibleProblem = connectionProblem && currentConnectionProblem(connectionProblem) ? connectionProblem : null;
  function currentRuntimeProblem(problem: RuntimeProblem) {
    if (runtimeProblemRef.current !== problem || runtimeProblemEpoch.current !== problem.epoch || phaseRef.current !== 'running'
      || phaseRef.current !== problem.phase || pluginHost.current !== problem.host || sceneRef.current !== problem.scene
      || openCompositeRef.current !== problem.view || historyVersion.current !== problem.version
      || JSON.stringify(documentRef.current) !== problem.document || JSON.stringify(selectionRef.current) !== problem.selection) return false;
    if (problem.issue.resourceSource && problem.host.resourceSelectionVersion !== problem.resourceVersion) return false;
    if (problem.evidence.kind === 'file-selection') return JSON.stringify(problem.host.readTextFileSelectionDiagnostic(problem.evidence.error)) === problem.evidence.diagnostic;
    return problem.evidence.kind === 'preflight' || (problem.evidence.kind === 'model-preflight'
      ? JSON.stringify(problem.host.readWorkflowPreflightDiagnostic(problem.evidence.error)) === problem.evidence.diagnostic
      : JSON.stringify(problem.host.readWorkflowDiagnostic(problem.evidence.workflowId, problem.evidence.nodeId)) === problem.evidence.diagnostic);
  }
  const visibleRuntimeProblem = runtimeProblem && currentRuntimeProblem(runtimeProblem) ? runtimeProblem : null;
  function viewRuntimeProblem(run: S2WorkflowRun, nodeId: string) {
    if (!displayedHost || pluginHost.current !== displayedHost || phaseRef.current !== 'running' || sceneRef.current !== scene
      || active.current || saving.current || dragStart.current || runtimeProblemEpoch.current !== renderedRuntimeEpoch
      || historyVersion.current !== renderedHistoryVersion || openCompositeRef.current !== openComposite
      || JSON.stringify(selectionRef.current) !== JSON.stringify(selection) || JSON.stringify(documentRef.current) !== JSON.stringify(document)) throw new Error('运行问题入口已过期，请在当前画布重新查看；没有修改或执行。');
    const diagnostic = displayedHost.readWorkflowDiagnostic(run.id, nodeId);
    if (!diagnostic || JSON.stringify(diagnostic) !== JSON.stringify(run.nodes.find(item => item.nodeId === nodeId)?.diagnostic)) throw new Error('这项运行问题已过期或已有新的尝试；请查看最新运行记录。');
    const issue = s2RuntimeIssue(definition!, documentRef.current, nodeId, diagnostic);
    if (!issue) throw new Error('暂无可靠的定位说明，请查看原始运行记录；没有自动修改或重试。');
    offerRuntimeProblem(issue, displayedHost, { kind: 'runtime', workflowId: run.id, nodeId, diagnostic: JSON.stringify(diagnostic) });
  }
  function locateRuntimeProblem(problem: RuntimeProblem, target: string, focus: 'settings' | 'condition' | 'extraction' = 'settings') {
    if (!currentRuntimeProblem(problem) || active.current || saving.current || dragStart.current) throw new Error('运行问题定位已过期或当前操作尚未完成；请重新查看，没有修改或运行。');
    if (!problem.issue.nodeIds.includes(target) || !s2AllNodes(documentRef.current).some(node => node.id === target)) throw new Error('该步骤不属于当前问题或已移除。');
    if (focus === 'condition' && (problem.issue.kind !== 'condition-unavailable' || problem.evidence.kind !== 'runtime'
      || problem.evidence.nodeId !== target || !documentRef.current.execution?.nodes.find(node => node.id === target)?.when)) throw new Error('该运行问题没有可定位的当前条件。');
    if (focus === 'extraction') {
      const step = documentRef.current.execution?.nodes.find(node => node.id === target);
      if (problem.issue.kind !== 'structured-transform' || problem.evidence.kind !== 'runtime' || problem.evidence.nodeId !== target
        || step?.pluginId !== 'structured-data' || step.pluginVersion !== '1.0.0' || step.capabilityId !== 'select') throw new Error('该运行问题没有可定位的提取设置。');
    }
    const owner = (documentRef.current.composites ?? []).filter(item => item.nodeIds.includes(target))
      .sort((a, b) => s2CompositePath(documentRef.current, b.id).length - s2CompositePath(documentRef.current, a.id).length)[0];
    clearRuntimeProblem(); setConnectionProblem(null); setConnectionSelection(null); setError('');
    showComposite(owner?.id ?? null); focusNode(target); recoveryFocus.current = true;
    recoveryConditionTarget.current = focus === 'condition' ? target : null;
    recoveryFieldTarget.current = focus === 'extraction' ? target : null;
    setNotice(`已定位${s2ConnectionNodeLabel(definition!, documentRef.current, target)}${focus === 'condition' ? '的运行条件' : focus === 'extraction' ? '的提取设置' : ''}。请自行调整材料或设置；原图、记录和已用额度保留，修改后需单独确认运行。`);
  }
  /** Bind navigation/cancellation to this exact live run, not a reused node name or a different host after re-entry. */
  function currentRunAction(run: S2WorkflowRun) {
    if (!displayedHost || pluginHost.current !== displayedHost || phaseRef.current !== 'running' || sceneRef.current !== scene
      || dragStart.current || runtimeProblemEpoch.current !== renderedRuntimeEpoch || historyVersion.current !== renderedHistoryVersion
      || openCompositeRef.current !== openComposite || JSON.stringify(selectionRef.current) !== JSON.stringify(selection)
      || JSON.stringify(documentRef.current) !== JSON.stringify(document)) throw new Error('运行操作入口已过期，请在当前页面重新操作；未提交或取消其他运行。');
    const current = displayedHost.workflowHistory().find(item => item.id === run.id);
    if (!current || current.publication !== 'current' || !['queued', 'running', 'waiting'].includes(current.status)
      || JSON.stringify(current) !== JSON.stringify(run)) throw new Error('这次运行的状态已变化，请查看最新记录；未提交或取消其他运行。');
    return displayedHost;
  }
  function locateHumanInput(run: S2WorkflowRun, waitId: string) {
    const host = currentRunAction(run), wait = run.waiting?.find(item => item.id === waitId);
    if (!wait || run.nodes.find(node => node.nodeId === wait.nodeId)?.status !== 'waiting') throw new Error('这项填写或确认等待已失效；没有重新排队或提交。');
    const owner = (documentRef.current.composites ?? []).filter(item => item.nodeIds.includes(wait.nodeId))
      .sort((a, b) => s2CompositePath(documentRef.current, b.id).length - s2CompositePath(documentRef.current, a.id).length)[0];
    clearRuntimeProblem(); setConnectionProblem(null); setConnectionSelection(null); setError('');
    showComposite(owner?.id ?? null); focusNode(wait.nodeId);
    setWorkspacePanel(null);
    setHumanFocusRequest({ waitId, host, scene: scene! });
    setNotice(`已定位${humanWaitLabel({ workflowId: run.id, nodeId: wait.nodeId })}的${wait.capabilityId === 'confirm' ? '确认区' : '填写区'}；草稿、等待、运行记录与次数未变，没有提交或运行。`);
  }
  function cancelCurrentRun(run: S2WorkflowRun) {
    const host = currentRunAction(run);
    clearRuntimeProblem(); host.cancelWorkflow(run.id); refreshWorkflow(host);
    setNotice(`已请求取消${runLabel(run.id)}，停止这次运行中所有尚未完成的步骤和等待；已完成的记录与已用次数保留，正在执行的调用以实际记录为准，其他运行不受影响。不会自动重新开始。`);
  }
  function locateModelAuthorization(problem: RuntimeProblem) {
    if (!currentRuntimeProblem(problem) || problem.issue.kind !== 'model-request' || saving.current || dragStart.current) throw new Error('模型说明入口已过期；没有读取配置、批准预算或发送请求。');
    clearRuntimeProblem(); setError(''); setDeveloperDiagnostics(true); setWorkspacePanel('diagnostics'); setModelFocusRequest({ host: problem.host, scene: problem.scene });
    setNotice('已定位模型授权与用量区；只查看本局状态，没有读取模型配置、批准预算、重置用量或发送请求。');
  }
  function locateResourceSettings(problem: RuntimeProblem) {
    if (!currentRuntimeProblem(problem) || !problem.issue.resourceSource || active.current || saving.current || dragStart.current) throw new Error('资料说明入口已过期；没有读取、重新允许或运行。');
    const nodeId = problem.issue.nodeIds.find(id => document.execution?.nodes.some(node => node.id === id && s2SessionResourceKind(node)));
    if (!nodeId) throw new Error('资料节点已不存在，请在当前画布重新选择。');
    const owner = (document.composites ?? []).filter(item => item.nodeIds.includes(nodeId)).sort((a, b) => s2CompositePath(document, b.id).length - s2CompositePath(document, a.id).length)[0];
    clearRuntimeProblem(); setError(''); showComposite(owner?.id ?? null); focusNode(nodeId); setWorkspacePanel(null); setResourceFocusRequest(problem);
    setNotice('已定位原资料节点。请选择本局资料，再使用包内入口运行；定位不会读取资料或修改输入。');
  }
  function locateModelRequest(run: S2WorkflowRun, waitId: string) {
    const host = currentRunAction(run), wait = host.waitingModelTests().find(wait => wait.workflowId === run.id && wait.id === waitId);
    if (!wait || !run.modelWaiting?.some(item => item.id === waitId && item.nodeId === wait.nodeId)) throw new Error('这项模型请求已失效；没有重新排队或发送。');
    const owner = (document.composites ?? []).filter(item => item.nodeIds.includes(wait.nodeId)).sort((a, b) => s2CompositePath(document, b.id).length - s2CompositePath(document, a.id).length)[0];
    clearRuntimeProblem(); setError(''); showComposite(owner?.id ?? null); focusNode(wait.nodeId); setWorkspacePanel(null); setModelFocusRequest({ host, scene: scene!, waitId });
    setNotice(`已定位${humanWaitLabel(wait)}的完整请求核对区；尚未确认或发送，不改变授权、用量和原文。`);
  }
  function chooseModelRequest(wait: ReturnType<S2PluginHost['waitingModelTests']>[number], approved: boolean) {
    const run = workflowRuns.find(run => run.id === wait.workflowId);
    if (!run) throw new Error('模型确认已失效，未改变其他请求');
    const host = currentRunAction(run), current = host.waitingModelTests().find(item => item.id === wait.id && item.workflowId === wait.workflowId);
    if (!current || JSON.stringify(current) !== JSON.stringify(wait)) throw new Error('模型确认已失效，未发送或改变其他请求');
    host.confirmModelTest(wait.workflowId, wait.id, approved); clearRuntimeProblem(); refreshWorkflow(host);
    setNotice(approved ? `已接收${humanWaitLabel(wait)}的发送确认；后续以真实调用记录为准，不自动追加请求。`
      : `已拒绝${humanWaitLabel(wait)}的这次模型请求；没有发送或新增模型用量，整局授权未因此撤回。再次测试需另行运行并重新确认。`);
  }
  function inspectConnectionProblem(problem: ConnectionProblem, nodeId: string, connectionId?: string) {
    if (!currentConnectionProblem(problem)) throw new Error('连接问题定位已过期；请在当前画布重新检查，未改变材料或连线。');
    if (!problem.issue.nodeIds.includes(nodeId) || connectionId && !problem.issue.connectionIds.includes(connectionId)) throw new Error('不能定位不属于本次问题的步骤或连接。');
    const link = connectionId ? s2ConnectionDescriptions(definition!, documentRef.current).find(item => item.id === connectionId) : undefined;
    if (connectionId && !link) throw new Error('原连接已不存在，请重新检查。');
    // Navigate to the real receiver, even if its visible endpoint was a composite proxy.
    const target = link?.targetId ?? nodeId;
    const owner = (documentRef.current.composites ?? []).filter(item => item.nodeIds.includes(target))
      .sort((a, b) => s2CompositePath(documentRef.current, b.id).length - s2CompositePath(documentRef.current, a.id).length)[0];
    setConnectionProblem(null); setError(''); showComposite(owner?.id ?? null); focusNode(target);
    setConnectionSelection(link ? { id: link.id, scene: problem.scene, view: owner?.id ?? null } : null);
    recoveryConditionTarget.current = null;
    recoveryFieldTarget.current = null;
    recoveryFocus.current = true;
    setNotice(`已定位${s2ConnectionNodeLabel(definition!, documentRef.current, target)}的设置。原材料和连线均保留；请自行选择要修改的来源或运行条件，修改不会自动执行。`);
  }
  const selectedConnection = connectionSelection?.scene === scene && connectionSelection.view === openComposite && visibleConnectionIds.has(connectionSelection.id)
    ? connectionById.get(connectionSelection.id) : undefined;
  function showConnection(id: string) {
    if (!developerDiagnostics) return;
    if (sceneRef.current !== scene || openCompositeRef.current !== openComposite || id && !visibleConnectionIds.has(id)) return;
    setConnectionProblem(null);
    if (!id) { setConnectionSelection(null); return; }
    setConnectionSelection({ id, scene, view: openComposite });
    setWorkspacePanel('diagnostics');
    connectionHelp.current?.scrollIntoView({ block: 'nearest' });
  }
  return <S2CanvasDisplayBoundary onExit={leaveScene}><section className="s2-trial" data-scene-pack={selectedPack ? `${selectedPack.manifest.id}@${selectedPack.manifest.version}` : undefined} aria-label="S2 通用画布试验" onKeyDown={handleCanvasShortcut}>
    <header className="s2-header"><div><h2>S2 实验画布</h2><p>自行填写、接线；需要时再请 Agent 帮助。</p></div>
      <div className="s2-actions"><button onClick={leaveScene}>返回</button>
      </div></header>
    <div className="s2-status" aria-live="polite">{busy || notice || (phase === 'preview' ? '可直接编辑画布，或使用插件包提供的操作入口。' : finished ? '试验已结束，可保存画布模板或返回。' : '可编辑画布，或向 Agent 描述要求。')}
      {active.current && <button onClick={() => { active.current?.abort(); active.current = null; setBusy(''); setNotice('请求已停止，迟到回应不会应用。'); }}>停止请求</button>}</div>
    {error && !(visibleProblem && error === `${visibleProblem.issue.title}：${visibleProblem.issue.summary} ${visibleProblem.issue.detail}`) && <div className="s2-error" role="alert">{error}{!scene && <button onClick={leaveScene}>返回重新选择</button>}</div>}
    {definition && <>
      <nav className="s2-toolbar" aria-label="画布工具" ref={canvasToolbar}>
        <button type="button" aria-expanded={workspacePanel === "add"} onClick={() => setWorkspacePanel(workspacePanel === "add" ? null : "add")}>添加</button>
        <button type="button" disabled={!!busy} onClick={() => void saveSceneSnapshot()}>保存场景</button>
        {selected && <button type="button" onClick={() => setWorkspacePanel('node')}>节点设置</button>}
        <button type="button" aria-expanded={workspacePanel === "more"} onClick={() => setWorkspacePanel(workspacePanel === "more" ? null : "more")}>更多</button>
        {currentComposite && <><nav aria-label="组合层级"><button disabled={finished} onClick={() => act(() => {
          if (phaseRef.current === 'finished' || sceneRef.current !== scene || openCompositeRef.current !== openComposite) throw new Error('组合视图已变化');
          showComposite(null); focusNode(null);
        })}>返回总画布</button>{compositePath.map(item => <button key={item.id} disabled={finished || item.id === currentComposite.id} aria-current={item.id === currentComposite.id ? 'page' : undefined}
          onClick={() => compositeOperation(item.id, 'enter', scene!, JSON.stringify(document))}>跳转到组合 · {item.label}</button>)}</nav>
          <strong>正在编辑：{currentComposite.label}</strong><button disabled={finished} onClick={() => compositeOperation(currentComposite.id, 'leave', scene!, JSON.stringify(document))}>返回上级画布</button><small>外部连接仍保留；在上级设置跨组合材料。编辑不会自动运行。</small></>}
      </nav>
      <div className="s2-body"><div className="s2-canvas-shell" ref={canvasKeyboardScope}><div className="s2-flow" aria-label="自由画布" tabIndex={0}>
        <ReactFlow nodeTypes={nodeTypes} nodes={flowNodes} edges={flowEdges} deleteKeyCode={null} nodesDraggable={!finished} nodesConnectable={!finished} selectionOnDrag multiSelectionKeyCode={['Control', 'Meta']} minZoom={0.1}
          onEdgeClick={(event, edge) => { if (connectionById.has(edge.id)) {
            if (!finished && !event.ctrlKey && !event.metaKey && !event.shiftKey) { selectNodes([]); selectEdges([edge.id]); }
            showConnection(edge.id);
          } }}
          onEdgesChange={changes => { if (finished || sceneRef.current !== scene || openCompositeRef.current !== openComposite) return;
            const ids = new Set(edgeSelectionRef.current);
            for (const change of changes) if (change.type === 'select' && visibleConnectionIds.has(change.id) && connectionById.has(change.id)) {
              if (change.selected) ids.add(change.id); else ids.delete(change.id);
            }
            selectEdges([...ids]);
          }}
          onNodeClick={(event, node) => { setConnectionSelection(null); if (!event?.ctrlKey && !event?.metaKey && !event?.shiftKey) selectEdges([]);
            const hiddenContentSettings = canvasPolicy?.contentSettings === 'hide' && document.nodes.some(item => item.id === node.id);
            if (shouldOpenSettings(node.id) && !hiddenContentSettings) setWorkspacePanel('node');
            else if (workspacePanel === 'node') setWorkspacePanel(null);
            const composite = document.composites?.find(item => item.id === node.id);
            if (composite) { compositeOperation(composite.id, 'select', scene!, JSON.stringify(document)); return; }
            if (phaseRef.current !== 'finished' && sceneRef.current === scene && s2AllNodes(documentRef.current).some(item => item.id === node.id)) {
            if (!event?.ctrlKey && !event?.metaKey && !event?.shiftKey) { if (!selectionRef.current.includes(node.id)) selectNodes([node.id]); setSelected(node.id); }
            else setSelected(selectionRef.current.includes(node.id) ? node.id : null);
          } }} onPaneClick={() => { setConnectionSelection(null); selectEdges([]); focusNode(null); if (workspacePanel === 'node') setWorkspacePanel(null); }}
          onNodeDragStart={beginDrag}
          onSelectionDragStart={beginDrag}
          onNodesChange={changes => {
            let measuredChanged = false;
            for (const change of changes) if (change.type === 'dimensions' && flowNodeIds.has(change.id)) {
              const dimensions = change.dimensions;
              if (!dimensions || !Number.isFinite(dimensions.width) || !Number.isFinite(dimensions.height) || dimensions.width <= 0 || dimensions.height <= 0) continue;
              const previous = measuredNodes.current.get(change.id);
              if (previous?.width === dimensions.width && previous.height === dimensions.height) continue;
              measuredNodes.current.set(change.id, { width: dimensions.width, height: dimensions.height }); measuredChanged = true;
            }
            if (measuredChanged) setMeasurementRevision(value => value + 1);
            if (phaseRef.current === 'finished' || sceneRef.current !== scene || openCompositeRef.current !== openComposite) return;
            if (changes.some(change => change.type === 'position') && JSON.stringify(document.composites ?? []) !== JSON.stringify(documentRef.current.composites ?? [])) return;
            const selectedIds = new Set(selectionRef.current), existing = new Set(s2AllNodes(documentRef.current).map(node => node.id));
            for (const change of changes) if (change.type === 'select') {
              const ids = documentRef.current.composites?.find(composite => composite.id === change.id)?.nodeIds ?? (existing.has(change.id) ? [change.id] : []);
              ids.forEach(id => { if (change.selected) selectedIds.add(id); else selectedIds.delete(id); });
            }
            selectNodes([...selectedIds]);
            let next = documentRef.current;
            const gestureActive = !!dragStart.current;
            if (changes.some(change => change.type === 'position' && change.position)) beginDrag();
            for (const change of changes) if (change.type === 'position' && change.position) {
              const composite = next.composites?.find(composite => composite.id === change.id);
              if (composite) {
                if (JSON.stringify(document.composites ?? []) !== JSON.stringify(documentRef.current.composites ?? []) || semanticDocumentKey(document) !== semanticDocumentKey(documentRef.current)) continue;
                const position = s2CompositePosition(next, composite); next = mutateS2Batch(next, { kind: 'move', nodeIds: composite.nodeIds, delta: { x: change.position.x - position.x, y: change.position.y - position.y } }); continue;
              }
              next = { ...next, nodes: next.nodes.map(node => node.id === change.id ? { ...node, position: change.position! } : node) };
              if (next.execution) next = { ...next, execution: { ...next.execution, nodes: next.execution.nodes.map(node => node.id === change.id ? { ...node, position: change.position! } : node) } };
            }
            if (next !== documentRef.current) act(() => {
              write(readS2Document(next, readS2Scene(sceneRef.current!)));
              if (!gestureActive && !changes.some(change => change.type === 'position' && change.dragging === true)) finishDrag();
            });
          }}
          onNodeDragStop={() => act(finishDrag)}
          onSelectionDragStop={() => act(finishDrag)}
          onConnect={connection => act(() => connect(connection.source, connection.sourceHandle ?? null, connection.target, connection.targetHandle ?? null))}
          fitView><Background /><Controls /></ReactFlow>
      </div><div className="s2-workspace-panels" data-panel={workspacePanel ?? undefined} hidden={!workspacePanel} ref={workspacePanelRef} tabIndex={-1} role="region" aria-label="画布操作面板" onKeyDown={event => { if (event.key === "Escape") { event.stopPropagation(); setWorkspacePanel(null); } }}>
        <header className="s2-panel-heading"><strong>{{node:"节点设置",add:"添加",more:"更多",diagnostics:"开发诊断"}[workspacePanel ?? "node"]}</strong><button type="button" aria-label="关闭画布操作面板" onClick={() => setWorkspacePanel(null)}>关闭</button></header>
        <section hidden={workspacePanel !== "more"} className="s2-more-actions">
        {scene && <details><summary>场景保存什么</summary><p>保存已应用的内容、参数、连线、布局、组合、蓝图及场景设定，保留插件包的精确版本引用；每次新增一份可复用场景，不覆盖原场景，不保存尚未应用的草稿。</p><p>保存时清理文本文件、图片、项目笔记的本局临时资料引用；不会撤回当前正在使用的资料。下次打开保留画布配置，并提示重新选择资料。对话、执行结果、等待、本局授权和已用额度不随场景保存。</p></details>}
        <span>已选 {selection.length} 个节点</span>
        <button disabled={finished || !selection.length} onClick={() => batch('copy')}>复制所选（含内部连线）</button>
          <label><input type="checkbox" checked={developerDiagnostics} onChange={event => setDeveloperDiagnostics(event.target.checked)} />开发诊断（显示技术信息）</label>
          {developerDiagnostics && <button type="button" onClick={() => setWorkspacePanel("diagnostics")}>查看连接与技术说明</button>}
        </section>
        <section hidden={workspacePanel !== "node"} className="s2-common-panel" aria-label="选择与填写">
          <h3>选择与填写</h3><p>点选画布中的内容或处理步骤，也可在下面选择；填写与运行是独立操作。</p>
        <label>选择执行节点<select value={selectedWorkflow?.id ?? ''} onChange={e => {
          if (phaseRef.current === 'finished' || sceneRef.current !== scene) return;
          const id = e.target.value, owner = (documentRef.current.composites ?? []).filter(item => item.nodeIds.includes(id)).sort((a, b) => s2CompositePath(documentRef.current, b.id).length - s2CompositePath(documentRef.current, a.id).length)[0];
          showComposite(owner?.id ?? null); focusNode(id || null);
        }}><option value="">请选择</option>{document.execution?.nodes.map((node, index) => <option key={node.id} value={node.id}>{s2NodeTitle(node)} · 步骤 {index + 1}</option>)}</select></label>
        {publicCatalog && (selectedWorkflow && !selectedPublicComponent || selectedNode && !selectedPublicContent) && <p>此组件由包内运行程序管理，不能修改。</p>}
        {selectedWorkflow && selectedCapability && (!publicCatalog || selectedPublicComponent) && <section ref={recoveryPanel} tabIndex={-1} aria-label="所选步骤说明"><h3>{s2NodeTitle(selectedWorkflow)}</h3><p>{s2NodeDescription(selectedWorkflow)}</p>
          {(developerDiagnostics || (selectedViewPolicy?.showResult ?? !scenePackView(scene?.interactionPack, selectedWorkflow, 'node'))) && selectedResultRun && resultArtifacts(selectedResultRun.id, selectedWorkflow.id).some(artifact => JSON.stringify(artifact.payload).length > 1500) && <button type="button" onClick={event => act(() => openResult(selectedResultRun.id, selectedWorkflow.id, event.currentTarget))}>全屏阅读所选步骤结果</button>}
          <details><summary>用途与帮助</summary>{pluginGuide(selectedWorkflow, allowedCapabilities, '当前步骤的使用帮助', true)}</details>
          <ScenePackView reference={scene?.interactionPack} slot="settings" context={packViewContext(selectedWorkflow)} />
          {!publicCatalog && genericSettings && renderFieldChoices(selectedWorkflow)}
          {ordinaryInputs.map(port => {
            const input = s2MaterialInput(definition, document, selectedWorkflow.id, port.id), label = s2PortLabel(selectedWorkflow, port, 'inputs');
            const choose = (selected: string[]) => act(() => {
              guardConnectionAction();
              if (phaseRef.current === 'finished' || sceneRef.current !== scene) throw new Error('本次材料选择已过期');
              const commands = planS2MaterialInput(definition, documentRef.current, selectedWorkflow.id, port.id, selected, input.base);
              if (!commands.length) return;
              patch(commands);
              pluginHost.current?.recordParameterControl(selectedWorkflow.id, port.id, s2ParameterSource(documentRef.current, selectedWorkflow.id, port.id).key, !selected.length ? 'cleared' : selected.includes('manual') || selected.includes('fixed') ? 'committed' : 'referenced');
            });
            let textBase = s2ParameterSource(document, selectedWorkflow.id, port.id).key;
            const binding = selectedWorkflow.bindings[port.id];
            const noteId = `s2-material-note-${selectedWorkflow.id}-${port.id}`;
            return <div key={JSON.stringify([selectedWorkflow.id, port.id])} ref={element => registerViewPanel({ kind: 'input', nodeId: selectedWorkflow.id, portId: port.id }, element)} tabIndex={-1} role="group" aria-label={`${s2NodeTitle(selectedWorkflow)}「${label}」的材料设置`}>
              {port.multiple ? <fieldset><legend>{label}的材料来源</legend><p>可勾选多条来源；只改变连接，不自动运行。</p>
                {input.options.map(option => <label key={option.id}><input type="checkbox" aria-label={`${label}的材料来源 · ${option.label}`} disabled={finished} checked={input.selected.includes(option.id)} onChange={event => choose(event.target.checked ? [...input.selected, option.id] : input.selected.filter(id => id !== option.id))} />{option.label}</label>)}
                {!input.options.length && <p>目前没有类型匹配的材料，请先添加相应处理步骤。</p>}
                {selectedWorkflow.pluginId === 'workflow-merge' && <p>这是候选分支，不会拼接内容：运行时只能有一路命中；多路同时命中会提示冲突，不替你选第一路。</p>}
              </fieldset> : <label>{`为${label}选择材料`}<select disabled={finished} value={input.selected[0] ?? ''} onChange={event => choose(event.target.value ? [event.target.value] : [])}>
                <option value="">{port.required ? '请选择材料' : '不提供（可选）'}</option>{input.options.map(option => <option key={option.id} value={option.id}>{option.label}</option>)}
              </select></label>}
              {!!input.unavailable.length && <details><summary>为何其他结果不能直接使用</summary><ul>{input.unavailable.map((item, index) => <li key={index}>{item.label}<small>{item.reason}</small></li>)}</ul>
                <p>这里只说明直接连接的类型限制，不会替你添加转换步骤或运行。可查看本场景已允许插件的用途，再明确选择如何处理。</p></details>}
              {input.manual && binding?.kind === 'literal' && typeof binding.value === 'string' && <label>{`填写${label}`}<textarea aria-label={`填写${label}`} aria-describedby={noteId} disabled={finished} value={binding.value} maxLength={6000} onChange={event => act(() => {
                textBase = commitInputBinding(selectedWorkflow.id, port.id, { kind: 'literal', value: event.target.value }, textBase, scene!);
              })} /><small id={noteId}>填写即更新参数，不会运行步骤；切换为引用材料后，输入内容由所选来源提供。</small></label>}
              {(selectedWorkflow.presentation?.inputForms?.[port.id] || port.type.id === 'structured-data.value' && port.type.version === 1 && !port.multiple) && <>
                {s2ParameterSource(document, selectedWorkflow.id, port.id).connected && <p>材料来自已连接的步骤。要直接填写，请先取消该输入的连线；当前内容不会被表单覆盖。</p>}
                {binding?.kind === 'field' && <p>材料引用了内容块；请修改原内容，或明确清除引用后再直接填写。</p>}
                <S2JsonParameter nodeId={selectedWorkflow.id} portId={port.id} formField={selectedWorkflow.presentation?.inputForms?.[port.id]} valueForm label={label}
                  value={binding?.kind === 'literal' ? binding.value : undefined} sourceKey={textBase}
                  drafts={parameterDrafts.current} disabled={finished || binding?.kind === 'field' || s2ParameterSource(document, selectedWorkflow.id, port.id).connected}
                  onCommit={(value, base = textBase, via) => commitParameter(selectedWorkflow.id, port.id, value, base, scene!, via)}
                  onStateChange={(state, base, via) => {
                    if (phaseRef.current === 'running' && pluginHost.current === displayedHost && sceneRef.current === scene) displayedHost?.recordParameterControl(selectedWorkflow.id, port.id, base, state, via);
                  }} />
              </>}
            </div>;
          })}
          {!publicCatalog && renderConditionControls(selectedWorkflow)}
          {!publicCatalog && developerDiagnostics && genericSettings && <details key={selectedWorkflow.id}><summary>高级接线与参数</summary><fieldset><legend>{selectedWorkflow.capabilityId} 的参数与输入</legend>
          <p>{selectedCapability.meaning}</p>
          {selectedCapability.inputs.map(port => {
            const binding = selectedWorkflow.bindings[port.id], connected = !!document.execution?.links.some(link => link.target.nodeId === selectedWorkflow.id && link.target.portId === port.id);
            let bindingBase = s2ParameterSource(document, selectedWorkflow.id, port.id).key;
            const changeBinding = (value: S2InputBinding | null) => { bindingBase = commitInputBinding(selectedWorkflow.id, port.id, value, bindingBase, scene!); };
            return <div key={`${selectedWorkflow.id}-${port.id}`} ref={element => registerViewPanel({ kind: 'input', nodeId: selectedWorkflow.id, portId: port.id, sectionId: 'advanced' }, element)} tabIndex={-1} role="group" aria-label={`${s2NodeTitle(selectedWorkflow)}「${s2PortLabel(selectedWorkflow, port, 'inputs')}」的高级设置`}><small>{port.id}：{port.type.id}@{port.type.version}{port.multiple ? '（多路输入）' : ''}{connected ? '（已接线；需断开后修改常量）' : ''}</small>
              {port.type.id === 'core.text' && <><label>{`参数 ${port.id}`}<textarea disabled={finished || connected} value={binding?.kind === 'literal' ? String(binding.value) : ''} onChange={e => act(() => changeBinding({ kind: 'literal', value: e.target.value }))} maxLength={6000} /></label>
                <label>{`引用字段 ${port.id}`}<select disabled={finished || connected} value={binding?.kind === 'field' ? JSON.stringify([binding.nodeId, binding.fieldId]) : ''} onChange={e => act(() => {
                  if (!e.target.value) { changeBinding(null); return; }
                  const [nodeId, fieldId] = JSON.parse(e.target.value); changeBinding({ kind: 'field', nodeId, fieldId });
                })}><option value="">无字段引用</option>{document.nodes.flatMap(node => Object.keys(node.values).map(fieldId => <option key={`${node.id}-${fieldId}`} value={JSON.stringify([node.id, fieldId])}>{node.id} · {fieldId}</option>))}</select></label></>}
              {binding && <button disabled={finished} onClick={() => act(() => changeBinding(null))}>清除输入 {port.id}</button>}
              {port.type.id !== 'core.text' && !(port.type.id === 'structured-data.value' && port.type.version === 1 && !port.multiple) && !selectedWorkflow.presentation?.inputForms?.[port.id] && <S2JsonParameter key={JSON.stringify([selectedWorkflow.id, port.id])} nodeId={selectedWorkflow.id} portId={port.id}
                value={binding?.kind === 'literal' ? binding.value : undefined} sourceKey={s2ParameterSource(document, selectedWorkflow.id, port.id).key}
                drafts={parameterDrafts.current} disabled={finished || connected}
                onCommit={(value, base = s2ParameterSource(document, selectedWorkflow.id, port.id).key, via) => commitParameter(selectedWorkflow.id, port.id, value, base, scene!, via)}
                onStateChange={(state, base, via) => {
                  if (phaseRef.current === 'running' && pluginHost.current === displayedHost && sceneRef.current === scene) displayedHost?.recordParameterControl(selectedWorkflow.id, port.id, base, state, via);
                }} />}
              {binding?.kind === 'literal' && port.type.id !== 'core.text' && <pre>{JSON.stringify(binding.value, null, 2)}</pre>}
            </div>;
          })}
          <button disabled={finished} onClick={() => act(() => { const id = `exec-${crypto.randomUUID()}`; patchHere([{ op: 'add-execution-node', node: { ...structuredClone(selectedWorkflow), id, position: { x: selectedWorkflow.position.x + 60, y: selectedWorkflow.position.y + 60 } } }]); focusNode(id); })}>复制所选执行节点（不复制连线）</button>
          <button disabled={finished} onClick={() => act(() => { patch([{ op: 'remove-execution-node', id: selectedWorkflow.id }]); focusNode(null); })}>删除执行节点及其连线</button>
          <label>数据线来源<select disabled={finished} value={wireSource} onChange={e => { setWireSource(e.target.value); setWireOutput(''); }}><option value="">请选择上游节点</option>{document.execution?.nodes.filter(node => node.id !== selectedWorkflow.id).map(node => <option key={node.id} value={node.id}>{node.capabilityId} · {node.id.slice(-8)}</option>)}</select></label>
          <label>来源输出端口<select disabled={finished} value={wireOutput} onChange={e => setWireOutput(e.target.value)}><option value="">请选择</option>{sourcePorts.map(port => <option key={port.id} value={port.id}>{port.id} · {port.type.id}</option>)}</select></label>
          <label>所选节点输入端口<select disabled={finished} value={wireInput} onChange={e => setWireInput(e.target.value)}><option value="">请选择</option>{selectedCapability.inputs.map(port => <option key={port.id} value={port.id}>{port.id} · {port.type.id}</option>)}</select></label>
          <button disabled={finished || !wireSource || !wireOutput || !wireInput} onClick={() => act(() => connect(wireSource, `out:${wireOutput}`, selectedWorkflow.id, `in:${wireInput}`))}>连接数据端口</button>
        </fieldset></details>}</section>}
        {canvasPolicy?.contentSettings !== 'hide' && <><h3>{selectedType ? `编辑：${selectedNode?.label?.trim() || selectedType.label}` : '画布对象'}</h3>
        <label>选择块<select value={selectedNode?.id || ''} onChange={e => focusNode(e.target.value || null)}><option value="">请选择</option>{document.nodes.map((node, index) => <option key={node.id} value={node.id}>{node.label?.trim() || definition.blockTypes.find(type => type.id === node.type)?.label} · 内容 {index + 1}</option>)}</select></label>
        {selectedNode && selectedType && (!publicCatalog || selectedPublicContent) && <><label>名称（可选）<input value={selectedNode.label ?? ''} maxLength={80} disabled={finished} placeholder="只方便辨认，不决定内容用途" onChange={event => act(() => {
            if (phaseRef.current === 'finished' || phaseRef.current !== phase || sceneRef.current !== scene || historyVersion.current !== renderedHistoryVersion
              || JSON.stringify(selectionRef.current) !== JSON.stringify(selection)
              || documentRef.current.nodes.find(node => node.id === selectedNode.id)?.label !== selectedNode.label) throw new Error('名称编辑已过期，请在当前内容块重新填写。');
            patch([{ op: 'update-node', id: selectedNode.id, values: {}, label: event.target.value }]);
          })} /></label>
          <small>内容块只保存原文；怎样使用由接收它的处理步骤决定。名称不改变内容、连接或执行结果。</small>
          {selectedNode.readOnly && <p className="s2-readonly-label">只读 · 场景固定内容，可查看、复制或连接到处理步骤。</p>}
          <details ref={element => { recoveryPanel.current = element; }} tabIndex={-1} aria-label="所选内容说明" key={selectedNode.id} open={!selectedType.advanced}><summary>{selectedType.advanced ? '高级内容与格式' : '编辑内容'}</summary>{selectedType.fields.filter(field => !publicCatalog || selectedPublicContent?.parameters.includes(field.id)).map(field => <div key={`${selectedNode.id}-${field.id}`} ref={element => registerViewPanel({ kind: 'content', nodeId: selectedNode.id, fieldId: field.id }, element)} tabIndex={-1} role="group" aria-label={`${selectedNode.label?.trim() || selectedType.label}「${field.label}」的原内容`}>{!['text', 'multiline'].includes(field.kind) || field.required !== undefined || field.maxLength !== undefined || field.defaultValue !== undefined
          ? selectedNode.readOnly ? <S2FieldPreview field={field} value={selectedNode.values[field.id]} /> : <S2FieldEditor key={`${selectedNode.id}-${field.id}`} nodeId={selectedNode.id} field={field} value={selectedNode.values[field.id]} drafts={controlDrafts.current} disabled={finished}
            onSubmit={event => submitField(event, scene!, JSON.stringify(field))}
            onStateChange={(state, base) => {
              if (phaseRef.current === 'running' && sceneRef.current === scene) pluginHost.current?.recordFieldControl(selectedNode.id, field.id, base, state);
            }} />
          : <label key={`${selectedNode.id}-${field.id}`}>{field.label}
          {field.kind === 'multiline' ? <textarea disabled={finished} readOnly={selectedNode.readOnly === true} value={selectedNode.values[field.id]} maxLength={6000} onChange={e => act(() => editPlainField(selectedNode.id, field.id, e.target.value))} />
            : <input disabled={finished} readOnly={selectedNode.readOnly === true} value={selectedNode.values[field.id]} maxLength={6000} onChange={e => act(() => editPlainField(selectedNode.id, field.id, e.target.value))} />}</label>}</div>)}</details>
          <button disabled={finished || readOnlyBaseline.current?.document.nodes.some(node => node.id === selectedNode.id && node.readOnly)} onClick={() => act(() => { patch([{ op: 'remove-node', id: selectedNode.id }]); focusNode(null); })}>删除所选块及连线</button></>}
        {selectedNode && selectedType && hasJsonCheck && <>
          <label>插件输入字段<select value={selectedType.fields.some(field => field.id === pluginField) ? pluginField : selectedType.fields[0].id} disabled={finished || !!busy} onChange={e => setPluginField(e.target.value)}>{selectedType.fields.map(field => <option key={field.id} value={field.id}>{field.label}</option>)}</select></label>
          <button disabled={finished || !!busy} onClick={checkSelectedField}>检查 JSON 格式</button></>}</>}
        </section>
        {visibleRuntimeProblem && <section ref={runtimeHelp} aria-label="运行问题与恢复" role="alert" className="s2-connection-help s2-connection-problem">
          <h3>{visibleRuntimeProblem.issue.title}</h3><p>{visibleRuntimeProblem.issue.summary}</p><p>{visibleRuntimeProblem.issue.detail}</p>
          <p>以下按钮只定位设置，不会填写材料、选择分支、改线或重跑。</p>
          {visibleRuntimeProblem.issue.kind === 'model-request' && <button type="button" disabled={finished}
            onClick={() => act(() => locateModelAuthorization(visibleRuntimeProblem))}>查看模型授权与用量（不发送）</button>}
          {visibleRuntimeProblem.issue.resourceSource && <button type="button" disabled={!!busy || finished}
            onClick={() => act(() => locateResourceSettings(visibleRuntimeProblem))}>{visibleRuntimeProblem.issue.resourceSource === 'file' ? '查看本局文本资料设置（不读取）' : '查看本局项目笔记设置（不读取）'}</button>}
          {visibleRuntimeProblem.issue.kind === 'condition-unavailable' && visibleRuntimeProblem.evidence.kind === 'runtime' && <button type="button" disabled={!!busy || finished}
            onClick={() => act(() => { if (visibleRuntimeProblem.evidence.kind === 'runtime') locateRuntimeProblem(visibleRuntimeProblem, visibleRuntimeProblem.evidence.nodeId, 'condition'); })}>
            {`查看运行条件 · ${s2ConnectionNodeLabel(definition, document, visibleRuntimeProblem.evidence.nodeId)}`}</button>}
          {visibleRuntimeProblem.issue.kind === 'structured-transform' && visibleRuntimeProblem.evidence.kind === 'runtime'
            && document.execution?.nodes.find(node => node.id === (visibleRuntimeProblem.evidence.kind === 'runtime' ? visibleRuntimeProblem.evidence.nodeId : '')
              && node.pluginId === 'structured-data' && node.pluginVersion === '1.0.0' && node.capabilityId === 'select') && <button type="button" disabled={!!busy || finished}
              onClick={() => act(() => { if (visibleRuntimeProblem.evidence.kind === 'runtime') locateRuntimeProblem(visibleRuntimeProblem, visibleRuntimeProblem.evidence.nodeId, 'extraction'); })}>
              {`查看提取设置 · ${s2ConnectionNodeLabel(definition, document, visibleRuntimeProblem.evidence.nodeId)}`}</button>}
          <div className="s2-actions">{visibleRuntimeProblem.issue.nodeIds.map(id => <button type="button" key={id} disabled={!!busy || finished}
            onClick={() => act(() => locateRuntimeProblem(visibleRuntimeProblem, id))}>{`查看相关步骤 · ${s2ConnectionNodeLabel(definition, document, id)}`}</button>)}</div>
          <details><summary>本次问题的技术详情</summary><pre>{visibleRuntimeProblem.issue.technical}</pre></details>
        </section>}
        <section hidden={!visibleProblem && (!developerDiagnostics || workspacePanel !== "diagnostics")} ref={connectionHelp} aria-label="连接说明" className="s2-connection-help"><h3>连接说明</h3>
          {visibleProblem && <section aria-label="连接未应用" role="alert" className="s2-connection-problem">
            <h4>{visibleProblem.issue.title}</h4><p>{visibleProblem.issue.summary}</p><p>{visibleProblem.issue.detail}</p>
            <p>原图未改变。以下按钮只定位设置，不会断线、替换材料或运行。</p>
            <div className="s2-actions">{visibleProblem.issue.nodeIds.map(id => <button key={id} type="button" onClick={() => act(() => inspectConnectionProblem(visibleProblem, id))}>{`查看相关${document.nodes.some(node => node.id === id) ? '内容' : '步骤'}：${s2ConnectionNodeLabel(definition, document, id)}`}</button>)}</div>
            {visibleProblem.issue.connectionIds.map(id => { const link = connectionById.get(id); return link ? <button key={id} type="button" onClick={() => act(() => inspectConnectionProblem(visibleProblem, link.targetId, id))}>{`查看已有连接：${link.summary}`}</button> : null; })}
            <details><summary>本次拒绝的技术详情</summary><pre>{visibleProblem.issue.technical}</pre></details>
          </section>}
          <label>查看连接说明<select value={selectedConnection?.id ?? ''} onChange={event => showConnection(event.target.value)}>
            <option value="">点选画布连线，或在这里选择</option>{connectionDescriptions.filter(item => visibleConnectionIds.has(item.id)).map(item => <option key={item.id} value={item.id}>{item.summary}</option>)}
          </select></label>
          {selectedConnection ? <><strong>{selectedConnection.summary}</strong><p>{selectedConnection.detail}</p>
            {(() => { const drawn = flowEdges.find(edge => edge.id === selectedConnection.id)!;
              const displayName = (id: string) => document.groups?.find(group => group.id === id)?.label ?? s2ConnectionNodeLabel(definition, document, id);
              return drawn.source !== selectedConnection.sourceId || drawn.target !== selectedConnection.targetId
                ? <p>当前画布显示为「{displayName(drawn.source)}」到「{displayName(drawn.target)}」。这是组合或分组外观；实际内部来源与接收位置以上方说明为准。</p> : null;
            })()}
            <details><summary>这条连接的技术详情</summary><pre>{selectedConnection.technical}</pre></details>
          </> : <p>材料线：把结果交给下一步。内容引用：使用你填写的文字。条件线：决定是否运行。内容关联：只表达关系，不传递材料。</p>}
          <small>查看说明不会运行步骤、读取新资料或询问 Agent。是否满足业务目标仍需另行检查。</small>
        </section>
        <div hidden={workspacePanel !== "more"}>
        <details className="s2-management" aria-label="组合与蓝图管理"><summary>组合与蓝图管理</summary>
        <section aria-label="组合处理步骤" className="s2-composite-panel"><h3>组合处理步骤</h3>
          <p>把选中的处理步骤封装为一个有名称的组合。材料和参数仍来自真实内部端口；不自动执行，不增加工具权限。</p>
          <label>组合名称<input value={compositeLabel} maxLength={80} disabled={finished} onChange={event => setCompositeLabel(event.target.value)} /></label>
          <details><summary>选择要封装的处理步骤</summary>{directSteps.map(node => <label key={node.id}>{`选择组合成员 · ${executionTitle(node.id)}`}<input type="checkbox" checked={selection.includes(node.id)} disabled={finished} onChange={event => {
            if (openCompositeRef.current !== openComposite) return;
            selectNodes(event.target.checked ? [...selectionRef.current, node.id] : selectionRef.current.filter(id => id !== node.id));
          }} /></label>)}{visibleComposites.map(composite => <label key={composite.id}>{`选择组合成员 · ${composite.label}（组合）`}<input type="checkbox" disabled={finished}
            checked={composite.nodeIds.every(id => selection.includes(id))} onChange={event => {
              if (openCompositeRef.current !== openComposite || JSON.stringify(document.composites) !== JSON.stringify(documentRef.current.composites)) return;
              selectNodes(event.target.checked ? [...selectionRef.current, ...composite.nodeIds] : selectionRef.current.filter(id => !composite.nodeIds.includes(id)));
            }} /></label>)}</details>
          <button disabled={finished || !!busy || !selection.length || !compositeLabel.trim()} onClick={() => act(() => {
            if (phaseRef.current === 'finished' || sceneRef.current !== scene || openCompositeRef.current !== openComposite || JSON.stringify(documentRef.current) !== JSON.stringify(document) || JSON.stringify(selectionRef.current) !== JSON.stringify(selection)) throw new Error('组合选区已变化，请重新选择。');
            const wrapped = wrapS2CanvasComposite(documentRef.current, definition.plugins, selectionRef.current, compositeLabel, openComposite ?? undefined);
            commit(wrapped.document); focusNode(null); setNotice('已封装选中步骤；没有执行。可进入内部编辑，或单独确认运行组合。');
          })}>封装选中步骤</button>
          {[...(currentComposite ? [currentComposite] : []), ...visibleComposites].map(composite => {
            const blueprint = compositeBlueprints.get(composite.id)!, base = JSON.stringify(document);
            const focusPort = (nodeId: string) => act(() => {
              if (phaseRef.current === 'finished' || sceneRef.current !== scene || openCompositeRef.current !== openComposite || JSON.stringify(documentRef.current) !== base) throw new Error('组合入口已变化，请重新选择。');
              const owner = (document.composites ?? []).filter(item => item.nodeIds.includes(nodeId)).sort((a, b) => s2CompositePath(document, b.id).length - s2CompositePath(document, a.id).length)[0];
              showComposite(owner?.id ?? composite.id); focusNode(nodeId);
            });
            return <details key={composite.id} open={openComposite === composite.id}><summary>{composite.label} · {composite.nodeIds.length} 个处理步骤</summary>
              <button disabled={finished} onClick={() => compositeOperation(composite.id, 'enter', scene!, base)}>进入内部 · {composite.label}</button>
              {composite.blueprint && <p>来源版本：{composite.blueprint.version}。这是独立副本，可编辑；来源标记不证明当前内容仍与蓝图一致，不恢复授权。</p>}
              {composite.blueprint && <details><summary>检查与原版的差异（只读）</summary>
                <p>对照库中来源版本，区分材料选择、可调项和内部改动；不会替换组合或运行。</p>
                <button disabled={finished} onClick={() => act(() => {
                  guardBlueprintAction();
                  setInstanceInspection({ id: composite.id, report: inspectS2CompositeInstance(documentRef.current, definition, composite.id), base, scene: scene!, view: openComposite });
                })}>{`检查实例差异 · ${composite.label}`}</button>
                {instanceInspection?.id === composite.id && (instanceInspection.base !== base || instanceInspection.scene !== scene || instanceInspection.view !== openComposite
                  ? <p role="status">画布或来源已变化，实例检查已过期，请重新检查。</p>
                  : <section aria-label="实例与原版差异" aria-live="polite">
                    {instanceInspection.report.status === 'unavailable' ? <p>{instanceInspection.report.reason}</p> : <>
                      <p>对照版本：{instanceInspection.report.source.label} · {instanceInspection.report.source.version}</p>
                      <p>{instanceInspection.report.structuralDifferences ? '发现内部设计差异，请保留并核对当前改动。' : '未发现内部步骤、接线或层级差异；不等于已运行或可自动升级。'}</p>
                      <p>内部接线：{instanceInspection.report.internalLinksChanged ? '有变化' : '未变化'}；相对布局：{instanceInspection.report.relativeLayoutChanged ? '有变化' : '未变化'}；外部材料、数据或条件引用：{instanceInspection.report.externalConnectionCount} 条（单独保留核对）。</p>
                      <details open><summary>材料与可调项</summary>
                        {instanceInspection.report.materials.map(item => <p key={`input:${item.id}`}>材料「{item.label}」：{item.targets.join('；')}</p>)}
                        {instanceInspection.report.parameters.map(item => <p key={`parameter:${item.id}`}>可调项「{item.label}」：{item.state}</p>)}
                        {!instanceInspection.report.materials.length && !instanceInspection.report.parameters.length && <p>原版没有公共材料入口或可调项。</p>}
                      </details>
                      {!!instanceInspection.report.nodeChanges.length && <details><summary>步骤变化（{instanceInspection.report.nodeChanges.length}）</summary><ul>{instanceInspection.report.nodeChanges.map(item => <li key={item.id}>{item.label}：{item.changes.join('；')}</li>)}</ul></details>}
                      {!!instanceInspection.report.hierarchyChanges.length && <details><summary>组合名称、成员与层级变化</summary><ul>{instanceInspection.report.hierarchyChanges.map((item, index) => <li key={index}>{item}</li>)}</ul></details>}
                    </>}
                    <p>{instanceInspection.report.note}</p>
                  </section>)}
              </details>}
              {composite.blueprint && <details><summary>预览其他版本的沿用方案（不应用）</summary>
                <p>只检查当前材料和参数能否进入确认。不会替换实例、重接线、复制资料权限或执行；当前改动始终保留。</p>
                <label>{`「${composite.label}」的沿用目标版本`}<select disabled={finished} value={migrationTargets[composite.id] ?? ''} onChange={event => act(() => {
                  guardBlueprintAction();
                  migrationTargetsRef.current = { ...migrationTargetsRef.current, [composite.id]: event.target.value }; setMigrationTargets(migrationTargetsRef.current); setMigrationPreview(null);
                })}><option value="">请选择同系列的另一版本</option>{blueprintEntries.filter(entry => entry.blueprint.id === composite.blueprint!.id && entry.blueprint.version !== composite.blueprint!.version).map(entry => <option key={entry.blueprint.version} value={entry.blueprint.version}>{entry.blueprint.label} · {entry.blueprint.version}</option>)}</select></label>
                <button disabled={finished || !migrationTargets[composite.id]} onClick={() => act(() => {
                  guardBlueprintAction(); if (migrationTargetsRef.current[composite.id] !== migrationTargets[composite.id]) throw new Error('沿用目标已变化，请重新选择。');
                  const version = migrationTargetsRef.current[composite.id];
                  setMigrationPreview({ id: composite.id, version, report: previewS2CompositeMigration(documentRef.current, definition, composite.id, version), base, configuration: JSON.stringify(definition), scene: scene!, view: openComposite });
                })}>{`预览材料与参数沿用 · ${composite.label}`}</button>
                {migrationPreview?.id === composite.id && (migrationPreview.base !== base || migrationPreview.configuration !== JSON.stringify(definition) || migrationPreview.scene !== scene || migrationPreview.view !== openComposite || migrationPreview.version !== migrationTargets[composite.id]
                  ? <p role="status">画布、配置或目标已变化，沿用预览已过期，请重新预览。</p>
                  : <section aria-label="材料与参数沿用预览" aria-live="polite">
                    {migrationPreview.report.status === 'unavailable' ? <p>{migrationPreview.report.reason}</p> : <>
                      <h4>{migrationPreview.report.source.version} → {migrationPreview.report.target.version} · 只读预览</h4>
                      {migrationPreview.report.direction === 'downgrade' && <p>目标是较早版本，不是自动升级建议。</p>}
                      {migrationPreview.report.blockers.map((reason, index) => <p key={index}>{reason}</p>)}
                      <p>目标内部设计：{migrationPreview.report.internalDesignChangedInTarget ? '有变化，需核对业务用途' : '未发现结构变化'}；当前外部引用：{migrationPreview.report.externalReferenceCount} 条，须单独核对，不自动重接。</p>
                      {migrationPreview.report.relativeLayoutChangedInInstance && <p>你调整过内部布局，后续也不能直接覆盖。</p>}
                      {migrationPreview.report.items.map(item => <details key={item.key}><summary>{item.kindLabel}「{item.label}」 · {item.stateLabel}</summary>
                        <p>{item.currentDescription}</p>{item.reasons.map((reason, index) => <p key={index}>{reason}</p>)}
                        {!!item.copyChoices.length && <label>{`新副本的${item.kindLabel}「${item.label}」`}<select disabled={finished || !!busy} value={copyChoices[item.key] ?? ''} onChange={event => act(() => {
                          guardBlueprintAction(); if (migrationPreviewRef.current !== migrationPreview) throw new Error('沿用预览已变化，请重新选择。');
                          const choice = event.target.value as S2CompositeCopyChoice;
                          if (choice && !item.copyChoices.includes(choice)) throw new Error('不支持该沿用选择。');
                          const next = { ...copyChoicesRef.current }; if (choice) next[item.key] = choice; else delete next[item.key];
                          copyChoicesRef.current = next; setCopyChoices(next); setCopyCandidate(null);
                        })}><option value="">请明确选择，不自动代选</option>{item.copyChoices.map(choice => <option key={choice} value={choice}>{choice === 'current' ? '沿用当前来源或值' : choice === 'target-default' ? '使用目标默认值' : '暂不设置，添加后再填写或选择'}</option>)}</select></label>}
                        {item.detailAvailable && <button disabled={finished} onClick={() => act(() => {
                          guardBlueprintAction(); if (migrationPreviewRef.current !== migrationPreview || migrationTargetsRef.current[composite.id] !== migrationPreview.version) throw new Error('沿用预览已变化，请重新预览。');
                          setMigrationDetail({ key: item.key, result: readS2CompositeMigrationDetail(migrationPreview.report, documentRef.current, definition, item.key) });
                        })}>{`查看当前值与目标默认值 · ${item.label}`}</button>}
                        {migrationDetail?.key === item.key && (migrationDetail.result.status === 'unavailable' ? <p role="status">{migrationDetail.result.reason}</p> : <div>
                          <p>当前内容（仅显示，不应用）：</p>{migrationDetail.result.detail.current.kind === 'literal' ? <pre>{migrationValueText(migrationDetail.result.detail.current.value)}</pre> : <p>{migrationDetail.result.detail.current.description}</p>}
                          <p>目标默认值：</p>{migrationDetail.result.detail.targetDefault.present ? <pre>{migrationValueText(migrationDetail.result.detail.targetDefault.value)}</pre> : <p>没有默认值。</p>}
                        </div>)}
                      </details>)}
                      {!!migrationPreview.report.outputChanges.length && <details><summary>外部输出接口也有变化</summary>{migrationPreview.report.outputChanges.map((item, index) => <p key={index}>{item.label}：{item.reasons.join('；')}</p>)}</details>}
                      <p>可按上述选择另建独立新版副本，原实例与外部输出接线不变；预览和添加分开确认，不运行。</p>
                      <button disabled={finished || !!busy || !!migrationPreview.report.missingCapabilities.length || migrationPreview.report.items.some(item => item.copyChoices.length && !copyChoices[item.key])} onClick={() => act(() => {
                        guardBlueprintAction();
                        if (migrationPreviewRef.current !== migrationPreview || JSON.stringify(copyChoicesRef.current) !== JSON.stringify(copyChoices)) throw new Error('选择已变化，请重新预览副本。');
                        const report = migrationPreview.report; if (report.status !== 'preview') throw new Error('请重新预览沿用方案。');
                        const choices = report.items.filter(item => item.copyChoices.length).map(item => ({ key: item.key, choice: copyChoicesRef.current[item.key] }));
                        setCopyCandidate({ report: prepareS2CompositeCopy(report, documentRef.current, definition, choices), preview: migrationPreview, choicesKey: JSON.stringify(copyChoicesRef.current) });
                      })}>预览独立新版副本（不添加）</button>
                      {copyCandidate?.preview === migrationPreview && <section aria-label="独立新版副本预览">
                        <h4>将新增：{copyCandidate.report.target.label} · {copyCandidate.report.target.version}</h4>
                        <p>{copyCandidate.report.nodeCount} 个真实步骤、{copyCandidate.report.compositeCount} 个组合，放置在「{copyCandidate.report.parentLabel}」。原实例不移除。</p>
                        {copyCandidate.report.selections.map((item, index) => <p key={index}>{item.label}：{item.choice}</p>)}
                        <details open><summary>新增步骤与连接</summary>{copyCandidate.report.steps.map((step, index) => <div key={index}><strong>{step.label}</strong><ul>{step.inputs.map((input, index) => <li key={index}>{input.label}：{input.source}</li>)}</ul></div>)}
                          {copyCandidate.report.connections.map((link, index) => <p key={index}>{link.source} → {link.target}{link.external ? '（保留对原步骤的输入引用）' : ''}</p>)}
                        </details>
                        {!!copyCandidate.report.requiredPending.length && <p>添加后仍需补充：{copyCandidate.report.requiredPending.join('、')}。暂不设置不会被默认值替代。</p>}
                        {copyCandidate.report.warnings.map((warning, index) => <p key={index}>{warning}</p>)}
                        <p>{copyCandidate.report.note}</p>
                        {renderOutputPreview(copyCandidate)}
                        <button disabled={finished || !!busy} onClick={() => act(() => {
                          guardBlueprintAction(); if (copyCandidateRef.current !== copyCandidate || migrationPreviewRef.current !== migrationPreview || copyCandidate.choicesKey !== JSON.stringify(copyChoicesRef.current)) throw new Error('副本预览已变化，请重新生成。');
                          setCopyDesign(readS2CompositeCopyDesign(copyCandidate.report, documentRef.current, definition));
                        })}>查看新增副本完整设计（含值与技术字段）</button>
                        {copyDesign && <details><summary>完整设计，仅显示不执行</summary><pre>{JSON.stringify(copyDesign, null, 2)}</pre></details>}
                        <button disabled={finished || !!busy} onClick={() => act(() => {
                          guardBlueprintAction(); if (copyCandidateRef.current !== copyCandidate || migrationPreviewRef.current !== migrationPreview || copyCandidate.choicesKey !== JSON.stringify(copyChoicesRef.current)) throw new Error('副本预览已变化，请重新生成。');
                          const accepted = acceptS2CompositeCopy(copyCandidate.report, documentRef.current, definition);
                          commit(accepted.document); setMigrationPreview(null); showComposite(accepted.id); focusNode(null); selectNodes(accepted.nodeIds);
                          setNotice('已按确认内容添加独立新版副本，原实例与外部输出连线保留；没有运行。画布修订已更新，请补充留空项，运行需另行确认。');
                        })}>确认添加独立新版副本（不运行）</button>
                        <button disabled={finished} onClick={() => { if (copyCandidateRef.current === copyCandidate) setCopyCandidate(null); }}>取消本次副本预览</button>
                      </section>}
                    </>}
                    <p>{migrationPreview.report.note}</p>
                  </section>)}
              </details>}
              <label>{`移动「${composite.label}」到`}<select aria-label={`移动「${composite.label}」到`} value={composite.parentId ?? ''} disabled={finished} onChange={event => act(() => {
                if (phaseRef.current === 'finished' || sceneRef.current !== scene || openCompositeRef.current !== openComposite || JSON.stringify(documentRef.current) !== base) throw new Error('组合位置已变化，请重新选择。');
                patch([{ op: 'move-composite', id: composite.id, parentId: event.target.value || null }]); focusNode(null);
              })}><option value="">总画布</option>{(document.composites ?? []).filter(item => !s2CompositePath(document, item.id).some(ancestor => ancestor.id === composite.id)).map(item => <option key={item.id} value={item.id}>{s2CompositePath(document, item.id).map(ancestor => ancestor.label).join(' / ')}</option>)}</select></label>
              <small>只改变归属，不运行。原父级为空时会移除空壳，步骤和连线保留。</small>
              {!!blueprint.inputs.length && <div><h4>需要的材料</h4>{blueprint.inputs.map(input => <button key={input.id} disabled={finished} onClick={() => focusPort(input.targets[0].nodeId)}>设置材料 · {input.label}</button>)}</div>}
              {!!blueprint.outputs.length && <div><h4>输出结果</h4>{blueprint.outputs.map(output => <p key={output.id}>{output.label}</p>)}</div>}
              {!!blueprint.parameters.length && <div><h4>可调项</h4>{blueprint.parameters.map(parameter => <button key={parameter.id} disabled={finished} onClick={() => focusPort(parameter.target.nodeId)}>调整 · {parameter.label}</button>)}</div>}
              <button disabled={finished} onClick={() => compositeOperation(composite.id, 'unwrap', scene!, base)}>拆开组合（保留步骤） · {composite.label}</button>
            </details>;
          })}
        </section>
        <details aria-label="可复用蓝图库" className="s2-composite-panel"><summary>可复用蓝图库（{blueprintEntries.length} / 8）</summary>
          <p>蓝图库随本画布模板保存，可显式导入/导出。保存和添加只改设计，不运行；固定文本和默认参数会随蓝图保存，请先检查。外部内容块和本局资料选择不会复制。</p>
          <details><summary>保存组合为蓝图</summary>
            <label>要保存的组合<select value={publicationSource?.id ?? ''} disabled={finished} onChange={event => editPublication('source', event.target.value)}><option value="">请选择组合</option>{document.composites?.map(item => <option key={item.id} value={item.id}>{s2CompositePath(document, item.id).map(parent => parent.label).join(' / ')}</option>)}</select></label>
            <label>蓝图系列<select value={publishFamily} disabled={finished} onChange={event => editPublication('family', event.target.value)}><option value="">新系列</option>{blueprintEntries.filter((entry, index) => blueprintEntries.findIndex(item => item.blueprint.id === entry.blueprint.id) === index).map(entry => <option key={entry.blueprint.id} value={entry.blueprint.id}>{entry.blueprint.label}</option>)}</select></label>
            <label>蓝图名称<input value={publishName} maxLength={80} disabled={finished} placeholder={publicationSource?.label ?? '例如：读取并整理材料'} onChange={event => editPublication('name', event.target.value)} /></label>
            <label>蓝图版本<input value={publishVersion} maxLength={32} disabled={finished} onChange={event => editPublication('version', event.target.value)} /></label>
            <label>用途说明<textarea value={publishDescription} maxLength={1000} disabled={finished} onChange={event => editPublication('description', event.target.value)} /></label>
            <button disabled={finished || !publicationSource} onClick={() => act(() => {
              guardBlueprintAction();
              if (publishDraftRef.current !== publishDraft) throw new Error('蓝图填写内容已变化，请重新预览。');
              const design = createS2CompositeDesign(documentRef.current, definition.plugins, publicationSource!.id, { id: publishFamily || `blueprint-${crypto.randomUUID()}`, version: publishVersion,
                label: publishName || publicationSource!.label, description: publishDescription || `复用「${publicationSource!.label}」的内部步骤与层级；材料在添加后重新选用。` });
              setPublication({ design, base: JSON.stringify(documentRef.current), scene: scene!, view: openComposite });
            })}>预览将保存的蓝图</button>
            {publication && <div role="region" aria-label="蓝图保存预览"><h4>{publication.design.blueprint.label} · {publication.design.blueprint.version}</h4>
              <p>{publication.design.composites.length} 个组合层级项，{publication.design.blueprint.workflow.nodes.length} 个真实步骤；不保存执行结果、预算、等待或授权。</p>
              <p>需要的材料：{publication.design.blueprint.inputs.map(input => input.label).join('、') || '无'}</p><p>输出结果：{publication.design.blueprint.outputs.map(output => output.label).join('、') || '无'}</p>
              <p>可调项：{publication.design.blueprint.parameters.map(parameter => parameter.label).join('、') || '无'}</p>
              <details><summary>检查完整设计（含固定文本与默认值）</summary><pre>{exportS2CompositeDesign(publication.design)}</pre></details>
              <button disabled={finished} onClick={() => act(() => {
                guardBlueprintAction();
                if (publicationRef.current !== publication || publication.scene !== sceneRef.current || publication.view !== openCompositeRef.current || publication.base !== JSON.stringify(documentRef.current)) throw new Error('保存预览已过期，请重新预览。');
                commit(addS2CompositeDesign(documentRef.current, publication.design));
                const key = entryKey(publication.design); blueprintKeyRef.current = key; setBlueprintKey(key); setPublication(null); setNotice('蓝图版本已加入本画布库；请保存模板以保留，没有运行或覆盖旧版本。');
              })}>确认保存蓝图版本</button>
              <button onClick={() => { if (publicationRef.current === publication) setPublication(null); }}>取消蓝图保存</button>
            </div>}
          </details>
          <label>选择蓝图版本<select value={chosenBlueprint ? entryKey(chosenBlueprint) : ''} disabled={finished} onChange={event => { blueprintKeyRef.current = event.target.value; setBlueprintKey(event.target.value); setComparison(null); }}><option value="">暂无已保存版本</option>{blueprintEntries.map(entry => <option key={entryKey(entry)} value={entryKey(entry)}>{entry.blueprint.label} · {entry.blueprint.version}</option>)}</select></label>
          {chosenBlueprint && <div><p>{chosenBlueprint.blueprint.description}</p>
            <p>需要的材料：{chosenBlueprint.blueprint.inputs.map(input => input.label).join('、') || '无'}；输出结果：{chosenBlueprint.blueprint.outputs.map(output => output.label).join('、') || '无'}；可调项：{chosenBlueprint.blueprint.parameters.map(parameter => parameter.label).join('、') || '无'}</p>
            <p>需要的能力：{chosenBlueprint.blueprint.plugins.map(cap => s2NodeTitle(cap)).join('、')}。库中存在不代表本场景已允许使用。</p>
            <button disabled={finished || !!busy} onClick={() => act(() => {
              guardBlueprintAction(); if (blueprintKeyRef.current !== blueprintKey) throw new Error('选用版本已变化，请重新确认。');
              const offset = 60 * ((document.composites?.length ?? 0) + 1);
              const instance = instantiateS2CompositeDesign(documentRef.current, definition.plugins, chosenBlueprint.blueprint.id, chosenBlueprint.blueprint.version, { position: { x: offset, y: offset } }, openComposite ?? undefined);
              commit(instance.document); selectNodes(instance.nodeIds); setNotice('已添加独立组合副本；请为材料入口选用来源，再单独确认运行。');
            })}>添加到当前画布（不运行）</button>
            <button disabled={finished} onClick={() => act(() => { guardBlueprintAction(); if (blueprintKeyRef.current !== blueprintKey) throw new Error('版本已变化'); editBlueprintJson(exportS2CompositeDesign(chosenBlueprint)); })}>导出选用版本到下方</button>
            <button disabled={finished} onClick={() => act(() => { guardBlueprintAction(); if (blueprintKeyRef.current !== blueprintKey) throw new Error('版本已变化'); commit(removeS2CompositeDesign(documentRef.current, chosenBlueprint.blueprint.id, chosenBlueprint.blueprint.version)); setNotice('已从库中移除此版本，已有实例保留；可撤销本次设计修改。'); })}>从库中移除此版本（保留实例）</button>
            <details><summary>比较其他版本（只读）</summary>
              <p>比较库中的版本，不修改现有组合、不迁移参数、不运行。结构兼容不等于业务含义相同。</p>
              <label>比较目标版本<select value={compareVersions.some(entry => entryKey(entry) === compareVersion) ? compareVersion : ''} disabled={finished || !compareVersions.length} onChange={event => { compareVersionRef.current = event.target.value; setCompareVersion(event.target.value); setComparison(null); }}><option value="">{compareVersions.length ? '请选择同系列版本' : '请先保存同系列的另一版本'}</option>{compareVersions.map(entry => <option key={entryKey(entry)} value={entryKey(entry)}>{entry.blueprint.label} · {entry.blueprint.version}</option>)}</select></label>
              <button disabled={finished || !compareVersions.some(entry => entryKey(entry) === compareVersion)} onClick={() => act(() => {
                guardBlueprintAction();
                if (blueprintKeyRef.current !== blueprintKey || compareVersionRef.current !== compareVersion) throw new Error('比较版本已变化，请重新选择。');
                const target = compareVersions.find(entry => entryKey(entry) === compareVersion); if (!target) throw new Error('比较目标版本已不存在。');
                setComparison({ report: compareS2CompositeDesigns(chosenBlueprint, target, definition.plugins ?? []), base: JSON.stringify(document), scene: scene!, view: openComposite, source: entryKey(chosenBlueprint), target: compareVersion });
              })}>预览版本差异</button>
              {comparison && !comparisonCurrent && <p role="status">版本或画布已变化，原比较已过期，请重新预览。</p>}
              {comparison && comparisonCurrent && <section aria-label="蓝图版本差异" aria-live="polite">
                <h4>{comparison.report.from.version} → {comparison.report.to.version}</h4>
                <p>{comparison.report.interfaceCompatibility === 'breaking' ? '存在不兼容接口，不能直接沿用旧接线。' : '公共接口结构未发现不兼容变化，仍需核对业务用途。'}</p>
                {comparison.report.direction === 'downgrade' && <p>目标是较早版本；这不是自动升级建议。</p>}
                {!comparison.report.sceneCapabilitiesReady && <p>目标版本需要本场景尚未选装的能力：{comparison.report.missingCapabilities.map(cap => cap.label).join('、')}。本次没有改变能力范围。</p>}
                <p>名称／用途说明：{comparison.report.nameChanged || comparison.report.descriptionChanged ? '有变化' : '未变化'}；内部接线：{comparison.report.linksChanged ? '有变化' : '未变化'}；分层与成员：{comparison.report.hierarchyChanged ? '有变化' : '未变化'}。</p>
                <details open><summary>材料、输出与可调项变化（{comparison.report.changes.length}）</summary>{comparison.report.changes.length ? <ul>{comparison.report.changes.map(change => <li key={`${change.kind}:${change.id}`}>{change.kindLabel}「{change.label}」：{change.changes.join('；')}{change.breaking ? '（不兼容）' : change.review ? '（需核对）' : ''}</li>)}</ul> : <p>公共接口未变化。</p>}</details>
                <details><summary>内部步骤变化（{comparison.report.nodeChanges.length}）</summary>{comparison.report.nodeChanges.length ? <ul>{comparison.report.nodeChanges.map(change => <li key={change.id}>{change.label}：{change.changes.join('；')}</li>)}</ul> : <p>内部步骤未变化。</p>}</details>
                <p>可进入后续沿用检查的接口：{comparison.report.carryCandidates.map(item => item.label).join('、') || '无'}。这不是已提取或已迁移的实例参数。</p>
                {!!comparison.report.addedRequired.length && <p>新增或变为必填的内容：{comparison.report.addedRequired.map(item => item.label).join('、')}。</p>}
                {!!comparison.report.resourceInputs.length && <p>资料入口必须在本局重新核对选用与授权：{comparison.report.resourceInputs.map(item => item.label).join('、')}。</p>}
                <p>{comparison.report.note}</p>
              </section>}
            </details>
          </div>}
          <details><summary>蓝图导入／导出</summary><p>仅添加完整S2设计到库，不导入调用权限，不自动创建实例或升级已有组合。</p>
            <label>蓝图设计 JSON<textarea value={blueprintJson} disabled={finished} maxLength={128000} onChange={event => editBlueprintJson(event.target.value)} /></label>
            <button disabled={finished || !blueprintJson.trim()} onClick={() => act(() => { guardBlueprintAction(); if (blueprintJsonRef.current !== blueprintJson) throw new Error('导入文本已变化'); const design = importS2CompositeDesign(blueprintJson); commit(addS2CompositeDesign(documentRef.current, design)); setNotice('完整蓝图已加入本画布库；没有添加实例、运行或扩大权限。'); })}>检查并导入蓝图库</button>
          </details>
        </details>
        </details>
        </div><div hidden={workspacePanel !== "diagnostics"}>
        {developerDiagnostics && <section className="s2-resource-diagnostics" aria-label="本局资源授权诊断"><h3>本局资源授权诊断</h3>
          <p>只列本局授权摘要。选择资料请在对应节点操作；撤回会使引用该资料的后续读取失效，不删除画布配置。</p>
          {([...textResources.map(item => ({ ...item, kind: 'text' as const })), ...imageResources.map(item => ({ ...item, kind: 'image' as const })),
            ...projectNotes.map(item => ({ ...item, kind: 'note' as const }))]).map(resource => <p key={resource.id}>{resource.label}
              <button type="button" disabled={phase !== 'running'} onClick={() => act(() => {
                const host = pluginHost.current;
                if (!host || host !== displayedHost || sceneRef.current !== scene || phaseRef.current !== 'running') throw new Error('资源诊断操作已失效');
                if (resource.kind === 'text') host.revokeTextFile(resource.id); else if (resource.kind === 'image') host.revokeImageFile(resource.id); else host.revokeProjectNote(resource.id);
                refreshWorkflow(host); setNotice('已撤回该资料的本局授权；已有配置和历史保留。');
              })}>撤回授权</button></p>)}
          {!textResources.length && !imageResources.length && !projectNotes.length && <p>本局没有已允许的资料。</p>}
        </section>}
        {hasModelAccess && developerDiagnostics && <section ref={modelAuthorizationPanel} tabIndex={-1} className="s2-model-test" aria-label="模型测试授权与用量"><h3>模型测试 · 独立授权</h3>
          <p>画布装配不是模型授权。仅使用本局批准的固定模型；不注入笔记、画像或教学主持上下文，不自动重试或增加评审请求。保存模板不保存模型授权或预算。</p>
          {modelSummary && <><p role="status" aria-live="polite">{modelSummary.active ? '本局已批准' : '本局授权已关闭'}：{modelSummary.providerLabel} · {modelSummary.model}；已预留 {modelSummary.usedRequests}/{modelSummary.limits.maxRequests} 次，输出 {modelSummary.reservedOutputTokens}/{modelSummary.limits.maxReservedOutputTokens} tokens，单次最多 {modelSummary.limits.maxOutputTokens}。</p>
            {modelBudgetExhausted && <p role="status">本局预算不足一次完整模型请求，不能再发送；不会自动追加或重置。已有待核对请求可拒绝或取消所属运行，本地步骤和已获得结果仍保留。</p>}
            {!modelSummary.active && <p role="status">{modelSummary.closure?.message} 本局不能恢复授权或重置预算；需由你另开新局并重新授权，旧确认不恢复。</p>}
            <button disabled={!modelSummary.active || phase !== 'running'} onClick={() => act(() => { const host = pluginHost.current;
              if (!host || host !== displayedHost || phaseRef.current !== 'running' || sceneRef.current !== scene || !host.modelTestSummary()?.active
                || host.modelTestSummary()?.resourceId !== modelSummary.resourceId) throw new Error('模型授权操作已失效，未改变其他会话。');
              host.revokeModelTests(); refreshWorkflow(host); clearRuntimeProblem(); setNotice('模型授权已撤回，保留原用量与记录；本局不能重置预算。');
            })}>撤回模型测试权限</button>
            {!!modelSummary.records.length && <details><summary>模型测试记录（{modelSummary.records.length}）</summary>{modelSummary.records.map(record => <section key={record.id}><strong>{executionTitle(record.nodeId)} · {{ pending: '等待模型返回', succeeded: '已取得完整回复', failed: '未取得完整结果', cancelled: '已取消', 'timed-out': '已超时' }[record.status]}</strong>
              <p>{record.outputComplete ? '响应完整；不代表业务指标通过。' : '未取得可发布的完整结果，不传给下游。'} {record.error}</p>
              {record.output && <pre>{record.output}</pre>}{record.outputOmitted > 0 && <p>仅预览，另省略 {record.outputOmitted} 个字符；预览不是执行输入。</p>}
              <small>结束原因：{record.finishReason ?? '未知'}；实际输出用量：{record.usage?.completionTokens ?? '未知'} tokens</small>
            </section>)}</details>}</>}

        </section>}
        </div><div hidden={workspacePanel !== "more"}>
        <details><summary>多选与分组（{selection.length} 个已选）</summary><p>可用 Ctrl＋点击或框选选择节点。分组不改变执行规则；复制仅复制选区内部连线，保留未选中内容块的字段引用。</p>
          <label>分组名称<input value={groupLabel} maxLength={80} disabled={finished} onChange={e => setGroupLabel(e.target.value)} /></label>
          <button disabled={finished || !selection.length || !groupLabel.trim()} onClick={() => act(() => {
            if (phaseRef.current === 'finished' || sceneRef.current !== scene) throw new Error('分组操作已过期');
            finishDrag(); const host = pluginHost.current, ticket = host?.beginCanvasOperation();
            patch([{ op: 'set-group', group: { id: `group-${crypto.randomUUID()}`, label: groupLabel, nodeIds: selectionRef.current, collapsed: false } }]);
            if (ticket) host!.recordCanvasOperation(ticket, 'group', 'control');
          })}>把所选节点组成一组</button>
        </details>
        {document.groups?.map(group => <details key={group.id}><summary>{group.label}（{group.nodeIds.length} 个节点）</summary>
          <button disabled={finished} onClick={() => groupOperation(group, 'select', scene!)}>选择整组</button>
          <button disabled={finished} onClick={() => groupOperation(group, 'ungroup', scene!)}>解散组（保留节点） {group.label}</button>
        </details>)}
        </div><section hidden={workspacePanel !== "add"} aria-label="添加组件">
        {publicCatalog ? <div className="s2-component-menu" ref={libraryPanel} tabIndex={-1} aria-label="公开组件目录">
          {publicGroups?.map(group => <section key={group.id} role="region" aria-label={group.label}>
            <h3>{group.label}</h3><div className="s2-component-options">{group.componentIds.map(componentId => {
              const component = publicCatalog.components.find(item => item.id === componentId)!;
              return <button type="button" key={component.id} data-s2-component={component.id} disabled={finished || !!busy}
                title={component.purpose} onClick={() => act(() => addPublicComponent(component.id))}>{component.label}</button>;
            })}</div></section>)}
          {!publicCatalog.components.length && <p>此包未公开可搭建组件，可直接使用包内场景。</p>}
        </div> : <>
        {componentMenu && <h3>{componentMenu.contentLabel ?? '内容块'}</h3>}
        {definition.blockTypes.map(type => <button key={type.id} disabled={finished} onClick={() => act(() => patch([{ op: 'add-node', node: {
          id: `node-${crypto.randomUUID()}`, type: type.id, position: { x: 100 + document.nodes.length * 35, y: 120 + document.nodes.length * 25 },
          values: Object.fromEntries(type.fields.map(field => [field.id, s2DefaultFieldText(field)])),
        } }]))}>＋{type.label}</button>)}
        {componentMenu ? <div className="s2-component-menu" ref={libraryPanel} tabIndex={-1}>
          {phase === 'preview' && <small>添加后可直接编辑和接线。</small>}
          {componentGroups.map((group, index) => <section key={`${index}-${group.id}`} role="region" aria-label={group.label}>
            <h3>{group.label}</h3><div className="s2-component-options">{group.capabilities.map(cap => {
              const approved = allowedCapabilities.some(item => s2CapabilityKey(item) === s2CapabilityKey(cap));
              return <button type="button" key={s2CapabilityKey(cap)} data-s2-capability={s2CapabilityKey(cap)} disabled={finished || !!busy || phase !== 'preview' && !approved}
                title={phase !== 'preview' && !approved ? '本局未选择；可重新进入场景后添加' : s2NodeDescription(cap)} onClick={() => act(() => addCapability(cap))}>{s2NodeTitle(cap)}
                {phase !== 'preview' && !approved && <small>下次试验可添加</small>}</button>;
            })}</div></section>)}
          {!componentGroups.length && <p>当前包未提供可添加的处理组件。</p>}
        </div> : <details open={workspacePanel === "add"} ref={libraryDisclosure} className="s2-management" aria-label="添加处理步骤"><summary>添加处理步骤</summary>
        <h3 ref={libraryPanel} tabIndex={-1}>节点库与执行图</h3>
        <p>先了解用途，再选择添加。这里只列出本场景已允许的步骤；查看说明不会修改画布或发起调用。</p>
        <label>按用途浏览<select value={activeCategory} onChange={event => setLibraryCategory(event.target.value)}><option value="">全部用途</option>{categories.map(category => <option key={category} value={category}>{category}</option>)}</select></label>
        <label>搜索已选能力<input value={libraryQuery} maxLength={200} placeholder="例如：角色、表格、检查格式" onChange={e => setLibraryQuery(e.target.value)} /></label>
        {!filteredLibrary.length && <p role="status">{allowedCapabilities.length ? '没有匹配的已允许步骤。可清空搜索或切换“全部用途”；搜索不会增加能力或权限。' : '本场景尚未选择处理能力；可在开始前核对能力范围，不能靠搜索或帮助自动增加。'}</p>}
        <label>添加的执行能力<select value={chosenLibrary ? s2CapabilityKey(chosenLibrary) : ''} disabled={finished} onChange={e => setLibraryKey(e.target.value)}><option value="">请选择当前目录中的组件</option>{filteredLibrary.map(cap => <option key={s2CapabilityKey(cap)} value={s2CapabilityKey(cap)}>{s2NodeTitle(cap)}</option>)}</select></label>
        {chosenLibrary && pluginGuide(chosenLibrary, allowedCapabilities, '添加前了解这个步骤')}
        <button disabled={finished || !chosenLibrary} onClick={() => act(() => { if (chosenLibrary) addCapability(chosenLibrary); })}>添加执行节点</button>
        </details>}
        </>}
        </section><div hidden={workspacePanel !== "more"}>
        </div><div hidden={workspacePanel !== "diagnostics"}>
        {developerDiagnostics && pluginResults.length > 0 && <details><summary>本局插件记录（{pluginResults.length}）</summary><div className="s2-plugin-results" aria-live="polite">{pluginResults.map(item => <article key={item.receipt.id}>
          <p>执行：{item.receipt.status} · {item.receipt.publication === 'current' ? '当前结果' : '过期／结束，不用于当前判断'}</p>
          {item.receipt.error && <p>{item.receipt.error.message}</p>}
          {item.artifacts.map(artifact => <S2ArtifactView key={artifact.id} artifact={artifact} presentation="raw" />)}
        </article>)}</div></details>}

        </div><div hidden={workspacePanel !== "more"}>
        <details><summary>工作区导入／导出</summary><p>保存完整模板设计、内容、参数和两种连线，不包含本局授权、执行记录或对话。完整模板包含业务包和参考完成图，请勿作为无答案练习包分享；子图导出不含参考图。导入只允许在开始前替换预览，运行前重新确认范围；不是 ComfyUI 文件格式。</p>
          <button disabled={!!busy} onClick={() => act(() => setWorkspaceJson(exportS2Workspace(definition, documentRef.current, scene?.interactionPack, readOnlyBaseline.current?.document)))}>导出工作区 JSON 到下方</button>
          <label>工作区 JSON<textarea value={workspaceJson} maxLength={128000} onChange={e => setWorkspaceJson(e.target.value)} /></label>
          <button disabled={phase !== 'preview' || !!busy || !workspaceJson.trim()} onClick={() => void importWorkspace()}>导入并替换当前预览</button></details>
        <details><summary>可复用子图打包／粘贴</summary><p>导出选区内部连线，并携带引用的内容块；外部执行依赖变成未连接输入。粘贴会重映射所有 ID，不复制权限、缓存、凭据或 Agent 策略，不是新的不透明插件。</p>
          <button disabled={!selection.length || !!busy} onClick={() => act(() => setSubgraphJson(exportS2Subgraph(definition, documentRef.current, selectionRef.current)))}>导出所选子图到下方</button>
          <label>子图 JSON<textarea value={subgraphJson} maxLength={128000} onChange={e => setSubgraphJson(e.target.value)} /></label>
          <button disabled={finished || !!busy || !subgraphJson.trim()} onClick={() => act(() => {
            const imported = importS2Subgraph(subgraphJson, definition, documentRef.current); commit(imported.document); setSelected(imported.nodeIds[0]); selectNodes(imported.nodeIds);
            setNotice('已粘贴可编辑子图；外部输入需重新连接，未扩大本局能力范围。');
          })}>粘贴子图（保留当前画布）</button>
        </details>
        </div>
      </div></div><aside className="s2-sidebar" aria-label="Agent 聊天">
        <section className="s2-assistant-panel" aria-label="场景助手">
        <h3 ref={agentPanel} tabIndex={-1}>Agent</h3>

        {assistantBusy && <div className="s2-assistant-status" role="status">{assistantBusy}<button type="button" onClick={() => { stopAssistant(); setAssistantError('助手请求已停止，迟到回应不会应用；实验继续运行。'); }}>停止助手请求</button></div>}
        {assistantError && <p className="s2-error" role="alert">{assistantError}</p>}
        <div className="s2-messages" aria-live="polite">{messages.map((message, i) => <div key={i}><strong>{message.role === 'user' ? '你' : '助手'}</strong>{message.experiment && <small>{message.experiment}</small>}<p>{message.content}</p></div>)}</div>
        {proposal && <div className="s2-proposal"><p>{proposal.result.understanding}</p><p>{proposal.result.plan}</p>
          <details><summary>查看 {proposal.result.commands.length} 项修改</summary><pre>{JSON.stringify(proposal.result.commands, null, 2)}</pre></details>
          <button disabled={finished} onClick={() => {
            if (proposalRef.current !== proposal) {
              if (proposal.inputKey !== JSON.stringify(documentRef.current)) setError('画布已变化，建议已过期；请重新请求');
              return;
            }
            if (active.current || saving.current || phase !== 'running') return;
            act(() => {
              if (proposal.inputKey !== JSON.stringify(documentRef.current)) throw new Error('画布已变化，建议已过期；请重新请求');
              setProposal(null); patch(proposal.result.commands); setNotice('已确认并应用整批修改。');
            });
          }}>确认应用修改</button><button onClick={() => { if (proposalRef.current === proposal) setProposal(null); }}>放弃建议</button></div>}
        <label>向 Agent 提出要求<textarea value={query} maxLength={4000} disabled={phase === 'finished'} onChange={e => setQuery(e.target.value)}
          onKeyDown={event => {
            if (event.key !== 'Enter' || event.shiftKey || event.ctrlKey || event.metaKey || event.altKey || event.defaultPrevented
              || event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
            event.preventDefault();
            if (!event.repeat && !assistantBusy) void ask();
          }} title="Enter 发送，Shift+Enter 换行" placeholder="例如：解释这个结果；或明确委托助手保留原文、补充一个块" /></label>
        <button disabled={phase === 'finished' || !!assistantBusy || !query.trim()} onClick={() => void ask()}>发送</button>
        </section>
      </aside></div>
      {reading && <dialog ref={resultDialog} className="s2-result-dialog" aria-labelledby="s2-result-title" aria-describedby="s2-result-boundary"
        onCancel={event => { event.preventDefault(); setReading(null); }}>
        <header><div><h3 id="s2-result-title">{document.execution?.nodes.some(node => node.id === reading.nodeId) ? s2ConnectionNodeLabel(definition, document, reading.nodeId) : '处理步骤'} · {runLabel(reading.workflowId)}</h3>
          <p id="s2-result-boundary">只读阅读已有结果，不执行、不发送，也不代表业务评价通过。关闭后返回原操作，未应用草稿保留。</p></div>
          <button type="button" autoFocus onClick={() => setReading(null)}>关闭结果阅读</button></header>
        {!!(humanWaits.length + modelWaits.length) && <p role="status">另有 {humanWaits.length + modelWaits.length} 项填写或发送确认在等待；关闭阅读窗后处理，阅读不会代替确认。</p>}
        <div className="s2-result-content">{readingArtifacts.length ? readingArtifacts.map((artifact, index) => <section key={artifact.id} aria-label={`结果材料 ${index + 1}`}>
          <h4>结果材料 {index + 1}</h4><S2ArtifactView artifact={artifact} presentation={artifact.type.id === 'structured-data.value' ? 'reading' : 'typed'} complete onViewChange={recordView} onTreeToggle={recordTreeView} />
        </section>) : <p role="status">结果已过期、不可用或本局已结束；不继续展示为当前结果。请关闭后核对当前设计与运行，没有自动重跑。</p>}</div>
      </dialog>}
    </>}
  </section></S2CanvasDisplayBoundary>;
}
