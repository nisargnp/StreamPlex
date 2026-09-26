const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const test = require("node:test");
const source = fs.readFileSync(require("node:path").join(__dirname, "../static/app.js"), "utf8");
function load(overrides = {}) {
  const timers = new Map(); let sequence = 0;
  const context = vm.createContext({
    URL, URLSearchParams, AbortController,
    document: { querySelector: () => null, documentElement: { dataset: {} } },
    window: {
      location: new URL("https://streamplex.example/"), addEventListener() {}, removeEventListener() {},
      setTimeout(fn) { const id = ++sequence; timers.set(id, fn); return id; }, clearTimeout(id) { timers.delete(id); },
      setInterval() { return 1; }, clearInterval() {},
    }, ...overrides,
  });
  vm.runInContext(source, context);
  return context;
}

test("quality selection accepts current objects and legacy strings", () => {
  const app = load();
  for (const qualities of [[{ group: "auto" }, { group: "720p60" }, { group: "480p30" }], ["auto", "480p30", "720p60"]]) {
    let selected;
    assert.equal(app.applyPlayerQualityPreference({ getQuality: () => "auto", getQualities: () => qualities, setQuality: (value) => selected = value }), true);
    assert.equal(selected, "480p30");
  }
  assert.equal(app.pickPreferredQuality(["720p60", "360p30"]), "360p30");
  assert.equal(app.pickPreferredQuality(["1080p60", "720p30"]), "720p30");
  assert.equal(app.pickPreferredQuality(["auto"]), null);
});

test("initial quality selection does not override later manual choices", () => {
  const app = load(); let changes = 0;
  const view = {};
  const player = { getQuality: () => "auto", getQualities: () => ["480p30"], setQuality() { changes++; } };
  app.initializePlayerQuality(view, player);
  app.initializePlayerQuality(view, player);
  assert.equal(changes, 1);
});

test("403, network errors, and unreadable previews are unknown, not offline", async () => {
  for (const fetch of [async () => { throw Error("offline network"); }, async () => ({ ok: false, status: 403 }), async () => ({ type: "opaque" })]) {
    const app = load({ fetch });
    assert.equal(await app.probeStreamPreview("channel"), "unknown");
  }
  assert.equal(await load({ fetch: async () => ({ status: 404, ok: false }) }).probeStreamPreview("channel"), "offline");
  assert.equal(await load({ fetch: async () => ({ status: 200, ok: true, url: "https://cdn.example/ttv-static/403_preview.jpg" }) }).probeStreamPreview("channel"), "unknown");
  assert.equal(await load({ fetch: async () => ({ status: 200, ok: true, url: "https://cdn.example/404_preview.jpg" }) }).probeStreamPreview("channel"), "offline");
});

test("image fallback never treats a valid placeholder image as proof of live", async () => {
  class Image { set src(value) { this.currentSrc = value; this.naturalWidth = 440; this.naturalHeight = 248; this.onload(); } }
  const app = load({ Image });
  assert.equal(await app.probeStreamPreviewViaImage("https://cdn.example/preview.jpg"), "unknown");
});

test("paused players stay paused when playback is requested", () => {
  const app = load(); let plays = 0;
  vm.runInContext(`streamViews.set('channel',{ready:true,userPaused:true,tile:{hidden:false}})`, app);
  app.requestPlayerPlayback("channel", { play() { plays++; } });
  assert.equal(plays, 0);
  vm.runInContext(`streamViews.get('channel').userPaused=false`, app);
  app.requestPlayerPlayback("channel", { play() { plays++; } });
  assert.equal(plays, 1);
});

test("audio toggles off, preserves volume, and never calls play", () => {
  const app = load();
  const player = { muted: true, volume: 0.5, getVolume() { return this.volume; }, setMuted(v) { this.muted = v; }, setVolume(v) { this.volume = v; }, play() { throw Error("audio must not play"); } };
  app.player = player;
  vm.runInContext(`players.set('channel',player);streamViews.set('channel',{ready:true,stream:{provider:'twitch'}})`, app);
  app.setActiveAudioChannel("channel");
  player.volume = 0.23;
  app.setActiveAudioChannel("channel");
  assert.equal(player.muted, true);
  app.setActiveAudioChannel("channel");
  assert.equal(player.muted, false);
  assert.equal(player.volume, 0.23);
});

