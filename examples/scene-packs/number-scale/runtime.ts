import type { ScenePackConfig, ScenePackHostServices, SceneInteractionRuntime } from '../../../src/types/sceneInteractionPack';
import { amountAllowed, factorAllowed, labelAllowed, isScaleNode } from './plugins/scale';

/** Business validation of current configuration; dynamic inputs are checked again by the operation after resolution. */
export function validate(config: ScenePackConfig) {
  const issues: Array<{ path: string; message: string }> = [];
  const graph = config?.document?.execution;
  if (!graph || !Array.isArray(graph.nodes) || !Array.isArray(graph.links)) return [{ path: '/document/execution', message: '需要完整执行图' }];
  const nodes = graph.nodes.filter(isScaleNode);
  if (!nodes.length) return [{ path: '/document/execution/nodes', message: '至少需要一个数值缩放节点' }];
  for (const node of nodes) {
    const issue = (portId: string, message: string) => issues.push({ path: `/document/execution/nodes/${node.id}/bindings/${portId}`, message });
    for (const [id, allowed, rule] of [['amount', amountAllowed, '数值须为 0 至 1000000'], ['factor', factorAllowed, '倍数须大于 0 且不超过 100']] as const) {
      const binding = node.bindings[id], linked = graph.links.some(link => link.target.nodeId === node.id && link.target.portId === id);
      if (binding?.kind === 'literal') { if (!allowed(binding.value)) issue(id, rule); }
      else if (!linked) issue(id, '请选择真实数值来源或填写数值 literal');
    }
    const label = node.bindings.label;
    if (label?.kind === 'literal' && !labelAllowed(label.value)) issue('label', '名称最多 80 字');
    if (label?.kind === 'field') {
      const value = config.document.nodes.find(block => block.id === label.nodeId)?.values[label.fieldId];
      if (!labelAllowed(value)) issue('label', '名称字段不存在或超过 80 字');
    }
  }
  return issues;
}

export function createRuntime(config: ScenePackConfig, host: ScenePackHostServices): SceneInteractionRuntime {
  let active = true;
  const owned = new Set<string>();
  const assertActive = () => { if (!active) throw new Error('PACK_CLOSED: 数值缩放实例已关闭'); };
  const check = (next: ScenePackConfig) => {
    host.validateConfig(next); // Structural format and fixed-content rules belong to the terminal.
    const issues = validate(next);
    if (issues.length) throw new Error(`INVALID_CONFIG: ${issues[0].path} ${issues[0].message}`);
  };
  check(config);
  const run: SceneInteractionRuntime['run'] = (targets, notify, options) => {
    assertActive(); check(host.readConfig()); // Read current state, never the first configuration snapshot.
    const job = host.run(targets, notify, options);
    owned.add(job.id);
    void job.completion.then(() => owned.delete(job.id), () => owned.delete(job.id));
    return job;
  };
  return {
    run,
    updateConfig(next) {
      assertActive(); check(next);
      // Production canvas editing uses view callbacks. Only embedding hosts with an apply callback allow this method.
      host.applyConfig(structuredClone(next));
    },
    dispatch(operation, input = {}, notify) {
      assertActive();
      if (operation === 'readState') return host.readConfig();
      if (operation === 'readResult') return host.readResults();
      if (operation === 'run') return run(input.targets, notify, { force: input.force });
      if (operation === 'cancel') {
        if (typeof input.runId !== 'string' || !owned.has(input.runId)) throw new Error('RUN_NOT_OWNED: 只能取消本实例尚未结束的运行');
        host.cancel(input.runId); return;
      }
      throw new Error('UNKNOWN_OPERATION: 此包未实现该操作');
    },
    dispose() { if (active) { active = false; owned.clear(); host.close(); } },
  };
}
