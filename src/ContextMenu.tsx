import { useEffect, useRef, type ReactNode } from 'react';

export type MenuItem = { label: string; icon?: ReactNode; onSelect: () => void };

export type MenuAt = { x: number; y: number; items: MenuItem[] };

/**
 * A small menu where the pointer was right-clicked. Esc, a click elsewhere or scrolling
 * closes it; arrow keys move between items.
 */
export default function ContextMenu({ at, onClose }: { at: MenuAt; onClose: () => void }) {
  const ref = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    ref.current?.querySelector('button')?.focus();
    const away = (e: Event) => {
      if (ref.current && e.target instanceof Node && ref.current.contains(e.target)) return;
      onClose();
    };
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.preventDefault(); onClose(); return; }
      if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
      e.preventDefault();
      const buttons = Array.from(ref.current?.querySelectorAll('button') ?? []);
      const now = buttons.indexOf(document.activeElement as HTMLButtonElement);
      const next = (now + (e.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length;
      buttons[next]?.focus();
    };
    window.addEventListener('pointerdown', away, true);
    window.addEventListener('wheel', away, true);
    window.addEventListener('blur', onClose);
    window.addEventListener('keydown', key);
    return () => {
      window.removeEventListener('pointerdown', away, true);
      window.removeEventListener('wheel', away, true);
      window.removeEventListener('blur', onClose);
      window.removeEventListener('keydown', key);
    };
  }, [onClose]);

  // Kept on screen near the window's right and bottom edges.
  const left = Math.min(at.x, window.innerWidth - 220);
  const top = Math.min(at.y, window.innerHeight - 12 - at.items.length * 36);

  return (
    <div ref={ref} className="context-menu" role="menu" style={{ left, top }}>
      {at.items.map((item) => (
        <button
          key={item.label}
          type="button"
          role="menuitem"
          onClick={() => { onClose(); item.onSelect(); }}
        >
          {item.icon}
          {item.label}
        </button>
      ))}
    </div>
  );
}
