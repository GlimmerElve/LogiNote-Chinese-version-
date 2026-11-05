import type { ScenePackConfig, ScenePackHostServices, SceneInteractionRuntime } from '../../../src/types/sceneInteractionPack';
import { readFaultTreeModel } from './model';
export const validate = (config: ScenePackConfig) => readFaultTreeModel(config.document).issues.map(({ path, message }) => ({ path, message }));
export function createRuntime(config: ScenePackConfig, host: ScenePackHostServices): SceneInteractionRuntime {
  let active = true;
  const guard = () => { if (!active) throw new Error('PACK_CLOSED: 事故树实例已关闭'); };
  const check = (next: ScenePackConfig) => { host.validateConfig(next); const issue = validate(next)[0]; if (issue) throw new Error(`INVALID_CONFIG: ${issue.path} ${issue.message}`); };
  check(config);
  const run: SceneInteractionRuntime['run'] = () => { guard(); throw new Error('PACK_EXECUTION_DISABLED: 事故树包仅做结构建模，编辑和保存直接生效'); };
  return { run, updateConfig(next) { guard(); check(next); host.applyConfig(structuredClone(next)); },
    dispatch(operation, input = {}, notify) {
      guard();
      if (operation === 'readState') return host.readConfig();
      if (operation === 'readModel') return readFaultTreeModel(host.readConfig().document);
      if (operation === 'readResult') return host.readResults();
      if (operation === 'run') return run(input.targets, notify, { force: input.force });
      if (operation === 'cancel') throw new Error('RUN_NOT_OWNED: 本包没有活动运行');
      throw new Error('UNKNOWN_OPERATION: 未实现该事故树操作');
    }, dispose() { if (active) { active = false; host.close(); } } };
}
