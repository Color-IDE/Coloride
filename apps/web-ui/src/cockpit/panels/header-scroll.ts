import { attachThinScrollbar } from "../../ui/thin-scrollbar.js";

/**
 * Edge shadows for a header tab strip (state exposed as data attributes, drawn in CSS) plus the
 * shared thin scrollbar. Returns a function that releases both.
 *
 * The state is refreshed on scroll, but also whenever the strip resizes or its tabs change:
 * a new tab can make the strip overflow without any scroll event, and the shadow must show then.
 */
export function attachHeaderScroll(headerEl: HTMLElement, scrollEl: HTMLElement): () => void {
  const scrollbar = attachThinScrollbar(headerEl, scrollEl, "x");
  const refresh = () => {
    const { scrollLeft, scrollWidth, clientWidth } = scrollEl;
    const maxScroll = Math.max(0, scrollWidth - clientWidth);
    headerEl.dataset.scrollable = String(maxScroll > 2);
    headerEl.dataset.scrollLeft = String(scrollLeft > 2);
    headerEl.dataset.scrollRight = String(maxScroll - scrollLeft > 2);
    scrollbar.update();
  };
  scrollEl.addEventListener("scroll", refresh, { passive: true });
  const win = headerEl.ownerDocument.defaultView;
  win?.addEventListener("resize", refresh, { passive: true });
  // The panel resizing (panel toggles, window) or tabs being added, removed or renamed.
  const resizeObserver = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(refresh);
  resizeObserver?.observe(scrollEl);
  const mutationObserver =
    typeof MutationObserver === "undefined" ? null : new MutationObserver(refresh);
  mutationObserver?.observe(scrollEl, { childList: true, subtree: true, characterData: true });
  win?.requestAnimationFrame?.(refresh);
  refresh();
  return () => {
    scrollEl.removeEventListener("scroll", refresh);
    win?.removeEventListener("resize", refresh);
    resizeObserver?.disconnect();
    mutationObserver?.disconnect();
    scrollbar.destroy();
  };
}
