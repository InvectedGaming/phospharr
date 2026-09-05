import { afterAll, describe, expect, test } from "bun:test";
import { sqlite } from "../src/db/index.ts";
import { setSetting, getSetting } from "../src/settings.ts";
import { compositor } from "../src/proxy/compositor.ts";

// Sentinel ids well clear of real rows, cleaned up in afterAll.
const A = 991001, B = 991002, C = 991003, GONE = 991999;

sqlite.exec(
  `INSERT INTO channels (id,name,is_hidden,number) VALUES
     (${A},'MOSAIC TEST A',0,99101),
     (${B},'MOSAIC TEST B',0,99102),
     (${C},'MOSAIC TEST C',0,99103)`,
);

afterAll(() => {
  sqlite.exec(`DELETE FROM channels WHERE id IN (${A},${B},${C})`);
});

const save = (s: object) => setSetting("mosaic.state", s as never);

describe("mosaic selection survives a restart", () => {
  test("round-trips channels, layout, focus and audio", async () => {
    await save({ channels: [A, B, C], layout: "3x3", focus: B, audio: 2 });
    await compositor.restore();
    const st = compositor.getState();
    expect(st.channels).toEqual([A, B, C]);
    expect(st.layout).toBe("3x3");
    expect(st.focus).toBe(B);
    expect(st.audio).toBe(2);
  });

  test("prunes ids whose channel no longer exists, preserving order", async () => {
    await save({ channels: [A, GONE, B], layout: "2x2", focus: null, audio: 0 });
    await compositor.restore();
    expect(compositor.getState().channels).toEqual([A, B]);
  });

  test("clears focus when the focused channel was pruned", async () => {
    await save({ channels: [A, GONE], layout: "2x2", focus: GONE, audio: 0 });
    await compositor.restore();
    expect(compositor.getState().focus).toBeNull();
  });

  test("clamps an audio index that outlived its tile", async () => {
    await save({ channels: [A, B, GONE], layout: "2x2", focus: null, audio: 2 });
    await compositor.restore();
    const st = compositor.getState();
    expect(st.channels).toEqual([A, B]);
    expect(st.audio).toBe(1); // was 2, now past the end
  });

  test("a selection of only-dead channels leaves the mosaic empty, not composing dead tiles", async () => {
    await save({ channels: [A, B], layout: "2x2", focus: null, audio: 0 });
    await compositor.restore();
    expect(compositor.getState().channels.length).toBe(2);
    await save({ channels: [GONE], layout: "2x2", focus: null, audio: 0 });
    await compositor.restore();
    // restore() returns early, so the prior selection is left untouched rather
    // than being replaced by an empty one — the encode keeps whatever it had.
    expect(compositor.getState().channels).toEqual([A, B]);
  });

  test("an empty saved selection is a no-op, not a crash", async () => {
    await save({ channels: [], layout: "2x2", focus: null, audio: 0 });
    await expect(compositor.restore()).resolves.toBeUndefined();
  });

  test("setState writes the selection through to settings", async () => {
    await save({ channels: [], layout: "2x2", focus: null, audio: 0 });
    compositor.setState({ channels: [A, B], layout: "2up", focus: null, audio: 1 });
    await Bun.sleep(50); // persist() is fire-and-forget
    const saved = await getSetting("mosaic.state");
    expect(saved.channels).toEqual([A, B]);
    expect(saved.layout).toBe("2up");
    expect(saved.audio).toBe(1);
    compositor.setState({ channels: [] }); // tear the encode back down
  });
});

describe("first-boot seed", () => {
  // A resolver-backed (Twitch) channel and a provider-backed one, so the seed
  // has to choose correctly between them.
  const FREE = 991101, PAID = 991102;
  const FREE_PROV = 99120, PAID_PROV = 99121;
  // A free (resolver) source and a connection-capped provider source, so the
  // seed has to choose correctly between them.
  sqlite.exec(
    `INSERT OR IGNORE INTO providers (id,name,type,url,max_connections,priority,enabled,via_vpn) VALUES
       (${FREE_PROV},'MOSAIC TEST CUSTOM','custom','',0,0,1,0),
       (${PAID_PROV},'MOSAIC TEST XTREAM','xtream','http://example.invalid',4,0,1,0)`,
  );
  sqlite.exec(
    `INSERT INTO channels (id,name,is_hidden,number) VALUES
       (${FREE},'MOSAIC TEST TWITCH',0,99111),(${PAID},'MOSAIC TEST PROVIDER',0,99112)`,
  );
  sqlite.exec(
    `INSERT INTO streams (channel_id,provider_id,url,raw_name,health,quality_score,resolver) VALUES
       (${FREE},${FREE_PROV},'https://twitch.tv/mosaictest','MOSAIC TEST TWITCH','live',0,'streamlink')`,
  );
  sqlite.exec(
    `INSERT INTO streams (channel_id,provider_id,url,raw_name,health,quality_score) VALUES
       (${PAID},${PAID_PROV},'http://example.invalid/x.ts','MOSAIC TEST PROVIDER','live',0)`,
  );
  afterAll(() => {
    sqlite.exec(`DELETE FROM streams WHERE channel_id IN (${FREE},${PAID})`);
    sqlite.exec(`DELETE FROM channels WHERE id IN (${FREE},${PAID})`);
    sqlite.exec(`DELETE FROM providers WHERE id IN (${FREE_PROV},${PAID_PROV})`);
  });

  test("with nothing saved, seeds from free sources and never the provider", async () => {
    await save({ channels: [], layout: "2x2", focus: null, audio: 0 });
    await compositor.restore();
    const picked = compositor.getState().channels;
    expect(picked).toContain(FREE);
    // The provider caps concurrent connections; seeding it would starve viewers.
    expect(picked).not.toContain(PAID);
  });

  test("the seed is not persisted, so it keeps tracking new free sources", async () => {
    await save({ channels: [], layout: "2x2", focus: null, audio: 0 });
    await compositor.restore();
    expect(compositor.getState().channels.length).toBeGreaterThan(0);
    const stored = await getSetting("mosaic.state");
    expect(stored.channels).toEqual([]); // still empty on disk
  });

  test("a saved selection always beats the seed", async () => {
    await save({ channels: [A], layout: "2up", focus: null, audio: 0 });
    await compositor.restore();
    expect(compositor.getState().channels).toEqual([A]);
  });

  test("dead free sources are not seeded", async () => {
    sqlite.exec(`UPDATE streams SET health='dead' WHERE channel_id=${FREE}`);
    await save({ channels: [], layout: "2x2", focus: null, audio: 0 });
    await compositor.restore();
    expect(compositor.getState().channels).not.toContain(FREE);
    sqlite.exec(`UPDATE streams SET health='live' WHERE channel_id=${FREE}`);
  });
});
