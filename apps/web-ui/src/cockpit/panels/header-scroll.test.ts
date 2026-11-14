// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import { attachHeaderScroll } from "./header-scroll.js";

describe("attachHeaderScroll", () => {
  it("shows the edge shadows as soon as tabs make the strip overflow, without any scroll", async () => {
    const header = document.createElement("div");
    const track = document.createElement("div");
    header.append(track);
    document.body.append(header);
    let scrollWidth = 300;
    Object.defineProperty(track, "scrollWidth", { get: () => scrollWidth });
    Object.defineProperty(track, "clientWidth", { get: () => 400 });
    const release = attachHeaderScroll(header, track);
    expect(header.dataset.scrollRight).toBe("false");
    expect(header.dataset.scrollable).toBe("false");

    // A tab is added and the strip now overflows: no scroll event is fired by the browser.
    scrollWidth = 1000;
    track.append(document.createElement("div"));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(header.dataset.scrollable).toBe("true");
    expect(header.dataset.scrollRight).toBe("true");
    expect(header.dataset.scrollLeft).toBe("false");

    // Removing tabs clears it again.
    scrollWidth = 300;
    track.replaceChildren();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(header.dataset.scrollRight).toBe("false");

    release();
    header.remove();
  });
});
