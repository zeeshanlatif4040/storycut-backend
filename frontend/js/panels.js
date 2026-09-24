// Left panel tabs, inspector, review queue, settings, debug.
import { api, get, post, uploadFiles, toast, esc, fmtTime, mediaUrl, thumbUrl, uid } from "./api.js";
import { S, TRACKS, tl, asset, mutate, pushUndo, markDirty, scheduleAutosave, saveProject } from "./store.js";
import { transport, setTime, renderTimeline, splitAtPlayhead, deleteSelected, duplicateSelected, toggleLockSelected } from "./timeline.js";
import { regenerateClip } from "./pipeline.js";

export function initPanels() {
  document.querySelectorAll("#lp-tabs button").forEach(b =>
    b.onclick = () => {
      document.querySelectorAll("#lp-tabs button").forEach(x => x.classList.remove("active"));
      b.classList.add("active");
      renderTab(b.dataset.tab);
    });
  renderTab("media");
  window.addEventListener("selection", renderInspector);
  window.addEventListener("project-opened", () => { renderTab("media"); renderInspector(); });
  window.addEventListener("timeline-progress", () => { if (tabCur === "media") renderTab("media"); });
  window.addEventListener("open-review", openReview);
  window.addEventListener("open-settings", openSettings);
  document.getElementById("btn-review").onclick = openReview;
  document.getElementById("btn-settings").onclick = openSettings;
  document.getElementById("btn-debug").onclick = openDebug;
  document.getElementById("btn-script-panel").onclick = () =>
    document.getElementById("scriptbar").classList.toggle("hidden");
  document.getElementById("btn-undo").onclick = () => import("./store.js").then(m => m.undo());
  document.getElementById("btn-redo").onclick = () => import("./store.js").then(m => m.redo());
  document.getElementById("btn-export").onclick = () =>
    window.dispatchEvent(new CustomEvent("open-export"));
  document.getElementById("btn-new").onclick = () => {
    if (S.dirty && !confirm("Discard unsaved changes?")) return;
    location.reload();
  };
  document.getElementById("project-name").onchange = (e) => {
    S.project.name = e.target.value; markDirty(); scheduleAutosave();
  };
  document.getElementById("settings-close").onclick = () =>
    document.getElementById("settings").classList.add("hidden");
}

let tabCur = "media";
function renderTab(tab) {
  tabCur = tab;
  const body = document.getElementById("lp-body");
  ({ media: renderMediaTab, audio: renderAudioTab, text: renderTextTab,
     captions: renderCaptionsTab, effects: renderEffectsTab })[tab](body);
}

// ---------------- MEDIA ----------------
function renderMediaTab(body) {
  const assets = Object.values(S.project?.assets || {});
  body.innerHTML = `
    <h4 class="sec">Project media (${assets.length})</h4>
    <div id="bin"></div>
    <h4 class="sec">Find B-roll</h4>
    <div class="wz-field"><input type="text" id="br-q" placeholder="search phrase, e.g. city skyline at dusk"></div>
    <div class="wz-field"><select id="br-mt"><option value="video">🎬 Videos</option><option value="image">🖼️ Images</option></select></div>
    <button class="btn sm primary" id="br-go" style="width:100%">🔍 Search B-roll</button>
    <div id="br-results" style="margin-top:10px"></div>
    <p class="muted" style="font-size:11.5px">Tip: highlight a phrase in the script bar, then search it here to replace the selected clip's visual.</p>`;
  const bin = body.querySelector("#bin");
  bin.innerHTML = assets.length ? "" : `<p class="muted">No media yet.</p>`;
  for (const a of assets) {
    const el = document.createElement("div");
    el.className = "bin-item";
    el.innerHTML = `
      ${a.thumb ? `<img src="${thumbUrl(a.thumb)}">` : `<div style="width:56px;height:34px;background:#000;border-radius:4px;display:flex;align-items:center;justify-content:center">🎞</div>`}
      <div class="bi-meta"><b>${esc(a.original || a.name)}</b>
        <span>${a.sourceType || a.kind}${a.provider ? " · " + esc(a.provider) : ""}${a.duration ? " · " + a.duration.toFixed(1) + "s" : ""}</span></div>
      <button class="btn sm" title="Insert at playhead">＋</button>`;
    el.querySelector("button").onclick = () => insertAssetAtPlayhead(a);
    bin.appendChild(el);
  }
  body.querySelector("#br-go").onclick = () => searchBrollBox(body);
  body.querySelector("#br-q").onkeydown = (e) => { if (e.key === "Enter") searchBrollBox(body); };
}

async function searchBrollBox(body) {
  const q = body.querySelector("#br-q").value.trim();
  if (!q) return;
  const mt = body.querySelector("#br-mt").value || "video";
  const box = body.querySelector("#br-results");
  box.innerHTML = `<p class="muted">Searching…</p>`;
  try {
    const orientation = S.project.format === "9:16" ? "portrait" : "landscape";
    const r = await get(`/api/broll/search?provider=auto&q=${encodeURIComponent(q)}&orientation=${orientation}&per_page=12&media_type=${mt}`);
    box.innerHTML = `<p class="muted">${r.candidates.length} results via ${esc(r.provider)}${r.cached ? " (cached)" : ""}</p>` +
      r.candidates.map((c, i) => `
      <div class="bin-item" data-i="${i}">
        <img src="${esc(c.preview_url)}">
        <div class="bi-meta"><b>${esc(c.title.slice(0, 40))}</b>
          <span>${esc(c.provider)} · ${c.media_type === "image" ? "🖼️ image" : c.duration.toFixed(1) + "s"} · ${c.file_width}×${c.file_height} · score ${c.score}</span>
          ${c.license_name ? `<span>${esc(c.license_name)}${c.attribution_required ? " · ⚠️ attribution" : ""}</span>` : ""}</div>
        <button class="btn sm">Use</button>
      </div>`).join("");
    box.querySelectorAll(".bin-item").forEach(el => el.querySelector("button").onclick = async () => {
      const c = r.candidates[+el.dataset.i];
      try {
        toast("Downloading full-quality file…");
        const d = await post("/api/broll/download", { candidate: { ...c, searchQuery: q } });
        d.asset.sourceType = "broll";
        S.project.assets[d.asset.name] = d.asset;
        markDirty(); scheduleAutosave(); renderTab("media");
        toast("B-roll added to media bin", "ok");
      } catch (e) { toast("Download failed: " + e.message, "bad"); }
    });
  } catch (e) { box.innerHTML = `<p style="color:var(--bad)">Search failed: ${esc(e.message)}</p>`; }
}

