import type { ProfileInsight, KnowledgePointMasteryResult } from '../../types';
import type { FlowAnalysisInput, FlowAnalysisReport } from './types';
import type { ArgDoc } from '../argumentDoc/types';
import { runProductionFlowAnalysisV2, type FlowReviewAnalysisResultV2 } from './productionV2';

export type FlowAnalysisProgressStage = 'evidence' | 'summary';

/**
 * 心流复盘唯一生产入口：新版论证解构与参考评价。
 * 不保留旧九类分析的执行或自动回退路径；历史报告仍使用兼容结果类型读取。
 */
export async function runFlowAnalysis(
  input: FlowAnalysisInput,
  masteryResults: KnowledgePointMasteryResult[] = [],
  onProgress?: (stage: FlowAnalysisProgressStage) => void,
): Promise<{ report: FlowAnalysisReport; profileInsight: ProfileInsight; serviceError?: string; argumentDoc?: ArgDoc;
  analysisV2: FlowReviewAnalysisResultV2 }> {
  return runProductionFlowAnalysisV2(input, masteryResults, onProgress);
}
