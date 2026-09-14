/**
 * 论证结构画布 → PNG 导出（modern-screenshot 截图 + 浏览器下载）
 */
import { domToCanvas } from 'modern-screenshot';

export async function exportPNG(element: HTMLElement, fileName: string): Promise<void> {
  if (!element) return;

  const canvas = await domToCanvas(element, {
    scale: 2,
    backgroundColor: '#FEF9F3',
  });
  const a = document.createElement('a');
  a.download = `${fileName}.png`;
  a.href = canvas.toDataURL('image/png');
  a.click();
}