function insertAssetAtPlayhead(a) {
  const t = transport.time;
  const dur = a.kind === "video" ? Math.min(6, a.duration || 6) : 4;
  const isImg = a.kind === "image";
  mutate("Insert media", () => {
    tl().clips.push({
      clipId: uid("clip"), assetId: a.name,
      sourceType: a.sourceType || (isImg ? "user_image" : "user_video"),
      provider: a.provider || null, pageUrl: a.pageUrl || null, license: a.license || null,
      creator: a.creator || null, attributionRequired: !!a.attributionRequired,
      srcStart: 0, srcEnd: isImg ? dur : Math.min(dur, a.duration || dur),
      start: Math.round(t * 100) / 100, end: Math.round((t + dur) * 100) / 100,
      trackId: "v_overlay",
      transform: { focalX: 0.5, focalY: 0.5, scale: 1, rotation: 0 },
      opacity: 1, speed: 1, filter: {},
      transitionIn: { type: "cut", duration: 0 }, transitionOut: { type: "cut", duration: 0 },
      locked: false, confidence: "high", title: `📁 ${(a.original || "").slice(0, 30)}`,
      thumb: a.thumb || null,
    });
    tl().duration = Math.max(tl().duration, t + dur);
  });
  toast("Inserted on overlay track at playhead", "ok");
}

// ---------------- AUDIO ----------------
function renderAudioTab(body) {
  const T = tl();
  body.innerHTML = `
    <h4 class="sec">Voice-over</h4>
    <div class="kv"><span>File</span><b>${esc(T.voice?.name?.slice(0, 24) || "—")}</b></div>
    <div class="kv"><span>Duration</span><b>${fmtTime(T.duration)}</b></div>
    <div class="kv"><span>Timing method</span><b style="font-size:11px">energy-aligned to real audio</b></div>
    <h4 class="sec">Music / SFX</h4>
    <label class="snap-toggle" style="font-size:13px"><input type="checkbox" id="au-en" ${T.musicEnabled ? "checked" : ""}> Enable music track</label>
    <div class="wz-field" style="margin-top:8px"><label>Music file</label>
      <input type="file" id="au-file" accept="audio/*"></div>
    <div class="wz-field"><label>Music volume</label>
      <input type="range" id="au-vol" min="0" max="100" value="${(T.music?.volume ?? 0.5) * 100}"></div>
    <div class="wz-field"><label>Auto-ducking under narration</label>
      <input type="range" id="au-duck" min="0" max="80" value="${(T.ducking ?? 0.35) * 100}">
      <div class="muted" style="font-size:11px">Lowers music while someone is speaking.</div></div>
    <div class="wz-field"><label>Voice volume</label>
      <input type="range" id="au-vvol" min="0" max="150" value="${(T.voice?.volume ?? 1) * 100}"></div>`;
  body.querySelector("#au-en").onchange = (e) => mutate("Toggle music", () => { T.musicEnabled = e.target.checked; });
  body.querySelector("#au-file").onchange = async (e) => {
    const f = e.target.files[0]; if (!f) return;
    try {
      const [m] = await uploadFiles([f], "voice");
      mutate("Add music", () => {
        T.music = { name: m.name, start: 0, end: T.duration, volume: 0.5 };
        T.musicEnabled = true;
      });
      renderTab("audio"); toast("Music added", "ok");
    } catch (err) { toast("Upload failed: " + err.message, "bad"); }
  };
  body.querySelector("#au-vol").oninput = (e) => { if (T.music) T.music.volume = e.target.value / 100; markDirty(); };
  body.querySelector("#au-duck").oninput = (e) => { T.ducking = e.target.value / 100; markDirty(); };
  body.querySelector("#au-vvol").oninput = (e) => { if (T.voice) T.voice.volume = e.target.value / 100; markDirty(); };
}

