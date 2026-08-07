import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { sqlite } from "../src/db/index.ts";
import { selectStream } from "../src/scheduler/selector.ts";
import { pool } from "../src/scheduler/pool.ts";
import { _resetVerdicts, updateVerdicts } from "../src/health/verdict.ts";

/**
 * Task 10: provider verdicts folded into stream selection. Regression guards
 * for the two judgment calls that matter most here:
 *  - a `down` provider is a LAST RESORT, not a hard exclude — otherwise a
 *    wrong verdict makes a channel that exists only on that provider
 *    unplayable (see health/verdict.ts's module doc);
 *  - a `degraded` provider's fixed penalty is small enough that it only
 *    loses to an equal-or-better resolution tier, and always wins when it's
 *    the only source for a channel.
 *
 * Seeded against the real DB (not hand-built literals), high/unlikely-to-
 * collide ids, cleaned up after itself — same convention as
 * tests/fingerprint.test.ts. Verdict state is reset per test via
 * `_resetVerdicts` (module singleton — see tests/verdict.test.ts).
 */

const PA = 990801, PB = 990802, PC = 990803, PD = 990804; // providers
const C_SOLE_DOWN = 990810; // channel with a single stream on a down provider
const C_DOWN_VS_HEALTHY = 990811; // down provider loses to a healthy alternative
const C_SOLE_DEGRADED = 990812; // channel with a single stream on a degraded provider
const C_DEGRADED_BEATS_LOWER_TIER = 990813; // degraded 1080p still beats healthy 720p
const C_DEGRADED_LOSES_TO_EQUAL_TIER = 990814; // degraded 1080p loses to healthy 1080p

const S_SOLE_DOWN = 990820;
const S_DOWN = 990821, S_HEALTHY_ALT = 990822;
const S_SOLE_DEGRADED = 990823;
const S_DEG_1080 = 990824, S_HEALTHY_720 = 990825;
const S_DEG_1080B = 990826, S_HEALTHY_1080 = 990827;

const PROVIDER_IDS = [PA, PB, PC, PD];
const CHANNEL_IDS = [C_SOLE_DOWN, C_DOWN_VS_HEALTHY, C_SOLE_DEGRADED, C_DEGRADED_BEATS_LOWER_TIER, C_DEGRADED_LOSES_TO_EQUAL_TIER];
const STREAM_IDS = [S_SOLE_DOWN, S_DOWN, S_HEALTHY_ALT, S_SOLE_DEGRADED, S_DEG_1080, S_HEALTHY_720, S_DEG_1080B, S_HEALTHY_1080];

function seed() {
  for (const id of PROVIDER_IDS) {
    sqlite.exec(
      `INSERT INTO providers (id,name,type,url,max_connections,priority,enabled) VALUES
         (${id},'sel_test_provider_${id}','custom','http://example.invalid',4,100,1)`,
    );
  }
  for (const id of CHANNEL_IDS) {
    sqlite.exec(
      `INSERT INTO channels (id,canonical_id,name,number,logo_url,category,is_hidden) VALUES
         (${id},'sel.test.${id}','Sel Test Channel ${id}',${id},'','',0)`,
    );
  }
  const stream = (id: number, channelId: number, providerId: number, health: string, qualityScore: number) =>
    sqlite.exec(
      `INSERT INTO streams (id,channel_id,provider_id,url,raw_name,health,quality_score) VALUES
         (${id},${channelId},${providerId},'http://stream.example/${id}.ts','SEL TEST RAW','${health}',${qualityScore})`,
    );

  stream(S_SOLE_DOWN, C_SOLE_DOWN, PA, "live", 1080 + 1000);

  stream(S_DOWN, C_DOWN_VS_HEALTHY, PA, "live", 2160 + 1000); // higher raw score...
  stream(S_HEALTHY_ALT, C_DOWN_VS_HEALTHY, PB, "live", 1080 + 1000); // ...but PA is down

  stream(S_SOLE_DEGRADED, C_SOLE_DEGRADED, PC, "live", 1080 + 1000);

  stream(S_DEG_1080, C_DEGRADED_BEATS_LOWER_TIER, PC, "live", 1080 + 1000); // degraded provider, 1080p
  stream(S_HEALTHY_720, C_DEGRADED_BEATS_LOWER_TIER, PB, "live", 720 + 1000); // healthy provider, 720p

  stream(S_DEG_1080B, C_DEGRADED_LOSES_TO_EQUAL_TIER, PC, "live", 1080 + 1000); // degraded provider, 1080p
  stream(S_HEALTHY_1080, C_DEGRADED_LOSES_TO_EQUAL_TIER, PD, "live", 1080 + 1000); // healthy provider, 1080p
}

function cleanup() {
  for (const id of STREAM_IDS) sqlite.exec(`DELETE FROM streams WHERE id = ${id}`);
  for (const id of CHANNEL_IDS) sqlite.exec(`DELETE FROM channels WHERE id = ${id}`);
  for (const id of PROVIDER_IDS) sqlite.exec(`DELETE FROM providers WHERE id = ${id}`);
  for (const id of PROVIDER_IDS) pool.remove(id);
}

const down = (providerId: number) => updateVerdicts(Array.from({ length: 5 }, () => ({ providerId, healthy: false })));
const degraded = (providerId: number) => updateVerdicts([
  ...Array.from({ length: 4 }, () => ({ providerId, healthy: false })),
  { providerId, healthy: true },
]);

cleanup(); // idempotent from a prior aborted run
seed();
afterAll(cleanup);

// Verdicts are separate in-memory state (not DB rows) and every test drives
// its own provider(s) to the verdict it needs, so only that reset is needed
// per test — the seeded DB rows above are shared read-only across the suite.
beforeEach(() => {
  _resetVerdicts();
  for (const id of PROVIDER_IDS) pool.setBudget(id, 4);
});

describe("selectStream + provider verdicts", () => {
  test("a down provider is still used as a last resort when it's the only source", async () => {
    down(PA);
    const sel = await selectStream(C_SOLE_DOWN);
    expect(sel?.stream.id).toBe(S_SOLE_DOWN);
  });

  test("a down provider loses to a healthy alternative, even with a higher raw quality score", async () => {
    down(PA);
    const sel = await selectStream(C_DOWN_VS_HEALTHY);
    expect(sel?.stream.id).toBe(S_HEALTHY_ALT);
  });

  test("a degraded provider still wins when it's the only source for a channel", async () => {
    degraded(PC);
    const sel = await selectStream(C_SOLE_DEGRADED);
    expect(sel?.stream.id).toBe(S_SOLE_DEGRADED);
  });

  test("degraded penalty is below one quality tier: 1080p degraded still beats 720p healthy", async () => {
    degraded(PC);
    const sel = await selectStream(C_DEGRADED_BEATS_LOWER_TIER);
    expect(sel?.stream.id).toBe(S_DEG_1080);
  });

  test("degraded provider loses to an equal-tier healthy alternative", async () => {
    degraded(PC);
    const sel = await selectStream(C_DEGRADED_LOSES_TO_EQUAL_TIER);
    expect(sel?.stream.id).toBe(S_HEALTHY_1080);
  });
});
