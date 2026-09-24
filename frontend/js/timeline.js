// Professional timeline: tracks, zoom, snapping, thumbnails, waveform,
// drag move/trim, split, multi-select, lock. DOM-based for rich interaction.
import { post, toast, fmtTime, esc, mediaUrl, thumbUrl, uid } from "./api.js";
import { S, TRACKS, tl, asset, mutate, undo, redo, onChange, pushUndo, markDirty, scheduleAutosave } from "./store.js";

export const transport = {
  time: 0, playing: false,
  get duration() { return S.project ? tl().duration : 0; },
};
const bus = new EventTarget();
export const onTransport = (fn) => bus.addEventListener("t", fn);
function emitT() { bus.dispatchEvent(new Event("t")); }

export function setTime(t, fromPreview) {
  transport.time = Math.max(0, Math.min(transport.duration || 0, t));
  updatePlayhead();
  if (!fromPreview) emitT();
}
export function togglePlay() {
  transport.playing = !transport.playing;
  document.getElementById("t-play").textContent = transport.playing ? "⏸" : "▶";
  emitT();
}
export function stopPlay() {
  if (transport.playing) togglePlay();
}

let pxPerSec = 60;
const peaksCache = {};

export function initTimeline() {
  const zoom = document.getElementById("tl-zoom");
  zoom.oninput = () => { pxPerSec = +zoom.value; renderTimeline(); };
  document.getElementById("tl-fit").onclick = fitTimeline;
  document.getElementById("tl-split").onclick = splitAtPlayhead;
  document.getElementById("tl-del").onclick = deleteSelected;
  document.getElementById("tl-dup").onclick = duplicateSelected;
  document.getElementById("tl-lock").onclick = toggleLockSelected;
  document.getElementById("tl-snap").onchange = (e) => { snapOn = e.target.checked; };
  onChange((what) => { if (what === "timeline" || what === "project") renderTimeline(); });
  window.addEventListener("timeline-progress", () => renderTimeline());
  document.addEventListener("keydown", onKey);
}

let snapOn = true;

function fitTimeline() {
  const d = transport.duration || 60;
  const laneW = document.getElementById("timeline-scroll").clientWidth - 140;
  pxPerSec = Math.max(8, Math.min(400, laneW / d));
  document.getElementById("tl-zoom").value = pxPerSec;
  renderTimeline();
}

function onKey(e) {
  if (document.getElementById("app").classList.contains("hidden")) return;
  if (/INPUT|TEXTAREA|SELECT/.test(document.activeElement?.tagName)) return;
  if (e.code === "Space") { e.preventDefault(); togglePlay(); }
  else if (e.key === "s" || e.key === "S") splitAtPlayhead();
  else if (e.key === "Delete" || e.key === "Backspace") deleteSelected();
  else if ((e.ctrlKey || e.metaKey) && e.key === "z" && !e.shiftKey) { e.preventDefault(); undo(); }
  else if ((e.ctrlKey || e.metaKey) && (e.key === "y" || (e.key === "z" && e.shiftKey))) { e.preventDefault(); redo(); }
  else if (e.key === "ArrowLeft") setTime(transport.time - 1);
  else if (e.key === "ArrowRight") setTime(transport.time + 1);
}