// ---------------- TEXT ----------------
function renderTextTab(body) {
  body.innerHTML = `
    <h4 class="sec">Add text overlay at playhead</h4>
    <div class="wz-field"><input type="text" id="tx-text" placeholder="Overlay text"></div>
    <div class="wz-field"><label>Animation</label><select id="tx-style">
      ${["fade", "slide", "pop", "type-on", "lower-third", "stat-pop"].map(s =>
        `<option value="${s}">${s}</option>`).join("")}</select></div>
    <div class="insp-row">
      <div class="wz-field"><label>Size</label><input type="range" id="tx-size" min="24" max="160" value="56"></div>
      <div class="wz-field"><label>Color</label><input type="color" id="tx-color" value="#ffffff"></div>
    </div>
    <button class="btn primary sm" id="tx-add" style="width:100%">＋ Add overlay (4s)</button>
    <h4 class="sec">Overlays on timeline</h4><div id="tx-list"></div>`;
  const list = body.querySelector("#tx-list");
  const T = tl();
  list.innerHTML = T.overlays.length ? "" : `<p class="muted">None yet — the auto-edit adds them selectively.</p>`;
  T.overlays.forEach(o => {
    const el = document.createElement("div");
    el.className = "cap-item";
    el.innerHTML = `<div class="cap-time">${fmtTime(o.start)} → ${fmtTime(o.end)} · ${esc(o.style)}</div>
      <div>${esc(o.text)}</div>`;
    el.onclick = () => { S.selection.clear(); S.selection.add(o.id); renderTimeline(); renderInspector(); setTime(o.start); };
    list.appendChild(el);
  });
  body.querySelector("#tx-add").onclick = () => {
    const text = body.querySelector("#tx-text").value.trim();
    if (!text) { toast("Type some text first", "bad"); return; }
    const t = transport.time;
    mutate("Add text", () => {
      T.overlays.push({ id: uid("ov"), trackId: "gfx", text,
        style: body.querySelector("#tx-style").value,
        size: +body.querySelector("#tx-size").value,
        color: body.querySelector("#tx-color").value,
        start: Math.round(t * 100) / 100, end: Math.round((t + 4) * 100) / 100, kind: "custom" });
    });
    renderTab("text"); toast("Overlay added", "ok");
  };
}

// ---------------- CAPTIONS ----------------
const PRESETS = [
  { name: "Clean White", style: { color: "#FFFFFF", background: "rgba(0,0,0,0.55)", outline: 2, size: 44, weight: "bold", position: "bottom" } },
  { name: "Hormozi Pop", style: { color: "#FFE14D", background: "transparent", outline: 3, size: 56, weight: "bold", position: "middle" } },
  { name: "Minimal", style: { color: "#FFFFFF", background: "transparent", outline: 1, size: 36, weight: "400", position: "bottom" } },
  { name: "News Lower", style: { color: "#FFFFFF", background: "rgba(20,40,120,0.85)", outline: 0, size: 40, weight: "bold", position: "bottom" } },
];
function renderCaptionsTab(body) {
  const T = tl(), st = T.subtitleStyle;
  body.innerHTML = `
    <h4 class="sec">Captions</h4>
    <label class="snap-toggle" style="font-size:13px"><input type="checkbox" id="cap-en" ${T.subtitlesEnabled ? "checked" : ""}> Show subtitles</label>
    <div class="muted" style="font-size:11.5px;margin:6px 0">${T.subtitles.length} cues · generated from real voice-over timing</div>
    <h4 class="sec">Style presets</h4>
    <div class="style-grid">${PRESETS.map((p, i) => `<div class="preset" data-i="${i}">${p.name}</div>`).join("")}</div>
    <h4 class="sec">Style</h4>
    <div class="insp-row">
      <div class="wz-field"><label>Size</label><input type="range" id="cs-size" min="24" max="96" value="${st.size}"></div>
      <div class="wz-field"><label>Color</label><input type="color" id="cs-color" value="${st.color}"></div>
    </div>
    <div class="insp-row">
      <div class="wz-field"><label>Position</label><select id="cs-pos">
        ${["bottom", "middle", "top"].map(p => `<option ${st.position === p ? "selected" : ""}>${p}</option>`).join("")}</select></div>
      <div class="wz-field"><label>Outline</label><input type="range" id="cs-ol" min="0" max="5" value="${st.outline}"></div>
    </div>
    <div class="wz-field"><label>Animation</label><select id="cs-anim">
      ${["fade", "pop", "slide"].map(a => `<option ${st.animation === a ? "selected" : ""}>${a}</option>`).join("")}</select></div>
    <h4 class="sec">Edit cues</h4><div id="cap-list" style="max-height:260px;overflow:auto"></div>`;
  body.querySelector("#cap-en").onchange = (e) => mutate("Toggle captions", () => { T.subtitlesEnabled = e.target.checked; });
  body.querySelectorAll(".preset").forEach(p => p.onclick = () =>
    mutate("Caption preset", () => Object.assign(T.subtitleStyle, PRESETS[+p.dataset.i].style)));
  const upd = () => mutate("Caption style", () => {
    st.size = +body.querySelector("#cs-size").value;
    st.color = body.querySelector("#cs-color").value;
    st.position = body.querySelector("#cs-pos").value;
    st.outline = +body.querySelector("#cs-ol").value;
    st.animation = body.querySelector("#cs-anim").value;
  });
  ["#cs-pos", "#cs-anim"].forEach(s => body.querySelector(s).onchange = upd);
  ["#cs-size", "#cs-ol", "#cs-color"].forEach(s => body.querySelector(s).oninput = upd);
  const list = body.querySelector("#cap-list");
  T.subtitles.slice(0, 200).forEach(s => {
    const el = document.createElement("div");
    el.className = "cap-item";
    el.innerHTML = `<div class="cap-time">${fmtTime(s.start)} → ${fmtTime(s.end)}</div>
      <textarea>${esc(s.text)}</textarea>`;
    el.querySelector("textarea").onchange = (e) => mutate("Edit caption", () => { s.text = e.target.value; });
    el.onclick = () => setTime(s.start + 0.01);
    list.appendChild(el);
  });
}

