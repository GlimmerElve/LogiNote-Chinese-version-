/** Distribution-only React peer bridge. The bundle reuses the terminal's React dispatcher. */
let peer: Record<string, (...args: any[]) => any> | undefined;
export function bindPromptLabReact(value: unknown) {
  if (!value || typeof (value as any).createElement !== 'function' || typeof (value as any).useState !== 'function') throw new Error('宿主React接口不可用');
  peer = value as typeof peer;
}
function invoke(name: string, args: any[]) { if (!peer) throw new Error('交互包尚未激活'); return peer[name](...args); }
export const useState = (...args: any[]) => invoke('useState', args);
export const useRef = (...args: any[]) => invoke('useRef', args);
export const useEffect = (...args: any[]) => invoke('useEffect', args);
const React = { createElement: (...args: any[]) => invoke('createElement', args),
  get Fragment() { if (!peer) throw new Error('交互包尚未激活'); return peer.Fragment; } };
export default React;
