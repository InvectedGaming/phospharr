import { afterAll, describe, expect, test } from "bun:test";
import { sqlite } from "../src/db/index.ts";
import { twitchLogin, pollOnce } from "../src/health/liveness.ts";

const PROV = 99230;
const ON = 992001, OFF = 992002, YT = 992003, PROVIDER = 992004;

sqlite.exec(
  `INSERT OR IGNORE INTO providers (id,name,type,url,max_connections,priority,enabled,via_vpn)
     VALUES (${PROV},'LIVENESS TEST','custom','',20,0,1,0)`,
);
sqlite.exec(
  `INSERT INTO channels (id,name,is_hidden,number) VALUES
     (${ON},'LV ON',0,99201),(${OFF},'LV OFF',0,99202),(${YT},'LV YT',0,99203),(${PROVIDER},'LV PROVIDER',0,99204)`,
);
const ins = (ch: number, url: string, health: string, resolver: string | null) =>
  sqlite.exec(
    `INSERT INTO streams (channel_id,provider_id,url,raw_name,health,quality_score,resolver)
       VALUES (${ch},${PROV},'${url}','x','${health}',0,${resolver ? `'${resolver}'` : "NULL"})`,
  );
ins(ON, "https://twitch.tv/liveone", "dead", "streamlink");
ins(OFF, "https://twitch.tv/offone", "live", "streamlink");
ins(YT, "https://youtube.com/@someone/live", "live", "ytdlp");
ins(PROVIDER, "http://example.invalid/x.ts", "live", null);

afterAll(() => {
  sqlite.exec(`DELETE FROM streams WHERE channel_id IN (${ON},${OFF},${YT},${PROVIDER})`);
  sqlite.exec(`DELETE FROM channels WHERE id IN (${ON},${OFF},${YT},${PROVIDER})`);
  sqlite.exec(`DELETE FROM providers WHERE id = ${PROV}`);
});

const healthOf = (ch: number): string =>
  (sqlite.query(`SELECT health FROM streams WHERE channel_id = ${ch}`).get() as { health: string }).health;

describe("twitchLogin", () => {
  test("extracts the login from a channel URL", () => {
    expect(twitchLogin("https://twitch.tv/LofiGirl")).toBe("lofigirl");
    expect(twitchLogin("https://www.twitch.tv/lofigirl/")).toBe("lofigirl");
    expect(twitchLogin("https://twitch.tv/lofigirl?x=1")).toBe("lofigirl");
  });
  test("refuses URLs whose liveness we cannot actually ask about", () => {
    expect(twitchLogin("https://twitch.tv/videos/12345")).toBeNull(); // a VOD, not a channel
    expect(twitchLogin("https://youtube.com/@someone/live")).toBeNull();
    expect(twitchLogin("http://example.invalid/x.ts")).toBeNull();
  });
});

describe("liveness poll", () => {
  test("a broadcasting channel is marked live so it enters the lineup", async () => {
    await pollOnce(async () => new Map([["liveone", true], ["offone", true]]));
    expect(healthOf(ON)).toBe("live");
  });

  test("an offline channel is marked dead, which is what removes it from the lineup", async () => {
    await pollOnce(async () => new Map([["liveone", true], ["offone", false]]));
    expect(healthOf(OFF)).toBe("dead");
    expect(healthOf(ON)).toBe("live");
  });

  test("it comes back on its own when the stream returns", async () => {
    await pollOnce(async () => new Map([["offone", false]]));
    expect(healthOf(OFF)).toBe("dead");
    await pollOnce(async () => new Map([["offone", true]]));
    expect(healthOf(OFF)).toBe("live");
  });

  test("a login Twitch did not answer for keeps its last state, never guessed dead", async () => {
    await pollOnce(async () => new Map([["liveone", true]]));
    expect(healthOf(ON)).toBe("live");
    await pollOnce(async () => new Map()); // API returned nothing at all
    expect(healthOf(ON)).toBe("live"); // unchanged, not condemned
  });

  test("a network failure marks nothing dead", async () => {
    await pollOnce(async () => new Map([["liveone", true]]));
    await pollOnce(async () => { throw new Error("network down"); }).catch(() => {});
    expect(healthOf(ON)).toBe("live");
  });

  test("leaves provider streams and non-Twitch resolvers alone", async () => {
    const r = await pollOnce(async () => new Map([["liveone", false], ["offone", false]]));
    expect(healthOf(PROVIDER)).toBe("live"); // never selected: no resolver
    expect(healthOf(YT)).toBe("live");       // selected but not a Twitch URL
    expect(r.skipped).toBeGreaterThanOrEqual(1);
  });
});