// ---------------- rendering ----------------
export function renderTimeline() {
  if (!S.project) return;
  const T = tl();
  const dur = Math.max(T.duration, 10);
  const laneW = Math.ceil(dur * pxPerSec) + 200;

  const ruler = document.getElementById("tl-ruler");
  ruler.innerHTML = "";
  ruler.style.width = laneW + 118 + "px";
  ruler.style.marginLeft = "118px";
  const stepS = niceStep(pxPerSec);
  for (let t = 0; t <= dur + 1; t += stepS) {
    const d = document.createElement("div");
    d.className = "tick";
    d.style.left = (t * pxPerSec) + "px";
    d.textContent = fmtTime(t).slice(0, -2);
    ruler.appendChild(d);
  }
  ruler.onpointerdown = (e) => {
    e.preventDefault();
    const r = ruler.getBoundingClientRect();
    seekFromEvent(e, r);
    const mv = (ev) => seekFromEvent(ev, r);
    const up = () => { removeEventListener("pointermove", mv); removeEventListener("pointerup", up); };
    addEventListener("pointermove", mv); addEventListener("pointerup", up);
  };

  const tracksEl = document.getElementById("tl-tracks");
  tracksEl.innerHTML = "";
  for (const tr of TRACKS) {
    const row = document.createElement("div");
    row.className = "track" + (tr.tall ? " tall" : "");
    row.dataset.track = tr.id;
    row.innerHTML = `<div class="track-label">${esc(tr.label)}</div><div class="track-lane" style="width:${laneW}px"></div>`;
    const lane = row.querySelector(".track-lane");
    lane.onpointerdown = (e) => {
      if (e.target === lane) startMarquee(e);
    };
    tracksEl.appendChild(row);
    renderClipsForTrack(tr, lane);
  }
  // voice + music pseudo-clips
  renderAudioClip(T.voice, "a_voice", "🎙 Voice-over");
  renderAudioClip(T.music, "a_music", "🎵 Music");
  updatePlayhead();
  document.getElementById("tl-duration").textContent =
    `Duration ${fmtTime(dur)} · ${T.clips.length} clips`;
  document.getElementById("review-count").textContent = (S.project.review || []).length;
}

function niceStep(px) {
  const target = 90 / px;
  const steps = [0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300];
  return steps.find(s => s >= target) || 600;
}

function seekFromEvent(e, rect) {
  const t = (e.clientX - rect.left) / pxPerSec;
  setTime(t);
}

function renderAudioClip(v, trackId, label) {
  if (!v || !v.name) return;
  const lane = document.querySelector(`.track[data-track="${trackId}"] .track-lane`);
  if (!lane) return;
  const el = document.createElement("div");
  el.className = "clip audio";
  el.style.left = (v.start * pxPerSec) + "px";
  el.style.width = (Math.max(0.5, v.end - v.start) * pxPerSec) + "px";
  el.innerHTML = `<span class="clip-title">${esc(label)}</span><canvas class="wave"></canvas>`;
  lane.appendChild(el);
  drawWave(el.querySelector("canvas"), v.name);
}

async function drawWave(canvas, name) {
  try {
    let peaks = peaksCache[name];
    if (!peaks) {
      const r = await post("/api/voice/peaks", { name, buckets: 800 });
      peaks = peaksCache[name] = r.peaks;
    }
    const dpr = devicePixelRatio || 1;
    const w = canvas.clientWidth || canvas.parentElement.clientWidth, h = canvas.clientHeight || 40;
    canvas.width = w * dpr; canvas.height = h * dpr;
    const ctx = canvas.getContext("2d");
    ctx.scale(dpr, dpr);
    ctx.fillStyle = "#9fd8ff";
    const bw = w / peaks.length;
    peaks.forEach((p, i) => {
      const bh = Math.max(1, p * h * 0.9);
      ctx.fillRect(i * bw, (h - bh) / 2, Math.max(1, bw - 0.5), bh);
    });
  } catch { /* waveform is a nicety */ }
}

function clipLabel(c) {
  if (c.trackId === "gfx") return "✏ " + (c.text || "").slice(0, 40);
  if (c.trackId === "subs") return (c.text || "").replace(/\n/g, " ").slice(0, 48);
  return c.title || c.clipId;
}

