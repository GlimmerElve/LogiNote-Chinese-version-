import type { ScenePackConfig, ScenePackHostServices, ScenePackIssue, SceneInteractionRuntime, ScenePackOperation } from '../../types/sceneInteractionPack';

/** Business validation only; the host still validates the S2 wire format and runtime inputs. */
export function validatePromptLab(config: ScenePackConfig): ScenePackIssue[] {
  const issues: ScenePackIssue[] = [];
  if (!config?.definition || config.definition.version !== 1 || !config.document || !Array.isArray(config.document.nodes) || !Array.isArray(config.document.edges))
    return [{ path: '/', message: '需要完整的S2画布定义和文档' }];
  const ids = new Set<string>();
  for (const [index, node] of [...config.document.nodes, ...(config.document.execution?.nodes ?? [])].entries()) {
    if (typeof node.id !== 'string' || ids.has(node.id)) issues.push({ path: `/nodes/${index}/id`, message: '组件ID缺失或重复' });
    ids.add(node.id);
  }
  for (const [index, link] of (config.document.execution?.links ?? []).entries()) {
    if (!ids.has(link.source.nodeId) || !ids.has(link.target.nodeId)) issues.push({ path: `/execution/links/${index}`, message: '连接引用了不存在的组件' });
  }
  // Missing experimental content is an editable blank, not a reason to refuse saving.
  return issues;
}

export function createPromptLabRuntime(config: ScenePackConfig, host: ScenePackHostServices): SceneInteractionRuntime {
  const check = (next: ScenePackConfig) => {
    const issues = validatePromptLab(next);
    if (issues.length) throw new Error(`INVALID_CONFIG: ${issues[0].path} ${issues[0].message}`);
    host.validateConfig(next);
  };
  check(config);
  let active = true;
  const owned = new Set<string>();
  const assertActive = () => { if (!active) throw new Error('PACK_CLOSED: 提示词实验已结束'); };
  const run: SceneInteractionRuntime['run'] = (targets, notify, options) => {
    assertActive(); const current = host.readConfig(); check(current);
    if (targets !== undefined && (!Array.isArray(targets) || !targets.length || targets.length > 40 || targets.some(id => typeof id !== 'string')))
      throw new Error('INVALID_CONFIG: 运行目标必须是明确的节点ID数组');
    // Both the local Test button and Agent run use this package policy. A test
    // also publishes its text to directly connected result views, without
    // starting unrelated downstream model capabilities.
    const selected = targets ? new Set(targets) : undefined;
    if (selected) {
      const nodes = new Map((current.document.execution?.nodes ?? []).map(node => [node.id, node]));
      for (const link of current.document.execution?.links ?? []) {
        const source = nodes.get(link.source.nodeId), target = nodes.get(link.target.nodeId);
        if (selected.has(link.source.nodeId) && source?.pluginId === 'model-test' && link.source.portId === 'text'
          && target?.pluginId === 'structured-view' && target.capabilityId === 'text') selected.add(target.id);
      }
    }
    const job = host.run(selected ? [...selected] : undefined, notify, options);
    owned.add(job.id);
    // Observe settlement without introducing an unhandled rejection or starting another run.
    void job.completion.then(() => owned.delete(job.id), () => owned.delete(job.id));
    return job;
  };
  return {
    updateConfig(next) { assertActive(); check(next); host.applyConfig(structuredClone(next)); },
    run,
    dispatch(operation: ScenePackOperation, input = {}, notify) {
      assertActive();
      switch (operation) {
        case 'readState': return structuredClone(host.readConfig());
        case 'readResult': return structuredClone(host.readResults());
        case 'run': return run(input.targets, notify, { force: input.force });
        case 'cancel':
          if (typeof input.runId !== 'string' || !owned.has(input.runId)) throw new Error('RUN_NOT_OWNED: 只能取消当前交互包启动的运行');
          host.cancel(input.runId); return;
        default: throw new Error('交互包不支持此操作');
      }
    },
    dispose() { if (!active) return; active = false; owned.clear(); host.close(); },
  };
}
