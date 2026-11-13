// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from "vitest";
import { attachThinScrollbar } from "./thin-scrollbar.js";

const cleanup: Array<() => void> = [];
afterEach(() => {
  for (const fn of cleanup.splice(0)) fn();
});

function setup(axis: "x" | "y", size: number, view: number, scroll = 0) {
  const host = document.createElement("div");
  const scroller = document.createElement("div");
  host.append(scroller);
  document.body.append(host);
  const dims =
    axis === "y"
      ? { size: "scrollHeight", view: "clientHeight" }
      : { size: "scrollWidth", view: "clientWidth" };
  Object.defineProperty(scroller, dims.size, { value: size, configurable: true });
  Object.defineProperty(scroller, dims.view, { value: view, configurable: true });
  const key = axis === "y" ? "scrollTop" : "scrollLeft";
  scroller[key] = scroll;
  const bar = attachThinScrollbar(host, scroller, axis);
  cleanup.push(() => {
    bar.destroy();
    host.remove();
  });
  const track = host.querySelector<HTMLElement>(".coloride-thin-scrollbar");
  const thumb = host.querySelector<HTMLElement>(".coloride-thin-scrollbar-thumb");
  if (!track || !thumb) throw new Error("Missing scrollbar nodes");
  return { host, scroller, bar, track, thumb };
}

describe("thin scrollbar", () => {
  it("sizes and positions the thumb on the vertical axis", () => {
    const { track, thumb, scroller, bar } = setup("y", 1000, 250, 0);
    expect(track.className).toContain("coloride-thin-scrollbar--y");
    expect(track.dataset.scrollable).toBe("true");
    expect(thumb.style.height).toBe("25.00%");
    expect(thumb.style.top).toBe("0.00%");
    scroller.scrollTop = 750; // fully scrolled
    bar.update();
    expect(thumb.style.top).toBe("75.00%");
  });

  it("uses width/left on the horizontal axis and keeps a minimum thumb size", () => {
    const { track, thumb } = setup("x", 100000, 100, 0);
    expect(track.className).toContain("coloride-thin-scrollbar--x");
    expect(thumb.style.width).toBe("15.00%");
  });

  it("is inert when the content fits, and removes itself on destroy", () => {
    const { host, track, thumb, bar } = setup("y", 100, 100);
    expect(track.dataset.scrollable).toBe("false");
    expect(thumb.style.height).toBe("0%");
    bar.destroy();
    expect(host.querySelector(".coloride-thin-scrollbar")).toBeNull();
  });
});
