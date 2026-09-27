const appShell = document.querySelector(".app-shell");
const channelList = document.querySelector("#channel-list");
const addButton = document.querySelector("#add-channel");
const streamGrid = document.querySelector("#stream-grid");
const emptyState = document.querySelector("#empty-state");
const pollIndicator = document.querySelector("#poll-indicator");
const pollIndicatorText = document.querySelector("#poll-indicator-text");
const themeToggle = document.querySelector("#theme-toggle");
const themeToggleLabel = document.querySelector("#theme-toggle-label");
const themeColorMeta = document.querySelector('meta[name="theme-color"]');
const emptyStateText = emptyState ? emptyState.querySelector("p") : null;
const STREAMS_QUERY_PARAM = "streams";
const PLUTO_QUERY_PARAM = "pluto";
const PLUTO_LIVE_TV_BASE_URL = "https://pluto.tv/us/watch/live-tv/";
const PLUTO_LEGACY_LIVE_TV_BASE_URL = "https://pluto.tv/us/live-tv/";
const PLUTO_STREAM_ID_PATTERN = /^(?:[1-9][0-9]*|[a-f0-9]{24})$/i;
const PLUTO_HOSTS = new Set(["pluto.tv", "www.pluto.tv"]);
let currentChannels = parseInitialChannels();
let currentPlutoStream = parseInitialPlutoStream();
let currentStreams = buildStreamEntries(currentChannels, currentPlutoStream);
const streamViews = new Map();
const pillViews = new Map();
const players = new Map();
const audioVolumes = new Map();
const probeControllers = new Set();
const APP_VERSION = "2026-09-27.11";
const TWITCH_VIEWPORT_WIDTH = 400;
const TWITCH_VIEWPORT_HEIGHT = 300;
const THEME_STORAGE_KEY = "streamplex-theme";
const DEFAULT_ACTIVE_VOLUME = 0.5;
const POLL_INTERVAL_MS = 300000;
const PROBE_TIMEOUT_MS = 8000;
const FETCH_PROBE_TIMEOUT_MS = 5000;
const PREFERRED_QUALITY_PATTERN = /^480p(?:\d+)?$/i;
const PREVIEW_PLACEHOLDER_PATTERNS = [
  /\/ttv-static\/404_/i,
  /\/ttv-static\/403_/i,
  /404_preview/i,
  /404_processing/i,
  /forbidden/i,
];
let activeAudioChannel = null;
let pollTimer = null;
let pollTicker = null;
let pollInFlight = false;
let nextPollAt = null;
let lastPollState = "checking";
let layoutSyncFrame = null;
let plutoModulePromise;
let twitchSdkPromise;
let pollEpoch = 0;
let audioMonitor = null;
let activeAudioVolume = DEFAULT_ACTIVE_VOLUME;
let activeTheme = getStoredTheme();

applyTheme(activeTheme);
renderInitialView();
bindEvents();
startStatusPolling();

function renderInitialView() {
  renderStreamTiles();
  renderChannelPills();
  syncGridLayout();
}

function bindEvents() {
  if (themeToggle) {
    themeToggle.addEventListener("click", () => {
      setTheme(activeTheme === "light" ? "dark" : "light");
    });
  }

  if (addButton) {
    addButton.addEventListener("click", () => {
      const value = window.prompt("Add channels", "");
      if (value === null) {
        return;
      }

      const selection = parseAddedSelection(value);
      navigateToChannels(mergeChannels(currentChannels, selection.channels), selection.pluto ?? currentPlutoStream);
    });
  }

  if (channelList) {
    channelList.addEventListener("click", (event) => {
      const button = event.target.closest("[data-remove-channel]");
      if (!button) {
        return;
      }

      const channel = button.dataset.removeChannel || "";
      if (channel === currentPlutoStream?.id) {
        navigateToChannels(currentChannels, null);
        return;
      }
      if (!channel) {
        return;
      }

      navigateToChannels(currentChannels.filter((entry) => entry !== channel));
    });
  }

  if (streamGrid) {
    streamGrid.addEventListener("click", (event) => {
      const button = event.target.closest("[data-audio-channel]");
      if (!button || button.disabled) {
        return;
      }

      const channel = button.dataset.audioChannel || "";
      if (!streamViews.has(channel)) {
        return;
      }

      setActiveAudioChannel(channel);
    });
  }

  window.addEventListener("resize", scheduleGridLayoutSync);
  window.addEventListener("pageshow", handlePageShow);
  window.addEventListener("popstate", () => updateSelection(parseInitialChannels(), parseInitialPlutoStream()));
  document.querySelector("#refresh-streams")?.addEventListener("click", () => runPollCycle());
  window.addEventListener("pagehide", () => {
    stopStatusPolling();
    [...players.keys()].forEach(teardownPlayer);
    streamViews.forEach(disposePlutoView);
    window.clearInterval(audioMonitor);
    audioMonitor = null;
  });
}

function renderChannelPills() {
  pillViews.clear();

  if (!channelList) {
    return;
  }

  channelList.querySelectorAll("[data-channel-pill]").forEach((pill) => pill.remove());

  const fragment = document.createDocumentFragment();

  currentStreams.forEach((stream) => {
    const channel = stream.id;
    const pill = document.createElement("div");
    pill.className = "channel-pill is-pending";
    pill.dataset.channelPill = channel;

    const status = document.createElement("span");
    status.className = "channel-pill-status";
    status.dataset.channelStatus = channel;
    status.setAttribute("aria-hidden", "true");

    const label = document.createElement("span");
    label.className = "channel-pill-label";
    label.textContent = stream.label;

    const removeButton = document.createElement("button");
    removeButton.className = "channel-pill-remove";
    removeButton.type = "button";
    removeButton.dataset.removeChannel = channel;
    removeButton.setAttribute("aria-label", `Remove ${channel}`);
    removeButton.title = `Remove ${channel}`;
    removeButton.textContent = "x";

    pill.append(status, label, removeButton);
    fragment.append(pill);
    pillViews.set(channel, { pill, status });
  });

  channelList.append(fragment);
  streamViews.forEach((view, id) => setChannelStatus(id, view.tile.dataset.live === "true" ? "live" : view.tile.dataset.live === "false" ? "offline" : "pending"));
}

