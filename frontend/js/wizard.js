// Startup screen + multi-step project wizard.
import { uploadFiles, toast, esc, post, get } from "./api.js";
import { S, newProject } from "./store.js";
import { runAutoEdit } from "./pipeline.js";

const STEPS = ["Script", "Voice-over", "Media", "Format & Sources", "Review"];
let wiz = null;
// Assets imported from Settings while no wizard is open wait here instead
// of being silently dropped; openWizard() merges them into the new project.
const pendingImports = [];

export function initStartup() {
  document.getElementById("mode-broll").onclick = () => openWizard("broll");
  document.getElementById("mode-user").onclick = () => openWizard("user");
  document.getElementById("mode-both").onclick = () => openWizard("both");
  document.getElementById("btn-startup-settings").onclick = () =>
    window.dispatchEvent(new CustomEvent("open-settings"));
  // Assets imported from manual providers via Settings join the wizard's
  // media list like any uploaded file (deduplicated by server name).
  // If no wizard is open yet, they wait in pendingImports so nothing is lost.
  window.addEventListener("media-imported", (e) => {
    const a = e.detail;
    if (!a) return;
    if (!wiz) {
      if (!pendingImports.some(m => m.name === a.name)) pendingImports.push(a);
      toast("File saved — it will appear in your media when you start a project.", "ok");
      return;
    }
    if (!wiz.mediaFiles.some(m => m.name === a.name)) wiz.mediaFiles.push(a);
    const body = document.querySelector("#wizard-body");
    if (body) renderMediaChips(body);
  });
  document.getElementById("btn-open-project").onclick = toggleProjectList;
  document.getElementById("wizard-close").onclick = closeWizard;
  document.getElementById("wizard-back").onclick = () => navStep(-1);
  document.getElementById("wizard-next").onclick = () => navStep(1);
}

async function toggleProjectList() {
  const box = document.getElementById("project-list");
  if (!box.classList.contains("hidden")) { box.classList.add("hidden"); return; }
  try {
    const r = await get("/api/projects");
    if (!r.projects.length) { box.innerHTML = `<p class="muted">No saved projects yet.</p>`; }
    else box.innerHTML = r.projects.map(p => `
      <div class="project-item">
        <div><b>${esc(p.name || "Untitled")}</b>
          <div class="meta">${esc(p.format || "")} · ${p.clipCount || 0} clips ·
          ${p.updatedAt ? new Date(p.updatedAt).toLocaleString() : ""}</div></div>
        <div style="display:flex;gap:6px">
          <button class="btn sm" data-open="${p.id}">Open</button>
          <button class="btn sm" data-del="${p.id}">Delete</button>
        </div>
      </div>`).join("");
    box.classList.remove("hidden");
    box.querySelectorAll("[data-open]").forEach(b => b.onclick = async () => {
      const { loadProject } = await import("./store.js");
      await loadProject(b.dataset.open);
      document.getElementById("startup").classList.add("hidden");
      document.getElementById("app").classList.remove("hidden");
      window.dispatchEvent(new CustomEvent("project-opened"));
    });
    box.querySelectorAll("[data-del]").forEach(b => b.onclick = async () => {
      if (!confirm("Delete this project?")) return;
      await fetch(`/api/projects/${b.dataset.del}`, { method: "DELETE" });
      toggleProjectList(); toggleProjectList();
    });
  } catch (e) { toast("Could not list projects: " + e.message, "bad"); }
}

export function openWizard(mode) {
  newProject(mode);
  wiz = { mode, step: 0, script: "", voiceFiles: [], mediaFiles: [],
          format: "16:9", sourceMode: mode === "broll" ? "broll-first" : mode === "user" ? "user-first" : "balanced",
          speedMode: "balanced", mediaPref: "auto", targetH: 720,
          retryFailed: true, slateFallback: true };
  // Merge any files imported from Settings before the wizard was opened.
  for (const a of pendingImports) {
    if (!wiz.mediaFiles.some(m => m.name === a.name)) wiz.mediaFiles.push(a);
  }
  if (pendingImports.length) {
    toast(`${pendingImports.length} imported file(s) added to your media`, "ok");
    pendingImports.length = 0;
  }
  document.getElementById("wizard-title").textContent =
    mode === "broll" ? "B-Roll Footage Finder" : mode === "user" ? "Auto Edit My Footage" : "B-Roll + My Footage";
  document.getElementById("wizard").classList.remove("hidden");
  renderStep();
}

