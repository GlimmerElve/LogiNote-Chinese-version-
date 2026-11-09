/** Independent mobile task fixtures. No production schedule or mastery writes. */
export type MobileTaskKind = '阅读' | '复述' | '简测' | '待办' | '桌面任务';
export type MobileTask = {
  id: string;
  title: string;
  plan: string;
  kind: MobileTaskKind;
  day: string;
  minutes: number;
  done: boolean;
  materialId?: string;
};

export function mobileDate(date = new Date()): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

export function initialMobileTasks(): MobileTask[] {
  const tomorrow = new Date(); tomorrow.setDate(tomorrow.getDate() + 1);
  return [
    { id: 'mobile-read-derivative', title: '读懂导数与变化率', plan: '高等数学', kind: '阅读', day: mobileDate(), minutes: 15, done: false, materialId: 'derivative' },
    { id: 'mobile-recap-retrieval', title: '用自己的话解释主动回忆', plan: '学习方法', kind: '复述', day: mobileDate(), minutes: 5, done: false, materialId: 'retrieval' },
    { id: 'mobile-organize-photos', title: '整理今天的课堂照片', plan: '日常学习', kind: '待办', day: mobileDate(), minutes: 10, done: false },
    { id: 'mobile-quick-check', title: '检验提取练习的理解', plan: '学习方法', kind: '简测', day: mobileDate(tomorrow), minutes: 10, done: false, materialId: 'retrieval' },
  ];
}

export function mobileWeek(date = new Date()): { start: string; end: string } {
  const start = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  start.setDate(start.getDate() - (start.getDay() + 6) % 7);
  const end = new Date(start); end.setDate(end.getDate() + 6);
  return { start: mobileDate(start), end: mobileDate(end) };
}