function renderStreamTiles() {
  if (!streamGrid) {
    return;
  }

  const wanted = new Set(currentStreams.map((stream) => stream.id));
  streamViews.forEach((view, id) => {
    if (wanted.has(id)) return;
    teardownPlayer(id);
    disposePlutoView(view);
    view.tile.remove();
    streamViews.delete(id);
    audioVolumes.delete(id);
    if (activeAudioChannel === id) activeAudioChannel = null;
  });
  currentStreams.forEach((stream, index) => {
    const existing = streamViews.get(stream.id);
    if (existing) {
      existing.tile.style.order = String(index);
      return;
    }
    const tile = document.createElement("article");
    tile.className = "stream-tile";
    tile.dataset.streamChannel = stream.id;
    tile.dataset.provider = stream.provider;
    tile.dataset.live = isPlutoStream(stream) ? "true" : "pending";
    tile.dataset.mountPending = "false";
    tile.style.order = String(index);

    const header = document.createElement("header");
    header.className = "stream-name";

    const label = document.createElement("span");
    label.className = "stream-name-label";
    label.textContent = stream.label;

    const action = createStreamAction(stream);

    const audioButton = createAudioButton(stream);
    if (isPlutoStream(stream)) {
      const actions = document.createElement("div");
      actions.className = "stream-actions";
      actions.append(audioButton, action);
      header.append(label, actions);
    } else {
      header.append(label, audioButton);
    }

    const shell = document.createElement("div");
    shell.className = "player-shell";
    shell.dataset.playerShell = stream.id;

    tile.append(header, shell);
    // Never reparent an existing iframe: even moving it can restart playback.
    streamGrid.append(tile);

    const view = { tile, shell, audioButton, stream, userPaused: false, ready: false };
    streamViews.set(stream.id, view);

    if (isPlutoStream(stream)) {
      renderPlutoStream(view);
      return;
    }

    renderShellPlaceholder(view, stream.label, "Checking live status", "pending");
  });

}

function createStreamAction(stream) {
  if (isPlutoStream(stream)) {
    const link = document.createElement("a");
    link.className = "stream-audio-button stream-open-link";
    link.href = stream.url;
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    link.textContent = "Open";
    link.setAttribute("aria-label", `Open ${stream.label} on Pluto TV`);
    link.title = `Open ${stream.label} on Pluto TV`;
    return link;
  }

  return createAudioButton(stream);
}

function createAudioButton(stream) {
  const audioButton = document.createElement("button");
  audioButton.className = "stream-audio-button";
  audioButton.type = "button";
  audioButton.dataset.audioChannel = stream.id;
  audioButton.setAttribute("aria-pressed", "false");
  audioButton.disabled = true;
  audioButton.textContent = "Audio";
  audioButton.setAttribute("aria-label", `Listen to ${stream.label}`);
  return audioButton;
}

function buildStreamEntries(channels, plutoStream) {
  const streams = channels.map((channel) => ({
    id: channel,
    provider: "twitch",
    label: channel,
    channel,
  }));

  if (plutoStream) {
    streams.push(plutoStream);
  }

  return streams;
}

function isTwitchStream(stream) {
  return Boolean(stream && stream.provider === "twitch");
}

function isPlutoStream(stream) {
  return Boolean(stream && stream.provider === "pluto");
}

function isTwitchView(view) {
  return Boolean(view && isTwitchStream(view.stream));
}

function isPlutoView(view) {
  return Boolean(view && isPlutoStream(view.stream));
}

function parseInitialChannels() {
  const params = new URLSearchParams(window.location.search);
  return parseChannelList(params.get(STREAMS_QUERY_PARAM) || "");
}

function parseInitialPlutoStream() {
  const params = new URLSearchParams(window.location.search);
  const streamId = sanitizePlutoStreamId(params.get(PLUTO_QUERY_PARAM) || "");

  if (!streamId) {
    return null;
  }
  return makePlutoStream(streamId);
}

function makePlutoStream(streamId) {
  // Legacy IDs still resolve through Pluto's redirect to the new numeric ID.
  const baseUrl = /^[a-f0-9]{24}$/i.test(streamId)
    ? PLUTO_LEGACY_LIVE_TV_BASE_URL
    : PLUTO_LIVE_TV_BASE_URL;

  return {
    id: `pluto-${streamId}`,
    provider: "pluto",
    label: "Pluto TV",
    streamId,
    url: `${baseUrl}${streamId}/`,
  };
}

function parseChannelList(value) {
  return [
    ...new Set(
      value
        .split(/[\s,]+/)
        .map((entry) => sanitizeChannel(entry))
        .filter(Boolean)
    ),
  ];
}

function mergeChannels(existingChannels, nextChannels) {
  return [...new Set([...existingChannels, ...nextChannels])];
}

function navigateToChannels(channels, plutoStream = currentPlutoStream) {
  const next = buildStreamUrl(channels, plutoStream);
  if (next.href !== window.location.href) window.history.pushState(null, "", next);
  updateSelection(channels, plutoStream);
}

function updateSelection(channels, plutoStream) {
  stopStatusPolling();
  currentChannels = channels;
  currentPlutoStream = plutoStream;
  currentStreams = buildStreamEntries(channels, plutoStream);
  renderStreamTiles();
  renderChannelPills();
  syncGridLayout();
  syncAudioButtons();
  startStatusPolling();
}

function parseAddedSelection(value) {
  const text = value.trim();
  let pluto;
  if (/^https?:\/\//i.test(text)) {
    try {
      const url = new URL(text);
      const id = sanitizePlutoStreamId(url.searchParams.get("pluto") || text);
      if (id) pluto = makePlutoStream(id);
    } catch { /* Invalid URLs add nothing. */ }
  }
  return { channels: parseChannels(text), pluto };
}

