/** Owned, guest-only clock: no model timers run in the reader's JS realm. */
export const FIGURE_CLOCK_RUNTIME = String.raw`(function(){
  let frame=0,callback=null,last=0,visible=true;
  const reduced=matchMedia('(prefers-reduced-motion: reduce)');
  function pause(){if(frame)cancelAnimationFrame(frame);frame=0;callback=null;last=0}
  function tick(now){
    frame=0;
    if(!callback||!visible||document.hidden||reduced.matches){pause();return}
    if(now-last<1000/30){frame=requestAnimationFrame(tick);return}
    const dt=Math.min(.05,Math.max(0,(now-last)/1000));last=now;
    const run=callback;
    try{if(run(dt)===false){pause();return}}catch(error){pause();throw error}
    if(callback===run)frame=requestAnimationFrame(tick);
  }
  const clock={
    start(fn){pause();if(typeof fn!=='function'||!visible||document.hidden||reduced.matches)return clock;callback=fn;last=performance.now();frame=requestAnimationFrame(tick);return clock},
    pause,
    setVisible(value){visible=value===true;if(!visible)pause()},
    get running(){return !!callback},
    get reducedMotion(){return reduced.matches}
  };
  Object.defineProperty(window,'TeachingClock',{value:Object.freeze(clock),writable:false,configurable:false});
  document.addEventListener('visibilitychange',()=>{if(document.hidden)pause()});
  reduced.addEventListener('change',()=>{if(reduced.matches)pause()});
  window.addEventListener('pagehide',pause,{once:true});
})();`;
