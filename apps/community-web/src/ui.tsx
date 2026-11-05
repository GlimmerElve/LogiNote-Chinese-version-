import { useEffect, useId, useRef, type ReactNode, type RefObject } from 'react';
import { ArrowRight, ChevronDown, X } from 'lucide-react';
import type { Person, Resource } from './model';
import { useApp } from './context';
import peopleSheet from '../../../design/community-website-concepts/v1/00-home-approved.png';
import meSheet from '../../../design/community-website-concepts/personal-v1/01-my-profile.png';
import marketSheet from '../../../design/community-website-concepts/v1/01-resource-market.png';
import discussionSheet from '../../../design/community-website-concepts/v1/02-discussion.png';
/** Reuse only the fictional portrait regions of the approved reference, rendered as CSS sprites. */
export function Avatar({ person = 'me', size = 48, src }: {
    person?: Person;
    size?: number;
    src?: string;
}) {
    const {state} = useApp();
    const uploaded = src ?? (person === 'me' ? state.profile.avatar : undefined);
    if(uploaded) return <span aria-hidden="true" className="avatar custom-avatar" style={{width:size,height:size}}><img alt="" src={uploaded}/></span>;
    const rects = { me: [343, 134, 148], he: [316, 363, 63], lin: [399, 687, 35], boat: [316, 785, 63] };
    const [x, y, s] = rects[person];
    return <span aria-hidden="true" className="avatar" style={{ width: size, height: size }}><img alt="" draggable={false} src={person === 'me' ? meSheet : peopleSheet} style={{ width: `${1536 / s * 100}%`, left: `${-x / s * 100}%`, top: `${-y / s * 100}%` }}/></span>;
}
export function Art({ type = 'space', className = '' }: {
    type?: Resource['art'];
    className?: string;
}) {
    const regions = {
        space: { source: marketSheet, x: 190, y: 395, width: 231, height: 160 },
        matrix: { source: marketSheet, x: 190, y: 600, width: 231, height: 152 },
        code: { source: marketSheet, x: 190, y: 799, width: 231, height: 151 },
        gradient: { source: meSheet, x: 415, y: 585, width: 162, height: 109 },
    };
    const region = className.includes('answer-art') ? { source: discussionSheet, x: 390, y: 571, width: 523, height: 154 } : regions[type];
    return <div className={`resource-art ${className}`} aria-hidden="true"><svg viewBox={`0 0 ${region.width} ${region.height}`} preserveAspectRatio="xMidYMid slice" focusable="false"><image href={region.source} x={-region.x} y={-region.y} width="1536" height="1024"/></svg></div>;
}
export function Primary({ children, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement>) { return <button type="button" className="primary" {...props}>{children}</button>; }
export function LinkButton({ children, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement>) { return <button type="button" className="text-button" {...props}>{children}</button>; }
export function ArrowLink({ children, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement>) { return <LinkButton {...props}>{children}<ArrowRight size={17}/></LinkButton>; }
export function Tabs({ items, value, onChange, trailing }: {
    items: string[];
    value: string;
    onChange: (v: string) => void;
    trailing?: ReactNode;
}) {
    return <div className="tabs"><nav aria-label="内容分类">{items.map(v => <button type="button" key={v} aria-current={v === value ? 'page' : undefined} className={v === value ? 'selected' : ''} onClick={() => onChange(v)}>{v}</button>)}</nav>{trailing}</div>;
}
export function Fold({ title, children }: {
    title: string;
    children: ReactNode;
}) { return <details className="fold"><summary>{title}<ChevronDown size={17}/></summary><div className="fold-content">{children}</div></details>; }
export function Empty({ children, action }: {
    children: ReactNode;
    action?: ReactNode;
}) { return <div className="empty"><p>{children}</p>{action}</div>; }
/** One native modal at a time: built-in inert background, Escape, focus trap and focus restoration. */
export function Overlay({ title, kind = 'drawer', anchor, onClose, headerActions, initialFocusRef, children }: {
    title: string;
    kind?: 'drawer' | 'popover' | 'modal';
    anchor?: DOMRect;
    onClose: () => void;
    headerActions?: ReactNode;
    initialFocusRef?: RefObject<HTMLElement|null>;
    children: ReactNode;
}) {
    const titleId=useId();
    const ref = useRef<HTMLDialogElement>(null);
    const closeButtonRef = useRef<HTMLButtonElement>(null);
    useEffect(() => {
        const dialog = ref.current!;
        const restore = document.activeElement as HTMLElement | null;
        const previousOverflow = document.body.style.overflow;
        dialog.showModal();
        if(initialFocusRef?.current)initialFocusRef.current.focus({preventScroll:true});
        else if (headerActions)
            closeButtonRef.current?.focus({ preventScroll: true });
        document.body.style.overflow = 'hidden';
        return () => { dialog.close(); document.body.style.overflow = previousOverflow; if (restore?.isConnected)
            restore.focus({ preventScroll: true }); };
    }, []);
    useEffect(() => {
        if(kind!=='popover'||!anchor||window.innerWidth<=600)return;
        const dialog=ref.current!;
        const place=()=>{
            dialog.style.maxHeight=`${window.innerHeight-32}px`;
            const box=dialog.getBoundingClientRect();
            const below=anchor.bottom+10;
            const preferred=below+box.height<=window.innerHeight-16?below:anchor.top-box.height-10;
            dialog.style.top=`${Math.max(16,Math.min(preferred,window.innerHeight-box.height-16))}px`;
            dialog.style.left=`${Math.max(16,Math.min(anchor.right-box.width,window.innerWidth-box.width-16))}px`;
        };
        place();const observer=new ResizeObserver(place);observer.observe(dialog);
        return()=>observer.disconnect();
    }, [kind,anchor]);
    const style = kind === 'popover' && anchor && window.innerWidth > 600 ? { top: Math.min(anchor.bottom + 10, window.innerHeight - 330), left: Math.min(Math.max(16, anchor.right - 350), window.innerWidth - 370) } : undefined;
    return <dialog ref={ref} className={`overlay ${kind}`} style={style} aria-labelledby={titleId} onKeyDown={e => {
            if (e.key !== 'Tab')
                return;
            const elements = Array.from(e.currentTarget.querySelectorAll<HTMLElement>('button:not(:disabled),a[href],input:not(:disabled),textarea:not(:disabled),select:not(:disabled),summary,[tabindex="0"]')).filter(el => el.getClientRects().length > 0);
            const first = elements[0], last = elements[elements.length - 1];
            if (e.shiftKey && document.activeElement === first) {
                e.preventDefault();
                last?.focus();
            }
            else if (!e.shiftKey && document.activeElement === last) {
                e.preventDefault();
                first?.focus();
            }
        }} onCancel={e => { e.preventDefault(); onClose(); }} onClick={e => { if (e.target === e.currentTarget) {
        const box = e.currentTarget.getBoundingClientRect();
        if (e.clientX < box.left || e.clientX > box.right || e.clientY < box.top || e.clientY > box.bottom)
            onClose();
    } }}>
    <div className="overlay-heading"><h2 id={titleId}>{title}</h2><div className="overlay-heading-actions">{headerActions}<button ref={closeButtonRef} type="button" className="icon-button" aria-label="关闭面板" onClick={onClose}><X /></button></div></div>
    {children}
  </dialog>;
}