function buildStreamUrl(channels, plutoStream) {
  const nextUrl = new URL(window.location.href);

  nextUrl.searchParams.delete(STREAMS_QUERY_PARAM);
  nextUrl.searchParams.delete(PLUTO_QUERY_PARAM);

  if (channels.length) {
    nextUrl.searchParams.set(STREAMS_QUERY_PARAM, channels.join(","));
  }

  if (plutoStream) {
    nextUrl.searchParams.set(PLUTO_QUERY_PARAM, plutoStream.streamId);
  }

  return nextUrl;
}

function startStatusPolling() {
  if (!hasTwitchStreams()) {
    stopStatusPolling();
    setPollIndicatorState("idle", "No Twitch streams selected");
    return;
  }

  if (!pollTicker) {
    pollTicker = window.setInterval(updatePollIndicator, 1000);
  }

  runPollCycle();
}

async function runPollCycle() {
  if (!hasTwitchStreams()) {
    stopStatusPolling();
    setPollIndicatorState("idle", "No Twitch streams selected");
    return;
  }

  if (pollInFlight) {
    return;
  }

  pollInFlight = true;
  const epoch = pollEpoch;
  setPollIndicatorState("checking", "Checking live status");

  try {
    const complete = await pollStreamStatuses(epoch);
    if (epoch !== pollEpoch) return;
    lastPollState = complete ? "ok" : "error";
  } catch (error) {
    lastPollState = "error";
  } finally {
    if (epoch !== pollEpoch) return;
    pollInFlight = false;
    nextPollAt = Date.now() + POLL_INTERVAL_MS;
    scheduleNextPoll();
    updatePollIndicator();
  }
}

function scheduleNextPoll() {
  if (pollTimer) {
    window.clearTimeout(pollTimer);
  }

  pollTimer = window.setTimeout(runPollCycle, POLL_INTERVAL_MS);
}

function stopStatusPolling() {
  pollEpoch += 1;
  probeControllers.forEach((controller) => controller.abort());
  probeControllers.clear();
  pollInFlight = false;
  if (pollTimer) {
    window.clearTimeout(pollTimer);
    pollTimer = null;
  }

  if (pollTicker) {
    window.clearInterval(pollTicker);
    pollTicker = null;
  }

  nextPollAt = null;
}

function handlePageShow(event) {
  if (!event.persisted || !streamViews.size) {
    return;
  }

  [...players.keys()].forEach((channel) => {
    teardownPlayer(channel);
  });

  streamViews.forEach((view, channel) => {
    if (isPlutoView(view)) {
      renderPlutoStream(view);
      return;
    }

    view.tile.hidden = false;
    view.tile.dataset.live = "pending";
    view.tile.dataset.mountPending = "false";
    view.audioButton.disabled = true;
    renderShellPlaceholder(view, view.stream.label, "Checking live status", "pending");
    setChannelStatus(channel, "pending");
  });

  if (pollTimer) {
    window.clearTimeout(pollTimer);
    pollTimer = null;
  }

  pollInFlight = false;
  nextPollAt = null;
  lastPollState = "checking";
  syncGridLayout();
  startStatusPolling();
}

async function pollStreamStatuses(epoch = pollEpoch) {
  const channels = getTwitchStreamIds();

  if (!channels.length) {
    return true;
  }

  // Process each result immediately; one slow thumbnail must not hold back
  // all the other players. A mounted SDK is a better status source than images.
  await Promise.all(
    channels.map(async (channel) => {
      const view = streamViews.get(channel);
      if (players.has(channel) || (view.tile.dataset.mountPending === "loading" && !view.playbackError)) return;
      await refreshUnmountedTwitchStream(channel, view, epoch);
    })
  );
  return twitchStatusesResolved();
}

async function refreshUnmountedTwitchStream(channel, view, epoch) {
  const generation = view.mountGeneration || 0;
  const wasFailed = Boolean(view.playbackError);
  const state = await safelyProbeStreamPreview(channel);
  if (epoch !== pollEpoch || streamViews.get(channel) !== view ||
      generation !== (view.mountGeneration || 0) ||
      Boolean(view.playbackError) !== wasFailed || players.has(channel)) return;

  view.playbackError = false;
  if (state === "offline") {
    view.autoRecoveryTried = false;
    renderOfflineStream(channel);
    setChannelStatus(channel, "offline");
    refreshStatusFromPlayers();
  } else {
    // Unknown never means offline. Let the official embedded player decide.
    renderLiveStream(channel);
    setChannelStatus(channel, state === "live" ? "live" : "pending");
  }
  syncGridLayout();
}

function twitchStatusesResolved() {
  return getTwitchStreamIds().every((id) => {
    const view = streamViews.get(id);
    return !view.playbackError && (view.ready || view.tile.dataset.live === "false");
  });
}

function refreshStatusFromPlayers() {
  if (twitchStatusesResolved()) lastPollState = "ok";
  updatePollIndicator();
}

async function safelyProbeStreamPreview(channel) {
  try {
    return await probeStreamPreview(channel);
  } catch (error) {
    return "unknown";
  }
}

async function probeStreamPreview(channel) {
  const cacheToken = Math.floor(Date.now() / POLL_INTERVAL_MS);

  const previewUrl = `${buildPreviewUrl(channel)}?cb=${cacheToken}`;
  const fetchState = await probeStreamPreviewViaFetch(previewUrl);

  if (fetchState !== "unknown") {
    return fetchState;
  }

  return "unknown";
}

function buildPreviewUrl(channel) {
  return `https://static-cdn.jtvnw.net/previews-ttv/live_user_${channel}-440x248.jpg`;
}

async function probeStreamPreviewViaFetch(previewUrl) {
  if (typeof fetch !== "function" || typeof AbortController === "undefined") {
    return "unknown";
  }

  const abortController = new AbortController();
  probeControllers.add(abortController);
  const timeoutId = window.setTimeout(() => {
    abortController.abort();
  }, FETCH_PROBE_TIMEOUT_MS);

  try {
    const response = await fetch(previewUrl, {
      method: "GET",
      mode: "cors",
      cache: "default",
      signal: abortController.signal,
    });

    if (response.type === "opaque" || response.type === "opaqueredirect") {
      return "unknown";
    }

    if (response.status === 404) {
      return "offline";
    }
    if (!response.ok) return "unknown";

    if (isPlaceholderPreviewUrl(response.url)) {
      return /403_|forbidden/i.test(response.url) ? "unknown" : "offline";
    }

    if (response.ok) {
      return "live";
    }

    return "unknown";
  } catch (error) {
    return "unknown";
  } finally {
    window.clearTimeout(timeoutId);
    probeControllers.delete(abortController);
  }
}

