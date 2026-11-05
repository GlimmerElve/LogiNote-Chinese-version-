/** Package-owned business guidance. The host supplies the common canvas/field contract. */
export function promptLabDesignPolicy(_fieldRules: string) {
const EXPERIMENT_ASSEMBLE = `提示词实验只使用五种逻辑块：内容、组装、测试、结果、待测资料。用户自行填写和连接，点击测试后观察原始返回，助手按需协助，不参与节点间数据传输。
内容共用type=text、字段content；角色、任务和输出要求是同型块的不同实例，不新增业务块类型。待测文字资料默认也用同型块，label=待测资料，field连接测试input；只有用户需要文件或图片才分别选local-material@1.0.0/read-text或read-image，作为同一类待测资料块，text输出接input、image输出接image，resource留待本局选择。按用户目标预填或留白，未知资料不虚构正文。
组装使用单个text-template@1.0.0/compose，预先配置part1至part8的入口、prefixes和separator。正文只从内容块field绑定或真实上游连线进入，不写入槽位字面量；用途、顺序及结构由组装配置表达，原文不改写、不补写。
测试使用model-test@1.0.0/generate：组装text接prompt，按需把独立资料接input、原图句柄接image；模型参数是该节点配置。用户点击测试即以当前输入和参数发出本次请求，节点内显示状态并可停止；次数、长度及超时由程序处理，不增加预算准备、队列核对或发送确认任务。结果使用structured-view@1.0.0/text，测试text接结果text。数据关系用field绑定或execution.links呈现，不用说明文字代替连接。
新场景不增加其他处理、等待或评价节点，也不生成复杂属性面板。旧场景不强制迁移。用户明确要求固定的原文预填readOnly:true；保留原文、中文名称和明确约束，不解锁固定块。goal说明目标，instructions只写可选助手策略；预期不混入被测请求，不虚构返回或声称已运行，不给场景JSON添加授权字段。只有用户明确提供标准时才填写criteria。不新增business、私有完成图或coverage，不返回designBrief。`;
const EXPERIMENT_REPAIR = `按feedback/repairContext只修错误的连接和配置，保留需求、原文、中文名称及只读内容。新场景维持五种逻辑块与单个compose→测试→结果链路，正文保留独立来源，未知资料留入口，不增添处理或评价节点。既有场景只修本次问题，不顺带迁移旧节点。有jsonFormatRepair时只修同阶段格式，保留previousOutput完整内容，不虚构资料或执行结果。`;


return { assemble: EXPERIMENT_ASSEMBLE, repair: EXPERIMENT_REPAIR };
}
