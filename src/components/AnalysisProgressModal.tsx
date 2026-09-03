import React, { useEffect, useState } from 'react';
import { Sparkles, Check, Loader2, WifiOff, Brain } from 'lucide-react';

export type AnalysisPhase = 'mastery' | 'evidence' | 'summary';

const STEPS = ['识别知识点', '掌握度评分', '五路画像证据', '综合分析总结'];

const TIPS = [
  '正在拆解你的思考…',
  '正在为每个知识点打分…',
  'AI 正在整理证据链…',
  '正在归纳你的表达习惯…',
  '快好了，综合建议生成中…',
];

interface AnalysisProgressModalProps {
  phase: AnalysisPhase;
  /** 是否判定为「未连接 AI / 请求全部失败」 */
  offline: boolean;
}

export const AnalysisProgressModal: React.FC<AnalysisProgressModalProps> = ({ phase, offline }) => {
  const [tipIndex, setTipIndex] = useState(0);

  useEffect(() => {
    const t = setInterval(() => setTipIndex((i) => (i + 1) % TIPS.length), 1600);
    return () => clearInterval(t);
  }, []);

  const stepStatus = (idx: number): 'done' | 'active' | 'pending' => {
    if (offline) return idx === 0 ? 'done' : 'pending'; // 离线时仅「识别知识点」已完成
    if (idx === 0) return 'done'; // 选择面板已识别完
    if (phase === 'mastery') return idx === 1 ? 'active' : 'pending';
    if (phase === 'evidence') return idx <= 1 ? 'done' : idx === 2 ? 'active' : 'pending';
    if (phase === 'summary') return idx <= 2 ? 'done' : idx === 3 ? 'active' : 'pending';
    return 'pending';
  };

  return (
    <div className="fixed inset-0 z-[400] flex items-center justify-center bg-slate-900/60 backdrop-blur-sm">
      <div className="w-full max-w-md mx-4 rounded-3xl bg-white dark:bg-slate-900 shadow-2xl border border-slate-200 dark:border-slate-700 p-7">
        {/* 头部动感图标 + 标题 */}
        <div className="flex flex-col items-center text-center mb-6">
          <div className="relative">
            <div className="w-16 h-16 rounded-2xl bg-gradient-to-br from-indigo-500 to-violet-500 flex items-center justify-center shadow-lg shadow-indigo-500/30">
              {offline ? <WifiOff className="w-8 h-8 text-white" /> : <Brain className="w-8 h-8 text-white" />}
            </div>
            {!offline && (
              <span className="absolute -right-1 -bottom-1 w-5 h-5 rounded-full bg-white dark:bg-slate-800 flex items-center justify-center border border-indigo-100">
                <Loader2 className="w-3 h-3 animate-spin text-indigo-600" />
              </span>
            )}
          </div>
          <h3 className="mt-4 text-base font-bold text-slate-900 dark:text-slate-100 flex items-center gap-1.5">
            <Sparkles className="w-4 h-4 text-indigo-500" />
            {offline ? '未连接 AI' : '正在分析复盘'}
          </h3>
          <p className="mt-1 text-xs text-slate-500 dark:text-slate-400 min-h-[2rem] leading-relaxed">
            {offline ? '请检查网络连接并查看 AI 服务是否可用（余额不足或配置异常）' : TIPS[tipIndex]}
          </p>
        </div>

        {/* 步骤列表 */}
        <div className="space-y-2.5">
          {STEPS.map((label, idx) => {
            const status = stepStatus(idx);
            return (
              <div
                key={label}
                className={`flex items-center gap-3 px-3 py-2 rounded-xl border transition ${
                  status === 'active'
                    ? 'bg-indigo-50/70 dark:bg-indigo-950/40 border-indigo-200 dark:border-indigo-800'
                    : status === 'done'
                    ? 'bg-emerald-50/50 dark:bg-emerald-950/30 border-emerald-100 dark:border-emerald-900/40'
                    : 'bg-slate-50 dark:bg-slate-800/40 border-slate-100 dark:border-slate-700/50'
                }`}
              >
                <span className="w-5 h-5 shrink-0 flex items-center justify-center">
                  {status === 'done' && <Check className="w-4 h-4 text-emerald-500" />}
                  {status === 'active' && <Loader2 className="w-4 h-4 animate-spin text-indigo-500" />}
                  {status === 'pending' && <span className="w-3.5 h-3.5 rounded-full border-2 border-slate-200 dark:border-slate-600" />}
                </span>
                <span
                  className={`text-sm ${
                    status === 'active'
                      ? 'text-indigo-700 dark:text-indigo-300 font-semibold'
                      : status === 'done'
                      ? 'text-slate-700 dark:text-slate-300'
                      : 'text-slate-400 dark:text-slate-500'
                  }`}
                >
                  {label}
                </span>
              </div>
            );
          })}
        </div>

        {/* 底部进度条 */}
        <div className="mt-6 h-1.5 rounded-full bg-slate-100 dark:bg-slate-800 overflow-hidden">
          <div
            className={`h-full rounded-full transition-all duration-500 ${
              offline ? 'w-0' : phase === 'summary' ? 'w-[90%] bg-emerald-500' : phase === 'evidence' ? 'w-[65%] bg-indigo-500' : 'w-[35%] bg-indigo-500'
            }`}
          />
        </div>
      </div>
    </div>
  );
};