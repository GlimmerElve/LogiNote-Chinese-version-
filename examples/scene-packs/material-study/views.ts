import type * as React from 'react';
import type { ScenePackActivationServices, ScenePackViewContext } from '../../../src/types/sceneInteractionPack';
import { readStudyData, type StudyData } from './plugins/study';

export function createViews(services: ScenePackActivationServices) {
  const react = services.ui.react as typeof React;
  const h = react.createElement;
  function MaterialsView(props: ScenePackViewContext) {
    const [loaded, setLoaded] = react.useState<{ data: StudyData; guide: string; image: string }>();
    const [error, setError] = react.useState('');
    react.useEffect(() => {
      setLoaded(undefined); setError('');
      const controller = new AbortController(); let active = true, lease: { url: string; release(): void } | undefined;
      const materials = props.materials;
      if (!materials) { setError('本包物料不可用'); return () => controller.abort(); }
      void (async () => {
        try {
          const [scores, guide] = await Promise.all([materials.read('scores', controller.signal), materials.read('guide', controller.signal)]);
          const data = readStudyData(scores.data), text = new TextDecoder('utf-8', { fatal: true }).decode(guide.data);
          const image = await materials.openUrl('legend', controller.signal);
          if (!active) { image.release(); return; }
          lease = image; setLoaded({ data, guide: text, image: image.url });
        } catch (cause) { if (active && !controller.signal.aborted) setError(cause instanceof Error ? cause.message : '物料读取失败'); }
      })();
      // Host owns the shared scope. This view releases only its URL lease on unmount or scope change.
      return () => { active = false; controller.abort(); lease?.release(); };
    }, [props.materialScopeKey, props.materials]);
    if (error) return h('p', { role: 'alert' }, error);
    if (!loaded) return h('p', { className: 'material-study-loading' }, '正在读取本包学习物料…');
    const max = Math.max(100, loaded.data.target, ...loaded.data.scores.map(row => row.value));
    return h('section', { className: 'material-study-panel', 'aria-label': '本包学习物料' },
      h('h4', null, loaded.data.title), h('p', null, loaded.guide),
      h('button', { type: 'button', disabled: !props.execution?.enabled, onClick: () => {
        props.guard();
        const targets = props.document.execution?.links.filter(link => link.source.nodeId === props.node.id).map(link => link.target.nodeId) ?? [];
        props.execution?.run([...new Set([props.node.id, ...targets])]);
      } }, '计算均分'),
      props.execution?.running && h('button', { type: 'button', onClick: () => { props.guard(); props.execution?.cancel?.(); } }, '停止'),
      props.execution?.error && h('p', { role: 'alert' }, props.execution.error),
      h('svg', { viewBox: '0 0 300 140', role: 'img', 'aria-label': '三次测验成绩柱状图' },
        h('line', { x1: 10, x2: 290, y1: 110 - loaded.data.target / max * 100, y2: 110 - loaded.data.target / max * 100, stroke: '#15803d', strokeDasharray: '4 3' }),
        ...loaded.data.scores.flatMap((row, index) => {
          const x = 24 + index * 90, height = row.value / max * 100;
          return [h('rect', { key: `bar-${index}`, x, y: 110 - height, width: 40, height, fill: '#2563eb' }),
            h('text', { key: `label-${index}`, x, y: 128, fontSize: 11 }, `${row.label} ${row.value}${loaded.data.unit}`)];
        })),
      h('figure', null, h('img', { src: loaded.image, width: 120, height: 28, alt: '蓝色成绩柱与绿色参考线图例' }),
        h('figcaption', null, '蓝色柱：测验成绩；绿色线：80 分参考。')));
  }
  return { 'example-material-study/summarize': { settings: MaterialsView, inline: MaterialsView, policy: () => ({ genericSettings: true }) } };
}

export const studyHelp = { 'example-material-study/summarize': {
  title: '学习物料汇总', description: '读取本包成绩 JSON、说明与图例，在画布展示并计算均分。', category: '包内物料',
  when: '需要随包分发固定学习材料并在本地交互时。', example: '60、75、90 的平均分为 75；factor=1。',
  difference: '物料来自当前包固定版本；它们不同于用户上传的本局资源，显示物料不会把它注册为通用画布输入。',
  inputLabels: { factor: '均分倍数' }, outputLabels: { mean: '平均分', report: '结果说明' },
} };
