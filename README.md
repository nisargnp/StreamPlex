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
https://<your-pages-host>/?streams=channel_one,channel_two&pluto=5da0c85bd2c9c10009370984
```

The Pluto value is the stream id from a Pluto TV live URL:

```text
https://pluto.tv/us/live-tv/<stream_id>
```

Raw stream ids are the canonical URL format. Encoded Pluto live URLs from `pluto.tv` or `www.pluto.tv` are also accepted and normalized back to the stream id when Streamplex rebuilds the page URL.

If `pluto` is omitted or the stream id is invalid, the Pluto tile is hidden. Pluto playback is embedded in an iframe, so its audio and playback controls are managed inside Pluto's player rather than through Streamplex's Twitch audio button.

Pluto TV is rendered as a cross-origin page iframe. Streamplex cannot inspect Pluto's internal player, so it visually crops a calibrated region of the iframe inside the stream box. If Pluto changes its page layout, the crop constants in `static/app.js` may need retuning.

## Local Preview

Twitch embeds should be served over HTTP, not opened directly from `file://`.

```bash
python -m http.server 8000
```

Then open:

```text
http://127.0.0.1:8000/?streams=channel_one,channel_two,channel_three
```

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
