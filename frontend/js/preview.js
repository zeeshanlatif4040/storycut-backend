// Real preview compositor: canvas video compositor + Web Audio graph.
// Plays the actual timeline: trimmed clips, crossfades, Ken Burns images,
// text animations, subtitles, voice-over + ducked music. No mockups.
import { transport, onTransport, setTime, togglePlay, updatePlayhead } from "./timeline.js";
import { S, tl, asset } from "./store.js";
import { mediaUrl, fmtTime, esc } from "./api.js";

const canvas = document.getElementById("preview");
const ctx = canvas.getContext("2d");
const videos = new Map();   // assetName -> HTMLVideoElement
let audioCtx = null, masterGain = null, voiceGain = null, musicGain = null;
let voiceEl = null, musicEl = null, duckTimer = null;
let rafId = 0, lastFrameT = -1;

export function initPreview() {
  sizeCanvas();
  onTransport(onTransportEvent);
  document.getElementById("t-play").onclick = () => ensureAudio() && togglePlay();
  document.getElementById("t-back").onclick = () => setTime(transport.time - 5);
  document.getElementById("t-fwd").onclick = () => setTime(transport.time + 5);
  document.getElementById("t-scrub").oninput = (e) =>
    setTime((e.target.value / 1000) * transport.duration);
  document.getElementById("t-mute").onclick = (e) => {
    ensureAudio();
    masterGain.gain.value = masterGain.gain.value > 0 ? 0 : (+document.getElementById("t-vol").value / 100);
    e.target.textContent = masterGain.gain.value > 0 ? "🔊" : "🔇";
  };
  document.getElementById("t-vol").oninput = (e) => {
    ensureAudio(); masterGain.gain.value = e.target.value / 100;
  };
  document.getElementById("t-full").onclick = () => {
    const w = document.getElementById("preview-wrap");
    document.fullscreenElement ? document.exitFullscreen() : w.requestFullscreen?.();
  };
  document.getElementById("inspect-mode").onchange = updateInspect;
  window.addEventListener("project-opened", resetMedia);
  window.addEventListener("timeline-progress", () => { renderFrame(transport.time); });
}

function sizeCanvas() {
  const fmt = S.project?.format || "16:9";
  if (fmt === "9:16") { canvas.width = 540; canvas.height = 960; }
  else if (fmt === "1:1") { canvas.width = 640; canvas.height = 640; }
  else { canvas.width = 960; canvas.height = 540; }
  canvas.style.aspectRatio = fmt === "9:16" ? "9/16" : fmt === "1:1" ? "1/1" : "16/9";
}

function resetMedia() {
  sizeCanvas();
  for (const v of videos.values()) { v.pause(); v.removeAttribute("src"); v.load(); }
  videos.clear();
  teardownAudio();
  lastFrameT = -1;
  const txt = document.getElementById("scriptbar-text");
  if (txt) { txt.dataset.built = ""; txt.innerHTML = ""; }
  renderFrame(0);
  updateScriptBar();
}

// ---------------- video pool ----------------
function videoFor(name) {
  let v = videos.get(name);
  if (!v) {
    v = document.createElement("video");
    v.muted = true; v.playsInline = true; v.preload = "auto";
    v.crossOrigin = "anonymous";
    v.src = mediaUrl(name);
    videos.set(name, v);
  }
  return v;
}

// ---------------- audio graph ----------------
function ensureAudio() {
  if (!S.project) return false;
  if (!audioCtx) {
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    masterGain = audioCtx.createGain();
    masterGain.gain.value = (+document.getElementById("t-vol").value || 90) / 100;
    masterGain.connect(audioCtx.destination);
  }
  if (audioCtx.state === "suspended") audioCtx.resume();
  const T = tl();
  if (T.voice?.name && (!voiceEl || voiceEl.dataset.name !== T.voice.name)) {
    voiceEl?.pause();
    voiceEl = new Audio(mediaUrl(T.voice.name));
    voiceEl.dataset.name = T.voice.name;
    voiceGain = audioCtx.createMediaElementSource(voiceEl);
    voiceGain.connect(masterGain);
  }
  if (T.musicEnabled && T.music?.name && (!musicEl || musicEl.dataset.name !== T.music.name)) {
    musicEl?.pause();
    musicEl = new Audio(mediaUrl(T.music.name));
    musicEl.dataset.name = T.music.name;
    musicGain = audioCtx.createMediaElementSource(musicEl);
    musicGain.connect(masterGain);
  }
  return true;
}
function teardownAudio() {
  clearInterval(duckTimer); duckTimer = null;
  voiceEl?.pause(); musicEl?.pause();
  voiceEl = musicEl = null; voiceGain = musicGain = null;
}
function isSpeech(t) {
  return (S.project?.timed || []).some(s => t >= s.start && t <= s.end);
}