function renderClipsForTrack(tr, lane) {
  const T = tl();
  let items = [];
  if (tr.id === "gfx") items = T.overlays;
  else if (tr.id === "subs") items = T.subtitles;
  else items = T.clips.filter(c => c.trackId === tr.id);
  for (const c of items) {
    const el = document.createElement("div");
    const st = c.sourceType || (tr.id === "gfx" ? "gfx" : tr.id === "subs" ? "subs" : "");
    el.className = `clip ${st}` + (S.selection.has(c.clipId || c.id) ? " selected" : "") +
      (c.locked ? " locked" : "");
    el.style.left = (c.start * pxPerSec) + "px";
    el.style.width = Math.max(6, (c.end - c.start) * pxPerSec) + "px";
    el.dataset.id = c.clipId || c.id;
    const a = c.assetId ? asset(c.assetId) : null;
    const thumb = c.thumb || a?.thumb;
    el.innerHTML = `
      ${thumb ? `<div class="clip-thumb" style="background-image:url('${thumbUrl(thumb)}')"></div>` : ""}
      ${c.transitionIn && c.transitionIn.type === "dissolve" ? `<div class="trans-mark"></div>` : ""}
      <span class="clip-title">${esc(clipLabel(c))}</span>
      <div class="trim-l"></div><div class="trim-r"></div>`;
    el.onpointerdown = (e) => clipMouseDown(e, c, el);
    lane.appendChild(el);
  }
}

// ---------------- drag-marquee box selection ----------------
// Dragging on empty lane background draws a selection box across all lanes.
// Locked clips are never selected. A plain click (no drag) keeps the old
// behavior: clear the selection.
function startMarquee(e) {
  if (e.button !== 0) return;
  e.preventDefault();
  const startX = e.clientX, startY = e.clientY;
  const tracksEl = document.getElementById("tl-tracks");
  const box = document.createElement("div");
  box.className = "tl-marquee";
  box.style.display = "none";
  tracksEl.appendChild(box);
  let dragging = false;
  const mv = (ev) => {
    if (!dragging && Math.hypot(ev.clientX - startX, ev.clientY - startY) < 5) return;
    dragging = true;
    const r = tracksEl.getBoundingClientRect();
    const x1 = Math.min(startX, ev.clientX) - r.left;
    const x2 = Math.max(startX, ev.clientX) - r.left;
    const y1 = Math.min(startY, ev.clientY) - r.top;
    const y2 = Math.max(startY, ev.clientY) - r.top;
    box.style.display = "block";
    box.style.left = x1 + "px"; box.style.top = y1 + "px";
    box.style.width = Math.max(0, x2 - x1) + "px";
    box.style.height = Math.max(0, y2 - y1) + "px";
  };
  const up = (ev) => {
    removeEventListener("pointermove", mv); removeEventListener("pointerup", up);
    box.remove();
    if (!dragging) {
      if (S.selection.size) { S.selection.clear(); paintSelection(); }
      window.dispatchEvent(new CustomEvent("selection"));
      return;
    }
    const mx1 = Math.min(startX, ev.clientX), mx2 = Math.max(startX, ev.clientX);
    const my1 = Math.min(startY, ev.clientY), my2 = Math.max(startY, ev.clientY);
    const ids = [];
    for (const el of tracksEl.querySelectorAll(".clip")) {
      const r = el.getBoundingClientRect();
      if (r.left < mx2 && r.right > mx1 && r.top < my2 && r.bottom > my1) {
        const c = findClip(el.dataset.id);
        if (c && !c.locked) ids.push(el.dataset.id);
      }
    }
    S.selection.clear();
    ids.forEach((id) => S.selection.add(id));
    paintSelection();
    window.dispatchEvent(new CustomEvent("selection"));
    if (ids.length) toast(`${ids.length} clip(s) selected`);
  };
  addEventListener("pointermove", mv); addEventListener("pointerup", up);
}

/** Toggle .selected classes in place (no DOM rebuild), so an in-progress
 *  drag keeps its live element references. */
function paintSelection() {
  for (const el of document.querySelectorAll("#tl-tracks .clip"))
    el.classList.toggle("selected", S.selection.has(el.dataset.id));
}

function findClip(id) {
  const T = tl();
  return T.clips.find(c => c.clipId === id) || T.overlays.find(o => o.id === id) ||
    T.subtitles.find(s => s.id === id);
}

