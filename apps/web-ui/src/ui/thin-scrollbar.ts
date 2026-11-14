export type ThinScrollbarAxis = "x" | "y";

export interface ThinScrollbar {
  /** Re-measures the scroller and repositions the thumb. */
  update(): void;
  destroy(): void;
}

const MIN_THUMB_RATIO = 0.15;

/**
 * Overlay scrollbar: a 2px thumb that appears while the pointer is over `host`.
 * One implementation for every scroller (header tabs, file tree, code editor).
 * `host` must be positioned; the native scrollbar of `scrollEl` is expected to be hidden.
 */
export function attachThinScrollbar(
  host: HTMLElement,
  scrollEl: HTMLElement,
  axis: ThinScrollbarAxis,
): ThinScrollbar {
  const doc = host.ownerDocument;
  const vertical = axis === "y";
  const track = doc.createElement("div");
  track.className = `coloride-thin-scrollbar coloride-thin-scrollbar--${axis}`;
  track.setAttribute("aria-hidden", "true");
  const thumb = doc.createElement("div");
  thumb.className = "coloride-thin-scrollbar-thumb";
  track.append(thumb);
  host.append(track);

  const metrics = () => ({
    scroll: vertical ? scrollEl.scrollTop : scrollEl.scrollLeft,
    size: vertical ? scrollEl.scrollHeight : scrollEl.scrollWidth,
    view: vertical ? scrollEl.clientHeight : scrollEl.clientWidth,
  });

  const update = () => {
    const { scroll, size, view } = metrics();
    const max = Math.max(0, size - view);
    const scrollable = max > 2;
    track.dataset.scrollable = String(scrollable);
    if (!scrollable || size <= 0) {
      thumb.style[vertical ? "height" : "width"] = "0%";
      return;
    }
    const ratio = Math.max(MIN_THUMB_RATIO, Math.min(1, view / size));
    const progress = Math.min(1, Math.max(0, scroll / max));
    thumb.style[vertical ? "height" : "width"] = `${(ratio * 100).toFixed(2)}%`;
    thumb.style[vertical ? "top" : "left"] = `${(progress * (100 - ratio * 100)).toFixed(2)}%`;
  };

  let dragging = false;
  let dragStart = 0;
  let dragStartScroll = 0;
  const trackLength = () => track.getBoundingClientRect()[vertical ? "height" : "width"];
  const thumbLength = () => thumb.getBoundingClientRect()[vertical ? "height" : "width"];
  const pointer = (event: PointerEvent) => (vertical ? event.clientY : event.clientX);
  const setScroll = (value: number) => {
    if (vertical) scrollEl.scrollTop = value;
    else scrollEl.scrollLeft = value;
  };

  const onPointerDown = (event: PointerEvent) => {
    event.preventDefault();
    event.stopPropagation();
    const { size, view } = metrics();
    const max = Math.max(0, size - view);
    if (max <= 0) return;
    const trackRect = track.getBoundingClientRect();
    const thumbRect = thumb.getBoundingClientRect();
    const start = vertical ? trackRect.top : trackRect.left;
    const thumbStart = vertical ? thumbRect.top : thumbRect.left;
    const thumbEnd = vertical ? thumbRect.bottom : thumbRect.right;
    const at = pointer(event);
    // Clicking the track outside the thumb jumps the thumb's center to the pointer first.
    if (at < thumbStart || at > thumbEnd) {
      const usable = Math.max(1, trackLength() - thumbLength());
      const target = Math.max(0, Math.min(usable, at - start - thumbLength() / 2));
      setScroll((target / usable) * max);
      update();
    }
    dragging = true;
    dragStart = pointer(event);
    dragStartScroll = metrics().scroll;
    track.dataset.dragging = "true";
    track.setPointerCapture?.(event.pointerId);
  };
  const onPointerMove = (event: PointerEvent) => {
    if (!dragging) return;
    event.preventDefault();
    const { size, view } = metrics();
    const max = Math.max(0, size - view);
    const usable = Math.max(1, trackLength() - thumbLength());
    const delta = pointer(event) - dragStart;
    setScroll(Math.max(0, Math.min(max, dragStartScroll + (delta / usable) * max)));
    update();
  };
  const stopDragging = (event: PointerEvent) => {
    if (!dragging) return;
    dragging = false;
    delete track.dataset.dragging;
    track.releasePointerCapture?.(event.pointerId);
  };

  track.addEventListener("pointerdown", onPointerDown);
  track.addEventListener("pointermove", onPointerMove);
  track.addEventListener("pointerup", stopDragging);
  track.addEventListener("pointercancel", stopDragging);
  scrollEl.addEventListener("scroll", update, { passive: true });

  // Content growing or the panel resizing changes the thumb without any scroll event.
  const win = doc.defaultView;
  win?.addEventListener("resize", update, { passive: true });
  let observer: ResizeObserver | undefined;
  if (typeof ResizeObserver !== "undefined") {
    observer = new ResizeObserver(update);
    observer.observe(scrollEl);
    for (const child of Array.from(scrollEl.children)) observer.observe(child);
  }
  win?.requestAnimationFrame?.(update);
  update();

  return {
    update,
    destroy() {
      scrollEl.removeEventListener("scroll", update);
      win?.removeEventListener("resize", update);
      observer?.disconnect();
      track.remove();
    },
  };
}
