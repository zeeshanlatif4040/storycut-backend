// Startup screen + multi-step project wizard.
import { uploadFiles, toast, esc, post, get } from "./api.js";
import { S, newProject } from "./store.js";
import { runAutoEdit } from "./pipeline.js";

const STEPS = ["Script", "Voice-over", "Media", "Format & Sources", "Review"];
let wiz = null;

export function initStartup() {
  document.getElementById("mode-broll").onclick = () => openWizard("broll");
  document.getElementById("mode-user").onclick = () => openWizard("user");
  document.getElementById("mode-both").onclick = () => openWizard("both");
  document.getElementById("btn-startup-settings").onclick = () =>
    window.dispatchEvent(new CustomEvent("open-settings"));
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
          speedMode: "balanced" };
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
      setStatus("⏳ Uploading voice-over…");
      const metas = await uploadFiles(files.slice(0, 1), "voice");
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

function renderMedia(body) {
  dropZone(body, "video/*,image/*", true, async (files) => {
    if (!files.length) return;
    try {
      toast(`Uploading ${files.length} file(s)…`);
      const metas = await uploadFiles(files, "media");
      wiz.mediaFiles.push(...metas);
      renderMediaChips(body);
      toast(`${metas.length} file(s) analyzed`, "ok");
    } catch (e) { toast("Upload failed: " + e.message, "bad"); }
  }, "Videos (MP4/MOV/WebM/MKV) and images (JPG/PNG/WebP)");
  renderMediaChips(body);
}
function renderMediaChips(body) {
  const chips = body.querySelector("#dz-chips");
  if (!chips) return;
  chips.innerHTML = wiz.mediaFiles.map((f, i) => `
    <div class="file-chip">${f.kind === "video" ? "🎞" : "🖼"} ${esc(f.original)}
      ${f.duration ? `(${f.duration.toFixed(1)}s)` : ""}<button data-i="${i}">✕</button></div>`).join("");
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
      </div></div>
    <div class="wz-field"><label>Visual source mode</label>
      <div class="radio-row">${modes.map(([v, l]) =>
        `<div class="radio-pill ${wiz.sourceMode === v ? "sel" : ""}" data-sm="${v}">${l}</div>`).join("")}</div></div>
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
    <div class="kv"><span>Format</span><b>${wiz.format}</b></div>
    <div class="kv"><span>Source mode</span><b>${esc(wiz.sourceMode)}</b></div>
    <div class="kv"><span>Processing</span><b>${esc(wiz.speedMode)}</b></div>
    <p class="muted" style="font-size:12.5px">The AI will analyze the full script, map it to your voice-over's real timing,
    find/select visuals, trim and sync them, then build subtitles, text animations and a complete editable timeline.</p>`;
}

async function startEdit() {
  const cfg = { ...wiz };
  closeWizard();
  document.getElementById("startup").classList.add("hidden");
  document.getElementById("app").classList.remove("hidden");
  window.dispatchEvent(new CustomEvent("project-opened"));
  try {
    await runAutoEdit(cfg);
  } catch (e) {
    toast("Automatic edit failed: " + e.message, "bad");
  }
}