export function closeWizard() {
  document.getElementById("wizard").classList.add("hidden");
  wiz = null;
}

function navStep(d) {
  if (!wiz) return;
  if (d > 0 && !validateStep()) return;
  const n = wiz.step + d;
  if (n < 0) return;
  if (n >= STEPS.length) { startEdit(); return; }
  wiz.step = n;
  renderStep();
}

function validateStep() {
  if (wiz.step === 0) {
    const words = wiz.script.trim().split(/\s+/).filter(Boolean).length;
    if (!wiz.script.trim()) { toast("Please paste or type your script.", "bad"); return false; }
    if (words > 10000) { toast("Script exceeds 10,000 words.", "bad"); return false; }
  }
  if (wiz.step === 1 && !wiz.voiceFiles.length) {
    toast("A voice-over file is required — it drives all timing.", "bad"); return false;
  }
  if (wiz.mode === "user" && wiz.step === 2 && !wiz.mediaFiles.length) {
    toast("Upload at least one video or image for this mode.", "bad"); return false;
  }
  return true;
}

function renderStep() {
  const dots = document.getElementById("wizard-steps");
  dots.innerHTML = STEPS.map((s, i) =>
    `<span class="${i < wiz.step ? "done" : i === wiz.step ? "cur" : ""}" title="${s}"></span>`).join("");
  const body = document.getElementById("wizard-body");
  const next = document.getElementById("wizard-next");
  const back = document.getElementById("wizard-back");
  back.disabled = wiz.step === 0;
  next.textContent = wiz.step === STEPS.length - 1 ? "⚡ Start Automatic Edit" : "Next →";
  document.getElementById("wizard-hint").textContent = [
    "Up to 10,000 words. The script gives meaning; the voice-over gives timing.",
    "MP3 / WAV / M4A / AAC / OGG. Actual speech timing is analyzed, never guessed from text length.",
    wiz.mode === "broll" ? "Optional — your own videos/images become an extra visual source."
      : "Your footage library — AI picks the best moments from each file.",
    "Output shape and which visual sources the AI may use.",
    "Ready when you are.",
  ][wiz.step];
  [renderScript, renderVoice, renderMedia, renderFormat, renderReview][wiz.step](body);
}

function dropZone(body, accept, multiple, onFiles, hint) {
  body.innerHTML = `
    <div class="drop" id="dz">
      <div style="font-size:34px">📥</div>
      <div><b>Drop files here</b> or click to browse</div>
      <div class="muted" style="font-size:12px;margin-top:4px">${hint}</div>
      <input type="file" id="dz-input" accept="${accept}" ${multiple ? "multiple" : ""}>
    </div>
    <div class="file-chips" id="dz-chips"></div>`;
  const dz = body.querySelector("#dz"), input = body.querySelector("#dz-input");
  dz.onclick = () => input.click();
  ["dragover", "dragenter"].forEach(e => dz.addEventListener(e, ev => { ev.preventDefault(); dz.classList.add("over"); }));
  ["dragleave", "drop"].forEach(e => dz.addEventListener(e, ev => { ev.preventDefault(); dz.classList.remove("over"); }));
  dz.addEventListener("drop", ev => onFiles([...ev.dataTransfer.files]));
  input.onchange = () => onFiles([...input.files]);
}

