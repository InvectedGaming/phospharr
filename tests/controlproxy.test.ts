import { afterEach, describe, expect, test } from "bun:test";
import { sqlite } from "../src/db/index.ts";
import { setSetting, getSettings } from "../src/settings.ts";
import { providerEgress, providerControlEgress } from "../src/net/egress.ts";

const PROV = 99340;
sqlite.exec(
  `INSERT OR IGNORE INTO providers (id,name,type,url,max_connections,priority,enabled,via_vpn,proxy_url)
     VALUES (${PROV},'CTRL TEST','xtream','http://x.invalid',4,0,1,0,'http://127.0.0.1:9/stream')`,
);
const set = async (v: string) => { await setSetting("providers.controlProxy", v); await getSettings(); };
afterEach(async () => { await set(""); });

describe("control-plane egress", () => {
  test("with no override, control traffic follows the streaming egress", async () => {
    await set("");
    expect(providerControlEgress(PROV)).toEqual(providerEgress(PROV));
  });

  test("an override redirects control traffic only", async () => {
    await set("http://gluetun:8888");
    expect(providerControlEgress(PROV)).toEqual({ proxy: "http://gluetun:8888" });
    // The data plane must be untouched: streaming keeps the tunnel that works.
    expect(providerEgress(PROV)).toEqual({ proxy: "http://127.0.0.1:9/stream" });
  });

  test("whitespace is not a proxy", async () => {
    await set("   ");
    expect(providerControlEgress(PROV)).toEqual(providerEgress(PROV));
  });
});
