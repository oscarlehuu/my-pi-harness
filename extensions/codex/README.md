# codex

pi extension with two tools:

- `codex-image-generate` — generate an image from a prompt.
- `codex-image-edit` — edit one or more local PNG/JPEG/WebP images with a prompt.

Both tools use ChatGPT/Codex subscription OAuth credentials and call the Codex `image_generation` backend directly. They do **not** use pay-as-you-go API keys.

## Auth

Credentials are read from:

1. `~/.pi/agent/auth.json`, key `openai-codex`
2. newest `~/.cli-proxy-api/codex-*.json` fallback

Override the primary auth file with `CODEX_AUTH_PATH`. If auth is missing or expired and refresh fails, run `codex login` again.

## Output

Images are returned inline to pi and saved to disk. Defaults:

- output dir: `./generated-images/`
- filename: `img-<timestamp>-<random>.<format>`

Environment overrides:

- `CODEX_IMAGE_OUTPUT_DIR`
- `CODEX_IMAGE_BASE_MODEL` (default `gpt-5.4-mini`)
- `CODEX_IMAGE_USER_AGENT` (default `codex_cli_rs/0.0.0`)
- `CODEX_IMAGE_DEADLINE_MS` (default `180000`)

Callers may also pass `output_path`.

## Install

This repo's `install.sh` symlinks every extension folder with an `index.ts` or `package.json` into `~/.pi/agent/extensions/`, so `codex/` is installed automatically:

```bash
./install.sh
```

## Test

```bash
bash extensions/codex/test/image_test.sh
```

The live test skips with exit 0 when no Codex auth is present. When authorised, it generates a PNG, checks PNG magic bytes + saved file, then edits that PNG and checks the edited output.
