import type { S2CanvasDefinition, S2Document } from '../../types/sceneS2';
import type { S2WorkflowDiagnostic } from './sceneS2PluginHost';
import { s2ConnectionNodeLabel, s2ConnectionPortLabel, s2ConnectionFieldLabel } from './sceneS2Connections';
import { snapshotS2CompositeData } from './sceneS2Composite';
import { isS2ExclusiveMerge } from './sceneS2Merge';
import { isInstalledS2ModelSession, s2BuiltinPluginRegistry } from './sceneS2PluginRegistry';
import { S2PluginProtocolError } from './sceneS2PluginProtocol';
import { selectS2Execution } from './sceneS2Workflow';

export interface S2RuntimeIssue {
  kind: 'merge-conflict' | 'upstream-unavailable' | 'missing-input' | 'condition-unavailable' | 'structured-transform' | 'model-request' | 'resource-read' | 'file-selection';
  resourceSource?: 'file' | 'note';
  title: string;
  summary: string;
  detail: string;
  nodeIds: string[];
  /** Only identifiers, counts, port names and the public configured condition path. Never material bodies, artifacts, comparison values or permissions. */
  technical: string;
}
const registry = s2BuiltinPluginRegistry();

/** Human vocabulary for current host-issued scheduling metadata. This pure formatter is not an execution or freshness authority.
 * Callers must retrieve the diagnostic from readWorkflowDiagnostic again before offering current-node navigation. */
