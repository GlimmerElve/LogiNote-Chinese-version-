import { compileTextbookFunction, type TextbookFunctionPlot } from './functionPlot';
/** Evaluate the safe arithmetic AST, never the plotting library's expression parser. */
export function sampleTextbookCurve(plot: TextbookFunctionPlot, curveIndex: number, count = 600): Array<Array<[number, number]>> {
  const compiled = compileTextbookFunction(plot.curves[curveIndex].expression, plot.variable, plot.parameters);
  const [from, to] = plot.xDomain, segments: Array<Array<[number, number]>> = [];
  let current: Array<[number, number]> = [], previousX: number | null = null;
  const flush = () => { if (current.length > 1) segments.push(current); current = []; };
  for (let index = 0; index <= count; index++) {
    const x = from + (to - from) * index / count, y = compiled.evaluate(x);
    if (!Number.isFinite(y) || previousX !== null && !compiled.continuousOn(previousX, x)) {
      flush(); previousX = Number.isFinite(y) ? x : null; continue;
    }
    current.push([x, y]); previousX = x;
  }
  flush(); return segments;
}
