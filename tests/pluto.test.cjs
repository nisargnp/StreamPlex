const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const source = fs.readFileSync(path.join(__dirname, "../static/app.js"), "utf8");

function loadApp(search = "") {
  const context = vm.createContext({
    URL,
    URLSearchParams,
    document: {
      querySelector: () => null,
      documentElement: { dataset: {} },
    },
    window: {
      location: new URL(`https://streamplex.example/${search}`),
      addEventListener: () => {},
      clearInterval: () => {},
    },
  });
  vm.runInContext(source, context);
  return context;
}

test("accepts current and legacy Pluto channel links", () => {
  const { sanitizePlutoStreamId } = loadApp();
  for (const [input, expected] of [
    ["29262", "29262"],
    [" 29262 ", "29262"],
    ["https://pluto.tv/us/watch/live-tv/29262/", "29262"],
    ["https://www.pluto.tv/us/watch/live-tv/29262?referrer=copy-link#watch", "29262"],
    ["https://pluto.tv/us/live-tv/29262/", "29262"],
    ["5DA0C85BD2C9C10009370984", "5da0c85bd2c9c10009370984"],
    ["https://pluto.tv/us/live-tv/5da0c85bd2c9c10009370984", "5da0c85bd2c9c10009370984"],
    ["https://pluto.tv/us/watch/live-tv/5da0c85bd2c9c10009370984/", "5da0c85bd2c9c10009370984"],
  ]) assert.equal(sanitizePlutoStreamId(input), expected, input);
});

test("rejects invalid IDs, unrelated routes, and lookalike hosts", () => {
  const { sanitizePlutoStreamId } = loadApp();
  for (const input of [
    "", "0", "-29262", "29262.5", "naruto", "29262/extra",
    "https://pluto.tv.evil.example/us/watch/live-tv/29262/",
    "https://pluto.tv@evil.example/us/watch/live-tv/29262/",
    "https://pluto.tv/us/watch/live-tv/29262/extra",
    "https://pluto.tv/us/movies/29262/", "https://[",
    "javascript:alert(1)",
  ]) assert.equal(sanitizePlutoStreamId(input), "", input);
});

test("builds current URLs and preserves legacy redirect routes", () => {
  for (const [input, expected] of [
    ["29262", "https://pluto.tv/us/watch/live-tv/29262/"],
    ["https://pluto.tv/us/watch/live-tv/29262/", "https://pluto.tv/us/watch/live-tv/29262/"],
    ["5da0c85bd2c9c10009370984", "https://pluto.tv/us/live-tv/5da0c85bd2c9c10009370984/"],
    ["123456789012345678901234", "https://pluto.tv/us/live-tv/123456789012345678901234/"],
  ]) {
    const app = loadApp(`?pluto=${encodeURIComponent(input)}`);
    const stream = app.parseInitialPlutoStream();
    assert.equal(stream.url, expected);
    const next = app.buildStreamUrl(["channel_one", "channel_two"], stream);
    assert.equal(next.searchParams.get("pluto"), stream.streamId);
    assert.equal(next.searchParams.get("streams"), "channel_one,channel_two");
  }
  assert.equal(loadApp("?pluto=invalid").parseInitialPlutoStream(), null);
});

const plutoSource = fs.readFileSync(path.join(__dirname, "../static/pluto.js"), "utf8");
function loadPluto(overrides = {}) {
  const context = vm.createContext({ URL, URLSearchParams, navigator: {}, ...overrides });
  vm.runInContext(plutoSource, context);
  return context.StreamplexPluto;
}

test("maps Naruto's new ID and fails explicitly for unknown numeric IDs", () => {
  const pluto = loadPluto();
  assert.equal(pluto.resolveChannelId("29262"), "5da0c85bd2c9c10009370984");
  assert.equal(pluto.resolveChannelId("5DA0C85BD2C9C10009370984"), "5da0c85bd2c9c10009370984");
  for (const id of ["12345", "constructor", "__proto__", "", "naruto"]) {
    assert.throws(() => pluto.resolveChannelId(id), /not mapped/);
  }
});

test("requests a fresh anonymous ad-supported session with privacy preference", () => {
  const pluto = loadPluto({ navigator: { doNotTrack: "1" } });
  const url = pluto.buildSessionUrl("5da0c85bd2c9c10009370984", "test-client");
  assert.equal(url.origin, "https://boot.pluto.tv");
  assert.equal(url.searchParams.get("serverSideAds"), "true");
  assert.equal(url.searchParams.get("deviceDNT"), "true");
  assert.equal(url.searchParams.get("clientID"), "test-client");
  assert.equal(url.searchParams.get("channelID"), "5da0c85bd2c9c10009370984");
});

