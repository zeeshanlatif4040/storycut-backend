// Automatic editing pipeline: voice timing -> visual plan -> per-segment
// visual selection (user footage scoring vs. provider B-roll search with
// fallback) -> timeline assembly -> subtitles/overlays/transitions ->
// quality control -> review queue -> completion.
import { post, get, toast, fmtTime, uid } from "./api.js";
import { S, tl, markDirty, mutate, scheduleAutosave, saveProject } from "./store.js";

let cancelled = false;
let lastCfg = null;

export function showProcessing(show) {
  document.getElementById("processing").classList.toggle("hidden", !show);
  cancelled = false;
}
function step(text, frac) {
  document.getElementById("proc-step").textContent = text;
  document.getElementById("proc-fill").style.width = `${Math.round(frac * 100)}%`;
}
function stats(text) {
  document.getElementById("proc-stats").textContent = text;
}
function renderSceneCells(segs) {
  document.getElementById("proc-scenes").innerHTML = segs.map(s => `
    <div class="scene-cell" id="cell-${s.id}">
      <div class="st">⏳</div><div>Scene ${s.index + 1}</div>
      <div class="muted">${s.duration.toFixed(1)}s</div></div>`).join("");
}
function markScene(id, state, label) {
  const el = document.getElementById(`cell-${id}`);
  if (!el) return;
  el.classList.remove("working"); el.classList.add("done");
  el.querySelector(".st").textContent = state === "ok" ? "✅" : state === "warn" ? "⚠️" : "❌";
  if (label) el.title = label;
}

async function mapPool(items, n, fn) {
  const it = items[Symbol.iterator]();
  const workers = Array.from({ length: Math.min(n, items.length) }, async () => {
    for (let x = it.next(); !x.done; x = it.next()) {
      if (cancelled) return;
      await fn(x.value);
    }
  });
  await Promise.all(workers);
}

// ---------------- user footage scoring (spec 22/23) ----------------
function scoreUserAsset(a, seg, orientation) {
  const text = `${a.original || ""} ${(a.tags || []).join(" ")}`.toLowerCase();
  const terms = seg.keywords || [];
  const overlap = terms.length
    ? terms.filter(t => text.includes(t.toLowerCase())).length / terms.length : 0;
  let orientFit = 1;
  if (a.orientation && a.orientation !== "unknown")
    orientFit = a.orientation === orientation ? 1 : 0.45;
  let durFit = 1;
  if (a.kind === "video" && a.duration)
    durFit = a.duration >= seg.duration ? 1 : Math.max(0.25, a.duration / seg.duration);
  return { score: 0.6 * overlap + 0.2 * orientFit + 0.2 * durFit, overlap, orientFit, durFit };
}

function pickSrcStart(a, need) {
  const dur = a.duration || need;
  if (a.kind === "image") return { srcStart: 0, srcEnd: need, speed: 1 };
  const scenes = (a.scenes || []).filter(s => s >= 0.6 && s + need <= dur - 0.2);
  if (scenes.length) return { srcStart: scenes[0], srcEnd: scenes[0] + need, speed: 1 };
  if (dur >= need) return { srcStart: Math.max(0, (dur - need) / 3), srcEnd: 0, speed: 1 };
  // source shorter than needed: gentle slow-motion to fill the narration
  return { srcStart: 0, srcEnd: Math.max(0.5, dur), speed: Math.max(0.4, dur / need) };
}

// ---------------- B-roll search with provider fallback (spec 15) ----------------
async function searchBroll(queries, orientation, need, usedIds, perPage, metrics, mediaType = "video") {
  for (const q of queries) {
    if (cancelled) return null;
    try {
      metrics.apiCalls++;
      const r = await get(`/api/broll/search?provider=auto&q=${encodeURIComponent(q)}` +
        `&orientation=${orientation}&per_page=${perPage}&media_type=${mediaType}` +
        `&need_duration=${need.toFixed(1)}&used=${encodeURIComponent(usedIds.join(","))}`);
      metrics.searches++;
      if (r.cached) metrics.cacheHits++;
      if (r.candidates && r.candidates.length)
        return { candidates: r.candidates, query: q, provider: r.provider, attempts: r.attempts, mediaType };
    } catch (e) {
      metrics.failed++;
    }
  }
  return null;
}

