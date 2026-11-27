import { forwardRef, useEffect, useImperativeHandle, useMemo, useRef, useState, type CSSProperties } from 'react';
import { createPortal } from 'react-dom';
import { PageFlip } from 'page-flip/dist/js/page-flip.module.js';
import type { Cover, PhotoInfo, ProjectSpec, Spread } from './api';
import { colourOf, type CoverSide } from './cover';
import { CoverFace, HalfSpread, TitlePage } from './FlipBook';

/**
 * The album as the client turns it: paper that curls, and can be dragged over by a corner.
 *
 * The turning is StPageFlip, the same library and settings as the client's flip album, so
 * what is seen here is what they get. Closed, the book still lies on the table with its
 * thickness and shadow; it lies flat the moment a page starts to turn, because the paper
 * follows the pointer and has to be where the pointer thinks it is.
 *
 * StPageFlip owns the page elements and moves them about, so they are made by hand and
 * React only draws inside them.
 */

export interface PaperBookHandle {
  next(): void;
  prev(): void;
}

/** Pages this far either side of the open one are drawn; a turn shows no further. */
const DRAWN_EITHER_SIDE = 4;

const FLIP_MS = 800;

interface Props {
  spec: ProjectSpec;
  spreads: Spread[];
  photos: PhotoInfo[];
  cover: Cover | null;
  title: string;
  /** How many leaves have been turned: 0 is closed, one more than the spreads is the back. */
  onAt: (at: number) => void;
}

