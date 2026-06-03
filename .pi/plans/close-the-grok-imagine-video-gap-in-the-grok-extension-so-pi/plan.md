# Plan: Close the Grok Imagine **video** gap in the `grok/` extension so pi matches the official Grok Build CLI's REST video surface. SCOPE (per founder): fix the broken default model + add a reference-to-video tool. Do NOT add an extend tool (native REST extend does not exist). Update README + tests. Keep the subscription-proxy auth pattern (no x-grok-model-override for Imagine).

=== GROUND TRUTH (verified from ~/.grok/downloads/grok-0.2.19-macos-aarch64 binary strings AND live POST /videos/generations probes; do not deviate) ===
- The official CLI exposes THREE REST video tools, all POST https://cli-chat-proxy.grok.com/v1/videos/generations with model literal "grok-imagine-video" (BARE alias — 1.5-preview is NEVER sent by the CLI):
  1. video_gen (text→video): body {model, prompt, duration?, aspect_ratio?, resolution?}. duration 1–15 (API default 8). resolution "480p"|"720p".
  2. image_to_video: adds image:{url}  (an OBJECT {url}, NOT a bare string, NOT an array). duration 6 or 10 (default 6). uses resolution_name "480p"|"720p".
  3. reference_to_video: adds reference_images:[{url},{url},...] (array of {url} OBJECTS, 2–7 entries). REQUIRED prompt. duration 6 or 10 (default 6). aspect_ratio. resolution_name.
- Live probe receipts (authoritative):
  * images:[...] → HTTP 400 "The `images` field is deprecated. Please use `reference_images` instead." → so the wire field is reference_images (NOT images).
  * reference_images as array of bare strings → 422 (invalid type: string). Must be [{url:"..."}].
  * reference_images N=7 → 200; N=8 → 400 "Too many reference images: 8. Maximum allowed is 7." → max 7, min 2.
  * image:"<bare string>" → 422; image:{url:"..."} → 200. Single image MUST be {url} object.
  * model grok-imagine-video-1.5-preview → 400 "Text-to-video is not supported for this model." AND 400 "`reference_images` is not supported for this model." It ONLY supports image_to_video. model grok-imagine-video (bare) → 200 for ALL three modes.
  * The server SILENTLY IGNORES unknown fields (a garbage field xyzzy_not_a_field still returns 200). So do NOT invent extend fields like video:{url} or extend_from_media_id — they are no-ops on REST. (extended_from_media_id / extends_asset_id live only in the gRPC chat proto / VideoChunk, not this REST proxy.)
  * Poll GET /videos/{request_id} response shape: {status, video:{url, duration, respect_moderation}, model, usage, progress}. status terminal values: "done" | "failed" | "expired".

=== FILE-BY-FILE CHANGES ===

1) extensions/grok/_shared/imagineClient.ts
   - FIX the default model (this is a live bug):
       export const GROK_VIDEO_MODEL = process.env.GROK_DEFAULT_VIDEO_MODEL ?? "grok-imagine-video";   // was grok-imagine-video-1.5-preview
   - Add an OPTIONAL per-call model override to GenerateVideoOptions: `model?: string;` and use (opts.model ?? GROK_VIDEO_MODEL) in generateVideo. (Lets advanced callers pin grok-imagine-video-1.5-preview for image-to-video without breaking defaults.) The VideoGenerationResult.model type is currently `typeof GROK_VIDEO_MODEL`; widen it to `string` so an override is representable.
   - generateVideo: keep behavior (text + optional single image). Ensure the single image is sent as image:{ url } (already the case). Thread the optional model through.
   - ADD a new interface + function for reference-to-video:
       export interface GenerateReferenceVideoOptions {
         prompt: string;
         images: string[];                 // 2–7 path/data-URI/URL refs → reference_images:[{url}]
         duration?: number;                // 6 or 10
         aspectRatio?: string;
         resolution?: "480p" | "720p" | string;
         model?: string;
         output?: string;
         cwd?: string;
         signal?: AbortSignal;
         onProgress?: (progress: ImagineProgress) => void;
       }
       export async function generateReferenceVideo(opts: GenerateReferenceVideoOptions): Promise<VideoGenerationResult>
     Implementation: trim/validate prompt (required). Validate images: array, length >= 2 (throw "reference_to_video requires at least 2 reference images") and <= 7 (throw "reference_to_video accepts at most 7 reference images"). Resolve each ref via resolveImageRef(ref, opts.cwd) and build reference_images: resolved.map(url => ({ url })). Body = { model: opts.model ?? GROK_VIDEO_MODEL, prompt, reference_images, ...(duration!==undefined?{duration: normalizeDuration(duration)}:{}) , ...(aspectRatio?{aspect_ratio}:{}), ...(resolution?{resolution}:{}) }. Then reuse the SAME create→pollVideo→download flow as generateVideo (factor a small private helper like createPollDownload(auth, body, output, signal, onProgress) to avoid duplication, OR call the existing path). Return VideoGenerationResult; OPTIONALLY add `referenceCount?: number` to VideoGenerationResult and set it.
   - Note: keep duration validation lenient via existing normalizeDuration (1–15); the server enforces 6/10 per mode. Do not hard-fail on 6/10.

