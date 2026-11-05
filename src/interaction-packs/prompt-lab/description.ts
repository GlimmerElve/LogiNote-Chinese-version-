import type { ScenePackDescription } from '../../types/sceneInteractionPack';
import { promptLabDesignPolicy } from './designPolicy';
import { promptLabAgentRules } from './agentRules';

/** The same package owns the executable implementation and its Agent-facing manual. */
export function describePromptLab(fieldRules = ''): ScenePackDescription {
  const capability = (pluginId: string, capabilityId: string) => ({ pluginId, pluginVersion: '1.0.0', capabilityId });
  return {
    purpose: '用内容、组装、测试、结果和待测资料五种逻辑块学习提示词工程；用户连接并测试，助手按需协助，运行代码负责传输。',
    components: [
      { id: 'content', name: '内容块', capabilities: [], purpose: '只保存一份原始文字。角色、任务和输出要求使用同型块的不同实例。',
        configuration: 'type=text，字段content；以field绑定连接组装入口，label只供辨认。', example: { id: 'task', type: 'text', values: { content: '概括成三点' } } },
      { id: 'compose', name: '组装块', capabilities: [capability('text-template', 'compose')], purpose: '按预设入口、顺序及结构原样拼接所连内容。',
        configuration: 'text-template@1.0.0/compose；预设part1至part8的入口、prefixes和separator；正文来自field绑定或上游连线，不放槽位字面量。',
        example: { pluginId: 'text-template', pluginVersion: '1.0.0', capabilityId: 'compose', bindings: { part1: { kind: 'field', nodeId: 'task', fieldId: 'content' }, prefixes: { kind: 'literal', value: ['任务：'] }, separator: { kind: 'literal', value: '\n' } } } },
      { id: 'model-test', name: '测试块', capabilities: [capability('model-test', 'generate')], purpose: '把所连提示词与按需提供的资料、图片送给固定模型，观察真实返回。',
        configuration: 'model-test@1.0.0/generate；prompt、可选input/image，以及maxOutputTokens/temperature/thinkingMode。用户点击测试即以当前提示词、资料及参数发送本次请求；次数、长度和超时由程序处理。',
        example: { source: { nodeId: 'assemble', portId: 'text' }, target: { nodeId: 'test', portId: 'prompt' } } },
      { id: 'result', name: '结果块', capabilities: [capability('structured-view', 'text')], purpose: '直接显示本次真实返回和状态。',
        configuration: 'structured-view@1.0.0/text；text接测试节点text输出。',
        example: { source: { nodeId: 'test', portId: 'text' }, target: { nodeId: 'result', portId: 'text' } } },
      { id: 'material', name: '待测资料块', capabilities: [capability('local-material', 'read-text'), capability('local-material', 'read-image')], purpose: '提供与提示词分开的待处理原文或本局选定资料、图片。',
        configuration: '默认用type=text、字段content、label=待测资料，测试bindings.input={kind:"field",nodeId:"material",fieldId:"content"}。有文件才选local-material@1.0.0/read-text（text输出接input），有图片才选local-material@1.0.0/read-image（image输出接image）；两者resource绑定留空，运行时由本局选择，不保存路径或旧句柄。',
        example: { id: 'material', type: 'text', label: '待测资料', values: { content: '待处理的文章原文' } } },
    ],
    combinations: [
      '内容字段接组装part1至part8；组装text接测试prompt；待测文字资料接input，图片接image；测试text接结果text。关系由field绑定或execution.links明确连接并呈现连线。',
      '新场景只装配这五种逻辑块，预先配置组装结构与模型参数，不增加处理、等待或评价节点；包内传输由运行代码完成。',
      '本局资源只能保存选择入口，不保存图片字节、授权、凭据或运行记录；未知资料不虚构，测试返回不预填。',
    ],
    operations: [
      { id: 'readState', description: '读取当前场景配置快照', parameters: '{}', errors: ['PACK_CLOSED'] },
      { id: 'readResult', description: '读取宿主记录的已有执行结果，不重跑', parameters: '{}', errors: ['PACK_CLOSED'] },
      { id: 'run', description: '经终端用户动作入口运行指定目标', parameters: '{targets?:节点ID数组,force?:布尔值}', errors: ['INVALID_CONFIG', 'PACK_CLOSED', 'HOST_DENIED'] },
      { id: 'cancel', description: '取消本运行器启动的任务，不撤销已发生的模型用量', parameters: '{runId:本运行器返回的ID}', errors: ['RUN_NOT_OWNED', 'PACK_CLOSED'] },
    ],
    builder: promptLabDesignPolicy(fieldRules),
    assistant: { instructions: '先理解用户消息或已配置事件的任务，再按需读取公开组件或真实实验记录。只在本轮scope内通过公开actions提议操作，由底座校验执行。\n' + promptLabAgentRules,
      defaultAllowedOperations: ['readState', 'readResult'] },
  };
}
