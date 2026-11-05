/** Isolated synthetic fixtures. Never imported into material selection or user notes. */
export const visualMindmap = 'mindmap\n  root((心理账户))\n    分类信息\n      金钱来源\n      用途标签\n    判断边界\n      核对评价条件\n      保留未知信息';
export const visualBoundaryFlow = 'flowchart TD\nV1["先列分类和评价条件"] --> V2{"信息是否明确"}\nV2 -->|否| V3["先补充信息"]\nV2 -->|是| V4["结合条件解释案例"]';
export const visualPracticeFlow = 'flowchart LR\nV1["列出题干事实"] --> V2["对照本章条件"]\nV2 --> V3["写出理由和未知事项"]';
export const visualSequence = 'sequenceDiagram\nparticipant V1 as 学习者\nparticipant V2 as 参考材料\nV1->>V2: 核对概念和条件\nV2-->>V1: 提供原文依据\nV1->>V1: 写出理由与未知信息';
export const visualFence = (language: string, code: string) => `\`\`\`${language}\n${code}\n\`\`\``;
export const visualTimeline = 'timeline\n  title 合成阶段演进示例\n  section 前期\n    起始阶段 : 确定问题\n      : 明确观察对象\n    探索阶段 : 对照已有材料\n  section 后期\n    形成阶段 : 组织概念关系\n    验证阶段 : 核对证据与边界\n    迁移阶段 : 解释新情境';