async function downloadCandidate(cand, query) {
  const r = await post("/api/broll/download", {
    candidate: { ...cand, searchQuery: query },
  });
  return r.asset;
}

// ---------------- main ----------------
export async function runAutoEdit(cfg) {
  const P = S.project;
  P.name = `Auto edit — ${new Date().toLocaleString()}`;
  document.getElementById("project-name").value = P.name;
  P.script = cfg.script; P.format = cfg.format; P.sourceMode = cfg.sourceMode;
  P.speedMode = cfg.speedMode;

  for (const m of cfg.mediaFiles)
    P.assets[m.name] = { ...m, assetId: m.name,
      sourceType: m.kind === "video" ? "user_video" : "user_image" };

  const voice = cfg.voiceFiles[0];
  P.voiceName = voice.name; P.voiceDuration = voice.duration;

  const metrics = { apiCalls: 0, cacheHits: 0, searches: 0, failed: 0,
                    t0: performance.now(), searchesMs: 0 };
  lastCfg = cfg;
  showProcessing(true);
  document.getElementById("proc-title").textContent = "Automatic editing…";

  try {
    // 1. voice timing (real audio analysis)
    step("Analyzing voice-over timing (speech energy detection)…", 0.04);
    const va = await post("/api/voice/analyze", { audioName: P.voiceName, script: cfg.script });
    P.timed = va.sentences;
    P.voiceDuration = va.duration;
    P.timeline.voice = { name: P.voiceName, start: 0, end: va.duration, volume: 1 };
    P.timeline.duration = va.duration;

    // 2. script understanding + visual plan
    step("Understanding the story & building the visual plan…", 0.12);
    const pr = await post("/api/pipeline/plan", { script: cfg.script, timed: P.timed });
    P.plan = pr.plan;
    P.timeline.subtitles = pr.plan.subtitles.map((s, i) =>
      ({ id: uid("sub"), ...s }));
    stats(`${pr.plan.segments.length} scenes · ${pr.plan.subtitles.length} captions · ${pr.plan.overlays.length} text overlays planned`);

    // 3. per-segment visual selection (parallel, progressive)
    const segs = pr.plan.segments;
    const orientation = P.format === "9:16" ? "portrait" : "landscape";
    const perPage = cfg.speedMode === "fast" ? 6 : cfg.speedMode === "quality" ? 20 : 12;
    const concurrency = cfg.speedMode === "fast" ? 5 : cfg.speedMode === "quality" ? 2 : 3;
    const queriesPerSeg = cfg.speedMode === "fast" ? 2 : 5;
    renderSceneCells(segs);
    const usedIds = [];
    let done = 0;
    const clipsBySeg = {};

    await mapPool(segs, concurrency, async (seg) => {
      const cell = document.getElementById(`cell-${seg.id}`);
      if (cell) cell.classList.add("working");
      try {
        const clip = await buildSegmentVisual(seg, cfg, P, orientation,
          usedIds, perPage, queriesPerSeg, metrics);
        clipsBySeg[seg.id] = clip;
        P.timeline.clips.push(clip);
        if (clip.sourceType === "broll" && clip.provider)
          usedIds.push(`${clip.provider}:${clip.assetId}`);
        markScene(seg.id, clip.confidence === "low" ? "warn" : "ok",
          `${clip.sourceType} · ${clip.intent}`);
      } catch (e) {
        markScene(seg.id, "bad", String(e.message || e).slice(0, 120));
        const clip = gapClip(seg, String(e.message || e).slice(0, 160));
        clipsBySeg[seg.id] = clip;
        P.timeline.clips.push(clip);
      }
      done++;
      step(`Selecting visuals… scene ${done}/${segs.length}`, 0.15 + 0.68 * done / segs.length);
      stats(`${metrics.searches} searches · ${metrics.cacheHits} cache hits · ${metrics.failed} failed`);
      window.dispatchEvent(new CustomEvent("timeline-progress"));
      if (cancelled) throw new Error("cancelled");
    });

    if (cancelled) throw new Error("cancelled");

    // 4. order, transitions, overlays
    step("Assembling timeline, transitions & text…", 0.86);
    P.timeline.clips.sort((a, b) => a.start - b.start);
    applyTransitions(P);
    P.timeline.overlays = pr.plan.overlays.map(o => ({
      ...o, trackId: "gfx", size: o.style === "stat-pop" ? 84 : 56,
      color: "#FFFFFF",
    }));

    // 5. quality control + auto repair
    step("Quality control…", 0.93);
    const repairs = qualityControl(P);

    // 6. review queue
    P.review = P.timeline.clips
      .filter(c => c.confidence === "low" && c.trackId === "v_main")
      .map(c => ({ clipId: c.clipId, segmentId: c.segmentId, start: c.start,
                   reason: c.reviewReason || "Low match confidence", intent: c.intent }));

    P.metrics.autoEditMs = Math.round(performance.now() - metrics.t0);
    Object.assign(P.metrics, metrics);
    markDirty(); scheduleAutosave();
    window.dispatchEvent(new CustomEvent("timeline-progress"));
    window.dispatchEvent(new CustomEvent("project"));
    showProcessing(false);
    showCompletion(P, repairs);
  } catch (e) {
    showProcessing(false);
    if (String(e.message) !== "cancelled") throw e;
    toast("Automatic edit cancelled", "bad");
  }
}