2) NEW dir extensions/grok/videoreference/index.ts  — registers tool `grok-video-reference`.
   - Mirror the style of extensions/grok/imageedit/index.ts and extensions/grok/videogen/index.ts EXACTLY (TypeBox schema, GrokAuthError handling, onUpdate progress, renderCall, renderResult, details object, `as any` returns where the existing files use them).
   - Params (TypeBox):
       prompt: Type.String (required, "Text prompt describing the desired video.")
       images: Type.Array(Type.String(), { minItems: 2, maxItems: 7, description: "Two to seven reference images (paths, data URIs, or http(s) URLs) for style/content consistency." })
       duration: Type.Optional(Type.Number({ minimum: 1, maximum: 15, description: "Duration in seconds (6 or 10 recommended)." }))
       aspect_ratio: Type.Optional(Type.String(...))
       resolution: Type.Optional(Type.Union([Type.Literal("480p"), Type.Literal("720p")]))
       output: Type.Optional(Type.String(...))
   - description (3 sentences) like the others, e.g.: "Generate a video from 2–7 reference images guided by a text prompt with Grok Imagine via the subscription-backed CLI proxy, for strong character/style consistency. Resolves each image, polls progress, downloads the mp4 to disk, and returns its path plus source URL. Requires Grok to be authorised with `grok login`."
   - execute: validate prompt non-empty and images length 2–7 (return isError text messages mirroring the client errors), call generateReferenceVideo({...params, aspectRatio: params.aspect_ratio, cwd: ctx.cwd, signal, onProgress}). Build a details object analogous to VideoGenDetails (prompt, path, url, requestId, duration, mode, model, referenceCount). Return { content:[{type:"text", text:`Video saved to ${path}\nSource URL: ${url}`}], details }.
   - renderCall: title "grok-video-reference " + prompt + dim opts [`${images.length} refs`, duration?`${duration}s`:undef, aspect_ratio, resolution].
   - renderResult: success line mirroring videogen's renderResult ("✓ grok-video-reference  mp4 saved · Nrefs · <mode>" then path + source).

3) extensions/grok/package.json
   - Add "videoreference/index.ts" to the pi.extensions array (after "videogen/index.ts").

4) extensions/grok/README.md
   - Tool table: add a row for `grok-video-reference` ("Generate a video from 2–7 reference images + a prompt for strong consistency; polls, downloads the mp4, returns path/source URL.").
   - Imagine video HTTP section: change the example model from "grok-imagine-video" stays (it was already correct in the example) BUT fix the single-image note. ADD a new "Imagine reference→video (`grok-video-reference`)" subsection with the verified body:
       POST /videos/generations
       { "model": "grok-imagine-video", "prompt": "...", "reference_images": [ {"url":"data:image/jpeg;base64,..."}, {"url":"https://..."} ], "duration": 6, "aspect_ratio": "16:9", "resolution": "480p" }
     and note: 2–7 references; the legacy `images` field is rejected (use `reference_images`); each entry is an OBJECT {url}; local paths are converted to data URIs.
   - Add a short "Model note" near the video docs: default model is `grok-imagine-video` (the alias the official CLI sends; supports text/image/reference). `grok-imagine-video-1.5-preview` is image-to-video ONLY (400s on text and reference) and can be pinned per-call via the client `model` option / GROK_DEFAULT_VIDEO_MODEL.
   - Tool parameters section: add a `grok-video-reference` block (prompt required; images 2–7; duration?; aspect_ratio?; resolution? 480p|720p; output?).
   - Env overrides table: update the GROK_DEFAULT_VIDEO_MODEL row default to `grok-imagine-video`.
   - Packaging section: bump "five tools" → "six tools" and add the videoreference/index.ts line to the tree.
   - "Important: ... do not send x-grok-model-override" note stays.

