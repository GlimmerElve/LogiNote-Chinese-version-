import React from 'react';
import { Handle, Position, type NodeProps } from '@xyflow/react';
import type { S2Artifact, S2PluginCapability } from '../../types/sceneS2Plugin';
import { S2ArtifactView } from './S2ArtifactView';
import type { S2WorkflowCondition, S2WorkflowNode } from '../../types/sceneS2';
import { s2PortLabel, s2StatusLabel } from '../../services/scene/sceneS2Presentation';
import type { S2WorkflowRun } from '../../services/scene/sceneS2PluginHost';
import type { ScenePackPortAnchor, ScenePackViewPolicy } from '../../types/sceneInteractionPack';
import type { S2ArtifactViewSelection, S2JsonTreeSelection } from '../../services/scene/sceneS2Events';

export interface S2WorkflowNodeData extends Record<string, unknown> { title: string; referenceLabel?: string; description?: string; node?: S2WorkflowNode; nodeControls?: React.ReactNode; nodeView?: React.ReactNode; viewIdentity?: string; onNodeDoubleClick?: () => void; onViewError?: (message: string) => void; viewPolicy?: ScenePackViewPolicy; developerDiagnostics?: boolean; inputSources?: Record<string, string>; capability: S2PluginCapability; status: string; artifacts: S2Artifact[]; when?: S2WorkflowCondition; reason?: string; mergeEvidence?: S2WorkflowRun['nodes'][number]['mergeEvidence']; humanEvidence?: S2WorkflowRun['nodes'][number]['humanEvidence']; onOpenHumanInput?: () => void; onViewChange?: (artifactId: string, view: S2ArtifactViewSelection) => void; onTreeToggle?: (artifactId: string, view: S2JsonTreeSelection) => void }
export function s2WorkflowVisibleInputs(value: S2WorkflowNodeData) {
  return value.capability.inputs.filter(port => (!Array.isArray(value.publicInputs) || value.publicInputs.includes(port.id))
    && (value.developerDiagnostics || !value.viewPolicy?.visibleNodeInputs || value.viewPolicy.visibleNodeInputs.includes(port.id)));
}
export function s2WorkflowVisibleOutputs(value: S2WorkflowNodeData) {
  return value.capability.outputs.filter(port => !Array.isArray(value.publicOutputs) || value.publicOutputs.includes(port.id));
}
/** Geometry changes can require handle refresh even when the set of port IDs stays unchanged. */
export function s2WorkflowAnchorKey(value: S2WorkflowNodeData) {
  return JSON.stringify([s2WorkflowVisibleInputs(value).map(port => port.id), s2WorkflowVisibleOutputs(value).map(port => port.id),
    value.viewPolicy?.inputAnchors, value.viewPolicy?.outputAnchors, !!value.nodeView, !!value.when]);
}
function portHandle(port: S2PluginCapability['inputs'][number], direction: 'in' | 'out', anchor?: ScenePackPortAnchor) {
  const side = anchor?.side ?? (direction === 'in' ? 'left' : 'right');
  const style = anchor ? side === 'top' || side === 'bottom' ? { left: `${(anchor.offset ?? 0.5) * 100}%` } : { top: `${(anchor.offset ?? 0.5) * 100}%` } : undefined;
  return <Handle key={`${direction}:${port.id}`} type={direction === 'in' ? 'target' : 'source'} position={Position[side === 'top' ? 'Top' : side === 'bottom' ? 'Bottom' : side === 'left' ? 'Left' : 'Right']}
    id={`${direction}:${port.id}`} style={style} aria-label={`${direction === 'in' ? '输入' : '输出'}：${port.label}`} />;
}
class PackageNodeBoundary extends React.Component<{ children: React.ReactNode; fallback: React.ReactNode; resetKey: string }, { error?: string }> {
  state: { error?: string } = {};
  static getDerivedStateFromError(error: unknown) { return { error: `PACK_NODE_VIEW_ERROR: ${error instanceof Error ? error.message : String(error)}` }; }
  componentDidUpdate(previous: Readonly<{ resetKey: string }>) { if (this.state.error && previous.resetKey !== this.props.resetKey) this.setState({ error: undefined }); }
  render() {
    return this.state.error ? <><p className="s2-package-view-error" role="alert">{this.state.error}</p>{this.props.fallback}</> : this.props.children;
  }
}
export function S2WorkflowNodeView(props: NodeProps) {
  const value = props.data as S2WorkflowNodeData;
  const inputs = s2WorkflowVisibleInputs(value);
  const outputs = s2WorkflowVisibleOutputs(value);
  const inputLabel = (port: S2PluginCapability['inputs'][number]) => value.viewPolicy?.inputLabels?.[port.id] ?? s2PortLabel(value.node ?? {}, port, 'inputs');
  const showResult = value.developerDiagnostics || (value.viewPolicy?.showResult ?? !value.nodeView);
  const showStatus = value.developerDiagnostics || (value.viewPolicy?.showStatus ?? !value.nodeView);
  const doubleClick = value.onNodeDoubleClick ? (event: React.MouseEvent) => {
    if ((event.target as Element)?.closest?.('button,input,textarea,select,a,summary,.react-flow__handle,[contenteditable="true"]')) return;
    event.preventDefault(); event.stopPropagation();
    try { value.onNodeDoubleClick!(); } catch (error) { value.onViewError?.(`PACK_NODE_INTERACTION_ERROR: ${error instanceof Error ? error.message : String(error)}`); }
  } : undefined;
  const feedback = <>
    {(['waiting', 'failed', 'blocked', 'cancelled', 'unknown', 'stale'].includes(value.status) || showStatus && value.status === 'running') && <small>{s2StatusLabel(value.status)}</small>}
    {(value.viewPolicy?.annotation || !value.nodeView && value.capability.permissions.includes('model-call')) && <small className="s2-model-confirmation">{value.viewPolicy?.annotation ?? '使用本次明确操作提交模型请求'}</small>}
    {value.when && <small>仅在设定条件满足时运行</small>}
    {value.reason && <p>{value.reason}</p>}
    {typeof value.onInspectIssue === 'function' && <button type="button" className="nodrag nopan" onClick={event => { event.stopPropagation(); (value.onInspectIssue as () => void)(); }}>查看问题与处理方式</button>}
    {value.status === 'waiting' && value.onOpenHumanInput && <button type="button" className="nodrag nopan" onClick={event => { event.stopPropagation(); value.onOpenHumanInput!(); }}>{value.node?.capabilityId === 'confirm' ? '前往确认' : '前往填写'}</button>}
    {value.status === 'waiting' && typeof value.onOpenModelRequest === 'function' && <button type="button" className="nodrag nopan" onClick={event => { event.stopPropagation(); (value.onOpenModelRequest as () => void)(); }}>核对本次模型请求</button>}
    {value.humanEvidence && <small>用户输入已接收{value.humanEvidence.approved === undefined ? '' : value.humanEvidence.approved ? ' · 明确同意' : ' · 明确拒绝'}；不是插件执行或新增授权。</small>}
    {value.mergeEvidence && <small>互斥合流：{value.mergeEvidence.candidateArtifactIds.length} 路候选，跳过 {value.mergeEvidence.skippedNodeIds.length} 路
      {value.mergeEvidence.selectedArtifactId ? '；已选中唯一一份结果' : '；未选中'}{value.mergeEvidence.simulation ? '（仅模拟）' : ''}</small>}
    {value.capability.outputs.some(port => port.type.id === 'workflow-simulation.result') && <p className="s2-simulation-notice">仅模拟：记录预设示例，非真实业务执行</p>}
  </>;
  const interaction = !value.interactionInputInView && value.nodeInteractionInput as React.ReactNode;
  const fallbackResource = !value.nodeControls && value.nodeResourceInput as React.ReactNode;
  const controls = (value.nodeControls || interaction || fallbackResource) && <div className="s2-node-controls nodrag nopan nowheel" onClick={event => event.stopPropagation()}>{value.nodeControls}{fallbackResource}{interaction}</div>;
  const results = <>
    {showResult && typeof value.onReadResult === 'function' && value.artifacts.some(artifact => JSON.stringify(artifact.payload).length > 1500) && <button type="button" className="nodrag nopan" onClick={event => { event.stopPropagation(); (value.onReadResult as (opener: HTMLElement) => void)(event.currentTarget); }}>全屏阅读结果</button>}
    {value.developerDiagnostics && <details className="nodrag nopan s2-technical"><summary>技术详情</summary><p>{value.node ? `${value.node.pluginId} / ${value.node.capabilityId} @ ${value.node.pluginVersion}` : value.title}</p>
      {value.mergeEvidence && <pre>{JSON.stringify(value.mergeEvidence, null, 2)}</pre>}
      {value.when && <p>条件：{value.when.nodeId}.{value.when.portId} · {value.when.pointer || '整体'} {value.when.match ? '=' : '≠'} {JSON.stringify(value.when.equals).slice(0, 80)}{JSON.stringify(value.when.equals).length > 80 ? '…（预览）' : ''}</p>}
      {value.capability.inputs.map(port => <p key={`in-${port.id}`}>输入 {port.id} · {port.type.id}@{port.type.version}</p>)}
      {value.capability.outputs.map(port => <p key={`out-${port.id}`}>输出 {port.id} · {port.type.id}@{port.type.version}</p>)}
    </details>}
    {showResult && <div className="s2-node-result nodrag nopan nowheel" onClick={event => event.stopPropagation()}>{value.artifacts.filter(artifact => artifact.type.id !== 'core.image' || value.developerDiagnostics).map(artifact => value.capability.kind !== 'renderer' && artifact.type.id !== 'core.text'
      ? <details className="nodrag nopan" key={artifact.id}><summary>查看处理结果</summary><S2ArtifactView artifact={artifact} presentation="raw" onViewChange={value.onViewChange} onTreeToggle={value.onTreeToggle} /></details>
      : <S2ArtifactView key={artifact.id} artifact={artifact} presentation={value.capability.kind === 'renderer' ? 'typed' : 'raw'} onViewChange={value.onViewChange} onTreeToggle={value.onTreeToggle} />)}</div>}
  </>;
  const condition = value.when && <Handle type="target" position={Position.Top} id="condition" isConnectable={false} />;
  const fallback = <article className={`s2-block s2-workflow-node s2-node-${value.status}`} aria-label={`${value.title} · ${s2StatusLabel(value.status)}`} onDoubleClick={doubleClick}>
    <strong>{value.title}</strong>{value.developerDiagnostics && value.referenceLabel && <small>{value.referenceLabel}</small>}
    {value.developerDiagnostics && value.description && <p>{value.description}</p>}{feedback}{controls}{condition}
    {inputs.map(port => <div className="s2-input-port" key={port.id} title={value.inputSources?.[port.id]} aria-label={`${inputLabel(port)}：${value.inputSources?.[port.id] ?? '待提供材料'}`}>
      {!value.viewPolicy?.inputAnchors?.[port.id] && portHandle(port, 'in')}<span>{inputLabel(port)}</span>
      {value.viewPolicy?.inputActions?.[port.id] && <button type="button" className="s2-remove-input nodrag nopan" aria-label={value.viewPolicy.inputActions[port.id].label}
        onClick={event => { event.stopPropagation(); value.viewPolicy!.inputActions![port.id].run(); }}>×</button>}
      {value.developerDiagnostics && <small>{port.required ? '必需' : '可选'} · {value.inputSources?.[port.id] ?? '待提供材料'}</small>}</div>)}
    {value.viewPolicy?.addInput && <button type="button" className="nodrag nopan s2-add-input" disabled={value.viewPolicy.addInput.disabled}
      onClick={event => { event.stopPropagation(); value.viewPolicy!.addInput!.run(); }}>{value.viewPolicy.addInput.label}</button>}
    {outputs.map(port => <div className="s2-output-port" key={port.id}><span>{s2PortLabel(value.node ?? {}, port, 'outputs')}</span>
      {!value.viewPolicy?.outputAnchors?.[port.id] && portHandle(port, 'out')}</div>)}
    {inputs.filter(port => value.viewPolicy?.inputAnchors?.[port.id]).map(port => portHandle(port, 'in', value.viewPolicy!.inputAnchors![port.id]))}
    {outputs.filter(port => value.viewPolicy?.outputAnchors?.[port.id]).map(port => portHandle(port, 'out', value.viewPolicy!.outputAnchors![port.id]))}
    {results}
  </article>;
  if (!value.nodeView) return fallback;
  return <PackageNodeBoundary resetKey={JSON.stringify([value.viewIdentity, value.node])} fallback={<S2WorkflowNodeView {...props} data={{ ...value, nodeView: undefined, nodeControls: undefined, nodeResourceInput: value.resourceInputFallback, interactionInputInView: false }} />}>
    <article className={`s2-package-node s2-node-${value.status}`} aria-label={`${value.title} · ${s2StatusLabel(value.status)}`} onDoubleClick={doubleClick}>
      <div className="s2-package-node-body">{value.nodeView}{condition}
        {inputs.map((port, index) => portHandle(port, 'in', value.viewPolicy?.inputAnchors?.[port.id] ?? { side: 'left', offset: (index + 1) / (inputs.length + 1) }))}
        {outputs.map((port, index) => portHandle(port, 'out', value.viewPolicy?.outputAnchors?.[port.id] ?? { side: 'right', offset: (index + 1) / (outputs.length + 1) }))}
      </div>
      <div className="s2-package-node-feedback">{value.nodeResourceInput as React.ReactNode}{interaction}{feedback}{results}</div>
    </article>
  </PackageNodeBoundary>;
}
