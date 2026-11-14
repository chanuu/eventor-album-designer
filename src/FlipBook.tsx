import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import type { Cover, PhotoInfo, ProjectSpec, Spread } from './api';
import { colourOf, drawCover, loadCoverFonts, type CoverSide } from './cover';
import { FrameBorder, FramedPhoto, frameStyle, ThumbText } from './spreadParts';

/**
 * The album as a book that can be picked up and leafed through.
 *
 * Each leaf turns about the spine. The cover is the first leaf and the back cover the
 * last, with every spread split across the two pages that face each other, as it is in
 * the client's flip album. The stacks of pages either side have real thickness, so a
 * closed book looks like a book and not a picture of one.
 */

/** Wide enough to stay sharp on a large screen without asking for the full photo. */
const PAGE_PREVIEW = 1024;

/** Only the pages near the one on show are drawn in full. */
const DRAWN_EITHER_SIDE = 2;

const MAX_COVER_PX = 1400;

/** One side of the cover, drawn at the size it is shown, with foil that catches the light. */
export function CoverFace({ cover, side }: { cover: Cover; side: CoverSide }) {
  const box = useRef<HTMLDivElement>(null);
  const shown = useRef<HTMLCanvasElement>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  const [foil, setFoil] = useState<string | null>(null);
  const look = JSON.stringify(cover);

  useEffect(() => {
    const el = box.current;
    if (!el) return undefined;
    const watch = new ResizeObserver(() => {
      const scale = Math.min(2, window.devicePixelRatio || 1);
      const w = Math.min(MAX_COVER_PX, Math.round(el.clientWidth * scale));
      const h = Math.round((w * el.clientHeight) / Math.max(1, el.clientWidth));
      setSize((was) => (Math.abs(was.w - w) > 8 || Math.abs(was.h - h) > 8 ? { w, h } : was));
    });
    watch.observe(el);
    return () => watch.disconnect();
  }, []);

  useEffect(() => {
    if (size.w < 8 || size.h < 8) return undefined;
    let current = true;
    let made: string | null = null;
    void loadCoverFonts().then(() => {
      const target = shown.current;
      if (!current || !target) return;
      const drawn = drawCover(JSON.parse(look) as Cover, size.w, size.h, side);
      target.width = size.w;
      target.height = size.h;
      target.getContext('2d')?.drawImage(drawn.canvas, 0, 0);
      drawn.foil.toBlob((blob) => {
        if (!blob) return;
        const url = URL.createObjectURL(blob);
        if (!current) {
          URL.revokeObjectURL(url);
          return;
        }
        made = url;
        setFoil(url);
      });
    });
    return () => {
      current = false;
      if (made) {
        const old = made;
        setTimeout(() => URL.revokeObjectURL(old), 1000);
      }
    };
  }, [look, side, size]);

  return (
    <div ref={box} className="cover-face">
      <canvas ref={shown} />
      {foil && cover.foil !== 'blind' && (
        <span className="cover-glint" style={{ maskImage: `url(${foil})`, WebkitMaskImage: `url(${foil})` }} />
      )}
      <span className="cover-sheen" />
    </div>
  );
}

/** What the client sees when no cover has been designed: Eventor's own title page. */
export function TitlePage({ title, closing }: { title: string; closing?: boolean }) {
  return (
    <div className="title-page">
      {closing ? <em>With love</em> : <strong>{title}</strong>}
    </div>
  );
}

export function HalfSpread({ spread, half, byId }: { spread: Spread; half: 'left' | 'right'; byId: Map<string, PhotoInfo> }) {
  const { design } = spread;
  return (
    <div className={`fb-half fb-half-${half}`} style={{ background: design.background.value }}>
      {design.frames.map((frame) => {
        const photo = frame.asset_id ? byId.get(frame.asset_id) : undefined;
        return (
          <span key={frame.id} className="frame" style={frameStyle(frame, design)}>
            {photo && <FramedPhoto photo={photo} frame={frame} width={PAGE_PREVIEW} />}
            <FrameBorder frame={frame} design={design} />
          </span>
        );
      })}
      {design.texts.map((text) => <ThumbText key={text.id} block={text} design={design} />)}
    </div>
  );
}