function renderScript(body) {
  body.innerHTML = `
    <div class="wz-field"><label>Script</label>
      <textarea id="wz-script" placeholder="Paste your narration script here…">${esc(wiz.script)}</textarea>
      <div class="muted" style="font-size:12px;margin-top:6px"><span id="wz-wc">0</span> / 10,000 words</div>
    </div>`;
  const ta = body.querySelector("#wz-script");
  const upd = () => {
    wiz.script = ta.value;
    body.querySelector("#wz-wc").textContent =
      ta.value.trim().split(/\s+/).filter(Boolean).length;
  };
  ta.oninput = upd; upd();
}

function renderVoice(body) {
  dropZone(body, "audio/*,.mp3,.wav,.m4a,.aac,.ogg,.mp4,.webm", false, async (files) => {
    if (!files.length) return;
    const statusEl = body.querySelector("#voice-status");
    const setStatus = (t, cls) => {
      if (statusEl) { statusEl.textContent = t; statusEl.className = "voice-status " + (cls || ""); }
    };
    try {
      setStatus("⏳ Uploading voice-over… 0%");
      const up = uploadFiles(files.slice(0, 1), "voice", (frac) => {
        setStatus(`⏳ Uploading voice-over… ${Math.round(frac * 100)}%`);
      });
      const metas = await up;
      setStatus("⚙️ Processing audio…");
      // The backend validated the real audio content; double-check timing here.
      const m = metas[0];
      if (!m || !(m.duration > 0))
        throw new Error("the server could not detect any audio duration");
      wiz.voiceFiles = metas; // script + other state in `wiz` is preserved
      renderVoiceChips(body);
      setStatus(`✅ Audio ready — ${m.duration.toFixed(1)}s of real voice timing`, "ok");
      toast("Audio ready ✓ — timing will follow your voice-over", "ok");
    } catch (e) {
      // Never wedge the wizard: the script, media and settings are kept,
      // the drop zone stays active, and the user can simply retry.
      setStatus("", "");
      toast("Audio upload failed — " + e.message + ". Please try again.", "bad");
    }
  }, "MP3, WAV, M4A, AAC, OGG, MP4 audio, WebM audio — one file");
  const wrap = document.createElement("div");
  wrap.innerHTML = `<div id="voice-status" class="voice-status" style="margin-top:8px;font-size:13px"></div>`;
  body.appendChild(wrap);
  wiz._voiceWrap = wrap;
  renderVoiceChips(body);
}
function renderVoiceChips(body) {
  const chips = body.querySelector("#dz-chips");
  if (chips) chips.innerHTML = wiz.voiceFiles.map((f, i) => `
    <div class="file-chip">🎙 ${esc(f.original)} (${f.duration.toFixed(1)}s)
      <button data-i="${i}">✕</button></div>`).join("");
  chips?.querySelectorAll("button").forEach(b => b.onclick = (e) => {
    e.stopPropagation(); wiz.voiceFiles.splice(+b.dataset.i, 1); renderVoiceChips(body);
  });
}

function fmtMB(b) {
  if (!b && b !== 0) return "";
  return b >= 1048576 ? (b / 1048576).toFixed(1) + " MB" : Math.max(1, Math.round(b / 1024)) + " KB";
}

