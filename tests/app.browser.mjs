// Deterministic browser integration checks: real DOM/layout, fake provider SDKs.
// Run with Node 22+, a local HTTP server, and disposable Chrome on CDP port 9222.
import assert from "node:assert/strict";
const endpoint = process.env.CDP_URL || "http://127.0.0.1:9222";
const base = process.env.STREAMPLEX_URL || "http://127.0.0.1:8000/";
const version = await (await fetch(`${endpoint}/json/version`)).json();
const ws = new WebSocket(version.webSocketDebuggerUrl);
await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
let sequence = 0;
const pending = new Map();
const exceptions = [];
ws.onmessage = ({ data }) => {
  const message = JSON.parse(data);
  if (pending.has(message.id)) {
    const p = pending.get(message.id); pending.delete(message.id); clearTimeout(p.timer);
    message.error ? p.reject(new Error(message.error.message)) : p.resolve(message.result);
  } else if (message.method === "Runtime.exceptionThrown") exceptions.push(message.params.exceptionDetails.exception?.description || message.params.exceptionDetails.text);
};
function send(method, params = {}, sessionId) {
  return new Promise((resolve, reject) => {
    const id = ++sequence;
    const timer = setTimeout(() => { pending.delete(id); reject(Error(`${method} timed out`)); }, 30000);
    pending.set(id, { resolve, reject, timer }); ws.send(JSON.stringify({ id, method, params, sessionId }));
  });
}
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
function fixtures() {
  window.fakeInstances = [];
  window.fakePlutoDisposals = 0;
  window.fakeStalledChannels = new Set();
  // Exercise the actual watchdog and scheduled poll callbacks without waiting
  // thirty seconds or five minutes. All other browser timers run normally.
  const nativeSetTimeout = window.setTimeout.bind(window);
  const nativeClearTimeout = window.clearTimeout.bind(window);
  const controlledTimers = new Map();
  window.setTimeout = (callback, delay, ...args) => {
    if (delay !== 30000 && delay !== 300000) return nativeSetTimeout(callback, delay, ...args);
    const invoke = () => { controlledTimers.delete(id); return callback(...args); };
    const id = nativeSetTimeout(invoke, delay);
    controlledTimers.set(id, invoke);
    return id;
  };
  window.clearTimeout = (id) => { controlledTimers.delete(id); nativeClearTimeout(id); };
  window.fireControlledTimer = (id) => {
    const invoke = controlledTimers.get(id);
    if (!invoke) throw Error(`Timer ${id} is not active`);
    nativeClearTimeout(id);
    return invoke();
  };
  class Player {
    constructor(id, options) {
      this.options = options;
      this.channel = options.channel; this.events = new Map(); this.muted = true; this.volume = 0.5;
      this.quality = "auto"; this.paused = true; this.plays = 0; this.destroyed = false;
      this.iframe = document.createElement("iframe"); this.iframe.src = "about:blank";
      document.getElementById(id).append(this.iframe);
      this.leaky = () => {}; this.forward = () => {};
      window.addEventListener("message", this.leaky); window.addEventListener("message", this.forward);
      window.fakeInstances.push(this);
      setTimeout(() => { this.emit("ready"); this.emit("online"); }, 20);
    }
    addEventListener(event, fn) { if (!this.events.has(event)) this.events.set(event, new Set()); this.events.get(event).add(fn); }
    removeEventListener(event, fn) { this.events.get(event)?.delete(fn); }
    emit(event) { this.events.get(event)?.forEach((fn) => fn()); }
    play() {
      this.plays++; this.paused = false; this.emit("play");
      if (!window.fakeStalledChannels.has(this.channel)) this.emit("playing");
    }
    pause() { this.paused = true; this.emit("pause"); }
    isPaused() { return this.paused; }
    getQualities() { return [{ group: "auto" }, { group: "720p60" }, { group: "480p30" }]; }
    getQuality() { return this.quality; }
    setQuality(value) { this.quality = value; }
    setMuted(value) { this.audioWrites = (this.audioWrites || 0) + 1; this.muted = value; }
    getMuted() { return this.muted; }
    setVolume(value) { this.audioWrites = (this.audioWrites || 0) + 1; this.volume = value; }
    getVolume() { return this.volume; }
    destroy() { this.destroyed = true; this.events.clear(); window.removeEventListener("message", this.forward); this.iframe.remove(); }
  }
  for (const event of ["READY", "ONLINE", "OFFLINE", "PLAYING", "PLAY", "PAUSE", "ERROR", "PLAYBACK_BLOCKED"]) Player[event] = event.toLowerCase();
  window.Twitch = window.fakeSDK = { Player };
  window.StreamplexPluto = { mount(shell, id, callbacks) {
    const video = document.createElement("video"); video.className = "pluto-video"; video.muted = true;
    video.controls = true;
    shell.replaceChildren(video); callbacks.onReady?.(); callbacks.onChannelName?.("Naruto");
    return () => { window.fakePlutoDisposals++; };
  } };
  const fetch = window.fetch.bind(window);
  window.fetch = (url, options) => String(url).includes("static-cdn.jtvnw.net")
    ? Promise.resolve({ ok: true, status: 200, url: String(url) }) : fetch(url, options);
}
let context;
try {
  context = await send("Target.createBrowserContext");
  const { targetId } = await send("Target.createTarget", { url: "about:blank", browserContextId: context.browserContextId });
  const { sessionId } = await send("Target.attachToTarget", { targetId, flatten: true });
  const run = async (expression, commandLine = false) => {
    const result = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true, includeCommandLineAPI: commandLine }, sessionId);
    if (result.exceptionDetails) throw Error(result.exceptionDetails.exception?.description);
    return result.result.value;
  };
  const wait = async (expression) => {
    for (let i = 0; i < 100; i++) { if (await run(expression)) return; await pause(100); }
    throw Error(`Condition timed out: ${expression}; ${await run("document.body.innerText")}`);
  };
  const resize = (width, height) => send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: false }, sessionId);
  const assertFits = async (count) => {
    const layout = await run(`(() => {
      const tiles = [...document.querySelectorAll('.stream-tile:not([hidden])')];
      return {count:tiles.length, width:innerWidth, height:innerHeight,
        pageWidth:document.documentElement.scrollWidth, pageHeight:document.documentElement.scrollHeight,
        fits:tiles.every(t=>{const r=t.getBoundingClientRect();const s=t.querySelector('.player-shell').getBoundingClientRect();
          const frame=t.querySelector('iframe');const f=frame?.getBoundingClientRect();
          const fullTile=!t.querySelector('header') && Math.abs(s.top-r.top-1)<1 && Math.abs(s.bottom-r.bottom+1)<1;
          const playerFits=!frame || (frame.clientWidth>=400 && frame.clientHeight>=300 &&
            f.left>=s.left-0.5 && f.top>=s.top-0.5 && Math.abs(f.right-s.right)<1 && Math.abs(f.bottom-s.bottom)<1);
          return fullTile && playerFits && r.left>=0 && r.top>=0 && r.right<=innerWidth+0.5 && r.bottom<=innerHeight+0.5 && s.width>0 && s.height>0;})};
    })()`);
    assert.equal(layout.count, count, JSON.stringify(layout));
    assert.equal(layout.fits, true, JSON.stringify(layout));
    assert.ok(layout.pageWidth <= layout.width, JSON.stringify(layout));
    assert.ok(layout.pageHeight <= layout.height, JSON.stringify(layout));
  };
  const listeners = () => run("(getEventListeners(window).message || []).length", true);
  await send("Page.enable", {}, sessionId); await send("Runtime.enable", {}, sessionId); await send("Network.enable", {}, sessionId);
  await send("Page.addScriptToEvaluateOnNewDocument", { source: `(${fixtures})()` }, sessionId);
  await resize(1280, 720);
  await send("Page.navigate", { url: new URL("?streams=one,two&pluto=29262", base).href }, sessionId);
  await wait("typeof players!=='undefined' && players.size===2 && [...players.values()].every(p=>p.quality==='480p30')");
  await run("window.originalOne=players.get('one');window.originalPluto=document.querySelector('.pluto-video')");
  assert.equal(await run("[...players.values()].every(p=>p.options.autoplay===true && p.options.muted===true)"), true);
  assert.equal(await listeners(), 4);
  assert.equal(await run("[...players.values()].every(p=>p.muted) && originalPluto.muted && originalPluto.controls && !document.querySelector('.stream-name,[data-audio-channel]') && document.querySelector('[data-channel-pill=\"pluto-29262\"] .channel-pill-label').textContent==='Naruto' && !!document.querySelector('.channel-pill .channel-pill-open')"), true);
  console.log("PASS native controls, channel names and Open link in the shared bar; all players start muted without tile headers");
  await run("originalOne.pause(); originalOne.quality='720p60'; originalOne.emit('playing')");
  for (const [w, h] of [[390,844], [1280,720], [1920,1080]]) {
    await resize(w, h); await pause(150);
    assert.equal(await run("originalOne.paused && originalOne.quality==='720p60'"), true);
    await assertFits(3);
  }
  console.log("PASS all tiles fit the viewport; resize preserves manual pause and quality");
  await run("window.resizePlays=originalOne.plays;streamViews.get('one').tile.style.cssText='flex:none;width:233.5px;height:145.25px'");
  await pause(150);
  assert.equal(await run(`(() => {const v=streamViews.get('one'),s=v.shell.getBoundingClientRect(),f=v.playerMount.getBoundingClientRect();return Math.abs(s.width-f.width)<1 && Math.abs(s.height-f.height)<1 && originalOne.plays===resizePlays && originalOne.paused;})()`), true);
  await run("streamViews.get('one').tile.style.cssText='';syncGridLayout()");
  console.log("PASS independent fractional tile resize updates zoom without issuing play commands");
  for (const [w, h] of [[320,568], [390,844], [844,390], [1280,720], [1920,1080]]) {
    await resize(w, h);
    for (const count of [1,2,4,6,9,16,36]) {
      await run(`navigateToChannels(Array.from({length:${count - 1}},(_,i)=>'layout'+i))`);
      await wait(`players.size===${count - 1} && [...streamViews.values()].filter(v=>!v.tile.hidden).length===${count}`);
      await pause(100);
      await assertFits(count);
    }
  }
  // Restore the original fixture before the lifecycle/audio checks below.
  await run("navigateToChannels(['one','two'])");
  await wait("players.size===2 && [...players.values()].every(p=>p.quality==='480p30')");
  await run("window.originalOne=players.get('one');originalOne.pause()");
  assert.equal(await run("document.querySelector('.pluto-video')===originalPluto && fakePlutoDisposals===0"), true);
  console.log("PASS 1–36 mixed-provider tiles at five viewport sizes: no page scrolling or clipped videos");
  await run("originalOne.setMuted(false);originalOne.setVolume(0.23);players.get('two').setMuted(false);players.get('two').setVolume(0.7);originalPluto.muted=false;originalPluto.volume=0.31;window.audioWritesBeforePoll=[...players.values()].map(p=>p.audioWrites)");
  await run("runPollCycle()"); await pause(1100);
  assert.equal(await run("originalOne.volume===0.23 && originalOne.paused && !originalOne.muted && !players.get('two').muted && players.get('two').volume===0.7 && !originalPluto.muted && originalPluto.volume===0.31 && [...players.values()].every((p,i)=>p.audioWrites===audioWritesBeforePoll[i])"), true);
  console.log("PASS independent native audio and volume; polling sends no audio commands or forced playback");
  for (let i = 0; i < 5; i++) {
    await run("navigateToChannels(['one','two','three'])"); await wait("players.has('three') && streamViews.get('three').ready");
    await run("navigateToChannels(['one','two'])");
    assert.equal(await listeners(), 4);
    assert.equal(await run("players.get('one')===originalOne && document.querySelector('.pluto-video')===originalPluto && fakePlutoDisposals===0"), true);
  }
  console.log("PASS add/remove preserves existing players; SDK listeners do not accumulate");
  await run("history.back()"); await wait("currentChannels.includes('three') && players.has('three')");
  await run("history.forward()"); await wait("!currentChannels.includes('three') && !players.has('three')");
  assert.equal(await run("players.get('one')===originalOne"), true);
  console.log("PASS browser Back/Forward reconciles URL without restarting retained players");
  await run("renderPlutoStream(streamViews.get('pluto-29262'))"); await pause(100);
  assert.equal(await run("document.querySelector('.pluto-video')!==originalPluto && !document.querySelector('.pluto-video').muted && document.querySelector('.pluto-video').volume===0.31"), true);
  console.log("PASS Pluto remount preserves native mute and volume preferences");
  await run("originalOne.emit('offline')");
  assert.equal(await run("streamViews.get('one').tile.hidden && players.get('one')===originalOne"), true);
  await run("originalOne.emit('online')");
  assert.equal(await run("!streamViews.get('one').tile.hidden && originalOne.paused"), true);
  console.log("PASS offline/online events reuse the selected player and preserve pause");
  await run("originalOne.play();window.failedPlayer=players.get('one');failedPlayer.emit('error');window.failureChannel=document.querySelector('.notice-channel')?.textContent");
  assert.equal(await run("failureChannel"), "one");
  await wait("players.has('one') && players.get('one')!==failedPlayer && streamViews.get('one').ready && !streamViews.get('one').tile.hidden");
  assert.equal(await run("failedPlayer.destroyed && !streamViews.get('one').playbackError && !players.get('one').paused && !players.get('one').muted && players.get('one').volume===0.23"), true);
  console.log("PASS a transient Twitch error automatically restores playback");
  await run(`window.previewFetch=window.fetch;window.fetch=(url,options)=>String(url).includes('live_user_one-')
    ? Promise.resolve({ok:false,status:404,url:String(url)}) : previewFetch(url,options);
    players.get('one').emit('error')`);
  await wait("streamViews.get('one').tile.hidden && !players.has('one') && streamViews.get('one').tile.dataset.live==='false'");
  await run("window.fetch=previewFetch;runPollCycle()");
  await wait("players.has('one') && streamViews.get('one').ready && !streamViews.get('one').tile.hidden");
  console.log("PASS a failed offline stream disappears and the next poll restores it when live");
  await run("window.healthyPlayer=players.get('two');fakeStalledChannels.add('timeout');navigateToChannels(['one','two','timeout'])");
  await wait("streamViews.get('timeout')?.ready && !streamViews.get('timeout').hasPlayed && !pollInFlight");
  await run("fireControlledTimer(streamViews.get('timeout').startupTimer)");
  await wait("fakeInstances.filter(p=>p.channel==='timeout').length===2 && streamViews.get('timeout').ready");
  await run("fireControlledTimer(streamViews.get('timeout').startupTimer)");
  await pause(150);
  assert.equal(await run("streamViews.get('timeout').playbackError && !players.has('timeout') && streamViews.get('timeout').notice.textContent.includes('Twitch did not start') && streamViews.get('timeout').notice.querySelector('.notice-channel').textContent==='timeout' && fakeInstances.filter(p=>p.channel==='timeout').length===2"), true);
  await run("fakeStalledChannels.delete('timeout');fireControlledTimer(pollTimer)");
  await wait("streamViews.get('timeout').hasPlayed && !streamViews.get('timeout').playbackError && players.has('timeout')");
  assert.equal(await run("fakeInstances.filter(p=>p.channel==='timeout').length===3 && players.get('two')===healthyPlayer"), true);
  assert.equal(await listeners(), 6);
  console.log("PASS startup timeout retries once, repeated timeout waits, and the scheduled poll recovers without disturbing healthy players or leaking listeners");
  await run("navigateToChannels([]); delete window.Twitch");
  assert.equal(await listeners(), 0);
  await send("Network.setBlockedURLs", { urls: ["*player.twitch.tv*"] }, sessionId);
  await run("navigateToChannels(['failure'])");
  await wait("document.querySelector('.player-notice')?.innerText.includes('Retry playback')");
  assert.equal(await run("document.querySelector('.notice-channel').textContent"), "failure");
  await run("window.Twitch=window.fakeSDK;document.querySelector('.player-notice button').click()");
  await wait("players.has('failure') && streamViews.get('failure').ready");
  await run("players.get('failure').emit('playback_blocked')");
  // Fixture event constants use the underscore form of PLAYBACK_BLOCKED.
  assert.equal(await run("document.querySelector('.notice-channel').textContent"), "failure");
  await run("document.querySelector('.player-notice button').click()");
  console.log("PASS SDK failure shows actionable retry and recovers without reloading the page");
  for (const [w, h] of [[390,844], [844,390], [1280,720]]) {
    await resize(w, h);
    for (const count of [1,6,36]) {
      await run(`navigateToChannels(Array.from({length:${count}},(_,i)=>'layout'+i),null)`);
      await wait(`players.size===${count} && [...streamViews.values()].every(v=>!v.tile.hidden)`);
      await pause(100);
      await assertFits(count);
    }
  }
  console.log("PASS Twitch-only layouts also fit without scrolling");
  await run("players.get('layout0').pause();teardownPlayer('layout0');renderLiveStream('layout0');syncGridLayout()");
  await wait("players.has('layout0') && streamViews.get('layout0').ready");
  assert.equal(await run("players.get('layout0').options.autoplay===false && players.get('layout0').paused && players.get('layout0').plays===0 && streamViews.get('layout0').startupTimer===null"), true);
  console.log("PASS intentional pause also survives provider remount without an autoplay timeout");
  await run("navigateToChannels(['reloadone','reloadtwo'],makePlutoStream('29262'))");
  await wait("players.size===2 && [...streamViews.values()].filter(v=>v.stream.provider==='twitch').every(v=>v.ready)");
  await run("players.get('reloadone').setMuted(false);players.get('reloadone').setVolume(0.42);document.querySelector('.pluto-video').muted=false;document.querySelector('.pluto-video').volume=0.27");
  await run("runPollCycle()");
  assert.equal(await run("!players.get('reloadone').muted && players.get('reloadone').volume===0.42 && !document.querySelector('.pluto-video').muted && document.querySelector('.pluto-video').volume===0.27"), true);
  await send("Page.reload", { ignoreCache: true }, sessionId);
  await wait("typeof players!=='undefined' && players.size===2 && [...players.values()].every(p=>streamViews.get(p.channel).ready)");
  assert.equal(await run("[...players.values()].every(p=>p.muted && p.options.muted===true) && document.querySelector('.pluto-video').muted"), true);
  await assertFits(3);
  console.log("PASS polling preserves native audio; browser reload starts both providers muted");
  assert.deepEqual(exceptions, []);
} finally {
  if (context) await send("Target.disposeBrowserContext", context);
  ws.close();
}