// ---------------- EFFECTS ----------------
function renderEffectsTab(body) {
  const c = [...S.selection].map(id =>
    tl().clips.find(x => x.clipId === id)).find(Boolean);
  if (!c) { body.innerHTML = `<p class="muted">Select a timeline clip to edit transitions, speed, filters and framing.</p>`; return; }
  const f = c.filter || (c.filter = {});
  body.innerHTML = `
    <h4 class="sec">Selected: ${esc((c.title || c.clipId).slice(0, 28))}</h4>
    <div class="wz-field"><label>Transition in</label><select id="fx-tin">
      ${["cut", "dissolve", "fade"].map(t => `<option value="${t}" ${c.transitionIn?.type === t ? "selected" : ""}>${t}</option>`).join("")}</select></div>
    <div class="wz-field"><label>Transition duration (s)</label>
      <input type="range" id="fx-tind" min="0" max="2" step="0.1" value="${c.transitionIn?.duration || 0}"></div>
    <div class="wz-field"><label>Speed</label>
      <input type="range" id="fx-spd" min="25" max="200" value="${(c.speed || 1) * 100}">
      <div class="muted" style="font-size:11px" id="fx-spdv">${Math.round((c.speed || 1) * 100)}%</div></div>
    <div class="wz-field"><label>Opacity</label>
      <input type="range" id="fx-op" min="10" max="100" value="${(c.opacity ?? 1) * 100}"></div>
    <h4 class="sec">Filters</h4>
    <label class="snap-toggle" style="font-size:13px"><input type="checkbox" id="fx-gs" ${f.grayscale ? "checked" : ""}> Grayscale</label><br>
    <label class="snap-toggle" style="font-size:13px"><input type="checkbox" id="fx-se" ${f.sepia ? "checked" : ""}> Sepia</label>
    <div class="wz-field" style="margin-top:8px"><label>Brightness</label>
      <input type="range" id="fx-br" min="-50" max="50" value="${(f.brightness || 0) * 100}"></div>
    <div class="wz-field"><label>Contrast</label>
      <input type="range" id="fx-co" min="50" max="200" value="${(f.contrast || 1) * 100}"></div>
    <div class="wz-field"><label>Saturation</label>
      <input type="range" id="fx-sa" min="0" max="200" value="${(f.saturation ?? 1) * 100}"></div>
    <h4 class="sec">Framing (9:16 smart reframe)</h4>
    <div class="wz-field"><label>Focus X</label>
      <input type="range" id="fx-fx" min="0" max="100" value="${(c.transform?.focalX ?? 0.5) * 100}"></div>
    <div class="wz-field"><label>Focus Y</label>
      <input type="range" id="fx-fy" min="0" max="100" value="${(c.transform?.focalY ?? 0.5) * 100}"></div>
    <p class="muted" style="font-size:11px">For vertical output, the crop follows this focal point instead of blind center-cropping.</p>`;
  const ch = (id, fn) => body.querySelector(id).onchange = (e) =>
    mutate("Effect", () => fn(e));
  const inp = (id, fn) => body.querySelector(id).oninput = (e) => { fn(e); markDirty(); };
  ch("#fx-tin", e => c.transitionIn = { type: e.target.value, duration: c.transitionIn?.duration || 0.5 });
  inp("#fx-tind", e => c.transitionIn = { type: c.transitionIn?.type || "dissolve", duration: +e.target.value });
  inp("#fx-spd", e => { c.speed = e.target.value / 100; body.querySelector("#fx-spdv").textContent = e.target.value + "%"; });
  inp("#fx-op", e => c.opacity = e.target.value / 100);
  ch("#fx-gs", e => f.grayscale = e.target.checked);
  ch("#fx-se", e => f.sepia = e.target.checked);
  inp("#fx-br", e => f.brightness = e.target.value / 100);
  inp("#fx-co", e => f.contrast = e.target.value / 100);
  inp("#fx-sa", e => f.saturation = e.target.value / 100);
  inp("#fx-fx", e => c.transform.focalX = e.target.value / 100);
  inp("#fx-fy", e => c.transform.focalY = e.target.value / 100);
}

// ---------------- INSPECTOR ----------------
function selClip() {
  const id = [...S.selection][0];
  if (!id) return null;
  return tl().clips.find(c => c.clipId === id) ||
    tl().overlays.find(o => o.id === id) || null;
}