function renderMedia(body) {
  dropZone(body, "video/*,image/*", true, async (files) => {
    if (!files.length) return;
    // Persistent status bar: unlike the toast, this stays on screen for the
    // whole upload so a slow video upload never "disappears".
    let bar = body.querySelector("#media-up-status");
    if (!bar) {
      bar = document.createElement("div");
      bar.id = "media-up-status";
      body.appendChild(bar);
    }
    const names = files.map(f => f.name).join(", ");
    bar.innerHTML = `
      <div class="up-status">
        <div class="up-row"><span class="up-label">⏳ Uploading: ${esc(names)}</span>
          <button class="btn sm" id="up-cancel">Cancel</button></div>
        <div class="up-track"><div class="up-fill" style="width:0%"></div></div>
        <div class="up-meta muted">0%</div>
      </div>`;
    const fill = bar.querySelector(".up-fill");
    const meta = bar.querySelector(".up-meta");
    const label = bar.querySelector(".up-label");
    let done = false;
    const up = uploadFiles(files, "media", (frac, loaded, total) => {
      const pct = Math.round(frac * 100);
      fill.style.width = pct + "%";
      meta.textContent = `${pct}% — ${fmtMB(loaded)} of ${fmtMB(total)}`;
      // Bytes are all sent at 100% but the server still has to respond —
      // say so explicitly instead of looking stuck on "Uploading".
      if (frac >= 0.999) label.textContent = "⏳ Upload complete — processing on server…";
    });
    bar.querySelector("#up-cancel").onclick = () => up.cancel();
    try {
      const metas = await up;
      done = true;
      wiz.mediaFiles.push(...metas);
      renderMediaChips(body);
      label.textContent = `✅ ${metas.length} file(s) uploaded & analyzed`;
      fill.style.width = "100%";
      meta.textContent = "";
      bar.querySelector("#up-cancel").remove();
      toast(`${metas.length} file(s) analyzed`, "ok");
      setTimeout(() => { if (done) bar.innerHTML = ""; }, 4000);
      // Scene-moment detection runs on the server in the background for
      // videos (it needs a full decode). Poll until the moments land so the
      // "AI picks the best moments" step has real data; export also
      // lazy-fetches them if the user moves on faster than the analysis.
      for (const m of metas) {
        if (m.kind === "video" && m.scenesPending) pollScenes(m, body);
      }
    } catch (e) {
      label.textContent = `❌ Upload failed — ${e.message}`;
      meta.innerHTML = `<button class="btn sm primary" id="up-retry">Retry</button>
        <span class="muted"> — tip: large videos upload faster on Wi-Fi; keep clips under ~200 MB on mobile data.</span>`;
      bar.querySelector("#up-cancel").remove();
      const rb = bar.querySelector("#up-retry");
      if (rb) rb.onclick = () => { bar.innerHTML = ""; body.querySelector("#dz-input").click(); };
    }
  }, "Videos (MP4/MOV/WebM/MKV) and images (JPG/PNG/WebP)");
  renderMediaChips(body);
}
/** Poll /api/media/scenes until background scene detection finishes for an
 *  uploaded video, then refresh its chip. Non-blocking: the user can click
 *  Next at any time — export lazy-fetches missing moments itself. */
async function pollScenes(m, body) {
  for (let i = 0; i < 60; i++) {           // up to ~5 minutes
    await new Promise(r => setTimeout(r, 5000));
    if (!wiz.mediaFiles.includes(m)) return;   // user removed the file
    if (m.scenes && m.scenes.length) return;   // already filled
    try {
      const r = await get(`/api/media/scenes?name=${encodeURIComponent(m.name)}`);
      if (r.scenes && r.scenes.length) {
        m.scenes = r.scenes;
        m.scenesPending = false;
        renderMediaChips(body);
        return;
      }
      if (!r.pending) { m.scenesPending = false; return; }
    } catch { return; }   // server unreachable — export will retry lazily
  }
  m.scenesPending = false;
}
function renderMediaChips(body) {
  const chips = body.querySelector("#dz-chips");
  if (!chips) return;
  chips.innerHTML = wiz.mediaFiles.map((f, i) => `
    <div class="file-chip">${f.kind === "video" ? "🎞" : "🖼"} ${esc(f.original)}
      ${f.duration ? `(${f.duration.toFixed(1)}s)` : ""}${f.kind === "video" && f.scenesPending && !(f.scenes && f.scenes.length) ? ` <span class="muted">· ⏳ moments…</span>` : ""}<button data-i="${i}">✕</button></div>`).join("");
  chips.querySelectorAll("button").forEach(b => b.onclick = (e) => {
    e.stopPropagation(); wiz.mediaFiles.splice(+b.dataset.i, 1); renderMediaChips(body);
  });
}

