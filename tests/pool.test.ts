import { describe, expect, test } from "bun:test";
import { pool } from "../src/scheduler/pool.ts";

// The pool is a module singleton; use provider ids far from anything real.
const P = 910_001;
const Q = 910_002;

describe("SlotPool", () => {
  test("acquire/release respects the budget", () => {
    pool.setBudget(P, 2);
    expect(pool.hasFreeSlot(P)).toBe(true);
    expect(pool.acquire(P)).toBe(true);
    expect(pool.acquire(P)).toBe(true);
    expect(pool.acquire(P)).toBe(false); // full
    expect(pool.hasFreeSlot(P)).toBe(false);
    pool.release(P);
    expect(pool.acquire(P)).toBe(true);
    pool.release(P);
    pool.release(P);
    expect(pool.usage(P)).toEqual({ used: 0, max: 2 });
  });

  test("release never goes negative", () => {
    pool.setBudget(Q, 1);
    pool.release(Q);
    pool.release(Q);
    expect(pool.usage(Q)).toEqual({ used: 0, max: 1 });
    expect(pool.acquire(Q)).toBe(true);
    pool.release(Q);
  });

  test("unknown provider has no slots", () => {
    expect(pool.hasFreeSlot(987_654)).toBe(false);
    expect(pool.acquire(987_654)).toBe(false);
  });

  test("budget can shrink below current usage without breaking", () => {
    pool.setBudget(P, 2);
    pool.acquire(P);
    pool.acquire(P);
    pool.setBudget(P, 1); // admin lowers max_connections mid-flight
    expect(pool.hasFreeSlot(P)).toBe(false);
    pool.release(P);
    pool.release(P);
    expect(pool.usage(P).used).toBe(0);
  });
});