function probeStreamPreviewViaImage(previewUrl) {
  return new Promise((resolve) => {
    const image = new Image();
    let settled = false;

    const finish = (state) => {
      if (settled) {
        return;
      }

      settled = true;
      window.clearTimeout(timeoutId);
      image.onload = null;
      image.onerror = null;
      resolve(state);
    };

    const timeoutId = window.setTimeout(() => {
      finish("unknown");
    }, PROBE_TIMEOUT_MS);

    image.referrerPolicy = "no-referrer";

    image.onload = () => {
      const resolvedUrl = image.currentSrc || image.src || previewUrl;

      if (isPlaceholderPreviewUrl(resolvedUrl)) {
        finish("offline");
        return;
      }

      finish("unknown");
    };

    image.onerror = () => finish("unknown");
    image.src = previewUrl;
  });
}

function isPlaceholderPreviewUrl(value) {
  return PREVIEW_PLACEHOLDER_PATTERNS.some((pattern) => pattern.test(value || ""));
}

function retainExistingStreamState(channel) {
  const view = streamViews.get(channel);
  if (!isTwitchView(view) || !view.shell || !view.audioButton) {
    return;
  }

  if (view.tile.dataset.live === "true") {
    setChannelStatus(channel, "live");
    return;
  }

  if (view.tile.dataset.live === "false") {
    setChannelStatus(channel, "offline");
    return;
  }

  view.tile.hidden = false;
  view.tile.dataset.live = "pending";
  view.tile.dataset.mountPending = "false";
  view.audioButton.disabled = true;

  teardownPlayer(channel);
  renderShellPlaceholder(view, view.stream.label, "Checking live status", "pending");
  setChannelStatus(channel, "pending");
}

function renderLiveStream(channel) {
  const view = streamViews.get(channel);
  if (!isTwitchView(view) || !view.shell || !view.audioButton) {
    return;
  }

  view.tile.hidden = false;
  view.tile.dataset.live = "true";
  view.audioButton.disabled = false;

  if (players.has(channel)) {
    return;
  }

  view.tile.dataset.mountPending = "true";

  if (!view.shell.querySelector(".stream-placeholder-pending")) {
    renderShellPlaceholder(view, channel, "Loading stream", "pending");
  }
}

function mountPendingPlayers() {
  streamViews.forEach((view, channel) => {
    if (!isTwitchView(view)) {
      return;
    }

    if (view.tile.hidden || view.tile.dataset.live !== "true" || players.has(channel)) {
      return;
    }

    if (view.tile.dataset.mountPending !== "true") {
      return;
    }

    mountPlayer(channel, view);
  });
}

function loadTwitchSdk() {
  if (window.Twitch?.Player) return Promise.resolve(window.Twitch);
  if (!twitchSdkPromise) {
    twitchSdkPromise = new Promise((resolve, reject) => {
      const script = document.createElement("script");
      let settled = false;
      const finish = (error) => {
        if (settled) return;
        settled = true;
        window.clearTimeout(timer);
        if (error) { script.remove(); reject(error); }
        else resolve(window.Twitch);
      };
      const timer = window.setTimeout(() => finish(new Error("Twitch player download timed out.")), 15000);
      script.src = "https://player.twitch.tv/js/embed/v1.js";
      script.async = true;
      script.onload = () => finish(window.Twitch?.Player ? null : new Error("Twitch player is unavailable."));
      script.onerror = () => finish(new Error("Could not load Twitch. Check your connection or blocker settings."));
      document.head.append(script);
    }).catch((error) => { twitchSdkPromise = null; throw error; });
  }
  return twitchSdkPromise;
}

function createTwitchPlayer(SDK, mountId, options, view) {
  // The current SDK's destroy() leaves an internal bound message listener.
  // Capture only listeners registered synchronously by this constructor so
  // they can be removed with their exact identities. Restore the API even if
  // construction throws; unrelated listeners are never touched.
  const add = window.addEventListener;
  view.sdkListeners = [];
  window.addEventListener = function(type, listener, options) {
    if (type === "message") view.sdkListeners.push({ listener, options });
    return add.call(this, type, listener, options);
  };
  try {
    return new SDK.Player(mountId, options);
  } finally {
    window.addEventListener = add;
  }
}