export function s2RuntimeIssue(definition: S2CanvasDefinition, document: S2Document, nodeId: string, raw: unknown): S2RuntimeIssue | null {
  try {
    const diagnostic = snapshotS2CompositeData(raw, { maxBytes: 6000, maxEntries: 120 }) as S2WorkflowDiagnostic;
    const node = document.execution?.nodes.find(item => item.id === nodeId);
    if (!node || !diagnostic || typeof diagnostic !== 'object' || Array.isArray(diagnostic)
      || !['merge-conflict', 'upstream-unavailable', 'condition-unavailable', 'structured-transform', 'model-request', 'resource-read'].includes(diagnostic.kind)) return null;
    if (diagnostic.kind === 'resource-read') {
      if (Object.keys(diagnostic).length !== 3 || Object.keys(diagnostic).some(key => !['kind', 'source', 'reason'].includes(key))
        || !['file', 'note'].includes(diagnostic.source) || node.pluginVersion !== '1.0.0' || node.capabilityId !== 'read-text'
        || node.pluginId !== (diagnostic.source === 'file' ? 'local-material' : 'project-notes')
        || !(diagnostic.source === 'file'
          ? ['not-approved', 'revoked', 'file-encoding', 'file-text-limit', 'file-non-text']
          : ['not-approved', 'revoked', 'note-changed', 'note-missing', 'note-scope-unavailable', 'note-empty', 'note-text-limit', 'note-non-text', 'note-response-mismatch']).includes(diagnostic.reason)) return null;
      const step = s2ConnectionNodeLabel(definition, document, nodeId), name = diagnostic.source === 'file' ? '文本资料' : '项目笔记';
      const contentDescription = {
        'file-encoding': { title: '文件不是有效的 UTF-8 文本', summary: `${step}不能完整解码这份文件；不是缺少读取许可，也不代表 JSON 写法有误。`,
          action: '请先在原文件的编辑器中另存为 UTF-8，再自行重新提供、选用并运行；画布不转换编码或用替代字符补齐。' },
        'file-text-limit': { title: '文件文本超过本局长度上限', summary: `${step}读到的完整文本超过6000字符计数上限；文件字节大小合规也可能出现此问题。`,
          action: '请自行整理需要使用的完整内容，另存较小文件后重新提供、选用并运行；不自动取前6000字符。字符按UTF-16单位计数，部分表情占两个单位。' },
        'file-non-text': { title: '文件含不支持的非文本内容', summary: `${step}解码后的文件含空字符（NUL）；这与空文件、空白文字不是一回事。`,
          action: '请核对原文件是否为纯文本，自行整理后重新提供、选用并运行；画布不会删除空字符或将二进制内容强转成文本。' },
        'note-empty': { title: '笔记正文为空或只有空白', summary: `${step}返回的笔记正文没有非空白内容；有笔记标题不等于有正文。`,
          action: '请自行补充原笔记正文，或选择另一份原范围内的笔记；随后按当前版本重新允许、选用并单独运行。不会代填、借用其他笔记或把标题当正文。' },
        'note-text-limit': { title: '笔记正文超过本局长度上限', summary: `${step}取得的完整正文超过单份6000字符或24000字节限制；不能用摘要冒充全文。`,
          action: '请自行在原笔记整理所需内容，或选择较小笔记，再重新允许、选用并运行。不自动裁剪或摘要；字符按UTF-16单位计数，部分表情占两个单位。' },
        'note-non-text': { title: '笔记正文含不支持的非文本内容', summary: `${step}返回的正文含空字符（NUL）；它不是空白笔记或版本已变化。`,
          action: '请核对并自行整理原笔记正文，再重新允许、选用并运行；画布不删除字符、强制转换或修改原笔记。' },
        'note-response-mismatch': { title: '笔记正文返回不完整或身份不一致', summary: `${step}取得的返回缺少文本正文，或笔记身份、版本与所选项不一致；不据此断定笔记已删除或内容为空。`,
          action: '请先核对原笔记和项目状态；若资料未变仍出现此提示，请保留记录排查读取入口，不必反复运行。不会读取替代笔记或发布部分内容。' },
      };
      if (Object.hasOwn(contentDescription, diagnostic.reason)) {
        const description = contentDescription[diagnostic.reason as keyof typeof contentDescription];
        return { kind: diagnostic.kind, resourceSource: diagnostic.source, title: description.title, summary: description.summary, nodeIds: [nodeId],
          detail: `${description.action}本次读取已开始，扣次保留；没有发布新正文或继续依赖它的步骤。查看设置不读取、修改、重新允许或重试；旧结果不代表本次成功。`,
          technical: JSON.stringify({ nodeId, ...diagnostic }) };
      }
      const description = {
        'not-approved': { title: `这项${name}尚未获本局允许`, summary: `${step}选用的标识不是本局当前允许的${name}，不能使用名称、路径或旧模板句柄代替授权。` },
        revoked: { title: `这项${name}已撤回`, summary: `${step}仍选用已撤回的旧资料标识；重新提供同名资料也不会恢复旧选择。` },
        'note-changed': { title: '选用的笔记版本已变化', summary: `${step}允许的笔记版本或名称曾发生变化；恢复旧版本也不会复活已失效的允许。` },
        'note-missing': { title: '选用的笔记已不在原项目范围内', summary: `${step}对应的笔记曾被移除、删除或移出原范围；不能据此判断是哪一种，也不会改查其他项目。` },
        'note-scope-unavailable': { title: '项目笔记范围暂不可确认', summary: `${step}无法可靠核对原项目的笔记范围；这不等于笔记已删除或正文为空。` },
      }[diagnostic.reason];
      return { kind: diagnostic.kind, resourceSource: diagnostic.source, ...description, nodeIds: [nodeId],
        detail: `本次没有发布可用新正文；读取前检查失败不扣读取次数，若已开始读取则原扣次保留。已有结果与记录仍保留，不代表本次读取成功或最新内容。请先查看本局${name}设置，由你决定撤回失效项、重新提供并允许；之后还需到读取步骤明确选用，再单独运行。定位不读取、重新允许、替换选择或重试。${diagnostic.source === 'file' ? '文件是选择时的浏览器快照，不实时跟踪磁盘变更；需要新版请重新选择文件。' : '仅限原项目进入场景时的范围，不扩大到其他项目或后来新增的笔记。'}`,
        technical: JSON.stringify({ nodeId, ...diagnostic }) };
    }
    if (diagnostic.kind === 'model-request') {
      if (Object.keys(diagnostic).length !== 2 || Object.keys(diagnostic).some(key => !['kind', 'reason'].includes(key))
        || !['authorization-missing', 'authorization-closed', 'budget-exhausted', 'user-declined'].includes(diagnostic.reason)
        || !isInstalledS2ModelSession(node)) return null;
      const title = s2ConnectionNodeLabel(definition, document, nodeId);
      const description = {
        'authorization-missing': { title: '本局尚未单独批准模型测试', summary: `${title}需要独立批准本局模型与预算，装配或连接不等于授权。`,
          detail: '本次未进入运行队列，没有发送请求或新增调用次数。你可只查看授权与用量区；准备配置、批准预算和逐次发送都需分别决定，也可只运行纯本地子图。' },
        'authorization-closed': { title: '本局模型授权已关闭', summary: `${title}不能再发送新的模型请求，不能在本局恢复或重置授权。`,
          detail: '此提示所对应的请求未再发送；已有用量、结果和本地步骤记录保留，关闭原因可查看授权区。需要新的预算时应由你另开新局并重新授权，不能复活旧确认或自动重试。' },
        'budget-exhausted': { title: '本局预算不足一次完整模型请求', summary: `${title}未取得新的发送确认，因为请求次数或完整输出预留额度已不足。`,
          detail: '本次模型请求未发送，未增加模型请求或输出预留；上游本地步骤可能已经运行，原记录与次数保留。预算不自动追加、重置或退还；可查看用量、保留结果或手动选择本地步骤，不截短输入或输出上限来绕过预算。' },
        'user-declined': { title: '你已拒绝这次模型请求', summary: `${title}的这次请求没有发送，也没有增加模型请求或输出预留。`,
          detail: '这不是服务商报错，也不是撤回整局模型权限；依赖本次结果的下游没有继续。若想再试，先自行核对材料，再明确运行目标并重新核对完整请求；不会恢复旧发送按钮或自动重试。' },
      }[diagnostic.reason];
      return { kind: diagnostic.kind, ...description, nodeIds: [nodeId], technical: JSON.stringify({ nodeId, ...diagnostic }) };
    }
    if (diagnostic.kind === 'structured-transform') {
      const keys = ['kind', 'reason', 'inputPortIds'];
      const expected = {
        'json-syntax': { capability: 'parse-json', ports: ['text'] },
        'pointer-syntax': { capability: 'select', ports: ['pointer'] },
        'pointer-missing': { capability: 'select', ports: ['value', 'pointer'] },
        'pointer-inaccessible': { capability: 'select', ports: ['value', 'pointer'] },
        'table-records-required': { capability: 'to-table', ports: ['value'] },
        'table-row-limit': { capability: 'to-table', ports: ['value'] },
        'table-column-limit': { capability: 'to-table', ports: ['value'] },
        'table-column-name-limit': { capability: 'to-table', ports: ['value'] },
        'table-nested-cell': { capability: 'to-table', ports: ['value'] },
      };
      if (Object.keys(diagnostic).length !== keys.length || Object.keys(diagnostic).some(key => !keys.includes(key))
        || !Object.hasOwn(expected, diagnostic.reason) || !Array.isArray(diagnostic.inputPortIds)
        || node.pluginId !== 'structured-data' || node.pluginVersion !== '1.0.0') return null;
      const contract = expected[diagnostic.reason];
      if (node.capabilityId !== contract.capability || JSON.stringify(diagnostic.inputPortIds) !== JSON.stringify(contract.ports)) return null;
      const cap = registry.capability(node), nodeIds = [nodeId], sources: string[] = [];
      for (const portId of contract.ports) {
        const port = cap.inputs.find(port => port.id === portId); if (!port) return null;
        const binding = node.bindings[portId], links = document.execution!.links.filter(link => link.target.nodeId === nodeId && link.target.portId === portId);
        if (binding && links.length || !binding && !links.length || !port.multiple && links.length > 1) return null;
        const role = portId === 'text' ? '待解析文本' : portId === 'value' ? node.capabilityId === 'to-table' ? '待整理的数据' : '要提取的数据' : '提取位置';
        if (binding?.kind === 'field') {
          if (port.type.id !== 'core.text' || port.type.version !== 1) return null;
          sources.push(`${role}来自${s2ConnectionFieldLabel(definition, document, binding.nodeId, binding.fieldId)}，请在原内容块修改。`);
          nodeIds.push(binding.nodeId);
        } else if (binding?.kind === 'literal') sources.push(`${role}是在本步骤内填写的，请在本步骤的材料设置中核对。`);
        else if (binding) return null;
        else for (const link of links) {
          sources.push(`${role}来自${s2ConnectionPortLabel(definition, document, link.source, 'outputs')}，请核对原来源；接收步骤不会自动替换上游材料。`);
          nodeIds.push(link.source.nodeId);
        }
      }
      const title = s2ConnectionNodeLabel(definition, document, nodeId);
      const canSelect = definition.plugins?.some(plugin => plugin.pluginId === 'structured-data' && plugin.pluginVersion === '1.0.0' && plugin.capabilityId === 'select');
      const description = {
        'json-syntax': { title: '待解析文本不是有效的 JSON', summary: `${title}无法按 JSON 语法读取本次文本，尚未生成可用结果。`,
          detail: '这是原生解析器确认的语法错误，不是缺少某个业务字段，也不代表数据内容已经过评价。请核对引号、逗号、括号等格式，不会自动改写文本。' },
        'pointer-syntax': { title: '提取位置的写法无法识别', summary: `${title}的提取位置不符合支持的位置格式，尚未提取结果。`,
          detail: '提取位置需要标准 JSON Pointer，不支持表达式或按名称猜测。位置可能来自上游文本；请先核对来源，不会为了诊断读取或展示其中内容。' },
        'pointer-missing': { title: '没有找到要提取的位置', summary: `${title}无法从本次数据找到指定的完整位置，尚未提取结果。`,
          detail: '不猜测缺少哪一段，也不把未找到的位置补成空值。请结合数据结构核对提取位置；在本步骤填写位置时，可由你主动查看真实来源字段再选择。' },
        'pointer-inaccessible': { title: '指定的提取位置不能访问', summary: `${title}无法访问指定位置，尚未提取结果。`,
          detail: '可能涉及保留字段名或不支持的数组位置写法；不能直接判断为缺少字段，也不会尝试绕过访问限制。请核对数据来源与提取位置。' },
        'table-records-required': { title: '转表格需要逐条排列的记录', summary: `${title}收到的数据不是记录列表，尚未生成表格。`,
          detail: `需要一个列表，每项是一条由字段组成的记录，例如两条各含姓名与分数的记录。${canSelect ? '如果记录放在某个字段中，可检查已有提取步骤的选择位置，或自行添加本场景已允许的提取步骤。' : '请检查原材料或上游输出的结构；当前不会自动添加提取能力。'}` },
        'table-row-limit': { title: '本次记录超过表格行数上限', summary: `${title}收到的列表包含超过100项，尚未生成表格。`,
          detail: '本地表格每次最多整理100条记录。请自行决定本次处理范围或分批方式；全部原记录保留，不会截取前100条继续。' },
        'table-column-limit': { title: '记录字段超过表格列数上限', summary: `${title}的记录合计包含超过24种字段，尚未生成表格。`,
          detail: '所有记录的字段合起来最多对应24列，不只统计第一条记录。请核对原材料并决定要呈现哪些字段；不会自动丢弃多余字段。' },
        'table-column-name-limit': { title: '有字段名称超过表格支持的长度', summary: `${title}有字段名称过长，尚未生成表格。`,
          detail: '字段名称最多120个字符，部分特殊字符会占用两位。请在原材料中自行调整名称及相关引用；不会截短名称或合并字段。' },
        'table-nested-cell': { title: '记录中还有不能直接放进单元格的内容', summary: `${title}发现记录字段内还有对象或列表，尚未生成表格。`,
          detail: '单元格支持文字、数字、布尔值和空值；多层内容需要先明确如何呈现。请检查原材料或上游整理方式，不会自动展开、拼接为文字或丢弃嵌套内容。' },
      }[diagnostic.reason];
      return { kind: diagnostic.kind, ...description,
        detail: `${description.detail}${sources.join('')}本次转换调用已计入次数；上游可能也已运行，记录与额度保留。定位只帮助查看，不会读取正文、自动修复或重跑。`,
        nodeIds: [...new Set(nodeIds)], technical: JSON.stringify({ nodeId, ...diagnostic }) };
    }
    if (diagnostic.kind === 'condition-unavailable') {
      const keys = ['kind', 'reason', 'sourceNodeId', 'sourcePortId', 'pointer'];
      const when = node.when, source = document.execution!.nodes.find(item => item.id === diagnostic.sourceNodeId);
      if (Object.keys(diagnostic).length !== keys.length || Object.keys(diagnostic).some(key => !keys.includes(key))
        || !['pointer-missing', 'source-output-unavailable', 'inline-data-unavailable'].includes(diagnostic.reason)
        || !when || !source || diagnostic.sourceNodeId !== when.nodeId || diagnostic.sourcePortId !== when.portId || diagnostic.pointer !== when.pointer
        || typeof diagnostic.pointer !== 'string' || diagnostic.pointer.length > 500
        || diagnostic.reason === 'pointer-missing' && diagnostic.pointer === ''
        || diagnostic.pointer !== '' && (!diagnostic.pointer.startsWith('/') || /~(?![01])/u.test(diagnostic.pointer))) return null;
      const port = registry.capability(source).outputs.find(item => item.id === diagnostic.sourcePortId);
      if (!port?.required || port.multiple || !['core.assessment', 'structured-data.value', 'workflow-simulation.result', 'human-input.decision'].includes(port.type.id)) return null;
      // JSON quoting distinguishes an empty field from the root and prevents slash/tilde tokens being visually conflated.
      // Numeric tokens may be object keys or array positions; metadata alone cannot decide which.
      const path = diagnostic.pointer === '' ? '整体内容（根路径）'
        : `从整体内容依次查找 ${diagnostic.pointer.slice(1).split('/').map(token => JSON.stringify(token.replace(/~1/g, '/').replace(/~0/g, '~'))).join(' → ')}`;
      const title = s2ConnectionNodeLabel(definition, document, nodeId);
      const from = s2ConnectionPortLabel(definition, document, { nodeId: diagnostic.sourceNodeId, portId: diagnostic.sourcePortId }, 'outputs');
      const description = {
        'pointer-missing': { title: '运行条件指定的位置未找到', summary: `${title}无法从${from}的本次结果找到设置的完整路径：${path}。`,
          detail: '这是条件尚不能判定，不是条件不成立；没有猜测缺少哪一段，也没有按不相等分支继续。请核对条件位置与来源结果的结构，定位不会读取或代填结果、改条件或重跑。' },
        'source-output-unavailable': { title: '运行条件的来源结果还不可用', summary: `${title}需要${from}的本次完整单值结果，但当前没有获得可用于判断的结果。设置的位置：${path}。`,
          detail: '这不是已经确认路径缺失；请先查看来源步骤本次是否失败、阻塞或未得到完整输出。不能用历史结果或把不可用当作条件不成立，定位不会自动重试。' },
        'inline-data-unavailable': { title: '运行条件缺少可直接判断的完整内容', summary: `${title}从${from}取得的结果没有完整内联内容，不能判断设置的位置：${path}。`,
          detail: '不能把引用句柄或摘要当作完整结果，也不会为诊断自动读取其内容。这不是已经确认路径缺失，请核对来源的数据形式；定位不改配置、不自动解析资料或重跑。' },
      }[diagnostic.reason];
      return { kind: diagnostic.kind, ...description,
        detail: `${description.detail}当前条件步骤未执行；上游可能已经运行并消耗次数，原记录与额度保留。${port.type.id === 'workflow-simulation.result' ? '该条件来源为模拟结果，不能证明真实业务已发生或已达标。' : ''}`,
        nodeIds: [nodeId, diagnostic.sourceNodeId], technical: JSON.stringify({ nodeId, ...diagnostic }) };
    }
    const keys = diagnostic.kind === 'merge-conflict' ? ['kind', 'candidateCount', 'sourceNodeIds', 'boundInput'] : ['kind', 'sourceNodeIds'];
    if (Object.keys(diagnostic).length !== keys.length || Object.keys(diagnostic).some(key => !keys.includes(key))
      || !Array.isArray(diagnostic.sourceNodeIds) || diagnostic.sourceNodeIds.length > 40
      || new Set(diagnostic.sourceNodeIds).size !== diagnostic.sourceNodeIds.length
      || diagnostic.sourceNodeIds.some(id => typeof id !== 'string' || !document.execution!.nodes.some(item => item.id === id))) return null;
    const links = document.execution!.links.filter(link => link.target.nodeId === nodeId);
    if (diagnostic.sourceNodeIds.some(id => !links.some(link => link.source.nodeId === id
      && (diagnostic.kind !== 'merge-conflict' || link.target.portId === 'candidates')))) return null;
    const title = s2ConnectionNodeLabel(definition, document, nodeId);
    const names = diagnostic.sourceNodeIds.map(id => s2ConnectionNodeLabel(definition, document, id));
    if (diagnostic.kind === 'merge-conflict') {
      const boundInput = Object.hasOwn(node.bindings, 'candidates');
      if (!isS2ExclusiveMerge(node) || typeof diagnostic.boundInput !== 'boolean' || diagnostic.boundInput !== boundInput
        || !Number.isSafeInteger(diagnostic.candidateCount) || diagnostic.candidateCount < 2 || diagnostic.candidateCount > 32
        || diagnostic.candidateCount < diagnostic.sourceNodeIds.length + Number(boundInput)
        || !diagnostic.sourceNodeIds.length || node.bindings.candidates?.kind === 'field') return null;
      return { kind: diagnostic.kind, title: '有多份结果同时到达合流步骤',
        summary: `${title}收到 ${diagnostic.candidateCount} 份候选结果，但它只能转交唯一一份；本次没有自动选择或执行合流。`,
        detail: `本次有结果的来源：${names.join('、')}${boundInput ? '，以及合流步骤内已填写的一份内容' : ''}。合流未执行，但上游可能已经运行并消耗次数，原记录与额度保留。请检查这些来源的运行条件是否允许同时成立，或是否还保留了固定输入。相同内容仍算不同候选；系统不会替你删线、改条件或重跑。`,
        nodeIds: [nodeId, ...diagnostic.sourceNodeIds], technical: JSON.stringify({ nodeId, ...diagnostic }) };
    }
    if (!diagnostic.sourceNodeIds.length) return null;
    return { kind: diagnostic.kind, title: '上游还没有可用的完整结果',
      summary: `${title}依赖${names.join('、')}，这些来源本次未提供完整成功输出，因此暂未继续。`,
      detail: '请先查看这些上游步骤的本次运行情况。失败或阻塞不能当作“没有命中”而绕过，也不能用历史结果替代；定位只帮助查看，不会自动重试。',
      nodeIds: [nodeId, ...diagnostic.sourceNodeIds], technical: JSON.stringify({ nodeId, ...diagnostic }) };
  } catch { return null; }
}

