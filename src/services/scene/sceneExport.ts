/**
 * S4 场景导出服务（对应实施计划阶段五「导出」项）。
 *
 * 提供三种导出，覆盖三种留档诉求：
 * - PNG：单张图片，便于贴进笔记/聊天
 * - PDF：可打印的 A4 留档（横向，适配画布宽扁比例）
 * - LaTeX：可继续编辑/排版的源码（.tex），便于写进论文或讲义
 *
 * 与前两者不同，LaTeX 导出不依赖 DOM —— 它直接从 SceneSpec + SceneRunState
 * 重建内容，因此**不受当前视口滚动位置与折叠状态影响**，导出的是完整推导过程。
 *
 * 对应《场景设计原则》：
 * - 原则 14「案例可沉淀」：导出物即一次成功运行的沉淀载体
 * - 原则 12「反事实支持」：导出的记录可用于复盘「换了变量会怎样」
 * - 原则 10「LLM 生成、系统执行」：导出内容全部来自 spec/run 的结构化字段，
 *   不额外调用 LLM，保证导出结果可复现
 */

import { domToCanvas } from 'modern-screenshot';
import jsPDF from 'jspdf';
import type { SceneRunState, SceneSpec } from '../../types';
import type { DerivationNode } from '../../types/sceneS4';
import { stepDisplay } from '../../types/sceneS4';

/** 导出画布背景色（与项目主色调一致，避免透明背景在 PDF 中变黑） */
const EXPORT_BG = '#FEF9F3';

