import { afterAll, describe, expect, test } from "bun:test";
import { sqlite } from "../src/db/index.ts";
import { recordView, recentChannels } from "../src/analytics.ts";

/**
 * "Jump back in" (recentChannels) must be PER-USER — a household shouldn't share
 * one recently-watched row. Regression guard for the leak where view_events had
 * no user_id. Uses high, unlikely-to-collide ids and cleans up after itself.
 */

const U1 = 990001, U2 = 990002;
const C1 = 990010, C2 = 990020, C3 = 990030;

function seed() {
  sqlite.exec(
    `INSERT INTO users (id,username,password_hash,role,created_at) VALUES
       (${U1},'test_alice_${U1}','x','user',0),
       (${U2},'test_bob_${U2}','x','user',0)`,
  );
  for (const id of [C1, C2, C3]) sqlite.exec(`INSERT INTO channels (id,name,is_hidden) VALUES (${id},'TESTCH${id}',0)`);
}
function cleanup() {
  sqlite.exec(`DELETE FROM view_events WHERE channel_id IN (${C1},${C2},${C3})`);
  sqlite.exec(`DELETE FROM channels WHERE id IN (${C1},${C2},${C3})`);
  sqlite.exec(`DELETE FROM users WHERE id IN (${U1},${U2})`);
}

afterAll(cleanup);

describe("recentChannels (per-user)", () => {
  test("each user sees only their own history; tuner/key streams leak to nobody", () => {
    cleanup(); // idempotent from a prior aborted run
    seed();
    const now = Date.now();
    recordView({ userId: U1, channelId: C1, kind: "watch", source: "passthrough", startedAt: now - 5000, endedAt: now });
    recordView({ userId: U1, channelId: C2, kind: "watch", source: "passthrough", startedAt: now - 4000, endedAt: now });
    recordView({ userId: U2, channelId: C3, kind: "watch", source: "passthrough", startedAt: now - 3000, endedAt: now });
    recordView({ userId: null, channelId: C1, kind: "watch", source: "passthrough", startedAt: now - 2000, endedAt: now }); // Emby/Plex via ?key=

    const alice = recentChannels(U1).map((r) => r.id);
    const bob = recentChannels(U2).map((r) => r.id);

    expect(alice).toEqual([C2, C1]); // most-recent first, only alice's
    expect(bob).toEqual([C3]); // NOT alice's channels
    expect(alice).not.toContain(C3);
    expect(bob).not.toContain(C1);
    expect(recentChannels(null)).toEqual([]); // no user → no personal history
    expect(recentChannels(undefined)).toEqual([]);
  });
});
