/** The complete network whitelist. Raw profiles and timelines never cross this boundary. */
export const LEARNING_METRICS=['streak','activeDaysThisMonth','avgDailyMinutes'] as const;
export type LearningMetric=typeof LEARNING_METRICS[number];
export const DEFAULT_LEARNING_METRICS:LearningMetric[]=['streak','activeDaysThisMonth'];
export type LearningStatisticsPolicy={enabled:boolean;metrics:LearningMetric[];scope:'public'|'groups';groupIds:string[];sourceDeviceId:string|null;revision:number};
export type LearningStatisticsValues=Partial<Record<LearningMetric,number>>;
export type LearningStatisticsSnapshot={state:'ready'|'empty'|'unavailable';asOfDate:string;timeZone:string;computedAt:string;calculationVersion:'loginote-learning-v1';values:LearningStatisticsValues};
export type DisplayedLearningStatistics=LearningStatisticsSnapshot&{updatedAt:string};
export type OwnLearningStatistics={policy:LearningStatisticsPolicy;snapshot:DisplayedLearningStatistics|null;sourceConnected:boolean};
export const learningMetricLabels:Record<LearningMetric,string>={streak:'连续学习',activeDaysThisMonth:'本月活跃',avgDailyMinutes:'日均学习'};
export const learningMetricUnits:Record<LearningMetric,string>={streak:'天',activeDaysThisMonth:'天',avgDailyMinutes:'分钟'};
export function statisticsDate(date:Date,timeZone:string){
  const parts=new Intl.DateTimeFormat('en-US',{timeZone,year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(date);
  const part=(type:string)=>parts.find(item=>item.type===type)!.value;
  return `${part('year')}-${part('month')}-${part('day')}`;
}