function onTransportEvent() {
  if (!S.project) return;
  renderFrame(transport.time);
  updatePlayhead();
  updateScriptBar();
  if (transport.playing) {
    ensureAudio();
    syncAudio(true);
    if (!rafId) rafId = requestAnimationFrame(loop);
  } else {
    syncAudio(false);
    cancelAnimationFrame(rafId); rafId = 0;
  }
}

function syncAudio(playing) {
  const T = tl();
  if (voiceEl) {
    const target = Math.min(Math.max(0, transport.time - (T.voice?.start || 0)), voiceEl.duration || 1e9);
    if (Math.abs(voiceEl.currentTime - target) > 0.35) voiceEl.currentTime = target;
    voiceEl.volume = T.voice?.volume ?? 1;
    playing ? voiceEl.play().catch(() => {}) : voiceEl.pause();
  }
  if (musicEl && T.musicEnabled) {
    const target = Math.min(Math.max(0, transport.time - (T.music?.start || 0)), musicEl.duration || 1e9);
    if (Math.abs(musicEl.currentTime - target) > 0.35) musicEl.currentTime = target;
    musicEl.volume = T.music?.volume ?? 0.5;
    musicEl.loop = true;
    playing ? musicEl.play().catch(() => {}) : musicEl.pause();
    // real ducking: ride the music gain under narration
    clearInterval(duckTimer);
    if (playing && musicGain) {
      const duck = T.ducking ?? 0.35;
      duckTimer = setInterval(() => {
        const want = isSpeech(transport.time) ? 1 - duck : 1;
        musicGain.gain.setTargetAtTime(want, audioCtx.currentTime, 0.25);
      }, 120);
    }
  } else clearInterval(duckTimer);
}

let lastWall = 0;
function loop(ts) {
  if (!transport.playing) { rafId = 0; lastWall = 0; return; }
  if (!lastWall) lastWall = ts;
  const dt = Math.min(0.1, (ts - lastWall) / 1000);   // wall-clock delta
  lastWall = ts;
  // voice element is the A/V sync truth when audible; otherwise wall clock
  const t = (voiceEl && !voiceEl.paused && voiceEl.currentTime > 0)
    ? voiceEl.currentTime + (tl().voice?.start || 0)
    : transport.time + dt;
  if (t >= transport.duration) { setTime(transport.duration); togglePlay(); return; }
  setTime(t, true);
  renderFrame(t);
  updatePlayhead();
  rafId = requestAnimationFrame(loop);
}

// ---------------- frame rendering ----------------
function activeAt(list, t) {
  return list.find(c => t >= c.start && t < c.end);
}

function renderFrame(t) {
  const W = canvas.width, H = canvas.height;
  ctx.fillStyle = "#000";
  ctx.fillRect(0, 0, W, H);
  if (!S.project) return;
  const T = tl();
  const empty = document.getElementById("preview-empty");
  if (empty) empty.style.display = T.clips.length ? "none" : "block";

  const main = activeAt(T.clips.filter(c => c.trackId === "v_main"), t);

  // Opt-in dissolve, placed exactly where the export's xfade sits: the last
  // td seconds of the outgoing clip crossfade into the incoming clip's
  // first td seconds (export offset = acc_dur - td). td uses the identical
  // clamping rule as backend/export.py::_transition_layout, so the preview
  // and the FFmpeg export agree frame-for-frame at every junction.
  // Anything that is not a dissolve is a hard cut (same as the export).
  let drewMain = false;
  if (main) {
    const mains = T.clips.filter(c => c.trackId === "v_main")
      .sort((a, b) => a.start - b.start);
    const next = mains[mains.indexOf(main) + 1];
    const td = next ? transitionTd(mains, mains.indexOf(next), !!T.transitionsDisabled) : 0;
    const remain = main.end - t;
    if (next && td > 0 && remain > 0 && remain <= td) {
      const q = td - remain;              // incoming clip's local time: 0..td
      const a = smooth(q / td);
      renderFrameBase(t, W, H, main, 1 - a);   // outgoing, true local time
      renderFrameBase(t, W, H, next, a, q);    // incoming, local q (matches xfade)
      drewMain = true;
    }
  }
  if (!drewMain) drawMainClip(main, t, W, H, 1);

  const ov = activeAt(T.clips.filter(c => c.trackId === "v_overlay"), t);
  if (ov) renderFrameBase(t, W, H, ov, ov.opacity ?? 0.9);

  drawOverlaysAndSubs(t, W, H);
  updateInspectBadge(main, t);
}

