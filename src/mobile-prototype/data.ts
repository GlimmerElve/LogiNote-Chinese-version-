// Synthetic design fixtures. Never import the production vault, account or AI services here.
export type MobileTab = 'discover' | 'practice' | 'capture' | 'messages' | 'plan';
export type Reading = { id: string; title: string; category: string; minutes: number; summary: string; reason: string; sections: { heading: string; text: string }[] };
export const readings: Reading[] = [
  { id: 'retrieval', title: '为什么「想起来」比「再看一遍」更有效？', category: '学习方法', minutes: 4, summary: '从提取练习出发，重新理解熟悉感与真正掌握之间的距离。', reason: '与你的「学习科学」计划相关', sections: [
    { heading: '熟悉，不等于能够提取', text: '反复阅读时，内容就在眼前，理解往往显得毫不费力。可当资料合上，我们能否独立解释、在新问题中使用它，是另一件事。流畅的阅读体验并不能单独证明掌握。' },
    { heading: '先尝试回忆，再回看资料', text: '学完一小段后，暂时离开原文，用自己的话说清楚关键观点。再回看资料，核对遗漏和错误。这里的重点是主动提取与反馈，而不是机械复读。' },
    { heading: '给它一个具体的使用情境', text: '例如读完一段关于机会成本的笔记，尝试解释：周末选择加班时，你放弃的最有价值的替代选择是什么？解释具体情境，比重复定义更能暴露理解中的缺口。' },
    { heading: '留下一条自己的理解', text: '可以记录「我现在如何理解」「在哪些条件下成立」「还不确定什么」。这条记录属于你的个人认知，与作为参考依据的资料分开保存。' },
  ] },
  { id: 'bayes', title: '贝叶斯思维：有了新证据，如何改变判断', category: '思维模型', minutes: 6, summary: '把先验、证据与更新连成一条清晰的思考路径。', reason: '接着上次读到的内容', sections: [
    { heading: '从已有判断出发', text: '先验描述你在看到这条新证据之前的判断。它不是永远不变的立场，而是后续更新的起点。' },
    { heading: '证据的区分能力', text: '同一条证据是否更可能出现在某个假设成立的时候？如果证据在两个假设下都很常见，它通常不能有力地区分两者。' },
    { heading: '不要把更新等同于翻转', text: '新证据可以让信心适度增强或减弱，不必总是彻底改变结论。也要留意样本选择与证据的独立性。' },
  ] },
  { id: 'spacing', title: '间隔复习，把时间留给遗忘', category: '学习方法', minutes: 3, summary: '不必在一天内反复刷同一个知识点，让复习发生在合适的间隔。', reason: '为接下来的复习做准备', sections: [
    { heading: '把练习分散到不同时间', text: '与一次集中完成所有重复相比，分散练习让你在每次复习时重新提取。合适的间隔还取决于内容、已有基础和希望保持记忆的时长。' },
    { heading: '根据表现调整', text: '复习排期应结合真实表现。一次答对不等于全面掌握，一次失误也不等于需要从头开始。' },
  ] },
  { id: 'cost', title: '机会成本，不只是付出的金钱', category: '思维模型', minutes: 3, summary: '每一次选择，也意味着放弃另一个可能。', reason: '适合用一个小问题检查理解', sections: [
    { heading: '选择的另一面', text: '机会成本是被放弃的最佳替代选择的价值。它不是所有替代选择之和，也不只是实际支付的金钱。' },
    { heading: '从下一步行动看问题', text: '决定是否继续时，已经无法收回的支出与接下来可以改变的收益、成本要分别看待。明确可选项，再比较被放弃的那个最佳选择。' },
  ] },
];
export const questions = [
  { id: 'q1', source: 'retrieval', title: '提取练习', prompt: '读完一节内容后，哪种做法更能检查自己能否独立提取？', options: ['立即重读并标记熟悉的句子', '合上资料，用自己的话解释，再核对原文', '统计这一节读了多少遍'], correct: 1, explanation: '合上资料后的独立解释能暴露提取的缺口，回看原文则提供纠错反馈。单凭熟悉感或阅读次数不足以判断。' },
  { id: 'q2', source: 'cost', title: '机会成本', prompt: '周末你选择读书，原本也可去兼职或看电影。机会成本应如何理解？', options: ['兼职与看电影的价值总和', '仅包括买书的钱', '被放弃的最佳替代选择的价值'], correct: 2, explanation: '机会成本关注被放弃的最佳替代选择，而不是所有替代选择的总和。具体价值取决于你的实际可选项。' },
  { id: 'q3', source: 'spacing', title: '间隔复习', prompt: '某知识点今天答对一次，下一步最合理的做法是？', options: ['结合后续间隔中的表现继续检查', '直接认定已经长期掌握', '今天立刻重复二十次，之后不再复习'], correct: 0, explanation: '单次作答仅反映这一次的表现。间隔后的独立提取和反馈，能提供更多判断依据。' },
];
export type Task = { id: string; title: string; kind: '阅读' | '复述' | '简测'; minutes: number; day: string; done: boolean };
export const initialTasks: Task[] = [
  { id: 't1', title: '读懂提取练习的作用', kind: '阅读', minutes: 5, day: '今天', done: false },
  { id: 't2', title: '用自己的话解释一个思维模型', kind: '复述', minutes: 3, day: '今天', done: false },
  { id: 't3', title: '完成一组轻量简测', kind: '简测', minutes: 5, day: '今天', done: false },
];
export type Capture = { id: string; text: string; kind: '复述' | '认知' | '想法'; sourceId: string; at: string };
export type DemoMessage = { id: string; conversation: string; text: string; self: boolean };
export const conversations = [
  { id: 'lin', name: '林同学', avatar: '林', subtitle: '关于费曼学习法的一点想法', type: '私信', text: '我发现复述的时候，最难的是把「我懂了」变成一个具体的例子。你会怎么练习？' },
  { id: 'group', name: '每天一点学习科学', avatar: '学', subtitle: '一起分享今天的小发现', type: '共学群', text: '今天的讨论：你如何判断自己真的理解了一个概念？可以分享一个例子。' },
];
export const tabInfo: Record<MobileTab, { label: string; en: string; scene: string; actions: string[]; boundary: string }> = {
  discover: { label: '发现', en: 'DISCOVER', scene: '一张卡片，一个想法。', actions: ['左右滑动切换', '点击复述', '长按说话，点框打字'], boundary: '收起气泡保留草稿。' },
  practice: { label: '练习', en: 'PRACTICE', scene: '用三五分钟，检查一个知识点是否真的理解。', actions: ['逐题作答，提交后看解析', '回到对应资料', '保留作答进度'], boundary: '演示题只展示交互；正式版复用现有简测评价标准，不靠本地答对直接更新掌握度。' },
  capture: { label: '记录', en: 'CAPTURE', scene: '自己的理解，收在这里。', actions: ['查看记录', '继续草稿', '写一条'], boundary: '语音仍为交互演示，尚未录音。' },
  messages: { label: '消息', en: 'CONNECT', scene: '围绕学习，与同伴交流一个具体的问题。', actions: ['私信与共学群', '引用资料展开讨论', '从会话进入举报和屏蔽'], boundary: '社交消息与 AI 助手区分；正式版复用社区权限、举报和拉黑服务。演示消息不会发给他人。' },
  plan: { label: '计划', en: 'PLAN', scene: '看清今天的安排，让计划适应当下的时间。', actions: ['查看、完成或改期任务', '输入目标生成轻量草案', '预览调整，再确认应用'], boundary: '任务变更按版本提交；发生冲突时保留草案，不能用手机旧快照覆盖桌面整份计划。' },
};