export default function FlipBook({
  spec, spreads, photos, cover, title, at, onAt,
}: {
  spec: ProjectSpec;
  spreads: Spread[];
  photos: PhotoInfo[];
  cover: Cover | null;
  title: string;
  /** How many leaves have been turned: 0 is closed, one more than the spreads is the back. */
  at: number;
  onAt: (at: number) => void;
}) {
  const stage = useRef<HTMLDivElement>(null);
  const byId = useMemo(() => new Map(photos.map((p) => [p.id, p])), [photos]);
  const leaves = spreads.length + 1;
  const depth = Math.min(46, 22 + leaves * 1.6);
  const perLeaf = depth / leaves;
  const aspect = spec.trim_w_mm / spec.trim_h_mm;

  // The book leans a little towards the pointer, which also moves the light on the foil.
  const lean = (e: React.PointerEvent) => {
    const el = stage.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    el.style.setProperty('--mx', String(((e.clientX - r.left) / r.width) * 2 - 1));
    el.style.setProperty('--my', String(((e.clientY - r.top) / r.height) * 2 - 1));
  };

  const state = at === 0 ? 'at-front' : at === leaves ? 'at-back' : 'open';
  const right = (leaves - at) * perLeaf;
  const left = at * perLeaf;
  const board = cover ? colourOf(cover) : '#e9e4da';

  const face = (side: CoverSide) => (cover ? <CoverFace cover={cover} side={side} /> : <TitlePage title={title} closing={side === 'back'} />);

  return (
    <div ref={stage} className={`fb-stage ${spreads.length ? '' : 'fb-solo'}`} onPointerMove={lean}>
      <div
        className={`fb-book ${state}`}
        style={{ '--wide': String(aspect * 2), '--board': board, aspectRatio: String(aspect * 2) } as CSSProperties}
      >
        <span className={`fb-shadow fb-shadow-right ${at < leaves ? 'on' : ''}`} />
        <span className={`fb-shadow fb-shadow-left ${at > 0 ? 'on' : ''}`} />

        <span className={`fb-edge fb-fore-right ${at === 0 ? 'capped' : ''}`} style={{ width: right }} />
        <span className={`fb-edge fb-foot-right ${at === 0 ? 'capped' : ''}`} style={{ height: right }} />
        <span className={`fb-edge fb-head-right ${at === 0 ? 'capped' : ''}`} style={{ height: right }} />
        <span className={`fb-edge fb-fore-left ${at === leaves ? 'capped' : ''}`} style={{ width: left }} />
        <span className={`fb-edge fb-foot-left ${at === leaves ? 'capped' : ''}`} style={{ height: left }} />
        <span className={`fb-edge fb-head-left ${at === leaves ? 'capped' : ''}`} style={{ height: left }} />
        <span className="fb-spine fb-spine-front" style={{ width: at === 0 ? right : 0 }} />
        <span className="fb-spine fb-spine-back" style={{ width: at === leaves ? left : 0 }} />

        {Array.from({ length: leaves }, (_, k) => {
          const turned = k < at;
          const near = Math.abs(k - at) <= DRAWN_EITHER_SIDE;
          const height = (turned ? k + 1 : leaves - k) * perLeaf;
          const isCover = k === 0;
          const isBack = k === leaves - 1;
          return (
            <div
              key={k}
              className={`fb-leaf ${isCover || isBack ? 'fb-board' : ''}`}
              style={{ transform: `translateZ(${height}px) rotateY(${turned ? -180 : 0}deg)` }}
              onClick={() => onAt(turned ? k : k + 1)}
            >
              <div className={`fb-face fb-face-front ${isCover ? 'fb-outside' : ''}`}>
                {isCover ? face('front') : near && <HalfSpread spread={spreads[k - 1]} half="right" byId={byId} />}
              </div>
              <div className={`fb-face fb-face-back ${isBack ? 'fb-outside' : ''}`}>
                {isBack ? face('back') : near && <HalfSpread spread={spreads[k]} half="left" byId={byId} />}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
