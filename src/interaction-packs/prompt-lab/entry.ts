import { promptLabPack } from './index';
import { bindPromptLabUiHost } from './uiHost';
import type { ScenePackActivationServices } from '../../types/sceneInteractionPack';
import { bindPromptLabReact } from './reactBridge';
import { S2ComposeEditor } from './ComposeEditor';
import { S2ModelParameters } from './ModelParameters';
import React from 'react';
import { applyS2ComposeStructure, s2ComposeStructure } from './composeControls';
import type { ScenePackViewContext } from '../../types/sceneInteractionPack';
import { PromptTemplateControls, promptTemplateHiddenInputs } from './TemplateControls';
import { promptLabHelp } from './help';

function uiPolicy(props: ScenePackViewContext) {
  const cap = promptLabPack.capabilities.flatMap(plugin => plugin.capabilities).find(cap => cap.id === props.node.capabilityId
    && promptLabPack.capabilities.some(plugin => plugin.id === props.node.pluginId && plugin.capabilities.includes(cap)));
  const ports = cap?.inputs.map(port => port.id) ?? [];
  const linked = (id: string) => props.node.bindings[id]?.kind === 'field' || props.document.execution?.links.some(link => link.target.nodeId === props.node.id && link.target.portId === id);
  if (props.node.pluginId === 'model-test') return { showResult: false, annotation: '点击测试即发送', hiddenSettingsInputs: ['maxOutputTokens', 'temperature', 'thinkingMode'],
    visibleNodeInputs: ports.filter(id => !['maxOutputTokens', 'temperature', 'thinkingMode'].includes(id) || linked(id)) };
  if (props.node.capabilityId !== 'compose') return { hiddenSettingsInputs: promptTemplateHiddenInputs(props), visibleNodeInputs: ports.filter(id => !(props.node.capabilityId === 'bind' && id === 'key' && props.node.bindings.key?.kind === 'literal')) };
  const structure = s2ComposeStructure(props.definition, props.document, props.node.id);
  return { showResult: false, hiddenSettingsInputs: ports, visibleNodeInputs: [...structure.slots.map(slot => slot.portId), ...ports.filter(id => ['prefixes', 'separator'].includes(id) && linked(id))],
    inputLabels: Object.fromEntries(structure.slots.map(slot => [slot.portId, slot.title])) };
}

/** Fixed v0.1 module entry. Importing the bundle performs no IO or model calls. */
export function activate(services: ScenePackActivationServices) {
  const editor = services.editor;
  bindPromptLabUiHost({ readS2Definition: editor.readDefinition, readS2Document: editor.readDocument,
    snapshotS2CompositeData: editor.snapshot, canonicalS2Json: editor.canonicalJson,
    s2NodeTitle: editor.nodeTitle, s2ParameterSource: editor.parameterSource });
  bindPromptLabReact(services.ui.react);
  const inlineEditor = (label: string, child: React.ReactNode, className = '') => React.createElement('details', {
    className: `s2-prompt-node-editor nodrag nopan nowheel ${className}`.trim(),
    onClick: (event: React.MouseEvent) => event.stopPropagation(),
    onDoubleClick: (event: React.MouseEvent) => event.stopPropagation(),
    onKeyDown: (event: React.KeyboardEvent) => event.stopPropagation(),
  }, React.createElement('summary', null, label), child);
  const ComposeInline = (props: ScenePackViewContext) => inlineEditor('提示词结构', React.createElement(S2ComposeEditor, {
    definition: props.definition, document: props.document, nodeId: props.node.id, disabled: !props.active || props.editable === false,
    scopeKey: props.materialScopeKey,
    onError: props.onError,
    onStructureChange: (config, base) => { props.guard(); props.onDocumentChange(applyS2ComposeStructure(props.definition, props.document, props.node.id, config, base)); },
  }));
  const TemplateInline = (props: ScenePackViewContext) => inlineEditor(props.node.capabilityId === 'bind' ? '内容用途' : '提示词排版',
    React.createElement(PromptTemplateControls, props));
  const ModelInline = (props: ScenePackViewContext) => React.createElement('section', { className: 's2-prompt-test nodrag nopan nowheel', 'aria-label': '提示词测试' }, React.createElement(S2ModelParameters, {
      node: props.node, document: props.document, active: props.active && props.editable !== false, ...props.model,
      onChange: props.onInputChange, onError: props.onError,
    }), React.createElement('button', { type: 'button', disabled: !props.execution?.enabled, title: props.execution?.enabled ? '测试当前提示词与待测资料' : '当前不可测试，请等待场景准备或本次测试结束', onClick: () => {
      try {
        props.guard();
        props.execution?.run([props.node.id]);
      } catch (error) { props.onError((error as Error).message); }
    } }, '测试'), props.execution?.running && React.createElement('button', { type: 'button', onClick: () => {
      try { props.guard(); props.execution?.cancel?.(); } catch (error) { props.onError((error as Error).message); }
    } }, '停止'), props.execution?.status && React.createElement('small', { role: 'status' }, props.execution.status),
    props.execution?.error && React.createElement('p', { role: 'alert' }, props.execution.error));
  const MaterialInline = (props: ScenePackViewContext) => React.createElement(React.Fragment, null, props.resourceInput as React.ReactNode);
  const capability = (pluginId: string, capabilityId: string) => ({ pluginId, pluginVersion: '1.0.0', capabilityId });
  return { ...promptLabPack, help: promptLabHelp,
    canvas: { contentEditing: 'double-click' as const, openSettingsOnSelect: false, contentSettings: 'hide' as const,
      addMenu: { contentLabel: '内容块', groups: [
        { id: 'assembly', label: '提示词组装块', capabilities: [{ ...capability('text-template', 'compose'), defaults: { prefixes: ['角色：', '任务：', '输出要求：'], separator: '\n' } }] },
        { id: 'model', label: '提示词测试块', capabilities: [capability('model-test', 'generate')] },
        { id: 'results', label: '结果展示块', capabilities: [capability('structured-view', 'text')] },
        { id: 'materials', label: '待测资料块', capabilities: [capability('local-material', 'read-text'), capability('local-material', 'read-image')] },
      ], otherCapabilities: 'hide' as const } },
    views: {
    'text-template/compose': { inline: ComposeInline, policy: uiPolicy },
    'text-template/bind': { inline: TemplateInline, policy: uiPolicy },
    'text-template/render': { inline: TemplateInline, policy: uiPolicy },
    'model-test/generate': { inline: ModelInline, policy: uiPolicy },
    'local-material/read-text': { inline: MaterialInline, policy: () => ({ resourceInputInView: true, showResult: false, visibleNodeInputs: [], hiddenSettingsInputs: ['resource'] }) },
    'local-material/read-image': { inline: MaterialInline, policy: () => ({ resourceInputInView: true, showResult: false, visibleNodeInputs: [], hiddenSettingsInputs: ['resource'] }) },
  } };
}