5) extensions/grok/test/imagine_live_test.mjs
   - Import generateReferenceVideo alongside generateVideo from the client.
   - After the existing text→video step, add a reference→video smoke: build/reuse two tiny generated images (or two small data URIs) and call generateReferenceVideo({ prompt:"...", images:[ref1,ref2], duration:6, resolution:"480p", output:"acceptance-reference-video.mp4", onProgress }). Assert the mp4 lands in PI_IMAGINE_OUTPUT_DIR, exists, and isMp4(bytes). Keep the graceful SKIP-on-unauth behavior. Keep it cheap (480p, duration 6, 2 refs).
   - Also import the new videoreference/index.ts tool module in the toolPaths loop so loader/syntax regressions are caught.

=== CONSTRAINTS ===
- Update existing files with precise edits; only NEW file is videoreference/index.ts. Follow harness style: primitives, TypeBox schemas, proper error handling, progress via onUpdate, outputs to ~/.pi/.generated (PI_IMAGINE_OUTPUT_DIR). No new deps. Match the exact return/{as any} patterns already used in videogen/imageedit so the TS loads under jiti with no build.
- Do NOT add an extend tool or any extend/video/asset-UUID fields to request bodies.
- Keep generateVideo backward compatible (existing grok-video-gen tool unchanged in surface except it now defaults to the working model).

## Summary (planner)
Read-only Gate 1 plan to close the Grok Imagine video gap in extensions/grok: fix the broken default video model (grok-imagine-video-1.5-preview -> grok-imagine-video), add a per-call model override, add generateReferenceVideo + a new grok-video-reference tool (2-7 reference_images as {url} objects), and update package manifest, README, and the live test. No extend tool/fields. Keep subscription-proxy auth (no x-grok-model-override for Imagine). foreman.json already exists; existing gates are reflected, not overwritten.

## Steps
1. imagineClient.ts: change GROK_VIDEO_MODEL default to 'grok-imagine-video' (env GROK_DEFAULT_VIDEO_MODEL); widen VideoGenerationResult.model from `typeof GROK_VIDEO_MODEL` to `string`; optionally add referenceCount?: number.
2. imagineClient.ts: add `model?: string` to GenerateVideoOptions and use (opts.model ?? GROK_VIDEO_MODEL) in generateVideo; keep image sent as image:{url}; preserve create->pollVideo->download flow.
3. imagineClient.ts: add GenerateReferenceVideoOptions interface + generateReferenceVideo(): trim/require prompt; validate images array length >=2 ('reference_to_video requires at least 2 reference images') and <=7 ('reference_to_video accepts at most 7 reference images'); resolveImageRef each ref via opts.cwd; build reference_images: resolved.map(url => ({url})); body {model: opts.model ?? GROK_VIDEO_MODEL, prompt, reference_images, optional normalizeDuration(duration)/aspect_ratio/resolution}; reuse same create->poll->download path (factor a private createPollDownload helper to avoid duplication); return VideoGenerationResult (set referenceCount). Keep normalizeDuration lenient (1-15); do not hard-fail on 6/10.
4. NEW extensions/grok/videoreference/index.ts: register tool 'grok-video-reference' mirroring videogen/imageedit exactly (TypeBox schema, GrokAuthError handling, onUpdate progress, renderCall/renderResult, details object, `as any` returns). Params: prompt (required), images Type.Array(Type.String(),{minItems:2,maxItems:7}), duration? (1-15), aspect_ratio?, resolution? Union(480p,720p), output?. execute validates prompt/images then calls generateReferenceVideo({...,aspectRatio:params.aspect_ratio,cwd:ctx.cwd,signal,onProgress}); details {prompt,path,url,requestId,duration,mode,model,referenceCount}; returns {content:[{type:'text',text:`Video saved to ${path}\nSource URL: ${url}`}], details}. renderResult mirrors videogen success line with Nrefs.
5. package.json: append 'videoreference/index.ts' to pi.extensions after 'videogen/index.ts'.
6. README.md: add grok-video-reference table row; add 'Imagine reference->video' HTTP subsection with verified reference_images:[{url},...] body + notes (2-7 refs, legacy `images` rejected, each entry is {url} object, local paths -> data URIs); add Model note (default grok-imagine-video supports text/image/reference; 1.5-preview is image-to-video only, pin per-call via model option/GROK_DEFAULT_VIDEO_MODEL); add grok-video-reference tool-parameters block; fix env table GROK_DEFAULT_VIDEO_MODEL default to grok-imagine-video; bump 'five tools'->'six tools' and add videoreference/index.ts to packaging tree; keep the x-grok-model-override note.
7. test/imagine_live_test.mjs: import generateReferenceVideo alongside generateVideo; add videoreference/index.ts to the toolPaths loop; after the text->video step add a cheap reference->video smoke (two tiny refs, duration 6, resolution 480p, output 'acceptance-reference-video.mp4') asserting mp4 lands in PI_IMAGINE_OUTPUT_DIR / exists / isMp4; keep graceful SKIP-on-unauth.
8. Verify by loading via jiti (no build) and running `bash extensions/grok/test/imagine_test.sh` (SKIPs without grok login); confirm legacy controller-fallback grep checks pass.

