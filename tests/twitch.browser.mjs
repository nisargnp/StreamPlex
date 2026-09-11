// Opt-in real Twitch startup test. Supply currently live channels, a local
// server, and disposable Chrome on CDP 9222. No clicks or autoplay-policy flags.
import assert from "node:assert/strict";
const channels = (process.env.TWITCH_CHANNELS || "shroud,lirik,xqc").split(",").map(s=>s.trim()).filter(Boolean);
const endpoint = process.env.CDP_URL || "http://127.0.0.1:9222";
const base = process.env.STREAMPLEX_URL || "http://127.0.0.1:8000/";
const version = await (await fetch(`${endpoint}/json/version`)).json();
const ws = new WebSocket(version.webSocketDebuggerUrl);
await new Promise((resolve,reject)=>{ws.onopen=resolve;ws.onerror=reject;});
let sequence = 0;
const pending = new Map();
ws.onmessage = ({data}) => {
  const m=JSON.parse(data), p=pending.get(m.id);
  if (!p) return;
  pending.delete(m.id); clearTimeout(p.timer);
  m.error ? p.reject(Error(m.error.message)) : p.resolve(m.result);
};
function send(method,params={},sessionId) {
  return new Promise((resolve,reject)=>{
    const id=++sequence;
    const timer=setTimeout(()=>{pending.delete(id);reject(Error(`${method} timed out`));},30000);
    pending.set(id,{resolve,reject,timer}); ws.send(JSON.stringify({id,method,params,sessionId}));
  });
}
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const context=await send("Target.createBrowserContext");
try {
  const {targetId}=await send("Target.createTarget",{url:"about:blank",browserContextId:context.browserContextId});
  const {sessionId}=await send("Target.attachToTarget",{targetId,flatten:true});
  const evaluate=async (expression,targetSession=sessionId)=>{
    const r=await send("Runtime.evaluate",{expression,returnByValue:true,awaitPromise:true},targetSession);
    if(r.exceptionDetails)throw Error(r.exceptionDetails.exception?.description);
    return r.result.value;
  };
  const wait=async expression=>{
    for(let i=0;i<90;i++) {if(await evaluate(expression))return;await pause(500);}
    throw Error(`Playback condition timed out; verify channels are live: ${channels.join(",")}. ${await evaluate("document.body.innerText")}`);
  };
  const resize=(width,height)=>send("Emulation.setDeviceMetricsOverride",{width,height,deviceScaleFactor:1,mobile:false},sessionId);
  await send("Page.enable",{},sessionId);
  await resize(390,500);
  const url=new URL(base);url.search=new URLSearchParams({streams:channels.join(",")});
  await send("Page.navigate",{url:url.href},sessionId);
  await wait(`typeof players!=='undefined' && players.size===${channels.length} && [...players].every(([id,p])=>streamViews.get(id).hasPlayed && !p.isPaused() && p.getPlaybackStats().fps>0)`);
  console.log("PASS real muted Twitch autoplay from a fresh load in a 390×500 viewport");
  const {targetInfos}=await send("Target.getTargets");
  const frames=[];
  for(const target of targetInfos.filter(t=>t.type==="iframe" && t.browserContextId===context.browserContextId && t.url.startsWith("https://player.twitch.tv/"))) {
    frames.push((await send("Target.attachToTarget",{targetId:target.targetId,flatten:true})).sessionId);
  }
  assert.equal(frames.length,channels.length);
  const sample=()=>Promise.all(frames.map(s=>evaluate(`(()=>{const v=document.querySelector('video');return {width:innerWidth,height:innerHeight,ready:v?.readyState,paused:v?.paused,frames:v?.getVideoPlaybackQuality().totalVideoFrames,time:v?.currentTime}})()`,s)));
  await evaluate("window.retainedPlayers=new Map(players)");
  for(const [width,height] of [[390,500],[844,390],[1280,720],[1920,1080]]) {
    await resize(width,height);await pause(500);
    const before=await sample();await pause(2500);const after=await sample();
    for(let i=0;i<after.length;i++) {
      assert.ok(after[i].width>=400 && after[i].height>=300,JSON.stringify(after[i]));
      assert.ok(after[i].ready>=2 && !after[i].paused,JSON.stringify(after[i]));
      assert.ok(after[i].frames>0 && after[i].frames!==before[i].frames,"actual decoded frames must change, not just the SDK's cached play state");
    }
    assert.equal(await evaluate(`document.documentElement.scrollWidth<=innerWidth && document.documentElement.scrollHeight<=innerHeight && [...players].every(([id,p])=>p===retainedPlayers.get(id)) && [...document.querySelectorAll('.stream-tile:not([hidden])')].every(t=>{const r=t.getBoundingClientRect();return r.left>=0 && r.top>=0 && r.right<=innerWidth && r.bottom<=innerHeight})`),true);
    console.log(`PASS advancing real Twitch video frames at ${width}×${height}; no scrolling or player recreation`);
  }
  const first=JSON.stringify(channels[0]);
  await evaluate(`players.get(${first}).pause()`);
  await wait(`streamViews.get(${first}).userPaused`);
  await resize(390,500);await pause(2000);
  assert.equal(await evaluate(`players.get(${first}).isPaused() && streamViews.get(${first}).userPaused && players.get(${first})===retainedPlayers.get(${first})`),true);
  console.log("PASS intentional pause survives resizing after autoplay succeeds");
} finally {
  await send("Target.disposeBrowserContext",context);ws.close();
}
