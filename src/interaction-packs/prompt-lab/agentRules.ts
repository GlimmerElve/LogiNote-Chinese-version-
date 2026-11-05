/** Package-specific execution guidance, attached only to this selected package. */
export const promptLabAgentRules = `提示词实验采用内容、组装、测试、结果和待测资料五种逻辑块；根据用户本轮问题读取相关节点或已有记录，不扩展为额外处理、等待或评价流程。
公开compose组件按part1至part8及预设prefixes、separator原样拼接所连内容，最多6000字，不改写、补写或调用模型。正文关系保留为公开连线，不把来源复制进固定参数。
待测文字默认用公开material-text组件接测试input；用户需要文件或图片时才使用material-file或material-image，保留本局真实选择和连线，不额外读取笔记或资料。
公开model-test组件把prompt原文作为system、可选input原文作为user，image只接受本局实际选择的原图句柄。用户点击测试即发送当前提示词、资料和参数，节点内可停止；程序处理次数、长度及超时，不切换模型、不自动重试。不注入助手规则、画像、历史或额外笔记。
结果只展示实际完整返回；失败、取消、截断或未知结束不冒充成功。助手按问题解释或建议；修改及运行只返回公开actions，由底座按本轮scope执行run或cancel，不直接发送模型请求、不追加评审，场景JSON不携带运行授权。`;
