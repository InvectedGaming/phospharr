/* Cathode · Aerial UI
 *
 * Faithful port of the Aerial.dc.html design handoff, recreated in vanilla JS
 * and wired to the live Cathode API (/api/view, PATCH /api/channels/:id).
 * No build step — served straight from the Bun/Hono server.
 */

const AC = "#54b6ff"; // accent

const GRADS = {
  news: "linear-gradient(135deg,#c0322a,#5e120e)",
  sports: "linear-gradient(135deg,#1f8a46,#0b3a1f)",
  movies: "linear-gradient(135deg,#37489a,#11183f)",
  classics: "linear-gradient(135deg,#4a4a4a,#141414)",
  scifi: "linear-gradient(135deg,#5a2a9a,#1d0c3a)",
  general: "linear-gradient(135deg,#444a54,#171a1f)",
  music: "linear-gradient(135deg,#9a2486,#3a0c34)",
  nature: "linear-gradient(135deg,#1f8a96,#0b3a40)",
  travel: "linear-gradient(135deg,#c06a24,#5e2f0c)",
  kids: "linear-gradient(135deg,#caa028,#6a4f0c)",
};
const SOLIDS = {
  news: "#d6433a", sports: "#2fae5c", movies: "#5b6fd6", classics: "#9aa0a6",
  scifi: "#9b6bff", general: "#9aa6b2", music: "#e24fc4", nature: "#2fc0cf",
  travel: "#e2873f", kids: "#f3c63f",
};
const HEALTH = {
  live: { l: "Live", c: "#2fae5c", bg: "rgba(47,174,92,0.13)", bd: "rgba(47,174,92,0.3)" },
  sd: { l: "SD", c: "#f4b740", bg: "rgba(244,183,64,0.13)", bd: "rgba(244,183,64,0.3)" },
  dead: { l: "Dead", c: "#ff5d52", bg: "rgba(255,93,82,0.13)", bd: "rgba(255,93,82,0.3)" },
};
const ICON = (n) => `https://cdn.jsdelivr.net/npm/lucide-static@latest/icons/${n}.svg`;

// Layout constants. Row height is a density option: Comfortable (the design's
// 88px) by default, Compact for fitting more channels on screen.
const PXPM = 7, COLW = 210, HEADH = 48;
const ROWH_COMFORTABLE = 88, ROWH_COMPACT = 56;
function rowH() {
  return state.density === "compact" ? ROWH_COMPACT : ROWH_COMFORTABLE;
}

// ---- category → genre mapping (our backend uses free-form categories) ----
function toGenre(category) {
  const c = (category || "").toLowerCase();
  if (c.includes("sport")) return "sports";
  if (c.includes("news")) return "news";
  if (c.includes("movie") || c.includes("cinema") || c.includes("film")) return "movies";
  if (c.includes("kid") || c.includes("child")) return "kids";
  if (c.includes("music")) return "music";
  if (c.includes("nature") || c.includes("doc")) return "nature";
  if (c.includes("travel")) return "travel";
  if (c.includes("sci") || c.includes("fi")) return "scifi";
  if (c.includes("classic")) return "classics";
  return "general";
}
function initials(name) {
  return (name || "?").split(/\s+/).map((w) => w[0]).join("").slice(0, 3).toUpperCase();
}

// ===== tiny hyperscript =====
function styleStr(obj) {
  let s = "";
  for (const k in obj) {
    if (obj[k] == null) continue;
    const prop = k.startsWith("--") ? k : k.replace(/[A-Z]/g, (m) => "-" + m.toLowerCase());
    s += `${prop}:${obj[k]};`;
  }
  return s;
}
function h(tag, props, ...kids) {
  const el = document.createElement(tag);
  props = props || {};
  for (const k in props) {
    const v = props[k];
    if (v == null) continue;
    if (k === "style") el.setAttribute("style", typeof v === "string" ? v : styleStr(v));
    else if (k === "html") el.innerHTML = v;
    else if (k.startsWith("on") && typeof v === "function") el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === "value") el.value = v;
    else if (v === true) el.setAttribute(k, "");
    else if (v !== false) el.setAttribute(k, v);
  }
  for (const kid of kids.flat()) {
    if (kid == null || kid === false) continue;
    el.appendChild(typeof kid === "object" ? kid : document.createTextNode(String(kid)));
  }
  return el;
}
// lucide <img> icon
function icon(name, size, inv) {
  return h("img", {
    src: ICON(name),
    style: { width: size + "px", height: size + "px", filter: `brightness(0) invert(${inv ?? 0.7})` },
  });
}

// A channel logo tile: the real provider logo when we have one, falling back to
// the genre-coloured initials (and falling back to those again if the image 404s).
function logoTile(ch, size, fontSize, radius) {
  radius = radius || 10;
  const hasLogo = !!ch.logoUrl;
  const pad = Math.max(2, Math.round(size * 0.1));
  const kids = [h("span", { style: { position: "relative", zIndex: 1 } }, ch.mono)];
  if (hasLogo) {
    kids.push(h("img", {
      src: ch.logoUrl,
      loading: "lazy",
      style: { position: "absolute", inset: 0, width: "100%", height: "100%", objectFit: "contain", padding: pad + "px", zIndex: 2, background: "inherit" },
      onError: (e) => e.target.remove(), // reveal the initials underneath
    }));
  }
  return h("div", {
    style: {
      width: size + "px", height: size + "px", flex: "none", borderRadius: radius + "px",
      background: hasLogo ? "rgba(255,255,255,0.06)" : ch.grad,
      display: "flex", alignItems: "center", justifyContent: "center", position: "relative", overflow: "hidden",
      fontSize: fontSize + "px", fontWeight: 700, color: "#fff", letterSpacing: ".02em",
      boxShadow: "inset 0 0 0 1px rgba(255,255,255,0.08)",
    },
  }, ...kids);
}

// ===== state =====
const state = {
  mode: "watch",
  screen: "guide",
  selectedCellId: null,
  selectedProgram: null, // full detail of the focused program (from /api/program)
  detailMuted: true, // detail-pane preview audio
  detailVolume: 1, // preview volume (0–1), via the hover rocker
  detailHeight: loadDetailHeight(), // resizable hero height, persisted
  ambient: localStorage.getItem("cathode.ambient") !== "off", // focused video as guide backdrop
  mosaicLayout: "2x2",
  density: "comfortable", // guide row density: 'comfortable' | 'compact'
  guideOnlyWithEpg: true, // guide shows only channels that have program data
  networkGroup: localStorage.getItem("cathode.netgroup") !== "off", // collapse affiliate clusters into one row
  networkSelection: loadNetSel(), // per-network: which affiliate/market is active
  previews: localStorage.getItem("cathode.previews") !== "off", // auto-play live preview in the guide
  activeTileId: "t0",
  promotedTileId: null,
  selectedRows: {},
  data: null, // from /api/view
  settings: null, // from /api/settings
  envLocked: [],
  analytics: null, // from /api/analytics
  statusLive: null, // from /api/status (live streaming)
  loading: true,
  error: null,
  // auth
  auth: { user: null, needsSetup: false, checked: false },
  authBusy: false,
  authError: null,
  authForm: { username: "", password: "" },
  users: null, // admin: list of accounts (loaded on the Users screen)
  userNew: null, // create-user form draft, or null when closed
  userEditId: null, // which user's restriction editor is open
  userEditDraft: null, // working copy of that user's restrictions
  userBusy: false,
  userError: null,
  // share links
  shareFor: null, // channel id the share dialog is open for, or null
  shareForm: { expiresInHours: 24, maxConcurrent: 2 },
  shareBusy: false,
  shareError: null,
  shareCreated: null, // the most-recently created share (token + url)
  sharesList: null, // all shares (admin)
  // sources (providers) + rules
  providers: null,
  providerBusyId: null, // id currently syncing
  rules: null,
  ruleNew: null, // create-rule draft, or null
  ruleBusy: false,
  ruleError: null,
  ruleApplyMsg: null,
  // add-source modal
  addOpen: false,
  addBusy: false,
  addError: null,
  addForm: { name: "", type: "xtream", url: "", username: "", password: "", maxConnections: 4, epgUrl: "" },
};
let dragId = null;
let detailDragged = false; // suppress the pane's click after a resize drag
// Bounds inlined (not module consts) so this can run during the `state` literal
// without a temporal-dead-zone error.
function loadDetailHeight() {
  const v = parseInt(localStorage.getItem("cathode.detailHeight") || "", 10);
  return Number.isFinite(v) ? Math.max(150, Math.min(600, v)) : 300;
}
function loadNetSel() {
  try { return JSON.parse(localStorage.getItem("cathode.netsel") || "{}") || {}; } catch { return {}; }
}
function saveNetSel() {
  try { localStorage.setItem("cathode.netsel", JSON.stringify(state.networkSelection)); } catch { /* private mode */ }
}
function startDetailResize(e) {
  e.preventDefault();
  e.stopPropagation();
  const startY = e.clientY;
  const startH = state.detailHeight;
  const pane = e.currentTarget.parentElement;
  detailDragged = false;
  const onMove = (ev) => {
    const hgt = Math.max(150, Math.min(600, startH + (ev.clientY - startY)));
    if (Math.abs(hgt - startH) > 2) detailDragged = true;
    state.detailHeight = hgt;
    if (pane) pane.style.height = hgt + "px"; // live resize without a full re-render
  };
  const onUp = () => {
    document.removeEventListener("mousemove", onMove);
    document.removeEventListener("mouseup", onUp);
    document.body.style.userSelect = "";
    try { localStorage.setItem("cathode.detailHeight", String(state.detailHeight)); } catch { /* private mode */ }
    render(); // re-sync the virtualized grid to the new height
  };
  document.body.style.userSelect = "none";
  document.addEventListener("mousemove", onMove);
  document.addEventListener("mouseup", onUp);
}
// Virtualization scroll state (preserved across full re-renders).
let managerScrollTop = 0;
let guideScrollTop = 0;
let guideScrollLeft = null; // null = not yet positioned → snap to "now"

function set(patch) {
  Object.assign(state, patch);
  render();
}

// ===== data =====
async function loadView() {
  try {
    // /api/view = channels + health; /api/guide = the compressed EPG snapshot
    // (the browser transparently gunzips it). Fetched in parallel.
    const [viewRes, guideRes, settingsRes] = await Promise.all([
      fetch("/api/view"),
      fetch("/api/guide"),
      fetch("/api/settings"),
    ]);
    if (viewRes.status === 401) { // session expired/cleared → back to login
      state.auth = { user: null, needsSetup: false, checked: true };
      state.data = null;
      render();
      return;
    }
    if (!viewRes.ok) throw new Error("view " + viewRes.status);
    const data = await viewRes.json();
    if (settingsRes.ok) {
      const s = await settingsRes.json();
      state.settings = s.settings;
      state.envLocked = s.envLocked || [];
    }

    const guide = guideRes.ok
      ? await guideRes.json()
      : { base: Date.now(), end: Date.now() + 24 * 3600_000, ch: {} };
    data.windowStart = guide.base;
    data.windowEnd = guide.end;
    // Decode the compact [startMin, durMin, title] rows back to {start,end,title}.
    data.guide = {};
    for (const id in guide.ch) {
      data.guide[id] = guide.ch[id].map(([s, d, t]) => ({
        start: guide.base + s * 60000,
        end: guide.base + (s + d) * 60000,
        title: t,
      }));
    }

    // hydrate channels with genre/colour/mono
    data.channelsById = {};
    for (const ch of data.channels) {
      ch.genre = toGenre(ch.category);
      ch.color = SOLIDS[ch.genre];
      ch.grad = GRADS[ch.genre];
      ch.mono = initials(ch.name);
      data.channelsById[ch.id] = ch;
    }
    state.data = data;
    state.loading = false;
    state.error = null;
  } catch (e) {
    state.loading = false;
    state.error = String(e);
  }
  // Don't re-render under an open fullscreen player — it would tear down the
  // chrome-fade / the warm video. closePlayer() renders fresh on exit.
  if (!playerEl) render();
}

// programs for a channel within the window (synthesize a filler when EPG is thin)
function programsFor(ch) {
  const d = state.data;
  const raw = (d.guide && d.guide[ch.id]) || [];
  if (raw.length) return raw;
  return [{ start: d.windowStart, end: d.windowEnd, title: "No guide data", filler: true }];
}
function onNowProgram(ch) {
  const d = state.data;
  const progs = programsFor(ch);
  return progs.find((p) => p.start <= d.now && p.end > d.now) || progs[0];
}
function fmtClock(ms) {
  const dt = new Date(ms);
  const h2 = dt.getHours(), mn = dt.getMinutes();
  return (h2 < 10 ? "0" : "") + h2 + ":" + (mn < 10 ? "0" : "") + mn;
}

// ===== shell pieces =====
function topBar() {
  const seg = (on) => ({
    display: "flex", alignItems: "center", gap: "7px", height: "30px", padding: "0 14px",
    borderRadius: "8px", border: "none", background: on ? AC : "transparent",
    color: on ? "#06121c" : "#aeb4ba", fontSize: "13px", fontWeight: 600, cursor: "pointer", transition: "all .15s",
  });
  const segIcon = (on) => ({
    width: "15px", height: "15px",
    filter: on ? "brightness(0) invert(.05)" : "brightness(0) invert(.65)",
  });
  const d = state.data;
  const clock = d ? fmtClock(d.now) : "--:--";
  const u = state.auth.user;
  const isAdmin = u && u.role === "admin";

  return h("div", {
    style: "height:60px;flex:none;display:flex;align-items:center;gap:20px;padding:0 18px;border-bottom:1px solid rgba(255,255,255,0.07);background:rgba(18,20,22,0.6);backdrop-filter:blur(20px);position:relative;z-index:30",
  },
    h("div", { style: "display:flex;align-items:center;gap:11px;width:210px" },
      h("div", { style: "width:30px;height:30px;border-radius:9px;background:linear-gradient(140deg,#54b6ff,#2a78c2);display:flex;align-items:center;justify-content:center;box-shadow:0 0 16px rgba(84,182,255,0.35)" },
        h("div", { style: "width:11px;height:11px;border:2.5px solid #07121c;border-radius:50%;border-bottom-color:transparent;border-right-color:transparent;transform:rotate(45deg)" })),
      h("div", { style: "font-weight:700;font-size:17px;letter-spacing:.16em" }, "AERIAL")),
    // mode switch
    // Watch is for everyone; Manage is admin-only.
    h("div", { style: "display:flex;padding:3px;background:rgba(255,255,255,0.05);border:1px solid rgba(255,255,255,0.08);border-radius:11px;gap:2px" },
      h("button", { style: seg(state.mode === "watch"), onClick: () => setMode("watch") },
        h("img", { src: ICON("tv"), style: segIcon(state.mode === "watch") }), "Watch"),
      isAdmin ? h("button", { style: seg(state.mode === "manage"), onClick: () => setMode("manage") },
        h("img", { src: ICON("sliders-horizontal"), style: segIcon(state.mode === "manage") }), "Manage") : null),
    h("div", { style: "flex:1" }),
    h("div", { style: "display:flex;align-items:center;gap:9px;height:36px;padding:0 13px;background:rgba(255,255,255,0.04);border:1px solid rgba(255,255,255,0.08);border-radius:9px;min-width:230px;color:#7e858c" },
      h("img", { src: ICON("search"), style: "width:15px;height:15px;filter:brightness(0) invert(.55)" }),
      h("span", { style: "font-size:13.5px" }, "Search channels, shows…")),
    h("div", { style: "display:flex;align-items:center;gap:7px;padding:0 12px;height:36px;background:rgba(255,255,255,0.04);border:1px solid rgba(255,255,255,0.08);border-radius:9px" },
      h("span", { style: "width:7px;height:7px;border-radius:50%;background:#2fae5c;box-shadow:0 0 8px #2fae5c;animation:aerBlink 2.4s infinite" }),
      h("span", { style: "font-family:'JetBrains Mono',monospace;font-size:13.5px;font-weight:500;letter-spacing:.02em" }, clock)),
    h("div", { style: "display:flex;align-items:center;gap:9px" },
      h("div", { title: u ? u.username + (isAdmin ? " · admin" : "") : "", style: "width:34px;height:34px;border-radius:50%;background:linear-gradient(135deg," + (isAdmin ? "#2a78c2,#143c63" : "#3a3f47,#1a1d21") + ");border:1px solid rgba(255,255,255,0.12);display:flex;align-items:center;justify-content:center;font-size:13px;font-weight:700;color:#eef0f2;text-transform:uppercase" }, u ? u.username.slice(0, 2) : "?"),
      h("button", { title: "Sign out", onClick: logoutUser, style: "width:34px;height:34px;border-radius:9px;border:1px solid rgba(255,255,255,0.1);background:rgba(255,255,255,0.04);display:flex;align-items:center;justify-content:center;cursor:pointer" },
        h("img", { src: ICON("log-out"), style: "width:15px;height:15px;filter:brightness(0) invert(.65)" }))));
}

function leftRail() {
  const watchNav = [
    { id: "home", label: "Home", icon: "house", soon: true },
    { id: "guide", label: "Guide", icon: "tv" },
    { id: "mosaic", label: "Mosaic", icon: "grid-2x2" },
    { id: "nowplaying", label: "Now Playing", icon: "play", soon: true },
  ];
  const manageNav = [
    { id: "channels", label: "Channels", icon: "list" },
    { id: "users", label: "Users", icon: "users" },
    { id: "sources", label: "Sources", icon: "database" },
    { id: "rules", label: "Rules", icon: "filter" },
    { id: "analytics", label: "Analytics", icon: "chart-line" },
    { id: "epg", label: "EPG Matcher", icon: "git-compare", soon: true },
    { id: "settings", label: "Settings", icon: "settings" },
  ];
  const built = { guide: 1, mosaic: 1, channels: 1, settings: 1, analytics: 1, users: 1, sources: 1, rules: 1 };
  const navSrc = state.mode === "watch" ? watchNav : manageNav;
  const d = state.data;
  const healthLine = !d
    ? "—"
    : state.mode === "watch"
      ? `${d.serverHealth.channels} channels · ${d.serverHealth.streams} streams`
      : `${d.channels.length} channels · ${d.serverHealth.sources} sources`;

  return h("div", { style: "width:210px;flex:none;border-right:1px solid rgba(255,255,255,0.07);background:rgba(14,16,18,0.5);display:flex;flex-direction:column;padding:14px 12px;gap:3px" },
    h("div", { style: "font-size:10.5px;font-weight:600;letter-spacing:.16em;color:#5c6166;padding:6px 10px 8px" }, state.mode === "watch" ? "WATCH" : "MANAGE"),
    ...navSrc.map((n) => {
      const active = state.screen === n.id;
      const disabled = !built[n.id];
      return h("button", {
        title: disabled ? "Coming next pass" : n.label,
        onClick: disabled ? () => {} : () => setScreen(n.id),
        style: {
          display: "flex", alignItems: "center", gap: "11px", height: "42px", padding: "0 11px", borderRadius: "10px",
          border: "1px solid " + (active ? "rgba(84,182,255,0.3)" : "transparent"),
          background: active ? "rgba(84,182,255,0.12)" : "transparent",
          color: active ? "#eaf4ff" : disabled ? "#5c6166" : "#aeb4ba",
          fontSize: "14px", fontWeight: active ? 600 : 500,
          cursor: disabled ? "default" : "pointer", textAlign: "left", width: "100%",
          transition: "background .15s, color .15s", opacity: disabled ? 0.7 : 1,
        },
      },
        h("div", { style: { width: "18px", height: "18px", flex: "none", backgroundImage: `url(${ICON(n.icon)})`, backgroundSize: "contain", backgroundRepeat: "no-repeat", backgroundPosition: "center", filter: `brightness(0) invert(${active ? 1 : disabled ? 0.32 : 0.62})` } }),
        h("span", { style: "flex:1;text-align:left" }, n.label),
        n.soon ? h("span", { style: "font-size:9px;font-weight:600;letter-spacing:.1em;color:#5c6166;border:1px solid rgba(255,255,255,0.1);border-radius:5px;padding:2px 5px" }, "SOON") : null);
    }),
    h("div", { style: "flex:1" }),
    h("div", { style: "padding:12px 11px;border:1px solid rgba(255,255,255,0.07);border-radius:11px;background:rgba(255,255,255,0.02)" },
      h("div", { style: "display:flex;align-items:center;gap:7px;margin-bottom:7px" },
        h("span", { style: "width:7px;height:7px;border-radius:50%;background:#2fae5c;box-shadow:0 0 8px #2fae5c" }),
        h("span", { style: "font-size:11.5px;font-weight:600;color:#aeb4ba" }, "Server healthy")),
      h("div", { style: "font-size:11px;color:#6b7178;line-height:1.5" }, healthLine)));
}

// ===== GUIDE =====
// Comfortable (roomy, the default) vs Compact (fit more channels) row density.
function densityToggle() {
  const btn = (mode, iconName, title) => {
    const on = (state.density || "comfortable") === mode;
    return h("button", {
      title,
      onClick: () => set({ density: mode }),
      style: {
        display: "flex", alignItems: "center", justifyContent: "center",
        width: "34px", height: "30px", borderRadius: "8px", border: "none",
        background: on ? AC : "transparent", cursor: "pointer", transition: "all .15s",
      },
    }, icon(iconName, 16, on ? 0.05 : 0.6));
  };
  return h("div", { style: "display:flex;padding:3px;background:rgba(255,255,255,0.05);border:1px solid rgba(255,255,255,0.08);border-radius:10px;gap:2px" },
    btn("comfortable", "menu", "Comfortable"),
    btn("compact", "align-justify", "Compact"));
}

