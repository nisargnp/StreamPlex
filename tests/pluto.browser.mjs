// Opt-in real-network smoke test. Node 22+, local HTTP server, and a disposable
// Chrome launched with --remote-debugging-port=9222 are required. Never changes
// cookie/security settings; each run uses its own fresh browser context.
import assert from "node:assert/strict";

const endpoint = process.env.CDP_URL || "http://127.0.0.1:9222";
const appUrl = process.env.STREAMPLEX_URL || "http://127.0.0.1:8000/";
const version = await (await fetch(`${endpoint}/json/version`)).json();
const socket = new WebSocket(version.webSocketDebuggerUrl);
await new Promise((resolve, reject) => {
  socket.addEventListener("open", resolve, { once: true });
  socket.addEventListener("error", reject, { once: true });
});
let sequence = 0;
const pending = new Map();
const errors = [];
let bootRequests = 0;
socket.addEventListener("message", ({ data }) => {
  const message = JSON.parse(data);
  if (message.id) {
    const entry = pending.get(message.id);
    if (!entry) return;
    pending.delete(message.id);
    clearTimeout(entry.timer);
    if (message.error) entry.reject(new Error(message.error.message));
    else entry.resolve(message.result);
  } else if (message.method === "Runtime.exceptionThrown") {
    errors.push(message.params.exceptionDetails.text);
  } else if (message.method === "Network.requestWillBeSent" && message.params.request.url.startsWith("https://boot.pluto.tv/")) {
    bootRequests += 1;
  }
});
function send(method, params = {}, sessionId) {
  return new Promise((resolve, reject) => {
    const id = ++sequence;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`${method} timed out`)); }, 45000);
    pending.set(id, { resolve, reject, timer });
    socket.send(JSON.stringify({ id, method, params, sessionId }));
  });
}
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let context;
try {
  context = await send("Target.createBrowserContext");
  const target = await send("Target.createTarget", { url: "about:blank", browserContextId: context.browserContextId });
  const { sessionId } = await send("Target.attachToTarget", { targetId: target.targetId, flatten: true });
  const evaluate = async (expression) => {
    const result = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true }, sessionId);
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
    return result.result.value;
  };
  const waitFor = async (expression, description) => {
    const deadline = Date.now() + 45000;
    while (Date.now() < deadline) {
      if (await evaluate(expression)) return;
      await pause(500);
    }
    const diagnostic = await evaluate(`({text:document.body.innerText.slice(-600),video:[...document.querySelectorAll('video')].map(v=>({state:v.readyState,paused:v.paused,time:v.currentTime,error:v.error?.message})),playerLoaded:!!window.StreamplexPluto,hlsLoaded:!!window.Hls})`);
    throw new Error(`Timed out: ${description}; ${JSON.stringify(diagnostic)}`);
  };
  const resize = (width, height) => send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: false }, sessionId);
  const navigate = (id) => send("Page.navigate", { url: new URL(`?pluto=${id}`, appUrl).href }, sessionId);
  await send("Page.enable", {}, sessionId);
  await send("Runtime.enable", {}, sessionId);
  await send("Network.enable", {}, sessionId);
  await resize(1280, 720);
  await navigate("29262");
  await waitFor(`(() => {const v=document.querySelector('.pluto-video');return v?.readyState>=2&&!v.paused&&v.currentTime>0})()`, "real Pluto playback");
  await evaluate(`window.testVideo=document.querySelector('.pluto-video')`);
  let last = await evaluate(`({time:testVideo.currentTime,frames:testVideo.getVideoPlaybackQuality().totalVideoFrames})`);
  const initialRequests = bootRequests;
  assert.equal(await evaluate(`performance.getEntriesByType('resource').some(r=>r.name.includes('player.twitch.tv'))`), false, "Pluto-only pages must not download Twitch's SDK");
  for (const [width, height] of [[1280,720], [390,844], [1440,400], [1920,1080]]) {
    await resize(width, height);
    await pause(2500);
    const current = await evaluate(`(() => {
      const v=document.querySelector('.pluto-video');const r=v.getBoundingClientRect();const s=v.parentElement.getBoundingClientRect();
      return {same:v===testVideo,time:v.currentTime,frames:v.getVideoPlaybackQuality().totalVideoFrames,paused:v.paused,fit:getComputedStyle(v).objectFit,w:r.width,h:r.height,sw:s.width,sh:s.height,vw:v.videoWidth,vh:v.videoHeight,notice:!document.querySelector('.pluto-notice').hidden,iframes:document.querySelectorAll('iframe').length};
    })()`);
    assert.equal(current.same, true);
    assert.equal(current.paused, false);
    assert.ok(current.time > last.time, "playback time advances");
    assert.ok(current.frames > last.frames, "new video frames decode");
    assert.ok(current.vw > 0 && current.vh > 0);
    assert.equal(current.fit, "contain");
    assert.ok(Math.abs(current.w - current.sw) < 0.1 && Math.abs(current.h - current.sh) < 0.1);
    assert.equal(current.notice, false);
    assert.equal(current.iframes, 0);
    last = current;
    console.log(`PASS real playback + resize ${width}×${height}; time=${current.time.toFixed(2)}, decoded frames=${current.frames}`);
  }
  await evaluate(`document.querySelector('[data-provider="pluto"]').style.cssText='flex:none;width:437.5px;height:310.25px'`);
  await pause(1500);
  const fractional = await evaluate(`({same:testVideo===document.querySelector('.pluto-video'),time:testVideo.currentTime,video:testVideo.getBoundingClientRect().toJSON(),shell:testVideo.parentElement.getBoundingClientRect().toJSON()})`);
  assert.equal(fractional.same, true);
  assert.ok(fractional.time > last.time, JSON.stringify(fractional));
  assert.ok(Math.abs(fractional.video.width - fractional.shell.width) < 0.1, JSON.stringify(fractional));
  assert.ok(Math.abs(fractional.video.height - fractional.shell.height) < 0.1, JSON.stringify(fractional));
  assert.equal(bootRequests, initialRequests, "resizing must not create a new session");
  console.log("PASS independent fractional tile resize without restarting playback");

  await evaluate(`navigateToChannels(['streamplex_nonexistent_test']); window.retainedVideo=document.querySelector('.pluto-video')`);
  await pause(1500);
  await evaluate(`navigateToChannels([])`);
  assert.equal(await evaluate(`testVideo===document.querySelector('.pluto-video') && retainedVideo===testVideo`), true);
  assert.equal(bootRequests, initialRequests, "editing Twitch selection must not restart Pluto");
  console.log("PASS real Pluto video survives Twitch selection edits");

  const soakSeconds = Math.max(0, Number(process.env.SOAK_SECONDS) || 0);
  const soakEnd = Date.now() + soakSeconds * 1000;
  while (Date.now() < soakEnd) {
    await pause(Math.min(10000, soakEnd - Date.now()));
    const sample = await evaluate(`(() => {const v=document.querySelector('.pluto-video');return {time:v.currentTime,paused:v.paused,back:v.buffered.length?v.currentTime-v.buffered.start(0):0,frames:v.getVideoPlaybackQuality().totalVideoFrames,heap:performance.memory?.usedJSHeapSize}})()`);
    assert.equal(sample.paused, false);
    assert.ok(sample.back < 90, "back buffer should remain bounded (including segment slack)");
    console.log("SOAK", JSON.stringify(sample));
  }

  await navigate("999999999");
  await waitFor(`document.querySelector('.pluto-notice')?.innerText.includes('not mapped')`, "explicit unknown-ID error");
  assert.equal(bootRequests, initialRequests, "unknown ID must not play a default channel");
  console.log("PASS unknown numeric ID fails clearly without playing another channel");

  await send("Network.setBlockedURLs", { urls: ["*boot.pluto.tv*"] }, sessionId);
  await navigate("5da0c85bd2c9c10009370984");
  await waitFor(`document.querySelector('.pluto-notice button')?.hidden===false`, "network error with retry");
  assert.equal(await evaluate(`document.querySelector('.pluto-notice').hidden`), false);
  await send("Network.setBlockedURLs", { urls: [] }, sessionId);
  await evaluate(`document.querySelector('.pluto-notice button').click()`);
  await waitFor(`(() => {const v=document.querySelector('.pluto-video');return v?.readyState>=2&&!v.paused&&v.currentTime>0})()`, "successful retry with legacy ID");
  console.log("PASS legacy ID + recovery after blocked playback request");
  assert.deepEqual(errors, [], "no uncaught browser exceptions");
} finally {
  if (context) await send("Target.disposeBrowserContext", context);
  socket.close();
}
