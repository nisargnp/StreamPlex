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
const PLUTO_LIVE_TV_BASE_URL = "https://pluto.tv/us/live-tv/";
const PLUTO_STREAM_ID_PATTERN = /^[a-f0-9]{24}$/i;
const PLUTO_HOSTS = new Set(["pluto.tv", "www.pluto.tv"]);
const currentChannels = parseInitialChannels();
const currentPlutoStream = parseInitialPlutoStream();
const currentStreams = buildStreamEntries(currentChannels, currentPlutoStream);
const streamViews = new Map();
const pillViews = new Map();
const players = new Map();
const autoplayMonitors = new Map();
const THEME_STORAGE_KEY = "streamplex-theme";
const DEFAULT_ACTIVE_VOLUME = 0.5;
const INACTIVE_VOLUME = 0;
const POLL_INTERVAL_MS = 300000;
const PROBE_TIMEOUT_MS = 8000;
const FETCH_PROBE_TIMEOUT_MS = 5000;
const PREFERRED_QUALITY_PATTERN = /^480p(?:\d+)?$/i;
// Pluto is cross-origin, so crop the full page iframe as an opaque visual surface.
const PLUTO_FRAME_WIDTH = 1280;
const PLUTO_FRAME_HEIGHT = 720;
// "contain" preserves the calibrated crop; "cover" fills odd-shaped boxes by cropping more.
const PLUTO_CROP_FIT = "contain";
const PLUTO_CROP_RECT = {
  x: 240,
  y: 47.571,
  width: 800,
  height: 450,
};
const PLUTO_FRAME_OFFSET = {
  x: 0,
  y: 0.05,
};
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
let autoplaySyncFrame = null;
let autoplaySyncTimeouts = [];
let layoutSyncFrame = null;
let plutoCropSyncFrame = null;
let plutoResizeObserver = null;
const pendingPlutoCropShells = new Set();
let probeSequence = 0;
let activeAudioVolume = DEFAULT_ACTIVE_VOLUME;
let activeTheme = getStoredTheme();

applyTheme(activeTheme);
renderInitialView();
bindEvents();
startStatusPolling();

function renderInitialView() {
  renderChannelPills();
  renderStreamTiles();
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

      const nextChannels = mergeChannels(currentChannels, parseChannels(value));
      navigateToChannels(nextChannels);
    });
  }

  if (channelList) {
    channelList.addEventListener("click", (event) => {
      const button = event.target.closest("[data-remove-channel]");
      if (!button) {
        return;
      }

      const channel = sanitizeChannel(button.dataset.removeChannel || "");
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

      const channel = sanitizeChannel(button.dataset.audioChannel || "");
      if (!channel) {
        return;
      }

      setActiveAudioChannel(channel);
    });
  }

  window.addEventListener("resize", scheduleGridLayoutSync);
  window.addEventListener("pageshow", handlePageShow);
}