document.getElementById("proc-cancel")?.addEventListener("click", () => { cancelled = true; });

function gapClip(seg, reason) {
  return {
    clipId: uid("clip"), assetId: null, sourceType: "gap",
    srcStart: 0, srcEnd: seg.duration, start: seg.start, end: seg.end,
    trackId: "v_main", transform: { focalX: 0.5, focalY: 0.5, scale: 1, rotation: 0 },
    opacity: 1, speed: 1, transitionIn: { type: "cut", duration: 0 },
    transitionOut: { type: "cut", duration: 0 },
    locked: false, confidence: "low", reviewReason: "No visual found: " + reason,
    segmentId: seg.id, intent: (seg.keywords || []).join(" "), searchQuery: "",
    title: "⚠ no visual",
  };
}

async function buildSegmentVisual(seg, cfg, P, orientation, usedIds, perPage, nQueries, metrics) {
  const need = Math.max(0.8, seg.duration);
  const mode = cfg.sourceMode;

  const userAssets = Object.values(P.assets).filter(a =>
    a.sourceType === "user_video" || a.sourceType === "user_image");
  const scored = userAssets
    .map(a => ({ a, ...scoreUserAsset(a, seg, orientation) }))
    .sort((x, y) => y.score - x.score);
  const bestUser = scored[0] || null;

  const wantBrollFirst = mode === "broll-only" || mode === "broll-first" || mode === "balanced";
  const wantUserFirst = mode === "user-only" || mode === "user-first" || mode === "balanced";

  async function tryBroll() {
    if (mode === "user-only") return null;
    const queries = seg.queries.slice(0, nQueries);
    // The AI decides per scene: video first (motion usually wins), but images
    // compete whenever video is weak or missing — never force video.
    const v = await searchBroll(queries, orientation, need, usedIds, perPage, metrics, "video");
    const vScore = v && v.candidates.length ? v.candidates[0].score : 0;
    let found = v, best = vScore + 0.05; // slight preference for motion
    if (vScore < 0.45) {
      const im = await searchBroll(queries, orientation, need, usedIds, perPage, metrics, "image");
      const iScore = im && im.candidates.length ? im.candidates[0].score : 0;
      if (iScore > best) { found = im; best = iScore; }
    }
    if (!found) return null;
    const cand = found.candidates[0];
    const t0 = performance.now();
    const asset = await downloadCandidate(cand, found.query);
    metrics.searchesMs += performance.now() - t0;
    asset.sourceType = "broll";
    P.assets[asset.name] = asset;
    return { asset, score: cand.score, provider: found.provider, query: found.query,
             match: cand.match, attempts: found.attempts,
             mediaType: found.mediaType || cand.media_type || "video" };
  }
  function tryUser() {
    if (!bestUser || mode === "broll-only") return null;
    return { asset: bestUser.a, score: bestUser.score };
  }

  let pick = null, via = "";
  if (wantBrollFirst && wantUserFirst) {
    // balanced: gather both, take the better real score
    const [b, u] = await Promise.all([tryBroll(), Promise.resolve(tryUser())]);
    if (b && u) pick = (b.score * 0.9 + 0.1) >= u.score ? (via = "broll", b) : (via = "user", u);
    else if (b) { pick = b; via = "broll"; }
    else if (u) { pick = u; via = "user"; }
    else if (mode === "balanced") pick = null;
  } else if (wantBrollFirst) {
    const b = await tryBroll();
    if (b) { pick = b; via = "broll"; }
    else if (wantUserFirst || mode === "broll-first") { const u = tryUser(); if (u) { pick = u; via = "user"; } }
  } else {
    const u = tryUser();
    if (u && (mode === "user-only" || u.score >= 0.28)) { pick = u; via = "user"; }
    else { const b = await tryBroll(); if (b) { pick = b; via = "broll"; } else if (u) { pick = u; via = "user"; } }
  }

  if (!pick) {
    const clip = gapClip(seg, "no B-roll results and no matching user media");
    return clip;
  }

  const { asset } = pick;
  const { srcStart, srcEnd: sEnd, speed } = pickSrcStart(asset, need);
  const srcEnd = sEnd || (srcStart + need);
  const confidence = pick.score >= 0.55 ? "high" : pick.score >= 0.32 ? "medium" : "low";

  return {
    clipId: uid("clip"), assetId: asset.name, sourceType: asset.sourceType,
    provider: asset.provider || null, assetIdRaw: asset.assetId || null,
    pageUrl: asset.pageUrl || null, license: asset.license || null,
    creator: asset.creator || null, creatorUrl: asset.creatorUrl || null,
    attributionRequired: !!asset.attributionRequired,
    retrievedAt: asset.retrievedAt || null,
    srcStart: round2(srcStart), srcEnd: round2(Math.min(srcEnd, asset.duration || srcEnd)),
    start: seg.start, end: seg.end, trackId: "v_main",
    transform: { focalX: 0.5, focalY: orientation === "portrait" ? 0.38 : 0.5, scale: 1, rotation: 0 },
    opacity: 1, speed: round2(speed),
    filter: {},
    transitionIn: { type: "cut", duration: 0 }, transitionOut: { type: "cut", duration: 0 },
    locked: false, confidence,
    reviewReason: confidence === "low" ? `Weak ${via} match (score ${pick.score.toFixed(2)}) for “${(seg.keywords || []).slice(0, 3).join(" ")}”` : null,
    segmentId: seg.id, intent: (seg.keywords || []).join(" "),
    searchQuery: pick.query || "",
    title: via === "broll" ? `🎬 ${(asset.original || "").slice(0, 34)}` : `📁 ${(asset.original || "").slice(0, 34)}`,
    thumb: asset.thumb || null,
    matchInfo: pick.match || { keyword: round2(bestUser?.overlap || 0) },
  };
}

