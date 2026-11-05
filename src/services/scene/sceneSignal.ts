/**
 * 场景对话文本标记解析（零额外 LLM 调用）。
 *
 * 角色流式回复中，两类标记由本模块剥离，不作为正文展示：
 * 1. 结局标记 `[结束:原因]`（仅出现在末尾）→ 由系统判定对话结束
 * 2. 动作描写 `*...*` → 拆为独立的 action 消息，斜体灰字渲染
 *
 * 解析范式复用 reviewSegmentScoring 的 parseIntentMarker（同样以「末尾方括号标记」为约定）。
 */

/** 结局标记：`[结束:原因]` 或 `[结束：原因]`，只认末尾（允许尾部空白） */
const END_MARKER_PATTERN = /\[结束[:：]([\s\S]*?)\]\s*$/;

/** 动作描写：`*...*`，不跨行、内容非空、不支持嵌套星号 */
const ACTION_PATTERN_SOURCE = '\\*([^*\\n]+)\\*';

/** 结局标记解析结果 */
export interface EndMarkerResult {
  /** 剥离标记后的正文（已 trim） */
  content: string;
  /** 命中结局标记时给出原因 */
  endSignal?: { reason: string };
}

/** 动作描写解析结果 */
export interface ActionsResult {
  /** 剥离动作后的正文 */
  content: string;
  /** 抽出的动作描写（保持出现顺序，已 trim） */
  actions: string[];
}

/** 一轮角色回复的完整拆分结果 */
export interface RoleReplyParts {
  /** 正文（已剥离结局标记与动作） */
  content: string;
  /** 动作描写列表 */
  actions: string[];
  /** 结局标记（若有） */
  endSignal?: { reason: string };
}

/**
 * 剥离并解析末尾的 `[结束:原因]`。
 * 未命中时原样返回（仅 trim），不抛错、不做其他清洗。
 */
export function parseEndMarker(text: string): EndMarkerResult {
  const raw = typeof text === 'string' ? text : '';
  const match = raw.match(END_MARKER_PATTERN);
  if (!match) return { content: raw.trim() };

  const reason = (match[1] || '').trim();
  const content = raw.slice(0, match.index).trim();
  return { content, endSignal: { reason: reason || '对话已结束' } };
}

/**
 * 抽出 `*动作*` 并从正文移除。
 * 移除后可能出现连续空行，统一压缩为单空行再 trim。
 */
export function parseActions(text: string): ActionsResult {
  const raw = typeof text === 'string' ? text : '';
  const actions: string[] = [];
  // 每次调用新建正则，避免模块级 g 标志的 lastIndex 状态在重入时相互干扰
  const re = new RegExp(ACTION_PATTERN_SOURCE, 'g');

  const content = raw
    .replace(re, (_full, inner: string) => {
      const action = (inner || '').trim();
      if (action) actions.push(action);
      return '';
    })
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  return { content, actions };
}

/**
 * 一轮角色回复的完整拆分：先剥离结局标记，再抽动作描写。
 * 顺序不可颠倒——结局标记约定在末尾，先剥离可避免其被误判为动作内容。
 */
export function splitRoleReply(text: string): RoleReplyParts {
  const endParsed = parseEndMarker(text);
  const actionParsed = parseActions(endParsed.content);
  return {
    content: actionParsed.content,
    actions: actionParsed.actions,
    endSignal: endParsed.endSignal,
  };
}

/**
 * 通用行为场景保留 Markdown 星号，只兼容剥离旧式结束标记。
 * 不能复用 splitRoleReply：`**题目**` 会被 NPC 的 `*动作*` 语法误删。
 */
export function splitGeneralTurnReply(text: string): RoleReplyParts {
  const endParsed = parseEndMarker(text);
  return {
    content: endParsed.content,
    actions: [],
    endSignal: endParsed.endSignal,
  };
}