test("grids fit every tile inside the viewport, shrinking gutters for dense layouts", () => {
  const app = load();
  for (const [width, height] of [[1267,635], [377,760], [830,300], [1907,995], [120,80]]) {
    for (const count of [1,2,3,4,6,9,16,36,100]) {
      const grid = app.chooseBestGrid(count, width, height, 6.4);
      const tileWidth = Math.floor((width - grid.gap * (grid.columns - 1)) / grid.columns);
      const tileHeight = Math.floor((height - grid.gap * (grid.rows - 1)) / grid.rows);
      assert.ok(grid.rows * grid.columns >= count);
      assert.ok(tileWidth > 0 && tileHeight > 0);
      assert.ok(tileWidth * grid.columns + grid.gap * (grid.columns - 1) <= width);
      assert.ok(tileHeight * grid.rows + grid.gap * (grid.rows - 1) <= height);
    }
  }
});

test("add prompt accepts Twitch URLs and Pluto/full selection URLs", () => {
  const app = load();
  assert.deepEqual([...app.parseChannels("https://www.twitch.tv/shroud")], ["shroud"]);
  const added = app.parseAddedSelection("https://streamplex.example/?streams=a,b&pluto=29262");
  assert.deepEqual([...added.channels], ["a", "b"]);
  assert.equal(added.pluto.streamId, "29262");
  assert.equal(app.parseAddedSelection("https://pluto.tv/us/watch/live-tv/29262/").pluto.streamId, "29262");
});

test("Twitch internal viewport meets minimums while the whole player fits its tile", () => {
  const app = load();
  for (const [width,height] of [[375,105.875],[1280,720],[80,40],[437.5,210.25],[200,800]]) {
    const viewport = app.getTwitchViewport(width,height);
    assert.ok(viewport.width>=400 && viewport.height>=300);
    assert.ok(viewport.scale>0 && viewport.scale<=1);
    assert.ok(viewport.width*viewport.scale<=width+1e-8);
    assert.ok(viewport.height*viewport.scale<=height+1e-8);
    assert.ok(width-viewport.width*viewport.scale<1);
    assert.ok(height-viewport.height*viewport.scale<1);
  }
  assert.equal(app.getTwitchViewport(0,300),null);
  assert.equal(app.getTwitchViewport(400,0),null);
});

test("Twitch resize only changes zoom geometry, and disposal disconnects observation", () => {
  const app = load();
  const style = {};
  let disconnected = false;
  const view = {tile:{hidden:false},playerMount:{style},shell:{getBoundingClientRect:()=>({width:375,height:106}),querySelector:()=>null},playerResizeObserver:{disconnect(){disconnected=true;}}};
  app.syncTwitchPlayerSize(view);
  assert.ok(Number(style.zoom)<1);
  assert.equal(style.transform,undefined);
  app.view = view;
  vm.runInContext("streamViews.set('channel',view)",app);
  app.teardownPlayer('channel');
  assert.equal(disconnected,true);
  assert.equal(view.playerMount,null);
});

test("SDK constructor capture is restored and exact listeners are removed", () => {
  const app = load(); const removed = []; const before = app.window.addEventListener;
  app.window.removeEventListener = (type, callback) => removed.push(callback);
  const view = { shell: { querySelector: () => null }, playerEvents: [] };
  class Player {
    constructor() { this.listener = () => {}; app.window.addEventListener("message", this.listener); }
    destroy() { this.destroyed = true; }
  }
  const p = app.createTwitchPlayer({ Player }, "mount", {}, view);
  assert.equal(app.window.addEventListener, before);
  app.view = view; app.p = p;
  vm.runInContext(`streamViews.set('channel',view);players.set('channel',p)`, app);
  app.teardownPlayer("channel");
  assert.equal(p.destroyed, true);
  assert.deepEqual(removed, [p.listener]);
  assert.throws(() => app.createTwitchPlayer({ Player: class { constructor() { throw Error("construction failed"); } } }, "mount", {}, view));
  assert.equal(app.window.addEventListener, before);
});