function applyTransitions(P) {
  // Transitions are strictly opt-in: every new segment defaults to a clean
  // cut. The user adds dissolves deliberately via the Effects panel; the
  // global "Disable all transitions" toggle forces cuts everywhere.
  const clips = P.timeline.clips.filter(c => c.trackId === "v_main");
  for (const c of clips) {
    c.transitionIn = { type: "cut", duration: 0 };
    c.transitionOut = { type: "cut", duration: 0 };
  }
}

// ---------------- quality control (spec 45) ----------------
function qualityControl(P) {
  const repairs = [];
  const T = P.timeline;
  const clips = T.clips.filter(c => c.trackId === "v_main").sort((a, b) => a.start - b.start);

  // 1. no gaps in visual coverage
  for (let i = 1; i < clips.length; i++) {
    const prev = clips[i - 1], cur = clips[i];
    const gap = cur.start - prev.end;
    if (gap > 0.25 && !cur.locked && !prev.locked) {
      const extend = Math.min(gap, 1.5);
      prev.end = round2(prev.end + extend);
      const a = P.assets[prev.assetId];
      if (a && a.kind === "video" && prev.sourceType !== "user_image")
        prev.srcEnd = round2(Math.min(prev.srcEnd + extend * prev.speed, a.duration || prev.srcEnd + extend));
      repairs.push(`Extended scene ${i} by ${extend.toFixed(1)}s to close a gap`);
      cur.start = round2(prev.end);
    } else if (gap > 0.25) {
      repairs.push(`Gap of ${gap.toFixed(1)}s at ${fmtTime(cur.start)} flagged for review`);
      P.review.push({ clipId: cur.clipId, segmentId: cur.segmentId, start: cur.start,
        reason: `Timeline gap of ${gap.toFixed(1)}s (locked neighbors)`, intent: cur.intent });
    }
    // 2. overlaps
    if (cur.start < prev.end - 0.01) {
      cur.start = round2(prev.end);
      repairs.push(`Fixed overlap at ${fmtTime(cur.start)}`);
    }
  }
  // 3. valid source ranges
  for (const c of clips) {
    const a = P.assets[c.assetId];
    if (!a || c.sourceType === "gap") continue;
    if (c.srcEnd <= c.srcStart) { c.srcEnd = round2(c.srcStart + Math.max(0.5, (c.end - c.start) * c.speed)); repairs.push(`Fixed empty source range on ${c.clipId}`); }
    if (a.duration && c.srcEnd > a.duration + 0.05 && a.kind === "video") {
      c.srcEnd = round2(a.duration); repairs.push(`Clamped source range on ${c.clipId}`);
    }
    if (!c.license && c.sourceType === "broll") {
      repairs.push(`Missing license metadata on ${c.clipId} — flagged`);
      c.confidence = "low"; c.reviewReason = "Missing license metadata";
    }
  }
  // 4. subtitle timing within duration
  T.subtitles = T.subtitles.filter(s => s.start < T.duration && s.end > 0)
    .map(s => ({ ...s, end: Math.min(s.end, T.duration) }));
  // 5. overlays within duration
  T.overlays = T.overlays.filter(o => o.start < T.duration)
    .map(o => ({ ...o, end: Math.min(o.end, T.duration) }));
  // 6. total coverage vs voice
  const covered = clips.reduce((s, c) => s + Math.max(0, c.end - c.start), 0);
  if (T.duration - covered > 2) repairs.push(`Visual coverage ${covered.toFixed(1)}s vs voice ${T.duration.toFixed(1)}s`);
  return repairs;
}

