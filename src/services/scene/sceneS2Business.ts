import type { S2CanvasDefinition, S2DesignBrief, S2Document } from '../../types/sceneS2';
import type { S2BusinessCapability, S2BusinessCriterion, S2BusinessPackage } from '../../types/sceneS2Business';
import type { S2Json } from '../../types/sceneS2Plugin';
import { s2BuiltinPluginRegistry, s2CapabilityKey, readS2PluginBindings } from './sceneS2PluginRegistry';
import { selectS2Execution } from './sceneS2Workflow';
import { readS2BusinessRule } from './sceneS2BusinessRule';
import { canonicalS2Json } from './sceneS2PluginProtocol';

const reserved = new Set(['__proto__', 'constructor', 'prototype']);
function fail(message: string): never { throw new Error(`S2 业务包：${message}`); }
function object(raw: unknown, allowed: string[]): Record<string, unknown> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) fail('需要对象');
  if (Object.keys(raw).some(key => reserved.has(key) || !allowed.includes(key))) fail(`存在未知字段；此层仅允许 ${allowed.join(', ')}`);
  return raw as Record<string, unknown>;
}
function text(raw: unknown, max = 1000): string {
  if (typeof raw !== 'string' || !raw.trim() || raw.length > max) fail(`文本必须为1–${max}字`);
  return raw as string;
}
function id(raw: unknown): string {
  const value = text(raw, 64);
  if (!/^[A-Za-z][A-Za-z0-9_-]*$/.test(value) || reserved.has(value)) fail('标识符无效');
  return value;
}
function array(raw: unknown, max: number): unknown[] {
  if (!Array.isArray(raw) || raw.length > max) fail(`列表最多${max}项`);
  return raw as unknown[];
}
function unique(values: string[], field: string) {
  if (new Set(values).size !== values.length) fail(`${field}不能重复`);
}
/** Bound every nested value BEFORE handing a reference document to the existing reader. */
function json(raw: unknown, maxBytes = 131072, maxDepth = 20, maxEntries = 12000): asserts raw is S2Json {
  let entries = 0;
  const seen = new Set<object>();
  const visit = (value: unknown, depth: number) => {
    if (++entries > maxEntries || depth > maxDepth) fail('嵌套或元素数量超过上限');
    if (value === null || typeof value === 'boolean' || typeof value === 'string') return;
    if (typeof value === 'number') { if (!Number.isFinite(value)) fail('只接受有限JSON数值'); return; }
    if (!value || typeof value !== 'object') fail('只接受完整JSON数据');
    if (seen.has(value as object)) fail('不接受循环数据');
    seen.add(value as object);
    if (Array.isArray(value)) value.forEach(item => visit(item, depth + 1));
    else {
      const proto = Object.getPrototypeOf(value);
      if (proto !== Object.prototype && proto !== null) fail('不接受原型对象');
      for (const [key, item] of Object.entries(value)) {
        if (reserved.has(key)) fail('不能包含原型保留字段');
        visit(item, depth + 1);
      }
    }
    seen.delete(value as object);
  };
  visit(raw, 0);
  if (new TextEncoder().encode(JSON.stringify(raw)).byteLength > maxBytes) fail('完整数据超过字节上限，不截断');
}
function criterion(raw: unknown, definition: S2CanvasDefinition, strictTargets: boolean): S2BusinessCriterion {
  const value = object(raw, ['id', 'label', 'expectation', 'method', 'required', 'target', 'rule']);
  if (!['local', 'semantic', 'advisory'].includes(value.method as string) || typeof value.required !== 'boolean') fail('评价需要合法method及布尔required');
  let target: S2BusinessCriterion['target'];
  if (value.target !== undefined) {
    const item = object(value.target, ['nodeId', 'fieldId', 'portId']);
    const hasField = Object.hasOwn(item, 'fieldId'), hasPort = Object.hasOwn(item, 'portId');
    if (hasField === hasPort) fail('评价target必须且只能选择fieldId或portId之一');
    target = { nodeId: id(item.nodeId), ...(hasField ? { fieldId: id(item.fieldId) } : { portId: id(item.portId) }) };
    if (strictTargets && hasField) {
      const node = definition.initial.nodes.find(node => node.id === target!.nodeId);
      if (!node || !Object.hasOwn(node.values, target.fieldId!)) fail('评价target必须是初始画布真实内容字段');
    }
    if (strictTargets && hasPort) {
      const node = definition.initial.execution?.nodes.find(node => node.id === target!.nodeId);
      const port = node && s2BuiltinPluginRegistry().capability(node).outputs.find(port => port.id === target!.portId);
      if (!port || port.multiple) fail('评价target.portId必须是初始画布真实执行节点的单值输出端口');
    }
  }
  if (value.method === 'local' && (!target || value.rule === undefined)) fail('local评价必须绑定真实内容字段或单值执行输出并提供rule');
  if (value.method !== 'local' && value.rule !== undefined) fail('只有local评价允许rule');
  if (value.method === 'advisory' && value.required) fail('开放建议不能设为必过指标');
  return { id: id(value.id), label: text(value.label, 200), expectation: text(value.expectation, 1000),
    method: value.method as S2BusinessCriterion['method'], required: value.required,
    ...(target ? { target } : {}), ...(value.rule !== undefined ? { rule: readS2BusinessRule(value.rule) } : {}) };
}