// Channels shown in the guide: non-hidden, optionally only those with EPG.
// Shared by guideScreen + miniPlayer so cell indices stay consistent.
// ===== network grouping =====
// Local affiliates of one network (same programming nationally, local news/ads
// + time-zone differences locally) are collapsed into a single guide row with a
// market dropdown. We key off the provider's own categories — which already
// separate true affiliates ("USA Local - NBC", "USA Latin TELEMUNDO") from
// multiplex/premium variants ("USA Movies", "USA Sports") that show DIFFERENT
// content and must stay as their own rows.
const LATIN_NET = { TELEMUNDO: "Telemundo", UNIVISION: "Univision", UNIMAS: "UniMás", GALAVISION: "Galavisión" };
function networkOf(ch) {
  const cat = ch.category || "";
  const local = cat.match(/USA Local - (ABC|NBC|CBS|FOX)\b/i);
  if (local) return local[1].toUpperCase();
  const latin = cat.match(/USA Latin (TELEMUNDO|UNIVISION|UNIMAS|GALAVISION)\b/i);
  if (latin) return LATIN_NET[latin[1].toUpperCase()] || latin[1];
  return null;
}

// Short market/affiliate label for the dropdown ("LA: TELEMUNDO CHICAGO" → "Chicago").
function marketLabel(ch, network) {
  let s = ch.name.replace(/^USA\s+/i, "").replace(/^LA:\s*/i, "");
  s = s.replace(new RegExp("\\b" + network + "\\b", "ig"), "");
  s = s.replace(/\bLocal\b/ig, "").replace(/^\d+\s*/, "").replace(/\s{2,}/g, " ").trim();
  return s || ch.name;
}

// Which affiliate is active for a group: the user's pick if still present, else
// the lowest channel number (the flagship/national feed tends to sort first).
function pickGroupMember(group) {
  const wanted = state.networkSelection[group.key];
  const found = wanted != null && group.members.find((m) => m.id === wanted);
  return found || group.members.slice().sort((a, b) => (a.number ?? 1e9) - (b.number ?? 1e9))[0];
}

// Collapse affiliate clusters; each group entry IS its selected member plus a
// `_group` tag, so EPG/detail/playback keep working transparently.
function groupByNetwork(list) {
  const byKey = new Map();
  const out = [];
  for (const ch of list) {
    const net = networkOf(ch);
    if (!net) { out.push(ch); continue; }
    const key = "net:" + net;
    let g = byKey.get(key);
    if (!g) { g = { key, network: net, members: [] }; byKey.set(key, g); out.push(g); }
    g.members.push(ch);
  }
  return out.map((e) => {
    if (!e.members) return e; // ungrouped channel
    if (e.members.length === 1) return e.members[0]; // lone affiliate — no point collapsing
    const sel = pickGroupMember(e);
    return { ...sel, _group: { key: e.key, network: e.network, members: e.members } };
  });
}

function guideVisible() {
  const d = state.data;
  let v = d.channels.filter((c) => !c.isHidden);
  if (state.guideOnlyWithEpg !== false) {
    const withEpg = v.filter((ch) => d.guide[ch.id] && d.guide[ch.id].length);
    if (withEpg.length) v = withEpg; // don't filter to empty if no EPG synced yet
  }
  if (state.networkGroup !== false) v = groupByNetwork(v);
  return v;
}

// Toggle: only channels with guide data vs every channel.
function guideFilterToggle() {
  const seg = (on) => ({
    height: "30px", padding: "0 12px", borderRadius: "8px", border: "none",
    background: on ? AC : "transparent", color: on ? "#06121c" : "#aeb4ba",
    fontSize: "12.5px", fontWeight: 600, fontFamily: "inherit", cursor: "pointer", transition: "all .15s",
  });
  const only = state.guideOnlyWithEpg !== false;
  return h("div", { style: "display:flex;padding:3px;background:rgba(255,255,255,0.05);border:1px solid rgba(255,255,255,0.08);border-radius:10px;gap:2px" },
    h("button", { style: seg(only), onClick: () => set({ guideOnlyWithEpg: true, selectedCellId: null }), title: "Only channels with guide data" }, "With guide"),
    h("button", { style: seg(!only), onClick: () => set({ guideOnlyWithEpg: false, selectedCellId: null }), title: "All channels" }, "All"));
}

function guideScreen() {
  const d = state.data;
  const visible = guideVisible();
  const totalVisible = d.channels.filter((c) => !c.isHidden).length;
  const { windowStart, windowEnd, now } = d;
  const ROWH = rowH();
  const totalW = ((windowEnd - windowStart) / 60000) * PXPM;
  const rowsH = visible.length * ROWH;
  const nowX = ((now - windowStart) / 60000) * PXPM;

  // ambient mode: the focused channel's live video fills the guide background
  const focusSel = focusedGuideSelection();
  const ambient = state.ambient !== false && !!focusSel;
  // Frosted-glass framing in ambient mode: sticky time-header + channel column.
  // Low tint so the video shows through; backdrop-filter does the legibility work.
  const stickyBg = ambient ? "rgba(14,16,20,0.28)" : "#0c0d0e";
  const frost = ambient ? ";backdrop-filter:blur(18px);-webkit-backdrop-filter:blur(18px)" : "";

  // header
  const header = h("div", { style: "flex:none;display:flex;align-items:flex-end;justify-content:space-between;padding:18px 24px 14px" + (ambient ? ";position:relative;z-index:2" : "") },
    h("div", null,
      h("div", { style: "font-size:23px;font-weight:700;letter-spacing:-.01em" + (ambient ? ";" + "text-shadow:0 2px 8px rgba(0,0,0,0.7)" : "") }, "Guide"),
      h("div", { style: "font-size:13px;color:#9aa0a6;margin-top:3px" }, state.guideOnlyWithEpg !== false
        ? `${visible.length} channels with guide · ${totalVisible} total · ${new Date(now).toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" })}`
        : `Live across ${visible.length} channels · ${new Date(now).toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" })}`)),
    h("div", { style: "display:flex;gap:8px;align-items:center" },
      h("button", { onClick: () => { const next = state.previews === false; try { localStorage.setItem("cathode.previews", next ? "on" : "off"); } catch { /* private */ } set({ previews: next }); }, title: state.previews !== false ? "Live preview on — click to stop background video" : "Live preview off — click to enable", style: "width:36px;height:36px;border-radius:9px;border:1px solid " + (state.previews !== false ? "rgba(84,182,255,0.5)" : "rgba(255,255,255,0.1)") + ";background:" + (state.previews !== false ? "rgba(84,182,255,0.16)" : "rgba(255,255,255,0.04)") + ";display:flex;align-items:center;justify-content:center;cursor:pointer" },
        icon(state.previews !== false ? "monitor-play" : "monitor-off", 16, state.previews !== false ? 0.85 : 0.55)),
      h("button", { onClick: () => { const next = state.networkGroup === false; try { localStorage.setItem("cathode.netgroup", next ? "on" : "off"); } catch { /* private */ } set({ networkGroup: next, selectedCellId: null }); }, title: "Group network affiliates (collapse local stations into one row)", style: "width:36px;height:36px;border-radius:9px;border:1px solid " + (state.networkGroup !== false ? "rgba(84,182,255,0.5)" : "rgba(255,255,255,0.1)") + ";background:" + (state.networkGroup !== false ? "rgba(84,182,255,0.16)" : "rgba(255,255,255,0.04)") + ";display:flex;align-items:center;justify-content:center;cursor:pointer" },
        icon("layers", 16, state.networkGroup !== false ? 0.85 : 0.55)),
      h("button", { onClick: () => { const next = !(state.ambient !== false); try { localStorage.setItem("cathode.ambient", next ? "on" : "off"); } catch { /* private */ } set({ ambient: next }); }, title: "Ambient backdrop", style: "width:36px;height:36px;border-radius:9px;border:1px solid " + (state.ambient !== false ? "rgba(84,182,255,0.5)" : "rgba(255,255,255,0.1)") + ";background:" + (state.ambient !== false ? "rgba(84,182,255,0.16)" : "rgba(255,255,255,0.04)") + ";display:flex;align-items:center;justify-content:center;cursor:pointer" },
        icon("clapperboard", 16, state.ambient !== false ? 0.85 : 0.55)),
      guideFilterToggle(),
      densityToggle(),
      h("button", { style: "height:36px;padding:0 15px;border-radius:9px;border:1px solid rgba(255,255,255,0.1);background:rgba(255,255,255,0.04);color:#dfe3e7;font-size:13px;font-weight:600;display:flex;align-items:center;gap:7px;cursor:pointer", onClick: () => { guideScrollLeft = null; render(); } },
        h("span", { style: "width:7px;height:7px;border-radius:50%;background:#54b6ff;box-shadow:0 0 8px #54b6ff" }), "Jump to now"),
      h("button", { style: "height:36px;padding:0 15px;border-radius:9px;border:1px solid rgba(255,255,255,0.1);background:rgba(255,255,255,0.04);color:#dfe3e7;font-size:13px;font-weight:600;cursor:pointer" }, "All genres")));

  // rich detail pane (reflects the selected/highlighted program)
  const card = detailPane(ambient);

  // time axis labels every 30 min
  const labels = [];
  for (let t = windowStart; t <= windowEnd; t += 30 * 60000) {
    const hour = new Date(t).getMinutes() === 0;
    labels.push(h("div", { style: { position: "absolute", left: ((t - windowStart) / 60000) * PXPM + "px", top: 0, bottom: 0, display: "flex", alignItems: "center", borderLeft: "1px solid " + (hour ? "rgba(255,255,255,0.08)" : "rgba(255,255,255,0.035)"), paddingLeft: "9px" } },
      h("span", { style: { fontFamily: "JetBrains Mono, monospace", fontSize: "11.5px", fontWeight: hour ? 600 : 400, color: ambient ? (hour ? "#eef0f2" : "#b4bac0") : (hour ? "#9aa0a6" : "#5c6166"), textShadow: ambient ? "0 1px 4px rgba(0,0,0,0.95)" : undefined } }, fmtClock(t))));
  }

  const headerRow = h("div", { style: "display:flex;height:48px;position:sticky;top:0;z-index:6" },
    h("div", { style: "width:210px;flex:none;position:sticky;left:0;z-index:7;background:" + stickyBg + frost + ";border-bottom:1px solid rgba(255,255,255,0.08);border-right:1px solid rgba(255,255,255,0.06);display:flex;align-items:center;padding:0 18px;font-size:11px;font-weight:600;letter-spacing:.12em;color:#5c6166" }, "CHANNEL"),
    h("div", { style: { width: totalW + "px", position: "relative", borderBottom: "1px solid rgba(255,255,255,0.08)", background: stickyBg, backdropFilter: ambient ? "blur(16px)" : undefined } }, ...labels));

  // Static glow — animating box-shadow on a full-height (~100k px) line repaints
  // the whole column every frame and tanks scroll perf. The pulsing now-dot keeps
  // the live cue.
  const nowLine = h("div", { style: { position: "absolute", left: COLW + nowX + "px", top: HEADH + "px", width: "2px", height: rowsH + "px", background: AC, zIndex: 3, pointerEvents: "none", boxShadow: "0 0 8px " + AC } });
  const nowDot = h("div", { style: { position: "absolute", left: COLW + nowX - 4 + "px", top: HEADH - 5 + "px", width: "10px", height: "10px", borderRadius: "50%", background: AC, zIndex: 7, boxShadow: "0 0 12px " + AC, "--ac": AC, animation: "aerNowPulse 3s ease-in-out infinite" } });

  // Virtualized rows: only the rows in (and near) the viewport are in the DOM.
  // header/now-line/now-dot are the first 3 children and are kept across slices.
  const inner = h("div", { style: { width: COLW + totalW + "px", height: HEADH + rowsH + "px", position: "relative" } }, headerRow, nowLine, nowDot);
  const scroller = h("div", { id: "aerGuideScroll", style: "flex:1;min-height:0;overflow:auto" + (ambient ? ";position:relative;z-index:2;background:rgba(11,12,15,0.3);backdrop-filter:blur(22px);-webkit-backdrop-filter:blur(22px)" : "") }, inner);

  let lastStart = -1, lastEnd = -1, scrollRaf = 0;
  const renderSlice = () => {
    const st = scroller.scrollTop;
    const vh = scroller.clientHeight || 600;
    const start = Math.max(0, Math.floor(st / ROWH) - 4);
    const end = Math.min(visible.length, Math.ceil((st + vh) / ROWH) + 4);
    // Horizontal time-scroll doesn't change which rows are visible — skip the
    // rebuild entirely unless the vertical window actually moved.
    if (start === lastStart && end === lastEnd) return;
    lastStart = start;
    lastEnd = end;
    while (inner.childNodes.length > 3) inner.removeChild(inner.lastChild);
    for (let i = start; i < end; i++) {
      const el = guideRow(visible[i], i, totalW, now, windowStart, ROWH);
      el.style.position = "absolute";
      el.style.top = HEADH + i * ROWH + "px";
      el.style.left = "0";
      inner.appendChild(el);
    }
  };
  scroller.addEventListener("scroll", () => {
    guideScrollTop = scroller.scrollTop;
    guideScrollLeft = scroller.scrollLeft;
    if (!scrollRaf) scrollRaf = requestAnimationFrame(() => { scrollRaf = 0; renderSlice(); });
  }, { passive: true });
  const applyScroll = () => {
    if (guideScrollLeft == null) {
      scroller.scrollLeft = Math.max(0, COLW + ((now - windowStart) / 60000) * PXPM - 420);
      guideScrollLeft = scroller.scrollLeft;
    } else {
      scroller.scrollLeft = guideScrollLeft;
    }
    scroller.scrollTop = guideScrollTop;
    renderSlice();
  };
  renderSlice(); // immediate so rows paint even where rAF is throttled
  requestAnimationFrame(applyScroll);
  setTimeout(applyScroll, 0);

  if (ambient) {
    const fc = focusSel.ch;
    return h("div", { style: "flex:1;display:flex;flex-direction:column;min-height:0;position:relative;overflow:hidden" },
      // sharp full-screen background video (the grid frosts it via backdrop-filter)
      h("div", { style: "position:absolute;inset:0;z-index:0;overflow:hidden;background:" + fc.grad },
        tileVideo("detail", fc.id, state.detailMuted)),
      // subtle left fade so the hero text reads over the sharp video
      h("div", { style: "position:absolute;inset:0;z-index:1;pointer-events:none;background:linear-gradient(100deg,rgba(9,10,11,0.86) 0%,rgba(9,10,11,0.5) 26%,rgba(9,10,11,0) 56%)" }),
      header, card, scroller);
  }
  return h("div", { style: "flex:1;display:flex;flex-direction:column;min-height:0" }, header, card, scroller);
}

// The focused program drives the detail pane: the selected guide cell, else the
// first visible channel's on-now program.
function focusedGuideSelection() {
  const visible = guideVisible();
  if (!visible.length) return null;
  if (state.selectedCellId) {
    const [ci, pi] = state.selectedCellId.split("-").map(Number);
    const ch = visible[ci];
    if (ch) { const progs = programsFor(ch); return { ch, p: progs[pi] || progs[0] }; }
  }
  const ch = visible[0];
  return { ch, p: onNowProgram(ch) };
}

let lastDetailKey = null;
let detailFocusKey = null;
function ensureProgramDetail(ch, p) {
  if (!ch || !ch.canonicalId || !p || p.filler) { lastDetailKey = null; state.selectedProgram = null; return; }
  const key = ch.canonicalId + "@" + p.start;
  if (key === lastDetailKey) return;
  lastDetailKey = key;
  fetch(`/api/program?canonicalId=${encodeURIComponent(ch.canonicalId)}&at=${p.start + 1000}`)
    .then((r) => (r.ok ? r.json() : null))
    .then((det) => { if (lastDetailKey === key) { state.selectedProgram = det; render(); } })
    .catch(() => {});
}

// Rich, selection-driven detail pane. Two modes:
//  - boxed hero (default) — its own resizable video card
//  - ambient — info floats over a full-screen background video (rendered by guideScreen)
function detailPane(ambient) {
  const sel = focusedGuideSelection();
  if (!sel) return h("div", { style: "display:none" });
  const { ch, p } = sel;
  ensureProgramDetail(ch, p);
  const now = Date.now();
  const onNow = !p.filler && p.start <= now && p.end > now;
  const prog = onNow ? Math.max(0, Math.min(1, (now - p.start) / (p.end - p.start || 1))) : 0;
  const det = state.selectedProgram && lastDetailKey === ch.canonicalId + "@" + p.start ? state.selectedProgram : null;
  const desc = det && det.description ? det.description : "";
  const badges = [];
  if (ch.category) badges.push(ch.category);
  if (det && det.season && det.episode) badges.push(`S${det.season} · E${det.episode}`);
  const ts = "text-shadow:0 2px 10px rgba(0,0,0,0.85),0 1px 3px rgba(0,0,0,0.9)";
  // crossfade the info only when the focused program actually changes
  const focusKey = ch.id + "@" + p.start;
  const infoAnim = focusKey !== detailFocusKey ? "animation:aerFadeIn .3s ease;" : "";
  detailFocusKey = focusKey;

  // shared info pieces
  const channelRow = h("div", { style: "display:flex;align-items:center;gap:9px" },
    logoTile(ch, 30, 11, 7),
    h("span", { style: "font-family:'JetBrains Mono',monospace;font-size:13px;font-weight:600;color:" + ch.color + ";" + ts }, "#" + (ch.num ?? "—")),
    h("span", { style: "font-size:13.5px;font-weight:700;color:#e6e9ec;" + ts }, ch.name),
    onNow ? h("span", { style: "font-size:9.5px;font-weight:700;letter-spacing:.12em;color:#ff9d95;border:1px solid rgba(255,93,82,0.5);border-radius:5px;padding:2px 6px;background:rgba(8,10,12,0.35)" }, "ON NOW") : null);
  const titleEl = h("div", { style: "font-size:28px;font-weight:800;color:#fff;letter-spacing:-.015em;line-height:1.12;overflow:hidden;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;" + ts }, p.title);
  const metaEl = h("div", { style: "display:flex;align-items:center;gap:9px;flex-wrap:wrap" },
    h("span", { style: "font-family:'JetBrains Mono',monospace;font-size:12.5px;color:#cfd3d8;" + ts }, p.filler ? "No guide data" : fmtClock(p.start) + " – " + fmtClock(p.end)),
    ...badges.map((b) => h("span", { style: "font-size:11px;font-weight:600;color:#dfe3e7;border:1px solid rgba(255,255,255,0.2);border-radius:5px;padding:2px 7px;background:rgba(8,10,12,0.3)" }, b)));
  const descEl = desc ? h("div", { style: "font-size:13.5px;color:#c3c8cd;line-height:1.5;max-width:600px;overflow:hidden;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;" + ts }, desc) : null;
  const fsBtn = h("button", { title: "Fullscreen", style: "pointer-events:auto;width:46px;height:46px;border-radius:12px;border:none;background:#fff;cursor:pointer;display:flex;align-items:center;justify-content:center;box-shadow:0 4px 16px rgba(0,0,0,0.45)", onClick: (e) => { e.stopPropagation(); openPlayer(ch.id); } },
    icon("maximize-2", 19, 0.05));
  // Admins can mint a login-free share link for this channel.
  const shareBtn = (state.auth.user && state.auth.user.role === "admin")
    ? h("button", { title: "Create a share link", style: "pointer-events:auto;width:46px;height:46px;border-radius:12px;border:1px solid rgba(255,255,255,0.18);background:rgba(8,10,12,0.55);cursor:pointer;display:flex;align-items:center;justify-content:center;backdrop-filter:blur(6px)", onClick: (e) => { e.stopPropagation(); openShareDialog(ch.id); } }, icon("share-2", 18, 0.9))
    : null;
  const watchBtn = h("div", { style: "display:flex;gap:10px;align-self:flex-start;margin-top:6px;pointer-events:auto" }, fsBtn, shareBtn);
  // Mute button with a hover-reveal vertical volume rocker (popup to its left).
  const muteToggle = (extra) => {
    const muted = state.detailMuted;
    const vol = muted ? 0 : (state.detailVolume ?? 1);
    const iconName = muted ? "volume-x" : vol < 0.5 ? "volume-1" : "volume-2";
    let hideT = null;
    const show = () => { if (hideT) { clearTimeout(hideT); hideT = null; } popup.style.opacity = "1"; popup.style.transform = "translateY(-50%) scale(1)"; popup.style.pointerEvents = "auto"; };
    const hideSoon = () => { if (hideT) clearTimeout(hideT); hideT = setTimeout(() => { popup.style.opacity = "0"; popup.style.transform = "translateY(-50%) scale(.88)"; popup.style.pointerEvents = "none"; }, 260); };
    const slider = h("input", { type: "range", class: "aer-vol", min: "0", max: "1", step: "0.05", value: String(vol),
      onInput: (e) => setDetailVolume(Number(e.target.value)),
      onChange: () => render(),
      onClick: (e) => e.stopPropagation(),
      style: "writing-mode:vertical-lr;direction:rtl;width:8px;height:94px;cursor:pointer;margin:0" });
    // padding-right bridges the gap to the button so the pointer never leaves a hot area.
    // Smooth scale+fade reveal from the button (transform-origin right).
    const popup = h("div", { onMouseenter: show, onMouseleave: hideSoon, style: "position:absolute;right:30px;top:50%;transform:translateY(-50%) scale(.88);transform-origin:right center;opacity:0;pointer-events:none;transition:opacity .17s ease,transform .2s cubic-bezier(.2,.8,.3,1);display:flex;flex-direction:column;align-items:center;padding:13px 11px;padding-right:20px;background:rgba(8,10,12,0.9);border:1px solid rgba(255,255,255,0.14);border-radius:12px;backdrop-filter:blur(10px);box-shadow:0 8px 26px rgba(0,0,0,0.55);z-index:12" }, slider);
    const btn = h("button", { onClick: (e) => { e.stopPropagation(); toggleDetailMute(); }, title: muted ? "Unmute" : "Mute", style: "width:36px;height:36px;border-radius:9px;border:1px solid rgba(255,255,255,0.16);background:rgba(8,10,12,0.5);display:flex;align-items:center;justify-content:center;cursor:pointer;backdrop-filter:blur(5px)" },
      icon(iconName, 16, 0.92));
    const isAbs = !!(extra && extra.indexOf("position:absolute") >= 0);
    return h("div", { style: (extra || "") + (isAbs ? "" : "position:relative;") + "flex:none",
      onMouseenter: show,
      onMouseleave: hideSoon,
      onClick: (e) => e.stopPropagation() }, btn, popup);
  };

  // AMBIENT: just the floating info (the background video lives in guideScreen)
  if (ambient) {
    return h("div", { style: "flex:none;position:relative;z-index:3;padding:16px 28px 20px;display:flex;align-items:flex-end;justify-content:space-between;gap:16px" },
      h("div", { style: infoAnim + "display:flex;flex-direction:column;gap:10px;max-width:64%;pointer-events:auto" },
        channelRow, titleEl, metaEl, descEl, watchBtn),
      muteToggle());
  }

  // BOXED hero (resizable video card)
  return h("div", { onClick: () => { if (detailDragged) { detailDragged = false; return; } openPlayer(ch.id); }, style: "position:relative;flex:none;margin:0 24px 14px;height:" + state.detailHeight + "px;border-radius:14px;overflow:hidden;border:1px solid rgba(255,255,255,0.09);box-shadow:0 12px 34px rgba(0,0,0,0.4);cursor:pointer;background:" + ch.grad },
    ch.logoUrl ? h("img", { src: ch.logoUrl, loading: "lazy", style: "position:absolute;top:50%;left:66%;transform:translate(-50%,-50%);max-width:26%;max-height:50%;object-fit:contain;opacity:.55;z-index:0;filter:drop-shadow(0 2px 10px rgba(0,0,0,0.5))", onError: (e) => e.target.remove() }) : null,
    tileVideo("detail", ch.id, state.detailMuted),
    h("div", { style: "position:absolute;inset:0;z-index:2;background:linear-gradient(100deg,rgba(9,10,11,0.94) 0%,rgba(9,10,11,0.82) 24%,rgba(9,10,11,0.42) 44%,rgba(9,10,11,0) 62%)" }),
    h("div", { style: "position:absolute;left:0;right:0;bottom:0;height:45%;z-index:2;background:linear-gradient(0deg,rgba(9,10,11,0.5),transparent)" }),
    onNow ? h("div", { style: "position:absolute;top:15px;left:18px;z-index:4;display:flex;align-items:center;gap:6px;padding:4px 10px;background:rgba(8,10,12,0.5);border-radius:8px;backdrop-filter:blur(4px)" },
      h("span", { style: "width:6px;height:6px;border-radius:50%;background:#ff5d52;box-shadow:0 0 7px #ff5d52;animation:aerBlink 2s infinite" }),
      h("span", { style: "font-size:10px;font-weight:700;letter-spacing:.12em" }, "LIVE")) : null,
    muteToggle("position:absolute;top:14px;right:16px;z-index:5;"),
    h("div", { style: infoAnim + "position:absolute;left:28px;top:0;bottom:0;width:56%;z-index:3;display:flex;flex-direction:column;justify-content:center;gap:10px;pointer-events:none" },
      channelRow, titleEl, metaEl, descEl, watchBtn),
    onNow ? h("div", { style: "position:absolute;left:0;right:0;bottom:0;z-index:4;height:3px;background:rgba(255,255,255,0.15)" },
      h("div", { style: { height: "100%", width: Math.round(prog * 100) + "%", background: AC, boxShadow: "0 0 8px " + AC } })) : null,
    h("div", { onMousedown: startDetailResize, onClick: (e) => e.stopPropagation(), title: "Drag to resize", style: "position:absolute;left:0;right:0;bottom:0;z-index:7;height:14px;cursor:ns-resize;display:flex;align-items:flex-end;justify-content:center;padding-bottom:4px" },
      h("div", { style: "width:48px;height:4px;border-radius:2px;background:rgba(255,255,255,0.35);box-shadow:0 1px 3px rgba(0,0,0,0.6)" })));
}