function renderFrameBase(t, W, H, clip, alpha, localT) {
  if (!clip) return;
  if (clip.sourceType === "gap" || !clip.assetId) {
    ctx.save(); ctx.globalAlpha = alpha;
    ctx.fillStyle = "#101318"; ctx.fillRect(0, 0, W, H);
    ctx.fillStyle = "#5a6076"; ctx.font = `${Math.round(W / 22)}px sans-serif`;
    ctx.textAlign = "center";
    ctx.fillText("NO VISUAL — see review queue", W / 2, H / 2);
    ctx.restore();
    return;
  }
  const a = asset(clip.assetId);
  if (!a) return;
  ctx.save();
  ctx.globalAlpha = alpha * (clip.opacity ?? 1);
  applyFilter(clip);
  // localT overrides the clip-local time (used to render the incoming clip
  // of a dissolve at exactly the local time the export's xfade shows).
  const lt = localT ?? (t - clip.start);
  if (a.kind === "image") drawKenBurns(a, clip, lt, W, H);
  else drawVideoFrame(a, clip, lt, W, H);
  ctx.restore();
}

function drawMainClip(clip, t, W, H, alpha) { renderFrameBase(t, W, H, clip, alpha); }

function drawVideoFrame(a, clip, lt, W, H) {
  const v = videoFor(a.name);
  const target = (clip.srcStart || 0) + lt * (clip.speed || 1);
  if (v.readyState >= 2) {
    if (Math.abs(v.currentTime - target) > 0.35) {
      try { v.currentTime = Math.min(target, (v.duration || target + 1) - 0.05); } catch {}
    }
    if (transport.playing && v.paused) v.play().catch(() => {});
    if (!transport.playing && !v.paused) v.pause();
    const vw = v.videoWidth || 16, vh = v.videoHeight || 9;
    drawCover(v, vw, vh, W, H, clip.transform?.focalX ?? 0.5, clip.transform?.focalY ?? 0.5);
  } else if (a.thumb) {
    drawThumbCover(a.thumb, W, H);
  }
}

function drawThumbCover(thumb, W, H) {
  const img = thumbImage(thumb);
  if (img?.complete && img.naturalWidth) drawCover(img, img.naturalWidth, img.naturalHeight, W, H, 0.5, 0.5);
}
const thumbCache = {};
function thumbImage(thumb) {
  if (!thumbCache[thumb]) {
    const img = new Image();
    img.src = `/api/media/thumb?name=${encodeURIComponent(thumb)}`;
    thumbCache[thumb] = img;
  }
  return thumbCache[thumb];
}

function drawKenBurns(a, clip, lt, W, H) {
  const img = thumbImage(a.thumb || a.name);
  const p = Math.min(1, Math.max(0, lt / Math.max(0.1, clip.end - clip.start)));
  const draw = (iw, ih, src) => {
    const zoom = 1 + 0.14 * p;                       // subtle push-in
    const scale = Math.max(W / iw, H / ih) * zoom;
    const sw = W / scale, sh = H / scale;
    const sx = (iw - sw) * (0.5 + 0.1 * Math.sin(p * Math.PI));  // gentle drift
    const sy = (ih - sh) * 0.5;
    ctx.drawImage(src, sx, sy, sw, sh, 0, 0, W, H);
  };
  if (img?.complete && img.naturalWidth) draw(img.naturalWidth, img.naturalHeight, img);
  else if (a.thumb) drawThumbCover(a.thumb, W, H);
}

function drawCover(src, vw, vh, W, H, fx, fy) {
  const scale = Math.max(W / vw, H / vh);
  const sw = W / scale, sh = H / scale;
  const sx = Math.max(0, Math.min(vw - sw, (vw - sw) * fx));
  const sy = Math.max(0, Math.min(vh - sh, (vh - sh) * fy));
  ctx.drawImage(src, sx, sy, sw, sh, 0, 0, W, H);
}

