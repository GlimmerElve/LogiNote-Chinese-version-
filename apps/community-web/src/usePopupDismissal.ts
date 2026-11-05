import {useEffect} from 'react';

/** Temporary menus share dismissal rules; ordinary content folds keep their state. */
export function usePopupDismissal() {
  useEffect(() => {
    const menus = () => Array.from(document.querySelectorAll<HTMLDetailsElement>('details[data-popup][open]'));
    const outside = (event: Event) => {
      const path = event.composedPath();
      for (const menu of menus()) if (!path.includes(menu)) menu.open = false;
    };
    const toggle = (event: Event) => {
      const menu = event.target;
      if (!(menu instanceof HTMLDetailsElement) || !menu.hasAttribute('data-popup') || !menu.open) return;
      for (const other of menus()) if (other !== menu && !other.contains(menu)) other.open = false;
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.isComposing) return;
      const open = menus();
      if (!open.length) return;
      const focused = open.find(menu => menu.contains(document.activeElement)) || open.at(-1)!;
      open.forEach(menu => { menu.open = false; });
      // Escape dismisses the menu first, without also closing its containing dialog.
      event.preventDefault();
      event.stopImmediatePropagation();
      focused.querySelector('summary')?.focus({preventScroll: true});
    };
    const close = () => menus().forEach(menu => { menu.open = false; });
    document.addEventListener('pointerdown', outside, true);
    document.addEventListener('focusin', outside, true);
    document.addEventListener('toggle', toggle, true);
    document.addEventListener('keydown', escape, true);
    window.addEventListener('hashchange', close);
    return () => {
      document.removeEventListener('pointerdown', outside, true);
      document.removeEventListener('focusin', outside, true);
      document.removeEventListener('toggle', toggle, true);
      document.removeEventListener('keydown', escape, true);
      window.removeEventListener('hashchange', close);
    };
  }, []);
}