async function mountPlayer(channel, view) {
  if (view.tile.dataset.mountPending === "loading") return;
  view.tile.dataset.mountPending = "loading";
  const generation = view.mountGeneration = (view.mountGeneration || 0) + 1;
  try {
    const SDK = await loadTwitchSdk();
    if (streamViews.get(channel) !== view || generation !== view.mountGeneration) return;
    view.shell.replaceChildren();
    const mount = document.createElement("div");
    mount.className = "player-mount";
    mount.id = `player-${channel}`;
    view.shell.append(mount);
    view.playerMount = mount;
    syncTwitchPlayerSize(view);
    if (typeof ResizeObserver !== "undefined") {
      view.playerResizeObserver = new ResizeObserver(() => syncTwitchPlayerSize(view));
      view.playerResizeObserver.observe(view.shell);
    }
    const player = createTwitchPlayer(SDK, mount.id, {
      channel, width: "100%", height: "100%",
      parent: [window.location.hostname || "127.0.0.1"],
      autoplay: !view.userPaused, muted: true,
    }, view);
    players.set(channel, player);
    view.tile.dataset.mountPending = "false";
    view.playbackError = false;
    view.ready = false;
    view.hasPlayed = false;
    view.qualityInitialized = false;
    view.playerEvents = [];
    const on = (event, handler) => {
      if (!event) return;
      const guarded = (...args) => { if (players.get(channel) === player) handler(...args); };
      player.addEventListener(event, guarded);
      view.playerEvents.push({ event, handler: guarded });
    };
    const clearWatchdog = () => window.clearTimeout(view.startupTimer);
    view.startupTimer = view.userPaused ? null : window.setTimeout(() => showTwitchFailure(channel, "Twitch did not start. Retry playback or open the channel directly."), 30000);
    on(SDK.Player.READY, () => {
      view.ready = true;
      refreshStatusFromPlayers();
      view.audioButton.disabled = false;
      initializePlayerQuality(view, player);
      applyPlayerAudioState(channel, player);
      requestPlayerPlayback(channel, player);
      startAudioMonitor();
    });
    on(SDK.Player.ONLINE, () => {
      view.tile.hidden = false;
      view.tile.dataset.live = "true";
      setChannelStatus(channel, "live");
      syncGridLayout();
      if (view.ready) requestPlayerPlayback(channel, player);
    });
    on(SDK.Player.OFFLINE, () => {
      clearWatchdog();
      view.autoRecoveryTried = false;
      // Keep the selected offline player to receive ONLINE without five-minute
      // thumbnail guesses or repeated SDK construction. Destroy it on removal.
      view.tile.hidden = true;
      view.tile.dataset.live = "false";
      setChannelStatus(channel, "offline");
      if (activeAudioChannel === channel) setActiveAudioChannel(null);
      syncGridLayout();
    });
    on(SDK.Player.PLAYING, () => {
      view.hasPlayed = true;
      view.autoRecoveryTried = false;
      clearWatchdog();
      view.notice?.remove();
      view.notice = null;
      initializePlayerQuality(view, player);
      setChannelStatus(channel, "live");
    });
    on(SDK.Player.PAUSE, () => {
      if (view.hasPlayed && view.tile.dataset.live !== "false" && !player.getEnded?.()) view.userPaused = true;
      clearWatchdog();
    });
    on(SDK.Player.PLAY, () => { view.userPaused = false; });
    on(SDK.Player.PLAYBACK_BLOCKED, () => {
      clearWatchdog();
      showTwitchNotice(view, "Your browser needs a click to start Twitch.", "Play", () => {
        view.userPaused = false;
        requestPlayerPlayback(channel, player);
      });
    });
    on(SDK.Player.ERROR, () => showTwitchFailure(channel, "Twitch playback failed. Retry or open the channel directly."));
  } catch (error) {
    if (streamViews.get(channel) === view && generation === view.mountGeneration) showTwitchFailure(channel, error.message);
  }
}

function initializePlayerQuality(view, player) {
  if (!view.qualityInitialized) view.qualityInitialized = applyPlayerQualityPreference(player);
}

function getTwitchViewport(width, height) {
  if (width <= 0 || height <= 0) return null;
  const scale = Math.min(1, width / TWITCH_VIEWPORT_WIDTH, height / TWITCH_VIEWPORT_HEIGHT);
  const viewportWidth = Math.ceil(width / scale);
  const viewportHeight = Math.ceil(height / scale);
  return { width: viewportWidth, height: viewportHeight, scale: Math.min(width / viewportWidth, height / viewportHeight) };
}

function syncTwitchPlayerSize(view) {
  if (!view.playerMount || view.tile.hidden) return;
  const rect = view.shell.getBoundingClientRect();
  const viewport = getTwitchViewport(rect.width, rect.height);
  if (!viewport) return;
  // Keep the actual iframe viewport large enough for Twitch to initialize,
  // then scale the entire player to the tile. Do not enlarge or crop the tile.
  // Use layout zoom: transform:scale() fails Twitch's visibility check.
  view.playerMount.style.width = `${viewport.width}px`;
  view.playerMount.style.height = `${viewport.height}px`;
  view.playerMount.style.zoom = String(viewport.scale);
}

function showTwitchNotice(view, text, action, callback) {
  view.notice?.remove();
  const notice = document.createElement("div");
  notice.className = "player-notice";
  const message = document.createElement("span");
  message.textContent = text;
  message.setAttribute("role", "status");
  const button = document.createElement("button");
  button.type = "button";
  button.className = "stream-audio-button";
  button.textContent = action;
  button.addEventListener("click", callback);
  const link = document.createElement("a");
  link.href = `https://www.twitch.tv/${view.stream.channel}`;
  link.target = "_blank";
  link.rel = "noopener noreferrer";
  link.textContent = "Open on Twitch";
  notice.append(message, button, link);
  view.shell.append(notice);
  view.notice = notice;
}

function showTwitchFailure(channel, message) {
  const view = streamViews.get(channel);
  if (!view) return;
  teardownPlayer(channel);
  view.playbackError = true;
  lastPollState = "error";
  updatePollIndicator();
  view.audioButton.disabled = true;
  view.tile.hidden = false;
  view.tile.dataset.live = "pending";
  showTwitchNotice(view, message, "Retry playback", () => {
    view.playbackError = false;
    view.userPaused = false;
    renderLiveStream(channel);
    syncGridLayout();
  });
  setChannelStatus(channel, "pending");
  syncGridLayout();
  // Retry once now; repeated failures wait for the regular status poll.
  if (!view.autoRecoveryTried) {
    view.autoRecoveryTried = true;
    void refreshUnmountedTwitchStream(channel, view, pollEpoch);
  }
}

function renderOfflineStream(channel) {
  const view = streamViews.get(channel);
  if (!isTwitchView(view) || !view.shell || !view.audioButton) {
    return;
  }

  view.tile.hidden = true;
  view.tile.dataset.live = "false";
  view.tile.dataset.mountPending = "false";
  view.audioButton.disabled = true;

  if (activeAudioChannel === channel) {
    clearActiveAudioChannel();
  }

  teardownPlayer(channel);
  renderShellPlaceholder(view, view.stream.label, "Offline", "offline");
}

function disposePlutoView(view) {
  view.plutoGeneration = (view.plutoGeneration || 0) + 1;
  view.disposePluto?.();
  view.disposePluto = null;
}

