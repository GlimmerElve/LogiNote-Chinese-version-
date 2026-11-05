import React from 'react';
import type { S2CanvasDefinition, S2Document } from '../../types/sceneS2';
import { selectS2Execution } from '../../services/scene/sceneS2Workflow';
import { s2NodeTitle } from '../../services/scene/sceneS2Presentation';

/** Read-only explanation of the same scope the host will validate when queued. Never executes or grants. */
export function S2RunSummary({ document, plugins, targets, discuss = false, force = false }: {
  document: S2Document; plugins: S2CanvasDefinition['plugins']; targets?: string[]; discuss?: boolean; force?: boolean;
}) {
  try {
    const { graph, order } = selectS2Execution(document, plugins, targets);
    const nodes = order.map(id => graph.nodes.find(node => node.id === id)!);
    const title = (id: string) => {
      const node = graph.nodes.find(item => item.id === id)!;
      const label = s2NodeTitle(node);
      const same = document.execution!.nodes.filter(item => s2NodeTitle(item) === label);
      return same.length > 1 ? `${label}（第 ${same.findIndex(item => item.id === id) + 1} 个）` : label;
    };
    const human = nodes.filter(node => node.pluginId === 'human-input');
    const model = nodes.some(node => node.pluginId === 'model-test');
    const resource = nodes.some(node => ['local-material', 'project-notes'].includes(node.pluginId) && node.capabilityId === 'read-text');
    return <section className="s2-run-summary" aria-label="运行范围说明">
      <p>{targets ? `运行目标：${[...new Set(targets)].map(title).join('、')}` : `运行范围：全部 ${nodes.length} 个步骤`}</p>
      <details><summary>查看涉及的 {nodes.length} 个步骤</summary>
        <p>包括提供材料或决定分支的前置步骤；不满足条件的分支会跳过，不代表每步都会执行。</p>
        <ol>{nodes.map(node => <li key={node.id}>{title(node.id)}{node.when ? ' · 按条件决定是否运行' : ''}</li>)}</ol>
        <details><summary>技术标识</summary><pre>{JSON.stringify(order, null, 2)}</pre></details>
      </details>
      {!!human.length && <p>运行到「{human.map(node => title(node.id)).join('、')}」时会等待你填写或确认。提交后继续这次运行，已完成的前置步骤不会重做。</p>}
      {model && <p>包含模型测试：需先单独批准本局模型预算；真正发送前还会展示完整内容，请你逐次确认，可能产生费用。</p>}
      {resource && <p>包含资料读取：运行时重新核对本局授权与笔记版本，不从计算缓存读取正文。若已撤回、变更或移出项目，相关步骤会停止；历史输出不代表资料仍然可用。</p>}
      <p>{discuss ? '完成后请 Agent 结合本次结果回应；不会自动开启下一轮运行。' : '完成后显示结果，不自动请 Agent 评价；需要讲解时可在对话框提问。'}</p>
      <small>{force ? '本次重新计算，不使用已有计算结果。' : '可复用本局相同输入的有效计算结果。'}只使用已应用的内容；未应用的表单或参数草稿不会参与。</small>
    </section>;
  } catch (error) {
    return <section className="s2-run-summary" aria-label="运行范围说明"><p>当前范围还不能运行，请检查材料、连线和允许使用的工具。</p>
      <details><summary>查看具体原因</summary><p>{error instanceof Error ? error.message : '无法确认运行范围'}</p></details>
    </section>;
  }
}
