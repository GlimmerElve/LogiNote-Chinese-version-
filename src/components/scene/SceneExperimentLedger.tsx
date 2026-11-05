import React from 'react';
import type { SceneExperimentRecord } from '../../types';

/** Raw text stays text: model output cannot inject controls, links or judge instructions. */
export const SceneExperimentLedger: React.FC<{ records: SceneExperimentRecord[] }> = ({ records }) => (
  <section aria-label="实际模型实验记录">
    <div className="scene-side-title">实际模型实验记录 · {records.length}</div>
    {!records.length && <p className="scene-side-empty">尚未执行实验；对话中的草稿或建议不代表已经运行。</p>}
    {records.map(record => <details key={record.id} className="scene-context-item">
      <summary>{record.id} · {record.status === 'complete' ? '已运行并评估' : '未完整完成'}</summary>
      <p>{record.model} · temperature {record.temperature} · 输出上限 {record.maxOutputTokens} tokens</p>
      <p>期望格式：{record.outputFormat}；合法 JSON 对象：{record.formatValid === undefined ? '未要求' : record.formatValid ? '是（不代表内容合格）' : '否'}</p>
      <details><summary>实际提示词与测试输入</summary><pre style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{record.prompt + '\n\n输入：\n' + record.input}</pre></details>
      <details open><summary>原始返回结果</summary><pre style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', maxHeight: 320, overflow: 'auto' }}>{record.output || '未获得输出'}</pre></details>
      {record.error && <p role="status">{record.error}</p>}
      <ul>{record.evaluation.map((check, index) => <li key={index}>
        {check.criterion}：{check.verdict === 'met' ? '满足' : check.verdict === 'unmet' ? '未满足' : '不确定'}
        {check.evidence && <blockquote>{check.evidence}</blockquote>}<p>{check.suggestion}</p>
      </li>)}</ul>
    </details>)}
    <p>不同版本比较须保持输入、模型和参数一致；单次结果不能证明稳定性，语义评估也可能有误。</p>
  </section>
);
