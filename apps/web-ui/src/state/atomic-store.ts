export type StoreListener<T> = (state: T, prevState: T) => void;

/** Atomic state container used to isolate subscriptions between cockpit zones. */
export class AtomicStore<T> {
  private state: T;
  private updateCount = 0;
  private readonly listeners = new Set<StoreListener<T>>();

  constructor(initialState: T) {
    this.state = initialState;
  }

  getState(): T {
    return this.state;
  }

  getUpdateCount(): number {
    return this.updateCount;
  }

  setState(updater: T | ((prev: T) => T)): T {
    const prev = this.state;
    const next = typeof updater === "function" ? (updater as (prev: T) => T)(prev) : updater;
    if (Object.is(prev, next)) return prev;

    this.state = next;
    this.updateCount += 1;
    for (const listener of this.listeners) listener(next, prev);
    return next;
  }

  subscribe(listener: StoreListener<T>): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  subscribeSelector<S>(
    selector: (state: T) => S,
    listener: (selected: S, prevSelected: S) => void,
    isEqual: (a: S, b: S) => boolean = Object.is,
  ): () => void {
    let currentSlice = selector(this.state);
    return this.subscribe((nextState) => {
      const nextSlice = selector(nextState);
      if (isEqual(currentSlice, nextSlice)) return;
      const prevSlice = currentSlice;
      currentSlice = nextSlice;
      listener(nextSlice, prevSlice);
    });
  }
}