// The market/affiliate dropdown shown in a collapsed network row.
function networkSelect(g, selected) {
  const stop = (e) => e.stopPropagation(); // never let the dropdown trigger the row's "watch"
  const sel = h("select", {
    title: "Choose market / affiliate",
    onClick: stop, onMousedown: stop,
    onChange: (e) => { state.networkSelection[g.key] = Number(e.target.value); saveNetSel(); set({ selectedCellId: null }); },
    style: "appearance:none;-webkit-appearance:none;width:100%;max-width:100%;background:rgba(255,255,255,0.06);border:1px solid rgba(255,255,255,0.13);border-radius:7px;color:#dfe3e7;font-size:11.5px;font-weight:600;font-family:inherit;padding:3px 20px 3px 8px;cursor:pointer;white-space:nowrap;overflow:hidden;text-overflow:ellipsis",
  }, ...g.members.map((m) => h("option", { value: String(m.id), selected: m.id === selected.id, style: "background:#16181c;color:#dfe3e7" }, marketLabel(m, g.network))));
  return h("div", { style: "position:relative;min-width:0", onClick: stop },
    sel,
    h("span", { style: "position:absolute;right:7px;top:50%;transform:translateY(-50%);pointer-events:none;font-size:9px;color:#9aa0a6" }, "▾"));
}

