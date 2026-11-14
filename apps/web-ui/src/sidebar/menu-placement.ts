/** Vertical room a menu may use, in the same coordinates as the anchor (page pixels). */
export interface MenuBounds {
  readonly top: number;
  readonly bottom: number;
}

export interface MenuPlacementInput {
  /** The button that opened the menu. */
  readonly anchor: { readonly top: number; readonly bottom: number };
  /** The height the menu would have if nothing limited it. */
  readonly height: number;
  readonly bounds: MenuBounds;
  /** Space kept between the anchor and the menu. */
  readonly gap?: number;
  /** Space kept between the menu and the edge of the bounds. */
  readonly margin?: number;
}

export interface MenuPlacement {
  readonly side: "below" | "above";
  /** Set when neither side has enough room: the menu then scrolls instead of leaving the bounds. */
  readonly maxHeight?: number;
}

/**
 * Where a menu goes relative to its button: below when it fits, above when it does not but the
 * other side does, and otherwise on the larger side with a height limit.
 */
export function placeMenu(input: MenuPlacementInput): MenuPlacement {
  const gap = input.gap ?? 2;
  const margin = input.margin ?? 4;
  const below = input.bounds.bottom - input.anchor.bottom - gap - margin;
  const above = input.anchor.top - input.bounds.top - gap - margin;
  if (input.height <= below) return { side: "below" };
  if (input.height <= above) return { side: "above" };
  return below >= above
    ? { side: "below", maxHeight: Math.max(0, below) }
    : { side: "above", maxHeight: Math.max(0, above) };
}
