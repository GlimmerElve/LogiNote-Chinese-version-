import { FlowSettings } from '../types';

/** 心流设置持久化（localStorage），与心流会话记录无关。 */

const FLOW_SETTINGS_KEY = 'loginote_flow_settings';

/** 获取默认心流设置 */
export function getDefaultFlowSettings(): FlowSettings {
  return {
    reviewIntervalMinutes: 20,
    whiteNoiseType: 'none',
    whiteNoiseVolume: 0.4,
    autoStartReview: false,
  };
}

/** 读取心流设置（合并默认值确保字段完整性） */
export function getFlowSettings(): FlowSettings {
  try {
    const raw = localStorage.getItem(FLOW_SETTINGS_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      return { ...getDefaultFlowSettings(), ...parsed };
    }
  } catch { /* ignore */ }
  return getDefaultFlowSettings();
}

/** 保存心流设置 */
export function saveFlowSettings(s: FlowSettings): void {
  localStorage.setItem(FLOW_SETTINGS_KEY, JSON.stringify(s));
}