function renderInspector() {
  const body = document.getElementById("inspector-body");
  const c = selClip();
  if (!c) { body.innerHTML = `<p class="muted">Select a clip on the timeline.</p>`; return; }
  const a = c.assetId ? asset(c.assetId) : null;
  if (c.trackId === "gfx") {
    body.innerHTML = `
      <div class="insp-group"><label>Text</label><input type="text" id="in-tx" value="${esc(c.text)}"></div>
      <div class="insp-group"><label>Animation</label><select id="in-st">
        ${["fade", "slide", "pop", "type-on", "lower-third", "stat-pop"].map(s =>
          `<option ${c.style === s ? "selected" : ""}>${s}</option>`).join("")}</select></div>
      <div class="insp-row">
        <div class="insp-group"><label>Start</label><input type="number" id="in-s" step="0.1" value="${c.start}"></div>
        <div class="insp-group"><label>End</label><input type="number" id="in-e" step="0.1" value="${c.end}"></div>
      </div>
      <div class="insp-group"><label>Color</label><input type="color" id="in-c" value="${c.color || "#ffffff"}"></div>
      <div class="insp-row">
        <button class="btn sm" id="in-dup">⧉ Duplicate</button>
        <button class="btn sm" id="in-del">🗑 Delete</button>
      </div>`;
    const upd = () => mutate("Edit overlay", () => {
      c.text = body.querySelector("#in-tx").value;
      c.style = body.querySelector("#in-st").value;
      c.start = +body.querySelector("#in-s").value;
      c.end = +body.querySelector("#in-e").value;
      c.color = body.querySelector("#in-c").value;
    });
    ["#in-tx", "#in-st", "#in-s", "#in-e", "#in-c"].forEach(s =>
      body.querySelector(s).onchange = upd);
    body.querySelector("#in-dup").onclick = duplicateSelected;
    body.querySelector("#in-del").onclick = deleteSelected;
    return;
  }
  const conf = c.confidence || "—";
  body.innerHTML = `
    <div class="insp-group"><label>Clip</label>
      <div><b>${esc(c.title || c.clipId)}</b> <span class="conf ${conf}">${conf}</span>
      ${c.locked ? " 🔒" : ""}</div></div>
    ${c.intent ? `<div class="insp-group"><label>Visual intent</label><div style="font-size:12.5px">${esc(c.intent)}</div></div>` : ""}
    ${c.searchQuery ? `<div class="insp-group"><label>Search query used</label><div style="font-size:12.5px">${esc(c.searchQuery)}</div></div>` : ""}
    ${a ? `<div class="insp-group"><label>Source information</label>
      <div style="font-size:12.5px">
      ${c.provider ? `Provider: <b>${esc(c.provider)}</b><br>` : ""}
      ${a.creator ? `Creator: ${esc(a.creator)}<br>` : ""}
      ${a.license ? `License: ${esc(a.license)}<br>` : ""}
      ${a.pageUrl ? `<a href="${esc(a.pageUrl)}" target="_blank" style="color:var(--acc)">Source page ↗</a><br>` : ""}
      ${a.retrievedAt ? `Retrieved: ${esc(a.retrievedAt)}` : ""}
      ${a.attributionRequired ? `<br>⚠ Attribution required` : ""}</div></div>` : ""}
    <div class="insp-row">
      <div class="insp-group"><label>Timeline start</label><input type="number" id="in-ts" step="0.1" value="${c.start}"></div>
      <div class="insp-group"><label>Timeline end</label><input type="number" id="in-te" step="0.1" value="${c.end}"></div>
    </div>
    ${a?.kind === "video" ? `<div class="insp-row">
      <div class="insp-group"><label>Source in</label><input type="number" id="in-ss" step="0.1" value="${c.srcStart}"></div>
      <div class="insp-group"><label>Source out</label><input type="number" id="in-se" step="0.1" value="${c.srcEnd}"></div>
    </div>` : ""}
    ${c.reviewReason ? `<div class="insp-group"><label>Review note</label>
      <div style="font-size:12.5px;color:var(--warn)">${esc(c.reviewReason)}</div></div>` : ""}
    <div class="insp-group"><label>Actions</label>
      <div style="display:flex;gap:6px;flex-wrap:wrap">
        ${c.sourceType === "broll" ? `<button class="btn sm" id="in-replace">🔁 Replace B-roll</button>` : ""}
        ${c.segmentId ? `<button class="btn sm" id="in-regen">✨ Regenerate visual</button>` : ""}
        <button class="btn sm" id="in-lock">${c.locked ? "🔓 Unlock" : "🔒 Lock"}</button>
      </div>
      <div style="display:flex;gap:6px;margin-top:6px">
        <button class="btn sm" id="in-split">✂ Split</button>
        <button class="btn sm" id="in-dup2">⧉</button>
        <button class="btn sm" id="in-del2">🗑</button>
      </div></div>`;
  const num = (id, fn) => body.querySelector(id).onchange = (e) =>
    mutate("Edit timing", () => fn(+e.target.value));
  num("#in-ts", v => c.start = v);
  num("#in-te", v => c.end = v);
  if (body.querySelector("#in-ss")) {
    num("#in-ss", v => c.srcStart = Math.max(0, v));
    num("#in-se", v => c.srcEnd = Math.min(v, a.duration || v));
  }
  const rep = body.querySelector("#in-replace");
  if (rep) rep.onclick = () => openReplaceModal(c);
  const reg = body.querySelector("#in-regen");
  if (reg) reg.onclick = async () => {
    if (c.locked) { toast("Clip is locked", "bad"); return; }
    toast("Regenerating visual for this segment…");
    try { await regenerateClip(c.clipId); toast("Visual regenerated", "ok"); }
    catch (e) { toast("Regeneration failed: " + e.message, "bad"); }
  };
  body.querySelector("#in-lock").onclick = toggleLockSelected;
  body.querySelector("#in-split").onclick = splitAtPlayhead;
  body.querySelector("#in-dup2").onclick = duplicateSelected;
  body.querySelector("#in-del2").onclick = deleteSelected;
}

