# Streamplex

Streamplex is a static Twitch multiview page built for GitHub Pages. The URL query string is the source of truth for selected Twitch streams and an optional final Pluto TV tile.

Only these files are required for deployment:

- `index.html`
- `static/`
- `.nojekyll`

## Use

Open Twitch streams directly with the `streams` query parameter:

```text
https://<your-pages-host>/?streams=channel_one,channel_two,channel_three
```

You can also add channels from the `+` button by typing names separated with spaces or commas, pasting a Twitch channel URL, or pasting a full `?streams=...&pluto=...` URL. A Pluto channel URL in the prompt adds/replaces the Pluto tile. Each selected provider has a removable pill.

Adding/removing channels and browser Back/Forward update the URL in place. Unchanged players are retained; they do not restart. Twitch dependencies load on demand with an explicit retry if loading fails. Assets use a release version rather than a new timestamp on every visit. Bump the versions in `index.html` and `APP_VERSION` in `static/app.js` when deploying asset changes.

Twitch starts muted with autoplay enabled and a 480p preference (accepting both old and current SDK quality formats); if unavailable it selects a lower resolution, or the smallest higher resolution. After initialization, manual quality choices and pauses are preserved. Resizing never sends playback or audio commands. All visible stream tiles fit together in the current viewport without page scrolling, including mixed Twitch/Pluto layouts. Players fill their entire tiles without per-stream headers or floating badges. Channel names and Pluto's Open link live in the shared top bar. Failure and blocked-playback notices identify the affected channel; Pluto shows its resolved channel name or the requested ID before resolution. Tiles and gutters shrink as needed.

Small Twitch tiles retain an internal iframe viewport of at least 400 × 300 and use CSS `zoom` to fit the whole player into the available video area, including its controls. A `ResizeObserver` keeps this synchronized with independent tile resizing, without recreating the iframe. Ordinary `transform: scale()` did not pass Twitch's visibility check in testing; repeatedly calling `play()` on an undersized player did not fix startup either. This behavior is verified in desktop Chrome; mobile/browser policies can still require a click, and small controls can be difficult to use. The Play fallback remains available when the browser reports blocked playback.

Add a Pluto TV live channel as the final tile with the `pluto` query parameter:

```text
https://<your-pages-host>/?streams=channel_one,channel_two&pluto=29262
```

The Pluto value is the stream id from a Pluto TV live URL:

```text
https://pluto.tv/us/watch/live-tv/29262/
```

Raw stream ids are the canonical URL format. Encoded Pluto live URLs from `pluto.tv` or `www.pluto.tv`, with either `/us/watch/live-tv/<id>/` or `/us/live-tv/<id>/`, are also accepted and normalized back to the stream id when Streamplex rebuilds the page URL.

For playback, the new numeric ID `29262` is mapped to Naruto's legacy ID `5da0c85bd2c9c10009370984`. Other channels can use their legacy 24-character hexadecimal IDs. Pluto's numeric-ID resolver does not allow cross-origin browser requests; additional verified numeric aliases can be added to `CHANNEL_ALIASES` in `static/pluto.js`. An unmapped numeric ID shows an explicit error, never Pluto's default channel. The shared top bar's `Open` link still works for any valid numeric ID.

If `pluto` is omitted or the stream id is invalid, the Pluto tile is hidden. Both providers start muted on every browser page load or reload. Use each player's native mute and volume controls to enable the streams you want to hear; audio is independent across streams, with no custom audio buttons or automatic muting of other players. Scheduled polling and the top bar's Refresh button preserve current mute and volume settings. Playback recovery also retains those settings in memory for the current page, while a full reload clears them and starts muted again. Native controls also provide pause/fullscreen. If autoplay needs a user gesture, press Play.

The September 2026 Pluto website stalls on “Optimizing your video playback experience” inside a cross-site iframe. Testing isolated the failure to first-party session-cookie availability. Streamplex therefore uses a fresh anonymous session from Pluto's web playback service and plays its ad-supported HLS stream directly, without embedding the webpage, changing cookie settings, using a proxy, or persisting session tokens. Safari uses native HLS without depending on jsDelivr; other compatible browsers use the pinned, integrity-checked hls.js 1.7.2 player. Chrome's unreliable native-HLS capability claim is not used as the preferred path.

The video uses `object-fit: contain`, so the entire picture is centered at the maximum size that fits each tile. Black bars fill any unused space. Window resizing, tile resizing, and changes to the video's own aspect ratio need no crop calibration or playback restart.