function round2(n) { return Math.round(n * 100) / 100; }

// ---------------- completion popup (spec 46) ----------------
function showCompletion(P, repairs) {
  const T = P.timeline;
  const main = T.clips.filter(c => c.trackId === "v_main");
  const broll = main.filter(c => c.sourceType === "broll").length;
  const user = main.filter(c => c.sourceType === "user_video" || c.sourceType === "user_image").length;
  const gaps = main.filter(c => c.sourceType === "gap").length;
  const m = P.metrics;
  const root = document.getElementById("modal-root");
  root.innerHTML = `
  <div class="modal"><div class="modal-box">
    <h2>✅ VIDEO COMPLETE</h2>
    <p class="muted">Your script and voice-over were analyzed, visuals were selected,
    trimmed and synchronized, subtitles and text animations were added, and your
    timeline is ready for review.</p>
    <div class="complete-stats">
      <div><b>${fmtTime(T.duration)}</b>final duration</div>
      <div><b>${main.length}</b>visual clips</div>
      <div><b>${broll}</b>B-roll clips</div>
      <div><b>${user}</b>your clips</div>
      <div><b>${T.subtitles.length}</b>subtitles</div>
      <div><b>${T.overlays.length}</b>text animations</div>
      <div><b>${P.format}</b>output format</div>
      <div><b>${(m.autoEditMs / 1000).toFixed(0)}s</b>auto-edit time</div>
    </div>
    ${repairs.length ? `<h4 class="sec">Auto repairs (${repairs.length})</h4>
      <div class="debug-box" style="max-height:120px">${repairs.map(r => "• " + r).join("\n")}</div>` : ""}
    ${gaps ? `<p style="color:var(--warn)">⚠ ${gaps} scene(s) have no visual yet — see the review queue.</p>` : ""}
    <div class="modal-foot">
      <button class="btn" id="cp-review">⚠ View low-confidence segments (${P.review.length})</button>
      <button class="btn primary" id="cp-ok">OK — Review video</button>
      <button class="btn primary" id="cp-export">⤓ Export</button>
    </div>
  </div></div>`;
  root.querySelector("#cp-ok").onclick = () => { root.innerHTML = ""; };
  root.querySelector("#cp-review").onclick = () => {
    root.innerHTML = "";
    window.dispatchEvent(new CustomEvent("open-review"));
  };
  root.querySelector("#cp-export").onclick = () => {
    root.innerHTML = "";
    window.dispatchEvent(new CustomEvent("open-export"));
  };
  saveProject(true);
}

