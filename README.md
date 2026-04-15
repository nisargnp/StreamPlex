# Streamplex

Streamplex is a static Twitch multiview page built for GitHub Pages. The URL query string is the only source of truth for selected streams.

Only these files are required for deployment:

- `index.html`
- `static/`
- `.nojekyll`

## Use

Open streams directly with the `streams` query parameter:

```text
https://<your-pages-host>/?streams=channel_one,channel_two,channel_three
```

You can also add channels from the `+` button by typing names separated with spaces or commas, or by pasting a full `?streams=...` URL.

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

Live detection is now best-effort and fully client-side. The page probes Twitch preview images in the browser:

```text
https://static-cdn.jtvnw.net/previews-ttv/live_user_<channel>-440x248.jpg
```

Behavior:

- First try a browser `fetch()` probe and use real `403` / `404` responses when the browser exposes them
- Fall back to image loading if fetch status is unavailable
- Treat known placeholder or forbidden preview URLs as offline
- Keep the last known state if the probe times out or the result stays ambiguous

Because this runs entirely in the browser, it is less authoritative than the earlier server-side probe, but it is compatible with GitHub Pages.