## Files likely
- `extensions/grok/_shared/imagineClient.ts`
- `extensions/grok/videoreference/index.ts`
- `extensions/grok/package.json`
- `extensions/grok/README.md`
- `extensions/grok/test/imagine_live_test.mjs`

## Risks
- Live test gates on auth: imagine_test.sh SKIPs (exit 0) unless a valid `grok login` subscription token exists, so reference->video isn't truly exercised in unauthenticated CI; loader/syntax regressions are still caught via the toolPaths import loop.
- Type change: widening VideoGenerationResult.model from `typeof GROK_VIDEO_MODEL` to `string` and adding referenceCount must not break existing consumers (videogen reads result.model/duration only) — verify no other reader narrows on the literal type.
- Wire-shape correctness is critical: reference_images MUST be array of {url} objects (bare strings 422; legacy `images` field 400), min 2 / max 7 (N=8 -> 400). Server silently ignores unknown fields, so do NOT add extend/video/asset-UUID fields.
- Model semantics: grok-imagine-video-1.5-preview 400s on text and reference modes; only the bare grok-imagine-video alias supports all three — default must be the bare alias, override is opt-in only.
- Keep generateVideo backward compatible: grok-video-gen surface unchanged except now defaulting to the working model; duration stays lenient (normalizeDuration 1-15), server enforces 6/10 per mode.
- .pi/foreman.json already exists; its `verify` command runs the FOREMAN test suite (extensions/foreman/...), not the grok imagine test. Plan reflects existing gates and does not overwrite them; task-specific verification (imagine_test.sh + legacy grep checks) is run manually, not wired as a foreman gate.
- jiti no-build constraint: must reuse the exact `as any` return patterns and TypeBox primitives from videogen/imageedit or the .ts will fail to load.

## Requirements
- (none detected)

## Proposed gates
- verify (per-round command) — command: `grep -q "claude-opus-4-8:xhigh" extensions/foreman/crew/planner.md && bash extensions/foreman/test/planner_timeout_test.sh && bash extensions/foreman/test/planner_test.sh && bash extensions/foreman/test/gates_test.sh && bash extensions/foreman/test/reviewer_test.sh && bash extensions/foreman/test/guard_test.sh && bash extensions/foreman/test/fallback_test.sh && bash extensions/foreman/test/ledger_test.sh && bash extensions/foreman/dashboard/test/reader_test.sh`
- review (pre-ship judge) — agent: reviewer
- commit (release action) — action: `commit`

## Proposed manifest
- Existing .pi/foreman.json is present and will be preserved.

## Execution
- Working directory: /Users/a1241968/Desktop/Oscar/my-pi-harness
- Track: backend
- Developer: openai-codex/gpt-5.5:xhigh implements; controller-owned gates remain ground truth.
- Tester: cliproxy/claude-opus-4-8:high judges intent and catches cheats.
- Up to 3 fix rounds, then escalate.
