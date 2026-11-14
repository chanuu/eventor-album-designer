/**
 * StPageFlip ships no type declarations. The ESM build is imported directly: the
 * package's `main` points at a UMD bundle, and only `page-flip.module.js` carries a
 * real `export { PageFlip }`.
 *
 * Only what the preview uses is declared here.
 */
declare module 'page-flip/dist/js/page-flip.module.js' {
  export interface PageFlipSettings {
    width: number;
    height: number;
    size?: 'fixed' | 'stretch';
    showCover?: boolean;
    maxShadowOpacity?: number;
    drawShadow?: boolean;
    flippingTime?: number;
    usePortrait?: boolean;
    mobileScrollSupport?: boolean;
    swipeDistance?: number;
    clickEventForward?: boolean;
  }

  export class PageFlip {
    constructor(element: HTMLElement, settings: PageFlipSettings);
    loadFromHTML(items: NodeListOf<Element> | HTMLElement[]): void;
    on(event: 'flip' | 'changeOrientation' | 'changeState' | 'init', handler: (e: { data: unknown }) => void): void;
    flipNext(): void;
    flipPrev(): void;
    turnToPage(pageIndex: number): void;
    getCurrentPageIndex(): number;
    getPageCount(): number;
    update(): void;
    destroy(): void;
  }
}
