# Grok — search + Imagine image/video tools for pi

Pi tools that replicate Grok CLI features against the same subscription-backed
backend the CLI uses:

| Tool | What it does |
|------|--------------|
| `grok-web-search` | Web search with synthesized answer + real source URLs (citations). |
| `grok-x-search` | X (Twitter) search with synthesized answer + real `x.com` post URLs. |
| `grok-image-gen` | Generate one or more images, save them to disk, and return inline images. |
| `grok-image-edit` | Edit 1–3 images from local paths/data URIs/URLs, save outputs, and return inline images. |
| `grok-video-gen` | Generate text→video or image→video, poll progress, download the mp4, and return its path/source URL. |

All subscription-backed tools work whenever **Grok is authorised** — i.e. you've
run `grok login` — with no pay-as-you-go API credits required. Auth is reused
from `~/.grok/auth.json`.

## Reverse-engineered transports

### Search (`grok-web-search`, `grok-x-search`)

The grok CLI's `web_search` / `x_search` tools forward the turn to xAI's
subscription-backed proxy:

```http
POST https://cli-chat-proxy.grok.com/v1/responses
Authorization: Bearer <auth.json key>
X-XAI-Token-Auth: xai-grok-cli
x-grok-client-version: <grok version>
x-grok-model-override: grok-4.20-multi-agent
Content-Type: application/json

{
  "model": "grok-4.20-multi-agent",
  "input": "...",
  "stream": true,
  "tools": [ { "type": "web_search" } | { "type": "x_search" } ]
}
```

Search streams SSE events; the client folds `response.output_text.delta` into an
answer and collects `url_citation` annotations as sources.

### Imagine image generation (`grok-image-gen`)

```http
POST https://cli-chat-proxy.grok.com/v1/images/generations
Authorization: Bearer <auth.json key>
X-XAI-Token-Auth: xai-grok-cli
x-grok-client-version: <grok version>
Content-Type: application/json

{
  "model": "grok-imagine-image-quality",
  "prompt": "...",
  "n": 1,
  "response_format": "b64_json",
  "aspect_ratio": "16:9",
  "resolution": "1k"
}
```

Returns `data[].b64_json` plus `mime_type` (usually `image/jpeg`).

### Imagine image editing (`grok-image-edit`)

```http
POST https://cli-chat-proxy.grok.com/v1/images/edits

{
  "model": "grok-imagine-image-quality",
  "prompt": "...",
  "image_url": "data:image/png;base64,...", // or http(s), or an array of up to 3
  "n": 1,
  "response_format": "b64_json",
  "aspect_ratio": "1:1"
}
```

Local input image paths are read and converted to `data:image/...;base64,...`.
Data URIs and `http(s)` URLs pass through unchanged.

### Imagine video (`grok-video-gen`)

```http
POST https://cli-chat-proxy.grok.com/v1/videos/generations

{
  "model": "grok-imagine-video",
  "prompt": "...",
  "duration": 5,
  "aspect_ratio": "16:9",
  "resolution": "480p",
  "image": { "url": "data:image/jpeg;base64,..." } // optional image→video
}
```

The create call returns `{ "request_id": "..." }`. The client polls:

```http
GET https://cli-chat-proxy.grok.com/v1/videos/{request_id}
```

until `status` is `done`, then downloads `video.url` (mp4) to disk. `failed` or
`expired` statuses are surfaced as errors.

> Important: Search adds `x-grok-model-override: grok-4.20-multi-agent` via the
> shared auth helper's extra headers. Imagine image/video requests intentionally
> **do not** send that header.

## Shared auth

Transport/auth helpers live in [`_shared/grokAuth.ts`](./_shared/grokAuth.ts):

- `resolveGrokAuth()` loads `~/.grok/auth.json` subscription auth first.
- `buildAuthHeaders(auth, extraHeaders?)` sets `Content-Type`, `Authorization`,
  `x-grok-client-version`, `user-agent`, and `X-XAI-Token-Auth` in subscription
  mode.
- [`_shared/grokClient.ts`](./_shared/grokClient.ts) keeps the existing search
  public API and re-exports `GrokAuthError`.
