export interface S2BusinessDesignIssue {
  path: string;
  issue: string;
  code: 'misplaced-execution-node' | 'missing-reference-node' | 'missing-workflow-step' | 'uncovered-step-capability'
    | 'missing-requirement-coverage' | 'unknown-requirement-coverage' | 'duplicate-requirement-coverage'
    | 'empty-coverage-steps' | 'empty-coverage-nodes' | 'uncovered-workflow-step' | 'unsafe-diagnostic-input' | 'diagnostic-limit';
  requirementId?: string;
  relatedPaths?: string[];
  matchingReferenceNodeIds?: string[];
}

/** Bounded, read-only repair hints for a FULL unvalidated design candidate.
 * This deliberately is NOT a parser, validator, capability grant or execution
 * preflight. An empty issue list must never be treated as design acceptance.
 * Only named own data properties are inspected; no recursive JSON traversal. */
export function s2BusinessDesignIssues(rawCandidate: unknown, independentBrief?: unknown): S2BusinessDesignIssue[] {
  const issues: S2BusinessDesignIssue[] = [];
  const add = (item: S2BusinessDesignIssue) => { if (issues.length < 160) issues.push(item); };
  const plain = (raw: unknown): raw is Record<string, unknown> => !!raw && typeof raw === 'object' && !Array.isArray(raw)
    && [Object.prototype, null].includes(Object.getPrototypeOf(raw));
  const own = (raw: unknown, key: string, path: string): unknown => {
    if (!plain(raw)) return undefined;
    const descriptor = Object.getOwnPropertyDescriptor(raw, key);
    if (!descriptor) return undefined;
    if (!Object.hasOwn(descriptor, 'value')) {
      add({ path, code: 'unsafe-diagnostic-input', issue: '访问器字段未读取；请提供普通JSON数据。' }); return undefined;
    }
    return descriptor.value;
  };
  const list = (raw: unknown, max: number, path: string): Array<{ value: unknown; path: string }> => {
    if (raw === undefined) return [];
    if (!Array.isArray(raw) || Object.getPrototypeOf(raw) !== Array.prototype) {
      add({ path, code: 'unsafe-diagnostic-input', issue: '诊断只检查普通JSON列表，不遍历原型对象。' }); return [];
    }
    if (raw.length > max) add({ path, code: 'diagnostic-limit', issue: `仅检查前${max}项；其余未检查，不代表协议通过。` });
    const items: Array<{ value: unknown; path: string }> = [];
    for (let index = 0; index < Math.min(raw.length, max); index++) {
      const itemPath = `${path}/${index}`, descriptor = Object.getOwnPropertyDescriptor(raw, String(index));
      if (!descriptor || !Object.hasOwn(descriptor, 'value')) {
        add({ path: itemPath, code: 'unsafe-diagnostic-input', issue: '空项或访问器未读取；请提供普通JSON数据。' }); continue;
      }
      if (!plain(descriptor.value)) {
        add({ path: itemPath, code: 'unsafe-diagnostic-input', issue: '列表项必须是普通JSON对象；未递归遍历。' }); continue;
      }
      items.push({ value: descriptor.value, path: itemPath });
    }
    return items;
  };
  const scalarList = (raw: unknown, max: number, path: string, maxChars = 64): Array<{ value: string; path: string }> => {
    if (!Array.isArray(raw) || Object.getPrototypeOf(raw) !== Array.prototype) return [];
    if (raw.length > max) add({ path, code: 'diagnostic-limit', issue: `仅检查前${max}个引用，其余未检查。` });
    const result: Array<{ value: string; path: string }> = [];
    for (let index = 0; index < Math.min(raw.length, max); index++) {
      const itemPath = `${path}/${index}`, descriptor = Object.getOwnPropertyDescriptor(raw, String(index));
      if (!descriptor || !Object.hasOwn(descriptor, 'value')) {
        add({ path: itemPath, code: 'unsafe-diagnostic-input', issue: '引用访问器或空项未读取。' }); continue;
      }
      if (typeof descriptor.value === 'string' && descriptor.value.length <= maxChars) result.push({ value: descriptor.value, path: itemPath });
    }
    return result;
  };
  const identifier = (raw: unknown): raw is string => typeof raw === 'string' && /^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(raw)
    && !['__proto__', 'prototype', 'constructor'].includes(raw);
  const capability = (value: unknown, path: string): string | undefined => {
    const pluginId = own(value, 'pluginId', `${path}/pluginId`), version = own(value, 'pluginVersion', `${path}/pluginVersion`),
      capabilityId = own(value, 'capabilityId', `${path}/capabilityId`);
    return [pluginId, version, capabilityId].every(item => typeof item === 'string' && item.length > 0 && item.length <= 100)
      ? JSON.stringify([pluginId, version, capabilityId]) : undefined;
  };
  try {
    const business = own(rawCandidate, 'business', '/business');
    const completion = own(business, 'completion', '/business/completion');
    const reference = own(completion, 'reference', '/business/completion/reference');
    const content = list(own(reference, 'nodes', '/business/completion/reference/nodes'), 40, '/business/completion/reference/nodes');
    const execution = own(reference, 'execution', '/business/completion/reference/execution');
    const executed = list(own(execution, 'nodes', '/business/completion/reference/execution/nodes'), 40, '/business/completion/reference/execution/nodes');
    const contentIds = new Set<string>();
    for (const node of content) {
      const misplaced = ['pluginId', 'pluginVersion', 'capabilityId', 'bindings', 'when', 'inputs'].filter(key => {
        const descriptor = Object.getOwnPropertyDescriptor(node.value, key);
        return !!descriptor; // Presence alone is enough; never read an accessor.
      });
      if (misplaced.length) {
        add({ path: node.path, code: 'misplaced-execution-node', relatedPaths: misplaced.map(key => `${node.path}/${key}`),
          issue: `内容块列表混入执行字段${misplaced.join('、')}；执行节点应放在/business/completion/reference/execution/nodes，不能当作内容块或仅改为虚构块类型。` });
        continue;
      }
      const nodeId = own(node.value, 'id', `${node.path}/id`), type = own(node.value, 'type', `${node.path}/type`), values = own(node.value, 'values', `${node.path}/values`);
      if (identifier(nodeId) && identifier(type) && plain(values)) contentIds.add(nodeId);
    }
    const executionNodes = executed.flatMap(node => {
      const nodeId = own(node.value, 'id', `${node.path}/id`), key = capability(node.value, node.path);
      return identifier(nodeId) && key ? [{ id: nodeId, capability: key, path: node.path }] : [];
    });
    const realIds = new Set([...contentIds, ...executionNodes.map(node => node.id)]);
    const workflow = list(own(business, 'workflow', '/business/workflow'), 12, '/business/workflow').flatMap(step => {
      const stepId = own(step.value, 'id', `${step.path}/id`);
      if (!identifier(stepId)) return [];
      const capabilities = list(own(step.value, 'capabilities', `${step.path}/capabilities`), 16, `${step.path}/capabilities`)
        .flatMap(item => { const key = capability(item.value, item.path); return key ? [{ key, path: item.path }] : []; });
      const actor = own(step.value, 'actor', `${step.path}/actor`);
      return [{ id: stepId, path: step.path, capabilities, actor }];
    });
    const coverage = list(own(completion, 'coverage', '/business/completion/coverage'), 12, '/business/completion/coverage');
    // Read the host's independent brief, never a candidate-supplied designBrief.
    // Report these alongside graph errors, before fail-fast validation masks them.
    const required = list(own(independentBrief, 'requirements', '/designBrief/requirements'), 12, '/designBrief/requirements')
      .flatMap(item => {
        const id = own(item.value, 'id', `${item.path}/id`);
        return identifier(id) ? [{ id, path: `${item.path}/id` }] : [];
      });
    const requiredIds = new Set(required.map(item => item.id)), seen = new Set<string>();
    const coveredSteps = new Set<string>();
    for (const item of coverage) {
      const requirementId = own(item.value, 'requirementId', `${item.path}/requirementId`);
      if (identifier(requirementId)) {
        if (seen.has(requirementId)) add({ path: `${item.path}/requirementId`, code: 'duplicate-requirement-coverage', requirementId,
          issue: '同一需求只能有一条coverage，可在该条引用多个真实步骤和节点；不能以重复条目代替其他需求。' });
        seen.add(requirementId);
        if (independentBrief !== undefined && !requiredIds.has(requirementId)) add({ path: `${item.path}/requirementId`,
          code: 'unknown-requirement-coverage', requirementId, issue: '此ID不在宿主独立理解的需求中；不得修改designBrief或虚构新需求。' });
      }
      const nodes = scalarList(own(item.value, 'nodeIds', `${item.path}/nodeIds`), 40, `${item.path}/nodeIds`);
      const steps = scalarList(own(item.value, 'stepIds', `${item.path}/stepIds`), 12, `${item.path}/stepIds`);
      if (!steps.length) add({ path: `${item.path}/stepIds`, code: 'empty-coverage-steps',
        issue: '覆盖对应缺少有效业务步骤ID；用户编辑、解释或权限策略也须有真实职责步骤，不必虚构工具调用。自行核对已有步骤或补齐设计，不能用空列表声称覆盖。' });
      const policyPaths = scalarList(own(item.value, 'evidencePaths', `${item.path}/evidencePaths`), 8, `${item.path}/evidencePaths`, 200);
      const nonTool = steps.length > 0 && steps.every(step => {
        const declared = workflow.find(item => item.id === step.value);
        return declared && ['user', 'agent'].includes(declared.actor as string) && !declared.capabilities.length;
      });
      if (!nodes.length && !(nonTool && policyPaths.length)) add({ path: `${item.path}/nodeIds`, code: 'empty-coverage-nodes',
        issue: '工具职责须引用真实参考节点。非工具的用户操作/界面/交流策略可保留nodeIds:[]并用evidencePaths引用真实公开instructions或blockTypes名称字段；证据是否合法、是否充分仍须完整校验和语义审查。' });
      for (const node of nodes) if (!realIds.has(node.value)) add({ path: node.path, code: 'missing-reference-node',
        issue: `引用的节点${node.value}未在参考图的真实内容块或execution.nodes中声明；不能仅在coverage中虚构节点。非工具的界面/交流要求可改用真实公开策略或控件evidencePaths，不能复制无关节点充数。` });
      for (const step of steps) {
        coveredSteps.add(step.value);
        const declared = workflow.find(item => item.id === step.value);
        if (!declared) {
          add({ path: step.path, code: 'missing-workflow-step', issue: `引用的业务步骤${step.value}未在/business/workflow中声明。` }); continue;
        }
        for (const cap of declared.capabilities) {
          const matching = executionNodes.filter(node => node.capability === cap.key);
          if (!matching.some(node => nodes.some(item => item.value === node.id))) add({ path: `${item.path}/nodeIds`,
            code: 'uncovered-step-capability', relatedPaths: [step.path, cap.path], matchingReferenceNodeIds: matching.map(node => node.id),
            issue: matching.length ? `同条coverage引用步骤${step.value}，但nodeIds未包含实现该步骤能力的参考执行节点；请核对真实能力对应关系，不能只改描述。`
              : `同条coverage引用步骤${step.value}，但参考execution.nodes中没有实现其声明能力的节点；请修复实际装配或步骤能力，不能只添加虚构nodeId。` });
        }
      }
    }
    for (const step of workflow) if (!coveredSteps.has(step.id)) add({ path: '/business/completion/coverage',
      code: 'uncovered-workflow-step', relatedPaths: [`${step.path}/id`],
      issue: `业务步骤${step.id}未在任何需求覆盖对应中出现；核对其是否确属原需求及真实完成路径，不为凑数增加无关步骤。` });
    for (const requirement of required) if (!seen.has(requirement.id)) add({ path: '/business/completion/coverage',
      code: 'missing-requirement-coverage', requirementId: requirement.id, relatedPaths: [requirement.path],
      issue: '缺少此独立需求的覆盖对应。对照完整designBrief自主设计职责：工具任务用真实步骤和参考节点；界面/解释等非工具职责可引用真实公开策略或控件evidencePaths，不必伪装成工具执行。结构引用齐全不等于语义已满足，仍需独立审查。' });
  } catch {
    // Defensive boundary for hostile/non-JSON reflection traps; no repair or
    // acceptance is inferred from a partially inspected object.
    add({ path: '/business', code: 'unsafe-diagnostic-input', issue: '输入不是可安全检查的普通JSON；诊断未完成，不代表协议通过。' });
  }
  return issues;
}
