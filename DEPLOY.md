# Deploying StoryCut

## Important: what Netlify can and cannot do

The `public/` folder in this ZIP is a complete static website and deploys to
Netlify perfectly (drag & drop it, or connect a repo). **However**, StoryCut
is not a static-only app: the Python backend (`backend/`) does the real work
— script/voice analysis, B-roll search, media processing, and FFmpeg video
rendering. **Netlify cannot run Python or FFmpeg**, so a Netlify-only deploy
will show the interface but every backend feature will fail.

To make it fully live you need the backend running somewhere too.

## Option A — Split: frontend on Netlify, backend on a Python host (recommended)

1. Deploy the backend (`backend/` + `requirements.txt`) to a host that runs
   Python **and FFmpeg**: a small VPS (Hetzner, DigitalOcean, Hostinger…),
   Fly.io, or Railway with a Dockerfile. It needs:
   - Python 3.10+, `pip install -r requirements.txt`
   - FFmpeg installed (`ffmpeg` and `ffprobe` on PATH)
   - Start command: `python -m backend.app` (listens on port 8099 by default;
     set the `PORT` env var to match your host)
2. On the backend host, set the environment variable:
   `STORYCUT_CORS=https://YOUR-SITE.netlify.app`
   (your real Netlify URL).
3. In `public/static/js/config.js`, set:
   `window.STORYCUT_API_BASE = "https://YOUR-BACKEND-HOST";`
4. Deploy the `public/` folder to Netlify.

## Option B — Everything on one VPS

1. Copy the whole project to the server, `pip install -r requirements.txt`,
   install FFmpeg.
2. Run `./start.sh` (or set up a systemd service + nginx reverse proxy for
   production, with HTTPS via certbot).
3. Open `http://YOUR-SERVER-IP:8099`.

## Notes

- The backend stores uploads, projects, cache, and settings on local disk in
  `storage/` (created automatically). On hosts with ephemeral disks, use a
  persistent volume or uploads will vanish on redeploy.
- B-roll search needs your free Pexels / Pixabay API keys — enter them in the
  app under Settings → B-Roll Sources once it's live.
- Without API keys the app still fully works with your own uploaded footage.

## Update 2026-09-24 — provider system + audio upload fix (verified locally)

### What was verified with real tests (not just error-message checks)
- **Audio upload pipeline (tests A–J):** MP3, WAV, M4A, OGG, WebM-audio and
  MP4-audio all upload and validate with real ffprobe duration + codec
  detection. Corrupt and empty files are rejected with a clear message and
  deleted server-side. A 3-minute (180s) file uploads fine.
  Voice analysis then produced real timed sentences
  (4 sentences mapped across the detected duration), and the pipeline plan
  stage built segments + subtitles + overlays successfully.
- **Provider search + download:** auto fallback works honestly — Pexels/
  Pixabay/Unsplash report "API key not configured" (no keys supplied), and
  Wikimedia Commons serves real 1080p results with license/attribution
  metadata. A real image download preserved license, creator, retrieval
  date, query, and resolution on the timeline asset.
- **Provider research:** each provider card was reconciled against current
  official docs. Pexels: free 200 req/hour, 20,000/month (documented),
  API guidelines ask for a "Photos provided by Pexels" credit. Openverse:
  official REST API, anonymous access heavily rate-limited (OAuth raises
  limits). Wikimedia Commons: MediaWiki Action API, per-file licenses.
  Coverr: real API but **non-commercial use only + clickable logo credit
  required** — deliberately not wired in. Freepik: usage-based paid API
  whose license forbids stock-library redistribution — not wired in.
  Mixkit: no public API, terms forbid bot downloading — manual only.
  Videvo/Dareful: no public API — manual only.

### Audio upload failure fix (the reported bug)
The `/api/uploads` voice endpoint now **validates the actual audio content**
with ffprobe + a real ffmpeg decode probe (not just the file extension):
MP4/WebM audio containers are accepted, corrupt/empty/non-audio files are
rejected with a useful message, rejected temp files are cleaned up, and
audio codec/sample-rate/channels are returned. The wizard now shows
Uploading… → Processing audio… → Audio ready ✓ (with detected duration),
keeps the script/media/settings on failure, and lets the user retry from
the same drop zone.

### Honest status on a public URL
There is still **no public backend URL**, because no VPS/hosting access or
domain has been provided. The frontend ZIP (Netlify) is static-only and
cannot run the Python/FFmpeg backend — it now says so clearly in the UI
instead of failing with cryptic JSON errors. To go live, deploy the backend
per Option A/B above and set `window.STORYCUT_API_BASE`.

## Phase 1 update — 2026-09-24 (90-point spec, batch 1)
New modules (all real, tested on live server):
- `backend/director.py` + `director_routes.py` — POST /api/director/analyze: rule-based story map (hook/body/CTA, semantic units, entities, mood lexicon, pacing/boring flags), candidate scoring 0-100 with reasons, "why this visual" explanations, High/Med/Low confidence. Labeled rule-based, not AI.
- `backend/editing.py` + `editing_routes.py` — scene locking, 6 source modes, 3 creative modes, 11 style profiles, real QC (missing media via os.path.exists, subtitle overlap, aspect, dead silence, duplicate footage, low confidence) with safe auto-fix, completion report with real counts.
- `backend/audiofx.py` + `audiofx_routes.py` — real FFmpeg audio analysis (clipping via astats, silence, EBU R128 loudness) and enhancement (afftdn denoise + two-pass loudnorm); rhythm hints labeled energy-based.
- `backend/metrics.py` — GET /api/metrics/stages; perf dashboard reads real /api/metrics event log.
- Frontend: `js/director.js` (story map panel), `js/editing.js` (✂️ drawer: locks, modes, profiles, QC+fix, report), `js/studio.js` (🎬 panel: lower-thirds/callouts overlays, Audio FX, debug, perf, autosave versions in localStorage).
Bug fixed: b-roll images exported as 1 frame (Ken Burns loop only applied to user_image). Now any still image gets loop+zoompan. Verified: 8.0s, 240 frames, 1280x720 h264+aac, real Wikimedia image + voice.
E2E verified 2026-09-24: voice analyze -> pipeline plan -> director story map -> QC -> auto-fix -> report -> export download (real MP4).
Honest Phase-2 (needs paid APIs/heavy CV, not faked): motion tracking, face detection for reframe, AI image/video generation, Whisper word-level ASR, semantic embeddings search.
