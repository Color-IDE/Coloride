// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import { SidebarRow, splitSessionNumber } from "./sidebar-row.js";

describe("session number on the right of a sidebar row", () => {
  it("splits '#16 New session' into its number and name", () => {
    expect(splitSessionNumber("#16 New session")).toEqual({ number: "#16", name: "New session" });
    expect(splitSessionNumber("#4 Fix login")).toEqual({ number: "#4", name: "Fix login" });
    // Anything else is a plain name, e.g. a session the user renamed.
    expect(splitSessionNumber("Fix login")).toEqual({ number: null, name: "Fix login" });
    expect(splitSessionNumber("#16")).toEqual({ number: null, name: "#16" });
  });

  it("shows the name as the title and the number in a badge; other rows have none", () => {
    const row = new SidebarRow(document, { kind: "session", onSelect: () => {}, onMore: () => {} });
    row.update("#16 New session", false);
    expect(row.el.querySelector(".sidebar-row-title")?.textContent).toBe("New session");
    const badge = row.el.querySelector<HTMLElement>(".sidebar-row-badge");
    expect(badge?.textContent).toBe("#16");
    expect(badge?.hidden).toBe(false);
    // The full title stays available as the tooltip.
    expect(row.select.getAttribute("title")).toBe("#16 New session");

    row.update("Renamed", false);
    expect(row.el.querySelector(".sidebar-row-title")?.textContent).toBe("Renamed");
    expect(badge?.hidden).toBe(true);

    const group = new SidebarRow(document, { kind: "group", onSelect: () => {}, onMore: () => {} });
    group.update("#1 Workspace", false, true);
    expect(group.el.querySelector(".sidebar-row-badge")).toBeNull();
    expect(group.el.querySelector(".sidebar-row-title")?.textContent).toBe("#1 Workspace");
  });
});
