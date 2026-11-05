/** Distinguish failures and inconclusive runtime probes from clean checks. */
export function classifyTeachableAcceptance(report) {
  if (report.checks.some(item=>item.status!=='passed') || report.liveResults.some(item=>item.status!=='generated')) return 'failed';
  const incomplete=report.liveResults.some(item=>{
    if(!item.runtime)return false; // --live without --desktop has no runtime check.
    const d=item.runtime.diagnostics;
    return item.runtime.screenshot===false || d==='unavailable' || !d || d.warnings?.length>0 || d.interaction!=='observed' || d.reset!=='restored';
  });
  return incomplete?'needs-review':'passed';
}