function sessionFixture() {
  return {
    EPG: [{ id: "5da0c85bd2c9c10009370984", name: "Naruto", stitched: { path: "/stitch/hls/channel/5da0c85bd2c9c10009370984/master.m3u8" } }],
    servers: { stitcher: "https://example.prd.pluto.tv" },
    stitcherParams: "sessionID=fresh-session&serverSideAds=true",
    sessionToken: "test-token-not-a-real-credential",
  };
}

test("uses the returned server and propagates the session into child playlists", () => {
  const pluto = loadPluto();
  const boot = sessionFixture();
  const result = pluto.parseSession(boot, boot.EPG[0].id);
  const url = new URL(result.url);
  assert.equal(result.name, "Naruto");
  assert.equal(url.origin, boot.servers.stitcher);
  assert.equal(url.pathname, `/v2${boot.EPG[0].stitched.path}`);
  assert.equal(url.searchParams.get("jwt"), boot.sessionToken);
  assert.equal(url.searchParams.get("masterJWTPassthrough"), "true");
  assert.equal(url.searchParams.get("sessionID"), "fresh-session");
  assert.equal(url.searchParams.get("serverSideAds"), "true");
  boot.EPG[0].stitched = { paths: [{ type: "hls", path: boot.EPG[0].stitched.path }] };
  assert.equal(pluto.parseSession(boot, boot.EPG[0].id).url, result.url);
});

test("never plays Pluto's fallback channel or trusts an unrelated playback host", () => {
  const pluto = loadPluto();
  assert.throws(() => pluto.parseSession(sessionFixture(), "missing-channel"), /did not return/);
  for (const host of ["http://example.pluto.tv", "https://pluto.tv.evil.example", "https://evil.example"]) {
    const boot = sessionFixture();
    boot.servers.stitcher = host;
    assert.throws(() => pluto.parseSession(boot, boot.EPG[0].id), /unsupported/);
  }
  const boot = sessionFixture();
  boot.EPG[0].stitched.path = "//evil.example/master.m3u8";
  assert.throws(() => pluto.parseSession(boot, boot.EPG[0].id), /unsupported/);
});

function playerHarness(fetchImpl = async () => ({ ok: true, json: async () => sessionFixture() }), overrides = {}) {
  class Element {
    constructor(tag) { this.tag = tag; this.listeners = {}; this.attributes = {}; this.hidden = false; this.paused = true; }
    setAttribute(name, value) { this.attributes[name] = value; }
    removeAttribute(name) { delete this.attributes[name]; }
    hasAttribute(name) { return Object.hasOwn(this.attributes, name); }
    addEventListener(name, fn) { (this.listeners[name] ||= []).push(fn); }
    emit(name) { this.listeners[name]?.forEach((fn) => fn()); }
    append(...children) { this.children = children; }
    replaceChildren(...children) { this.children = children; }
    // Intentionally claims native support, as Chrome did in real testing.
    canPlayType() { return "maybe"; }
    play() { this.paused = false; return Promise.resolve(); }
    pause() { this.paused = true; }
    load() {}
  }
  const instances = [];
  class Hls {
    static isSupported() { return true; }
    static Events = { ERROR: "error" };
    constructor(config) { this.config = config; instances.push(this); }
    on(_event, handler) { this.onError = handler; }
    loadSource(url) { this.url = url; }
    attachMedia(video) { this.video = video; }
    destroy() { this.destroyed = true; }
  }
  let timerSequence = 0;
  const timers = new Map();
  const requests = [];
  const api = loadPluto({
    Hls, AbortController, crypto: { randomUUID: () => "test-uuid" },
    document: { createElement: (tag) => new Element(tag) },
    setTimeout: (fn, ms) => { const id = ++timerSequence; timers.set(id, { fn, ms }); return id; },
    clearTimeout: (id) => timers.delete(id),
    fetch: (...args) => { requests.push(args); return fetchImpl(...args); },
    ...overrides,
  });
  const shell = new Element("div");
  const flush = async () => { for (let i = 0; i < 15; i++) await Promise.resolve(); };
  const fireTimer = (ms) => {
    const entry = [...timers].find(([, timer]) => timer.ms === ms);
    assert.ok(entry, `expected a ${ms}ms timer`);
    timers.delete(entry[0]);
    entry[1].fn();
  };
  return { api, shell, instances, timers, requests, flush, fireTimer };
}