/** A pure view of a current host-issued local selection rejection, not a grant or a picker command. */
export function s2TextFileSelectionIssue(raw: unknown): S2RuntimeIssue | null {
  try {
    const value = snapshotS2CompositeData(raw, { maxBytes: 1000, maxEntries: 10 }) as { kind: string; reason: string };
    if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== 2
      || Object.keys(value).some(key => !['kind', 'reason'].includes(key)) || value.kind !== 'file-selection'
      || !['invalid-file', 'unsupported-file-name', 'file-byte-limit'].includes(value.reason)) return null;
    const description = {
      'invalid-file': { title: '尚未提供可用的本地文件', summary: '请通过文件选择入口提供原生文本文件；路径、文件名或对象不能代替文件。' },
      'unsupported-file-name': { title: '文件类型或名称不受支持', summary: '仅支持名称有效的 txt、md、json、csv 文件；不支持路径、控制字符或过长名称，改后缀也不会转换内容。' },
      'file-byte-limit': { title: '文件超过单份24000字节上限', summary: '选择阶段已拒绝这份文件；没有读取正文、授予读取许可、替换原资料或扣运行次数。' },
    }[value.reason]!;
    return { kind: 'file-selection', resourceSource: 'file', ...description, nodeIds: [], technical: JSON.stringify(value),
      detail: '请自行核对并重新选择合规文本文件。原文件、已允许资料、步骤输入和旧结果保持不变；不会自动转换、裁剪、替换或重试。重新提供后仍需选到读取步骤，再单独运行。' };
  } catch { return null; }
}

