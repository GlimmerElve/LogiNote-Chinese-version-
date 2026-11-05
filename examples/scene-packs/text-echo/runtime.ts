import type { ScenePackConfig, ScenePackHostServices, SceneInteractionRuntime } from '../../../src/types/sceneInteractionPack';
import { isEcho, textAllowed } from './plugins/echo';

export function validate(config: ScenePackConfig) {
  return (config.document.execution?.nodes ?? []).filter(isEcho).flatMap(node => {
    const binding = node.bindings.text;
    return binding?.kind === 'literal' && textAllowed(binding.value) ? []
      : [{ path: `/document/execution/nodes/${node.id}/bindings/text`, message: '回显文字须为不超过2000字符的字面量' }];
  });
}

export function createRuntime(config: ScenePackConfig, host: ScenePackHostServices): SceneInteractionRuntime {
  let closed = false;
  const owned = new Set<string>();
  const guard = () => { if (closed) throw new Error('PACK_CLOSED: 文字回显实例已关闭'); };
  const check = (current: ScenePackConfig) => {
    host.validateConfig(current);
    const issue = validate(current)[0];
    if (issue) throw new Error(`INVALID_CONFIG: ${issue.path} ${issue.message}`);
  };
  check(config);
  const run: SceneInteractionRuntime['run'] = (targets, notify, options) => {
    guard(); check(host.readConfig());
    const job = host.run(targets, notify, options);
    owned.add(job.id);
    void job.completion.then(() => owned.delete(job.id), () => owned.delete(job.id));
    return job;
  };
  return {
    run,
    updateConfig(current) { guard(); check(current); host.applyConfig(structuredClone(current)); },
    dispatch(operation, input = {}, notify) {
      guard();
      if (operation === 'readState') return host.readConfig();
      if (operation === 'readResult') return host.readResults();
      if (operation === 'run') return run(input.targets, notify, { force: input.force });
      if (operation === 'cancel') {
        if (typeof input.runId !== 'string' || !owned.has(input.runId)) throw new Error('RUN_NOT_OWNED: 只能取消本实例的活动任务');
        host.cancel(input.runId); return;
      }
      throw new Error('UNKNOWN_OPERATION: 未提供此操作');
    },
    dispose() { if (!closed) { closed = true; owned.clear(); host.close(); } },
  };
}
