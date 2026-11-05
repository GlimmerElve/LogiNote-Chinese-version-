import assert from 'node:assert/strict';
import {
  buildConceptSearchQueries,
  buildBingSearchUrl,
  buildResourceSearchQuery,
  buildResourceSearchTabs,
  classifyBrowserResource,
  classifyDownload,
  cleanConceptEvidenceText,
  conceptEvidenceRelevanceScore,
  extractResourceCoreTerm,
  findResourceAuthContainerForUrl,
  inferResourceIsFree,
  isExpectedBingSearch,
  normalizeBrowserCandidates,
  safeAttachmentFileName,
  sanitizeSourcePageUrl,
  safeDownloadFileName,
} from '../src/electron/resourceBrowserCore.ts';

const bingUrl = new URL(buildBingSearchUrl('心理账户 心理学效应 概念'));
const expectedQuery = '心理账户 心理学效应 概念';
const validPage = { url: buildBingSearchUrl(expectedQuery), input: expectedQuery, resultText: '心理账户 - 百度百科', resultCount: 3, emptyResults: false };
assert.equal(isExpectedBingSearch(validPage, expectedQuery, '心理账户'), true);
assert.equal(isExpectedBingSearch({ ...validPage, resultText: '心理健康与心理咨询' }, expectedQuery, '心理账户'), false, '心理不等于心理账户');
assert.equal(isExpectedBingSearch({ ...validPage, resultText: '凯美瑞动力电池；恒大新闻' }, expectedQuery, '心理账户'), false, '正确q/input也不能证明首次结果正确');
assert.equal(isExpectedBingSearch({ ...validPage, resultText: '心理帐户效应' }, expectedQuery, '心理账户'), true);
assert.equal(isExpectedBingSearch({ ...validPage, url: buildBingSearchUrl('心理') }, expectedQuery, '心理账户'), false);
assert.equal(isExpectedBingSearch({ ...validPage, input: '心理' }, expectedQuery, '心理账户'), false);
assert.equal(isExpectedBingSearch({ ...validPage, url: 'https://bing.com.evil.invalid/search?q=x' }, expectedQuery, '心理账户'), false);
assert.equal(isExpectedBingSearch({ ...validPage, resultText: '', resultCount: 0 }, expectedQuery, '心理账户'), false);
assert.equal(isExpectedBingSearch({ ...validPage, resultText: '', resultCount: 0, emptyResults: true }, expectedQuery, '心理账户'), true);
assert.equal(bingUrl.origin, 'https://cn.bing.com');
assert.equal(bingUrl.searchParams.get('q'), '心理账户 心理学效应 概念');
assert.equal(bingUrl.searchParams.get('mkt'), 'zh-CN');
assert.equal(bingUrl.searchParams.get('cc'), 'CN');
assert.equal(bingUrl.searchParams.get('setlang'), 'zh-Hans');

const query = buildResourceSearchQuery({
  projectTitle: '多元微积分',
  rootProjectTitle: '30天掌握高等数学',
  taskText: '理解梯度与方向导数',
  knowledgeTitles: ['梯度', '方向导数'],
});
assert.equal(query, '多元微积分 高等数学 概念');
const semanticQuery = buildResourceSearchQuery({
  projectTitle: '机器学习入门',
  taskText: '解释 [[梯度下降]] 的收敛条件',
  knowledgeTitles: ['梯度下降'],
});
assert.equal(semanticQuery, '机器学习 概念');
assert.equal(extractResourceCoreTerm('学习心理账户：一种解释消费决策的心理机制'), '心理账户');
assert.equal(extractResourceCoreTerm('30天了解心理学效应'), '心理学效应');
assert.equal(extractResourceCoreTerm('全面掌握心理学效应'), '心理学效应');
assert.equal(buildResourceSearchQuery({ projectTitle: '学习效应', taskText: '理解概念', knowledgeTitles: ['学习效应'] }), '学习效应 概念');
assert.equal(buildResourceSearchQuery({
  projectTitle: '学习心理账户：钱在不同账户的心理价值不同',
  rootProjectTitle: '全面掌握心理学效应',
  taskText: '围绕项目整理学习资源',
  knowledgeTitles: ['学习心理账户：钱在不同账户的心理价值不同'],
}), '心理账户 心理学效应 概念', '知识点标题不能把已经清理掉的“学习”模板覆盖回来');
const resourceTabs = buildResourceSearchTabs({
  projectTitle: '学习心理账户：一种解释消费决策的心理机制',
  rootProjectTitle: '30天了解心理学效应',
  taskText: '理解 [[心理账户]]',
  knowledgeTitles: ['心理账户'],
});
assert.deepEqual(resourceTabs.map((tab) => tab.id), ['encyclopedia', 'video', 'materials', 'practice']);
assert.deepEqual(resourceTabs.map((tab) => tab.automaticTarget), [2, 3, 2, 2]);
assert.deepEqual(resourceTabs.map((tab) => tab.query), [
  '心理账户 心理学效应 概念',
  '心理账户 心理学效应 bilibili',
  '心理账户 心理学效应 PDF',
  '心理账户 心理学效应 案例',
]);
assert.ok(resourceTabs.every((tab) => tab.loaded === false));
assert.deepEqual(resourceTabs[1].variants?.map((variant) => variant.label), ['bilibili', 'MOOC', 'opencourse', '公开课']);
assert.deepEqual(resourceTabs[2].variants?.map((variant) => variant.label), ['PDF', 'PPT', '教材', '讲义']);

