import { describe, expect, test } from "bun:test";
import { slateEligible } from "../src/slate/gate.ts";

const base = { enabled: true, codec: "h264", preroll: null };
describe("slateEligible", () => {
  test("cold h264 channel with the flag on", () => {
    expect(slateEligible(base)).toBe(true);
  });
  test("every other combination declines", () => {
    expect(slateEligible({ ...base, enabled: false })).toBe(false);
    expect(slateEligible({ ...base, codec: "hevc" })).toBe(false);
    expect(slateEligible({ ...base, codec: null })).toBe(false); // unprobed: unknown risk, skip
    expect(slateEligible({ ...base, preroll: new Uint8Array(188) })).toBe(false); // warm: TsPreroll already handles it
  });
});
