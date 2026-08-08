import { describe, expect, test } from "bun:test";
import { evictionPlan } from "../src/proxy/warmevict.ts";

/**
 * A warm hold must never cost a real viewer their tune. The bug this pins down:
 * a hold subscribes to its channel like a viewer, so a channel can carry both a
 * hold and real viewers — and releasing that hold frees no provider slot,
 * because the upstream keeps feeding the viewer. Reporting it as freed made the
 * muxer stop looking and fail the tune it was evicting for.
 */

/** `viewers` counts the hold itself, so 1 = warm only, 2+ = someone watching. */
const warmOnly = () => 1;
const watching = (...ids: number[]) => (id: number) => (ids.includes(id) ? 2 : 1);

describe("evictionPlan", () => {
  test("drops the oldest warm hold", () => {
    // Watched 1, then 2, then 3; tuning to 4 needs a slot → 1 is the stalest.
    const p = evictionPlan([1, 2, 3], warmOnly);
    expect(p.freed).toBe(1);
    expect(p.drop).toEqual([1]);
  });

  test("skips a channel someone is watching and takes the next oldest", () => {
    // 1,2,3,4 warm and someone is watching 1 → 2 goes, 1 stays live.
    const p = evictionPlan([1, 2, 3, 4], watching(1));
    expect(p.freed).toBe(2);
    // 1's hold is still dropped in passing — a watched channel is not "warm" —
    // but it is NOT what freed the slot.
    expect(p.drop).toEqual([1, 2]);
  });

  test("walks past several watched channels to reach an idle one", () => {
    const p = evictionPlan([1, 2, 3, 4], watching(1, 2, 3));
    expect(p.freed).toBe(4);
    expect(p.drop).toEqual([1, 2, 3, 4]);
  });

  test("reports failure when every hold is on a watched channel", () => {
    // The muxer must be told no slot was freed, so it can refuse the tune
    // honestly instead of retrying against a pool that never gained anything.
    const p = evictionPlan([1, 2], watching(1, 2));
    expect(p.freed).toBeNull();
    expect(p.drop).toEqual([1, 2]);
  });

  test("no holds at all frees nothing", () => {
    const p = evictionPlan([], warmOnly);
    expect(p.freed).toBeNull();
    expect(p.drop).toEqual([]);
  });

  test("never drops more holds than it had to look at", () => {
    // Evicting speculatively past the first usable hold would throw away warm
    // channels for nothing.
    const p = evictionPlan([9, 8, 7, 6], warmOnly);
    expect(p.drop).toEqual([9]);
  });

  test("the surf sequence from a real session", () => {
    // Watch 1 → 2 → 3 → 4 → 5 on a 4-slot provider, nobody else viewing:
    // each new tune retires the stalest warm channel.
    let order = [1, 2, 3];
    const a = evictionPlan(order, warmOnly);       // tune 4
    expect(a.freed).toBe(1);
    order = order.filter((c) => !a.drop.includes(c)).concat(4);
    expect(order).toEqual([2, 3, 4]);
    const b = evictionPlan(order, warmOnly);       // tune 5
    expect(b.freed).toBe(2);
    order = order.filter((c) => !b.drop.includes(c)).concat(5);
    expect(order).toEqual([3, 4, 5]);
  });

  test("the same sequence, but channel 1 has a viewer on it", () => {
    // 1 is protected, so 2 is retired instead and 1 stays live.
    const order = [1, 2, 3, 4];
    const p = evictionPlan(order, watching(1));
    expect(p.freed).toBe(2);
    const left = order.filter((c) => !p.drop.includes(c));
    expect(left).toEqual([3, 4]); // 1 is live (not warm), 2 is gone
  });
});
