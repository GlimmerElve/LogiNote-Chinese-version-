/**
 * 论证结构画布 → PDF 导出（modern-screenshot 截图 + jspdf 生成单页 A4）
 */
import { domToCanvas } from 'modern-screenshot';
import jsPDF from 'jspdf';

export async function exportPDF(element: HTMLElement, fileName: string): Promise<void> {
  if (!element) return;

  const canvas = await domToCanvas(element, {
    scale: 2,
    backgroundColor: '#FEF9F3',
  });
  const imgData = canvas.toDataURL('image/png');

  const pdf = new jsPDF({ orientation: 'landscape', unit: 'px', format: 'a4' });
  const pageWidth = pdf.internal.pageSize.getWidth();
  const pageHeight = pdf.internal.pageSize.getHeight();
  const margin = 20;
  const availW = pageWidth - margin * 2;
  const availH = pageHeight - margin * 2;
  const scale = Math.min(availW / canvas.width, availH / canvas.height, 1);
  const finalW = canvas.width * scale;
  const finalH = canvas.height * scale;
  const x = (pageWidth - finalW) / 2;
  const y = (pageHeight - finalH) / 2;

  pdf.addImage(imgData, 'PNG', x, y, finalW, finalH);
  pdf.save(`${fileName}.pdf`);
}