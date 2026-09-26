import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';

export type MenuItem =
  | { separator: true }
  | {
      id: string;
      label: string;
      /** Shown right-aligned, e.g. "Ctrl+C". Purely informational. */
      shortcut?: string;
      disabled?: boolean;
      danger?: boolean;
      onSelect: () => void;
    };

interface ContextMenuProps {
  x: number;
  y: number;
  /** Read by screen readers; also names the menu for tests. */
  label: string;
  items: MenuItem[];
  onClose: () => void;
}

const EDGE = 8;
const SCROLL_GRACE_MS = 250;

/**
 * A right-click menu anchored at a viewport point. Closes on Escape, outside
 * pointer-down, scroll, resize, or after an item runs. Arrow keys move between
 * enabled items; Enter / Space activate. Rendered inline (position: fixed), so
 * it needs no portal and inherits the lab's theme variables.
 */
export function ContextMenu({ x, y, label, items, onClose }: ContextMenuProps) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [pos, setPos] = useState({ left: x, top: y });

  // Keep the whole menu on screen: flip left/up when it would spill over.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const { width, height } = el.getBoundingClientRect();
    const left = x + width + EDGE > window.innerWidth ? Math.max(EDGE, x - width) : x;
    const top = y + height + EDGE > window.innerHeight ? Math.max(EDGE, y - height) : y;
    setPos({ left, top });
  }, [x, y, items.length]);

  useEffect(() => {
    const el = ref.current;
    const first = el?.querySelector<HTMLButtonElement>('button:not(:disabled)');
    // preventScroll: the focus jump would otherwise scroll the timeline and
    // trip the scroll-to-close listener below before the menu is even seen.
    first?.focus({ preventScroll: true });

    const onPointerDown = (e: PointerEvent) => {
      if (el && !el.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
      }
    };
    // Scroll events are dispatched a frame late, so a scroll-into-view that
    // preceded the right-click would otherwise close the menu on arrival.
    const openedAt = performance.now();
    const onScroll = () => {
      if (performance.now() - openedAt > SCROLL_GRACE_MS) onClose();
    };
    document.addEventListener('pointerdown', onPointerDown, true);
    document.addEventListener('keydown', onKey);
    window.addEventListener('scroll', onScroll, true);
    window.addEventListener('resize', onClose);
    window.addEventListener('blur', onClose);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown, true);
      document.removeEventListener('keydown', onKey);
      window.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('resize', onClose);
      window.removeEventListener('blur', onClose);
    };
  }, [onClose]);

  const onMenuKey = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp' && e.key !== 'Home' && e.key !== 'End') return;
    e.preventDefault();
    const buttons = Array.from(ref.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? []);
    if (!buttons.length) return;
    const index = buttons.findIndex(b => b === document.activeElement);
    let next = 0;
    if (e.key === 'ArrowDown') next = index < 0 ? 0 : (index + 1) % buttons.length;
    else if (e.key === 'ArrowUp') next = index < 0 ? buttons.length - 1 : (index - 1 + buttons.length) % buttons.length;
    else if (e.key === 'End') next = buttons.length - 1;
    buttons[next].focus();
  };

  return (
    <div
      ref={ref}
      className="st-context-menu"
      role="menu"
      aria-label={label}
      style={{ left: pos.left, top: pos.top }}
      onKeyDown={onMenuKey}
      onContextMenu={e => e.preventDefault()}
    >
      {items.map((item, i) =>
        'separator' in item ? (
          <div key={`sep-${i}`} className="st-context-sep" role="separator" />
        ) : (
          <button
            key={item.id}
            type="button"
            role="menuitem"
            className={`st-context-item${item.danger ? ' danger' : ''}`}
            disabled={item.disabled}
            onClick={() => {
              item.onSelect();
              onClose();
            }}
          >
            <span>{item.label}</span>
            {item.shortcut ? <kbd>{item.shortcut}</kbd> : null}
          </button>
        )
      )}
    </div>
  );
}