function guideRow(ch, ci, totalW, now, windowStart, ROWH) {
  const hc = ch.health === "live" ? "#2fae5c" : ch.health === "sd" ? "#f4b740" : "#ff5d52";
  const windowEnd = windowStart + (totalW / PXPM) * 60000;
  const cells = programsFor(ch).map((p, pi) => {
    const id = ci + "-" + pi;
    const onNow = p.start <= now && p.end > now && !p.filler;
    const sel = state.selectedCellId === id;
    const startsBefore = !p.filler && p.start < windowStart;
    const endsAfter = !p.filler && p.end > windowEnd;
    const left = Math.max(0, ((p.start - windowStart) / 60000) * PXPM);
    const rawW = ((p.end - windowStart) / 60000) * PXPM - left;
    const width = Math.max(54, rawW - 5);
    return h("div", { style: { position: "absolute", top: "6px", bottom: "6px", left: left + "px", width: width + "px" }, onClick: () => set({ selectedCellId: id }) },
      h("div", { class: "aer-cell", style: {
        height: "100%", borderRadius: "9px", overflow: "hidden", position: "relative", display: "flex", flexDirection: "column", justifyContent: "flex-end",
        padding: "9px 11px", cursor: "pointer", transition: "transform .14s, box-shadow .14s, border-color .14s",
        border: "1px solid " + (sel ? AC : onNow ? "rgba(255,255,255,0.12)" : "rgba(255,255,255,0.06)"),
        background: onNow ? ch.grad : "rgba(255,255,255,0.028)",
        boxShadow: sel ? "0 0 0 1px " + AC + ", 0 0 26px rgba(84,182,255,0.32)" : "none",
      } },
        onNow ? h("div", { style: { position: "absolute", inset: 0, background: "repeating-linear-gradient(0deg,rgba(255,255,255,0.05) 0,rgba(255,255,255,0.05) 1px,transparent 1px,transparent 3px)", opacity: 0.5 } }) : null,
        onNow ? h("div", { style: "position:absolute;top:7px;left:8px;display:flex;align-items:center;gap:5px;padding:2px 7px;background:rgba(8,10,12,0.66);border-radius:6px;backdrop-filter:blur(4px)" },
          h("span", { style: "width:6px;height:6px;border-radius:50%;background:#ff5d52;box-shadow:0 0 7px #ff5d52;animation:aerBlink 2s infinite" }),
          h("span", { style: "font-size:9.5px;font-weight:700;letter-spacing:.12em;color:#f5f0e6" }, "LIVE")) : null,
        !onNow ? h("div", { style: { position: "absolute", left: 0, top: 0, bottom: 0, width: "3px", background: ch.color, opacity: 0.55 } }) : null,
        startsBefore ? h("div", { style: "position:absolute;left:4px;top:50%;transform:translateY(-50%);z-index:3;color:#9aa0a6;font-size:15px;font-weight:700;text-shadow:0 1px 3px rgba(0,0,0,0.6)" }, "‹") : null,
        endsAfter ? h("div", { style: "position:absolute;right:4px;top:50%;transform:translateY(-50%);z-index:3;color:#9aa0a6;font-size:15px;font-weight:700;text-shadow:0 1px 3px rgba(0,0,0,0.6)" }, "›") : null,
        h("div", { style: "position:relative;z-index:2" },
          h("div", { style: { fontSize: "13.5px", fontWeight: 600, color: onNow ? "#f5f7f9" : "#cfd3d8", lineHeight: 1.25, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", textShadow: onNow ? "0 1px 6px rgba(0,0,0,0.5)" : "none" } }, p.title),
          h("div", { style: { fontFamily: "JetBrains Mono, monospace", fontSize: "10.5px", color: onNow ? "rgba(245,247,249,0.75)" : "#6b7178", marginTop: "2px" } }, p.filler ? "" : fmtClock(p.start) + " – " + fmtClock(p.end)))));
  });

  const g = ch._group;
  const colInfo = g
    ? h("div", { style: "min-width:0;flex:1;display:flex;flex-direction:column;gap:3px" },
        h("div", { style: "display:flex;align-items:center;gap:6px" },
          h("span", { style: "font-size:13.5px;font-weight:700;color:#dfe3e7;white-space:nowrap;overflow:hidden;text-overflow:ellipsis" }, g.network),
          h("span", { style: "flex:none;font-size:10px;font-weight:700;color:#9aa0a6;background:rgba(255,255,255,0.08);border-radius:5px;padding:1px 5px" }, g.members.length + " feeds")),
        networkSelect(g, ch))
    : h("div", { style: "min-width:0;flex:1" },
        h("div", { style: "font-family:'JetBrains Mono',monospace;font-size:11px;color:#6b7178;font-weight:500" }, "#" + (ch.num ?? "—")),
        h("div", { style: "font-size:13.5px;font-weight:600;color:#dfe3e7;white-space:nowrap;overflow:hidden;text-overflow:ellipsis" }, ch.name));

  const ambient = state.ambient !== false;
  // Channel column: keep the left frosted (logo/name) but ramp opacity toward the
  // right so program text scrolling under the sticky column can't bleed through,
  // plus a soft fade tail past the edge so cell titles don't butt the names.
  const colBg = ambient
    ? "linear-gradient(90deg, rgba(13,15,19,0.34) 0%, rgba(13,15,19,0.34) 46%, rgba(13,15,19,0.86) 100%)"
    : "#0c0d0e";
  return h("div", { style: { display: "flex", height: ROWH + "px", borderBottom: "1px solid rgba(255,255,255,0.045)" } },
    h("div", { onClick: () => openPlayer(ch.id), title: g ? "Watch " + g.network : "Watch " + ch.name, style: { width: COLW + "px", flex: "none", position: "sticky", left: 0, zIndex: 6, background: colBg, backdropFilter: ambient ? "blur(18px)" : undefined, borderRight: "1px solid rgba(255,255,255,0.06)", display: "flex", alignItems: "center", gap: "11px", padding: "0 16px", cursor: "pointer" } },
      logoTile(ch, 42, 13),
      colInfo,
      h("span", { style: { width: "8px", height: "8px", flex: "none", borderRadius: "50%", background: hc, boxShadow: "0 0 7px " + hc } }),
      h("div", { style: "position:absolute;top:0;bottom:0;left:100%;width:44px;pointer-events:none;background:linear-gradient(90deg," + (ambient ? "rgba(13,15,19,0.86)" : "rgba(12,13,14,0.96)") + ",transparent)" })),
    h("div", { style: { width: totalW + "px", position: "relative", flex: "none" } }, ...cells));
}

function miniPlayer() {
  if (!state.selectedCellId) return h("div", { style: "display:none" });
  const visible = guideVisible();
  const [ci, pi] = state.selectedCellId.split("-").map(Number);
  const mc = visible[ci];
  if (!mc) return h("div", { style: "display:none" });
  const progs = programsFor(mc);
  const mp = progs[pi] || progs[0];
  const next = progs.find((p) => p.start >= mp.end) || { title: "—" };
  return h("div", { style: { position: "absolute", right: "24px", bottom: "24px", width: "320px", borderRadius: "14px", overflow: "hidden", background: "rgba(20,22,24,0.82)", backdropFilter: "blur(18px)", border: "1px solid rgba(255,255,255,0.1)", boxShadow: "0 24px 60px rgba(0,0,0,0.55)", zIndex: 20, animation: "aerFadeUp .26s ease" } },
    h("div", { onClick: () => openPlayer(mc.id), title: "Watch " + mc.name, style: { position: "relative", height: "150px", background: mc.grad, overflow: "hidden", cursor: "pointer" } },
      h("div", { style: "position:absolute;inset:0;background:linear-gradient(180deg,rgba(8,10,12,0) 40%,rgba(8,10,12,0.82))" }),
      mc.logoUrl ? h("img", { src: mc.logoUrl, loading: "lazy", style: "position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);max-width:46%;max-height:46%;object-fit:contain;filter:drop-shadow(0 2px 8px rgba(0,0,0,0.55))", onError: (e) => e.target.remove() }) : null,
      tileVideo("mini", mc.id, true), // muted live preview
      h("div", { style: "position:absolute;top:9px;left:10px;z-index:2;display:flex;align-items:center;gap:5px;padding:2px 7px;background:rgba(8,10,12,0.6);border-radius:6px;backdrop-filter:blur(4px)" },
        h("span", { style: "width:6px;height:6px;border-radius:50%;background:#ff5d52;box-shadow:0 0 7px #ff5d52;animation:aerBlink 2s infinite" }),
        h("span", { style: "font-size:9.5px;font-weight:700;letter-spacing:.12em" }, "LIVE")),
      h("div", { style: "position:absolute;inset:0;z-index:2;display:flex;align-items:center;justify-content:center;pointer-events:none" },
        h("div", { style: "width:46px;height:46px;border-radius:50%;background:rgba(8,10,12,0.4);border:1px solid rgba(255,255,255,0.25);display:flex;align-items:center;justify-content:center;backdrop-filter:blur(4px)" }, icon("play", 18, 0.95))),
      h("button", { style: "position:absolute;top:8px;right:8px;width:30px;height:30px;border-radius:8px;border:1px solid rgba(255,255,255,0.12);background:rgba(8,10,12,0.55);display:flex;align-items:center;justify-content:center;cursor:pointer;z-index:2", onClick: (e) => { e.stopPropagation(); set({ selectedCellId: null }); } },
        icon("x", 14, 0.9))),
    h("div", { style: "padding:11px 13px 12px" },
      h("div", { style: "display:flex;align-items:center;gap:8px;margin-bottom:8px" },
        h("span", { style: { fontFamily: "'JetBrains Mono',monospace", fontSize: "12px", fontWeight: 600, color: mc.color } }, "#" + (mc.num ?? "—")),
        h("span", { style: "font-size:13px;font-weight:600;color:#dfe3e7" }, mc.name),
        h("div", { style: "flex:1" }),
        h("div", { style: "display:flex;gap:4px" },
          h("button", { style: "width:26px;height:26px;border-radius:7px;border:1px solid rgba(255,255,255,0.1);background:rgba(255,255,255,0.04);display:flex;align-items:center;justify-content:center;cursor:pointer" }, icon("chevron-up", 14, 0.7)),
          h("button", { style: "width:26px;height:26px;border-radius:7px;border:1px solid rgba(255,255,255,0.1);background:rgba(255,255,255,0.04);display:flex;align-items:center;justify-content:center;cursor:pointer" }, icon("chevron-down", 14, 0.7)))),
      h("div", { style: "font-size:14.5px;font-weight:600;color:#f3f5f7;line-height:1.25;margin-bottom:2px" }, mp.title),
      h("div", { style: "font-family:'JetBrains Mono',monospace;font-size:11px;color:#7e858c" }, mp.filler ? "" : fmtClock(mp.start) + " – " + fmtClock(mp.end)),
      h("div", { style: "margin-top:10px;padding-top:9px;border-top:1px solid rgba(255,255,255,0.07);display:flex;align-items:center;gap:8px" },
        h("span", { style: "font-size:9.5px;font-weight:700;letter-spacing:.12em;color:#5c6166" }, "UP NEXT"),
        h("span", { style: "font-size:12.5px;color:#aeb4ba;white-space:nowrap;overflow:hidden;text-overflow:ellipsis" }, next.title))));
}

// ===== MOSAIC =====
function mosaicScreen() {
  const d = state.data;
  const visible = d.channels.filter((c) => !c.isHidden);
  const n = state.mosaicLayout === "2x2" ? 4 : 9;
  const cols = state.mosaicLayout === "2x2" ? 2 : 3;
  const tiles = visible.slice(0, n);
  const seg = (on) => ({ display: "flex", alignItems: "center", height: "30px", padding: "0 14px", borderRadius: "8px", border: "none", background: on ? AC : "transparent", color: on ? "#06121c" : "#aeb4ba", fontSize: "13px", fontWeight: 600, cursor: "pointer", transition: "all .15s" });

  return h("div", { style: "flex:1;display:flex;flex-direction:column;min-height:0" },
    h("div", { style: "flex:none;display:flex;align-items:flex-end;justify-content:space-between;padding:18px 24px 14px" },
      h("div", null,
        h("div", { style: "font-size:23px;font-weight:700;letter-spacing:-.01em" }, "Mosaic"),
        h("div", { style: "font-size:13px;color:#7e858c;margin-top:3px" }, `${tiles.length} live tiles · one audio-active`)),
      h("div", { style: "display:flex;padding:3px;background:rgba(255,255,255,0.05);border:1px solid rgba(255,255,255,0.08);border-radius:10px;gap:2px" },
        h("button", { style: seg(state.mosaicLayout === "2x2"), onClick: () => set({ mosaicLayout: "2x2" }) }, "2×2"),
        h("button", { style: seg(state.mosaicLayout === "3x3"), onClick: () => set({ mosaicLayout: "3x3" }) }, "3×3"))),
    h("div", { style: "flex:1;min-height:0;padding:6px 24px 24px" },
      h("div", { style: { display: "grid", gridTemplateColumns: `repeat(${cols},1fr)`, gap: "14px", width: "100%", height: "100%" } },
        ...tiles.map((c, i) => mosaicTile(c, i)))));
}

function mosaicTile(c, i) {
  const id = "t" + i;
  const active = state.activeTileId === id;
  const on = onNowProgram(c);
  const big = state.mosaicLayout === "2x2" ? 72 : 48;
  return h("div", { style: { position: "relative", borderRadius: "14px", overflow: "hidden", cursor: "pointer", border: "1px solid " + (active ? AC : "rgba(255,255,255,0.09)"), boxShadow: active ? "0 0 0 1px " + AC + ", 0 0 30px rgba(84,182,255,0.28)" : "0 8px 24px rgba(0,0,0,0.35)", minHeight: 0, transition: "border-color .15s, box-shadow .15s" }, onClick: () => openPlayer(c.id) },
    h("div", { style: { position: "absolute", inset: 0, background: c.grad } }),
    h("div", { style: { position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center", fontSize: big + "px", fontWeight: 800, color: "rgba(255,255,255,0.14)", letterSpacing: ".04em" } }, c.mono),
    c.logoUrl ? h("img", { src: c.logoUrl, loading: "lazy", style: "position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);max-width:42%;max-height:42%;object-fit:contain;z-index:1;filter:drop-shadow(0 2px 10px rgba(0,0,0,0.6))", onError: (e) => e.target.remove() }) : null,
    tileVideo("mosaic:" + i, c.id, !active), // live video; only the active tile has audio
    h("div", { style: "position:absolute;top:10px;left:11px;z-index:2;display:flex;align-items:center;gap:5px;padding:3px 8px;background:rgba(8,10,12,0.6);border-radius:7px;backdrop-filter:blur(4px)" },
      h("span", { style: "width:6px;height:6px;border-radius:50%;background:#ff5d52;box-shadow:0 0 7px #ff5d52;animation:aerBlink 2s infinite" }),
      h("span", { style: "font-size:9.5px;font-weight:700;letter-spacing:.12em" }, "LIVE")),
    h("button", { style: { position: "absolute", top: "10px", right: "11px", width: "34px", height: "34px", borderRadius: "9px", border: "1px solid " + (active ? AC : "rgba(255,255,255,0.14)"), background: active ? AC : "rgba(8,10,12,0.55)", backdropFilter: "blur(4px)", display: "flex", alignItems: "center", justifyContent: "center", cursor: "pointer", zIndex: 3 }, onClick: (e) => { e.stopPropagation(); set({ activeTileId: id }); } },
      h("div", { style: { width: "16px", height: "16px", backgroundImage: `url(${ICON(active ? "volume-2" : "volume-x")})`, backgroundSize: "contain", backgroundRepeat: "no-repeat", backgroundPosition: "center", filter: active ? "brightness(0) invert(.05)" : "brightness(0) invert(.85)" } })),
    h("div", { style: "position:absolute;left:0;right:0;bottom:0;z-index:2;padding:14px 13px 12px;background:linear-gradient(180deg,rgba(8,10,12,0),rgba(8,10,12,0.88));display:flex;align-items:flex-end;gap:10px" },
      h("div", { style: "min-width:0;flex:1" },
        h("div", { style: "display:flex;align-items:center;gap:7px;margin-bottom:2px" },
          h("span", { style: { fontFamily: "'JetBrains Mono',monospace", fontSize: "11.5px", fontWeight: 600, color: c.color } }, "#" + (c.num ?? "—")),
          h("span", { style: "font-size:13px;font-weight:600;color:#eef0f2" }, c.name)),
        h("div", { style: "font-size:13px;color:#b4bac0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis" }, on.title)),
      h("div", { style: "width:30px;height:30px;flex:none;border-radius:8px;border:1px solid rgba(255,255,255,0.14);background:rgba(8,10,12,0.5);display:flex;align-items:center;justify-content:center" }, icon("maximize-2", 13, 0.85))));
}

function promoteOverlay() {
  if (!state.promotedTileId) return null;
  const d = state.data;
  const visible = d.channels.filter((c) => !c.isHidden);
  const i = Number(state.promotedTileId.slice(1));
  const c = visible[i];
  if (!c) return null;
  const on = onNowProgram(c);
  return h("div", { style: "position:fixed;inset:0;z-index:50;background:rgba(6,7,8,0.86);backdrop-filter:blur(8px);display:flex;align-items:center;justify-content:center;animation:aerPop .22s ease;padding:40px", onClick: () => set({ promotedTileId: null }) },
    h("div", { style: "width:min(1180px,92vw);aspect-ratio:16/9;border-radius:16px;overflow:hidden;position:relative;border:1px solid rgba(255,255,255,0.1);box-shadow:0 40px 120px rgba(0,0,0,0.7)" },
      h("div", { style: { position: "absolute", inset: 0, background: c.grad } }),
      h("div", { style: "position:absolute;inset:0;display:flex;align-items:center;justify-content:center;font-size:160px;font-weight:800;color:rgba(255,255,255,0.1);letter-spacing:.04em" }, c.mono),
      h("div", { style: "position:absolute;top:18px;left:20px;display:flex;align-items:center;gap:9px;padding:6px 12px;background:rgba(8,10,12,0.6);border-radius:9px;backdrop-filter:blur(6px)" },
        h("span", { style: "width:7px;height:7px;border-radius:50%;background:#ff5d52;box-shadow:0 0 8px #ff5d52;animation:aerBlink 2s infinite" }),
        h("span", { style: "font-size:11px;font-weight:700;letter-spacing:.12em" }, "LIVE")),
      h("div", { style: "position:absolute;left:0;right:0;bottom:0;padding:40px 26px 24px;background:linear-gradient(180deg,rgba(8,10,12,0),rgba(8,10,12,0.9))" },
        h("div", { style: "display:flex;align-items:center;gap:11px;margin-bottom:6px" },
          h("span", { style: { fontFamily: "'JetBrains Mono',monospace", fontSize: "16px", fontWeight: 600, color: c.color } }, "#" + (c.num ?? "—")),
          h("span", { style: "font-size:20px;font-weight:700;color:#f3f5f7" }, c.name)),
        h("div", { style: "font-size:15px;color:#b4bac0" }, on.title))));
}

// ===== CHANNEL MANAGER =====
function managerScreen() {
  const d = state.data;
  const rows = d.channels;
  const selCount = Object.values(state.selectedRows).filter(Boolean).length;
  const anySel = selCount > 0;
  const allSel = rows.length > 0 && rows.every((r) => state.selectedRows[r.id]);
  const liveCount = rows.filter((r) => r.health === "live").length;
  const deadCount = rows.filter((r) => r.health === "dead").length;

  const header = h("div", { style: "flex:none;display:flex;align-items:flex-end;justify-content:space-between;padding:18px 24px 14px" },
    h("div", null,
      h("div", { style: "font-size:23px;font-weight:700;letter-spacing:-.01em" }, "Channel Manager"),
      h("div", { style: "font-size:13px;color:#7e858c;margin-top:3px" }, `${rows.length} channels · ${liveCount} live · ${deadCount} dead`)),
    h("div", { style: "display:flex;gap:8px;align-items:center" },
      h("div", { style: "display:flex;align-items:center;gap:8px;height:34px;padding:0 12px;background:rgba(255,255,255,0.04);border:1px solid rgba(255,255,255,0.08);border-radius:8px;color:#7e858c" },
        h("img", { src: ICON("search"), style: "width:14px;height:14px;filter:brightness(0) invert(.55)" }),
        h("span", { style: "font-size:12.5px" }, "Filter channels")),
      h("button", { style: "height:34px;padding:0 14px;border-radius:8px;border:1px solid rgba(84,182,255,0.4);background:rgba(84,182,255,0.12);color:#9bd0ff;font-size:12.5px;font-weight:600;cursor:pointer", onClick: openAddSource }, "Add source")));

  const bulkBar = h("div", { style: { display: anySel ? "flex" : "none", alignItems: "center", gap: "10px", margin: "0 24px 12px", padding: "0 14px", height: "46px", borderRadius: "11px", background: "rgba(84,182,255,0.08)", border: "1px solid rgba(84,182,255,0.25)", animation: "aerFadeUp .2s ease" } },
    h("span", { style: "font-size:13px;font-weight:600;color:#9bd0ff" }, `${selCount} selected`),
    h("div", { style: "width:1px;height:18px;background:rgba(255,255,255,0.12)" }),
    h("button", { style: bulkBtn(), onClick: bulkHide }, icon("eye-off", 14, 0.8), "Hide"),
    h("button", { style: bulkBtn() }, icon("pencil", 13, 0.8), "Rename"),
    h("button", { style: bulkBtn() }, icon("git-merge", 13, 0.8), "Merge"),
    h("div", { style: "flex:1" }),
    h("button", { style: "height:30px;padding:0 12px;border-radius:7px;border:1px solid transparent;background:transparent;color:#9aa0a6;font-size:12.5px;font-weight:600;cursor:pointer", onClick: () => set({ selectedRows: {} }) }, "Clear"));

  const tableHeader = h("div", { style: "display:flex;align-items:center;height:38px;position:sticky;top:0;z-index:4;background:rgba(20,22,24,0.96);backdrop-filter:blur(10px);border-bottom:1px solid rgba(255,255,255,0.08);font-size:10.5px;font-weight:600;letter-spacing:.1em;color:#6b7178" },
    h("div", { style: "width:42px;flex:none;display:flex;align-items:center;justify-content:center" }, checkbox(allSel, toggleAll)),
    h("div", { style: "width:30px;flex:none" }),
    h("div", { style: "width:62px;flex:none" }, "#"),
    h("div", { style: "width:42px;flex:none" }),
    h("div", { style: "flex:1;min-width:0" }, "NAME"),
    h("div", { style: "width:120px;flex:none" }, "HEALTH"),
    h("div", { style: "width:96px;flex:none" }, "SOURCES"),
    h("div", { style: "width:120px;flex:none" }, "UPDATED"),
    h("div", { style: "width:48px;flex:none" }));

  // Virtualized body — render only the visible window of rows (handles 6k+ rows).
  const ROW_H = 40;
  const bodyInner = h("div", { style: { position: "relative", height: rows.length * ROW_H + "px" } });
  const scroller = h("div", { style: { flex: "1", minHeight: 0, overflow: "auto", margin: "0 24px 24px", border: "1px solid rgba(255,255,255,0.08)", borderRadius: "12px", background: "rgba(255,255,255,0.015)" } }, tableHeader, bodyInner);

  let lastStart = -1, lastEnd = -1, scrollRaf = 0;
  const renderSlice = () => {
    const st = scroller.scrollTop;
    const vh = scroller.clientHeight || 800;
    const start = Math.max(0, Math.floor(st / ROW_H) - 8);
    const end = Math.min(rows.length, Math.ceil((st + vh) / ROW_H) + 8);
    if (start === lastStart && end === lastEnd) return;
    lastStart = start;
    lastEnd = end;
    const slice = [];
    for (let i = start; i < end; i++) {
      const el = managerRow(rows[i], i);
      el.style.position = "absolute";
      el.style.top = i * ROW_H + "px";
      el.style.left = "0";
      el.style.right = "0";
      slice.push(el);
    }
    bodyInner.replaceChildren(...slice);
  };
  scroller.addEventListener("scroll", () => {
    managerScrollTop = scroller.scrollTop;
    if (!scrollRaf) scrollRaf = requestAnimationFrame(() => { scrollRaf = 0; renderSlice(); });
  }, { passive: true });
  const applyScroll = () => { scroller.scrollTop = managerScrollTop; renderSlice(); };
  renderSlice(); // immediate so rows paint even where rAF is throttled
  requestAnimationFrame(applyScroll);
  setTimeout(applyScroll, 0);

  return h("div", { style: "flex:1;display:flex;flex-direction:column;min-height:0" }, header, bulkBar, scroller);
}

function bulkBtn() {
  return "height:30px;padding:0 12px;border-radius:7px;border:1px solid rgba(255,255,255,0.12);background:rgba(255,255,255,0.05);color:#dfe3e7;font-size:12.5px;font-weight:600;cursor:pointer;display:flex;align-items:center;gap:6px";
}
function checkbox(checked, onclick) {
  return h("div", { onClick: onclick, style: { width: "17px", height: "17px", borderRadius: "5px", border: "1px solid " + (checked ? AC : "rgba(255,255,255,0.2)"), background: checked ? AC : "transparent", display: "flex", alignItems: "center", justifyContent: "center", cursor: "pointer" } },
    h("img", { src: ICON("check"), style: { width: "12px", height: "12px", filter: "brightness(0) invert(.05)", opacity: checked ? 1 : 0 } }));
}

function managerRow(r, idx) {
  const checked = !!state.selectedRows[r.id];
  const hm = HEALTH[r.health] || HEALTH.dead;
  const row = h("div", {
    draggable: "true",
    onDragstart: (e) => { dragId = r.id; if (e.dataTransfer) e.dataTransfer.effectAllowed = "move"; },
    onDragover: (e) => e.preventDefault(),
    onDrop: (e) => {
      e.preventDefault();
      const arr = state.data.channels;
      const from = arr.findIndex((x) => x.id === dragId);
      if (from >= 0 && from !== idx) {
        const [m] = arr.splice(from, 1);
        arr.splice(idx, 0, m);
        render();
      }
    },
    style: { display: "flex", alignItems: "center", height: "40px", borderBottom: "1px solid rgba(255,255,255,0.045)", background: checked ? "rgba(84,182,255,0.07)" : idx % 2 ? "rgba(255,255,255,0.012)" : "transparent", transition: "background .12s" },
  },
    h("div", { style: "width:42px;flex:none;display:flex;align-items:center;justify-content:center" }, checkbox(checked, () => toggleRow(r.id))),
    h("div", { style: "width:30px;flex:none;display:flex;align-items:center;justify-content:center;cursor:grab" }, h("img", { src: ICON("grip-vertical"), style: "width:15px;height:15px;filter:brightness(0) invert(.4)" })),
    h("div", { style: "width:62px;flex:none;font-family:'JetBrains Mono',monospace;font-size:12.5px;color:#8b9197;font-weight:500" }, r.num ?? "—"),
    h("div", { style: "width:42px;flex:none" }, logoTile(r, 28, 9.5, 7)),
    h("div", { style: "flex:1;min-width:0;padding-right:12px" },
      h("input", { type: "text", value: r.name, onBlur: (e) => commitName(r, e.target.value),
        onFocus: (e) => { e.target.style.background = "rgba(255,255,255,0.05)"; e.target.style.borderColor = "rgba(255,255,255,0.12)"; },
        style: { width: "100%", background: "transparent", border: "1px solid transparent", borderRadius: "6px", padding: "5px 8px", color: "#e6e9ec", fontSize: "13.5px", fontWeight: 500, fontFamily: "inherit", outline: "none", transition: "background .12s, border-color .12s" } })),
    h("div", { style: "width:120px;flex:none" },
      h("span", { style: { display: "inline-flex", alignItems: "center", gap: "6px", height: "22px", padding: "0 9px", borderRadius: "6px", background: hm.bg, border: "1px solid " + hm.bd, color: hm.c, fontSize: "11.5px", fontWeight: 600 } },
        h("span", { style: { width: "6px", height: "6px", borderRadius: "50%", background: hm.c, boxShadow: "0 0 6px " + hm.c } }), hm.l)),
    h("div", { style: "width:96px;flex:none;display:flex;align-items:center;gap:7px" },
      h("span", { style: "font-family:'JetBrains Mono',monospace;font-size:12.5px;color:#aeb4ba" }, r.sources),
      h("span", { style: "font-size:11.5px;color:#5c6166" }, "src")),
    h("div", { style: "width:120px;flex:none;font-size:12px;color:#6b7178" }, r.updated),
    h("div", { style: "width:48px;flex:none;display:flex;align-items:center;justify-content:center" },
      h("button", { style: "width:26px;height:26px;border-radius:7px;border:1px solid transparent;background:transparent;display:flex;align-items:center;justify-content:center;cursor:pointer" }, h("img", { src: ICON("ellipsis"), style: "width:15px;height:15px;filter:brightness(0) invert(.5)" }))));
  return row;
}

function stubScreen() {
  const map = { home: ["house", "Home"], nowplaying: ["play", "Now Playing"], sources: ["database", "Sources"], rules: ["filter", "Rules Builder"], epg: ["git-compare", "EPG Matcher"] };
  const s = map[state.screen] || ["tv", "Screen"];
  return h("div", { style: "flex:1;display:flex;align-items:center;justify-content:center;flex-direction:column;gap:14px;color:#6b7178" },
    h("div", { style: "width:56px;height:56px;border-radius:16px;border:1px solid rgba(255,255,255,0.1);background:rgba(255,255,255,0.03);display:flex;align-items:center;justify-content:center" }, h("img", { src: ICON(s[0]), style: "width:24px;height:24px;filter:brightness(0) invert(.5)" })),
    h("div", { style: "font-size:17px;font-weight:600;color:#aeb4ba" }, s[1]),
    h("div", { style: "font-size:13px;color:#6b7178" }, "Coming in the next pass — system locked here first."));
}

// ===== SETTINGS =====
function saveSetting(key, value) {
  if (!state.settings) return;
  state.settings[key] = value; // optimistic
  render();
  fetch("/api/settings", { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ [key]: value }) })
    .then((r) => (r.ok ? r.json() : null))
    .then((s) => { if (s) { state.settings = s.settings; state.envLocked = s.envLocked || []; render(); } })
    .catch(() => {});
}

function toggleSwitch(on, onClick, disabled) {
  return h("button", {
    onClick: disabled ? () => {} : onClick,
    title: disabled ? "Locked by an environment variable" : "",
    style: { width: "44px", height: "26px", borderRadius: "13px", border: "none", position: "relative", flex: "none", cursor: disabled ? "not-allowed" : "pointer", background: on ? AC : "rgba(255,255,255,0.14)", opacity: disabled ? 0.5 : 1, transition: "background .15s" },
  }, h("span", { style: { position: "absolute", top: "3px", left: on ? "21px" : "3px", width: "20px", height: "20px", borderRadius: "50%", background: "#fff", transition: "left .15s", boxShadow: "0 1px 3px rgba(0,0,0,0.4)" } }));
}

function settingRow(o) {
  const s = state.settings;
  const locked = state.envLocked.includes(o.key);
  let control;
  if (o.type === "toggle") {
    control = toggleSwitch(!!s[o.key], () => saveSetting(o.key, !s[o.key]), locked);
  } else {
    control = h("input", {
      type: o.type === "number" ? "number" : "text",
      value: s[o.key], disabled: locked,
      onBlur: (e) => saveSetting(o.key, o.type === "number" ? Number(e.target.value) : e.target.value),
      style: { width: o.type === "number" ? "92px" : "300px", height: "34px", background: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.1)", borderRadius: "8px", padding: "0 11px", color: "#e6e9ec", fontSize: "13px", fontFamily: "inherit", outline: "none", opacity: locked ? 0.5 : 1 },
    });
  }
  return h("div", { style: "display:flex;align-items:center;gap:16px;padding:14px 16px;border-bottom:1px solid rgba(255,255,255,0.045)" },
    h("div", { style: "flex:1;min-width:0" },
      h("div", { style: "display:flex;align-items:center;gap:8px" },
        h("span", { style: "font-size:14px;font-weight:600;color:#e6e9ec" }, o.title),
        locked ? h("span", { style: "font-size:9px;font-weight:600;letter-spacing:.1em;color:#f4b740;border:1px solid rgba(244,183,64,0.4);border-radius:5px;padding:2px 5px" }, "ENV") : null),
      h("div", { style: "font-size:12.5px;color:#7e858c;margin-top:3px" }, o.desc)),
    o.suffix ? h("span", { style: "font-size:12.5px;color:#7e858c" }, o.suffix) : null,
    control);
}

function settingsSection(title, ...rows) {
  return h("div", { style: "margin-bottom:22px;border:1px solid rgba(255,255,255,0.08);border-radius:12px;overflow:hidden;background:rgba(255,255,255,0.015)" },
    h("div", { style: "padding:12px 16px;font-size:11px;font-weight:600;letter-spacing:.12em;color:#7e858c;border-bottom:1px solid rgba(255,255,255,0.06);background:rgba(255,255,255,0.02)" }, title),
    ...rows);
}

function settingsScreen() {
  if (!state.settings) return centered("Loading settings…");
  const s = state.settings;
  const dvrOn = !!s["features.dvr"];
  const tsOn = !!s["features.timeshift"];
  return h("div", { style: "flex:1;display:flex;flex-direction:column;min-height:0" },
    h("div", { style: "flex:none;padding:18px 24px 14px" },
      h("div", { style: "font-size:23px;font-weight:700;letter-spacing:-.01em" }, "Settings"),
      h("div", { style: "font-size:13px;color:#7e858c;margin-top:3px" }, "Enable only what you need — heavy features are off by default")),
    h("div", { style: "flex:1;min-height:0;overflow:auto;padding:0 24px 24px" },
      h("div", { style: "max-width:760px" },
        settingsSection("FEATURES",
          settingRow({ title: "HDHomeRun tuner", desc: "Expose Cathode as a tuner for Plex / Emby / Jellyfin.", key: "features.hdhr", type: "toggle" }),
          settingRow({ title: "Browser audio transcode", desc: "Convert AC-3 → AAC so those channels play in-browser (needs ffmpeg).", key: "features.transcode", type: "toggle" }),
          settingRow({ title: "EPG auto-refresh", desc: "Pull the guide on a schedule so it stays current.", key: "features.epgAutoRefresh", type: "toggle" }),
          settingRow({ title: "Health probing", desc: "Probe streams to show real Live / SD / Dead badges.", key: "features.healthProbe", type: "toggle" }),
          settingRow({ title: "Timeshift (pause / rewind)", desc: "Keep a rolling on-disk buffer so you can pause and rewind live TV.", key: "features.timeshift", type: "toggle" }),
          settingRow({ title: "DVR recordings", desc: "Record programs to disk and build a recordings library.", key: "features.dvr", type: "toggle" })),
        (dvrOn || tsOn)
          ? settingsSection("STORAGE & RETENTION",
              settingRow({ title: "Storage path", desc: "Where segments and recordings live on disk.", key: "dvr.storagePath", type: "text" }),
              tsOn ? settingRow({ title: "Timeshift window", desc: "How far back you can rewind live TV.", key: "timeshift.windowMinutes", type: "number", suffix: "min" }) : null,
              dvrOn ? settingRow({ title: "Recording retention", desc: "Auto-delete recordings older than this.", key: "dvr.retentionDays", type: "number", suffix: "days" }) : null,
              dvrOn ? settingRow({ title: "Max DVR size", desc: "Cap total recording storage.", key: "dvr.maxGB", type: "number", suffix: "GB" }) : null,
              dvrOn ? settingRow({ title: "Max concurrent recordings", desc: "How many programs can record at once.", key: "dvr.maxConcurrentRecordings", type: "number" }) : null)
          : null,
        settingsSection("STREAMING",
          settingRow({ title: "Keep stream warm", desc: "Hold a channel's upstream this long after the last viewer leaves, so re-tuning is instant. Higher values keep a tuner slot in use longer.", key: "stream.keepWarmSeconds", type: "number", suffix: "sec" })),
        settingsSection("VPN",
          settingRow({ title: "VPN proxy URL", desc: "HTTP or SOCKS proxy (e.g. http://gluetun:8888 or socks5://gluetun:1080). Providers with VPN toggled on route their stream, EPG, and sync traffic through it. Leave blank to disable.", key: "vpn.proxyUrl", type: "text" })),
        settingsSection("GUIDE",
          settingRow({ title: "EPG refresh interval", desc: "How often auto-refresh pulls new EPG.", key: "epg.refreshHours", type: "number", suffix: "hours" })))));
}

// ===== ADD SOURCE (provider) modal =====
function sourceModal() {
  if (!state.addOpen) return null;
  const f = state.addForm;
  const isXtream = f.type === "xtream";

  const labelStyle = "font-size:11px;font-weight:600;letter-spacing:.08em;color:#7e858c;margin-bottom:6px;display:block";
  const inputStyle = {
    width: "100%", height: "38px", background: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.1)",
    borderRadius: "9px", padding: "0 12px", color: "#e6e9ec", fontSize: "13.5px", fontFamily: "inherit", outline: "none",
  };
  // Inputs are uncontrolled re: render — they write straight to state.addForm on
  // input (no re-render), so typing never loses focus. Re-render only on
  // structural changes (type toggle, busy, error).
  const field = (label, key, placeholder, type) =>
    h("div", { style: "margin-bottom:13px" },
      h("label", { style: labelStyle }, label),
      h("input", {
        type: type || "text", value: f[key], placeholder: placeholder || "",
        onInput: (e) => { f[key] = type === "number" ? Number(e.target.value) : e.target.value; },
        onFocus: (e) => (e.target.style.borderColor = "rgba(84,182,255,0.5)"),
        onBlur: (e) => (e.target.style.borderColor = "rgba(255,255,255,0.1)"),
        style: inputStyle,
      }));

  const typeBtn = (val, label) =>
    h("button", {
      onClick: () => { f.type = val; render(); },
      style: {
        flex: 1, height: "34px", borderRadius: "8px", border: "none", cursor: "pointer", fontSize: "13px", fontWeight: 600, fontFamily: "inherit",
        background: f.type === val ? AC : "transparent", color: f.type === val ? "#06121c" : "#aeb4ba", transition: "all .15s",
      },
    }, label);

  return h("div", { style: "position:fixed;inset:0;z-index:60;background:rgba(6,7,8,0.78);backdrop-filter:blur(8px);display:flex;align-items:center;justify-content:center;animation:aerPop .2s ease;padding:24px", onClick: closeAddSource },
    h("div", { style: "width:min(460px,94vw);max-height:90vh;overflow:auto;border-radius:16px;background:rgba(20,22,24,0.96);border:1px solid rgba(255,255,255,0.1);box-shadow:0 40px 120px rgba(0,0,0,0.6)", onClick: (e) => e.stopPropagation() },
      // header
      h("div", { style: "padding:20px 22px 14px;border-bottom:1px solid rgba(255,255,255,0.07);display:flex;align-items:center;gap:12px" },
        h("div", { style: "width:36px;height:36px;border-radius:10px;background:linear-gradient(140deg,#54b6ff,#2a78c2);display:flex;align-items:center;justify-content:center" }, icon("database", 17, 0.05)),
        h("div", { style: "flex:1" },
          h("div", { style: "font-size:16px;font-weight:700" }, "Add source"),
          h("div", { style: "font-size:12px;color:#7e858c;margin-top:2px" }, "Xtream Codes panel or M3U playlist")),
        h("button", { style: "width:30px;height:30px;border-radius:8px;border:1px solid rgba(255,255,255,0.1);background:rgba(255,255,255,0.04);display:flex;align-items:center;justify-content:center;cursor:pointer", onClick: closeAddSource }, icon("x", 15, 0.7))),
      // body
      h("div", { style: "padding:18px 22px" },
        // type switch
        h("div", { style: "display:flex;padding:3px;background:rgba(255,255,255,0.05);border:1px solid rgba(255,255,255,0.08);border-radius:10px;gap:3px;margin-bottom:16px" },
          typeBtn("xtream", "Xtream Codes"), typeBtn("m3u", "M3U Playlist")),
        field("NAME", "name", "e.g. EU Premium"),
        field(isXtream ? "SERVER URL" : "PLAYLIST URL", "url", isXtream ? "http://panel.example.com:8080" : "http://example.com/list.m3u"),
        isXtream ? field("USERNAME", "username", "username") : null,
        isXtream ? field("PASSWORD", "password", "password", "password") : null,
        h("div", { style: "display:flex;gap:12px" },
          h("div", { style: "width:130px" }, field("MAX STREAMS", "maxConnections", "4", "number")),
          h("div", { style: "flex:1" }, field("EPG URL (OPTIONAL)", "epgUrl", "xmltv.php?…"))),
        // VPN toggle
        h("div", { onClick: () => { f.viaVpn = !f.viaVpn; render(); }, style: "display:flex;align-items:center;gap:11px;padding:11px 13px;border-radius:10px;border:1px solid " + (f.viaVpn ? "rgba(127,220,160,0.4)" : "rgba(255,255,255,0.1)") + ";background:" + (f.viaVpn ? "rgba(127,220,160,0.08)" : "rgba(255,255,255,0.03)") + ";cursor:pointer" },
          h("div", { style: "width:44px;height:25px;flex:none;border-radius:13px;background:" + (f.viaVpn ? "#7fdca0" : "rgba(255,255,255,0.14)") + ";position:relative;transition:background .15s" },
            h("div", { style: "position:absolute;top:2px;left:" + (f.viaVpn ? "21px" : "2px") + ";width:21px;height:21px;border-radius:50%;background:#fff;transition:left .15s" })),
          h("div", { style: "flex:1" },
            h("div", { style: "font-size:13px;font-weight:600;color:#dfe3e7" }, "Route through VPN proxy"),
            h("div", { style: "font-size:11.5px;color:#7e858c;margin-top:1px" }, vpnConfigured() ? "Stream + EPG + sync egress via your configured proxy." : "Set the VPN proxy URL in Settings to use this."))),
        state.addError ? h("div", { style: "margin-top:13px;padding:10px 12px;border-radius:9px;background:rgba(255,93,82,0.12);border:1px solid rgba(255,93,82,0.3);color:#ff8d85;font-size:12.5px" }, state.addError) : null),
      // footer
      h("div", { style: "padding:14px 22px 20px;display:flex;gap:10px;justify-content:flex-end;border-top:1px solid rgba(255,255,255,0.07)" },
        h("button", { style: "height:38px;padding:0 16px;border-radius:9px;border:1px solid rgba(255,255,255,0.12);background:rgba(255,255,255,0.04);color:#dfe3e7;font-size:13px;font-weight:600;cursor:pointer", onClick: closeAddSource }, "Cancel"),
        h("button", {
          style: { height: "38px", padding: "0 18px", borderRadius: "9px", border: "none", background: AC, color: "#06121c", fontSize: "13px", fontWeight: 700, fontFamily: "inherit", cursor: state.addBusy ? "default" : "pointer", opacity: state.addBusy ? 0.7 : 1, display: "flex", alignItems: "center", gap: "8px" },
          onClick: state.addBusy ? () => {} : submitAddSource,
        }, state.addBusy ? "Connecting & importing…" : "Add & import"))));
}

function openAddSource() {
  state.addForm = { name: "", type: "xtream", url: "", username: "", password: "", maxConnections: 4, epgUrl: "", viaVpn: false };
  set({ addOpen: true, addError: null, addBusy: false });
}
function closeAddSource() {
  if (state.addBusy) return;
  set({ addOpen: false, addError: null });
}
async function submitAddSource() {
  const f = state.addForm;
  if (!f.name.trim()) return set({ addError: "Give the source a name." });
  if (!f.url.trim()) return set({ addError: "A URL is required." });
  if (f.type === "xtream" && (!f.username.trim() || !f.password.trim()))
    return set({ addError: "Xtream needs a username and password." });

  set({ addBusy: true, addError: null });
  try {
    const body = {
      name: f.name.trim(), type: f.type, url: f.url.trim(),
      username: f.type === "xtream" ? f.username.trim() : null,
      password: f.type === "xtream" ? f.password.trim() : null,
      maxConnections: Number(f.maxConnections) || 1,
      epgUrl: f.epgUrl.trim() || null,
      viaVpn: !!f.viaVpn,
    };
    const res = await fetch("/api/providers", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    if (!res.ok) throw new Error(`couldn't save source (${res.status})`);
    const prov = await res.json();

    // Ingest + canonical-match the lineup.
    const syncRes = await fetch(`/api/providers/${prov.id}/sync`, { method: "POST" });
    if (!syncRes.ok) {
      const txt = await syncRes.text().catch(() => "");
      throw new Error(`source saved, but import failed: ${txt || syncRes.status}`);
    }
    // Auto-pull EPG for this provider — explicit epgUrl wins, else the server
    // derives the Xtream xmltv.php feed. M3U without an epgUrl simply no-ops.
    await fetch("/api/epg/sync", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body.epgUrl ? { urls: [body.epgUrl] } : { providerId: prov.id }),
    }).catch(() => {});

    state.addOpen = false;
    state.addBusy = false;
    await loadView();
  } catch (e) {
    set({ addBusy: false, addError: String(e.message || e) });
  }
}

// ===== ANALYTICS =====
function fmtDuration(secs) {
  secs = Math.round(secs || 0);
  const h = Math.floor(secs / 3600), m = Math.floor((secs % 3600) / 60);
  if (h) return h + "h " + m + "m";
  if (m) return m + "m";
  return secs + "s";
}
function fmtAgo(ms) {
  const m = Math.floor((Date.now() - ms) / 60000);
  if (m < 1) return "just now";
  if (m < 60) return m + "m ago";
  const h = Math.floor(m / 60);
  if (h < 24) return h + "h ago";
  return Math.floor(h / 24) + "d ago";
}
function analyticsChan(row) {
  const genre = toGenre(row.category);
  return { name: row.name, logoUrl: row.logo, num: row.num, mono: initials(row.name || "?"), grad: GRADS[genre], color: SOLIDS[genre] };
}
function kpiCard(label, value, sub) {
  return h("div", { style: "flex:1;min-width:0;padding:16px 18px;border:1px solid rgba(255,255,255,0.08);border-radius:12px;background:rgba(255,255,255,0.015)" },
    h("div", { style: "font-size:11px;font-weight:600;letter-spacing:.1em;color:#7e858c" }, label),
    h("div", { style: "font-size:26px;font-weight:700;color:#f3f5f7;margin-top:8px;letter-spacing:-.01em" }, value),
    sub ? h("div", { style: "font-size:12px;color:#6b7178;margin-top:3px" }, sub) : null);
}
function panel(title, body, right) {
  return h("div", { style: "border:1px solid rgba(255,255,255,0.08);border-radius:12px;background:rgba(255,255,255,0.015);overflow:hidden" },
    h("div", { style: "padding:13px 16px;display:flex;align-items:center;justify-content:space-between;border-bottom:1px solid rgba(255,255,255,0.06)" },
      h("span", { style: "font-size:12px;font-weight:600;letter-spacing:.1em;color:#aeb4ba" }, title),
      right || null),
    body);
}

function analyticsScreen() {
  const a = state.analytics;
  if (!a) return centered("Loading analytics…");
  const live = state.statusLive;
  const activeStreams = live ? live.active : [];
  const cbi = (state.data && state.data.channelsById) || {};

  // 14-day chart
  const maxSecs = Math.max(1, ...a.byDay.map((d) => d.secs));
  const chart = h("div", { style: "display:flex;align-items:flex-end;gap:6px;height:120px;padding:14px 16px" },
    ...a.byDay.map((d) => {
      const hPct = Math.round((d.secs / maxSecs) * 100);
      const dt = new Date(d.ts);
      return h("div", { style: "flex:1;display:flex;flex-direction:column;align-items:center;gap:6px;height:100%", title: fmtDuration(d.secs) },
        h("div", { style: "flex:1;width:100%;display:flex;align-items:flex-end" },
          h("div", { style: { width: "100%", height: Math.max(2, hPct) + "%", background: d.secs ? "linear-gradient(180deg," + AC + ",#2a78c2)" : "rgba(255,255,255,0.05)", borderRadius: "4px 4px 0 0", minHeight: "2px" } })),
        h("div", { style: "font-size:9.5px;color:#5c6166;font-family:'JetBrains Mono',monospace" }, dt.getDate()));
    }));

  // now streaming
  const nowStreaming = activeStreams.length
    ? h("div", { class: "aer-stagger", style: "padding:8px 8px 12px" },
        ...activeStreams.map((s) => {
          const ch = cbi[s.channelId] || { name: "Channel " + s.channelId, mono: "?", grad: GRADS.general, color: SOLIDS.general };
          return h("div", { style: "display:flex;align-items:center;gap:12px;padding:8px 8px" },
            logoTile(ch, 34, 11, 8),
            h("div", { style: "flex:1;min-width:0" },
              h("div", { style: "font-size:13.5px;font-weight:600;color:#e6e9ec;white-space:nowrap;overflow:hidden;text-overflow:ellipsis" }, ch.name),
              h("div", { style: "font-size:11.5px;color:#7e858c" }, s.viewers + " viewer" + (s.viewers === 1 ? "" : "s") + " · provider " + s.providerId)),
            h("span", { style: "font-size:9.5px;font-weight:700;letter-spacing:.12em;color:#2fae5c;border:1px solid rgba(47,174,92,0.4);border-radius:5px;padding:3px 7px" }, "LIVE"));
        }))
    : h("div", { style: "padding:22px 16px;text-align:center;color:#6b7178;font-size:13px" }, "Nothing streaming right now");

  // top channels
  const topMax = Math.max(1, ...a.topChannels.map((t) => t.secs));
  const topList = a.topChannels.length
    ? h("div", { class: "aer-stagger", style: "padding:6px 8px 10px" },
        ...a.topChannels.map((t) => {
          const ch = analyticsChan(t);
          return h("div", { style: "display:flex;align-items:center;gap:12px;padding:7px 8px" },
            logoTile(ch, 32, 10, 8),
            h("div", { style: "flex:1;min-width:0" },
              h("div", { style: "font-size:13px;font-weight:600;color:#e6e9ec;white-space:nowrap;overflow:hidden;text-overflow:ellipsis" }, t.name),
              h("div", { style: "height:4px;border-radius:2px;background:rgba(255,255,255,0.06);margin-top:5px;overflow:hidden" },
                h("div", { style: { height: "100%", width: Math.round((t.secs / topMax) * 100) + "%", background: AC } }))),
            h("div", { style: "text-align:right;flex:none" },
              h("div", { style: "font-size:13px;font-weight:600;color:#dfe3e7;font-family:'JetBrains Mono',monospace" }, fmtDuration(t.secs)),
              h("div", { style: "font-size:11px;color:#6b7178" }, t.sessions + " session" + (t.sessions === 1 ? "" : "s"))));
        }))
    : h("div", { style: "padding:22px 16px;text-align:center;color:#6b7178;font-size:13px" }, "No watch history yet");

  // most-watched shows
  const showMax = Math.max(1, ...a.topShows.map((s) => s.secs));
  const showsList = a.topShows.length
    ? h("div", { class: "aer-stagger", style: "padding:6px 8px 10px" },
        ...a.topShows.map((s) => {
          const col = SOLIDS[toGenre(s.category)];
          return h("div", { style: "display:flex;align-items:center;gap:12px;padding:7px 8px" },
            h("span", { style: { width: "8px", height: "8px", flex: "none", borderRadius: "50%", background: col, boxShadow: "0 0 6px " + col } }),
            h("div", { style: "flex:1;min-width:0" },
              h("div", { style: "font-size:13px;font-weight:600;color:#e6e9ec;white-space:nowrap;overflow:hidden;text-overflow:ellipsis" }, s.title),
              h("div", { style: "height:4px;border-radius:2px;background:rgba(255,255,255,0.06);margin-top:5px;overflow:hidden" },
                h("div", { style: { height: "100%", width: Math.round((s.secs / showMax) * 100) + "%", background: col } }))),
            h("div", { style: "text-align:right;flex:none" },
              h("div", { style: "font-size:13px;font-weight:600;color:#dfe3e7;font-family:'JetBrains Mono',monospace" }, fmtDuration(s.secs)),
              h("div", { style: "font-size:11px;color:#6b7178" }, s.sessions + "×")));
        }))
    : h("div", { style: "padding:22px 16px;text-align:center;color:#6b7178;font-size:13px" }, "No show data yet — needs EPG-matched channels");

  // recent
  const recentList = a.recent.length
    ? h("div", { class: "aer-stagger", style: "padding:6px 8px 10px" },
        ...a.recent.map((r) => {
          const ch = analyticsChan(r);
          return h("div", { style: "display:flex;align-items:center;gap:12px;padding:7px 8px" },
            logoTile(ch, 32, 10, 7),
            h("div", { style: "flex:1;min-width:0" },
              h("div", { style: "font-size:13px;font-weight:600;color:#e6e9ec;white-space:nowrap;overflow:hidden;text-overflow:ellipsis" }, r.program || r.name),
              h("div", { style: "font-size:11.5px;color:#7e858c;white-space:nowrap;overflow:hidden;text-overflow:ellipsis" }, (r.program ? r.name + " · " : "") + fmtAgo(r.started * 1000) + " · " + (r.source === "transcode" ? "transcoded" : "direct"))),
            h("span", { style: "font-size:12px;color:#aeb4ba;font-family:'JetBrains Mono',monospace;flex:none" }, fmtDuration(r.secs)));
        }))
    : h("div", { style: "padding:22px 16px;text-align:center;color:#6b7178;font-size:13px" }, "No recent activity");

  return h("div", { style: "flex:1;display:flex;flex-direction:column;min-height:0" },
    h("div", { style: "flex:none;display:flex;align-items:flex-end;justify-content:space-between;padding:18px 24px 14px" },
      h("div", null,
        h("div", { style: "font-size:23px;font-weight:700;letter-spacing:-.01em" }, "Analytics"),
        h("div", { style: "font-size:13px;color:#7e858c;margin-top:3px" }, fmtDuration(a.all.secs) + " watched all-time · " + a.all.sessions + " sessions")),
      h("button", { style: "height:34px;padding:0 14px;border-radius:8px;border:1px solid rgba(255,255,255,0.1);background:rgba(255,255,255,0.04);color:#dfe3e7;font-size:12.5px;font-weight:600;cursor:pointer;display:flex;align-items:center;gap:7px", onClick: loadAnalytics },
        icon("refresh-cw", 14, 0.7), "Refresh")),
    h("div", { style: "flex:1;min-height:0;overflow:auto;padding:0 24px 24px" },
      h("div", { style: "display:flex;gap:14px;margin-bottom:16px" },
        kpiCard("WATCH TIME TODAY", fmtDuration(a.today.secs), a.today.sessions + " sessions"),
        kpiCard("WATCH TIME · 7 DAYS", fmtDuration(a.week.secs), a.week.sessions + " sessions"),
        kpiCard("CHANNELS WATCHED · 7D", String(a.week.channels), "distinct channels"),
        kpiCard("NOW STREAMING", String(activeStreams.length), live ? live.totalFree + " tuner slots free" : "")),
      h("div", { style: "margin-bottom:16px" }, panel("WATCH TIME · LAST 14 DAYS", chart)),
      h("div", { style: "display:grid;grid-template-columns:1fr 1fr;gap:16px;margin-bottom:16px" },
        panel("MOST WATCHED CHANNELS · 7 DAYS", topList),
        panel("MOST WATCHED SHOWS · 7 DAYS", showsList)),
      h("div", { style: "display:grid;grid-template-columns:1fr 1fr;gap:16px" },
        panel("NOW STREAMING", nowStreaming),
        panel("RECENT ACTIVITY", recentList))));
}

// ===== root render =====
function mainArea() {
  if (state.loading) return centered("Loading lineup…");
  if (state.error) return centered("Couldn't reach the server: " + state.error);
  if (!state.data || state.data.channels.length === 0) return centered("No channels yet — add a provider and sync.");
  if (state.screen === "guide") return guideScreen();
  if (state.screen === "mosaic") return mosaicScreen();
  if (state.screen === "channels") return managerScreen();
  if (state.screen === "users") return usersScreen();
  if (state.screen === "sources") return sourcesScreen();
  if (state.screen === "rules") return rulesScreen();
  if (state.screen === "settings") return settingsScreen();
  if (state.screen === "analytics") return analyticsScreen();
  return stubScreen();
}
function centered(msg) {
  return h("div", { style: "flex:1;display:flex;align-items:center;justify-content:center;color:#6b7178;font-size:14px" }, msg);
}

// ===== auth =====
async function checkAuth() {
  try {
    const r = await fetch("/api/auth/me");
    const d = await r.json();
    state.auth = { user: d.user, needsSetup: !!d.needsSetup, checked: true };
  } catch {
    state.auth = { user: null, needsSetup: false, checked: true };
  }
  if (state.auth.user) loadView();
  else render();
}
async function submitAuth() {
  if (state.authBusy) return;
  state.authBusy = true; state.authError = null; render();
  const url = state.auth.needsSetup ? "/api/auth/register" : "/api/auth/login";
  try {
    const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(state.authForm) });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) { state.authError = d.error || "Something went wrong"; state.authBusy = false; render(); return; }
    state.auth = { user: d.user, needsSetup: false, checked: true };
    state.authBusy = false; state.authForm = { username: "", password: "" };
    state.screen = "guide"; state.mode = "watch";
    loadView();
  } catch (e) { state.authError = String(e); state.authBusy = false; render(); }
}
async function logoutUser() {
  try { await fetch("/api/auth/logout", { method: "POST" }); } catch { /* offline */ }
  destroyMpegts(); if (playerEl) { playerEl.remove(); playerEl = null; }
  destroyAllTiles();
  state.data = null; state.users = null;
  state.auth = { user: null, needsSetup: false, checked: true };
  render();
}