function renderChannelPills() {
  pillViews.clear();

  if (!channelList) {
    return;
  }

  channelList.querySelectorAll("[data-channel-pill]").forEach((pill) => pill.remove());

  const fragment = document.createDocumentFragment();

  currentChannels.forEach((channel) => {
    const pill = document.createElement("div");
    pill.className = "channel-pill is-pending";
    pill.dataset.channelPill = channel;

    const status = document.createElement("span");
    status.className = "channel-pill-status";
    status.dataset.channelStatus = channel;
    status.setAttribute("aria-hidden", "true");

    const label = document.createElement("span");
    label.className = "channel-pill-label";
    label.textContent = channel;

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
}

function renderStreamTiles() {
  streamViews.clear();

  if (!streamGrid) {
    return;
  }

  streamGrid.replaceChildren();

  const fragment = document.createDocumentFragment();

  currentStreams.forEach((stream) => {
    const tile = document.createElement("article");
    tile.className = "stream-tile";
    tile.dataset.streamChannel = stream.id;
    tile.dataset.provider = stream.provider;
    tile.dataset.live = isPlutoStream(stream) ? "true" : "pending";
    tile.dataset.mountPending = "false";

    const header = document.createElement("header");
    header.className = "stream-name";

    const label = document.createElement("span");
    label.className = "stream-name-label";
    label.textContent = stream.label;

    const action = createStreamAction(stream);

    header.append(label, action);

    const shell = document.createElement("div");
    shell.className = "player-shell";
    shell.dataset.playerShell = stream.id;

    tile.append(header, shell);
    fragment.append(tile);

    const view = { tile, shell, audioButton: isTwitchStream(stream) ? action : null, stream };
    streamViews.set(stream.id, view);

    if (isPlutoStream(stream)) {
      renderPlutoStream(view);
      return;
    }

    renderShellPlaceholder(view, stream.label, "Checking live status", "pending");
  });

  streamGrid.append(fragment);
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

  const audioButton = document.createElement("button");
  audioButton.className = "stream-audio-button";
  audioButton.type = "button";
  audioButton.dataset.audioChannel = stream.id;
  audioButton.setAttribute("aria-pressed", "false");
  audioButton.disabled = true;
  audioButton.textContent = "Audio";
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

  return {
    id: `pluto-${streamId}`,
    provider: "pluto",
    label: "Pluto TV",
    streamId,
    url: `${PLUTO_LIVE_TV_BASE_URL}${streamId}`,
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

function navigateToChannels(channels) {
  window.location.assign(buildStreamUrl(channels, currentPlutoStream).toString());
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
  setPollIndicatorState("checking", "Checking live status");

  try {
    await pollStreamStatuses();
    lastPollState = "ok";
  } catch (error) {
    lastPollState = "error";
  } finally {
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

  clearAutoplaySync();

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
  clearActiveAudioChannel();
  syncGridLayout();
  startStatusPolling();
}

async function pollStreamStatuses() {
  const channels = getTwitchStreamIds();

  if (!channels.length) {
    return;
  }

  const results = await Promise.all(
    channels.map(async (channel) => ({
      channel,
      state: await safelyProbeStreamPreview(channel),
    }))
  );

  let activeStillLive = false;

  results.forEach(({ channel, state }) => {
    if (state === "live") {
      renderLiveStream(channel);
      setChannelStatus(channel, "live");
      if (channel === activeAudioChannel) {
        activeStillLive = true;
      }
      return;
    }

    if (state === "offline") {
      renderOfflineStream(channel);
      setChannelStatus(channel, "offline");
      return;
    }

    retainExistingStreamState(channel);
    if (channel === activeAudioChannel && isChannelVisible(channel)) {
      activeStillLive = true;
    }
  });

  if (!activeStillLive) {
    clearActiveAudioChannel();
  }

  syncPlayerAudio();
  syncAudioButtons();
  syncGridLayout();
}

async function safelyProbeStreamPreview(channel) {
  try {
    return await probeStreamPreview(channel);
  } catch (error) {
    return "unknown";
  }
}

async function probeStreamPreview(channel) {
  const cacheToken = `${Date.now()}-${probeSequence}`;
  probeSequence += 1;

  const previewUrl = `${buildPreviewUrl(channel)}?cb=${cacheToken}`;
  const fetchState = await probeStreamPreviewViaFetch(previewUrl);

  if (fetchState !== "unknown") {
    return fetchState;
  }

  return probeStreamPreviewViaImage(previewUrl);
}

function buildPreviewUrl(channel) {
  return `https://static-cdn.jtvnw.net/previews-ttv/live_user_${channel}-440x248.jpg`;
}

async function probeStreamPreviewViaFetch(previewUrl) {
  if (typeof fetch !== "function" || typeof AbortController === "undefined") {
    return "unknown";
  }

  const abortController = new AbortController();
  const timeoutId = window.setTimeout(() => {
    abortController.abort();
  }, FETCH_PROBE_TIMEOUT_MS);

  try {
    const response = await fetch(previewUrl, {
      method: "GET",
      mode: "cors",
      cache: "no-store",
      signal: abortController.signal,
    });

    if (response.type === "opaque" || response.type === "opaqueredirect") {
      return "unknown";
    }

    if (response.status === 403 || response.status === 404) {
      return "offline";
    }

    if (isPlaceholderPreviewUrl(response.url)) {
      return "offline";
    }

    if (response.ok) {
      return "live";
    }

    return "unknown";
  } catch (error) {
    return "unknown";
  } finally {
    window.clearTimeout(timeoutId);
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

      finish(image.naturalWidth > 0 && image.naturalHeight > 0 ? "live" : "offline");
    };

    image.onerror = () => finish("offline");
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

function mountPlayer(channel, view) {
  view.tile.dataset.mountPending = "false";

  if (typeof Twitch === "undefined" || typeof Twitch.Player === "undefined") {
    retainExistingStreamState(channel);
    return;
  }

  view.shell.replaceChildren();

  const mount = document.createElement("div");
  mount.className = "player-mount";
  mount.id = `player-${channel}`;
  view.shell.append(mount);

  const player = new Twitch.Player(mount.id, {
    channel,
    width: "100%",
    height: "100%",
    parent: [window.location.hostname || "127.0.0.1"],
    autoplay: true,
    muted: true,
  });

  players.set(channel, player);

  if (typeof player.addEventListener === "function" && Twitch.Player.READY) {
    player.addEventListener(Twitch.Player.READY, () => {
      queuePlayerAutoplay(channel, player);
      requestPlayerPlayback(channel, player);
    });
  }

  if (typeof player.addEventListener === "function" && Twitch.Player.ONLINE) {
    player.addEventListener(Twitch.Player.ONLINE, () => {
      queuePlayerAutoplay(channel, player);
      requestPlayerPlayback(channel, player);
    });
  }

  if (typeof player.addEventListener === "function" && Twitch.Player.PLAYING) {
    player.addEventListener(Twitch.Player.PLAYING, () => {
      clearPlayerAutoplay(channel);
    });
  }

  if (typeof player.addEventListener === "function" && Twitch.Player.PLAYBACK_BLOCKED) {
    player.addEventListener(Twitch.Player.PLAYBACK_BLOCKED, () => {
      window.setTimeout(() => {
        if (players.get(channel) !== player) {
          return;
        }

        queuePlayerAutoplay(channel, player);
        requestPlayerPlayback(channel, player);
      }, 120);
    });
  }

  queuePlayerAutoplay(channel, player);
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

function renderPlutoStream(view) {
  if (!isPlutoView(view) || !view.shell) {
    return;
  }

  view.tile.hidden = false;
  view.tile.dataset.live = "true";
  view.tile.dataset.mountPending = "false";
  view.shell.replaceChildren();

  const iframe = document.createElement("iframe");
  iframe.className = "pluto-frame";
  iframe.src = view.stream.url;
  iframe.title = `${view.stream.label} on Pluto TV`;
  iframe.allow = "autoplay; fullscreen; encrypted-media; picture-in-picture";
  iframe.allowFullscreen = true;
  iframe.referrerPolicy = "strict-origin-when-cross-origin";

  view.shell.append(iframe);
  observePlutoShell(view.shell);
  syncPlutoCrop(view.shell);
}

function observePlutoShell(shell) {
  if (!shell || typeof ResizeObserver === "undefined") {
    return;
  }

  if (!plutoResizeObserver) {
    plutoResizeObserver = new ResizeObserver((entries) => {
      entries.forEach((entry) => {
        schedulePlutoCropSync(entry.target);
      });
    });
  }

  plutoResizeObserver.observe(shell);
}

function schedulePlutoCropSync(shell) {
  if (shell) {
    pendingPlutoCropShells.add(shell);
  } else {
    streamViews.forEach((view) => {
      if (isPlutoView(view) && view.shell) {
        pendingPlutoCropShells.add(view.shell);
      }
    });
  }

  if (plutoCropSyncFrame) {
    return;
  }

  plutoCropSyncFrame = window.requestAnimationFrame(() => {
    plutoCropSyncFrame = null;
    const shells = [...pendingPlutoCropShells];
    pendingPlutoCropShells.clear();
    shells.forEach((entry) => syncPlutoCrop(entry));
  });
}

function syncAllPlutoCrops() {
  streamViews.forEach((view) => {
    if (isPlutoView(view) && view.shell) {
      syncPlutoCrop(view.shell);
    }
  });
}

function syncPlutoCrop(shell) {
  if (!shell || !shell.querySelector(".pluto-frame")) {
    return;
  }

  const rect = shell.getBoundingClientRect();
  const shellWidth = Math.max(rect.width || shell.clientWidth || 0, 0);
  const shellHeight = Math.max(rect.height || shell.clientHeight || 0, 0);

  if (shellWidth <= 0 || shellHeight <= 0) {
    return;
  }

  const scale = getPlutoCropScale(shellWidth, shellHeight);
  const x =
    (shellWidth - PLUTO_CROP_RECT.width * scale) / 2 -
    PLUTO_CROP_RECT.x * scale +
    shellWidth * PLUTO_FRAME_OFFSET.x;
  const y =
    (shellHeight - PLUTO_CROP_RECT.height * scale) / 2 -
    PLUTO_CROP_RECT.y * scale +
    shellHeight * PLUTO_FRAME_OFFSET.y;

  shell.style.setProperty("--pluto-frame-width", `${PLUTO_FRAME_WIDTH}px`);
  shell.style.setProperty("--pluto-frame-height", `${PLUTO_FRAME_HEIGHT}px`);
  shell.style.setProperty("--pluto-frame-scale", formatCssNumber(scale));
  shell.style.setProperty("--pluto-frame-x", formatCssPixels(x));
  shell.style.setProperty("--pluto-frame-y", formatCssPixels(y));
}

function getPlutoCropScale(shellWidth, shellHeight) {
  const widthScale = shellWidth / PLUTO_CROP_RECT.width;
  const heightScale = shellHeight / PLUTO_CROP_RECT.height;

  if (PLUTO_CROP_FIT === "cover") {
    return Math.max(widthScale, heightScale);
  }

  return Math.min(widthScale, heightScale);
}

function formatCssNumber(value) {
  if (!Number.isFinite(value)) {
    return "1";
  }

  const formattedValue = value.toFixed(4).replace(/\.?0+$/, "");
  return formattedValue || "0";
}

function formatCssPixels(value) {
  if (!Number.isFinite(value)) {
    return "0px";
  }

  const formattedValue = value.toFixed(3).replace(/\.?0+$/, "");
  return `${formattedValue || "0"}px`;
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
  clearPlayerAutoplay(channel);

  if (!players.has(channel)) {
    return;
  }

  const player = players.get(channel);
  if (player && typeof player.pause === "function") {
    player.pause();
  }

  players.delete(channel);
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

function setActiveAudioChannel(channel) {
  activeAudioChannel = channel;
  activeAudioVolume = DEFAULT_ACTIVE_VOLUME;
  syncPlayerAudio({ forceActiveVolume: true });
  syncAudioButtons();
}

function clearActiveAudioChannel() {
  activeAudioChannel = null;
  activeAudioVolume = DEFAULT_ACTIVE_VOLUME;
}

function syncPlayerAudio(options = {}) {
  if (!options.forceActiveVolume) {
    captureActiveAudioVolume();
  }

  players.forEach((player, channel) => {
    requestPlayerPlayback(channel, player, options);
  });
}

function captureActiveAudioVolume() {
  if (!activeAudioChannel) {
    return;
  }

  capturePlayerAudioVolume(players.get(activeAudioChannel));
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
    player.setVolume(isActive ? activeAudioVolume : INACTIVE_VOLUME);
  }
}

function requestPlayerPlayback(channel, player, options = {}) {
  if (!options.forceActiveVolume && channel === activeAudioChannel) {
    capturePlayerAudioVolume(player);
  }

  applyPlayerQualityPreference(player);
  applyPlayerAudioState(channel, player);
  safelyPlayPlayer(player);
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
      return;
    }

    const qualities = player.getQualities();
    const availableQualities = Array.isArray(qualities)
      ? qualities.filter((quality) => typeof quality === "string" && quality.length > 0)
      : [];
    const preferredQuality = pickPreferredQuality(availableQualities);

    if (!preferredQuality || preferredQuality === currentQuality) {
      return;
    }

    player.setQuality(preferredQuality);
  } catch (error) {
    // Ignore quality selection timing errors; the next player event or retry will try again.
  }
}

function pickPreferredQuality(qualities) {
  const exactMatches = qualities.filter((quality) => PREFERRED_QUALITY_PATTERN.test(quality));
  if (!exactMatches.length) {
    return null;
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
    if (!isTwitchView(view) || !view.audioButton) {
      return;
    }

    const isActive = channel === activeAudioChannel;
    view.audioButton.classList.toggle("active", isActive);
    view.audioButton.setAttribute("aria-pressed", isActive ? "true" : "false");
    view.audioButton.textContent = isActive ? "On" : "Audio";
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
    themeColorMeta.setAttribute("content", isLight ? "#f5f5f2" : "#000000");
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
    clearAutoplaySync();
    streamGrid.classList.remove("stream-grid-dynamic");
    streamGrid.style.removeProperty("--dynamic-tile-width");
    streamGrid.style.removeProperty("--dynamic-tile-height");
    streamGrid.style.removeProperty("--grid-height");
    return;
  }

  const gap = parseFloat(window.getComputedStyle(streamGrid).columnGap || "0") || 0;
  const shellStyles = appShell ? window.getComputedStyle(appShell) : null;
  const shellBottomPadding = shellStyles ? parseFloat(shellStyles.paddingBottom || "0") || 0 : 0;
  const gridRect = streamGrid.getBoundingClientRect();
  const gridWidth = Math.max(streamGrid.clientWidth || gridRect.width, 0);
  const availableHeight = Math.max(window.innerHeight - gridRect.top - shellBottomPadding - 6, 0);
  const { columns, rows } = chooseBestGrid(visibleCount, gridWidth, availableHeight, gap);
  const tileWidth = Math.max(
    Math.floor((gridWidth - gap * Math.max(columns - 1, 0)) / columns),
    0
  );
  const tileHeight = Math.max(
    Math.floor((availableHeight - gap * Math.max(rows - 1, 0)) / rows),
    0
  );

  streamGrid.classList.add("stream-grid-dynamic");
  streamGrid.style.setProperty("--dynamic-tile-width", `${tileWidth}px`);
  streamGrid.style.setProperty("--dynamic-tile-height", `${tileHeight}px`);
  streamGrid.style.setProperty(
    "--grid-height",
    `${rows * tileHeight + gap * Math.max(rows - 1, 0)}px`
  );
  syncAllPlutoCrops();
  window.requestAnimationFrame(() => {
    mountPendingPlayers();
    if (players.size) {
      scheduleAutoplaySync();
    } else {
      clearAutoplaySync();
    }
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
    score: Number.NEGATIVE_INFINITY,
  };

  for (let columns = 1; columns <= count; columns += 1) {
    const rows = Math.ceil(count / columns);
    const tileWidth = Math.max((width - gap * (columns - 1)) / columns, 0);
    const tileHeight = Math.max((height - gap * Math.max(rows - 1, 0)) / rows, 0);
    const tileArea = tileWidth * tileHeight;
    const aspect = tileHeight > 0 ? tileWidth / tileHeight : 0;
    const aspectPenalty = Math.abs(Math.log((aspect || 1) / (16 / 9)));
    const score = tileArea * (1 - Math.min(aspectPenalty, 1.25) * 0.35);

    if (score > best.score) {
      best = {
        columns,
        rows,
        score,
      };
    }
  }

  return best;
}

function autoplayVisiblePlayers() {
  players.forEach((player, channel) => {
    const view = streamViews.get(channel);
    if (!isTwitchView(view) || view.tile.hidden || !hasPlayableArea(view.shell)) {
      return;
    }

    requestPlayerPlayback(channel, player);
  });
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

function scheduleAutoplaySync() {
  if (autoplaySyncFrame) {
    window.cancelAnimationFrame(autoplaySyncFrame);
  }

  autoplaySyncTimeouts.forEach((timer) => window.clearTimeout(timer));
  autoplaySyncTimeouts = [];

  autoplaySyncFrame = window.requestAnimationFrame(() => {
    autoplayVisiblePlayers();
    autoplaySyncFrame = null;
  });

  [180, 650].forEach((delay) => {
    const timer = window.setTimeout(() => {
      autoplayVisiblePlayers();
      autoplaySyncTimeouts = autoplaySyncTimeouts.filter((entry) => entry !== timer);
    }, delay);

    autoplaySyncTimeouts.push(timer);
  });
}

function queuePlayerAutoplay(channel, player) {
  clearPlayerAutoplay(channel);

  const kick = () => {
    const view = streamViews.get(channel);
    if (
      players.get(channel) !== player ||
      !isTwitchView(view) ||
      view.tile.hidden ||
      !hasPlayableArea(view.shell)
    ) {
      return;
    }

    requestPlayerPlayback(channel, player);
  };

  const delayTimers = [0, 160, 420, 900, 1800].map((delay) => window.setTimeout(kick, delay));
  const interval = window.setInterval(kick, 2500);
  const stopTimer = window.setTimeout(() => {
    clearPlayerAutoplay(channel);
  }, 45000);

  autoplayMonitors.set(channel, {
    delayTimers,
    interval,
    stopTimer,
  });
}

function clearPlayerAutoplay(channel) {
  const monitor = autoplayMonitors.get(channel);
  if (!monitor) {
    return;
  }

  monitor.delayTimers.forEach((timer) => window.clearTimeout(timer));
  window.clearInterval(monitor.interval);
  window.clearTimeout(monitor.stopTimer);
  autoplayMonitors.delete(channel);
}

function clearAutoplaySync() {
  if (autoplaySyncFrame) {
    window.cancelAnimationFrame(autoplaySyncFrame);
    autoplaySyncFrame = null;
  }

  autoplaySyncTimeouts.forEach((timer) => window.clearTimeout(timer));
  autoplaySyncTimeouts = [];
}

function hasPlayableArea(element) {
  if (!element) {
    return false;
  }

  const rect = element.getBoundingClientRect();
  return rect.width > 24 && rect.height > 24;
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
      source = url.searchParams.get(STREAMS_QUERY_PARAM) || "";
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
      const pathMatch = url.pathname.match(/^\/us\/live-tv\/([^/?#]+)\/?$/i);
      candidate = PLUTO_HOSTS.has(url.hostname.toLowerCase()) && pathMatch ? pathMatch[1] : "";
    } catch (error) {
      candidate = "";
    }
  }

  return PLUTO_STREAM_ID_PATTERN.test(candidate) ? candidate.toLowerCase() : "";
}