const PaperBook = forwardRef<PaperBookHandle, Props>(function PaperBook({ spec, spreads, photos, cover, title, onAt }, ref) {
  const stage = useRef<HTMLDivElement>(null);
  const host = useRef<HTMLDivElement>(null);
  const flip = useRef<PageFlip | null>(null);
  const place = useRef(0);
  const [box, setBox] = useState<{ w: number; h: number } | null>(null);
  const [pages, setPages] = useState<HTMLElement[]>([]);
  const [page, setPage] = useState(0);
  const [turning, setTurning] = useState(false);
  const byId = useMemo(() => new Map(photos.map((p) => [p.id, p])), [photos]);

  // The front cover, each spread as its two facing pages, and the back cover.
  const count = spreads.length * 2 + 2;
  const aspect = spec.trim_w_mm / spec.trim_h_mm;
  const depth = Math.min(46, 22 + (spreads.length + 1) * 1.6);

  useImperativeHandle(ref, () => ({
    next: () => flip.current?.flipNext(),
    prev: () => flip.current?.flipPrev(),
  }), []);

  useEffect(() => {
    const el = stage.current;
    if (!el) return undefined;
    const watch = new ResizeObserver(() => {
      const w = el.clientWidth;
      const h = el.clientHeight;
      if (w < 200 || h < 200) return;
      setBox((was) => (was && Math.abs(was.w - w) < 24 && Math.abs(was.h - h) < 24 ? was : { w, h }));
    });
    watch.observe(el);
    return () => watch.disconnect();
  }, []);

  let pageW = 0;
  let pageH = 0;
  if (box) {
    pageH = box.h * 0.78;
    pageW = pageH * aspect;
    const widest = box.w * 0.44;
    if (pageW > widest) {
      pageW = widest;
      pageH = pageW / aspect;
    }
    pageW = Math.round(pageW);
    pageH = Math.round(pageH);
  }

  // StPageFlip fixes the page size when it is made, so a new size means a new book.
  useEffect(() => {
    const el = host.current;
    if (!el || !pageW || !pageH) return undefined;
    const mount = document.createElement('div');
    mount.style.cssText = `width:${pageW * 2}px;height:${pageH}px`;
    el.appendChild(mount);
    const holder = document.createElement('div');
    holder.style.cssText = 'position:absolute;left:-99999px;top:0';
    const made = Array.from({ length: count }, (_, i) => {
      const leaf = document.createElement('div');
      leaf.className = 'pb-page';
      if (i === 0 || i === count - 1) leaf.setAttribute('data-density', 'hard');
      holder.appendChild(leaf);
      return leaf;
    });
    mount.appendChild(holder);

    const book = new PageFlip(mount, {
      width: pageW,
      height: pageH,
      size: 'fixed',
      showCover: true,
      maxShadowOpacity: 0.5,
      drawShadow: true,
      flippingTime: FLIP_MS,
      usePortrait: false,
      mobileScrollSupport: false,
      swipeDistance: 20,
      clickEventForward: false,
    });
    book.loadFromHTML(made);
    book.on('flip', (e) => {
      place.current = Number(e.data);
      setPage(place.current);
    });
    book.on('changeState', (e) => setTurning(e.data === 'flipping' || e.data === 'user_fold'));
    flip.current = book;

    // Keep the place when the window changes size.
    if (place.current > 0) {
      try {
        book.turnToPage(Math.min(place.current, count - 1));
      } catch {
        /* the book is shorter now; it opens at the cover */
      }
    }
    setPage(book.getCurrentPageIndex());
    setTurning(false);
    setPages(made);

    return () => {
      flip.current = null;
      setPages([]);
      try {
        book.destroy();
      } catch {
        /* already gone */
      }
      el.innerHTML = '';
    };
  }, [pageW, pageH, count]);

  // StPageFlip counts pages; the album counts leaves turned.
  const at = Math.floor((page + 1) / 2);
  useEffect(() => onAt(at), [at, onAt]);

  // The closed book leans a little towards the pointer, which also moves the light on the foil.
  const lean = (e: React.PointerEvent) => {
    const el = stage.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    el.style.setProperty('--mx', String(((e.clientX - r.left) / r.width) * 2 - 1));
    el.style.setProperty('--my', String(((e.clientY - r.top) / r.height) * 2 - 1));
  };

  const state = turning ? 'open' : page === 0 ? 'at-front' : page >= count - 1 ? 'at-back' : 'open';
  const front = state === 'at-front' ? depth : 0;
  const back = state === 'at-back' ? depth : 0;
  const board = cover ? colourOf(cover) : '#e9e4da';

  const face = (side: CoverSide) => (cover ? <CoverFace cover={cover} side={side} /> : <TitlePage title={title} closing={side === 'back'} />);

  const drawn = (i: number) => {
    if (i === 0) return face('front');
    if (i === count - 1) return face('back');
    if (Math.abs(i - page) > DRAWN_EITHER_SIDE) return null;
    const spread = spreads[Math.floor((i - 1) / 2)];
    return spread ? <HalfSpread spread={spread} half={i % 2 === 1 ? 'left' : 'right'} byId={byId} /> : null;
  };

  return (
    <div ref={stage} className="fb-stage" onPointerMove={lean}>
      <div
        className={`fb-book fb-paper ${state}`}
        style={{ width: pageW * 2, height: pageH, '--board': board, '--deep': `${depth}px` } as CSSProperties}
      >
        <span className={`fb-shadow fb-shadow-right ${page < count - 1 ? 'on' : ''}`} />
        <span className={`fb-shadow fb-shadow-left ${page > 0 ? 'on' : ''}`} />

        <span className="fb-edge fb-fore-right capped" style={{ width: front }} />
        <span className="fb-edge fb-foot-right capped" style={{ height: front }} />
        <span className="fb-edge fb-head-right capped" style={{ height: front }} />
        <span className="fb-edge fb-fore-left capped" style={{ width: back }} />
        <span className="fb-edge fb-foot-left capped" style={{ height: back }} />
        <span className="fb-edge fb-head-left capped" style={{ height: back }} />
        <span className="fb-spine fb-spine-front" style={{ width: front }} />
        <span className="fb-spine fb-spine-back" style={{ width: back }} />

        <div ref={host} className="pb-host" />
      </div>
      {pages.map((leaf, i) => createPortal(drawn(i), leaf, String(i)))}
    </div>
  );
});

export default PaperBook;