function applyFilter(clip) {
  const f = clip.filter || {};
  const parts = [];
  if (f.grayscale) parts.push("grayscale(1)");
  if (f.sepia) parts.push("sepia(0.8)");
  if (f.brightness) parts.push(`brightness(${1 + f.brightness})`);
  if (f.contrast) parts.push(`contrast(${f.contrast})`);
  if (f.saturation != null && f.saturation !== 1) parts.push(`saturate(${f.saturation})`);
  ctx.filter = parts.join(" ") || "none";
}

function smooth(p) { p = Math.max(0, Math.min(1, p)); return p * p * (3 - 2 * p); }

// Mirror of backend/export.py::_transition_layout — the clamping rules MUST
// stay identical or the preview/export parity breaks.
// td = min(requested, 0.5, output_dur_so_far / 2, clip_dur / 2); 0 for cuts,
// non-dissolves, tiny durations, or when transitions are globally disabled.
const MAX_TD = 0.5;
function transitionTd(mains, idx, disabled) {
  let acc = mains[0].end - mains[0].start;
  for (let i = 1; i <= idx; i++) {
    const d = mains[i].end - mains[i].start;
    const tr = mains[i].transitionIn || {};
    let td = 0;
    if (!disabled && tr.type === "dissolve") {
      td = Math.min(tr.duration || 0.5, MAX_TD, acc / 2, d / 2);
      if (td <= 0.05) td = 0;
    }
    if (i === idx) return td;
    acc = acc + d - td;
  }
  return 0;
}

// ---------------- text overlays + subtitles ----------------
function drawOverlaysAndSubs(t, W, H) {
  const T = tl();
  for (const o of T.overlays) {
    if (t < o.start || t >= o.end) continue;
    drawTextOverlay(o, t, W, H);
  }
  if (!T.subtitlesEnabled) return;
  const cue = T.subtitles.find(s => t >= s.start && t < s.end);
  if (cue) drawSubtitle(cue, T.subtitleStyle, W, H);
}

function drawTextOverlay(o, t, W, H) {
  // Global "Disable all text animations": everything renders in its final
  // resting state — full opacity, full text, settled counter value.
  const noAnim = !!tl().textAnimationsDisabled;
  const p = noAnim ? 1 : smooth(Math.min(1, (t - o.start) / 0.45));
  const pOut = noAnim ? 1 : smooth(Math.min(1, Math.max(0, (o.end - t) / 0.4)));
  const alpha = Math.min(p, pOut);
  const size = Math.round((o.size || 56) * (W / 960));
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.font = `700 ${size}px "DejaVu Sans", sans-serif`;
  ctx.textBaseline = "middle";
  const style = o.style || "fade";
  let x = W / 2, y = H * 0.78, align = "center", scale = 1, text = o.text;

  if (style === "lower-third") {
    align = "left"; x = W * 0.07; y = H * 0.74;
    x = W * 0.07 - (noAnim ? 0 : (1 - p) * 60);
    // backdrop bar
    ctx.fillStyle = "rgba(0,0,0,0.55)";
    const tw = ctx.measureText(text).width;
    ctx.fillRect(x - 18, y - size * 0.75, tw + 36, size * 1.5);
    ctx.fillStyle = "#6c8cff";
    ctx.fillRect(x - 18, y - size * 0.75, 6, size * 1.5);
  } else if (style === "slide") {
    y = H * 0.78 + (noAnim ? 0 : (1 - p) * 70);
  } else if (style === "stat-pop" || style === "pop") {
    scale = noAnim ? 1 : 0.6 + 0.4 * p; y = H * 0.42;
    if (o.kind === "stat" && /^\d/.test(text.trim())) text = animatedNumber(o, t, noAnim);
  } else if (style === "type-on") {
    text = noAnim ? text
      : text.slice(0, Math.floor(text.length * Math.min(1, (t - o.start) / 1.2)));
  }
  ctx.translate(x, y); ctx.scale(scale, scale);
  ctx.textAlign = align;
  ctx.lineWidth = Math.max(2, size / 14); ctx.strokeStyle = "rgba(0,0,0,0.75)";
  ctx.fillStyle = o.color || "#fff";
  const lines = text.split("\n");
  lines.forEach((ln, i) => {
    const ly = (i - (lines.length - 1) / 2) * size * 1.25;
    ctx.strokeText(ln, 0, ly); ctx.fillText(ln, 0, ly);
  });
  ctx.restore();
}