function authScreen() {
  const setup = state.auth.needsSetup;
  const field = (label, key, type) => h("div", { style: "display:flex;flex-direction:column;gap:6px" },
    h("label", { style: "font-size:12px;font-weight:600;color:#9aa0a6;letter-spacing:.02em" }, label),
    h("input", { type: type || "text", value: state.authForm[key] || "", autocomplete: type === "password" ? (setup ? "new-password" : "current-password") : "username",
      onInput: (e) => { state.authForm[key] = e.target.value; },
      onKeydown: (e) => { if (e.key === "Enter") submitAuth(); },
      style: "height:42px;padding:0 13px;border-radius:10px;border:1px solid rgba(255,255,255,0.12);background:rgba(255,255,255,0.05);color:#eef0f2;font-size:14px;font-family:inherit;outline:none" }));
  return h("div", { style: "height:100vh;display:flex;align-items:center;justify-content:center;background:radial-gradient(1200px 600px at 50% -10%,rgba(84,182,255,0.10),transparent),#0c0d0e" },
    h("div", { style: "width:360px;display:flex;flex-direction:column;gap:18px;padding:34px 30px;background:rgba(20,22,26,0.8);border:1px solid rgba(255,255,255,0.08);border-radius:18px;box-shadow:0 24px 60px rgba(0,0,0,0.5);backdrop-filter:blur(20px)" },
      h("div", { style: "display:flex;align-items:center;gap:11px" },
        h("div", { style: "width:34px;height:34px;border-radius:10px;background:linear-gradient(140deg,#54b6ff,#2a78c2);display:flex;align-items:center;justify-content:center;box-shadow:0 0 18px rgba(84,182,255,0.4)" },
          h("div", { style: "width:12px;height:12px;border:2.5px solid #07121c;border-radius:50%;border-bottom-color:transparent;border-right-color:transparent;transform:rotate(45deg)" })),
        h("div", { style: "font-weight:800;font-size:19px;letter-spacing:.16em" }, "AERIAL")),
      h("div", null,
        h("div", { style: "font-size:19px;font-weight:700;color:#fff" }, setup ? "Create your admin account" : "Sign in"),
        h("div", { style: "font-size:13px;color:#9aa0a6;margin-top:4px" }, setup ? "This first account is the administrator." : "Welcome back.")),
      field("Username", "username"),
      field("Password", "password", "password"),
      state.authError ? h("div", { style: "font-size:12.5px;color:#ff8077;background:rgba(255,93,82,0.1);border:1px solid rgba(255,93,82,0.3);border-radius:8px;padding:8px 11px" }, state.authError) : null,
      h("button", { onClick: submitAuth, disabled: state.authBusy,
        style: "height:44px;border-radius:11px;border:none;background:" + AC + ";color:#06121c;font-size:14.5px;font-weight:700;font-family:inherit;cursor:pointer;opacity:" + (state.authBusy ? ".6" : "1") },
        state.authBusy ? "…" : setup ? "Create admin & continue" : "Sign in")));
}

