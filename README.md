# StoryCut — AI B-Roll Finder + Automatic Video Editor

A complete, production-style automatic video editing web application.
You provide the **story** (script) and the **timing** (voice-over); the app
finds/selects visuals, trims and synchronizes them, builds subtitles and text
animations, and hands you a full professional timeline for final review —
then exports a real video file.

## Quick start

```bash
cd ~/workspace/broll-editor
./start.sh
# open http://127.0.0.1:8099
```

`start.sh` creates/uses the local Python venv, installs Flask, and starts the
server. All data (projects, uploads, settings, cache) lives in `storage/`.

## The two automatic engines (one project, one timeline)

1. **Automatic B-Roll Footage Finder** — script + voice-over (+ optional own
   media) → searches Pexels / Pixabay (free API keys, yours) for every scene.
2. **Auto Edit My Footage** — uploads your videos/images, scores each file
   against every scene's visual intent, and extracts the best sub-clip
   (scene-change aware trimming, never destructive).
3. **Use Both** — per-scene source strategy: B-roll only, user only,
   user-first, B-roll-first, or balanced AI selection.

## How the automation works (honest description)

- **Script understanding** — full-script read first: sentences, story map
  (dates, numbers, named entities, keywords, sections). Later references keep
  narrative context.
- **Voice-over analysis** — `ffprobe` duration + `ffmpeg silencedetect`
  speech-energy intervals. Sentences are distributed across *detected speech*
  intervals proportionally to word count, preserving real pauses. This is an
  **energy-based alignment**, not word-level ASR — the UI says so, and word
  timestamps are interpolated. (Install Whisper for true word alignment;
  the pipeline will prefer it if a `whisper` binary/API is configured —
  not bundled.)
- **Visual checkpoints** — narration is inspected roughly every 2–3 words,
  but cuts are made at natural phrase/sentence boundaries targeting
  3.5–12 s shots (documentary pacing, not rapid-fire cuts).
- **Visual intent → queries** — content keywords → concise search queries
  (+ synonym alternates), never full sentences.
- **Two-stage B-roll** — stage 1 searches metadata/thumbnails (cached 24 h);
  stage 2 downloads full quality **only** for the chosen candidate.
- **Ranking** — keyword overlap, resolution, orientation, duration fit,
  uniqueness (repeat footage penalized). Best candidate wins, not the first
  result.
- **Confidence + review queue** — every automatic decision is scored
  high/medium/low; low-confidence scenes land in a Needs Review queue.
- **Progressive** — scenes appear on the timeline as they finish; you don't
  wait for the whole project.

## Editor

- 6 tracks (Main Video, B-Roll/Overlay, Text/Graphics, Subtitles,
  Voice-over, Music/SFX), zoom, snap, thumbnails, real waveform, split /
  trim / move / duplicate / delete / multi-select / lock, undo-redo.
- **Real preview** — canvas compositor playing actual clips with
  cross-dissolves, Ken Burns on images, animated text overlays, styled
  subtitles, voice-over + auto-ducked music, fullscreen, inspect mode.
- Script sync bar (click a sentence to seek), Find-B-roll-from-phrase,
  per-clip Replace B-roll (candidate grid), Regenerate visual for one
  segment (locked segments are never touched).
- Subtitle editor + presets; text overlay editor; transitions; speed,
  opacity, filters (grayscale/sepia/brightness/contrast/saturation),
  9:16 smart-reframe focal point.

## Export

- **Server render (FFmpeg)** — true 720p/1080p/1440p/4K in 16:9 or 9:16,
  hardware encoder auto-detected *and verified* (falls back to libx264),
  xfade dissolves, drawtext overlays, ASS subtitles, sidechain-ducked audio.
- **Fast capture** — records the live preview in-browser (WebM), exactly
  what you see and hear.

## B-roll sources & API keys

Settings → B-Roll Sources. Pexels and Pixabay need free API keys (links in
the app). Keys are stored server-side in `storage/settings/` and only ever
shown masked. Provider priority, enable/disable, Test Connection, and
license/attribution notes per provider. Every B-roll clip keeps provider,
asset ID, source URL, creator, license, retrieval date and the query that
found it; a credits list can be assembled from the timeline.

Mixkit / Coverr / Videvo / Dareful are listed with honest status notes —
no verified public API is fabricated. Manual downloads from them work
through "Auto Edit My Footage".

## Project layout

```
backend/          Flask API (analysis, providers, export, storage)
  providers/      modular adapters: base, pexels, pixabay, registry
frontend/         vanilla JS SPA (no build step)
  js/             api, store, wizard, pipeline, timeline, preview,
                  panels, exporter, app
storage/          uploads, projects, cache, exports, settings, metrics
```

## Limitations (documented, not hidden)

- Voice timing is energy-based alignment; true word-level ASR needs Whisper
  (not bundled — would add a large model download).
- 9:16 reframing uses a focal-point heuristic (adjustable per clip), not
  ML face detection.
- Server export renders the main video track; the overlay track is a
  preview-layer (its clips can be moved to main before export).
- B-roll search requires your free Pexels/Pixabay keys; without them the app
  still fully works with your own footage.
- Long 4K renders are CPU-bound on machines without a working HW encoder.

## Testing

`./start.sh`, then: script+voice only, script+voice+videos, images,
16:9 and 9:16, provider failure (no keys), missing visual (gap slug),
replace/regenerate, locked segments, export. Backend pieces are covered by
the smoke tests in this build's development log.