test("prefers HLS.js over an unreliable native-support claim and cleans up", async () => {
  const h = playerHarness();
  const dispose = h.api.mount(h.shell, "29262");
  await h.flush();
  const [video, notice] = h.shell.children;
  assert.equal(h.instances.length, 1);
  assert.equal(h.instances[0].video, video);
  assert.equal(video.src, undefined, "Chrome's native HLS must not be selected");
  assert.equal(video.muted, true);
  assert.equal(video.controls, true);
  assert.equal(h.requests[0][1].credentials, "omit");
  video.emit("playing");
  assert.equal(notice.hidden, true);
  assert.equal(h.timers.size, 1, "session refresh remains scheduled after playing");
  assert.equal(h.instances[0].config.backBufferLength, 30);
  dispose();
  assert.equal(h.instances[0].destroyed, true);
  assert.equal(h.requests[0][1].signal.aborted, true);
  assert.equal(h.timers.size, 0);
});

test("fatal playback failures reconnect at most twice before showing retry", async () => {
  const h = playerHarness();
  const dispose = h.api.mount(h.shell, "29262");
  await h.flush();
  h.instances[0].onError(null, { fatal: true });
  h.fireTimer(1500);
  await h.flush();
  h.instances[1].onError(null, { fatal: true });
  h.fireTimer(3000);
  await h.flush();
  h.instances[2].onError(null, { fatal: true });
  assert.equal(h.instances.length, 3);
  assert.equal(h.timers.size, 0);
  const [, notice] = h.shell.children;
  assert.equal(notice.hidden, false);
  assert.equal(notice.children[1].hidden, false);
  assert.match(notice.children[0].textContent, /interrupted/);
  assert.match(notice.children[0].textContent, /^Naruto:/);
  notice.children[1].emit("click");
  await h.flush();
  assert.equal(h.instances.length, 4);
  dispose();
});

test("startup timeout invalidates late network responses", async () => {
  let resolve;
  const h = playerHarness(() => new Promise((r) => { resolve = r; }));
  const dispose = h.api.mount(h.shell, "29262");
  h.fireTimer(30000);
  assert.match(h.shell.children[1].children[0].textContent, /^Pluto TV \(29262\):/);
  resolve({ ok: true, json: async () => sessionFixture() });
  await h.flush();
  assert.equal(h.instances.length, 0, "stale response must not attach a player");
  dispose();
  assert.equal(h.timers.size, 0);
});

test("unmapped numeric ID shows an actionable error without fetching", async () => {
  const h = playerHarness();
  const dispose = h.api.mount(h.shell, "999999");
  await h.flush();
  assert.equal(h.requests.length, 0);
  assert.equal(h.timers.size, 0);
  assert.match(h.shell.children[1].children[0].textContent, /not mapped/);
  assert.match(h.shell.children[1].children[0].textContent, /^Pluto TV \(999999\):/);
  assert.equal(h.shell.children[1].children[1].hidden, false);
  dispose();
});

test("refresh uses Pluto's interval and renews without losing manual pause", async () => {
  const fixture = sessionFixture(); fixture.refreshInSec = 100;
  const h = playerHarness(async () => ({ ok: true, json: async () => fixture }));
  const dispose = h.api.mount(h.shell, "29262");
  await h.flush();
  const video = h.shell.children[0];
  video.readyState = 4; video.currentSrc = "blob:test"; video.emit("playing");
  video.pause(); video.emit("pause");
  h.fireTimer(90000);
  await h.flush();
  assert.equal(h.requests.length, 2);
  assert.equal(h.instances[0].destroyed, true);
  assert.equal(video.paused, true);
  assert.equal(h.instances[1].config.backBufferLength, 30);
  dispose();
  assert.equal(h.timers.size, 0);
});

test("native Safari playback does not load or require the external HLS script", async () => {
  const h = playerHarness(undefined, { navigator: { userAgent: "Version/18.0 Safari/605.1.15" }, Hls: undefined });
  const dispose = h.api.mount(h.shell, "29262");
  await h.flush();
  assert.match(h.shell.children[0].src, /^https:\/\/example.prd.pluto.tv/);
  assert.equal(h.instances.length, 0);
  dispose();
});

test("refresh interval is bounded for missing and malformed service data", () => {
  const pluto = loadPluto();
  for (const value of [null, undefined, "not-a-number", -1, 0]) {
    const fixture = sessionFixture(); fixture.refreshInSec = value;
    assert.equal(pluto.parseSession(fixture, fixture.EPG[0].id).refreshMs, 14400000);
  }
});