let lastRenderedScreen = null;
function render() {
  const root = document.getElementById("root");
  // Auth gate: until we know who's logged in, then the login/setup screen.
  if (!state.auth.checked) { root.replaceChildren(centered("…")); return; }
  if (!state.auth.user) { lastRenderedScreen = null; root.replaceChildren(authScreen()); return; }
  // Keep "now" live every render so the now-line/clock track real time even
  // when the cached guide snapshot is a few minutes old.
  if (state.data) state.data.now = Date.now();
  usedTileKeys = new Set();
  // Fade the main area only when the screen actually changes (not every render).
  const screenChanged = state.screen !== lastRenderedScreen;
  lastRenderedScreen = state.screen;
  const main = h("div", { style: "flex:1;min-width:0;display:flex;flex-direction:column;position:relative" + (screenChanged ? ";animation:aerViewIn .3s ease" : "") }, mainArea());
  root.replaceChildren(
    topBar(),
    h("div", { style: "flex:1;display:flex;min-height:0" }, leftRail(), main),
    promoteOverlay() || h("div", { style: "display:none" }),
    sourceModal() || h("div", { style: "display:none" }),
    shareModal() || h("div", { style: "display:none" }),
  );
  reconcileTiles(); // tear down any tile player no longer on screen
}

// ===== actions =====
function setMode(mode) {
  const isAdmin = state.auth.user && state.auth.user.role === "admin";
  if (mode === "manage" && !isAdmin) mode = "watch"; // Manage is admin-only
  set({ mode, screen: mode === "watch" ? "guide" : "channels", selectedCellId: null });
}
function setScreen(screen) {
  set({ screen });
  if (screen === "analytics") loadAnalytics();
  if (screen === "users") loadUsers();
  if (screen === "sources") loadSources();
  if (screen === "rules") loadRules();
}
// ===== users (admin) =====
async function loadUsers() {
  try {
    const r = await fetch("/api/users");
    if (r.ok) { state.users = await r.json(); render(); }
  } catch { /* ignore */ }
}
async function createUserSubmit() {
  const f = state.userNew;
  if (!f || state.userBusy) return;
  state.userBusy = true; state.userError = null; render();
  try {
    const r = await fetch("/api/auth/register", { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: f.username, password: f.password, role: f.role }) });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) { state.userError = d.error || "Couldn't create user"; state.userBusy = false; render(); return; }
    state.userBusy = false; state.userNew = null;
    await loadUsers();
  } catch (e) { state.userError = String(e); state.userBusy = false; render(); }
}
async function patchUser(id, body) {
  try {
    const r = await fetch("/api/users/" + id, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) { state.userError = d.error || "Update failed"; render(); return false; }
    state.userError = null;
    await loadUsers();
    return true;
  } catch (e) { state.userError = String(e); render(); return false; }
}
async function deleteUserAction(id, name) {
  if (!confirm("Delete user “" + name + "”? This can't be undone.")) return;
  try {
    const r = await fetch("/api/users/" + id, { method: "DELETE" });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) { state.userError = d.error || "Delete failed"; render(); return; }
    await loadUsers();
  } catch (e) { state.userError = String(e); render(); }
}
function openRestrictEditor(u) {
  const r = u.restrictions || { mode: "all", categories: [], networks: [], channelIds: [] };
  state.userEditId = u.id;
  state.userEditDraft = { mode: r.mode || "all", categories: [...(r.categories || [])], networks: [...(r.networks || [])], channelIds: [...(r.channelIds || [])] };
  render();
}
async function saveRestrictEditor() {
  const id = state.userEditId;
  const ok = await patchUser(id, { restrictions: state.userEditDraft });
  if (ok) { state.userEditId = null; state.userEditDraft = null; render(); }
}

// ===== sources (providers) =====
async function loadSources() {
  try { const r = await fetch("/api/providers"); if (r.ok) { state.providers = await r.json(); render(); } } catch { /* ignore */ }
}
async function syncProviderAction(id) {
  state.providerBusyId = id; render();
  try { await fetch("/api/providers/" + id + "/sync", { method: "POST" }); await loadView(); await loadSources(); }
  catch { /* ignore */ }
  state.providerBusyId = null; render();
}
async function toggleProvider(p) {
  await fetch("/api/providers/" + p.id, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ enabled: !p.enabled }) }).catch(() => {});
  await loadSources();
}
async function toggleProviderVpn(p) {
  await fetch("/api/providers/" + p.id, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ viaVpn: !p.viaVpn }) }).catch(() => {});
  await loadSources();
}
function vpnConfigured() { return !!(state.settings && String(state.settings["vpn.proxyUrl"] || "").trim()); }
async function deleteProvider(p) {
  if (!confirm("Remove “" + p.name + "”? Its channels/streams go with it (your other providers are untouched).")) return;
  await fetch("/api/providers/" + p.id, { method: "DELETE" }).catch(() => {});
  await loadView(); await loadSources();
}

// ===== rules =====
async function loadRules() {
  try { const r = await fetch("/api/rules"); if (r.ok) { state.rules = await r.json(); render(); } } catch { /* ignore */ }
}
async function createRuleSubmit() {
  const f = state.ruleNew;
  if (!f || state.ruleBusy) return;
  // Build {condition, action} from the friendly draft.
  const value = ["lt", "lte", "gt", "gte"].includes(f.op) ? Number(f.value) : f.value;
  const rule = {
    name: f.name || (f.actionSet === "isHidden" ? "Hide" : f.actionSet === "category" ? "Categorize" : "Rename") + " when " + f.field + " " + f.op + " " + f.value,
    type: f.actionSet === "isHidden" ? "hide" : f.actionSet === "category" ? "categorize" : "rename",
    condition: { field: f.field, op: f.op, value },
    action: { set: f.actionSet, value: f.actionSet === "isHidden" ? true : f.actionValue },
    priority: 100,
  };
  state.ruleBusy = true; state.ruleError = null; render();
  try {
    const r = await fetch("/api/rules", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(rule) });
    if (!r.ok) { const d = await r.json().catch(() => ({})); state.ruleError = d.error || "Couldn't save rule"; state.ruleBusy = false; render(); return; }
    state.ruleBusy = false; state.ruleNew = null;
    await loadRules();
  } catch (e) { state.ruleError = String(e); state.ruleBusy = false; render(); }
}
async function toggleRule(r) {
  await fetch("/api/rules/" + r.id, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ enabled: !r.enabled }) }).catch(() => {});
  await loadRules();
}
async function deleteRule(r) {
  await fetch("/api/rules/" + r.id, { method: "DELETE" }).catch(() => {});
  await loadRules();
}
async function applyRulesAction() {
  state.ruleApplyMsg = "Applying…"; render();
  try {
    const r = await fetch("/api/rules/apply", { method: "POST" });
    const d = await r.json().catch(() => ({}));
    state.ruleApplyMsg = r.ok ? `Applied ${d.applied} rule(s) · ${d.affected} channel(s) changed` : (d.error || "Failed");
    await loadView();
  } catch { state.ruleApplyMsg = "Failed"; }
  render();
}

// ===== share links (admin) =====
function shareUrl(token) { return location.origin + "/s/" + token; }
function openShareDialog(channelId) {
  state.shareFor = channelId;
  state.shareCreated = null;
  state.shareError = null;
  state.shareForm = { expiresInHours: 24, maxConcurrent: 2 };
  render();
  loadShares();
}
async function loadShares() {
  try { const r = await fetch("/api/shares"); if (r.ok) { state.sharesList = await r.json(); render(); } } catch { /* ignore */ }
}
async function createShareSubmit() {
  if (state.shareBusy) return;
  state.shareBusy = true; state.shareError = null; render();
  try {
    const r = await fetch("/api/shares", { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ channelId: state.shareFor, expiresInHours: state.shareForm.expiresInHours, maxConcurrent: state.shareForm.maxConcurrent }) });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) { state.shareError = d.error || "Couldn't create link"; state.shareBusy = false; render(); return; }
    state.shareCreated = d; state.shareBusy = false;
    await loadShares();
  } catch (e) { state.shareError = String(e); state.shareBusy = false; render(); }
}
async function revokeShareAction(id) {
  try { await fetch("/api/shares/" + id + "/revoke", { method: "POST" }); await loadShares(); } catch { /* ignore */ }
}
async function deleteShareAction(id) {
  try { await fetch("/api/shares/" + id, { method: "DELETE" }); await loadShares(); } catch { /* ignore */ }
}
function copyText(text, btn) {
  navigator.clipboard?.writeText(text).then(() => { if (btn) { const o = btn.textContent; btn.textContent = "Copied!"; setTimeout(() => { btn.textContent = o; }, 1400); } }).catch(() => {});
}

const NETWORK_LIST = ["ABC", "CBS", "NBC", "FOX", "Telemundo", "Univision", "UniMás", "Galavisión"];
function shareModal() {
  if (state.shareFor == null) return null;
  const ch = state.data && state.data.channelsById[state.shareFor];
  if (!ch) return null;
  const close = () => { state.shareFor = null; state.shareCreated = null; render(); };
  const created = state.shareCreated;
  const mine = (state.sharesList || []).filter((s) => s.channelId === state.shareFor);
  const f = state.shareForm;
  const presets = [[1, "1 hour"], [6, "6 hours"], [24, "24 hours"], [168, "7 days"]];
  const fmtLeft = (s) => {
    if (s.revoked) return "revoked"; if (s.expired) return "expired";
    const ms = new Date(s.expiresAt).getTime() - Date.now();
    const h = ms / 3600000;
    return h >= 24 ? Math.round(h / 24) + "d left" : h >= 1 ? Math.round(h) + "h left" : Math.max(1, Math.round(ms / 60000)) + "m left";
  };

  const chip = (active, label, onClick) => h("button", { onClick, style: "padding:7px 13px;border-radius:9px;cursor:pointer;font-family:inherit;font-size:13px;font-weight:600;border:1px solid " + (active ? AC : "rgba(255,255,255,0.12)") + ";background:" + (active ? "rgba(84,182,255,0.16)" : "rgba(255,255,255,0.04)") + ";color:" + (active ? "#cfe8ff" : "#c3c8cd") }, label);

  const card = h("div", { onClick: (e) => e.stopPropagation(), style: "width:480px;max-width:94vw;max-height:88vh;overflow:auto;background:#16181c;border:1px solid rgba(255,255,255,0.1);border-radius:18px;box-shadow:0 30px 70px rgba(0,0,0,0.6);display:flex;flex-direction:column" },
    h("div", { style: "padding:20px 22px 0;display:flex;align-items:flex-start;justify-content:space-between;gap:14px" },
      h("div", null,
        h("div", { style: "font-size:18px;font-weight:700;color:#fff" }, "Share link"),
        h("div", { style: "font-size:13px;color:#9aa0a6;margin-top:3px;display:flex;align-items:center;gap:7px" }, logoTile(ch, 22, 7), ch.name)),
      h("button", { onClick: close, style: "width:32px;height:32px;flex:none;border-radius:9px;border:1px solid rgba(255,255,255,0.12);background:rgba(255,255,255,0.04);color:#cfd3d8;cursor:pointer;font-size:16px" }, "×")),
    h("div", { style: "padding:16px 22px 22px;display:flex;flex-direction:column;gap:18px" },
      h("div", { style: "font-size:12.5px;color:#9aa0a6;line-height:1.5;background:rgba(84,182,255,0.06);border:1px solid rgba(84,182,255,0.18);border-radius:10px;padding:11px 13px" },
        "A login-free link to this one channel. It expires, you can revoke it anytime, the stream is proxied (your provider stays hidden), and it's blocked from crawlers + can't be hotlinked."),

      // config
      h("div", null,
        h("div", { style: "font-size:11.5px;font-weight:700;color:#9aa0a6;letter-spacing:.05em;text-transform:uppercase;margin-bottom:9px" }, "Expires after"),
        h("div", { style: "display:flex;flex-wrap:wrap;gap:8px" }, ...presets.map(([hrs, lbl]) => chip(f.expiresInHours === hrs, lbl, () => { f.expiresInHours = hrs; render(); })))),
      h("div", { style: "display:flex;align-items:center;gap:12px" },
        h("div", { style: "font-size:13.5px;color:#dfe3e7;font-weight:600;flex:1" }, "Max simultaneous viewers",
          h("div", { style: "font-size:11.5px;color:#6b7178;font-weight:400;margin-top:2px" }, "A leaked link can't be watched by more than this at once.")),
        h("input", { type: "number", min: "1", max: "50", value: String(f.maxConcurrent),
          onInput: (e) => { f.maxConcurrent = Math.max(1, Math.min(50, Number(e.target.value) || 1)); },
          style: "width:64px;height:38px;text-align:center;border-radius:9px;border:1px solid rgba(255,255,255,0.12);background:rgba(255,255,255,0.05);color:#eef0f2;font-size:15px;font-family:inherit;outline:none" })),

      state.shareError ? h("div", { style: "font-size:13px;color:#ff8077;background:rgba(255,93,82,0.1);border:1px solid rgba(255,93,82,0.3);border-radius:9px;padding:9px 12px" }, state.shareError) : null,

      h("button", { onClick: createShareSubmit, disabled: state.shareBusy,
        style: "height:44px;border-radius:11px;border:none;background:" + AC + ";color:#06121c;font-size:14.5px;font-weight:700;font-family:inherit;cursor:pointer;opacity:" + (state.shareBusy ? ".6" : "1") },
        state.shareBusy ? "Creating…" : "Generate link"),

      created ? h("div", { style: "display:flex;flex-direction:column;gap:9px;padding:14px;background:rgba(47,174,92,0.08);border:1px solid rgba(47,174,92,0.3);border-radius:12px" },
        h("div", { style: "font-size:12.5px;font-weight:700;color:#7fdca0" }, "Link ready — copy & send it"),
        h("div", { style: "display:flex;gap:8px" },
          h("input", { readonly: true, value: shareUrl(created.token), onClick: (e) => e.target.select(),
            style: "flex:1;min-width:0;height:40px;padding:0 12px;border-radius:9px;border:1px solid rgba(255,255,255,0.14);background:rgba(0,0,0,0.3);color:#eef0f2;font-size:12.5px;font-family:'JetBrains Mono',monospace;outline:none" }),
          h("button", { onClick: (e) => copyText(shareUrl(created.token), e.target), style: "height:40px;padding:0 16px;border-radius:9px;border:none;background:#fff;color:#06121c;font-size:13px;font-weight:700;font-family:inherit;cursor:pointer;white-space:nowrap" }, "Copy"))) : null,

      // existing links
      mine.length ? h("div", { style: "border-top:1px solid rgba(255,255,255,0.08);padding-top:16px;display:flex;flex-direction:column;gap:9px" },
        h("div", { style: "font-size:11.5px;font-weight:700;color:#9aa0a6;letter-spacing:.05em;text-transform:uppercase" }, "Links for this channel"),
        ...mine.map((s) => {
          const dead = s.revoked || s.expired;
          return h("div", { style: "display:flex;align-items:center;gap:10px;padding:9px 11px;background:rgba(255,255,255,0.03);border:1px solid rgba(255,255,255,0.07);border-radius:10px;opacity:" + (dead ? ".5" : "1") },
            h("div", { style: "min-width:0;flex:1" },
              h("div", { style: "font-size:12px;font-family:'JetBrains Mono',monospace;color:#c3c8cd;white-space:nowrap;overflow:hidden;text-overflow:ellipsis" }, "…/s/" + s.token.slice(0, 12) + "…"),
              h("div", { style: "font-size:11px;color:#6b7178;margin-top:2px" }, fmtLeft(s) + " · " + s.active + "/" + s.maxConcurrent + " watching" + (s.useCount ? " · used " + s.useCount + "×" : ""))),
            dead
              ? h("button", { onClick: () => deleteShareAction(s.id), style: "height:30px;padding:0 11px;border-radius:8px;border:1px solid rgba(255,255,255,0.12);background:transparent;color:#9aa0a6;font-size:12px;font-weight:600;cursor:pointer;font-family:inherit" }, "Remove")
              : h("button", { onClick: () => revokeShareAction(s.id), style: "height:30px;padding:0 11px;border-radius:8px;border:1px solid rgba(255,93,82,0.3);background:rgba(255,93,82,0.08);color:#ff8077;font-size:12px;font-weight:600;cursor:pointer;font-family:inherit" }, "Revoke"));
        })) : null));

  return h("div", { onClick: close, style: "position:fixed;inset:0;z-index:90;background:rgba(0,0,0,0.6);backdrop-filter:blur(4px);display:flex;align-items:center;justify-content:center" }, card);
}

function restrictionSummary(r) {
  if (!r || r.mode === "all") return "Full access";
  const n = (r.categories?.length || 0) + (r.networks?.length || 0) + (r.channelIds?.length || 0);
  return (r.mode === "allow" ? "Only " : "Blocks ") + n + " group" + (n === 1 ? "" : "s");
}

// ===== SOURCES screen =====
function sourcesScreen() {
  const list = state.providers;
  const header = h("div", { style: "flex:none;display:flex;align-items:flex-end;justify-content:space-between;padding:22px 26px 16px" },
    h("div", null,
      h("div", { style: "font-size:23px;font-weight:700;letter-spacing:-.01em" }, "Sources"),
      h("div", { style: "font-size:13px;color:#9aa0a6;margin-top:3px" }, (list ? list.length : "…") + " provider" + (list && list.length === 1 ? "" : "s") + " · the Xtream/M3U feeds your lineup is built from")),
    h("button", { onClick: openAddSource, style: "height:38px;padding:0 16px;border-radius:10px;border:none;background:" + AC + ";color:#06121c;font-size:13.5px;font-weight:700;cursor:pointer;display:flex;align-items:center;gap:7px" },
      h("img", { src: ICON("plus"), style: "width:15px;height:15px;filter:brightness(0) invert(.05)" }), "Add source"));

  const rows = list == null ? [centered("Loading sources…")]
    : list.length === 0 ? [h("div", { style: "padding:40px;text-align:center;color:#6b7178;font-size:14px" }, "No providers yet — add your first Xtream panel or M3U playlist.")]
    : list.map((p) => providerCard(p));

  return h("div", { style: "flex:1;display:flex;flex-direction:column;min-height:0" },
    header,
    h("div", { class: "aer-stagger", style: "flex:1;overflow:auto;padding:0 26px 26px;display:flex;flex-direction:column;gap:11px" }, ...rows));
}
function providerCard(p) {
  const busy = state.providerBusyId === p.id;
  const slot = p.slots || { max: p.maxConnections, used: 0 };
  const off = !p.enabled;
  const pill = (label, color) => h("span", { style: "font-size:11px;font-weight:600;color:" + color + ";padding:2px 9px;border-radius:6px;background:" + color.replace("rgb", "rgba").replace(")", ",0.12)") }, label);
  const stat = (label, value) => h("div", { style: "display:flex;flex-direction:column;gap:1px" },
    h("div", { style: "font-size:16px;font-weight:700;color:#eef0f2;font-family:'JetBrains Mono',monospace" }, value),
    h("div", { style: "font-size:10.5px;color:#6b7178;text-transform:uppercase;letter-spacing:.05em" }, label));
  const action = (label, onClick, opts) => h("button", { onClick, disabled: opts && opts.busy, style: "height:34px;padding:0 13px;border-radius:8px;border:1px solid " + ((opts && opts.danger) ? "rgba(255,93,82,0.3)" : "rgba(255,255,255,0.12)") + ";background:" + ((opts && opts.danger) ? "rgba(255,93,82,0.08)" : "rgba(255,255,255,0.04)") + ";color:" + ((opts && opts.danger) ? "#ff8077" : "#dfe3e7") + ";font-size:12.5px;font-weight:600;cursor:pointer;font-family:inherit;opacity:" + ((opts && opts.busy) ? ".6" : "1") }, label);

  return h("div", { style: "background:rgba(255,255,255,0.025);border:1px solid rgba(255,255,255,0.07);border-radius:14px;padding:16px 18px;display:flex;flex-direction:column;gap:14px;opacity:" + (off ? ".6" : "1") },
    h("div", { style: "display:flex;align-items:center;gap:13px" },
      h("div", { style: "width:42px;height:42px;flex:none;border-radius:12px;background:rgba(84,182,255,0.12);border:1px solid rgba(84,182,255,0.25);display:flex;align-items:center;justify-content:center" }, h("img", { src: ICON(p.type === "xtream" ? "satellite-dish" : "list-video"), style: "width:20px;height:20px;filter:brightness(0) invert(.7)" })),
      h("div", { style: "min-width:0;flex:1" },
        h("div", { style: "display:flex;align-items:center;gap:9px" },
          h("span", { style: "font-size:15.5px;font-weight:700;color:#eef0f2" }, p.name),
          pill(p.type.toUpperCase(), "rgb(140,200,255)"),
          p.viaVpn ? pill("VPN", "rgb(127,220,160)") : null,
          off ? pill("DISABLED", "rgb(154,160,166)") : null),
        h("div", { style: "font-size:12px;color:#6b7178;margin-top:2px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-family:'JetBrains Mono',monospace" }, p.url)),
      h("div", { style: "display:flex;gap:22px;flex:none;padding:0 6px" },
        stat("Channels", String(p.channels ?? 0)),
        stat("Slots", slot.used + "/" + slot.max),
        stat("Synced", p.lastSyncedAt ? relTime(p.lastSyncedAt) : "never"))),
    h("div", { style: "display:flex;gap:8px;align-items:center;border-top:1px solid rgba(255,255,255,0.06);padding-top:13px" },
      action(busy ? "Syncing…" : "Sync now", () => syncProviderAction(p.id), { busy }),
      action(p.enabled ? "Disable" : "Enable", () => toggleProvider(p)),
      // Per-source VPN toggle (the headline of this feature).
      h("button", { onClick: () => toggleProviderVpn(p), title: p.viaVpn ? "Routing upstream through the VPN proxy" : "Route this provider's upstream through the VPN proxy", style: "height:34px;padding:0 12px;border-radius:8px;cursor:pointer;font-size:12.5px;font-weight:600;font-family:inherit;display:flex;align-items:center;gap:7px;border:1px solid " + (p.viaVpn ? "rgba(127,220,160,0.4)" : "rgba(255,255,255,0.12)") + ";background:" + (p.viaVpn ? "rgba(127,220,160,0.12)" : "rgba(255,255,255,0.04)") + ";color:" + (p.viaVpn ? "#7fdca0" : "#dfe3e7") },
        h("img", { src: ICON("shield-check"), style: "width:14px;height:14px;filter:brightness(0) invert(" + (p.viaVpn ? ".75" : ".6") + ")" }), "VPN " + (p.viaVpn ? "on" : "off")),
      p.viaVpn && !vpnConfigured() ? h("span", { style: "font-size:11px;color:#f4b740" }, "⚠ set proxy in Settings") : null,
      h("div", { style: "flex:1" }),
      action("Remove", () => deleteProvider(p), { danger: true })));
}
function relTime(ts) {
  const diff = Date.now() - new Date(ts).getTime();
  const m = Math.floor(diff / 60000);
  if (m < 1) return "just now"; if (m < 60) return m + "m ago";
  const hr = Math.floor(m / 60); if (hr < 24) return hr + "h ago";
  return Math.floor(hr / 24) + "d ago";
}

