import type { S2PluginHost } from './sceneS2PluginHost';
import { isInstalledS2ModelSession } from './sceneS2PluginRegistry';
import { bindS2ArtifactContext, readS2ContextArtifact, readS2ContextEvent, readS2ContextTrial, readS2ContextOutputIds,
  createS2AssessmentArtifactScope, resolveS2AssessmentOutput } from './sceneS2ArtifactAccess';

/** Read-only evidence for one requested analysis. Editing the canvas must not
 * invalidate the already-completed experiment or give it access to newer data.
 * Only entries readable through the original host-issued context are copied. */
export function snapshotS2AssistantContext(source: ReturnType<S2PluginHost['prepare']>, signal: AbortSignal) {
  const check = () => { if (signal.aborted) throw new DOMException('本次助手分析已关闭或结束', 'AbortError'); };
  check();
  const event = source.frame.event;
  const run = event.kind === 'workflow-completed' ? source.executionRuns.find(item => item.id === event.workflowRunId) : undefined;
  if (event.kind === 'workflow-completed' && (!run || run.revision !== source.frame.revision || run.publication !== 'current')) throw new Error('本次分析的实验轮次已失效');
  const invocationIds = new Set(run?.nodes.flatMap(node => node.invocationId ? [node.invocationId] : []) ?? (event.invocationId ? [event.invocationId] : []));
  const selectedTrials = source.trialIndex.filter(item => invocationIds.has(item.id)).sort((left, right) =>
    Number(isInstalledS2ModelSession(right.capability)) - Number(isInstalledS2ModelSession(left.capability)) || right.sequence - left.sequence);
  const modelInvocationIds = new Set(selectedTrials.filter(item => isInstalledS2ModelSession(item.capability)).map(item => item.id));
  // Result first, never spend the three-artifact pool on input fields before
  // preserving the model response the user actually asked to understand.
  const artifactIds = [...new Set([
    ...source.frame.observations.filter(item => modelInvocationIds.has(item.invocationId)).flatMap(item => item.artifacts.map(artifact => artifact.id)),
    ...(run?.nodes.filter(node => run.targets.includes(node.nodeId)).flatMap(node => node.artifactIds) ?? []),
    ...(run?.nodes.slice().reverse().flatMap(node => node.artifactIds) ?? []),
    ...source.frame.observations.filter(item => invocationIds.has(item.invocationId)).flatMap(item => item.artifacts.map(artifact => artifact.id)),
    ...source.bindings.map(item => item.artifactId),
  ])];
  const context = { ...structuredClone(source), assistantEvidence: {
    readonly: true as const, revision: source.frame.revision, workflowRunId: run?.id,
    imageContentsProvided: false as const, imageInputCount: 0,
    note: '只读的特定实验快照；完整正文仍按原有提取额度按需提供，超限或缺失不能从预览补全。core.image仅为本局图片句柄和类型，不含原图像素；即使complete=true也不表示助手看过图片。只能分析文字与返回，涉及图像内容的判断必须说明无法核实，不额外发送图片或重新测试。',
  } };
  const artifacts = new Map<string, ReturnType<typeof readS2ContextArtifact>['artifact']>();
  const trials = new Map<string, ReturnType<typeof readS2ContextTrial>>();
  const events = new Map<string, ReturnType<typeof readS2ContextEvent>>();
  let artifactChars = 0, trialChars = 0;
  for (const id of artifactIds.filter(id => source.frame.availableArtifactIds.includes(id))) {
    if (artifacts.size >= 3) break;
    try {
      const body = readS2ContextArtifact(source, id);
      if (artifactChars + body.text.length > 10000) continue;
      artifacts.set(id, body.artifact); artifactChars += body.text.length;
    } catch { /* Preserve unavailable evidence as unavailable. */ }
  }
  for (const item of selectedTrials) {
    if (trials.size >= 2) break;
    try {
      const trial = readS2ContextTrial(source, item.id), chars = JSON.stringify(trial).length;
      if (trialChars + chars > 20000) continue;
      trials.set(item.id, trial); trialChars += chars;
    } catch { /* No authority is manufactured from an index. */ }
  }
  const imageIds = new Set([...trials.values()].flatMap(trial => Object.values(trial.inputs).flat()
    .filter(value => value.type.id === 'core.image').map(value => value.artifactId)));
  context.assistantEvidence.imageInputCount = imageIds.size;
  const interaction = source.interactions;
  let eventChars = 0;
  for (const item of [...interaction.recentEvents, ...interaction.fieldStates, ...interaction.controlStates].filter(item => item.revision === source.frame.revision).slice(-4)) {
    if (events.has(item.id)) continue;
    try {
      const event = readS2ContextEvent(source, item.id), chars = JSON.stringify(event).length;
      if (artifactChars + eventChars + chars > 10000) continue;
      events.set(item.id, event); eventChars += chars;
    } catch { /* Inaccessible/omitted bodies remain inaccessible. */ }
  }
  // Port identity comes from the original host reader, never from the mutable
  // JSON index exposed beside this snapshot. A clone cannot forge this mapping.
  const outputIds = new Map<string, string[]>(), outputGroups = new Map<string, string[]>(), artifactScope = createS2AssessmentArtifactScope(source, [...artifacts.keys()]);
  for (const item of source.outputIndex) {
    const output = resolveS2AssessmentOutput(artifactScope, item.nodeId, item.portId);
    if (output && artifacts.has(output.artifact.id)) outputIds.set(JSON.stringify([item.nodeId, item.portId]), [output.artifact.id]);
    try { outputGroups.set(JSON.stringify([item.nodeId, item.portId]), readS2ContextOutputIds(source, item.nodeId, item.portId).filter(id => artifacts.has(id))); }
    catch { /* A clone has no host-owned port membership. */ }
  }
  bindS2ArtifactContext(context, {
    read: id => {
      check();
      const artifact = artifacts.get(id);
      if (!artifact) throw new Error('本次实验未提供该完整产物，不能使用新画布或预览替代');
      return structuredClone(artifact);
    },
    output: (nodeId, portId) => { check(); return [...(outputIds.get(JSON.stringify([nodeId, portId])) ?? [])]; },
    outputs: (nodeId, portId) => { check(); return [...(outputGroups.get(JSON.stringify([nodeId, portId])) ?? [])]; },
    trial: id => {
      check();
      const trial = trials.get(id);
      if (!trial) throw new Error('本次分析未提供该完整试验档案');
      return structuredClone(trial);
    },
    event: id => {
      check();
      const event = events.get(id);
      if (!event) throw new Error('本次分析未提供该完整操作记录');
      return structuredClone(event);
    },
  });
  return context;
}