function renderFormat(body) {
  const modes = wiz.mode === "broll"
    ? [["broll-only", "B-Roll only"], ["broll-first", "B-Roll first, my media as fallback"], ["balanced", "Balanced AI selection"]]
    : wiz.mode === "user"
    ? [["user-only", "My footage only"], ["user-first", "My footage first, B-roll as fallback"], ["balanced", "Balanced AI selection"]]
    : [["broll-only", "B-Roll only"], ["user-only", "My footage only"], ["user-first", "My footage first"], ["broll-first", "B-Roll first"], ["balanced", "Balanced AI selection"]];
  body.innerHTML = `
    <div class="wz-field"><label>Output format</label>
      <div class="fmt-cards">
        <div class="fmt-card ${wiz.format === "16:9" ? "sel" : ""}" data-fmt="16:9">
          <div class="fmt-prev"></div><b>YouTube 16:9</b><div class="muted">Landscape</div></div>
        <div class="fmt-card ${wiz.format === "9:16" ? "sel" : ""}" data-fmt="9:16">
          <div class="fmt-prev vert"></div><b>YouTube Shorts 9:16</b><div class="muted">Vertical</div></div>
        <div class="fmt-card ${wiz.format === "1:1" ? "sel" : ""}" data-fmt="1:1">
          <div class="fmt-prev sq"></div><b>Square 1:1</b><div class="muted">Instagram / Facebook</div></div>
      </div></div>
    <div class="wz-field"><label>Visual source mode</label>
      <div class="radio-row">${modes.map(([v, l]) =>
        `<div class="radio-pill ${wiz.sourceMode === v ? "sel" : ""}" data-sm="${v}">${l}</div>`).join("")}</div></div>
    <div class="wz-field"><label>Footage type</label>
      <div class="radio-row">${[["auto", "✨ Auto (AI decides)"], ["video", "🎬 Videos only"], ["image", "🖼️ Images only"]].map(([v, l]) =>
        `<div class="radio-pill ${wiz.mediaPref === v ? "sel" : ""}" data-mp="${v}">${l}</div>`).join("")}</div>
      <div class="muted" style="font-size:12px;margin-top:6px">Videos only = every scene gets motion footage. Images only = fast slideshow-style edits.</div></div>
    <div class="wz-field"><label>Download quality</label>
      <div class="radio-row">${[[720, "⚡ Fast (720p)"], [1080, "🎬 Full (1080p)"]].map(([v, l]) =>
        `<div class="radio-pill ${wiz.targetH === v ? "sel" : ""}" data-th="${v}">${l}</div>`).join("")}</div>
      <div class="muted" style="font-size:12px;margin-top:6px">Fast downloads ~4x smaller files — much quicker B-roll. Full keeps maximum sharpness for 1080p+ exports.</div></div>
    <div class="wz-field"><label>If a scene finds nothing</label>
      <div style="display:flex;flex-direction:column;gap:8px;margin-top:2px">
        <label class="chk"><input type="checkbox" data-fb="retryFailed" ${wiz.retryFailed ? "checked" : ""}>
          <span>🔁 Auto-retry failed scenes <span class="muted">— regenerate with broader searches (3 attempts)</span></span></label>
        <label class="chk"><input type="checkbox" data-fb="slateFallback" ${wiz.slateFallback ? "checked" : ""}>
          <span>🪄 Generate title card <span class="muted">— designed scene card instead of leaving a gap</span></span></label>
      </div></div>
    <div class="wz-field"><label>Processing mode</label>
      <div class="radio-row">${[["fast", "⚡ Fast"], ["balanced", "⚖ Balanced"], ["quality", "💎 Quality"]].map(([v, l]) =>
        `<div class="radio-pill ${wiz.speedMode === v ? "sel" : ""}" data-pm="${v}">${l}</div>`).join("")}</div>
      <div class="muted" style="font-size:12px;margin-top:6px">Fast: fewer candidates, stronger caching. Quality: deeper matching, broader candidate comparison.</div></div>`;
  body.querySelectorAll("[data-fmt]").forEach(c => c.onclick = () => {
    wiz.format = c.dataset.fmt;
    body.querySelectorAll("[data-fmt]").forEach(x => x.classList.toggle("sel", x === c));
  });
  body.querySelectorAll("[data-sm]").forEach(c => c.onclick = () => {
    wiz.sourceMode = c.dataset.sm;
    body.querySelectorAll("[data-sm]").forEach(x => x.classList.toggle("sel", x === c));
  });
  body.querySelectorAll("[data-mp]").forEach(c => c.onclick = () => {
    wiz.mediaPref = c.dataset.mp;
    body.querySelectorAll("[data-mp]").forEach(x => x.classList.toggle("sel", x === c));
  });
  body.querySelectorAll("[data-th]").forEach(c => c.onclick = () => {
    wiz.targetH = parseInt(c.dataset.th, 10);
    body.querySelectorAll("[data-th]").forEach(x => x.classList.toggle("sel", x === c));
  });
  body.querySelectorAll("[data-fb]").forEach(c => c.onchange = () => {
    wiz[c.dataset.fb] = c.checked;
  });
  body.querySelectorAll("[data-pm]").forEach(c => c.onclick = () => {
    wiz.speedMode = c.dataset.pm;
    body.querySelectorAll("[data-pm]").forEach(x => x.classList.toggle("sel", x === c));
  });
}