async function renderPlutoStream(view) {
  if (!isPlutoView(view) || !view.shell) {
    return;
  }

  view.tile.hidden = false;
  view.tile.dataset.live = "true";
  view.tile.dataset.mountPending = "false";
  disposePlutoView(view);
  const generation = view.plutoGeneration;
  renderShellPlaceholder(view, view.stream.label, "Loading video player…", "pending");
  try {
    if (!window.StreamplexPluto) {
      // Import from app.js so even a cached older index.html can load the new
      // player. Do not load any Pluto dependencies on Twitch-only pages.
      if (!plutoModulePromise) {
        plutoModulePromise = import(`./pluto.js?v=${APP_VERSION}`).catch((error) => {
          plutoModulePromise = null;
          throw error;
        });
      }
      await plutoModulePromise;
    }
    if (generation !== view.plutoGeneration) return;
    view.disposePluto = window.StreamplexPluto.mount(view.shell, view.stream.streamId, {
      onReady: () => { view.audioButton.disabled = false; syncAudioButtons(); },
      onAudioChange: ({ muted, volume }) => {
        audioVolumes.set(view.stream.id, volume);
        if (!muted && volume > 0 && activeAudioChannel !== view.stream.id) setActiveAudioChannel(view.stream.id, false);
        else if ((muted || volume === 0) && activeAudioChannel === view.stream.id) setActiveAudioChannel(null);
      },
    });
    const video = view.shell.querySelector("video");
    if (video) {
      video.volume = audioVolumes.get(view.stream.id) ?? DEFAULT_ACTIVE_VOLUME;
      video.muted = activeAudioChannel !== view.stream.id;
    }
  } catch (error) {
    if (generation === view.plutoGeneration) {
      renderShellPlaceholder(view, view.stream.label, "Video player could not load. Reload, or use Open to watch on Pluto TV.", "offline");
    }
  }
}

function renderShellPlaceholder(view, channel, message, state) {
  if (!view || !view.shell) {
    return;
  }

  view.shell.replaceChildren();

  const placeholder = document.createElement("div");
  placeholder.className = `stream-placeholder stream-placeholder-${state}`;

  const label = document.createElement("span");
  label.className = "stream-placeholder-label";
  label.textContent = channel;

  const status = document.createElement("span");
  status.className = "stream-placeholder-state";
  status.textContent = message;

  placeholder.append(label, status);
  view.shell.append(placeholder);
}

function teardownPlayer(channel) {
  const view = streamViews.get(channel);
  const player = players.get(channel);
  // Invalidate callbacks before destroy/pause can synchronously emit events.
  players.delete(channel);
  if (view) {
    view.mountGeneration = (view.mountGeneration || 0) + 1;
    view.ready = false;
    window.clearTimeout(view.startupTimer);
    view.playerResizeObserver?.disconnect();
    view.playerResizeObserver = null;
    view.playerEvents?.forEach(({ event, handler }) => player?.removeEventListener?.(event, handler));
    view.playerEvents = [];
    view.sdkListeners?.forEach(({ listener, options }) => window.removeEventListener("message", listener, options));
    view.sdkListeners = [];
  }
  try { player?.destroy?.(); } catch { /* Complete our cleanup even if the SDK fails. */ }
  view?.shell.querySelector(".player-mount")?.remove();
  if (view) view.playerMount = null;
  if (!players.size) { window.clearInterval(audioMonitor); audioMonitor = null; }
}

function setChannelStatus(channel, state) {
  const view = pillViews.get(channel);
  if (!view || !view.pill || !view.status) {
    return;
  }

  view.pill.classList.remove("is-live", "is-offline", "is-pending");
  view.pill.classList.add(`is-${state}`);
  view.status.title =
    state === "offline" ? "Offline" : state === "pending" ? "Checking live status" : "";
}

function setActiveAudioChannel(channel, toggle = true) {
  captureActiveAudioVolume();
  activeAudioChannel = toggle && activeAudioChannel === channel ? null : channel;
  activeAudioVolume = audioVolumes.get(activeAudioChannel) ?? DEFAULT_ACTIVE_VOLUME;
  syncPlayerAudio({ forceActiveVolume: true });
  syncAudioButtons();
}

function clearActiveAudioChannel() {
  setActiveAudioChannel(null);
}

function syncPlayerAudio(options = {}) {
  if (!options.forceActiveVolume) {
    captureActiveAudioVolume();
  }

  players.forEach((player, channel) => {
    if (streamViews.get(channel)?.ready) applyPlayerAudioState(channel, player);
  });
  streamViews.forEach((view, id) => {
    if (!isPlutoView(view)) return;
    const video = view.shell.querySelector("video");
    if (video) {
      video.muted = id !== activeAudioChannel;
      if (id === activeAudioChannel) video.volume = activeAudioVolume;
    }
  });
}

function captureActiveAudioVolume() {
  if (!activeAudioChannel) {
    return;
  }

  const view = streamViews.get(activeAudioChannel);
  if (isPlutoView(view)) {
    const video = view.shell.querySelector("video");
    if (video) activeAudioVolume = video.volume;
  } else {
    capturePlayerAudioVolume(players.get(activeAudioChannel));
  }
  audioVolumes.set(activeAudioChannel, activeAudioVolume);
}

function capturePlayerAudioVolume(player) {
  if (!player || typeof player.getVolume !== "function") {
    return;
  }

  try {
    const nextVolume = Number(player.getVolume());
    if (Number.isFinite(nextVolume)) {
      activeAudioVolume = clampVolume(nextVolume);
    }
  } catch (error) {
    // Some player states do not expose volume yet; keep the last known active volume.
  }
}

function clampVolume(value) {
  return Math.min(Math.max(value, 0), 1);
}

function applyPlayerAudioState(channel, player) {
  const isActive = channel === activeAudioChannel;

  if (typeof player.setMuted === "function") {
    player.setMuted(!isActive);
  }

  if (typeof player.setVolume === "function") {
    // Muting must not erase the user's selected volume.
    if (isActive) player.setVolume(activeAudioVolume);
  }
}

function requestPlayerPlayback(channel, player, options = {}) {
  const view = streamViews.get(channel);
  if (!view?.ready || view.userPaused || view.tile.hidden) return;
  safelyPlayPlayer(player);
}

