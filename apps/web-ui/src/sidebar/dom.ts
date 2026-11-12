/** Update only changed attributes/text to preserve focus and avoid needless DOM mutations. */
export function attribute(el: Element, name: string, value: string): void {
  if (el.getAttribute(name) !== value) el.setAttribute(name, value);
}

export function label(el: HTMLElement, value: string): void {
  if (el.textContent !== value) el.textContent = value;
}

export function visibility(el: HTMLElement, visible: boolean): void {
  if (el.hidden === visible) el.hidden = !visible;
}

/** Keep keyed nodes in place. Moving/replacing every child would disrupt keyboard focus. */
export function reconcile(host: HTMLElement, children: readonly HTMLElement[]): void {
  const retained = new Set(children);
  for (const child of Array.from(host.children)) {
    if (!retained.has(child as HTMLElement)) child.remove();
  }
  children.forEach((child, index) => {
    if (host.children[index] !== child) host.insertBefore(child, host.children[index] ?? null);
  });
}

export function button(doc: Document, className: string, ariaLabel?: string): HTMLButtonElement {
  const el = doc.createElement("button");
  el.type = "button";
  el.className = className;
  if (ariaLabel) el.setAttribute("aria-label", ariaLabel);
  return el;
}