/** One shared criterion protocol for lightweight experiments and legacy business packages. */
export function readS2Criteria(raw: unknown, definition: S2CanvasDefinition, options: { strictTargets?: boolean } = {}): S2BusinessCriterion[] {
  json(raw);
  const criteria = array(raw, 6).map(item => criterion(item, definition, options.strictTargets !== false));
  unique(criteria.map(item => item.id), 'criteria.id');
  return criteria;
}

/** Never silently prefer one rubric when a template declares two conflicting versions. */
export function s2Criteria(definition: Pick<S2CanvasDefinition, 'criteria' | 'business'>): S2BusinessCriterion[] {
  const root = definition.criteria, legacy = definition.business?.criteria;
  if (root !== undefined && legacy !== undefined
    && canonicalS2Json(root as unknown as S2Json) !== canonicalS2Json(legacy as unknown as S2Json))
    fail('根criteria与旧business.criteria冲突，请明确保留同一套评价标准');
  return root ?? legacy ?? [];
}

/** Read-only feasibility witness. The callback avoids a Canvas -> Business -> Canvas import cycle. */
export function readS2BusinessPackage(raw: unknown, definition: S2CanvasDefinition,
  readDocument: (raw: unknown, definition: S2CanvasDefinition) => S2Document, brief?: S2DesignBrief,
  options: { strictTargets?: boolean } = {}): S2BusinessPackage {
  json(raw);
  const value = object(raw, ['version', 'purpose', 'knowledge', 'workflow', 'completion', 'criteria']);
  if (value.version !== 1) fail('不支持此业务包版本');
  const knowledge = array(value.knowledge, 8).map(raw => {
    const item = object(raw, ['id', 'title', 'content']);
    return { id: id(item.id), title: text(item.title, 200), content: text(item.content, 3000) };
  });
  unique(knowledge.map(item => item.id), 'knowledge.id');
  const approved = new Set(readS2PluginBindings(definition.plugins ?? []).map(s2CapabilityKey));
  const workflow = array(value.workflow, 12).map(raw => {
    const item = object(raw, ['id', 'goal', 'actor', 'capabilities', 'input', 'output']);
    if (!['user', 'agent', 'tool'].includes(item.actor as string)) fail('步骤actor必须为user、agent或tool');
    const capabilities = readS2PluginBindings(item.capabilities) as S2BusinessCapability[];
    if (capabilities.some(cap => !approved.has(s2CapabilityKey(cap)))) fail('业务步骤使用了场景未装配能力；业务说明不能扩大能力范围');
    if (item.actor === 'tool' && !capabilities.length) fail('tool步骤必须有真实已安装能力');
    return { id: id(item.id), goal: text(item.goal, 500), actor: item.actor as 'user' | 'agent' | 'tool', capabilities,
      input: text(item.input, 500), output: text(item.output, 500) };
  });
  if (!workflow.length) fail('至少需要一个业务步骤');
  unique(workflow.map(item => item.id), 'workflow.id');
  // Later learner edits may remove a rubric target; save/import must preserve that
  // rubric as uncertain instead of locking the canvas. Fresh assembly remains strict.
  const criteria = readS2Criteria(value.criteria, definition, options);
  const completion = object(value.completion, ['mode', 'reference', 'targetNodeIds', 'coverage']);
  if (!['execution', 'canvas'].includes(completion.mode as string)) fail('完成路径mode必须为execution或canvas');
  // Clone twice: a completion witness must never alias/mutate the learner's initial canvas.
  const reference = structuredClone(readDocument(structuredClone(completion.reference), definition));
  const execution = reference.execution?.nodes ?? [];
  const allNodes = new Set([...reference.nodes.map(node => node.id), ...execution.map(node => node.id)]);
  const targetNodeIds = array(completion.targetNodeIds, 40).map(id);
  unique(targetNodeIds, 'completion.targetNodeIds');
  if (!targetNodeIds.length || targetNodeIds.some(nodeId => !allNodes.has(nodeId))) fail('完成目标必须是真实参考节点，且至少一个');
  if (completion.mode === 'execution') {
    // Strictly preflight the WHOLE witness, not only a conveniently runnable subset.
    selectS2Execution(reference, definition.plugins);
    selectS2Execution(reference, definition.plugins, targetNodeIds);
  } else {
    if (execution.length || workflow.some(step => step.actor === 'tool' || step.capabilities.length)) fail('canvas完成路径仅证明手动内容编辑，不能据此声称工具执行');
    if (targetNodeIds.some(nodeId => !reference.nodes.some(node => node.id === nodeId && Object.keys(node.values).length))) fail('canvas完成目标必须有真实内容入口');
  }
  // Every claimed capability has a real typed node in the witness; prose is not an adapter.
  for (const step of workflow) for (const cap of step.capabilities) {
    if (!execution.some(node => s2CapabilityKey(node) === s2CapabilityKey(cap))) fail(`步骤${step.id}的能力未在完成路径实现`);
  }
  const coverage = array(completion.coverage, 12).map(raw => {
    const item = object(raw, ['requirementId', 'stepIds', 'nodeIds', 'evidencePaths']);
    const stepIds = array(item.stepIds, 12).map(id), nodeIds = array(item.nodeIds, 40).map(id);
    unique(stepIds, 'coverage.stepIds'); unique(nodeIds, 'coverage.nodeIds');
    if (!stepIds.length || stepIds.some(stepId => !workflow.some(step => step.id === stepId))) fail('需求覆盖必须指向真实业务步骤');
    const evidencePaths = item.evidencePaths === undefined ? undefined : array(item.evidencePaths, 8).map(raw => {
      const path = text(raw, 200);
      // Only real, public instructions or UI declarations. Neither an external/source
      // assertion, a goal restatement nor a private witness is policy evidence.
      if (!/^\/(?:instructions\/(?:understanding|planning|response)|blockTypes\/(?:0|[1-9]\d*)\/(?:label|fields\/(?:0|[1-9]\d*)\/label))$/.test(path))
        fail('非执行证据只能引用真实公开策略或控件名称字段');
      let current: unknown = definition;
      for (const part of path.slice(1).split('/')) {
        if (!current || typeof current !== 'object' || !Object.hasOwn(current, part)) fail('非执行证据字段不存在');
        current = (current as Record<string, unknown>)[part];
      }
      if (typeof current !== 'string' || !current.trim()) fail('非执行证据须为非空的真实文本字段');
      return path;
    });
    if (evidencePaths) unique(evidencePaths, 'coverage.evidencePaths');
    const toolResponsibility = stepIds.some(stepId => {
      const step = workflow.find(step => step.id === stepId)!;
      return step.actor === 'tool' || step.capabilities.length > 0;
    });
    if ((!nodeIds.length && (toolResponsibility || !evidencePaths?.length)) || nodeIds.some(nodeId => !allNodes.has(nodeId)))
      fail('工具需求覆盖必须指向真实参考节点；非工具职责可用真实公开策略或控件证据，不得虚构参考节点');
    for (const stepId of stepIds) for (const cap of workflow.find(step => step.id === stepId)!.capabilities) {
      if (!execution.some(node => nodeIds.includes(node.id) && s2CapabilityKey(node) === s2CapabilityKey(cap))) fail('覆盖节点未实现其业务步骤声称的能力');
    }
    return { requirementId: id(item.requirementId), stepIds, nodeIds, ...(evidencePaths !== undefined ? { evidencePaths } : {}) };
  });
  unique(coverage.map(item => item.requirementId), 'coverage.requirementId');
  if (!coverage.length || workflow.some(step => !coverage.some(item => item.stepIds.includes(step.id)))) fail('每个业务步骤都需有实际完成节点落点');
  if (brief) {
    const required = new Set(brief.requirements.map(item => item.id));
    if (coverage.length !== required.size || coverage.some(item => !required.has(item.requirementId))) fail('完成路径必须逐项覆盖原始需求，不能只展示方便完成的子集');
  }
  return { version: 1, purpose: text(value.purpose, 2000), knowledge, workflow,
    completion: { mode: completion.mode as 'execution' | 'canvas', reference, targetNodeIds, coverage }, criteria };
}

