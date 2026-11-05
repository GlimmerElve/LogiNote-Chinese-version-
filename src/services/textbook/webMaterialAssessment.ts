/** Read-only assessment. Never rewrite frozen evidence, formulas or code. */
const administrativeHeader = /开课|选课|授课|高校|教师|课时|课程周期|课程状态|课程平台|参考答案|其他答案|文件下载|下载地址|资源链接|课件下载|教学安排/iu;
const onlyLinkCell = /^(?:下载|查看|点击|链接|download|click|答案|附件|pdf|pptx?|docx?)(?:[\s（(][\s\S]*)?$/iu;
const display = (value: string) => value.replace(/\\([|*_#\[\]\-:.])/gu, '$1').replace(/\[([^\]]+)\]\([^)]*\)/gu, '$1').replace(/<[^>]*>/gu, '')
  .replace(/^\s{0,3}#{1,6}\s*/gmu, '').replace(/\*\*/gu, '').trim();
export interface TeachingTableRange { start: number; end: number }
export function teachingTableRanges(text: string): TeachingTableRange[] {
  const lines: Array<{ raw: string; start: number; end: number; cells: string[] }> = [];
  let offset = 0, fence = '', fenceLength = 0;
  for (const raw of text.split('\n')) {
    const match = /^ {0,3}(`{3,}|~{3,})(.*)$/u.exec(raw);
    if (match) {
      if (!fence && (match[1][0] === '~' || !match[2].includes('`'))) {
        fence = match[1][0]; fenceLength = match[1].length;
      } else if (match[1][0] === fence && match[1].length >= fenceLength && /^[\t\r ]*$/u.test(match[2])) {
        fence = ''; fenceLength = 0;
      }
    }
    const plain = display(raw);
    const cells = !fence && !match && plain.includes('|') ? plain.replace(/^\|/u, '').replace(/\|$/u, '').split('|').map(c => c.trim()) : [];
    lines.push({ raw, start: offset, end: offset + raw.length, cells }); offset += raw.length + 1;
  }
  const ranges: TeachingTableRange[] = [];
  for (let i = 0; i < lines.length - 2; i++) {
    const header = lines[i].cells, divider = lines[i + 1].cells;
    if (header.length < 2 || divider.length !== header.length || !divider.every(c => /^:?-{2,}:?$/u.test(c)) || administrativeHeader.test(header.join(' '))) continue;
    let end = i + 2;
    while (end < lines.length && lines[end].cells.length >= 2) end++;
    const rows = lines.slice(i + 2, end).map(l => l.cells);
    if (!rows.length) continue;
    const values = rows.flat().filter(Boolean);
    if (!values.length || values.filter(c => onlyLinkCell.test(c) || /^https?:\/\//iu.test(c)).length >= values.length / 2) continue;
    ranges.push({ start: lines[i].start, end: lines[end - 1].end }); i = end - 1;
  }
  return ranges;
}
export function hasTeachingTable(text: string): boolean { return teachingTableRanges(text).length > 0; }

/** Course landing pages can be recommended as links, but are not lecture text.
 * A real lesson that mentions a syllabus keeps its substantive teaching prose. */
export function textbookTeachingBodyIssue(text: string): string | undefined {
  const plain = display(text.replace(/```[^\n]*\n[\s\S]*?```/gu, ''));
  const paragraphs = plain.split(/\n\s*\n/u).filter(p => p.length >= 80 && !p.includes('|') && /[。！？.!?;]/u.test(p)
    && !/^(?:[-*]\s|\d+[.、]\s|#{1,6}\s)/u.test(p));
  const proseChars = paragraphs.reduce((sum, p) => sum + p.length, 0);
  const metadata = (plain.match(/开课平台|开课高校|开课教师|开课时间|课程周期|开课状态|选课人数|人选课/gu) || []).length;
  const bookMetadata = (plain.match(/(?:书名|题名|作者|出版社|出版发行|主题词|中图分类法)\s*[:：]|ISBN(?:\s*[:：]|\s*\n)|馆藏|索书号|借阅|(?:^|\n)\s*(?:出版时间|出版社|页\s*数|开\s*本|装\s*帧|译\s*者|作\s*者)\s*(?:\n|[:：])/gimu) || []).length;
  const intro = /(?:^|\n)\s*课程简介\s*(?:\n|$)/u.test(plain);
  const outline = /课程大纲|课程目录|预修课程|教学目的、要求|主讲老师|课程内容/gu.test(plain);
  if ((metadata >= 2 || intro && outline) && proseChars < 1400) return '课程介绍、教学大纲或下载索引不是讲授正文，已跳过';
  if (bookMetadata >= 3 && proseChars < 1400) return '书目、馆藏或借阅介绍不是教材原文，已跳过';
  const links = (plain.match(/(?:^|[\s|])(?:下载|查看附件|点击下载)(?:$|[\s|])/gu) || []).length;
  if (links >= 4 && proseChars < 600 && !hasTeachingTable(text)) return '该页主要是下载索引，未取得可讲授正文';
  return undefined;
}
