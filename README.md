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

You can also add channels from the `+` button by typing names separated with spaces or commas, or by pasting a full `?streams=...` URL.

Add a Pluto TV live channel as the final tile with the `pluto` query parameter:

```text
https://<your-pages-host>/?streams=channel_one,channel_two&pluto=29262
```

The Pluto value is the stream id from a Pluto TV live URL:

```text
https://pluto.tv/us/watch/live-tv/29262/
```

Raw stream ids are the canonical URL format. Encoded Pluto live URLs from `pluto.tv` or `www.pluto.tv`, with either `/us/watch/live-tv/<id>/` or `/us/live-tv/<id>/`, are also accepted and normalized back to the stream id when Streamplex rebuilds the page URL.

For playback, the new numeric ID `29262` is mapped to Naruto's legacy ID `5da0c85bd2c9c10009370984`. Other channels can use their legacy 24-character hexadecimal IDs. Pluto's numeric-ID resolver does not allow cross-origin browser requests; additional verified numeric aliases can be added to `CHANNEL_ALIASES` in `static/pluto.js`. An unmapped numeric ID shows an explicit error, never Pluto's default channel. The tile's `Open` link still works for any valid numeric ID.

If `pluto` is omitted or the stream id is invalid, the Pluto tile is hidden. Playback starts muted to satisfy browser autoplay rules; use the video's native controls to unmute, pause, or go fullscreen. Pluto audio is independent of the Twitch audio buttons. If autoplay needs a user gesture, press the video's play button.

The September 2026 Pluto website stalls on “Optimizing your video playback experience” inside a cross-site iframe. Testing isolated the failure to first-party session-cookie availability. Streamplex therefore uses a fresh anonymous session from Pluto's web playback service and plays its ad-supported HLS stream directly, without embedding the webpage, changing cookie settings, using a proxy, or persisting session tokens. The pinned, integrity-checked hls.js 1.7.2 player loads from jsDelivr only when a Pluto tile is present, with native HLS as a fallback for browsers without compatible Media Source support.

The video uses `object-fit: contain`, so the entire picture is centered at the maximum size that fits each tile. Black bars fill any unused space. Window resizing, tile resizing, and changes to the video's own aspect ratio need no crop calibration or playback restart.

Startup and stalled playback have timeouts, bounded reconnection attempts, and a manual retry button. These Pluto web-client endpoints are not a guaranteed public embed API: service changes, regional availability, or blockers can still prevent playback. The `Open` link provides a direct-site fallback. No geo-restrictions, DRM, or ad segments are bypassed.

## Local Preview

Twitch embeds should be served over HTTP, not opened directly from `file://`.

```bash
python -m http.server 8000
```

Then open:

```text
http://127.0.0.1:8000/?streams=channel_one,channel_two,channel_three
```

Run the offline Pluto URL/session regression checks with Node.js:

```bash
node --test tests/pluto.test.cjs
```

To verify actual playback, start a **disposable** Chrome profile with remote debugging on port 9222 and keep the local server above running. Then use Node 22 or newer:

```bash
node tests/pluto.browser.mjs
```

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

- First try a browser `fetch()` probe and use real `403` / `404` responses when the browser exposes them
- Fall back to image loading if fetch status is unavailable
- Treat known placeholder or forbidden preview URLs as offline
- Keep the last known state if the probe times out or the result stays ambiguous

Because this runs entirely in the browser, it is less authoritative than the earlier server-side probe, but it is compatible with GitHub Pages.

When a valid `pluto` value is present, the Pluto TV tile is treated as always visible because Pluto TV does not provide the same client-side preview probe used for Twitch streams.
