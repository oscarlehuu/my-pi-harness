# Antigravity image tools for pi

This domain adds two pi tools that use Antigravity CLI's reverse-engineered image backend through the user's local `cli-proxy-api`.

## Backend

Antigravity CLI (`agy` v1.0.3) exposes an internal `generate_image` tool through the Cloud Code-backed Antigravity transport with:

- `Prompt` — text prompt or edit instruction
- `ImagePaths` — optional reference images for image-to-image edits

The `agy` planner UI may show **Gemini 3.5 Flash**, but that is only the planner deciding to call the tool. The actual image model is Gemini flash-image via Cloud Code; Antigravity's newest/default image model is:

```text
gemini-3.1-flash-image
```

These pi tools do not shell out to `agy`. They call the already-running local `cli-proxy-api` OpenAI-compatible endpoint, which holds and refreshes the Antigravity Google OAuth credentials:

```text
POST http://localhost:8317/v1/chat/completions
```

Generated image bytes arrive as data URIs in `choices[0].message.images[].image_url.url`.

## Tools

### `antigravity-image-gen`

Generate one or more images.

Parameters:

- `prompt` (required) — image prompt
- `n` (optional, `1`-`10`, default `1`) — number of images; if the proxy returns one image per call the client loops to honor `n`
- `model` (optional, default `gemini-3.1-flash-image` — Antigravity's Gemini flash-image model)
- `reasoning_effort` (optional, `low` | `medium` | `high`, default `low`)
- `output` (optional) — output filename basename; sanitized before saving

### `antigravity-image-edit`

Edit one or more reference images.

Parameters:

- `prompt` (required) — edit instruction
- `image` (required) — a path, data URI, URL, or array of up to 3 paths/data URIs/URLs
- `model` (optional, default `gemini-3.1-flash-image` — Antigravity's Gemini flash-image model)
- `reasoning_effort` (optional, `low` | `medium` | `high`, default `low`)
- `output` (optional) — output filename basename; sanitized before saving

Local reference images are encoded as `data:image/...;base64,...`; existing `data:` URIs and `http(s)` URLs pass through unchanged.

## Auth and configuration

Base URL precedence:

1. `ANTIGRAVITY_BASE_URL`
2. `PI_CLIPROXY_BASE_URL`
3. `http://localhost:8317/v1`

API key precedence:

1. `ANTIGRAVITY_API_KEY`
2. `CLIPROXY_API_KEY`
3. first entry under `api-keys:` in `~/cliproxyapi/config.yaml`
4. `providers.cliproxy.apiKey` in `~/.pi/agent/models.json`

If no key can be found, the tools report:

```text
cli-proxy-api key not found: set ANTIGRAVITY_API_KEY or run cli-proxy-api on :8317
```

## Output

Images are saved to the same directory used by the Grok Imagine tools:

- default: `~/.pi/.generated`
- override: `PI_IMAGINE_OUTPUT_DIR`

Default filenames look like:

```text
antigravity-image-<timestamp>-<rand>.<ext>
```

The extension also returns each image inline to pi as `ImageContent`.

## Test

```bash
bash extensions/antigravity/test/image_test.sh
```

The test imports the TypeScript client and tool modules through `jiti` (no build step), then runs one tiny live generation against `localhost:8317`. It exits `0` when the proxy/key is unavailable so normal development machines can skip cleanly.