function startAudioMonitor() {
  if (audioMonitor) return;
  // Twitch has no documented volume-change event. Observe transitions, not
  // stale command acknowledgements, to include its native mute controls.
  audioMonitor = window.setInterval(() => {
    players.forEach((player, id) => {
      const view = streamViews.get(id);
      if (!view?.ready) return;
      try {
        const snapshot = { muted: player.getMuted(), volume: player.getVolume() };
        const previous = view.audioSnapshot;
        view.audioSnapshot = snapshot;
        if (!previous) return;
        if (!snapshot.muted && snapshot.volume > 0 && (previous.muted || previous.volume === 0)) {
          audioVolumes.set(id, snapshot.volume);
          if (activeAudioChannel !== id) setActiveAudioChannel(id, false);
        } else if (activeAudioChannel === id && (snapshot.muted || snapshot.volume === 0)) {
          setActiveAudioChannel(null);
        } else if (activeAudioChannel === id) audioVolumes.set(id, snapshot.volume);
      } catch { /* Player is transitioning; try the next tick. */ }
    });
  }, 1000);
}

function applyPlayerQualityPreference(player) {
  if (
    !player ||
    typeof player.getQualities !== "function" ||
    typeof player.getQuality !== "function" ||
    typeof player.setQuality !== "function"
  ) {
    return;
  }

  try {
    const currentQuality = player.getQuality();
    if (typeof currentQuality === "string" && PREFERRED_QUALITY_PATTERN.test(currentQuality)) {
      return true;
    }

    const qualities = player.getQualities();
    const availableQualities = Array.isArray(qualities)
      ? qualities.map((quality) => typeof quality === "string" ? quality : quality?.group).filter((quality) => typeof quality === "string" && quality.length > 0)
      : [];
    const preferredQuality = pickPreferredQuality(availableQualities);

    if (!preferredQuality || preferredQuality === currentQuality) {
      return Boolean(preferredQuality);
    }

    player.setQuality(preferredQuality);
    return true;
  } catch (error) {
    // Ignore quality selection timing errors; the next player event or retry will try again.
  }
}

function pickPreferredQuality(qualities) {
  const exactMatches = qualities.filter((quality) => PREFERRED_QUALITY_PATTERN.test(quality));
  if (!exactMatches.length) {
    const resolutions = qualities.filter((quality) => /^\d+p\d*$/.test(quality));
    const smaller = resolutions.filter((quality) => parseInt(quality, 10) < 480);
    return (smaller.length ? smaller.sort((a, b) => parseInt(b, 10) - parseInt(a, 10)) : resolutions.sort((a, b) => parseInt(a, 10) - parseInt(b, 10)))[0] || null;
  }

  exactMatches.sort((left, right) => extractQualityFps(right) - extractQualityFps(left));
  return exactMatches[0];
}

function extractQualityFps(quality) {
  const match = quality.match(/^480p(\d+)$/i);
  return match ? Number.parseInt(match[1], 10) || 0 : 0;
}

function syncAudioButtons() {
  streamViews.forEach((view, channel) => {
    if (!view.audioButton) {
      return;
    }

    const isActive = channel === activeAudioChannel;
    view.audioButton.classList.toggle("active", isActive);
    view.audioButton.setAttribute("aria-pressed", isActive ? "true" : "false");
    view.audioButton.textContent = isActive ? "On" : "Audio";
    view.audioButton.setAttribute("aria-label", isActive ? `Mute ${view.stream.label}` : `Listen to ${view.stream.label}`);
  });
}

function getStoredTheme() {
  let storedTheme = null;

  try {
    storedTheme = window.localStorage.getItem(THEME_STORAGE_KEY);
  } catch (error) {
    storedTheme = null;
  }

  return storedTheme === "light" ? "light" : "dark";
}

function setTheme(theme) {
  activeTheme = theme === "light" ? "light" : "dark";

  try {
    window.localStorage.setItem(THEME_STORAGE_KEY, activeTheme);
  } catch (error) {
    // Ignore storage failures; the in-memory theme still updates for this session.
  }

  applyTheme(activeTheme);
}

function applyTheme(theme) {
  const safeTheme = theme === "light" ? "light" : "dark";
  const isLight = safeTheme === "light";
  const nextLabel = isLight ? "Dark" : "Light";
  const nextTitle = isLight ? "Switch to dark mode" : "Switch to light mode";

  document.documentElement.dataset.theme = safeTheme;

  if (themeToggle) {
    themeToggle.setAttribute("aria-label", nextTitle);
    themeToggle.setAttribute("aria-pressed", isLight ? "true" : "false");
    themeToggle.title = nextTitle;
  }

  if (themeToggleLabel) {
    themeToggleLabel.textContent = nextLabel;
  }

  if (themeColorMeta) {
    themeColorMeta.setAttribute("content", isLight ? "#f1f1ef" : "#121212");
  }
}

function setPollIndicatorState(state, text) {
  if (!pollIndicator || !pollIndicatorText) {
    return;
  }

  pollIndicator.classList.remove("is-checking", "is-ok", "is-error", "is-idle");
  pollIndicator.classList.add(`is-${state}`);
  pollIndicatorText.textContent = text;
}

function updatePollIndicator() {
  if (!pollIndicator || !pollIndicatorText) {
    return;
  }

  if (pollInFlight) {
    setPollIndicatorState("checking", "Checking live status");
    return;
  }

  if (!hasTwitchStreams()) {
    setPollIndicatorState("idle", "No Twitch streams selected");
    return;
  }

  const secondsUntilNext = nextPollAt ? Math.max(Math.ceil((nextPollAt - Date.now()) / 1000), 0) : null;
  const suffix =
    secondsUntilNext === null
      ? ""
      : secondsUntilNext > 0
        ? ` in ${secondsUntilNext}s`
        : " now";

  if (lastPollState === "error") {
    setPollIndicatorState("error", `Retry${suffix}`);
    return;
  }

  setPollIndicatorState("ok", `Refresh${suffix}`);
}