// ---------------- interactions ----------------
function clipMouseDown(e, c, el) {
  if (e.button !== 0) return;
  e.stopPropagation();
  e.preventDefault();
  const id = c.clipId || c.id;
  // Locked clips can never be selected or moved (unlock via Editing drawer).
  if (c.locked) { toast("Clip is locked 🔒 — unlock it in the Editing drawer", "bad"); return; }
  if (e.shiftKey) {
    S.selection.has(id) ? S.selection.delete(id) : S.selection.add(id);
  } else if (!S.selection.has(id)) {
    S.selection.clear(); S.selection.add(id);
  }
  // NOTE: paintSelection (not renderTimeline) — a full re-render here would
  // detach `el` and kill live drag feedback.
  paintSelection();
  window.dispatchEvent(new CustomEvent("selection"));

  const mode = e.target.classList.contains("trim-l") ? "trimL"
    : e.target.classList.contains("trim-r") ? "trimR" : "move";
  const startX = e.clientX;
  // Move drags every selected unlocked clip together; trim affects only the
  // grabbed clip.
  const targets = mode === "move"
    ? selectedClips().filter(x => !x.locked)
    : [c];
  const orig = new Map(targets.map(x => [x.clipId || x.id,
    { start: x.start, end: x.end, srcStart: x.srcStart, srcEnd: x.srcEnd }]));
  const els = new Map();
  for (const x of targets) {
    const xid = x.clipId || x.id;
    els.set(xid, document.querySelector(`#tl-tracks .clip[data-id="${xid}"]`));
  }
  const o0 = orig.get(id);
  const snapPts = snapPoints(c);
  let pushedUndo = false, moved = false;
  const undoLabel = mode === "move" ? "Move clip(s)" : "Trim clip";

  const mv = (ev) => {
    if (!pushedUndo) { pushUndo(undoLabel); pushedUndo = true; }
    moved = true;
    const dt = (ev.clientX - startX) / pxPerSec;
    if (mode === "move") {
      let ns = Math.max(0, o0.start + dt);
      ns = applySnap(ns, snapPts, c);
      const d = ns - o0.start;
      for (const x of targets) {
        const o = orig.get(x.clipId || x.id);
        x.start = round2(Math.max(0, o.start + d));
        x.end = round2(Math.max(0.2, o.end + d));
        positionEl(els.get(x.clipId || x.id), x);
      }
    } else if (mode === "trimL") {
      let ns = applySnap(Math.max(0, o0.start + dt), snapPts, c);
      ns = Math.min(ns, o0.end - 0.2);
      const d = ns - o0.start;
      c.start = round2(ns);
      if (c.srcStart != null && (c.sourceType === "broll" || c.sourceType === "user_video")) {
        c.srcStart = round2(Math.max(0, o0.srcStart + d * (c.speed || 1)));
      }
    } else {
      let ne = applySnap(o0.end + dt, snapPts, c);
      ne = Math.max(ne, o0.start + 0.2);
      const d = ne - o0.end;
      c.end = round2(ne);
      if (c.srcEnd != null && (c.sourceType === "broll" || c.sourceType === "user_video")) {
        const a = asset(c.assetId);
        c.srcEnd = round2(Math.min(o0.srcEnd + d * (c.speed || 1), a?.duration || Infinity));
      }
    }
    positionEl(el, c);
    updatePlayhead();
  };
  const up = () => {
    removeEventListener("pointermove", mv); removeEventListener("pointerup", up);
    if (moved) { markDirty(); scheduleAutosave(); }
    renderTimeline();
    window.dispatchEvent(new CustomEvent("selection"));
  };
  addEventListener("pointermove", mv); addEventListener("pointerup", up);
}

function positionEl(el, c) {
  if (!el) return;
  el.style.left = (c.start * pxPerSec) + "px";
  el.style.width = Math.max(6, (c.end - c.start) * pxPerSec) + "px";
}