function animatedNumber(o, t, done) {
  const m = o.text.match(/[\d,.]+/);
  if (!m) return o.text;
  const target = parseFloat(m[0].replace(/,/g, ""));
  const p = done ? 1 : smooth(Math.min(1, (t - o.start) / 1.0));
  const val = target * p;
  const fmt = m[0].includes(".") ? val.toFixed(1) : Math.round(val).toLocaleString();
  return o.text.replace(m[0], fmt);
}

function drawSubtitle(cue, st, W, H) {
  const size = Math.round((st.size || 44) * (W / 960));
  ctx.save();
  ctx.font = `${st.weight === "bold" ? "700" : "400"} ${size}px "${st.font || "DejaVu Sans"}", sans-serif`;
  ctx.textAlign = "center"; ctx.textBaseline = "middle";
  const lines = cue.text.split("\n");
  const lh = size * 1.28;
  let y = st.position === "top" ? H * 0.12 : st.position === "middle" ? H * 0.5 : H * 0.88;
  y -= ((lines.length - 1) / 2) * lh;
  // word-highlight animation
  const words = cue.text.replace(/\n/g, " ").split(" ").filter(Boolean);
  lines.forEach((ln, li) => {
    const w = ctx.measureText(ln).width;
    if (st.background && st.background !== "transparent") {
      ctx.fillStyle = st.background;
      ctx.fillRect(W / 2 - w / 2 - 12, y + li * lh - lh / 2, w + 24, lh);
    }
    ctx.lineWidth = Math.max(2, size / 12);
    ctx.strokeStyle = "rgba(0,0,0,0.85)";
    ctx.fillStyle = st.color || "#fff";
    ctx.strokeText(ln, W / 2, y + li * lh);
    ctx.fillText(ln, W / 2, y + li * lh);
  });
  ctx.restore();
}

// ---------------- script sync bar ----------------
function updateScriptBar() {
  const bar = document.getElementById("scriptbar");
  const txt = document.getElementById("scriptbar-text");
  if (!S.project?.timed?.length) { bar.classList.add("hidden"); return; }
  bar.classList.remove("hidden");
  if (!txt.dataset.built) {
    txt.dataset.built = "1";
    txt.innerHTML = S.project.timed.map((s, i) =>
      `<span class="sent" data-i="${i}">${esc(s.text)}</span> `).join("");
    txt.querySelectorAll(".sent").forEach(el => el.onclick = () =>
      setTime(S.project.timed[+el.dataset.i].start + 0.01));
  }
  const t = transport.time;
  const idx = S.project.timed.findIndex(s => t >= s.start && t < s.end);
  txt.querySelectorAll(".sent").forEach((el, i) =>
    el.classList.toggle("active", i === idx));
  const active = txt.querySelector(".sent.active");
  if (active && transport.playing)
    active.scrollIntoView({ block: "nearest", behavior: "smooth" });
}

// ---------------- inspect mode ----------------
function updateInspect() {
  const on = document.getElementById("inspect-mode").checked;
  document.getElementById("inspect-badge").classList.toggle("hidden", !on);
  if (on) updateInspectBadge(
    tl().clips.find(c => c.trackId === "v_main" && transport.time >= c.start && transport.time < c.end),
    transport.time);
}
function updateInspectBadge(clip, t) {
  if (!document.getElementById("inspect-mode").checked) return;
  const b = document.getElementById("inspect-badge");
  if (!clip) { b.textContent = `t=${fmtTime(t)} — no clip`; return; }
  const a = clip.assetId ? asset(clip.assetId) : null;
  b.textContent =
    `clip ${clip.clipId}\nsource: ${clip.sourceType}${clip.provider ? " · " + clip.provider : ""}\n` +
    `timeline ${fmtTime(clip.start)} → ${fmtTime(clip.end)}\n` +
    `source ${fmtTime(clip.srcStart)} → ${fmtTime(clip.srcEnd)}${a ? ` (${a.width}×${a.height})` : ""}\n` +
    `confidence: ${clip.confidence || "—"} · transition in: ${clip.transitionIn?.type || "cut"}`;
}

export function getCanvasStream() {
  ensureAudio();
  return { canvas, audioCtx, masterGain };
}