/** Learner-visible context. Never include the private reference, its node IDs, coverage, or local answer values. */
export function s2BusinessRuntimeContext(business: S2BusinessPackage, knowledgeIds: string[] = []) {
  const selected = array(knowledgeIds, 3).map(id); unique(selected, '知识选择');
  if (selected.some(id => !business.knowledge.some(item => item.id === id))) fail('选择的知识条目不存在');
  return { version: business.version, purpose: business.purpose,
    knowledgeIndex: business.knowledge.map(({ id, title, content }) => ({ id, title, chars: content.length })),
    knowledge: business.knowledge.filter(item => selected.includes(item.id)).map(item => ({ ...item })),
    workflow: business.workflow.map(step => ({ ...step, capabilities: step.capabilities.map(cap => ({ ...cap })) })),
    criteria: business.criteria.map(({ rule: _rule, ...item }) => ({ ...item, ...(item.target ? { target: { ...item.target } } : {}) })),
    completion: { mode: business.completion.mode, staticWitnessProvided: true, executed: false, businessSuccess: 'not-assessed' },
    authority: 'Guidance only; never permission, execution evidence, or a mandatory teaching sequence.' };
}

/** Fresh host facts for builder/reviewer only. Static schedulability does not prove business sufficiency. */
export function s2BusinessProtocolFacts(business: S2BusinessPackage, definition: S2CanvasDefinition) {
  const reference = business.completion.reference, registry = s2BuiltinPluginRegistry();
  const selected = business.completion.mode === 'execution' ? selectS2Execution(reference, definition.plugins) : undefined;
  return { origin: 'host-static-business-witness', executed: false, permissionGranted: false, businessSuccess: 'not-assessed',
    mode: business.completion.mode, protocolReady: true,
    referenceNodeCount: reference.nodes.length + (reference.execution?.nodes.length ?? 0),
    targetNodeIds: [...business.completion.targetNodeIds], order: selected?.order ?? [],
    coverage: structuredClone(business.completion.coverage),
    capabilities: (reference.execution?.nodes ?? []).map(node => ({ nodeId: node.id, pluginId: node.pluginId,
      pluginVersion: node.pluginVersion, capabilityId: node.capabilityId, kind: registry.capability(node).kind,
      simulationOnly: node.pluginId === 'workflow-simulation', requiresHumanInput: registry.capability(node).kind === 'human' })),
    scope: 'Typed completion witness only; Agent must still assess goal/role/tool semantic sufficiency. Simulation is not real business execution; human confirmation is not content validation.' };
}