- [`_shared/imagineClient.ts`](./_shared/imagineClient.ts) implements image gen,
  image edit, video create/poll/download, local-image data URI conversion,
  transient 429/5xx retry, and asset saving.

Search retains its historical API-key fallback for the public `api.x.ai` path;
Imagine is subscription-proxy first and requires a valid `grok login` session.

## Tool parameters

**`grok-web-search`**
- `query` (required)
- `allowed_domains?`
- `excluded_domains?`

**`grok-x-search`**
- `query` (required)
- `allowed_x_handles?` / `excluded_x_handles?`
- `from_date?` / `to_date?` (`YYYY-MM-DD`)

**`grok-image-gen`**
- `prompt` (required)
- `aspect_ratio?` — e.g. `"16:9"`, `"1:1"`, `"9:16"`
- `resolution?` — `"1k"` or `"2k"`
- `n?` — 1–10
- `output?` — optional filename; basename only is used and sanitized

**`grok-image-edit`**
- `prompt` (required)
- `image` (required) — a string or array of up to 3 local paths/data URIs/URLs
- `aspect_ratio?`
- `n?` — 1–10
- `output?` — optional filename; basename only is used and sanitized

**`grok-video-gen`**
- `prompt` (required)
- `image?` — optional local path/data URI/URL for image→video; omit for text→video
- `duration?` — 1–15 seconds
- `aspect_ratio?`
- `resolution?` — `"480p"` or `"720p"`
- `output?` — optional mp4 filename; basename only is used and sanitized

## Output files

Generated assets are saved under:

```text
~/.pi/.generated
```

Override with `PI_IMAGINE_OUTPUT_DIR`. Default names are:

```text
grok-image-<ts>-<rand>.<jpg|png|webp|gif>
grok-video-<ts>-<rand>.mp4
```

If `output` is supplied, only the basename is used and unsafe characters are
replaced. For multi-image outputs, `-1`, `-2`, ... are appended.

## Environment overrides

| Var | Purpose |
|-----|---------|
| `GROK_SEARCH_AUTH` | `subscription` \| `api-key` \| `auto` (search auth preference; default auto) |
| `GROK_API_KEY` / `XAI_API_KEY` | API key fallback for search's pay-as-you-go path |
| `GROK_AUTH_PATH` | Override `~/.grok/auth.json` location |
| `GROK_CLIENT_VERSION` | Override the `x-grok-client-version` header |
| `GROK_CLI_CHAT_PROXY_BASE_URL` | Override the subscription proxy base URL |
| `XAI_API_BASE_URL` | Override the public API base URL used by search fallback |
| `GROK_SEARCH_MAX_ATTEMPTS` / `GROK_SEARCH_BACKOFF_MS` | Search retry tuning |
| `GROK_SEARCH_DEADLINE_MS` | Hard wall-clock cap for a whole search (default 90000; 0 disables) |
| `PI_IMAGINE_OUTPUT_DIR` | Directory for generated images/videos (default `~/.pi/.generated`) |
| `PI_IMAGINE_MAX_ATTEMPTS` / `PI_IMAGINE_BACKOFF_MS` | Imagine 429/5xx retry tuning (default 4 attempts, 1500ms base) |
| `PI_IMAGINE_VIDEO_DEADLINE_MS` | Video polling deadline (default 300000ms) |
| `PI_IMAGINE_VIDEO_POLL_MS` | Video polling interval (default 5000ms) |

## Packaging

This domain registers five tools through the package manifest:

```text
grok/
  package.json              # pi.extensions lists all five index.ts entries
  _shared/grokAuth.ts       # shared CLI auth envelope
  _shared/grokClient.ts     # search client (public API preserved)
  _shared/imagineClient.ts  # image/video client + saving/downloading helpers
  websearch/index.ts        # grok-web-search
  xsearch/index.ts          # grok-x-search
  imagegen/index.ts         # grok-image-gen
  imageedit/index.ts        # grok-image-edit
  videogen/index.ts         # grok-video-gen
  test/
```

## Tests

```bash
bash extensions/grok/test/imagine_test.sh  # live image + video smoke; skips if unauthorised
bash extensions/grok/test/search_test.sh   # live web + X search; skips if unauthorised
```

Both tests load TypeScript through `jiti`, the same no-build loader pi uses.