/** Explain only the exact first native missing-input failure for the requested subgraph. No resource resolution or execution.
 * The normal selector rechecks declared bindings (including false/0/null), real links, selected ancestors and protocol precedence. */
export function s2WorkflowPreflightIssue(definition: S2CanvasDefinition, document: S2Document, targets: string[] | undefined, error: unknown): S2RuntimeIssue | null {
  if (!(error instanceof S2PluginProtocolError) || error.code !== 'MISSING_INPUT') return null;
  const match = /^([A-Za-z][A-Za-z0-9_-]*)\.([A-Za-z][A-Za-z0-9_-]*)$/.exec(error.field);
  if (!match) return null;
  try {
    try { selectS2Execution(document, definition.plugins, targets); return null; }
    catch (actual) {
      if (!(actual instanceof S2PluginProtocolError) || actual.code !== error.code || actual.field !== error.field
        || actual.message !== error.message || actual.message !== '必填输入未连接或提供') return null;
    }
    const [, nodeId, portId] = match, node = document.execution!.nodes.find(item => item.id === nodeId);
    const port = node && registry.capability(node).inputs.find(item => item.id === portId);
    if (!node || !port?.required || Object.hasOwn(node.bindings, portId)
      || document.execution!.links.some(link => link.target.nodeId === nodeId && link.target.portId === portId)) return null;
    return { kind: 'missing-input', title: '开始前还缺一项材料',
      summary: `${s2ConnectionPortLabel(definition, document, { nodeId, portId }, 'inputs')}尚未填写或连接，所选流程没有开始运行。`,
      detail: '请进入该步骤的材料设置，填写需要的内容或选择兼容来源。这里只定位当前首个缺项；补充后仍需重新检查并由你决定是否运行，不会自动读取资料或补值。',
      ...(portId === 'resource' && node.pluginVersion === '1.0.0' && node.capabilityId === 'read-text' && ['local-material', 'project-notes'].includes(node.pluginId)
        ? { resourceSource: node.pluginId === 'local-material' ? 'file' as const : 'note' as const } : {}),
      nodeIds: [nodeId], technical: JSON.stringify({ kind: 'missing-input', nodeId, portId, code: error.code }) };
  } catch { return null; }
}