// ---------------- REPLACE B-ROLL ----------------
async function openReplaceModal(clip) {
  const root = document.getElementById("modal-root");
  root.innerHTML = `<div class="modal"><div class="modal-box">
    <h2>🔁 Replace B-roll</h2>
    <p class="muted">Alternatives for “${esc(clip.intent || clip.searchQuery || "")}”</p>
    <div class="wz-field"><input type="text" id="rp-q" value="${esc(clip.searchQuery || clip.intent || "")}"></div>
    <button class="btn sm primary" id="rp-go">Search</button>
    <div class="cand-grid" id="rp-grid"></div>
    <div class="modal-foot"><button class="btn" id="rp-close">Cancel</button></div>
  </div></div>`;
  const close = () => root.innerHTML = "";
  root.querySelector("#rp-close").onclick = close;
  const go = async () => {
    const q = root.querySelector("#rp-q").value.trim();
    if (!q) return;
    const grid = root.querySelector("#rp-grid");
    grid.innerHTML = `<p class="muted">Searching…</p>`;
    try {
      const orientation = S.project.format === "9:16" ? "portrait" : "landscape";
      const used = tl().clips.filter(c => c.provider).map(c => `${c.provider}:${c.assetIdRaw}`);
      const r = await get(`/api/broll/search?provider=auto&q=${encodeURIComponent(q)}&orientation=${orientation}&per_page=12&used=${encodeURIComponent(used.join(","))}`);
      grid.innerHTML = r.candidates.map((c, i) => `
        <div class="cand" data-i="${i}">
          <img src="${esc(c.preview_url)}" loading="lazy">
          <div class="cand-meta"><b>${esc(c.provider)}</b> · ${c.duration.toFixed(1)}s ·
          ${c.file_width}×${c.file_height}<br>score ${c.score} · ${esc(c.license_name || "")}</div>
        </div>`).join("") || `<p class="muted">No results.</p>`;
      grid.querySelectorAll(".cand").forEach(el => el.onclick = async () => {
        const cand = r.candidates[+el.dataset.i];
        el.classList.add("sel");
        try {
          toast("Downloading replacement…");
          const d = await post("/api/broll/download", { candidate: { ...cand, searchQuery: q } });
          d.asset.sourceType = "broll";
          S.project.assets[d.asset.name] = d.asset;
          mutate("Replace B-roll", () => {
            clip.assetId = d.asset.name;
            clip.provider = d.asset.provider; clip.assetIdRaw = d.asset.assetId;
            clip.pageUrl = d.asset.pageUrl; clip.license = d.asset.license;
            clip.creator = d.asset.creator; clip.creatorUrl = d.asset.creatorUrl;
            clip.attributionRequired = d.asset.attributionRequired;
            clip.srcStart = 0;
            clip.srcEnd = Math.min(d.asset.duration || 999, clip.end - clip.start);
            clip.thumb = d.asset.thumb;
            clip.confidence = "high"; clip.reviewReason = null;
            clip.searchQuery = q;
            clip.title = `🎬 ${(d.asset.original || "").slice(0, 34)}`;
          });
          close(); toast("B-roll replaced", "ok");
        } catch (e) { toast("Download failed: " + e.message, "bad"); }
      });
    } catch (e) { grid.innerHTML = `<p style="color:var(--bad)">${esc(e.message)}</p>`; }
  };
  root.querySelector("#rp-go").onclick = go;
  go();
}

// ---------------- REVIEW QUEUE ----------------
function openReview() {
  const items = S.project?.review || [];
  const root = document.getElementById("modal-root");
  root.innerHTML = `<div class="modal"><div class="modal-box">
    <h2>⚠ Needs review (${items.length})</h2>
    <p class="muted">Low-confidence automatic decisions. Click to jump to the segment.</p>
    <div>${items.length ? items.map((r, i) => `
      <div class="review-item" data-i="${i}">
        <b>${fmtTime(r.start)}</b> — ${esc(r.reason)}
        ${r.intent ? `<div class="muted">${esc(r.intent)}</div>` : ""}
      </div>`).join("") : `<p class="muted">Nothing to review — all decisions are confident. 🎉</p>`}</div>
    <div class="modal-foot"><button class="btn primary" id="rv-close">Done</button></div>
  </div></div>`;
  root.querySelector("#rv-close").onclick = () => root.innerHTML = "";
  root.querySelectorAll(".review-item").forEach(el => el.onclick = () => {
    const r = items[+el.dataset.i];
    root.innerHTML = "";
    S.selection.clear();
    if (r.clipId) S.selection.add(r.clipId);
    setTime(Math.max(0, r.start - 0.5));
    renderTimeline(); renderInspector();
  });
}

// ---------------- SETTINGS ----------------
const _testStatus = {}; // key -> {ok, msg} from this session's TEST clicks

