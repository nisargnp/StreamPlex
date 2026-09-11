/* Pluto's website needs first-party cookies and stalls in a cross-site iframe.
 * Play its anonymous, ad-supported HLS session instead. No proxy or saved JWTs.
 * These are Pluto web-client endpoints, not a guaranteed public embed API.
 */
(() => {
  const BOOT_URL = "https://boot.pluto.tv/v4/start";
  const HLS_URL = "https://cdn.jsdelivr.net/npm/hls.js@1.7.2/dist/hls.min.js";
  const HLS_INTEGRITY = "sha384-xZKOEqJSfUEI1E4N6MG1+KjnKYM1R1v2WKpyaS0c+ksIxRi5PB8MAkyEdX48MX2/";
  // The new site's numeric IDs are NOT the old API's channel numbers. Its
  // resolver is not CORS-enabled, so keep verified aliases explicit. Never
  // accept boot's default channel when it cannot resolve the requested one.
  const CHANNEL_ALIASES = Object.freeze({ "29262": "5da0c85bd2c9c10009370984" });
  const STARTUP_TIMEOUT_MS = 30000;
  let hlsScriptPromise;

  function resolveChannelId(id) {
    if (/^[a-f0-9]{24}$/i.test(id)) return id.toLowerCase();
    if (Object.hasOwn(CHANNEL_ALIASES, id)) return CHANNEL_ALIASES[id];
    throw new Error("This numeric Pluto ID is not mapped yet. Use its legacy 24-character channel ID, or Open Pluto TV.");
  }

  function buildSessionUrl(channelId, clientId) {
    const url = new URL(BOOT_URL);
    url.search = new URLSearchParams({
      appName: "web", appVersion: "9.0.0", deviceVersion: "1",
      deviceModel: "web", deviceMake: "browser", deviceType: "web",
      clientModelNumber: "1.0.0", clientID: clientId, channelID: channelId,
      serverSideAds: "true", deviceDNT: String(navigator.doNotTrack === "1"),
    });
    return url;
  }

  function parseSession(boot, channelId) {
    const channel = boot.EPG?.find((entry) => entry.id === channelId);
    const path = channel?.stitched?.path || channel?.stitched?.paths?.find((entry) => entry.type === "hls")?.path;
    if (!path || !boot.sessionToken || typeof boot.stitcherParams !== "string") {
      throw new Error("Pluto did not return this channel. It may be unavailable in your region.");
    }
    const server = new URL(boot.servers?.stitcher);
    if (server.protocol !== "https:" || !server.hostname.endsWith(".pluto.tv") ||
        !path.startsWith(`/stitch/hls/channel/${channelId}/`)) {
      throw new Error("Pluto returned an unsupported playback address.");
    }
    const url = new URL(`/v2${path}`, server.origin);
    url.search = boot.stitcherParams;
    url.searchParams.set("jwt", boot.sessionToken);
    // Carry the anonymous session into child playlists, otherwise they 401.
    url.searchParams.set("masterJWTPassthrough", "true");
    const refresh = Number(boot.refreshInSec);
    return { url: url.href, name: channel.name, refreshMs: Number.isFinite(refresh) && refresh > 0 ? Math.max(1000, Math.min(refresh * 0.9 * 1000, 2147483647)) : 4 * 60 * 60 * 1000 };
  }

  function loadHls() {
    if (globalThis.Hls) return Promise.resolve(globalThis.Hls);
    if (!hlsScriptPromise) {
      hlsScriptPromise = new Promise((resolve, reject) => {
        const script = document.createElement("script");
        const timeout = setTimeout(failed, 15000);
        function failed() {
          clearTimeout(timeout);
          script.remove();
          reject(new Error("The video player could not load. Check your connection and retry."));
        }
        script.src = HLS_URL;
        script.integrity = HLS_INTEGRITY;
        script.crossOrigin = "anonymous";
        script.onload = () => {
          clearTimeout(timeout);
          if (globalThis.Hls) resolve(globalThis.Hls);
          else failed();
        };
        script.onerror = failed;
        document.head.append(script);
      }).catch((error) => { hlsScriptPromise = null; throw error; });
    }
    return hlsScriptPromise;
  }

  function mount(shell, streamId, callbacks = {}) {
    const video = document.createElement("video");
    video.className = "pluto-video";
    video.controls = true;
    video.autoplay = true;
    video.muted = true;
    video.playsInline = true;
    video.setAttribute("aria-label", "Pluto TV live video");
    const notice = document.createElement("div");
    notice.className = "pluto-notice";
    const message = document.createElement("span");
    message.setAttribute("role", "status");
    const retry = document.createElement("button");
    retry.type = "button";
    retry.className = "stream-audio-button";
    retry.textContent = "Retry playback";
    notice.append(message, retry);
    shell.replaceChildren(video, notice);

    let disposed = false;
    let attempt = 0;
    let hls;
    let request;
    let timer;
    let retries = 0;
    let playingSince = 0;
    let refreshTimer;
    let refreshAt = 0;
    let userPaused = false;
    let stopping = false;
    let hasStarted = false;
    let forceMse = false;

    function preferNativeHls() {
      // Safari's native HLS is independent of jsDelivr. Chrome's optimistic
      // native support failed with these streams, so continue to prefer MSE there.
      return !forceMse && video.canPlayType("application/vnd.apple.mpegurl") &&
        /Safari\//.test(navigator.userAgent || "") && !/Chrome|Chromium|CriOS|Edg|OPR/.test(navigator.userAgent || "");
    }

    function show(text, canRetry = false) {
      message.textContent = text;
      notice.hidden = false;
      retry.hidden = !canRetry;
    }

    function stop() {
      clearTimeout(timer);
      clearTimeout(refreshTimer);
      request?.abort();
      stopping = true;
      hls?.destroy();
      hls = null;
      video.pause();
      video.removeAttribute("src");
      video.load();
      stopping = false;
    }

    function fail(text, recover = true) {
      if (disposed) return;
      attempt += 1; // Invalidate pending fetches and player callbacks.
      stop();
      if (recover && retries < 2) {
        retries += 1;
        show(`Reconnecting to Pluto TV (${retries}/2)…`);
        timer = setTimeout(start, retries * 1500);
      } else {
        show(text, true);
      }
    }

    async function start() {
      if (disposed) return;
      const current = ++attempt;
      stop();
      refreshAt = 0;
      playingSince = 0;
      show("Connecting to Pluto TV…");
      request = new AbortController();
      timer = setTimeout(() => fail("Pluto playback timed out. Retry, or use Open to watch on Pluto TV."), STARTUP_TIMEOUT_MS);
      try {
        const channelId = resolveChannelId(streamId);
        const response = await fetch(buildSessionUrl(channelId, crypto.randomUUID()), {
          credentials: "omit", cache: "no-store", signal: request.signal,
        });
        if (!response.ok) throw new Error("Pluto's playback service is unavailable. Retry, or use Open to watch on Pluto TV.");
        const session = parseSession(await response.json(), channelId);
        if (disposed || current !== attempt) return;
        video.setAttribute("aria-label", `${session.name || "Pluto TV"} live video`);
        // Prefer MSE: some Chrome versions report native HLS support but fail
        // on Pluto's playlists. A canPlayType result alone is not sufficient.
        const native = preferNativeHls();
        const Hls = native ? null : await loadHls();
        if (disposed || current !== attempt) return;
        if (Hls?.isSupported()) {
          hls = new Hls({ capLevelToPlayerSize: true, maxBufferLength: 30, backBufferLength: 30 });
          hls.on(Hls.Events.ERROR, (_event, data) => {
            if (!disposed && current === attempt && data.fatal) {
              fail("Pluto playback was interrupted. Retry, or use Open to watch on Pluto TV.");
            }
          });
          hls.loadSource(session.url);
          hls.attachMedia(video);
        } else if (video.canPlayType("application/vnd.apple.mpegurl")) {
          video.src = session.url;
        } else {
          throw new Error("This browser cannot play Pluto's HLS video. Use Open to watch on Pluto TV.");
        }
        refreshAt = Date.now() + session.refreshMs;
        refreshTimer = setTimeout(() => { if (!disposed) start(); }, session.refreshMs);
        hasStarted = true;
        if (userPaused) {
          video.autoplay = false;
          clearTimeout(timer);
          notice.hidden = true;
          return;
        }
        const play = video.play();
        play?.catch((error) => {
          if (!disposed && current === attempt && error.name === "NotAllowedError") {
            clearTimeout(timer);
            // Do not cover the native controls if autoplay needs a gesture.
            notice.hidden = true;
          }
        });
      } catch (error) {
        if (disposed || current !== attempt) return;
        const text = error instanceof TypeError
          ? "Could not reach Pluto TV. Check your connection or blocker settings, then retry."
          : error.message;
        fail(text, false);
      }
    }

    video.addEventListener("playing", () => {
      if (disposed) return;
      clearTimeout(timer);
      notice.hidden = true;
      playingSince = Date.now();
      callbacks.onReady?.();
    });
    video.addEventListener("pause", () => {
      if (!stopping && hasStarted && video.currentSrc && video.readyState >= 2) {
        userPaused = true;
        video.autoplay = false;
        clearTimeout(timer);
      }
    });
    video.addEventListener("play", () => { if (!stopping) userPaused = false; });
    video.addEventListener("volumechange", () => {
      if (!disposed) callbacks.onAudioChange?.({ muted: video.muted, volume: video.volume });
    });
    video.addEventListener("timeupdate", () => {
      if (playingSince && Date.now() - playingSince > 30000) retries = 0;
    });
    video.addEventListener("waiting", () => {
      if (!playingSince || video.paused) return;
      clearTimeout(timer);
      timer = setTimeout(() => {
        if (!video.paused) fail("Pluto stopped sending video. Retry, or use Open to watch on Pluto TV.");
      }, STARTUP_TIMEOUT_MS);
    });
    video.addEventListener("error", () => {
      if (!disposed && !stopping && video.hasAttribute("src")) {
        forceMse = true;
        fail("Pluto video could not be played. Retry, or use Open to watch on Pluto TV.");
      }
    });
    const onVisible = () => {
      if (!disposed && document.visibilityState === "visible" && refreshAt && Date.now() >= refreshAt) start();
    };
    document.addEventListener?.("visibilitychange", onVisible);
    retry.addEventListener("click", () => { retries = 0; userPaused = false; start(); });
    start();
    return () => {
      disposed = true;
      attempt += 1;
      document.removeEventListener?.("visibilitychange", onVisible);
      stop();
    };
  }

  globalThis.StreamplexPluto = { mount, resolveChannelId, buildSessionUrl, parseSession };
})();
