import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { Check, ChevronRight } from 'lucide-react';

export type MenuItem =
  | { separator: true }
  | {
      separator?: false;
      label: string;
      icon?: ReactNode;
      shortcut?: string;
      disabled?: boolean;
      checked?: boolean;
      danger?: boolean;
      onClick?: () => void;
      submenu?: MenuItem[];
    };

export interface MenuState {
  x: number;
  y: number;
  items: MenuItem[];
}

type Entry = Exclude<MenuItem, { separator: true }>;
const isEntry = (m: MenuItem): m is Entry => !m.separator;

type KeyHandler = (e: KeyboardEvent) => void;

/** A right-click menu at (x, y) in viewport pixels, kept on screen. Submenus open sideways. */
export function ContextMenu({ menu, onClose }: { menu: MenuState; onClose: () => void }) {
  // the innermost open list gets the keys (focus is unreliable right after a right-click)
  const stack = useRef<{ current: KeyHandler }[]>([]);
  useEffect(() => {
    const close = (e: Event) => {
      if (e instanceof PointerEvent && (e.target as Element | null)?.closest?.('.ctx-menu')) return;
      onClose();
    };
    const key = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (e.key === 'Escape' || e.key === 'Tab') onClose();
      else stack.current[stack.current.length - 1]?.current(e);
    };
    window.addEventListener('pointerdown', close, true);
    window.addEventListener('wheel', close, { passive: true });
    window.addEventListener('resize', close);
    window.addEventListener('blur', close);
    window.addEventListener('keydown', key, true);
    return () => {
      window.removeEventListener('pointerdown', close, true);
      window.removeEventListener('wheel', close);
      window.removeEventListener('resize', close);
      window.removeEventListener('blur', close);
      window.removeEventListener('keydown', key, true);
    };
  }, [onClose]);
  return <MenuList items={menu.items} x={menu.x} y={menu.y} onClose={onClose} root stack={stack.current} />;
}

interface ListProps {
  items: MenuItem[];
  x: number;
  y: number;
  onClose: () => void;
  stack: { current: KeyHandler }[];
  root?: boolean;
  parentWidth?: number;
  /** Opened from the keyboard: start on the first item. */
  keyboard?: boolean;
  /** Close this submenu (← key). */
  onBack?: () => void;
}

function MenuList({ items, x, y, onClose, stack, root, parentWidth = 0, keyboard, onBack }: ListProps) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ left: x, top: y, ready: false });
  const [open, setOpen] = useState<{ i: number; keyboard: boolean } | null>(null);
  const enabledIdx = items.map((it, i) => (isEntry(it) && !it.disabled ? i : -1)).filter((i) => i >= 0);
  const [active, setActive] = useState<number>(keyboard ? (enabledIdx[0] ?? -1) : -1);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const w = el.offsetWidth, h = el.offsetHeight;
    const vw = window.innerWidth, vh = window.innerHeight;
    let left = x, top = y;
    // a submenu that does not fit on the right opens on the left of its parent
    if (left + w > vw - 4) left = root ? Math.max(4, vw - w - 4) : Math.max(4, x - w - parentWidth);
    if (top + h > vh - 4) top = Math.max(4, vh - h - 4);
    setPos({ left, top, ready: true });
  }, [x, y, root, parentWidth]);

  const run = (it: Entry) => {
    if (it.disabled || it.submenu) return;
    onClose();
    it.onClick?.();
  };

  const handler = useRef<KeyHandler>(() => {});
  handler.current = (e: KeyboardEvent) => {
    if (!enabledIdx.length) return;
    const k = enabledIdx.indexOf(active);
    if (e.key === 'ArrowDown') setActive(enabledIdx[(k + 1) % enabledIdx.length]);
    else if (e.key === 'ArrowUp') setActive(enabledIdx[k < 0 ? enabledIdx.length - 1 : (k - 1 + enabledIdx.length) % enabledIdx.length]);
    else if (e.key === 'ArrowLeft') onBack?.();
    else if ((e.key === 'Enter' || e.key === ' ' || e.key === 'ArrowRight') && active >= 0) {
      const it = items[active] as Entry;
      if (it.submenu) setOpen({ i: active, keyboard: true });
      else if (e.key !== 'ArrowRight') run(it);
    }
  };
  useEffect(() => {
    const h = handler;
    stack.push(h);
    return () => {
      const i = stack.indexOf(h);
      if (i >= 0) stack.splice(i, 1);
    };
  }, [stack]);

  return (
    <div
      ref={ref}
      className="ctx-menu"
      role="menu"
      style={{ left: pos.left, top: pos.top, visibility: pos.ready ? 'visible' : 'hidden' }}
      onContextMenu={(e) => e.preventDefault()}
    >
      {items.map((it, i) =>
        !isEntry(it) ? (
          <div key={i} className="ctx-sep" role="separator" />
        ) : (
          <div
            key={i}
            role="menuitem"
            aria-disabled={it.disabled || undefined}
            aria-haspopup={it.submenu ? 'menu' : undefined}
            className={`ctx-item${it.disabled ? ' disabled' : ''}${it.danger ? ' danger' : ''}${active === i || open?.i === i ? ' active' : ''}`}
            onPointerEnter={() => {
              setActive(i);
              setOpen(it.submenu && !it.disabled ? { i, keyboard: false } : null);
            }}
            onClick={() => (it.submenu ? setOpen({ i, keyboard: false }) : run(it))}
          >
            <span className="ctx-icon">{it.checked ? <Check size={14} /> : it.icon}</span>
            <span className="ctx-label">{it.label}</span>
            {it.shortcut && <span className="ctx-key">{it.shortcut}</span>}
            {it.submenu && <ChevronRight size={14} className="ctx-more" />}
            {open?.i === i && it.submenu && (
              <SubMenu items={it.submenu} anchor={ref} index={i} onClose={onClose} stack={stack} keyboard={open.keyboard} onBack={() => setOpen(null)} />
            )}
          </div>
        ),
      )}
    </div>
  );
}

function SubMenu({ items, anchor, index, ...rest }: { items: MenuItem[]; anchor: React.RefObject<HTMLDivElement | null>; index: number } & Pick<ListProps, 'onClose' | 'stack' | 'keyboard' | 'onBack'>) {
  const el = anchor.current?.children[index] as HTMLElement | undefined;
  const r = el?.getBoundingClientRect();
  if (!r) return null;
  return (
    <div onClick={(e) => e.stopPropagation()} onPointerEnter={(e) => e.stopPropagation()}>
      <MenuList items={items} x={r.right - 2} y={r.top - 4} parentWidth={r.width} {...rest} />
    </div>
  );
}
