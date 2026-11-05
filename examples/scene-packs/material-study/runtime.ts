import type { SceneInteractionRuntime, ScenePackConfig, ScenePackHostServices } from '../../../src/types/sceneInteractionPack';
import { factorAllowed, isStudyNode } from './plugins/study';

export function validate(config: ScenePackConfig) {
  const graph = config.document.execution, nodes = graph?.nodes.filter(isStudyNode) ?? [];
  if (!nodes.length) return [{ path: '/document/execution/nodes', message: '至少需要一个学习物料汇总节点' }];
  return nodes.flatMap(node => {
    const binding = node.bindings.factor, linked = graph!.links.some(link => link.target.nodeId === node.id && link.target.portId === 'factor');
    return binding?.kind === 'literal' ? factorAllowed(binding.value) ? [] : [{ path: `/document/execution/nodes/${node.id}/bindings/factor`, message: '倍数须大于 0 且不超过 2' }]
      : linked ? [] : [{ path: `/document/execution/nodes/${node.id}/bindings/factor`, message: '请提供真实数值来源或 literal 倍数' }];
  });
}

export function createRuntime(config: ScenePackConfig, host: ScenePackHostServices): SceneInteractionRuntime {
  let active = true; const owned = new Set<string>();
  const guard = () => { if (!active) throw new Error('PACK_CLOSED: 物料场景实例已关闭'); };
  const check = (next: ScenePackConfig) => { host.validateConfig(next); const issues = validate(next); if (issues.length) throw new Error(`INVALID_CONFIG: ${issues[0].message}`); };
  check(config);
  const run: SceneInteractionRuntime['run'] = (targets, notify, options) => {
    guard(); check(host.readConfig());
    if (!host.materials) throw new Error('MATERIALS_UNAVAILABLE: 当前场景没有本包物料作用域');
    const job = host.run(targets, notify, options); owned.add(job.id);
    void job.completion.then(() => owned.delete(job.id), () => owned.delete(job.id)); return job;
  };
  return { run, updateConfig(next) { guard(); check(next); host.applyConfig(structuredClone(next)); },
    dispatch(operation, input = {}, notify) {
      guard();
      if (operation === 'readState') return host.readConfig();
      if (operation === 'readResult') return host.readResults();
      if (operation === 'run') return run(input.targets, notify, { force: input.force });
      if (operation === 'cancel') { if (!input.runId || !owned.has(input.runId)) throw new Error('RUN_NOT_OWNED'); host.cancel(input.runId); return; }
      throw new Error('UNKNOWN_OPERATION');
    },
    dispose() { if (active) { active = false; owned.clear(); host.close(); } },
  };
}