function syncGridLayout() {
  if (!streamGrid) {
    return;
  }

  const visibleCount = syncVisibleStreamState();

  if (!visibleCount) {
    streamGrid.classList.remove("stream-grid-dynamic");
    streamGrid.style.removeProperty("--dynamic-tile-width");
    streamGrid.style.removeProperty("--dynamic-tile-height");
    streamGrid.style.removeProperty("--grid-height");
    return;
  }

  const gap = parseFloat(window.getComputedStyle(streamGrid).getPropertyValue("--stream-gap")) || 0;
  const shellStyles = appShell ? window.getComputedStyle(appShell) : null;
  const shellBottomPadding = shellStyles ? parseFloat(shellStyles.paddingBottom || "0") || 0 : 0;
  const gridRect = streamGrid.getBoundingClientRect();
  const gridWidth = Math.max(gridRect.width, 0);
  const availableHeight = Math.max(window.innerHeight - gridRect.top - shellBottomPadding - 6, 0);
  const { columns, rows, gap: fittedGap } = chooseBestGrid(visibleCount, gridWidth, availableHeight, gap);
  const tileWidth = Math.max(
    Math.floor((gridWidth - fittedGap * Math.max(columns - 1, 0)) / columns),
    0
  );
  const tileHeight = Math.max(
    Math.floor((availableHeight - fittedGap * Math.max(rows - 1, 0)) / rows),
    0
  );

  streamGrid.classList.add("stream-grid-dynamic");
  // At very small sizes, reserve the tile for video rather than its toolbar.
  streamGrid.classList.toggle("stream-grid-compact", tileHeight < 64);
  streamGrid.style.setProperty("--dynamic-grid-gap", `${fittedGap}px`);
  streamGrid.style.setProperty("--dynamic-tile-width", `${tileWidth}px`);
  streamGrid.style.setProperty("--dynamic-tile-height", `${tileHeight}px`);
  streamGrid.style.setProperty(
    "--grid-height",
    `${rows * tileHeight + fittedGap * Math.max(rows - 1, 0)}px`
  );
  window.requestAnimationFrame(() => {
    streamViews.forEach((view) => { if (isTwitchView(view)) syncTwitchPlayerSize(view); });
    mountPendingPlayers();
  });
}

function scheduleGridLayoutSync() {
  if (layoutSyncFrame) {
    window.cancelAnimationFrame(layoutSyncFrame);
  }

  layoutSyncFrame = window.requestAnimationFrame(() => {
    layoutSyncFrame = null;
    syncGridLayout();
  });
}

function syncVisibleStreamState() {
  const visibleCount = [...streamViews.values()].filter(
    (view) => view.tile && !view.tile.hidden
  ).length;

  if (streamGrid) {
    streamGrid.hidden = visibleCount === 0;
  }

  if (emptyState) {
    emptyState.hidden = visibleCount !== 0;
  }

  if (emptyStateText) {
    emptyStateText.textContent = currentStreams.length
      ? "No live Twitch streams."
      : "No streams selected.";
  }

  return visibleCount;
}

function chooseBestGrid(count, width, height, gap) {
  let best = {
    columns: 1,
    rows: count,
    gap,
    score: Number.NEGATIVE_INFINITY,
  };

  for (let columns = 1; columns <= count; columns += 1) {
    const rows = Math.ceil(count / columns);
    // Gutters must shrink too when many streams share a small viewport.
    const fittedGap = Math.max(0, Math.min(gap, width / (2 * columns), height / (2 * rows)));
    const tileWidth = Math.max((width - fittedGap * (columns - 1)) / columns, 0);
    const tileHeight = Math.max((height - fittedGap * Math.max(rows - 1, 0)) / rows, 0);
    const tileArea = tileWidth * tileHeight;
    const aspect = tileHeight > 0 ? tileWidth / tileHeight : 0;
    const aspectPenalty = Math.abs(Math.log((aspect || 1) / (16 / 9)));
    const score = tileArea * (1 - Math.min(aspectPenalty, 1.25) * 0.35);

    if (score > best.score) {
      best = {
        columns,
        rows,
        gap: fittedGap,
        score,
      };
    }
  }

  return best;
}

function safelyPlayPlayer(player) {
  if (!player || typeof player.play !== "function") {
    return;
  }

  try {
    player.play();
  } catch (error) {
    // Ignore autoplay timing failures; the next poll or interaction will retry.
  }
}

function isChannelVisible(channel) {
  const view = streamViews.get(channel);
  return Boolean(view && !view.tile.hidden && view.tile.dataset.live === "true");
}

function hasTwitchStreams() {
  for (const view of streamViews.values()) {
    if (isTwitchView(view)) {
      return true;
    }
  }

  return false;
}

function getTwitchStreamIds() {
  const channels = [];

  streamViews.forEach((view, channel) => {
    if (isTwitchView(view)) {
      channels.push(channel);
    }
  });

  return channels;
}

function parseChannels(value) {
  const trimmedValue = value.trim();
  let source = trimmedValue;

  if (/^https?:\/\//i.test(trimmedValue)) {
    try {
      const url = new URL(trimmedValue);
      source = url.searchParams.get(STREAMS_QUERY_PARAM) ||
        (/^(?:www\.)?twitch\.tv$/i.test(url.hostname) && /^\/[a-z0-9_]+\/?$/i.test(url.pathname) ? url.pathname.split("/")[1] : "");
    } catch (error) {
      source = "";
    }
  }

  return parseChannelList(source);
}

function sanitizeChannel(value) {
  return value.trim().toLowerCase().replace(/[^a-z0-9_]/g, "");
}

function sanitizePlutoStreamId(value) {
  const trimmedValue = value.trim();
  let candidate = trimmedValue;

  if (/^https?:\/\//i.test(trimmedValue)) {
    try {
      const url = new URL(trimmedValue);
      const pathMatch = url.pathname.match(/^\/us\/(?:watch\/)?live-tv\/([^/?#]+)\/?$/i);
      candidate = PLUTO_HOSTS.has(url.hostname.toLowerCase()) && pathMatch ? pathMatch[1] : "";
    } catch (error) {
      candidate = "";
    }
  }

  return PLUTO_STREAM_ID_PATTERN.test(candidate) ? candidate.toLowerCase() : "";
}
