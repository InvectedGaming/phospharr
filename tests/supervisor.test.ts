import { describe, expect, test } from "bun:test";
import { SupervisedProc } from "../src/proxy/supervisor.ts";

/**
 * The shared process supervisor. Children are real `bun -e` processes — the
 * scripts print / exit / hang to exercise each supervision path.
 */

const BUN = process.execPath;

function until(cond: () => boolean, ms: number): Promise<boolean> {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const iv = setInterval(() => {
      if (cond()) { clearInterval(iv); resolve(true); }
      else if (Date.now() - t0 > ms) { clearInterval(iv); resolve(false); }
    }, 25);
  });
}

describe("SupervisedProc", () => {
  test("pumps stdout and reports producing()", async () => {
    let got = "";
    const sup = new SupervisedProc({
      name: "t",
      cmd: () => [BUN, "-e", "console.log('hello'); setTimeout(() => {}, 30_000)"],
      wantRunning: () => true,
      onStdout: (c) => { got += new TextDecoder().decode(c); },
    });
    sup.restart();
    expect(await until(() => sup.producing(), 8000)).toBe(true);
    expect(got).toContain("hello");
    sup.stop();
  }, 15_000);

  test("respawns after an unexpected exit while wanted", async () => {
    const sup = new SupervisedProc({
      name: "t",
      cmd: () => [BUN, "-e", "console.log('x'); process.exit(1)"],
      wantRunning: () => true,
      onStdout: () => {},
      backoffBaseMs: 30,
      backoffCapMs: 100,
    });
    sup.restart();
    expect(await until(() => sup.spawnCount >= 3, 10_000)).toBe(true);
    sup.stop();
  }, 15_000);

  test("stays down after stop() even though the child died", async () => {
    let want = true;
    const sup = new SupervisedProc({
      name: "t",
      cmd: () => [BUN, "-e", "process.exit(0)"],
      wantRunning: () => want,
      onStdout: () => {},
      backoffBaseMs: 30,
    });
    sup.restart();
    await until(() => sup.spawnCount >= 1, 8000);
    want = false;
    sup.stop();
    const n = sup.spawnCount;
    await new Promise((r) => setTimeout(r, 400));
    expect(sup.spawnCount).toBe(n);
  }, 15_000);

  test("onDown fires on unexpected death, not on stop()", async () => {
    let downs = 0;
    const sup = new SupervisedProc({
      name: "t",
      cmd: () => [BUN, "-e", "process.exit(3)"],
      wantRunning: () => true,
      onStdout: () => {},
      onDown: () => { downs++; },
      backoffBaseMs: 5000, // long: exactly one spawn+death inside the window
    });
    sup.restart();
    expect(await until(() => downs >= 1, 8000)).toBe(true);
    const seen = downs;
    sup.stop();
    await new Promise((r) => setTimeout(r, 300));
    expect(downs).toBe(seen);
  }, 15_000);

  test("watchdog restarts a silent process", async () => {
    const sup = new SupervisedProc({
      name: "t",
      cmd: () => [BUN, "-e", "console.log('once'); setTimeout(() => {}, 60_000)"],
      wantRunning: () => true,
      onStdout: () => {},
      watchdogMs: 500,
      backoffBaseMs: 30,
    });
    sup.restart();
    // First spawn prints once then goes silent → watchdog (checks ~1s) respawns.
    expect(await until(() => sup.spawnCount >= 2, 10_000)).toBe(true);
    expect(sup.lastErr()).toContain("watchdog");
    sup.stop();
  }, 15_000);

  test("stderr lands in lastErr", async () => {
    const sup = new SupervisedProc({
      name: "t",
      cmd: () => [BUN, "-e", "console.error('boom-diagnostic'); setTimeout(() => {}, 30_000)"],
      wantRunning: () => true,
      onStdout: () => {},
    });
    sup.restart();
    expect(await until(() => sup.lastErr().includes("boom-diagnostic"), 8000)).toBe(true);
    sup.stop();
  }, 15_000);
});