async function openSettings() {
  document.getElementById("settings").classList.remove("hidden");
  const box = document.getElementById("provider-cards");
  box.innerHTML = `<p class="muted">Loading providers…</p>`;
  try {
    const r = await get("/api/settings/providers");
    const apis = r.providers.filter(p => p.category === "api");
    const manuals = r.providers.filter(p => p.category !== "api");
    const cfgOf = (k) => r.config[k] || {};
    const typeBadges = (p) => p.media_types.map(t =>
      t === "video" ? "🎬 Video" : "🖼️ Image").join(" · ");
    const apiState = (p) => {
      const c = cfgOf(p.key);
      if (_testStatus[p.key]) return _testStatus[p.key].ok ? "✅ Connected" : "❌ Failed";
      if (!p.needs_api_key) return "🔑 Keyless — ready";
      return c.has_key ? "🔑 Key saved (untested)" : "⚠️ No key";
    };

    // ---- status dashboard ----
    let html = `<h3 style="margin:4px 0 8px">📊 Provider status</h3>
    <table class="prov-table"><thead><tr>
      <th>Provider</th><th>Type</th><th>API status</th><th>Enabled</th><th>Priority</th>
    </tr></thead><tbody>`;
    const ordered = [...apis].sort((a, b) =>
      (cfgOf(a.key).priority ?? 50) - (cfgOf(b.key).priority ?? 50));
    for (const p of ordered) {
      const c = cfgOf(p.key);
      html += `<tr><td>${esc(p.icon)} ${esc(p.name)}</td>
        <td class="muted">${esc(typeBadges(p))}</td>
        <td>${esc(apiState(p))}</td>
        <td>${c.enabled !== false ? "ON" : "OFF"}</td>
        <td>${c.priority ?? 50}</td></tr>`;
    }
    html += `</tbody></table>
      <p class="muted" style="margin:6px 0 14px">Lower priority = tried first.
      The app still skips a provider when it has no good result and falls back
      to the next one — priority never forces a bad visual.</p>
      <h3 style="margin:4px 0 8px">🔌 API providers</h3><div id="api-cards"></div>
      <h3 style="margin:16px 0 8px">📦 Manual / future providers</h3>
      <p class="muted">These sites offer free media but no verified public API
      for automated retrieval — so there is deliberately no key box and no
      green check here. Download manually, then use “Auto Edit My Footage”.</p>
      <div id="manual-cards"></div>`;
    box.innerHTML = html;

    const apiBox = box.querySelector("#api-cards");
    for (const p of ordered) {
      const c = cfgOf(p.key);
      const card = document.createElement("div");
      card.className = "provider-card";
      const st = _testStatus[p.key];
      card.innerHTML = `
        <div class="pc-head">
          <span class="status-dot ${st ? (st.ok ? "ok" : "bad") : (c.has_key || !p.needs_api_key ? "ok" : "")}"></span>
          <h3>${esc(p.icon)} ${esc(p.name)}</h3>
          <span class="chip">${esc(typeBadges(p))}</span>
          <label class="snap-toggle" style="font-size:12px;margin-left:auto">
            <input type="checkbox" data-f="enabled" ${c.enabled !== false ? "checked" : ""}> Enabled</label>
        </div>
        <div class="pc-note" data-f="statusline">${esc(apiState(p))}${st ? " — " + esc(st.msg) : ""}</div>
        ${p.needs_api_key ? `
        <div class="key-row">
          <input type="password" data-f="key" autocomplete="off"
            placeholder="${c.has_key ? c.masked + " (saved)" : "Paste API key here"}">
          <button class="btn sm primary" data-act="save">Save key</button>
          <button class="btn sm" data-act="test">Test</button>
          ${c.has_key ? `<button class="btn sm" data-act="disc">Disconnect</button>` : ""}
        </div>` : `<div class="pc-note">✅ No key needed — works out of the box.</div>
        <div class="key-row"><button class="btn sm" data-act="test">Test connection</button></div>`}
        <div class="pc-grid">
          <div><label class="muted">Priority (lower = tried first)</label><br>
            <input type="number" data-f="priority" value="${c.priority ?? 50}" style="width:80px"></div>
          <div><label class="muted">License</label>
            <div><a href="${esc(p.license_url)}" target="_blank" style="color:var(--acc)">${esc(p.license_name)} ↗</a>
            ${p.attribution_required ? " · ⚠️ attribution required" : " · no attribution required"}</div></div>
          <div class="full"><span class="muted">Rate limit: </span>${esc(p.rate_limit || p.quota_notes)}</div>
          ${p.commercial_use ? `<div class="full"><span class="muted">Commercial use: </span>${esc(p.commercial_use)}</div>` : ""}
          ${p.redistribution_notes ? `<div class="full"><span class="muted">Redistribution: </span>${esc(p.redistribution_notes)}</div>` : ""}
          <div class="full"><a href="${esc(p.docs_url)}" target="_blank" style="color:var(--acc)">Official API docs ↗</a>
            ${p.needs_api_key ? ` · <a href="${esc(p.signup_url)}" target="_blank" style="color:var(--acc)">Get a free key ↗</a>` : ""}</div>
        </div>
        <div class="pc-note" data-f="msg"></div>
        <details class="pc-testsearch"><summary>🔍 Test search — run a real query</summary>
          <div class="key-row" style="margin-top:8px">
            <input type="text" data-f="tsq" value="business meeting" style="flex:1" placeholder="Search term">
            ${p.media_types.length > 1
              ? `<select data-f="tsmt"><option value="video">Video</option><option value="image">Image</option></select>`
              : `<select data-f="tsmt" disabled><option>${p.media_types[0]}</option></select>`}
            <button class="btn sm primary" data-act="tsgo">Search</button>
          </div>
          <div class="ts-results" data-f="tsres"></div>
        </details>`;
      apiBox.appendChild(card);

      const msg = (t, bad) => {
        const m = card.querySelector('[data-f="msg"]');
        m.textContent = t; m.style.color = bad ? "var(--bad)" : "var(--ok)";
      };
      const setStatus = (ok, text) => {
        _testStatus[p.key] = { ok, msg: text };
        const dot = card.querySelector(".status-dot");
        dot.className = "status-dot " + (ok ? "ok" : "bad");
        card.querySelector('[data-f="statusline"]').textContent =
          (ok ? "✅ Connected — " : "❌ Failed — ") + text;
      };
      const readKey = () => card.querySelector('[data-f="key"]')
        ? card.querySelector('[data-f="key"]').value.trim() : "";

      card.querySelector('[data-act="save"]').onclick = async () => {
        const key = readKey();
        try {
          await post(`/api/settings/providers/${p.key}`, {
            ...(key ? { api_key: key } : {}),
            enabled: card.querySelector('[data-f="enabled"]').checked,
            priority: +card.querySelector('[data-f="priority"]').value || 50,
          });
          msg(key ? "Key saved ✓ (masked from now on)" : "Settings saved ✓");
          const ki = card.querySelector('[data-f="key"]');
          if (ki && key) { ki.value = ""; ki.placeholder = "•••• (saved)"; }
        } catch (e) { msg("Save failed: " + e.message, true); }
      };
      card.querySelector('[data-act="test"]').onclick = async () => {
        msg("Testing real connection…");
        try {
          // Pasted-but-unsaved keys are tested ephemerally — never stored.
          const r2 = await post(`/api/settings/providers/${p.key}/test`,
            readKey() ? { api_key: readKey() } : {});
          setStatus(!!r2.ok, r2.message || (r2.ok ? "OK" : "failed"));
          msg(r2.ok ? "✓ API connection successful" : "✕ API connection failed: " + r2.message, !r2.ok);
        } catch (e) { setStatus(false, e.message); msg("✕ API connection failed: " + e.message, true); }
      };
      const disc = card.querySelector('[data-act="disc"]');
      if (disc) disc.onclick = async () => {
        await post(`/api/settings/providers/${p.key}/disconnect`, {});
        delete _testStatus[p.key];
        openSettings(); toast("Disconnected", "ok");
      };
      card.querySelector('[data-f="enabled"]').onchange = async (e) => {
        try {
          await post(`/api/settings/providers/${p.key}`, { enabled: e.target.checked });
          toast(p.name + (e.target.checked ? " enabled" : " disabled"), "ok");
        } catch (err2) { toast("Failed: " + err2.message, "bad"); e.target.checked = !e.target.checked; }
      };
      card.querySelector('[data-act="tsgo"]').onclick = async () => {
        const q = card.querySelector('[data-f="tsq"]').value.trim() || "business meeting";
        const mt = card.querySelector('[data-f="tsmt"]').value || "video";
        const resBox = card.querySelector('[data-f="tsres"]');
        resBox.innerHTML = `<p class="muted">Searching “${esc(q)}”…</p>`;
        try {
          const r3 = await post(`/api/settings/providers/${p.key}/test-search`, { q, media_type: mt });
          if (!r3.results.length) { resBox.innerHTML = `<p class="muted">No results for “${esc(q)}”.</p>`; return; }
          resBox.innerHTML = r3.results.map(c =>
            `<div class="ts-item">
              ${c.preview_url ? `<img src="${esc(c.preview_url)}" alt="">` : ""}
              <div><b>${esc(c.title)}</b>
                <div class="muted">${esc(c.resolution_label || "")} ${esc(c.media_type)}
                · ${esc(c.license_name)}${c.attribution_required ? " · ⚠️ attribution" : ""}</div>
                <div class="muted">by ${esc(c.creator || "unknown")}</div></div>
            </div>`).join("");
        } catch (e) { resBox.innerHTML = `<p style="color:var(--bad)">Search failed: ${esc(e.message)}</p>`; }
      };
    }

    const manBox = box.querySelector("#manual-cards");
    for (const p of manuals) {
      const card = document.createElement("div");
      card.className = "provider-card manual";
      card.innerHTML = `
        <div class="pc-head"><h3>${esc(p.icon)} ${esc(p.name)}</h3>
          <span class="chip">${esc(typeBadges(p))}</span>
          <span class="chip warn">Manual / Future</span></div>
        <div class="pc-note">${esc(p.status_note)}</div>
        <div class="pc-grid">
          <div><label class="muted">License</label>
            <div><a href="${esc(p.license_url)}" target="_blank" style="color:var(--acc)">${esc(p.license_name)} ↗</a>
            ${p.attribution_required ? " · ⚠️ attribution required" : ""}</div></div>
          ${p.commercial_use ? `<div><label class="muted">Commercial use</label><div>${esc(p.commercial_use)}</div></div>` : ""}
          <div class="full"><a href="${esc(p.docs_url)}" target="_blank" style="color:var(--acc)">Official site / terms ↗</a></div>
        </div>`;
      manBox.appendChild(card);
    }
  } catch (e) { box.innerHTML = `<p style="color:var(--bad)">${esc(e.message)}</p>`; }
}

