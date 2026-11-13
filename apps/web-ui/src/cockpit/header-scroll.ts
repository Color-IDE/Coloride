import { attachThinScrollbar } from "../thin-scrollbar.js";

/**
 * Edge shadows for a header tab strip (state exposed as data attributes, drawn in CSS) plus the
 * shared thin scrollbar. Returns a function that releases both.
 */
export function attachHeaderScroll(headerEl: HTMLElement, scrollEl: HTMLElement): () => void {
  const scrollbar = attachThinScrollbar(headerEl, scrollEl, "x");
  const updateShadows = () => {
    const { scrollLeft, scrollWidth, clientWidth } = scrollEl;
    const maxScroll = Math.max(0, scrollWidth - clientWidth);
    headerEl.dataset.scrollable = String(maxScroll > 2);
    headerEl.dataset.scrollLeft = String(scrollLeft > 2);
    headerEl.dataset.scrollRight = String(maxScroll - scrollLeft > 2);
  };
  scrollEl.addEventListener("scroll", updateShadows, { passive: true });
  const win = headerEl.ownerDocument.defaultView;
  win?.addEventListener("resize", updateShadows, { passive: true });
  win?.requestAnimationFrame?.(updateShadows);
  updateShadows();
  return () => {
    scrollEl.removeEventListener("scroll", updateShadows);
    win?.removeEventListener("resize", updateShadows);
    scrollbar.destroy();
  };
}