const conceptQueries = buildConceptSearchQueries('超限效应');
assert.equal(conceptQueries.length, 3);
assert.match(conceptQueries[0], /^"超限效应"/u);
const aliasedConceptQueries = buildConceptSearchQueries('心理账户', ['mental accounting', '心理账户', '心理会计']);
assert.deepEqual(aliasedConceptQueries.slice(3), ['"mental accounting" 定义 原理', '"心理会计" 定义 原理']);
assert.equal(
  conceptEvidenceRelevanceScore('超限效应', '超星', '提供课程和期刊服务'),
  0,
  '只共享“超”字的页面必须被拒绝',
);
assert.equal(
  conceptEvidenceRelevanceScore('超限效应', '超自然行动组', '游戏版本与隐私政策'),
  0,
  '相似前缀产品名不能作为概念证据',
);
assert.ok(
  conceptEvidenceRelevanceScore('超限效应', '心理学中的超限效应', '超限效应是一个待解释的概念') > 0,
  '完整词组命中标题或正文时才能进入证据候选',
);
assert.equal(conceptEvidenceRelevanceScore('C++', 'C 语言教程', '介绍 C 语言基础'), 0);
assert.ok(conceptEvidenceRelevanceScore('C++', 'C++ reference', 'C++ language reference') > 0);
assert.ok(
  conceptEvidenceRelevanceScore('心理账户', 'Mental accounting overview', 'Mental accounting explains spending decisions.', ['mental accounting']) > 0,
  '明确登记的别名应能补充召回英文或异名证据',
);
assert.equal(
  conceptEvidenceRelevanceScore('心理账户', '普通 accounting 教程', '只介绍 bookkeeping', ['mental accounting']),
  0,
  '别名也必须完整词组命中，不能退化为单词部分匹配',
);
const cleanedConceptEvidence = cleanConceptEvidenceText('超限效应', {
  description: '超限效应：过度刺激下的心理反弹。',
  blocks: [
    '登录 注册 下载客户端 隐私政策 版权所有',
    '首页 新闻 校园动态 热门推荐 相关阅读',
    '一、核心定义：下面说明这一心理现象。',
    '超限效应是指外界刺激过多、过强或持续时间过久后产生不耐烦或逆反的现象。',
    '它的核心是刺激超过个体可承受的限度。',
    '相关推荐：校园活动通知和新闻列表。',
  ],
}, 500);
assert.match(cleanedConceptEvidence, /超限效应是指/u);
assert.match(cleanedConceptEvidence, /核心定义/u);
assert.doesNotMatch(cleanedConceptEvidence, /下载客户端|热门推荐|相关推荐/u);
assert.ok(cleanedConceptEvidence.length <= 500);
assert.equal(cleanConceptEvidenceText('超限效应', {
  blocks: ['超星平台提供课程和期刊服务。', '超自然行动组是一款游戏。'],
}), '');
assert.match(cleanConceptEvidenceText('心理账户', {
  blocks: ['Mental accounting is a theory describing how people categorize and evaluate economic outcomes.'],
}, 500, ['mental accounting']), /Mental accounting/u);

