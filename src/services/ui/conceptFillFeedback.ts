import { readSafeLlmHttpFailure } from '../llmHttpFailure';

/** Explain known failures without echoing provider responses, credentials or local paths. */
export function conceptFillFailureReason(error: unknown): string {
  const message = error instanceof Error ? error.message : typeof error === 'string' ? error : '';
  const http = readSafeLlmHttpFailure(message);
  if (http) return http.detail;
  const exact = [
    '当前环境不支持隔离浏览器概念检索',
    '本地笔记与资料库中没有检索到相关证据',
    '没有检索到可公开访问且内容足够的概念来源',
    '没有检索到可用于概念补全的证据',
    'LLM 未返回概念草稿',
    '概念草稿没有引用任何检索证据，请重试',
    '概念草稿输出被截断，未写入；请检查模型输出额度后重试',
    '未找到可用的 LLM 服务商，请在设置中配置并启用至少一个。',
    '概念研究浏览器未能完成搜索',
    '概念研究浏览器未能初始化',
    '搜索页面加载超时',
    'Bing 页面内搜索提交超时',
  ];
  // IPC can prepend a transport wrapper; only the fixed diagnostic is displayed.
  const known = exact.find(text => message === text || message.endsWith(`Error: ${text}`));
  if (known) return known;
  if (/概念草稿引用了不存在的来源：/u.test(message)) return '模型生成的草稿引用了不存在的来源，未作为可用草稿保留。';
  if (/模型在思考阶段耗尽了输出额度，未生成最终正文/u.test(message)) return '模型在思考阶段耗尽了输出额度，未生成最终正文。';
  if (/模型供应商拦截了概念草稿/u.test(message)) return '模型服务拦截了本次生成，请检查模型设置。';
  if (/模型供应商中断了本次生成/u.test(message)) return '模型服务中断了本次生成，请稍后重试。';
  if (/模型供应商返回的最终正文为空/u.test(message)) return '模型返回的最终正文为空，请重试或更换模型。';
  if (/搜索引擎返回了 \d+ 个候选，但没有页面完整命中/u.test(message)) return '搜索结果未完整匹配概念标题或已登记别名，请检查名称或补充别名。';
  if (/搜索引擎没有返回.+的可读取候选/u.test(message)) return '搜索引擎没有返回可读取候选，请检查网络或补充概念别名。';
  if (/隔离浏览器未能读取到足够正文/u.test(message)) return '已找到相关网页，但未取得足够正文；页面可能需要登录、验证码或受到脚本限制。';
  if (/Failed to fetch|fetch failed|ERR_(?:INTERNET_DISCONNECTED|NAME_NOT_RESOLVED|CONNECTION|TIMED_OUT)|ECONNRESET|ETIMEDOUT/iu.test(message)) return '网络连接失败或请求超时，请检查网络后重试。';
  if (error instanceof Error && error.name === 'AbortError') return '本次检索或生成已停止。';
  return '检索或生成未完成，请检查资料来源和模型设置后重试。';
}

export function conceptFillFailureFeedback(error: unknown, hasDraft: boolean): string {
  return `${conceptFillFailureReason(error)} ${hasDraft
    ? '上一份草稿仍在下方“概念草稿”区域，可继续确认写入或清除；没有新增草稿。'
    : '本次未生成可用草稿，没有新增草稿缓存；笔记未修改。'}`;
}