function renderReview(body) {
  const words = wiz.script.trim().split(/\s+/).filter(Boolean).length;
  body.innerHTML = `
    <h4 class="sec">Project summary</h4>
    <div class="kv"><span>Mode</span><b>${esc(wiz.mode)}</b></div>
    <div class="kv"><span>Script</span><b>${words.toLocaleString()} words</b></div>
    <div class="kv"><span>Voice-over</span><b>${wiz.voiceFiles.length ? esc(wiz.voiceFiles[0].original) + ` (${wiz.voiceFiles[0].duration.toFixed(1)}s)` : "—"}</b></div>
    <div class="kv"><span>Your media</span><b>${wiz.mediaFiles.length} file(s)</b></div>
    <div class="kv"><span>Format</span><b>${wiz.format}${wiz.format === "1:1" ? " (Square)" : ""}</b></div>
    <div class="kv"><span>Source mode</span><b>${esc(wiz.sourceMode)}</b></div>
    <div class="kv"><span>Footage type</span><b>${wiz.mediaPref === "video" ? "🎬 Videos only" : wiz.mediaPref === "image" ? "🖼️ Images only" : "✨ Auto (AI decides)"}</b></div>
    <div class="kv"><span>Download quality</span><b>${wiz.targetH === 1080 ? "🎬 Full (1080p)" : "⚡ Fast (720p)"}</b></div>
    <div class="kv"><span>Auto-retry scenes</span><b>${wiz.retryFailed ? "🔁 On" : "Off"}</b></div>
    <div class="kv"><span>Title-card fallback</span><b>${wiz.slateFallback ? "🪄 On" : "Off"}</b></div>
    <div class="kv"><span>Processing</span><b>${esc(wiz.speedMode)}</b></div>
    <p class="muted" style="font-size:12.5px">The AI will analyze the full script, map it to your voice-over's real timing,
    find/select visuals, trim and sync them, then build subtitles, text animations and a complete editable timeline.</p>`;
}

async function startEdit() {
  const cfg = { ...wiz };
  closeWizard();
  document.getElementById("startup").classList.add("hidden");
  document.getElementById("app").classList.remove("hidden");
  // Apply the chosen format BEFORE project-opened so the preview canvas
  // sizes itself correctly on first paint (runAutoEdit sets it again later).
  S.project.format = cfg.format;
  window.dispatchEvent(new CustomEvent("project-opened"));
  try {
    await runAutoEdit(cfg);
  } catch (e) {
    toast("Automatic edit failed: " + e.message, "bad");
  }
}
