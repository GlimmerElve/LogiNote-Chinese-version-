import katex from '../services/textbook/formulaRenderer.ts';
import type { SourceBlock, StructuredDocument } from '../types.ts';
import type { MaterialExcerpt } from '../services/textbook/materialTypes.ts';
import { MAX_PDF_FORMULA_REGIONS } from '../services/textbook/localImages.ts';

/** Evidence quality, not formula truth. Missing heuristics never means accurate. */
export function blockFormulaEvidence(document: StructuredDocument, block: SourceBlock): NonNullable<MaterialExcerpt['formulaEvidence']> {
  if (block.kind === 'code') return [];
  const text = document.normalizedText.slice(block.textStart, block.textEnd);
  const evidence: NonNullable<MaterialExcerpt['formulaEvidence']> = [];
  const seen = new Set<string>();
  for (const fragment of block.sourceFragments || []) {
    if (!fragment.formulaEvidence) continue;
    const key = JSON.stringify([fragment.locator, fragment.formulaEvidence]);
    if (!seen.has(key)) { seen.add(key); evidence.push({ ...fragment.formulaEvidence, locator: fragment.locator }); }
    if (evidence.length >= MAX_PDF_FORMULA_REGIONS) break;
  }
  if (block.locator.kind === 'pdf') {
    if (!evidence.length && /[∫∑∏√≤≥≠∞±∂∇]|[A-Za-zα-ωΑ-Ω][^。！？]{0,32}[=^]/u.test(text)) {
      evidence.push({ origin: 'pdf_layout', status: 'needs_visual_check', reasons: ['pdf_text_is_not_math_structure'], locator: block.locator });
    }
    return evidence;
  }
  const math = /\$\$([\s\S]+?)\$\$|(?<![\\$])\$(?!\$)([^$\n]+)\$|\\\[([\s\S]+?)\\\]|\\\(([^\n]+?)\\\)/gu;
  for (const match of text.matchAll(math)) {
    const latex = match.slice(1).find(value => value !== undefined)!;
    let syntaxOk = false;
    try {
      if (latex.length > 16_000) throw new Error();
      katex.renderToString(latex, { throwOnError: true, trust: false, strict: 'error', maxExpand: 1000, maxSize: 20 });
      syntaxOk = true;
    } catch { /* Unknown notation is not proof of mathematical error. */ }
    evidence.push({ origin: 'native_latex', status: syntaxOk ? 'structured_unverified' : 'needs_visual_check',
      reasons: [syntaxOk ? 'latex_renderable_not_truth_verified' : 'latex_render_check_failed'], locator: block.locator });
    if (evidence.length >= MAX_PDF_FORMULA_REGIONS) break;
  }
  return evidence;
}

/** Region numbering is derived only from trusted, versioned material metadata. */
export function blockFormulaRegions(document: StructuredDocument, block: SourceBlock) {
  return blockFormulaEvidence(document, block).filter(item => item.origin === 'pdf_layout' && item.locator.kind === 'pdf' && item.region);
}
