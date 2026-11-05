import type { S2Json, S2PluginNode } from '../src/types/sceneS2Plugin';
import { recordsToS2Table } from '../src/services/scene/sceneS2Structured';

/** Synthetic complete inputs shared by dispatch and lifecycle checks; never user resources. */
export const s2AdapterRecords: S2Json = [
  { name: '<script>never run</script>', score: 0, enabled: false, nullable: null }, { name: '缺失' },
];
export const s2AdapterSimulation: S2Json = { mode: 'simulation-only', steps: [
  { purpose: '模拟收集', assumptions: '示例未经业务验证', input: { count: 0 }, output: { approved: false } },
] };
export const s2LocalAdapterSamples: Record<string, Record<string, S2Json[]>> = {
  'json-check/validate': { text: ['{"ok":false}'] },
  'structured-data/parse-json': { text: [JSON.stringify(s2AdapterRecords)] },
  'structured-data/select': { value: [{ items: [false, 0, null] }], pointer: ['/items/0'] },
  'structured-data/stringify': { value: [{ count: 0, enabled: false, missing: null }] },
  'structured-data/to-table': { value: [s2AdapterRecords] },
  'structured-data/table-to-json': { table: [recordsToS2Table(s2AdapterRecords) as unknown as S2Json] },
  'workflow-simulation/step': { purpose: ['仅模拟'], assumptions: ['预设示例，不是实际执行'],
    sample: [{ result: false }], input: [{ count: 0 }], previous: [] },
  'workflow-merge/merge-json': { candidates: [{ retained: false }] },
  'workflow-merge/merge-assessment': { candidates: [{ status: 'unknown', reason: '只检查协议，不代表业务成功', evidence: [] }] },
  'workflow-merge/merge-simulation': { candidates: [s2AdapterSimulation] },
  'text-template/bind': { key: ['role'], value: ['场景讲解员'], variables: [] },
  'text-template/compose': { part1: ['原文甲 {{literal}}'], part3: ['原文乙 $&'], prefixes: [['第一段：', '', '第三段：']], separator: ['\n'] },
  'text-template/render': { template: ['角色：{{role}}'], variables: [{ role: '场景讲解员' }] },
};
export interface S2LocalAdapterFixture {
  binding: Omit<S2PluginNode, 'id'>;
  inputs: Record<string, S2Json[]>;
}