/** 触发浏览器下载 */
function downloadBlob(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  a.click();
  // 立即释放会中断部分浏览器的下载，延迟释放更稳
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** 触发 dataURL 下载（截图类） */
function downloadDataUrl(dataUrl: string, fileName: string): void {
  const a = document.createElement('a');
  a.download = fileName;
  a.href = dataUrl;
  a.click();
}

/**
 * 把场景名清洗为安全文件名。
 * 去掉 Windows/macOS 不允许的字符与末尾空白，并兜底为空时的默认名。
 */
export function safeFileName(raw: string, fallback = 'scene'): string {
  const cleaned = (raw ?? '')
    .replace(/[\\/:*?"<>|\r\n\t]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 60);
  return cleaned || fallback;
}

/* ================================================================
 * 一、PNG 导出
 * ================================================================ */

/**
 * 把指定 DOM 元素导出为 PNG。
 * @param element 待截图的容器（通常是画布外层包裹节点）
 * @param fileName 不含扩展名的文件名
 */
export async function exportScenePng(element: HTMLElement | null, fileName: string): Promise<boolean> {
  if (!element) return false;
  const canvas = await domToCanvas(element, { scale: 2, backgroundColor: EXPORT_BG });
  downloadDataUrl(canvas.toDataURL('image/png'), `${safeFileName(fileName)}.png`);
  return true;
}

/* ================================================================
 * 二、PDF 导出
 * ================================================================ */

/**
 * 把指定 DOM 元素导出为单页 PDF。
 * 采用横向 A4 并等比缩放居中：画布是宽扁结构，横向留白最少。
 */
export async function exportScenePdf(element: HTMLElement | null, fileName: string): Promise<boolean> {
  if (!element) return false;

  const canvas = await domToCanvas(element, { scale: 2, backgroundColor: EXPORT_BG });
  const imgData = canvas.toDataURL('image/png');

  const pdf = new jsPDF({ orientation: 'landscape', unit: 'px', format: 'a4' });
  const pageWidth = pdf.internal.pageSize.getWidth();
  const pageHeight = pdf.internal.pageSize.getHeight();
  const margin = 20;
  const availW = pageWidth - margin * 2;
  const availH = pageHeight - margin * 2;

  // 只缩不放（上限 1），避免小画布被拉伸模糊
  const scale = Math.min(availW / canvas.width, availH / canvas.height, 1);
  const finalW = canvas.width * scale;
  const finalH = canvas.height * scale;

  pdf.addImage(imgData, 'PNG', (pageWidth - finalW) / 2, (pageHeight - finalH) / 2, finalW, finalH);
  pdf.save(`${safeFileName(fileName)}.pdf`);
  return true;
}

/* ================================================================
 * 三、LaTeX 导出
 * ================================================================ */

/** 转义 LaTeX 特殊字符（用于纯文本段落，如标题、注释） */
function escapeLatex(text: string): string {
  return (text ?? '')
    .replace(/\\/g, '\\textbackslash{}')
    .replace(/([&%$#_{}])/g, '\\$1')
    .replace(/~/g, '\\textasciitilde{}')
    .replace(/\^/g, '\\textasciicircum{}');
}

/**
 * 从节点 LaTeX 提取可放进数学环境的正文。
 * MathLive 输出的串可能已带 `$...$` 或 `\[...\]` 包裹，需剥离后再放进本文件自己的
 * 数学环境，否则会产生嵌套定界符导致编译失败。
 */
function stripMathDelims(latex: string): string {
  const trimmed = (latex ?? '').trim();
  const m =
    /^\$\$([\s\S]+)\$\$$/.exec(trimmed) ||
    /^\$([\s\S]+)\$$/.exec(trimmed) ||
    /^\\\[([\s\S]+)\\\]$/.exec(trimmed) ||
    /^\\\(([\s\S]+)\\\)$/.exec(trimmed);
  return m ? m[1].trim() : trimmed;
}

/** 节点类型 → 中文分区标题 */
function nodeTypeLabel(type: DerivationNode['type']): string {
  switch (type) {
    case 'given':
      return '已知条件';
    case 'formula':
      return '推导步骤';
    case 'conclusion':
      return '结论';
    default:
      return '节点';
  }
}

/** 节点状态 → 中文标注 */
function statusLabel(status: DerivationNode['data']['status']): string {
  switch (status) {
    case 'pass':
      return '通过';
    case 'warn':
      return '存疑';
    case 'fail':
      return '不通过';
    case 'pending':
      return '验证中';
    case 'frozen':
      return '已冻结';
    default:
      return '草稿';
  }
}

/**
 * 构造完整可编译的 LaTeX 文档。
 * 依赖宏包：ctex（中文）、amsmath/amssymb（数学）、geometry（页边距）。
 */
export function buildSceneLatex(spec: SceneSpec, run: SceneRunState): string {
  const compute = spec.compute;
  const nodes = run.canvas?.nodes ?? [];
  const lines: string[] = [];

  lines.push('\\documentclass[11pt]{article}');
  lines.push('\\usepackage[UTF8]{ctex}');
  lines.push('\\usepackage{amsmath,amssymb}');
  lines.push('\\usepackage[margin=2.2cm]{geometry}');
  lines.push('\\usepackage{enumitem}');
  lines.push('');
  lines.push(`\\title{${escapeLatex(spec.meta.name)}}`);
  lines.push(
    `\\author{${escapeLatex(spec.meta.subject)}${
      spec.meta.sceneSkill ? ` \\cdot ${escapeLatex(spec.meta.sceneSkill)}` : ''
    }}`,
  );
  lines.push(`\\date{${escapeLatex(run.startedAt || '')}}`);
  lines.push('');
  lines.push('\\begin{document}');
  lines.push('\\maketitle');
  lines.push('');

  // 一、学习目标与知识点
  if (spec.meta.goal) {
    lines.push('\\section*{学习目标}');
    lines.push(escapeLatex(spec.meta.goal));
    lines.push('');
  }
  if (spec.meta.knowledgePoints?.length) {
    lines.push('\\section*{知识点}');
    lines.push('\\begin{itemize}[leftmargin=1.6em]');
    // 知识点是用户/LLM 生成的短标签，转义后直出
    spec.meta.knowledgePoints.forEach((k) => lines.push(`  \\item ${escapeLatex(k)}`));
    lines.push('\\end{itemize}');
    lines.push('');
  }

  // 二、已知条件（优先输出 compute.given，它是引擎实际使用的口径）
  if (compute?.given?.length) {
    lines.push('\\section*{已知条件}');
    lines.push('\\begin{itemize}[leftmargin=1.6em]');
    compute.given.forEach((g) => {
      const val = g.symbol_value ?? g.display;
      lines.push(`  \\item $${escapeLatex(g.name)} = ${escapeLatex(val)}$`);
    });
    lines.push('\\end{itemize}');
    lines.push('');
  }

  // 三、用户推导过程（按节点在画布中的纵向位置排序，贴合阅读顺序）
  lines.push('\\section*{推导过程}');
  const ordered = [...nodes].sort((a, b) => {
    const dy = (a.position?.y ?? 0) - (b.position?.y ?? 0);
    return dy !== 0 ? dy : (a.position?.x ?? 0) - (b.position?.x ?? 0);
  });

  if (ordered.length === 0) {
    lines.push('（无节点）');
    lines.push('');
  } else {
    ordered.forEach((n, i) => {
      const label = n.data.label || `${nodeTypeLabel(n.type)} ${i + 1}`;
      lines.push(`\\subsection*{${escapeLatex(label)} \\textnormal{(${statusLabel(n.data.status)})}}`);

      const body = n.data.latex ? stripMathDelims(n.data.latex) : '';
      if (body) {
        lines.push('\\begin{equation*}');
        lines.push(`  ${body}`);
        lines.push('\\end{equation*}');
      }
      // 该步骤的解释（选填）：公式之外的补充说明，单独一段呈现
      if (n.data.note) {
        lines.push(`\\noindent\\textit{${escapeLatex(n.data.note)}}`);
        lines.push('');
      }

      // 引擎/LLM 反馈：附在节点下方，便于复盘「当时为什么被判错」
      if (n.data.verification?.feedback) {
        lines.push('');
        lines.push(`\\noindent\\textit{反馈：${escapeLatex(n.data.verification.feedback)}}`);
      }
      lines.push('');
    });
  }

  // 四、标准解法（参考解）
  if (run.status !== 'running' && compute?.expected_steps?.length) {
    lines.push('\\section*{标准解法}');
    lines.push('\\begin{enumerate}[leftmargin=1.8em]');
    compute.expected_steps.forEach((s) => {
      /**
       * 两分层适配（轮次 B）：先取展示文本再做 LaTeX 处理。
       * 导出面向「留档阅读」，故一律用 display；symbolic 与 note 不导出，
       * 避免把 `diff(A(x), x)` 这类机器形式混进给读者看的文档。
       */
      const display = stepDisplay(s);
      const body = stripMathDelims(display);
      // 整条为公式时放进行内数学环境，否则按文本输出
      const isFormula = /\$\$[\s\S]+\$\$|^\\\[[\s\S]+\\\]$/.test(display.trim());
      lines.push(isFormula ? `  \\item $${body}$` : `  \\item ${escapeLatex(display)}`);
    });
    lines.push('\\end{enumerate}');
    lines.push('');
  }

  // 五、目标结果
  if (run.status !== 'running' && compute?.expected_formula) {
    lines.push('\\section*{目标结果}');
    lines.push('\\begin{equation*}');
    lines.push(`  ${stripMathDelims(compute.expected_formula)}`);
    lines.push('\\end{equation*}');
    lines.push('');
  }

  // 六、指标结果
  if (run.metrics?.length) {
    lines.push('\\section*{指标结果}');
    lines.push('\\begin{itemize}[leftmargin=1.6em]');
    run.metrics.forEach((m) => {
      const def = spec.metrics?.find((s) => s.id === m.metricId);
      const name = def?.name ?? m.metricId;
      const target = def?.target !== undefined ? `（目标 $\\ge$ ${String(def.target)}）` : '';
      lines.push(`  \\item ${escapeLatex(name)}：${escapeLatex(String(m.value))}${target}`);
    });
    lines.push('\\end{itemize}');
    lines.push('');
  }

  // 七、收官信息
  lines.push('\\section*{运行信息}');
  lines.push('\\begin{itemize}[leftmargin=1.6em]');
  lines.push(`  \\item 状态：${escapeLatex(run.status)}`);
  if (run.endReason) lines.push(`  \\item 结束原因：${escapeLatex(run.endReason)}`);
  if (typeof run.finalScore === 'number') lines.push(`  \\item 得分：${run.finalScore}`);
  if (run.canvas) {
    lines.push(`  \\item 求助使用：${run.canvas.helpUsed} / ${run.canvas.maxHelp}`);
    lines.push(`  \\item 独立性：${run.canvas.independenceScore}`);
  }
  lines.push('\\end{itemize}');
  lines.push('');
  lines.push('\\end{document}');

  return lines.join('\n');
}

/**
 * 导出 LaTeX 源文件（.tex）。
 * 内容完全由 spec/run 重建，与当前视口无关。
 */
export function exportSceneLatex(spec: SceneSpec, run: SceneRunState): boolean {
  const tex = buildSceneLatex(spec, run);
  const blob = new Blob([tex], { type: 'application/x-tex;charset=utf-8' });
  downloadBlob(blob, `${safeFileName(spec.meta?.name ?? 'scene')}.tex`);
  return true;
}
