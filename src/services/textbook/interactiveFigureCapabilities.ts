import { wantsLocalGearFigure, type ExternalGearFacts } from './interactiveGearFigure';
import { wantsLocalLruFigure, type LruFacts } from './interactiveLruFigure';
import { wantsLocalThresholdFigure, type ThresholdSample } from './interactiveThresholdFigure';
import { extractCoinProbability, wantsLocalProbabilityFigure } from './interactiveProbabilityFigure';
import { wantsInteractiveFunction } from './interactiveFunctionFigure';
import { selectFigureRenderer, type FigureRenderer } from './interactiveFigureDesign';

export type FigureComponentId = 'gear'|'lru'|'threshold'|'coin'|'function'|'generic';
export interface FigureCapability { id:FigureComponentId; purpose:string; required:string; limits:string }
/** Capability descriptions are guidance, not evidence or authorization to invent values. */
export const FIGURE_CAPABILITIES: Readonly<Record<FigureComponentId,FigureCapability>> = {
  gear:{id:'gear',purpose:'理想外啮合齿轮转向和转数',required:'资料明确外啮合及主动轮、从动轮齿数',limits:'只作理想二维示意，不推断未知齿数'},
  lru:{id:'lru',purpose:'LRU 命中、顺序与淘汰',required:'资料明确初始顺序、命中和淘汰规则',limits:'仅限明确的小型示例'},
  threshold:{id:'threshold',purpose:'二分类阈值、误报与漏报',required:'资料明确分数、真实标签和达到阈值判正规则',limits:'仅限可识别的二分类样本'},
  coin:{id:'coin',purpose:'硬币理论概率与抽样频数',required:'资料明确公平硬币或正面概率',limits:'仅限正面概率在 0 与 1 之间；独立性是模拟假设'},
  function:{id:'function',purpose:'单自变量函数、曲线和参数观察',required:'教材明确函数关系、变量和适当的观察区间',limits:'模型输出的数据需通过本地解析与定义域检查'},
  generic:{id:'generic',purpose:'一般机制交互示意',required:'依据教材明确的论断、操作与观察',limits:'缺少规则时仅作标明假设的示意，不捏造事实'},
};
export interface FigureComponentSelection {
  component:FigureComponentId; renderer:FigureRenderer; gearFacts?:ExternalGearFacts; lruFacts?:LruFacts;
  thresholdFacts?:ThresholdSample[]; probability?:number; functionMode:boolean;
}
/** Conservative host-side routing; a description match alone never supplies facts. */
export function selectFigureComponent(brief:string, lesson:string, wholePage=false):FigureComponentSelection {
  const selectedRenderer=selectFigureRenderer(brief);
  const implicitIso=selectedRenderer==='anatomy-iso' && !/(等轴测|等距视角|立体示意)/u.test(brief);
  const simpleRenderer=implicitIso?'svg-2d':selectedRenderer;
  const gearFacts=wantsLocalGearFigure(brief,lesson,simpleRenderer,wholePage);
  const lruFacts=!gearFacts?wantsLocalLruFigure(brief,lesson,simpleRenderer,wholePage):undefined;
  const thresholdFacts=!gearFacts&&!lruFacts?wantsLocalThresholdFigure(brief,lesson,selectedRenderer,wholePage):undefined;
  const probability=!gearFacts&&!lruFacts&&!thresholdFacts?wantsLocalProbabilityFigure(brief,lesson,selectedRenderer,wholePage):undefined;
  const renderer=gearFacts||lruFacts||thresholdFacts||probability!==undefined?'svg-2d':selectedRenderer;
  const functionMode=!gearFacts&&!lruFacts&&!thresholdFacts&&probability===undefined && renderer==='svg-2d' && wantsInteractiveFunction(brief,lesson,wholePage);
  const component:FigureComponentId=gearFacts?'gear':lruFacts?'lru':thresholdFacts?'threshold':probability!==undefined?'coin':functionMode?'function':'generic';
  return {component,renderer,gearFacts,lruFacts,thresholdFacts,probability,functionMode};
}
export function figureCapabilityGuidance(id:FigureComponentId):string {
  const item=FIGURE_CAPABILITIES[id];
  return `已选组件：${item.purpose}。所需依据：${item.required}。边界：${item.limits}。`;
}
/** A model suggestion is advisory. Require exact original wording and a
 * consistent, independently parsed probability from the whole supplied lesson. */
export function verifiedCoinCandidate(value:unknown, brief:string, lesson:string):number | undefined {
  if (!/(硬币|钱币|投币)/u.test(brief) || !/(比例|频率|频数|概率|随机|抽样|样本|观察)/u.test(brief)) return;
  if (!value || typeof value!=='object' || Array.isArray(value)) return;
  const item=value as Record<string,unknown>;
  if (Object.keys(item).some(key=>!['type','probability','quote'].includes(key)) || item.type!=='coin'
    || typeof item.probability!=='number' || !Number.isFinite(item.probability)
    || typeof item.quote!=='string' || item.quote.length<4 || item.quote.length>200 || !lesson.includes(item.quote)) return;
  const fromQuote=extractCoinProbability(item.quote), fromLesson=extractCoinProbability(lesson);
  return fromQuote!==undefined && fromLesson!==undefined && fromQuote===fromLesson && fromQuote===item.probability ? fromQuote : undefined;
}