// ---------------- regenerate a single segment's visual (spec 24) ----------------
// Locked segments are never touched; the rest of the project is not reprocessed.
export async function regenerateClip(clipId) {
  const P = S.project;
  const clip = P.timeline.clips.find(c => c.clipId === clipId);
  if (!clip) throw new Error("clip not found");
  if (clip.locked) throw new Error("clip is locked");
  const seg = (P.plan?.segments || []).find(s => s.id === clip.segmentId);
  if (!seg) throw new Error("original segment plan not found");
  const orientation = P.format === "9:16" ? "portrait" : "landscape";
  const cfg = lastCfg || { sourceMode: P.sourceMode || "balanced", speedMode: "balanced" };
  const metrics = { apiCalls: 0, cacheHits: 0, searches: 0, failed: 0, searchesMs: 0 };
  const usedIds = P.timeline.clips
    .filter(c => c.provider && c.clipId !== clipId)
    .map(c => `${c.provider}:${c.assetIdRaw}`);
  const fresh = await buildSegmentVisual(seg, cfg, P, orientation, usedIds, 12, 5, metrics);
  if (fresh.sourceType === "gap") throw new Error("no better visual found");
  mutate("Regenerate visual", () => {
    for (const k of ["assetId", "sourceType", "provider", "assetIdRaw", "pageUrl",
      "license", "creator", "creatorUrl", "attributionRequired", "retrievedAt",
      "srcStart", "srcEnd", "speed", "confidence", "reviewReason", "intent",
      "searchQuery", "title", "thumb", "matchInfo", "transform"]) {
      if (fresh[k] !== undefined) clip[k] = fresh[k];
    }
    // refresh review queue entry
    P.review = P.review.filter(r => r.clipId !== clipId);
    if (clip.confidence === "low")
      P.review.push({ clipId, segmentId: clip.segmentId, start: clip.start,
        reason: clip.reviewReason || "Low match confidence", intent: clip.intent });
  });
  window.dispatchEvent(new CustomEvent("timeline-progress"));
}