// ===== RULES screen =====
const RULE_FIELDS = [["name", "Name"], ["category", "Category"], ["resolution", "Resolution"], ["country", "Country code"]];
const RULE_OPS = [["contains", "contains"], ["matches", "matches (regex)"], ["eq", "equals"], ["neq", "is not"], ["lt", "<"], ["lte", "≤"], ["gt", ">"], ["gte", "≥"]];
const RULE_ACTIONS = [["isHidden", "Hide it"], ["category", "Set category to…"], ["name", "Rename to…"]];
function rulesScreen() {
  const list = state.rules;
  const header = h("div", { style: "flex:none;display:flex;align-items:flex-end;justify-content:space-between;padding:22px 26px 16px;gap:14px" },
    h("div", null,
      h("div", { style: "font-size:23px;font-weight:700;letter-spacing:-.01em" }, "Rules"),
      h("div", { style: "font-size:13px;color:#9aa0a6;margin-top:3px" }, "Auto-manage channels on every sync — hide, rename, recategorize. Hiding is reversible.")),
    h("div", { style: "display:flex;gap:9px;align-items:center" },
      state.ruleApplyMsg ? h("span", { style: "font-size:12px;color:#7fdca0" }, state.ruleApplyMsg) : null,
      h("button", { onClick: applyRulesAction, style: "height:38px;padding:0 14px;border-radius:10px;border:1px solid rgba(255,255,255,0.12);background:rgba(255,255,255,0.04);color:#dfe3e7;font-size:13px;font-weight:600;cursor:pointer" }, "Run now"),
      h("button", { onClick: () => { state.ruleNew = state.ruleNew ? null : { field: "name", op: "contains", value: "", actionSet: "isHidden", actionValue: "", name: "" }; state.ruleError = null; render(); }, style: "height:38px;padding:0 16px;border-radius:10px;border:none;background:" + AC + ";color:#06121c;font-size:13.5px;font-weight:700;cursor:pointer;display:flex;align-items:center;gap:7px" },
        h("img", { src: ICON("plus"), style: "width:15px;height:15px;filter:brightness(0) invert(.05)" }), "New rule")));

  const create = state.ruleNew ? ruleBuilder() : null;
  const rows = list == null ? [centered("Loading rules…")]
    : list.length === 0 && !state.ruleNew ? [h("div", { style: "padding:34px;text-align:center;color:#6b7178;font-size:14px" }, "No rules yet — create one to auto-hide junk, fix names, or set categories.")]
    : list.map((r) => ruleCard(r));

  return h("div", { style: "flex:1;display:flex;flex-direction:column;min-height:0" },
    header,
    state.ruleError ? h("div", { style: "margin:0 26px 12px;font-size:13px;color:#ff8077;background:rgba(255,93,82,0.1);border:1px solid rgba(255,93,82,0.3);border-radius:9px;padding:9px 13px" }, state.ruleError) : null,
    h("div", { style: "flex:1;overflow:auto;padding:0 26px 26px;display:flex;flex-direction:column;gap:11px" }, create, ...rows));
}
function ruleSelect(value, opts, onPick) {
  const sel = h("select", { onChange: (e) => onPick(e.target.value),
    style: "height:38px;padding:0 30px 0 11px;border-radius:9px;border:1px solid rgba(255,255,255,0.12);background:rgba(255,255,255,0.05);color:#eef0f2;font-size:13px;font-family:inherit;appearance:none;-webkit-appearance:none;cursor:pointer" },
    ...opts.map(([v, label]) => h("option", { value: v, selected: v === value, style: "background:#16181c" }, label)));
  return h("div", { style: "position:relative;display:inline-flex" }, sel, h("span", { style: "position:absolute;right:10px;top:50%;transform:translateY(-50%);pointer-events:none;font-size:9px;color:#9aa0a6" }, "▾"));
}
function ruleBuilder() {
  const f = state.ruleNew;
  const valInput = (val, onInput, ph) => h("input", { value: val || "", placeholder: ph || "", onInput: (e) => onInput(e.target.value),
    style: "height:38px;padding:0 12px;border-radius:9px;border:1px solid rgba(255,255,255,0.12);background:rgba(255,255,255,0.05);color:#eef0f2;font-size:13px;font-family:inherit;outline:none;min-width:120px;flex:1" });
  return h("div", { style: "background:rgba(84,182,255,0.05);border:1px solid rgba(84,182,255,0.25);border-radius:14px;padding:16px 18px;display:flex;flex-direction:column;gap:14px" },
    h("div", { style: "font-size:13px;font-weight:700;color:#cfe8ff" }, "New rule"),
    h("div", { style: "display:flex;flex-wrap:wrap;gap:9px;align-items:center" },
      h("span", { style: "font-size:13px;color:#9aa0a6;font-weight:600" }, "If a channel's"),
      ruleSelect(f.field, RULE_FIELDS, (v) => { f.field = v; render(); }),
      ruleSelect(f.op, RULE_OPS, (v) => { f.op = v; render(); }),
      valInput(f.value, (v) => { f.value = v; }, f.field === "resolution" ? "720" : "value…")),
    h("div", { style: "display:flex;flex-wrap:wrap;gap:9px;align-items:center" },
      h("span", { style: "font-size:13px;color:#9aa0a6;font-weight:600" }, "then"),
      ruleSelect(f.actionSet, RULE_ACTIONS, (v) => { f.actionSet = v; render(); }),
      f.actionSet !== "isHidden" ? valInput(f.actionValue, (v) => { f.actionValue = v; }, f.actionSet === "category" ? "sports / news / kids…" : "new name…") : null),
    h("div", { style: "display:flex;gap:10px" },
      h("button", { onClick: createRuleSubmit, disabled: state.ruleBusy, style: "height:38px;padding:0 18px;border-radius:10px;border:none;background:" + AC + ";color:#06121c;font-weight:700;font-size:13px;cursor:pointer;font-family:inherit" }, state.ruleBusy ? "Saving…" : "Save rule"),
      h("button", { onClick: () => { state.ruleNew = null; render(); }, style: "height:38px;padding:0 16px;border-radius:10px;border:1px solid rgba(255,255,255,0.12);background:transparent;color:#aeb4ba;font-weight:600;font-size:13px;cursor:pointer;font-family:inherit" }, "Cancel")));
}
function ruleCard(r) {
  const c = r.condition || {}, a = r.action || {};
  const opLabel = (RULE_OPS.find((o) => o[0] === c.op) || [c.op, c.op])[1];
  const actLabel = a.set === "isHidden" ? "hide it" : a.set === "category" ? "set category → " + a.value : "rename → " + a.value;
  const off = !r.enabled;
  return h("div", { style: "background:rgba(255,255,255,0.025);border:1px solid rgba(255,255,255,0.07);border-radius:13px;padding:14px 16px;display:flex;align-items:center;gap:14px;opacity:" + (off ? ".55" : "1") },
    h("div", { style: "width:34px;height:34px;flex:none;border-radius:10px;background:rgba(255,255,255,0.05);display:flex;align-items:center;justify-content:center" }, h("img", { src: ICON(a.set === "isHidden" ? "eye-off" : a.set === "category" ? "tag" : "pencil"), style: "width:16px;height:16px;filter:brightness(0) invert(.65)" })),
    h("div", { style: "min-width:0;flex:1" },
      h("div", { style: "font-size:14px;font-weight:600;color:#eef0f2" }, r.name),
      h("div", { style: "font-size:12px;color:#9aa0a6;margin-top:2px" }, "If " + c.field + " " + opLabel + " “" + c.value + "” → " + actLabel)),
    h("button", { onClick: () => toggleRule(r), title: r.enabled ? "Enabled" : "Disabled", style: "width:44px;height:25px;flex:none;border-radius:13px;border:none;cursor:pointer;background:" + (r.enabled ? AC : "rgba(255,255,255,0.14)") + ";position:relative;transition:background .15s" },
      h("div", { style: "position:absolute;top:2px;left:" + (r.enabled ? "21px" : "2px") + ";width:21px;height:21px;border-radius:50%;background:#fff;transition:left .15s" })),
    h("button", { onClick: () => deleteRule(r), title: "Delete", style: "width:34px;height:34px;flex:none;border-radius:9px;border:1px solid rgba(255,93,82,0.25);background:rgba(255,93,82,0.07);cursor:pointer;display:flex;align-items:center;justify-content:center" }, h("img", { src: ICON("trash-2"), style: "width:15px;height:15px;filter:brightness(0) saturate(100%) invert(60%) sepia(40%) saturate(2000%) hue-rotate(-10deg)" })));
}

function usersScreen() {
  const list = state.users;
  const cats = state.data ? [...new Set(state.data.channels.map((c) => c.category).filter(Boolean))].sort() : [];
  const me = state.auth.user;

  const header = h("div", { style: "flex:none;display:flex;align-items:flex-end;justify-content:space-between;padding:22px 26px 16px" },
    h("div", null,
      h("div", { style: "font-size:23px;font-weight:700;letter-spacing:-.01em" }, "Users"),
      h("div", { style: "font-size:13px;color:#9aa0a6;margin-top:3px" }, (list ? list.length : "…") + " account" + (list && list.length === 1 ? "" : "s") + " · admins manage, users watch what you allow")),
    h("button", { onClick: () => { state.userNew = state.userNew ? null : { username: "", password: "", role: "user" }; state.userError = null; render(); },
      style: "height:38px;padding:0 16px;border-radius:10px;border:none;background:" + AC + ";color:#06121c;font-size:13.5px;font-weight:700;cursor:pointer;display:flex;align-items:center;gap:7px" },
      h("img", { src: ICON("plus"), style: "width:15px;height:15px;filter:brightness(0) invert(.05)" }), "New user"));

  const err = state.userError ? h("div", { style: "margin:0 26px 12px;font-size:13px;color:#ff8077;background:rgba(255,93,82,0.1);border:1px solid rgba(255,93,82,0.3);border-radius:9px;padding:9px 13px" }, state.userError) : null;

  const createForm = state.userNew ? h("div", { style: "margin:0 26px 16px;padding:16px;background:rgba(255,255,255,0.03);border:1px solid rgba(255,255,255,0.09);border-radius:13px;display:flex;gap:12px;align-items:flex-end;flex-wrap:wrap" },
    userField("Username", state.userNew.username, (v) => { state.userNew.username = v; }),
    userField("Password", state.userNew.password, (v) => { state.userNew.password = v; }, "password"),
    h("div", { style: "display:flex;flex-direction:column;gap:6px" },
      h("label", { style: "font-size:11.5px;font-weight:600;color:#9aa0a6" }, "Role"),
      roleToggle(state.userNew.role, (r) => { state.userNew.role = r; render(); })),
    h("button", { onClick: createUserSubmit, disabled: state.userBusy,
      style: "height:40px;padding:0 18px;border-radius:10px;border:none;background:" + AC + ";color:#06121c;font-weight:700;font-size:13.5px;cursor:pointer;opacity:" + (state.userBusy ? ".6" : "1") }, "Create")) : null;

  const rows = list == null
    ? [centered("Loading users…")]
    : list.map((u) => userRow(u, cats, me));

  return h("div", { style: "flex:1;display:flex;flex-direction:column;min-height:0" },
    header, err, createForm,
    h("div", { class: "aer-stagger", style: "flex:1;overflow:auto;padding:0 26px 26px;display:flex;flex-direction:column;gap:10px" }, ...rows));
}

function userField(label, value, onInput, type) {
  return h("div", { style: "display:flex;flex-direction:column;gap:6px;flex:1;min-width:160px" },
    h("label", { style: "font-size:11.5px;font-weight:600;color:#9aa0a6" }, label),
    h("input", { type: type || "text", value: value || "",
      onInput: (e) => onInput(e.target.value),
      style: "height:40px;padding:0 12px;border-radius:10px;border:1px solid rgba(255,255,255,0.12);background:rgba(255,255,255,0.05);color:#eef0f2;font-size:14px;font-family:inherit;outline:none" }));
}
function roleToggle(role, onPick) {
  const seg = (on) => "height:40px;padding:0 14px;border-radius:8px;border:none;background:" + (on ? AC : "transparent") + ";color:" + (on ? "#06121c" : "#aeb4ba") + ";font-size:13px;font-weight:600;cursor:pointer;font-family:inherit";
  return h("div", { style: "display:flex;padding:3px;background:rgba(255,255,255,0.05);border:1px solid rgba(255,255,255,0.08);border-radius:11px;gap:2px" },
    h("button", { style: seg(role === "user"), onClick: () => onPick("user") }, "User"),
    h("button", { style: seg(role === "admin"), onClick: () => onPick("admin") }, "Admin"));
}

function userRow(u, cats, me) {
  const isAdmin = u.role === "admin";
  const editing = state.userEditId === u.id;
  const badge = h("span", { style: "font-size:10px;font-weight:700;letter-spacing:.08em;padding:2px 8px;border-radius:6px;text-transform:uppercase;" + (isAdmin ? "color:#8fd0ff;background:rgba(84,182,255,0.14);border:1px solid rgba(84,182,255,0.35)" : "color:#b4bac0;background:rgba(255,255,255,0.06);border:1px solid rgba(255,255,255,0.12)") }, u.role);
  const actionBtn = (label, onClick, danger) => h("button", { onClick, style: "height:32px;padding:0 12px;border-radius:8px;border:1px solid " + (danger ? "rgba(255,93,82,0.3)" : "rgba(255,255,255,0.12)") + ";background:" + (danger ? "rgba(255,93,82,0.08)" : "rgba(255,255,255,0.04)") + ";color:" + (danger ? "#ff8077" : "#dfe3e7") + ";font-size:12.5px;font-weight:600;cursor:pointer;font-family:inherit" }, label);

  return h("div", { style: "background:rgba(255,255,255,0.025);border:1px solid rgba(255,255,255,0.07);border-radius:13px;overflow:hidden" },
    h("div", { style: "display:flex;align-items:center;gap:14px;padding:14px 16px" },
      h("div", { style: "width:40px;height:40px;flex:none;border-radius:11px;background:linear-gradient(135deg," + (isAdmin ? "#2a78c2,#143c63" : "#3a3f47,#1a1d21") + ");display:flex;align-items:center;justify-content:center;font-size:14px;font-weight:700;color:#eef0f2;text-transform:uppercase" }, u.username.slice(0, 2)),
      h("div", { style: "min-width:0;flex:1" },
        h("div", { style: "display:flex;align-items:center;gap:9px" },
          h("span", { style: "font-size:15px;font-weight:700;color:#eef0f2" }, u.username),
          badge,
          me && me.id === u.id ? h("span", { style: "font-size:11px;color:#6b7178" }, "(you)") : null),
        h("div", { style: "font-size:12.5px;color:#9aa0a6;margin-top:2px" },
          (isAdmin ? "Full access — manages everything" : restrictionSummary(u.restrictions)) +
          (u.lastLoginAt ? " · last seen " + new Date(u.lastLoginAt).toLocaleDateString() : " · never signed in"))),
      h("div", { style: "display:flex;gap:8px;flex:none" },
        isAdmin ? null : actionBtn(editing ? "Close" : "Restrict", () => { if (editing) { state.userEditId = null; state.userEditDraft = null; render(); } else openRestrictEditor(u); }),
        (me && me.id === u.id) ? null : actionBtn(isAdmin ? "Make user" : "Make admin", () => patchUser(u.id, { role: isAdmin ? "user" : "admin" })),
        (me && me.id === u.id) ? null : actionBtn("Delete", () => deleteUserAction(u.id, u.username), true))),
    editing ? restrictEditor(u, cats) : null);
}

function restrictEditor(u, cats) {
  const draft = state.userEditDraft;
  if (!draft) return null;
  const modeBtn = (m, label, desc) => h("button", { onClick: () => { draft.mode = m; render(); },
    style: "flex:1;text-align:left;padding:11px 13px;border-radius:10px;cursor:pointer;font-family:inherit;border:1px solid " + (draft.mode === m ? AC : "rgba(255,255,255,0.1)") + ";background:" + (draft.mode === m ? "rgba(84,182,255,0.12)" : "rgba(255,255,255,0.03)") },
    h("div", { style: "font-size:13px;font-weight:700;color:" + (draft.mode === m ? "#cfe8ff" : "#dfe3e7") }, label),
    h("div", { style: "font-size:11px;color:#9aa0a6;margin-top:2px" }, desc));
  const chip = (label, active, onClick) => h("button", { onClick,
    style: "padding:6px 11px;border-radius:8px;cursor:pointer;font-family:inherit;font-size:12px;font-weight:600;border:1px solid " + (active ? AC : "rgba(255,255,255,0.12)") + ";background:" + (active ? "rgba(84,182,255,0.16)" : "rgba(255,255,255,0.04)") + ";color:" + (active ? "#cfe8ff" : "#c3c8cd") }, label);
  const toggle = (arr, v) => { const i = arr.indexOf(v); if (i >= 0) arr.splice(i, 1); else arr.push(v); render(); };

  return h("div", { style: "padding:6px 16px 18px;border-top:1px solid rgba(255,255,255,0.06);display:flex;flex-direction:column;gap:14px" },
    h("div", { style: "display:flex;gap:10px;margin-top:12px" },
      modeBtn("all", "Everything", "No limits — sees all channels"),
      modeBtn("allow", "Only allow…", "Sees only what's selected below"),
      modeBtn("deny", "Block…", "Sees everything except the below")),
    draft.mode === "all" ? null : h("div", { style: "display:flex;flex-direction:column;gap:14px" },
      h("div", null,
        h("div", { style: "font-size:11.5px;font-weight:700;color:#9aa0a6;letter-spacing:.06em;text-transform:uppercase;margin-bottom:9px" }, "Networks"),
        h("div", { style: "display:flex;flex-wrap:wrap;gap:7px" }, ...NETWORK_LIST.map((n) => chip(n, draft.networks.includes(n), () => toggle(draft.networks, n))))),
      h("div", null,
        h("div", { style: "font-size:11.5px;font-weight:700;color:#9aa0a6;letter-spacing:.06em;text-transform:uppercase;margin-bottom:9px" }, "Categories (" + draft.categories.length + " selected)"),
        h("div", { style: "display:flex;flex-wrap:wrap;gap:7px;max-height:200px;overflow:auto;padding:2px" }, ...cats.map((cat) => chip(cat, draft.categories.includes(cat), () => toggle(draft.categories, cat)))))),
    h("div", { style: "display:flex;gap:10px;align-items:center" },
      h("button", { onClick: saveRestrictEditor, style: "height:38px;padding:0 18px;border-radius:10px;border:none;background:" + AC + ";color:#06121c;font-weight:700;font-size:13px;cursor:pointer;font-family:inherit" }, "Save restrictions"),
      h("button", { onClick: () => { state.userEditId = null; state.userEditDraft = null; render(); }, style: "height:38px;padding:0 16px;border-radius:10px;border:1px solid rgba(255,255,255,0.12);background:transparent;color:#aeb4ba;font-weight:600;font-size:13px;cursor:pointer;font-family:inherit" }, "Cancel")));
}

