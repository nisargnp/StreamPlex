const appShell = document.querySelector(".app-shell");
const channelList = document.querySelector("#channel-list");
const addButton = document.querySelector("#add-channel");
const streamGrid = document.querySelector("#stream-grid");
const emptyState = document.querySelector("#empty-state");
const pollIndicator = document.querySelector("#poll-indicator");
const pollIndicatorText = document.querySelector("#poll-indicator-text");
const currentChannels = parseInitialChannels();
const streamViews = new Map();
const pillViews = new Map();
const players = new Map();
const autoplayMonitors = new Map();
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
let autoplaySyncFrame = null;
let autoplaySyncTimeouts = [];
let probeSequence = 0;

renderInitialView();
bindEvents();
startStatusPolling();

function renderInitialView() {
  renderChannelPills();
  renderStreamTiles();

  emptyState.hidden = currentChannels.length !== 0;
  streamGrid.hidden = currentChannels.length === 0;

  if (currentChannels.length) {
    syncGridLayout();
  }
}

function bindEvents() {
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

  window.addEventListener("resize", syncGridLayout);
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

  currentChannels.forEach((channel) => {
    const tile = document.createElement("article");
    tile.className = "stream-tile";
    tile.dataset.streamChannel = channel;
    tile.dataset.live = "pending";
    tile.dataset.mountPending = "false";

    const header = document.createElement("header");
    header.className = "stream-name";

    const label = document.createElement("span");
    label.className = "stream-name-label";
    label.textContent = channel;

    const audioButton = document.createElement("button");
    audioButton.className = "stream-audio-button";
    audioButton.type = "button";
    audioButton.dataset.audioChannel = channel;
    audioButton.setAttribute("aria-pressed", "false");
    audioButton.disabled = true;
    audioButton.textContent = "Audio";

    header.append(label, audioButton);

    const shell = document.createElement("div");
    shell.className = "player-shell";
    shell.dataset.playerShell = channel;

    tile.append(header, shell);
    fragment.append(tile);

    const view = { tile, shell, audioButton };
    streamViews.set(channel, view);
    renderShellPlaceholder(view, channel, "Checking live status", "pending");
  });

  streamGrid.append(fragment);
}

function parseInitialChannels() {
  const params = new URLSearchParams(window.location.search);
  return parseChannelList(params.get("streams") || "");
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
  const nextUrl = new URL(window.location.pathname, window.location.origin);

  if (channels.length) {
    nextUrl.searchParams.set("streams", channels.join(","));
  }

  window.location.assign(nextUrl.toString());
}

function startStatusPolling() {
  if (!streamViews.size) {
    setPollIndicatorState("idle", "No streams selected");
    return;
  }

  if (!pollTicker) {
    pollTicker = window.setInterval(updatePollIndicator, 1000);
  }

  runPollCycle();
}

async function runPollCycle() {
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

async function pollStreamStatuses() {
  const channels = [...streamViews.keys()];
  if (!channels.length) {
    return;
  }

  const results = await Promise.all(
    channels.map(async (channel) => ({
      channel,
      state: await probeStreamPreview(channel),
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
    activeAudioChannel = null;
  }

  syncPlayerAudio();
  syncAudioButtons();
  syncGridLayout();
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
  if (!view || !view.shell || !view.audioButton) {
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
  renderShellPlaceholder(view, channel, "Checking live status", "pending");
  setChannelStatus(channel, "pending");
}

function renderLiveStream(channel) {
  const view = streamViews.get(channel);
  if (!view || !view.shell || !view.audioButton) {
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
        queuePlayerAutoplay(channel, player);
        requestPlayerPlayback(channel, player);
      }, 120);
    });
  }

  queuePlayerAutoplay(channel, player);
}

function renderOfflineStream(channel) {
  const view = streamViews.get(channel);
  if (!view || !view.shell || !view.audioButton) {
    return;
  }

  view.tile.hidden = true;
  view.tile.dataset.live = "false";
  view.tile.dataset.mountPending = "false";
  view.audioButton.disabled = true;

  if (activeAudioChannel === channel) {
    activeAudioChannel = null;
  }

  teardownPlayer(channel);
  renderShellPlaceholder(view, channel, "Offline", "offline");
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
  syncPlayerAudio();
  syncAudioButtons();
}

function syncPlayerAudio() {
  players.forEach((player, channel) => {
    requestPlayerPlayback(channel, player);
  });
}

function applyPlayerAudioState(channel, player) {
  const isActive = channel === activeAudioChannel;

  if (typeof player.setMuted === "function") {
    player.setMuted(!isActive);
  }

  if (typeof player.setVolume === "function") {
    player.setVolume(isActive ? 0.5 : 0);
  }
}

function requestPlayerPlayback(channel, player) {
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

    const availableQualities = Array.isArray(player.getQualities())
      ? player.getQualities().filter((quality) => typeof quality === "string" && quality.length > 0)
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
    const isActive = channel === activeAudioChannel;
    view.audioButton.classList.toggle("active", isActive);
    view.audioButton.setAttribute("aria-pressed", isActive ? "true" : "false");
    view.audioButton.textContent = isActive ? "On" : "Audio";
  });
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

  if (!streamViews.size) {
    setPollIndicatorState("idle", "No streams selected");
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

  const visibleViews = [...streamViews.values()].filter((view) => !view.tile.hidden);
  const visibleCount = visibleViews.length;
  streamGrid.hidden = visibleCount === 0;

  if (!visibleCount) {
    streamGrid.classList.remove("stream-grid-dynamic");
    streamGrid.style.removeProperty("--dynamic-tile-width");
    streamGrid.style.removeProperty("--dynamic-tile-height");
    streamGrid.style.removeProperty("--grid-height");
    return;
  }

  const gap = parseFloat(window.getComputedStyle(streamGrid).columnGap || "0") || 0;
  const shellStyles = appShell ? window.getComputedStyle(appShell) : null;
  const shellRightPadding = shellStyles ? parseFloat(shellStyles.paddingRight || "0") || 0 : 0;
  const shellBottomPadding = shellStyles ? parseFloat(shellStyles.paddingBottom || "0") || 0 : 0;
  const gridRect = streamGrid.getBoundingClientRect();
  const gridWidth = Math.max((streamGrid.clientWidth || gridRect.width) - shellRightPadding, 0);
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
  streamGrid.style.setProperty("--grid-height", `${rows * tileHeight + gap * Math.max(rows - 1, 0)}px`);
  window.requestAnimationFrame(() => {
    mountPendingPlayers();
    scheduleAutoplaySync();
  });
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
    if (!view || view.tile.hidden || !hasPlayableArea(view.shell)) {
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
    if (!view || view.tile.hidden || !hasPlayableArea(view.shell)) {
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

function parseChannels(value) {
  const trimmedValue = value.trim();
  let source = trimmedValue;

  if (/^https?:\/\//i.test(trimmedValue)) {
    try {
      const url = new URL(trimmedValue);
      source = url.searchParams.get("streams") || "";
    } catch (error) {
      source = "";
    }
  }

  return parseChannelList(source);
}

function sanitizeChannel(value) {
  return value.trim().toLowerCase().replace(/[^a-z0-9_]/g, "");
}