const candidates = normalizeBrowserCandidates([
  { title: ' 搜索结果 PDF ', url: 'https://example.com/files/gradient.pdf#page=2' },
  { title: '重复结果', url: 'https://example.com/files/gradient.pdf' },
  { title: '搜索站自身', url: 'https://www.bing.com/search?q=gradient' },
  { title: '脚本协议', url: 'javascript:alert(1)' },
  { title: '带登录令牌', url: 'https://example.com/private.pdf?access_token=secret' },
  { title: '课程页面', url: 'https://course.example.org/gradient' },
]);
assert.equal(candidates.length, 2);
assert.equal(candidates[0].url, 'https://example.com/files/gradient.pdf');
assert.equal(candidates[0].downloadable, true);
assert.equal(candidates[0].fileType, 'pdf');
assert.equal(candidates[1].downloadable, false);
const prioritized = normalizeBrowserCandidates([
  { title: '普通导航', url: 'https://example.com/home' },
  { title: '课程演示', url: 'https://example.com/slides.pptx', detectedFrom: 'link' },
  { title: '正文文章', url: 'https://example.com/article', hintType: 'article', detectedFrom: 'page' },
], 2);
assert.deepEqual(prioritized.map((item) => item.resourceType), ['presentation', 'article']);
assert.deepEqual(classifyDownload('https://example.com/readme.markdown'), { downloadable: true, fileType: 'md' });
assert.equal(inferResourceIsFree('https://example.com/readme.pdf', true), true);
assert.equal(inferResourceIsFree('https://en.wikipedia.org/wiki/Gradient', false), true);
assert.equal(inferResourceIsFree('https://example.com/course-preview', false), undefined);
const presentation = classifyBrowserResource({
  title: '课程讲义',
  url: 'https://example.com/download?id=1',
  contentType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  downloadName: 'lesson.pptx',
  detectedFrom: 'link',
});
assert.equal(presentation.resourceType, 'presentation');
assert.equal(presentation.fileType, 'office');
assert.equal(presentation.isAttachment, true);
assert.equal(presentation.downloadable, true);
assert.equal(presentation.indexable, true);
assert.equal(presentation.fileExtension, 'pptx');
const video = classifyBrowserResource({ title: '演示视频', url: 'https://www.youtube.com/watch?v=123', hintType: 'video' });
assert.equal(video.resourceType, 'video');
assert.equal(video.fileType, 'video');
const mimePdf = classifyBrowserResource({ title: '无扩展名讲义', url: 'https://example.com/download?id=2', contentType: 'application/pdf' });
assert.equal(mimePdf.resourceType, 'pdf');
assert.equal(mimePdf.downloadable, true);
assert.equal(
  sanitizeSourcePageUrl('https://example.com/oauth/callback?code=secret&state=session#done'),
  'https://example.com/oauth/callback',
);
assert.equal(sanitizeSourcePageUrl('javascript:alert(1)'), undefined);
const authContainers = [{
  id: 'auth-0123456789abcdef',
  name: 'Example',
  origin: 'https://www.example.com',
  partition: 'persist:resource-auth-auth-0123456789abcdef',
  createdAt: '2026-01-01T00:00:00.000Z',
  lastUsedAt: '2026-01-01T00:00:00.000Z',
}];
assert.equal(
  findResourceAuthContainerForUrl(authContainers, 'https://www.example.com/course/1?chapter=2')?.id,
  'auth-0123456789abcdef',
);
assert.equal(findResourceAuthContainerForUrl(authContainers, 'https://learn.example.com/course/1'), undefined);
assert.equal(findResourceAuthContainerForUrl(authContainers, 'http://www.example.com/course/1'), undefined);
assert.equal(findResourceAuthContainerForUrl(authContainers, 'javascript:alert(1)'), undefined);
assert.equal(safeDownloadFileName('梯度/讲义', 'https://example.com/download', 'pdf'), '梯度_讲义.pdf');
assert.equal(
  safeAttachmentFileName('课程演示', 'https://example.com/download?id=3', 'lesson.pptx', 'pptx'),
  'lesson.pptx',
);

console.log('resource browser core checks passed');
