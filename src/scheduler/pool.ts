/**
 * Slot pool: the live accounting that makes "2 providers × 4 = 8 concurrent"
 * work. Each provider contributes maxConnections slots. The pool tracks usage
 * in memory and enforces budgets.
 *
 * A slot is held per *upstream connection*, NOT per viewer — same-channel
 * viewers share one upstream (see muxer), so 8 slots serve far more than 8 viewers.
 */

interface ProviderState {
  max: number;
  used: number;
}

class SlotPool {
  private providers = new Map<number, ProviderState>();

  /** Register/update a provider's budget (called on ingest/config change). */
  setBudget(providerId: number, max: number) {
    const s = this.providers.get(providerId);
    if (s) s.max = max;
    else this.providers.set(providerId, { max, used: 0 });
  }

  remove(providerId: number) {
    this.providers.delete(providerId);
  }

  hasFreeSlot(providerId: number): boolean {
    const s = this.providers.get(providerId);
    if (!s) return false;
    return s.used < s.max;
  }

  /** Try to take a slot. Returns false if the provider is full. */
  acquire(providerId: number): boolean {
    const s = this.providers.get(providerId);
    if (!s || s.used >= s.max) return false;
    s.used++;
    return true;
  }

  release(providerId: number) {
    const s = this.providers.get(providerId);
    if (s && s.used > 0) s.used--;
  }

  usage(providerId: number): { used: number; max: number } {
    const s = this.providers.get(providerId);
    return s ? { used: s.used, max: s.max } : { used: 0, max: 0 };
  }

  /** Total free slots across the whole pool — for "all tuners busy" checks. */
  totalFree(): number {
    let free = 0;
    for (const s of this.providers.values()) free += Math.max(0, s.max - s.used);
    return free;
  }

  snapshot(): Record<number, ProviderState> {
    return Object.fromEntries(this.providers);
  }
}

export const pool = new SlotPool();