function snapPoints(except) {
  if (!snapOn) return [];
  const pts = new Set([0, transport.duration]);
  for (const c of tl().clips) {
    if (c === except) continue;
    pts.add(round2(c.start)); pts.add(round2(c.end));
  }
  pts.add(round2(transport.time));
  return [...pts];
}
function applySnap(t, pts, except) {
  if (!snapOn) return t;
  const thr = 8 / pxPerSec;
  let best = t, bd = thr;
  for (const p of pts) {
    const d = Math.abs(p - t);
    if (d < bd) { bd = d; best = p; }
  }
  return best;
}
function round2(n) { return Math.round(n * 100) / 100; }

// ---------------- edit ops ----------------
function selectedClips() {
  return [...S.selection].map(findClip).filter(c => c && c.trackId !== "subs");
}

export function splitAtPlayhead() {
  const t = transport.time;
  const targets = selectedClips().length ? selectedClips()
    : tl().clips.filter(c => c.trackId === "v_main" && c.start < t && c.end > t);
  const doSplit = targets.filter(c => !c.locked && c.start < t - 0.1 && c.end > t + 0.1);
  if (!doSplit.length) { toast("Nothing to split at the playhead", "bad"); return; }
  mutate("Split", () => {
    for (const c of doSplit) {
      const ratio = (t - c.start) / (c.end - c.start);
      const mid = c.srcStart + (c.srcEnd - c.srcStart) * ratio;
      const right = JSON.parse(JSON.stringify(c));
      right.clipId = uid("clip");
      right.start = round2(t); right.srcStart = round2(mid);
      c.end = round2(t); c.srcEnd = round2(mid);
      if (c.segmentId) right.segmentId = c.segmentId + "-b";
      tl().clips.push(right);
      S.selection.add(right.clipId);
    }
  });
  toast(`Split ${doSplit.length} clip(s)`, "ok");
}

export function deleteSelected() {
  const targets = selectedClips().filter(c => !c.locked);
  if (!targets.length) { toast("Nothing deletable selected", "bad"); return; }
  mutate("Delete", () => {
    const T = tl();
    const ids = new Set(targets.map(c => c.clipId || c.id));
    T.clips = T.clips.filter(c => !ids.has(c.clipId));
    T.overlays = T.overlays.filter(o => !ids.has(o.id));
    T.subtitles = T.subtitles.filter(s => !ids.has(s.id));
    S.selection.clear();
  });
}

export function duplicateSelected() {
  const targets = selectedClips().filter(c => !c.locked);
  if (!targets.length) return;
  mutate("Duplicate", () => {
    for (const c of targets) {
      const d = JSON.parse(JSON.stringify(c));
      const id = uid("clip");
      if (d.clipId) d.clipId = id; else d.id = id;
      const len = d.end - d.start;
      d.start = round2(d.end + 0.05); d.end = round2(d.start + len);
      if (d.trackId === "v_main") tl().clips.push(d);
      else if (d.trackId === "gfx") tl().overlays.push(d);
    }
  });
}

export function toggleLockSelected() {
  const targets = selectedClips();
  if (!targets.length) return;
  const to = !targets[0].locked;
  mutate(to ? "Lock" : "Unlock", () => targets.forEach(c => c.locked = to));
  toast(targets.length + (to ? " locked 🔒" : " unlocked 🔓"));
}

export function updatePlayhead() {
  const ph = document.getElementById("tl-playhead");
  if (!ph) return;
  const tlEl = document.getElementById("timeline");
  ph.style.left = (118 + transport.time * pxPerSec) + "px";
  ph.style.top = "0";
  const scroll = document.getElementById("timeline-scroll");
  // keep playhead visible while playing
  if (transport.playing) {
    const x = 118 + transport.time * pxPerSec;
    if (x < scroll.scrollLeft + 118 || x > scroll.scrollLeft + scroll.clientWidth - 60)
      scroll.scrollLeft = Math.max(0, x - scroll.clientWidth / 2);
  }
  const tt = document.getElementById("t-time");
  if (tt) tt.textContent = `${fmtTime(transport.time)} / ${fmtTime(transport.duration)}`;
  const sc = document.getElementById("t-scrub");
  if (sc && document.activeElement !== sc)
    sc.value = transport.duration ? (transport.time / transport.duration) * 1000 : 0;
}