async function loadAnalytics() {
  try {
    const [a, s] = await Promise.all([
      fetch("/api/analytics").then((r) => r.json()),
      fetch("/api/status").then((r) => r.json()),
    ]);
    state.analytics = a;
    state.statusLive = s;
    render();
  } catch {
    /* leave previous */
  }
}
function toggleRow(id) { state.selectedRows[id] = !state.selectedRows[id]; render(); }
function toggleAll() {
  const all = state.data.channels.every((r) => state.selectedRows[r.id]);
  const next = {};
  if (!all) state.data.channels.forEach((r) => (next[r.id] = true));
  set({ selectedRows: next });
}
async function commitName(r, value) {
  if (value === r.name) return;
  r.name = value;
  try {
    await fetch(`/api/channels/${r.id}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: value }) });
  } catch {}
}
async function bulkHide() {
  const ids = Object.keys(state.selectedRows).filter((k) => state.selectedRows[k]).map(Number);
  await Promise.all(ids.map((id) => fetch(`/api/channels/${id}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ isHidden: true }) }).catch(() => {})));
  state.selectedRows = {};
  await loadView();
}
// ===== live player =====
// Managed imperatively (outside render()) so the 60s data refresh never tears
// down the <video> mid-playback. Passthrough MPEG-TS via mpegts.js + MSE — the
// server just proxies bytes through the muxer, no transcoding.
let playerEl = null;
let mpegtsPlayer = null;
let playerChannelId = null;
let morphState = null; // { video, scrim, morph, chrome } while the expand transition/fullscreen is live

// Where to grow from when we have no warm preview to anchor on: a centered box.
function centerRect() {
  const w = innerWidth * 0.42, h = innerHeight * 0.42;
  return { left: (innerWidth - w) / 2, top: (innerHeight - h) / 2, width: w, height: h };
}
// Style a <video> as an inline tile (preview look) vs. the fullscreen player.
const TILE_VIDEO_STYLE = "position:absolute;inset:0;width:100%;height:100%;object-fit:cover;z-index:1";
// Drive the expand/collapse by the LAYOUT box (left/top/width/height), NOT a
// transform. Keeping object-fit:cover constant while the real box size animates
// means the crop is recomputed correctly every frame — the video grows
// seamlessly with no reframe/squish (transform-scale + object-fit glitches).
function setMorphRect(el, r) {
  el.style.left = r.left + "px";
  el.style.top = r.top + "px";
  el.style.width = r.width + "px";
  el.style.height = r.height + "px";
}
const MORPH_EASE = "cubic-bezier(.3,.72,.2,1)";
const MORPH_BOX_TRANSITION = ["left", "top", "width", "height"].map((p) => `${p} .42s ${MORPH_EASE}`).join(",");

function nextChannel(channelId, dir) {
  const list = state.data.channels.filter((c) => !c.isHidden);
  const i = list.findIndex((c) => c.id === channelId);
  if (i < 0) return channelId;
  return list[(i + dir + list.length) % list.length].id;
}

function destroyMpegts() {
  if (mpegtsPlayer) {
    try { mpegtsPlayer.destroy(); } catch { /* noop */ }
    mpegtsPlayer = null;
  }
}

function closePlayer() {
  if (!playerEl || !morphState) { if (playerEl) { playerEl.remove(); playerEl = null; } return; }
  const ms = morphState;
  const channelId = playerChannelId;
  const player = mpegtsPlayer; // the warm decoder — we hand it BACK to the preview, never destroy
  morphState = null;

  // Rebuild the FINAL guide NOW, while it's still hidden (visibility:hidden,
  // opacity:0), so it's invisible. playerEl is still set, so the detail slot
  // renders a placeholder — the warm video stays in the morph layer for the shrink.
  const root = document.getElementById("root");
  if (root) root.style.visibility = "";
  render();

  const r = ms.fromRect;
  const canFlip = innerWidth > 0 && innerHeight > 0 && r.width > 0 && r.height > 0;

  // PHASE 1 — shrink the player's box back down to the preview's rect (on black).
  ms.video.controls = false;
  ms.chrome.style.opacity = "0";
  if (canFlip) {
    ms.morph.style.transition = MORPH_BOX_TRANSITION;
    setMorphRect(ms.morph, r);
  }
  // PHASE 2 — once it's back at preview size, fade the whole guide back in over it.
  setTimeout(() => {
    if (playerEl !== ms.wrapper) { ms.wrapper.remove(); return; } // a re-open took over
    if (root) { root.style.transition = "opacity .3s ease"; root.style.opacity = ""; }
    setTimeout(() => {
      if (playerEl !== ms.wrapper) { ms.wrapper.remove(); return; }
      // Re-home the (still-playing) video into the preview tile so playback continues.
      const v = ms.video;
      v.controls = false;
      v.style.cssText = TILE_VIDEO_STYLE;
      v.style.transform = "";
      tilePlayers["detail"] = { key: "detail", video: v, player, channelId };
      playerEl = null;
      mpegtsPlayer = null;
      playerChannelId = null;
      if (root) { root.style.position = ""; root.style.zIndex = ""; root.style.transition = ""; root.style.opacity = ""; }
      // Point the guide's detail preview at the channel we were just watching so
      // the warm video is REUSED (not discarded) — that's what keeps it running.
      const vis = guideVisible();
      const ci = vis.findIndex((c) => c.id === channelId);
      if (ci >= 0) {
        const progs = programsFor(vis[ci]);
        let pi = progs.findIndex((p) => !p.filler && p.start <= Date.now() && p.end > Date.now());
        if (pi < 0) pi = 0;
        state.selectedCellId = ci + "-" + pi;
      }
      render();                 // swap the placeholder for THIS warm video (lands where it shrank to)
      applyDetailAudio();       // restore preview mute/volume
      ms.wrapper.remove();      // morph is now empty (video moved into the detail slot)
    }, 300);
  }, 440); // wait out the .42s box shrink before fading the guide in
}

function setPlayerStatus(msg) {
  const el = playerEl && playerEl.querySelector("#aerPlayerStatus");
  if (!el) return;
  el.textContent = msg || "";
  el.style.display = msg ? "block" : "none"; // hide the pill entirely when idle/playing
}

function attachMpegts(video, channelId, transcode) {
  if (!window.mpegts || !mpegts.isSupported()) {
    setPlayerStatus("This browser can't play live TS (no Media Source Extensions).");
    return;
  }
  destroyMpegts();
  // Passthrough first (most efficient); fall back to the server-side audio
  // transcode only when the browser rejects the native codec (e.g. AC-3).
  setPlayerStatus(transcode ? "Switching to compatible audio…" : "Connecting…");
  // Absolute URL — mpegts.js fetches inside a Web Worker, which has no page base
  // to resolve a relative "/stream/…" path against.
  const url = location.origin + (transcode ? "/watch/" : "/stream/") + channelId;
  const player = mpegts.createPlayer(
    { type: "mpegts", isLive: true, url },
    {
      enableWorker: true,
      // Smooth playback over chasing the live edge: edge-chasing seeks the video
      // forward whenever the buffer fluctuates, which looks like "skipping around".
      liveBufferLatencyChasing: false,
      lazyLoad: false, // keep the stream flowing so our server queue stays drained
      autoCleanupSourceBuffer: true, // bound memory on long sessions
      stashInitialSize: 1024 * 1024, // ~1MB pre-buffer before playback starts
    },
  );
  mpegtsPlayer = player;
  player.attachMediaElement(video);
  player.on(mpegts.Events.ERROR, (type, detail, info) => {
    const msg = (info && info.msg) || "";
    const codecIssue = String(detail).indexOf("MSE") >= 0 || /codec|unsupported|addSourceBuffer/i.test(msg);
    if (!transcode && codecIssue && playerChannelId === channelId) {
      attachMpegts(video, channelId, true); // retry via the transcode endpoint
      return;
    }
    setPlayerStatus("Stream error: " + (msg || detail) + (transcode ? "" : " — the source may be offline."));
  });
  player.load();
  video.play().catch(() => {});
  video.addEventListener("playing", () => setPlayerStatus(""), { once: true });
}

// The fullscreen chrome (title bar + surf/close controls + status pill). Pure
// overlay — the <video> itself lives in the morph layer so it can FLIP-grow.
function buildPlayerChrome(channelId) {
  const ch = state.data.channelsById[channelId];
  const on = onNowProgram(ch);
  const surf = (dir) => () => openPlayer(nextChannel(playerChannelId, dir));
  const topBtn = (kids, onClick) => h("button", { onClick, style: "width:38px;height:38px;border-radius:9px;border:1px solid rgba(255,255,255,0.14);background:rgba(8,10,12,0.55);display:flex;align-items:center;justify-content:center;cursor:pointer;pointer-events:auto" }, kids);

  return h("div", { style: "position:fixed;inset:0;z-index:3;pointer-events:none;opacity:0;transition:opacity .26s ease .1s" },
    h("div", { style: "position:absolute;top:0;left:0;right:0;padding:34px 22px 18px;display:flex;align-items:center;gap:14px;background:linear-gradient(180deg,rgba(0,0,0,0.75),transparent)" },
      h("div", { style: "display:flex;align-items:center;gap:14px;pointer-events:auto" },
        logoTile(ch, 44, 14),
        h("div", null,
          h("div", { style: "display:flex;align-items:center;gap:9px" },
            h("span", { style: { fontFamily: "'JetBrains Mono',monospace", fontSize: "13px", fontWeight: 600, color: ch.color } }, "#" + (ch.num ?? "—")),
            h("span", { style: "font-size:17px;font-weight:700" }, ch.name)),
          h("div", { style: "font-size:13px;color:#b4bac0;margin-top:2px" }, on.filler ? "Live" : on.title))),
      h("div", { style: "flex:1" }),
      h("div", { style: "display:flex;gap:8px" },
        topBtn(icon("chevron-up", 18, 0.85), surf(-1)),
        topBtn(icon("chevron-down", 18, 0.85), surf(1)),
        topBtn(icon("x", 18, 0.9), closePlayer))),
    h("div", { id: "aerPlayerStatus", style: "position:absolute;bottom:30px;left:50%;transform:translateX(-50%);font-size:13px;color:#cfd3d8;background:rgba(8,10,12,0.7);padding:8px 16px;border-radius:10px;backdrop-filter:blur(6px)" }, "Connecting…"));
}

// Steal an already-warm tile player for this channel (its decoder/buffer are hot)
// so promoting preview → fullscreen is instant. Removed from the registry without
// being destroyed so reconcile/destroyAllTiles won't kill it.
function stealTilePlayer(channelId) {
  for (const k of Object.keys(tilePlayers)) {
    const e = tilePlayers[k];
    if (e.channelId === channelId && e.player) {
      delete tilePlayers[k];
      return e;
    }
  }
  return null;
}

function openPlayer(channelId) {
  if (!state.data || !state.data.channelsById[channelId]) return;

  // Already fullscreen → channel surf: swap the source on the existing player
  // video and refresh the chrome. No FLIP (we're already full-bleed).
  if (playerEl && morphState) {
    if (channelId === playerChannelId) return;
    destroyMpegts();
    playerChannelId = channelId;
    attachMpegts(morphState.video, channelId);
    const fresh = buildPlayerChrome(channelId);
    morphState.chrome.replaceWith(fresh);
    morphState.chrome = fresh;
    void fresh.offsetWidth;
    fresh.style.opacity = "1";
    return;
  }

  const warm = stealTilePlayer(channelId); // reuse a live preview/tile if we have one
  const video = warm ? warm.video : h("video", { autoplay: true, playsinline: true });
  // Anchor the grow on the preview's current on-screen rect (or center if cold).
  const fromRect = warm && warm.video.isConnected ? warm.video.getBoundingClientRect() : centerRect();
  destroyAllTiles(); // stop the other background tiles (warm is already out of the registry)
  playerChannelId = channelId;

  video.controls = false; // enabled only after the expand settles (avoids a control-bar pop mid-grow)
  video.muted = false;
  // object-fit:cover MATCHES the preview tile, so promoting the element doesn't reframe it.
  video.setAttribute("style", "width:100%;height:100%;object-fit:cover;display:block;background:#000");

  // The fullscreen player video sits in a fixed layer at z-index:1; we lift #root
  // to z-index:2 so the WHOLE guide (rail, top bar, frosted grid) can fade away
  // OVER the video — and gets hidden while watching so its backdrop-filter stops
  // eating decode performance.
  const root = document.getElementById("root");
  if (root) { root.style.position = "relative"; root.style.zIndex = "2"; root.style.transition = "opacity .32s ease"; }
  // Morph layer holds the video; its layout box animates preview-rect → fullscreen.
  const morph = h("div", { style: "position:fixed;z-index:1;overflow:hidden;background:#000;left:0;top:0;width:100vw;height:100vh" }, video);
  const chrome = buildPlayerChrome(channelId); // z-index:3, above #root
  const wrapper = h("div", null, morph, chrome);
  playerEl = wrapper;
  morphState = { video, morph, chrome, wrapper, fromRect };
  document.body.appendChild(wrapper);

  // Pin the morph at the preview's exact rect to start — visually identical to
  // the tile it replaced, so there's no jump when the guide fades off it.
  const canFlip = innerWidth > 0 && innerHeight > 0 && fromRect.width > 0 && fromRect.height > 0;
  if (canFlip) {
    morph.style.transition = "none";
    setMorphRect(morph, fromRect);
    void morph.offsetWidth; // commit the start frame
  }

  if (warm) {
    // Already decoding — adopt it, unmute, play. No reconnect/rebuffer.
    mpegtsPlayer = warm.player;
    video.play().catch(() => {});
    setPlayerStatus("");
  } else {
    attachMpegts(video, channelId);
  }

  // PHASE 1 — fade the whole guide away, revealing the small preview behind it.
  if (root) { void root.offsetWidth; root.style.opacity = "0"; }
  // Once it's gone, hide it so backdrop-filter stops re-rasterizing (smooth playback).
  setTimeout(() => { if (playerEl === wrapper && root) root.style.visibility = "hidden"; }, 320);
  // PHASE 2 — now grow the preview's box to fill the screen, then reveal controls.
  setTimeout(() => {
    if (playerEl !== wrapper) return;
    if (canFlip) {
      morph.style.transition = MORPH_BOX_TRANSITION;
      setMorphRect(morph, { left: 0, top: 0, width: innerWidth, height: innerHeight });
    }
    chrome.style.opacity = "1";
    setTimeout(() => { if (playerEl === wrapper) video.controls = true; }, canFlip ? 440 : 0);
  }, 300);
}

document.addEventListener("keydown", (e) => {
  if (!playerEl) return;
  if (e.key === "Escape") closePlayer();
  else if (e.key === "ArrowUp") openPlayer(nextChannel(playerChannelId, -1));
  else if (e.key === "ArrowDown") openPlayer(nextChannel(playerChannelId, 1));
});

// Remote-style navigation of the guide grid (arrows move the highlight, Enter watches).
function navGuide(key) {
  const visible = guideVisible();
  if (!visible.length) return;
  let ci, pi;
  if (state.selectedCellId) {
    [ci, pi] = state.selectedCellId.split("-").map(Number);
  } else {
    ci = 0;
    const progs = programsFor(visible[0]);
    pi = Math.max(0, progs.findIndex((p) => p.start <= Date.now() && p.end > Date.now()));
  }
  if (key === "Enter") { openPlayer(visible[ci].id); return; }

  const curProgs = programsFor(visible[ci]);
  const focusTime = curProgs[pi] ? (curProgs[pi].start + curProgs[pi].end) / 2 : Date.now();
  if (key === "ArrowDown" || key === "ArrowUp") {
    ci = key === "ArrowDown" ? Math.min(visible.length - 1, ci + 1) : Math.max(0, ci - 1);
    const progs = programsFor(visible[ci]);
    pi = progs.findIndex((p) => p.start <= focusTime && p.end > focusTime);
    if (pi < 0) pi = 0;
  } else if (key === "ArrowRight") {
    pi = Math.min(curProgs.length - 1, pi + 1);
  } else if (key === "ArrowLeft") {
    pi = Math.max(0, pi - 1);
  }

  // Pre-set the scroll target so the post-render applyScroll lands on the cell.
  const scroller = document.getElementById("aerGuideScroll");
  if (scroller && state.data) {
    const ROWH = rowH();
    const rowTop = HEADH + ci * ROWH;
    let st = guideScrollTop;
    if (rowTop < st + HEADH + 4) st = Math.max(0, rowTop - HEADH - 4);
    else if (rowTop + ROWH > st + scroller.clientHeight) st = rowTop + ROWH - scroller.clientHeight + 6;
    guideScrollTop = st;
    const p = programsFor(visible[ci])[pi];
    if (p) {
      const left = COLW + ((p.start - state.data.windowStart) / 60000) * PXPM;
      let sl = guideScrollLeft == null ? scroller.scrollLeft : guideScrollLeft;
      if (left - sl < COLW + 12) sl = Math.max(0, left - COLW - 30);
      else if (left - sl > scroller.clientWidth - 220) sl = left - scroller.clientWidth + 240;
      guideScrollLeft = sl;
    }
  }
  set({ selectedCellId: ci + "-" + pi });
}

document.addEventListener("keydown", (e) => {
  if (playerEl || state.addOpen) return; // fullscreen / modal handle their own keys
  if (state.screen !== "guide") return;
  if (!["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Enter"].includes(e.key)) return;
  e.preventDefault();
  navGuide(e.key);
});

// ===== inline tile players (mosaic tiles + guide mini-preview) =====
// A persistent <video> per tile, reused across re-renders so playback survives
// the periodic data refresh. After each render we reconcile: any tile no longer
// on screen is destroyed, freeing its stream. Passthrough first, /watch fallback.
const tilePlayers = {}; // key -> { key, video, player, channelId }
let usedTileKeys = new Set();

function startTileMpegts(entry, channelId, transcode) {
  if (entry.player) { try { entry.player.destroy(); } catch { /* noop */ } entry.player = null; }
  if (!window.mpegts || !mpegts.isSupported()) return;
  // ?as=preview so tile/mini previews don't skew real watch-time analytics.
  const url = location.origin + (transcode ? "/watch/" : "/stream/") + channelId + "?as=preview";
  const p = mpegts.createPlayer(
    { type: "mpegts", isLive: true, url },
    { enableWorker: true, liveBufferLatencyChasing: false, lazyLoad: false, autoCleanupSourceBuffer: true },
  );
  entry.player = p;
  p.attachMediaElement(entry.video);
  p.on(mpegts.Events.ERROR, (t, detail, info) => {
    const codec = String(detail).indexOf("MSE") >= 0 || /codec|unsupported|addSourceBuffer/i.test((info && info.msg) || "");
    if (!transcode && codec && tilePlayers[entry.key]) startTileMpegts(entry, channelId, true);
  });
  p.load();
  entry.video.play().catch(() => {});
}

function tileVideo(key, channelId, muted) {
  usedTileKeys.add(key);
  // While the fullscreen player is open, don't run background tiles.
  if (playerEl) return h("video", { style: "position:absolute;inset:0;width:100%;height:100%;object-fit:cover;z-index:1;opacity:0" });
  // "Live preview" toggled off: don't auto-stream the guide previews (ambient
  // backdrop / detail hero / mini). The explicit Mosaic grid stays live.
  if (state.previews === false && (key === "detail" || key === "mini")) {
    if (tilePlayers[key]) destroyTile(key); // stop a stream already running
    return h("video", { style: "position:absolute;inset:0;width:100%;height:100%;object-fit:cover;z-index:1;opacity:0" });
  }
  const detailVol = key === "detail" ? Math.max(0, Math.min(1, state.detailVolume ?? 1)) : 1;
  let entry = tilePlayers[key];
  if (entry && entry.channelId === channelId) {
    entry.video.muted = muted; // active-tile audio toggles without a restart
    if (key === "detail") entry.video.volume = detailVol;
    return entry.video;
  }
  if (entry) destroyTile(key);
  const video = h("video", { autoplay: true, playsinline: true, style: "position:absolute;inset:0;width:100%;height:100%;object-fit:cover;z-index:1" });
  video.muted = muted;
  video.volume = detailVol;
  entry = tilePlayers[key] = { key, video, player: null, channelId };
  const e = entry;
  // Debounce: only start once the selection settles (rapid arrow-nav would
  // otherwise spawn and kill a stream on every keypress).
  setTimeout(() => { if (tilePlayers[key] === e) startTileMpegts(e, channelId, false); }, 400);
  return video;
}

function destroyTile(key) {
  const e = tilePlayers[key];
  if (!e) return;
  if (e.player) { try { e.player.destroy(); } catch { /* noop */ } }
  delete tilePlayers[key];
}
function destroyAllTiles() { for (const k of Object.keys(tilePlayers)) destroyTile(k); }
function reconcileTiles() { for (const k of Object.keys(tilePlayers)) if (!usedTileKeys.has(k)) destroyTile(k); }

// ----- preview audio (mute button + hover volume rocker) -----
function applyDetailAudio() {
  const e = tilePlayers["detail"];
  if (!e || !e.video) return;
  const vol = Math.max(0, Math.min(1, state.detailVolume ?? 1));
  e.video.volume = vol;
  e.video.muted = state.detailMuted || vol <= 0;
}
function setDetailVolume(v) {
  state.detailVolume = Math.max(0, Math.min(1, v));
  state.detailMuted = state.detailVolume <= 0;
  applyDetailAudio(); // live, no re-render (avoids jank while dragging)
}
function toggleDetailMute() {
  state.detailMuted = !state.detailMuted;
  if (!state.detailMuted && (state.detailVolume ?? 0) <= 0) state.detailVolume = 0.6;
  applyDetailAudio();
  render();
}

// ===== boot =====
render(); // shows the "…" splash until checkAuth resolves
checkAuth(); // → login/setup screen, or loadView() if already signed in
setInterval(() => { if (state.auth.user) loadView(); }, 60000); // keep clock/guide fresh