test("mounted players never depend on thumbnails for status", async () => {
  const app = load({ fetch: async () => { throw Error("must not probe a mounted player"); } });
  vm.runInContext(`streamViews.set('channel',{ready:true,stream:{provider:'twitch'},tile:{dataset:{}}});players.set('channel',{})`, app);
  assert.equal(await app.pollStreamStatuses(), true);
});

test("unknown checks are reported as incomplete, and stale checks cannot resurrect tiles", async () => {
  const app = load();
  vm.runInContext(`
    streamViews.set('channel',{stream:{provider:'twitch'},tile:{dataset:{}}});
    safelyProbeStreamPreview=async()=> 'unknown';
    renderLiveStream=()=>{};setChannelStatus=()=>{};syncGridLayout=()=>{};
  `, app);
  assert.equal(await app.pollStreamStatuses(), false);
  let resolve;
  app.pendingResult = new Promise((r) => { resolve = r; });
  vm.runInContext(`safelyProbeStreamPreview=()=>pendingResult;renderLiveStream=()=>{throw Error('stale result applied')}`, app);
  const polling = app.pollStreamStatuses();
  app.stopStatusPolling();
  resolve("live");
  assert.equal(await polling, false);
});

test("polling an errored Twitch tile hides it when offline and retries when status is unknown", async () => {
  const app = load();
  vm.runInContext(`
    const view = {stream:{provider:'twitch'},playbackError:true,tile:{hidden:false,dataset:{live:'pending',mountPending:'loading'}}};
    streamViews.set('channel',view);
    safelyProbeStreamPreview=async()=> 'offline';
    renderOfflineStream=()=>{view.tile.hidden=true;view.tile.dataset.live='false'};
    renderLiveStream=()=>{view.tile.hidden=false;view.tile.dataset.live='true';view.tile.dataset.mountPending='true'};
    setChannelStatus=()=>{};syncGridLayout=()=>{};
  `, app);
  assert.equal(await app.pollStreamStatuses(), true);
  assert.equal(vm.runInContext("view.tile.hidden && !view.playbackError", app), true);

  vm.runInContext("view.playbackError=true;view.tile.dataset.mountPending='loading';safelyProbeStreamPreview=async()=> 'unknown'", app);
  assert.equal(await app.pollStreamStatuses(), false);
  assert.equal(vm.runInContext("!view.tile.hidden && !view.playbackError && view.tile.dataset.mountPending==='true'", app), true);
});

test("an in-flight failure check cannot hide a stream after manual retry", async () => {
  const app = load();
  let finish;
  app.previewResult = new Promise((resolve) => { finish = resolve; });
  vm.runInContext(`
    const view = {stream:{provider:'twitch'},playbackError:true,mountGeneration:2,tile:{dataset:{}}};
    streamViews.set('channel',view);
    safelyProbeStreamPreview=()=>previewResult;
    renderOfflineStream=()=>{throw Error('stale failure check applied')};
  `, app);
  const checking = app.refreshUnmountedTwitchStream("channel", vm.runInContext("view", app), vm.runInContext("pollEpoch", app));
  vm.runInContext("view.playbackError=false", app);
  finish("offline");
  await checking;
});

test("repeated playback failures wait for polling after one immediate recovery attempt", () => {
  const app = load();
  vm.runInContext(`
    const view = {stream:{provider:'twitch'},tile:{hidden:false,dataset:{}},audioButton:{}};
    streamViews.set('channel',view);
    let recoveryChecks = 0;
    teardownPlayer=()=>{};showTwitchNotice=()=>{};setChannelStatus=()=>{};syncGridLayout=()=>{};
    refreshUnmountedTwitchStream=()=>{recoveryChecks++};
  `, app);
  app.showTwitchFailure("channel", "failed");
  app.showTwitchFailure("channel", "failed again");
  assert.equal(vm.runInContext("recoveryChecks", app), 1);
});
