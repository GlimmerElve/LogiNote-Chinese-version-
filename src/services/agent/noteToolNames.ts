/** General workspace primitives, not a grant to bypass a domain's managed content or confirmation. */
export const GENERAL_NOTE_TOOLS = ['list_notes', 'read_notes', 'update_note'] as const;
export const GENERAL_NOTE_GUIDANCE = `【通用笔记操作】
本轮激活的Skill负责专业流程，不代替用户当前目标。用户明确要求修改已有笔记或把刚讨论的内容替换进笔记时，通用助手仍可使用list_notes/read_notes/update_note，不必先开其它Skill或让用户手动粘贴。
先读取真实目标稳定ID和当前正文，只替换唯一匹配的oldText；长正文按工具分页读取，不能把记忆或当前页面标题当成完整原文。读不全、对象不明确或重复片段时先定位，不能整篇盲写。调用update_note提交具体改动确认卡，只有用户确认且saved=true才说已保存。
笔记正文编辑不授权改教材受管区域、计划任务身份、复盘/论证控制块、个人认知或掌握度；这些仍走各自专用工具和审批。看到工具尚未加载的错误时按提示先discover_agent_capabilities取得真实定义，不原样重试，不把未加载说成软件没有写入通道。`;
