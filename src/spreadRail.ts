import { useCallback, useEffect, useRef, useState } from 'react';

/** How far the pointer must travel before a press becomes a slide. */
const SLIDE_START_PX = 5;
/** A shorter slide than this springs back unless it reaches the next spread by itself. */
const SLIDE_STEP_PX = 80;
/** A mouse wheel's notches, or a trackpad's long swipe, move one spread at a time. */
const WHEEL_GAP_MS = 260;
/** In case a slide ends exactly in place, when the browser reports no end of scrolling. */
const SLIDE_END_MS = 700;

type Drag = { pointerId: number; x: number; left: number; moved: boolean };

function slots(rail: HTMLElement): HTMLElement[] {
  return [...rail.querySelectorAll<HTMLElement>('[data-spread-id]')];
}

function leftFor(rail: HTMLElement, slot: HTMLElement): number {
  return slot.offsetLeft + slot.offsetWidth / 2 - rail.clientWidth / 2;
}

function slotFor(rail: HTMLElement, id: string): HTMLElement | undefined {
  return slots(rail).find((s) => s.dataset.spreadId === id);
}

function nearestId(rail: HTMLElement): string | null {
  const middle = rail.scrollLeft + rail.clientWidth / 2;
  let best: HTMLElement | null = null;
  let bestGap = Infinity;
  for (const slot of slots(rail)) {
    const gap = Math.abs(slot.offsetLeft + slot.offsetWidth / 2 - middle);
    if (gap < bestGap) {
      best = slot;
      bestGap = gap;
    }
  }
  return best?.dataset.spreadId ?? null;
}

/**
 * Keeps the row of spreads and the current spread in step, whichever one moved first:
 * choosing a spread slides the row to it, and sliding the row chooses the spread it stops on.
 */
export function useSpreadRail(
  currentId: string | null,
  currentIndex: number,
  onPick: (id: string) => void,
  onStep: (step: -1 | 1) => void,
) {
  const [rail, setRail] = useState<HTMLElement | null>(null);
  const [sliding, setSliding] = useState(false);
  const current = useRef(currentId);
  current.current = currentId;
  // Set when the row itself chose the spread, so it does not then slide to where it already is.
  const settled = useRef<string | null>(null);
  // Set while sliding on our own, so that being interrupted does not change the current spread.
  const aiming = useRef(false);
  const placed = useRef(false);
  const drag = useRef<Drag | null>(null);
  const justSlid = useRef(false);
  const lastWheel = useRef(0);
  const endTimer = useRef<number>();

  useEffect(() => {
    placed.current = false;
  }, [rail]);

  useEffect(() => {
    if (!rail || !currentId) return;
    if (settled.current === currentId) {
      settled.current = null;
      return;
    }
    const slot = slotFor(rail, currentId);
    if (!slot) return;
    const left = leftFor(rail, slot);
    // Sliding past a long run of spreads would only be a blur.
    const smooth = placed.current && Math.abs(rail.scrollLeft - left) < rail.clientWidth * 2.5;
    placed.current = true;
    aiming.current = smooth;
    rail.scrollTo({ left, behavior: smooth ? 'smooth' : 'auto' });
  }, [rail, currentId, currentIndex]);

  useEffect(() => {
    if (!rail) return undefined;
    const onEnd = () => {
      if (drag.current?.moved) return;
      window.clearTimeout(endTimer.current);
      setSliding(false);
      const nearest = nearestId(rail);
      if (!nearest || nearest === current.current) {
        aiming.current = false;
        return;
      }
      if (aiming.current && current.current) {
        aiming.current = false;
        const slot = slotFor(rail, current.current);
        if (slot) rail.scrollTo({ left: leftFor(rail, slot), behavior: 'smooth' });
        return;
      }
      settled.current = nearest;
      onPick(nearest);
    };
    // Showing or hiding a panel changes the width, and the spread must stay in the middle.
    const resized = new ResizeObserver(() => {
      const slot = current.current ? slotFor(rail, current.current) : undefined;
      if (slot && !drag.current) rail.scrollTo({ left: leftFor(rail, slot), behavior: 'auto' });
    });
    resized.observe(rail);
    rail.addEventListener('scrollend', onEnd);
    return () => {
      resized.disconnect();
      rail.removeEventListener('scrollend', onEnd);
    };
  }, [rail, onPick]);

  const onPointerDown = useCallback((e: React.PointerEvent<HTMLElement>) => {
    if (e.button !== 0 || !rail) return;
    const target = e.target as Element;
    // Photos and text on the current spread have their own dragging.
    if (!target.closest('.spread-peek') && target.closest('.frame, .text-block, button')) return;
    drag.current = { pointerId: e.pointerId, x: e.clientX, left: rail.scrollLeft, moved: false };
  }, [rail]);

  const onPointerMove = useCallback((e: React.PointerEvent<HTMLElement>) => {
    const d = drag.current;
    if (!d || !rail || e.pointerId !== d.pointerId) return;
    // The button can be let go outside the window, where no release reaches us.
    if (e.buttons === 0) {
      drag.current = null;
      return;
    }
    const moved = e.clientX - d.x;
    if (!d.moved) {
      if (Math.abs(moved) < SLIDE_START_PX) return;
      d.moved = true;
      rail.setPointerCapture(d.pointerId);
      setSliding(true);
    }
    rail.scrollLeft = d.left - moved;
  }, [rail]);

  const onPointerEnd = useCallback((e: React.PointerEvent<HTMLElement>) => {
    const d = drag.current;
    drag.current = null;
    if (!d?.moved || !rail) return;
    justSlid.current = true;
    window.setTimeout(() => { justSlid.current = false; }, 50);
    endTimer.current = window.setTimeout(() => setSliding(false), SLIDE_END_MS);

    const moved = e.clientX - d.x;
    const nearest = nearestId(rail);
    if (nearest && nearest !== current.current) {
      onPick(nearest);
      return;
    }
    if (Math.abs(moved) >= SLIDE_STEP_PX) {
      const index = slots(rail).findIndex((s) => s.dataset.spreadId === current.current);
      const next = slots(rail)[index + (moved < 0 ? 1 : -1)];
      if (next) {
        onStep(moved < 0 ? 1 : -1);
        return;
      }
    }
    const slot = current.current ? slotFor(rail, current.current) : undefined;
    if (slot) {
      aiming.current = true;
      rail.scrollTo({ left: leftFor(rail, slot), behavior: 'smooth' });
    }
  }, [rail, onPick, onStep]);

  const onClickCapture = useCallback((e: React.MouseEvent) => {
    if (!justSlid.current) return;
    e.stopPropagation();
    e.preventDefault();
  }, []);

  const onWheel = useCallback((e: React.WheelEvent) => {
    if (Math.abs(e.deltaY) <= Math.abs(e.deltaX)) return;
    const now = Date.now();
    if (now - lastWheel.current < WHEEL_GAP_MS) return;
    lastWheel.current = now;
    onStep(e.deltaY > 0 ? 1 : -1);
  }, [onStep]);

  return {
    setRail,
    sliding,
    handlers: {
      onPointerDown,
      onPointerMove,
      onPointerUp: onPointerEnd,
      onPointerCancel: onPointerEnd,
      onClickCapture,
      onWheel,
    },
  };
}
