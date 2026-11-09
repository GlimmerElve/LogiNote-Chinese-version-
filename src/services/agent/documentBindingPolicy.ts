/** Shared-reference semantics; project source scopes remain explicit. */
export const DOCUMENT_BINDING_GUIDANCE = `已有资料是可复用引用，不是某个项目的独占文件。同一 documentId 可以同时绑定多个项目，包括不同根计划；已绑定项目 A 不妨碍再绑定项目 B、C。用户明确要求共用时直接准备追加绑定，不以“共用会稀释重点”“已属于另一计划”等无依据理由阻止。
先 query_local_documents 查询真实资料 ID 与全部现有绑定，再用 list_notes 确定目标项目稳定 ID；update_document_project_bindings 的 projectNoteIds 可一次填写多个目标，bind 只追加并保留原关联，共用同一原文件和索引，不复制、重新下载或解析。unbind 仅解除指定项目的直接引用，不影响其它项目，也不删除原文件。
用户只是问“是否绑定”时先只读核对状态；明确要求绑定后出示具体变更确认卡，saved=true 才能说已保存。新计划若仍在编辑器草案中，应如实说明保存生成项目 ID 后可追加绑定同一份资料；不能编造项目 ID、自动保存草案或因此否定多项目复用。各项目仍只使用自身直接绑定及祖先继承的资料，不会因为共用同一文件而自动合并项目范围。`;

/** Conservative offline fallback; the semantic router still resolves context. */
export function isExistingDocumentBindingRequest(text: string): boolean {
  return /(?:绑定|解绑|关联|解除关联|复用|共用|共享).{0,18}(?:资料|文档|教材|这本书|同一本书|PDF)|(?:资料|文档|教材|这本书|同一本书|PDF).{0,18}(?:绑定|解绑|关联|解除关联|复用|共用|共享)/iu.test(text)
    || /(?:资料|文档|教材|这本书|同一本书|PDF).{0,12}(?:也?用到|也?用于|也?用在).{0,14}(?:项目|计划)/iu.test(text);
}
