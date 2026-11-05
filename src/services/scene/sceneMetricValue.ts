/**
 * 指标值的纯语义模块（零依赖，只引类型）。
 *
 * 为何单独成文件：指标的「默认值 → 规范值 → 是否达标/失败」判定口径被三处共用
 * （sceneRuntime 初始化 / metricEngine 归一化与成败判定 / SceneMetricPanel 展示）。
 * 抽到此处可单一实现、多方复用，且**不引入 llmService**——否则 sceneRuntime
 * 这个声明「不调 LLM、不读写磁盘」的纯状态模块会被污染。
 *
 * 统一口径：
 * - boolean：取等值
 * - 数值型：达标取 >=，失败取 <=
 * - 其余（离散/集合/字符串）：取等值
 */

import { MetricSpec, MetricValue } from '../../types';

/**
 * 按指标定义生成默认初值（未设置 initial 时使用）。
 * 连续/计数/时间型缺省 0，布尔型缺省 false，离散/集合型缺省首个选项或空串。
 */
export function defaultMetricValue(spec: MetricSpec): MetricValue['value'] {
  if (spec.initial !== undefined && spec.initial !== null) return spec.initial;
  switch (spec.type) {
    case 'boolean':
      return false;
    case 'discrete':
    case 'set':
      return spec.options?.[0] ?? '';
    default:
      return 0;
  }
}

/**
 * 规范化指标值（边界⑬⑮）：
 * - 连续/计数/时间型：转数字，按 range clamp；无法转数字则退回原值
 * - 布尔型：转布尔
 * - 离散/集合型：命中 options 则保留；否则按包含关系模糊匹配，
 *   仍找不到则回退 options[0]（不丢弃该指标）
 */
export function clampMetricValue(metricSpec: MetricSpec, value: MetricValue['value']): MetricValue['value'] {
  switch (metricSpec.type) {
    case 'boolean':
      return value === true || value === 'true';

    case 'discrete':
    case 'set': {
      const options = metricSpec.options || [];
      if (options.length === 0) return value;
      const asStr = String(value);
      if (options.includes(asStr)) return asStr;
      const loose = options.find((o) => o.includes(asStr) || asStr.includes(o));
      return loose ?? options[0];
    }

    default: {
      // continuous / count / time
      const num = typeof value === 'number' ? value : Number(value);
      if (!Number.isFinite(num)) return value;
      if (metricSpec.range) {
        const [min, max] = metricSpec.range;
        return Math.min(max, Math.max(min, num));
      }
      return num;
    }
  }
}

/** 指标值是否达标 */
export function isMetricMet(metricSpec: MetricSpec, value: MetricValue['value']): boolean {
  if (metricSpec.type === 'boolean') return value === metricSpec.target;
  if (typeof value === 'number' && typeof metricSpec.target === 'number') {
    return value >= metricSpec.target;
  }
  return String(value) === String(metricSpec.target);
}

/** 指标值是否触发失败阈值（仅有 failureThreshold 时生效） */
export function isMetricFailed(metricSpec: MetricSpec, value: MetricValue['value']): boolean {
  if (metricSpec.failureThreshold === undefined) return false;
  if (typeof value === 'number' && typeof metricSpec.failureThreshold === 'number') {
    return value <= metricSpec.failureThreshold;
  }
  return String(value) === String(metricSpec.failureThreshold);
}