Startup and stalled playback have timeouts, bounded reconnection attempts, and a manual retry button. These Pluto web-client endpoints are not a guaranteed public embed API: service changes, regional availability, or blockers can still prevent playback. The `Open` link provides a direct-site fallback. No geo-restrictions, DRM, or ad segments are bypassed.

HLS.js retains only 30 seconds of played video (plus segment boundaries). Pluto sessions renew at 90% of the service's refresh interval, with a four-hour fallback if the interval is missing. Renewal briefly reconnects at the live edge and preserves a manual pause and audio settings. Returning from sleep/hidden-tab throttling checks for overdue renewal. All timers and SDK listeners are cleaned up when a player is removed.

## Local Preview

Twitch embeds should be served over HTTP, not opened directly from `file://`.

```bash
python -m http.server 8000
```

Then open:

```text
http://127.0.0.1:8000/?streams=channel_one,channel_two,channel_three
```

Run the offline Twitch/Pluto regression checks with Node.js:

```bash
node --test tests/*.test.cjs
```

To verify actual playback, start a **disposable** Chrome profile with remote debugging on port 9222 and keep the local server above running. Then use Node 22 or newer:

```bash
node tests/pluto.browser.mjs
node tests/app.browser.mjs
```

For real Twitch autoplay verification, choose channels that are currently live:

```bash
TWITCH_CHANNELS=shroud,lirik,xqc node tests/twitch.browser.mjs
```

This checks a fresh small-viewport load without clicking Play, advancing decoded video frames inside the real Twitch iframes, resizing without scrolling/recreation, and manual pause preservation. Offline channels or upstream restrictions will fail this opt-in check.

`app.browser.mjs` uses deterministic fake SDKs with the real DOM to check mixed-provider audio, viewport containment without scrolling across stream counts and window sizes, pause/quality preservation, history, add/remove identity, SDK-load failure, and repeated listener cleanup. `pluto.browser.mjs` uses real Pluto playback. For an extended live buffer/heap observation run:

```bash
SOAK_SECONDS=3600 node tests/pluto.browser.mjs
```

Session renewal and Safari-native selection are covered with simulated responses in the offline tests. Actual Safari/iOS behavior and multi-hour playback still need device-specific verification; Chrome emulation is not a substitute for those browsers.

This opt-in test uses a fresh isolated browser context, checks advancing decoded video frames through desktop/portrait/fractional tile resizes, checks unmapped IDs, and blocks/unblocks the playback service to verify retry. It requires network access and Pluto availability in your region. `CDP_URL` and `STREAMPLEX_URL` override the defaults (`http://127.0.0.1:9222` and `http://127.0.0.1:8000/`). It does not modify browser cookie or security settings.

## GitHub Pages

1. Push this repo to GitHub.
2. Enable GitHub Pages from the repository settings.
3. Publish from the repository root.

No build step, backend, or framework-specific configuration is required. `.nojekyll` is already included.

## Live Status

Live detection is best-effort and fully client-side for Twitch streams. The page probes Twitch preview images in the browser:

```text
https://static-cdn.jtvnw.net/previews-ttv/live_user_<channel>-440x248.jpg
```

Behavior:

- Initial unmounted channels use a browser `fetch()` probe; a readable 404 or recognized placeholder can indicate offline.
- A 403, network failure, or unavailable cross-origin response means **unknown**, never offline. A successfully loaded image alone is not evidence of a live stream.
- Unknown channels can mount the official Twitch player to determine status. Once mounted, ONLINE/OFFLINE events take precedence over thumbnail guesses; thumbnail failures cannot hide that player.
- Selected offline SDK players are retained to receive ONLINE promptly, and are destroyed when removed. No repeated SDK construction is needed for offline/online transitions.
- If Twitch playback fails, Streamplex checks the preview immediately. A confirmed offline result hides the tile; a live or unknown result retries the official player once. Later status polls retry unresolved failures. Persistent failures keep the manual Retry playback and Open on Twitch options visible.
- Results are applied individually, so a slow thumbnail does not delay the others. URL changes invalidate and abort stale checks. Incomplete checks show a retry state; Refresh runs a new check immediately.

Because this runs entirely in the browser, it is less authoritative than the earlier server-side probe, but it is compatible with GitHub Pages.

When a valid `pluto` value is present, the Pluto TV tile is treated as always visible because Pluto TV does not provide the same client-side preview probe used for Twitch streams.