// ---------------- DEBUG ----------------
async function openDebug() {
  const root = document.getElementById("modal-root");
  root.innerHTML = `<div class="modal"><div class="modal-box">
    <h2>🐞 Debug / developer</h2>
    <div id="dbg-body"><p class="muted">Loading metrics…</p></div>
    <div class="modal-foot"><button class="btn primary" id="dbg-close">Close</button></div>
  </div></div>`;
  root.querySelector("#dbg-close").onclick = () => root.innerHTML = "";
  try {
    const r = await get("/api/metrics");
    const evs = r.events.slice(-120).reverse();
    const counts = {};
    evs.forEach(e => counts[e.event] = (counts[e.event] || 0) + 1);
    const m = S.project?.metrics || {};
    root.querySelector("#dbg-body").innerHTML = `
      <h4 class="sec">This project</h4>
      <div class="kv"><span>Auto-edit time</span><b>${((m.autoEditMs || 0) / 1000).toFixed(1)}s</b></div>
      <div class="kv"><span>API calls</span><b>${m.apiCalls || 0}</b></div>
      <div class="kv"><span>Searches</span><b>${m.searches || 0}</b></div>
      <div class="kv"><span>Cache hits</span><b>${m.cacheHits || 0} (${m.searches ? Math.round(100 * m.cacheHits / m.searches) : 0}%)</b></div>
      <div class="kv"><span>Failed requests</span><b>${m.failed || 0}</b></div>
      <div class="kv"><span>B-roll download time</span><b>${((m.searchesMs || 0) / 1000).toFixed(1)}s</b></div>
      <h4 class="sec">Recent events</h4>
      <div class="debug-box">${esc(evs.map(e =>
        `${new Date(e.ts * 1000).toLocaleTimeString()} ${e.event} ${JSON.stringify({ ...e, ts: undefined, event: undefined })}`
      ).join("\n"))}</div>`;
  } catch (e) { root.querySelector("#dbg-body").innerHTML = `<p style="color:var(--bad)">${esc(e.message)}</p>`; }
}
