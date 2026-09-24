// Editing controls UI: scene locking, source/creative/style selectors,
// quality-check panel with working fixes, and the completion report modal.
// Self-contained: injects its own button + drawer into the existing DOM
// (index.html is never modified). All actions hit the real backend API.
import { get, post, toast, esc, fmtTime } from "./api.js";
import { S, mutate, markDirty, scheduleAutosave } from "./store.js";
import { renderTimeline } from "./timeline.js";

const CONF_NUM = { high: 0.85, medium: 0.55, low: 0.25 };

let MODES = null;      // GET /api/editing/modes
let PROFILES = null;   // GET /api/editing/profiles
let drawerOpen = false;
let lastFindings = [];

/* ------------------------------------------------------------ payload */
function projectId() {
  return (S.project && S.project.id) || "default";
}

/** Build the QC/report payload from the REAL current project state:
 *  plan segments joined with timeline clips and asset metadata. */
function qcPayload() {
  const P = S.project || {};
  const segs = (P.plan && P.plan.segments) || [];
  const clips = (P.timeline && P.timeline.clips) || [];
  const assets = P.assets || {};
  const bySeg = {};
  for (const c of clips) bySeg[c.segmentId] = c;
  const segments = segs.map((s) => {
    const c = bySeg[s.id] || null;
    const a = (c && c.assetId && assets[c.assetId]) || null;
    return {
      index: s.index ?? 0,
      start: s.start ?? 0,
      end: s.end ?? 0,
      text: s.text || "",
      confidence: c ? (CONF_NUM[c.confidence] ?? 0.5) : 0.1,
      origin: !c ? "broll" : (c.sourceType === "broll" ? "broll" : "user"),
      media_type: (a && a.kind) || "video",
      file: (a && a.name) || (c && c.assetId) || null,
      width: (a && a.width) || 0,
      height: (a && a.height) || 0,
      transition: (c && c.transitionIn && c.transitionIn.type) || null,
    };
  });
  return {
    id: projectId(),
    format: P.format || "16:9",
    duration: (P.timeline && P.timeline.duration) || P.voiceDuration || 0,
    segments,
    subtitles: ((P.timeline && P.timeline.subtitles) || [])
      .map((t) => ({ start: t.start, end: t.end, text: t.text || "" })),
    overlays: ((P.timeline && P.timeline.overlays) || [])
      .map((o) => ({ start: o.start, end: o.end, text: o.text || "",
                     kind: o.kind || "name" })),
    silences: [],
    transitions: clips
      .filter((c) => c.transitionIn && c.transitionIn.type && c.transitionIn.type !== "cut")
      .map((c) => ({ at: c.start, style: c.transitionIn.type })),
    editing: P.editing || {},
  };
}

function editingState() {
  const P = S.project;
  if (!P) return null;
  P.editing = P.editing || {};
  return P.editing;
}

/* ----------------------------------------------------------------- DOM */
const CSS = `
#editing-drawer{position:fixed;top:0;right:0;bottom:0;width:360px;max-width:92vw;
 background:var(--panel,#14171c);border-left:1px solid var(--line,#2a2f36);
 z-index:60;display:flex;flex-direction:column;box-shadow:-12px 0 32px rgba(0,0,0,.45)}
#editing-drawer.hidden{display:none}
.ed-head{display:flex;align-items:center;gap:8px;padding:12px 14px;border-bottom:1px solid var(--line,#2a2f36)}
.ed-head h3{margin:0;font-size:15px;flex:1}
.ed-body{overflow-y:auto;padding:12px 14px;display:flex;flex-direction:column;gap:16px}
.ed-sec h4{margin:0 0 8px;font-size:12px;text-transform:uppercase;letter-spacing:.06em;opacity:.7}
.ed-row{display:flex;align-items:center;gap:8px;margin-bottom:6px}
.ed-row label{flex:1;font-size:13px}
.ed-row select{background:var(--bg,#0d0f12);color:inherit;border:1px solid var(--line,#2a2f36);
 border-radius:6px;padding:5px 8px;font-size:13px;max-width:170px}
.ed-scene{display:flex;align-items:center;gap:8px;padding:6px 8px;border:1px solid var(--line,#2a2f36);
 border-radius:8px;margin-bottom:6px;font-size:13px}
.ed-scene .t{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.ed-lock{cursor:pointer;border:1px solid var(--line,#2a2f36);background:transparent;border-radius:6px;
 padding:3px 8px;font-size:13px;color:inherit}
.ed-lock.on{background:#3a2b12;border-color:#a97b1f;color:#ffd97a}
.ed-find{border:1px solid var(--line,#2a2f36);border-left-width:4px;border-radius:8px;
 padding:8px 10px;margin-bottom:8px;font-size:13px}
.ed-find.error{border-left-color:#e5484d}.ed-find.warning{border-left-color:#f5a524}.ed-find.info{border-left-color:#3e8ef7}
.ed-find .sev{font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.05em}
.ed-find.error .sev{color:#e5484d}.ed-find.warning .sev{color:#f5a524}.ed-find.info .sev{color:#3e8ef7}
.ed-find .hint{opacity:.75;font-size:12px;margin-top:4px}
.ed-find .btn{margin-top:6px}
.ed-empty{opacity:.6;font-size:13px}
#ed-report-modal{position:fixed;inset:0;z-index:70;display:flex;align-items:center;justify-content:center;
 background:rgba(0,0,0,.6)}
#ed-report-modal.hidden{display:none}
.ed-modal{background:var(--panel,#14171c);border:1px solid var(--line,#2a2f36);border-radius:12px;
 padding:20px;width:480px;max-width:94vw;max-height:86vh;overflow-y:auto}
.ed-grid{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin:12px 0}
.ed-stat{border:1px solid var(--line,#2a2f36);border-radius:8px;padding:8px 10px}
.ed-stat b{font-size:18px;display:block}
.ed-stat span{font-size:12px;opacity:.7}
.ed-low{font-size:13px;border-top:1px dashed var(--line,#2a2f36);padding:6px 0}
.ed-actions{display:flex;gap:8px;margin-top:14px;flex-wrap:wrap}
`;

function ensureCss() {
  if (document.getElementById("ed-css")) return;
  const st = document.createElement("style");
  st.id = "ed-css";
  st.textContent = CSS;
  document.head.appendChild(st);
}

function ensureDrawer() {
  ensureCss();
  if (document.getElementById("editing-drawer")) return;
  const d = document.createElement("aside");
  d.id = "editing-drawer";
  d.className = "hidden";
  d.innerHTML = `
    <div class="ed-head"><h3>✂️ Editing controls</h3>
      <button class="icon-btn" id="ed-close" title="Close">✕</button></div>
    <div class="ed-body">
      <div class="ed-sec"><h4>Source, creativity &amp; style</h4>
        <div class="ed-row"><label>Footage source mode</label><select id="ed-source-mode"></select></div>
        <div class="ed-row"><label>Creative mode</label><select id="ed-creative-mode"></select></div>
        <div class="ed-row"><label>Style profile</label><select id="ed-profile"></select></div>
        <div class="ed-row"><span id="ed-profile-desc" class="ed-empty"></span></div>
        <button class="btn sm" id="ed-apply">Apply to current plan</button>
        <div id="ed-apply-msg" class="ed-empty"></div>
      </div>
      <div class="ed-sec"><h4>Scene locks</h4><div id="ed-scenes"></div></div>
      <div class="ed-sec"><h4>Quality check</h4>
        <button class="btn sm" id="ed-qc">Run quality check</button>
        <div id="ed-qc-out" style="margin-top:8px"></div></div>
      <div class="ed-sec"><h4>Completion</h4>
        <button class="btn sm primary" id="ed-report">Build completion report</button></div>
    </div>`;
  document.getElementById("app").appendChild(d);
  d.querySelector("#ed-close").onclick = () => toggleDrawer(false);
  d.querySelector("#ed-qc").onclick = runQC;
  d.querySelector("#ed-report").onclick = openReport;
  d.querySelector("#ed-apply").onclick = applySettings;
  d.querySelector("#ed-source-mode").onchange = onSelectorChange;
  d.querySelector("#ed-creative-mode").onchange = onSelectorChange;
  d.querySelector("#ed-profile").onchange = onSelectorChange;
}

function toggleDrawer(force) {
  ensureDrawer();
  drawerOpen = force !== undefined ? force : !drawerOpen;
  document.getElementById("editing-drawer").classList.toggle("hidden", !drawerOpen);
  if (drawerOpen) refresh();
}

/* ------------------------------------------------------------- selectors */
function optionTitles() {
  return {
    source: (MODES && MODES.source_mode_info) || {},
    creative: (MODES && MODES.creative_mode_info) || {},
    profile: (PROFILES && PROFILES.info) || {},
  };
}

function fillSelectors() {
  const t = optionTitles();
  const sm = document.getElementById("ed-source-mode");
  const cm = document.getElementById("ed-creative-mode");
  const pf = document.getElementById("ed-profile");
  sm.innerHTML = (MODES.source_modes || []).map((m) =>
    `<option value="${m}" title="${esc(t.source[m] || "")}">${m}</option>`).join("");
  cm.innerHTML = Object.keys(MODES.creative_modes || {}).map((m) =>
    `<option value="${m}" title="${esc(t.creative[m] || "")}">${m}</option>`).join("");
  pf.innerHTML = Object.keys(PROFILES.profiles || {}).map((m) =>
    `<option value="${m}" title="${esc(t.profile[m] || "")}">${m}</option>`).join("");
  const ed = editingState() || {};
  // map stored lowercase sourceMode (wizard) to uppercase selector values
  const cur = {
    source: (ed.source_mode || (S.project && S.project.sourceMode) || "balanced").toUpperCase(),
    creative: ed.creative_mode || "BALANCED",
    profile: ed.profile || "DOCUMENTARY",
  };
  if ([...sm.options].some((o) => o.value === cur.source)) sm.value = cur.source;
  if ([...cm.options].some((o) => o.value === cur.creative)) cm.value = cur.creative;
  if ([...pf.options].some((o) => o.value === cur.profile)) pf.value = cur.profile;
  updateProfileDesc();
}

function updateProfileDesc() {
  const pf = document.getElementById("ed-profile");
  const el = document.getElementById("ed-profile-desc");
  const info = (PROFILES && PROFILES.info) || {};
  const params = (PROFILES && PROFILES.profiles && PROFILES.profiles[pf.value]) || null;
  el.textContent = (info[pf.value] || "") +
    (params ? ` (pace ${params.pacing_target}s/scene · music ${Math.round(params.music_energy * 100)}% · ${params.text_style} · ${params.transition_bias})` : "");
}

function onSelectorChange() {
  const ed = editingState();
  if (!ed) return;
  ed.source_mode = document.getElementById("ed-source-mode").value;
  ed.creative_mode = document.getElementById("ed-creative-mode").value;
  ed.profile = document.getElementById("ed-profile").value;
  updateProfileDesc();
  markDirty(); scheduleAutosave();   // persisted with the project
  toast("Editing settings saved with the project");
}

async function applySettings() {
  const msg = document.getElementById("ed-apply-msg");
  const P = S.project;
  if (!P || !(P.plan && P.plan.segments)) { toast("Run Automatic Editing first"); return; }
  const ed = editingState();
  msg.textContent = "Applying…";
  try {
    const r = await post("/api/editing/apply", {
      project: qcPayload(),
      creative_mode: ed.creative_mode || "BALANCED",
      profile: ed.profile || "DOCUMENTARY",
    });
    const qp = r.project || {};
    // Merge trimmed overlays back: match by (start|end|text).
    const keep = new Set((qp.overlays || []).map((o) => `${o.start}|${o.end}|${o.text}`));
    const before = P.timeline.overlays.length;
    mutate("Apply style profile", () => {
      P.timeline.overlays = P.timeline.overlays
        .filter((o) => keep.has(`${o.start}|${o.end}|${o.text}`));
      // Stamp default transitions onto clips still on hard cuts.
      const byIdx = {};
      for (const s of (qp.segments || [])) byIdx[s.index] = s.transition;
      const segIdx = {};
      for (const s of (P.plan.segments || [])) segIdx[s.id] = s.index;
      for (const c of P.timeline.clips) {
        const idx = segIdx[c.segmentId];
        const tr = byIdx[idx];
        if (tr && c.transitionIn && c.transitionIn.type === "cut") {
          c.transitionIn = { type: tr, duration: tr === "cut" ? 0 : 0.6 };
        }
      }
      P.editing = { ...ed, applied: (qp.editing || {}).applied || null };
    });
    renderTimeline();
    markDirty(); scheduleAutosave();
    const ch = r.changes || {};
    msg.textContent = `Applied: ${ch.overlays_removed || 0} overlay(s) trimmed, ` +
      `${ch.transitions_stamped || 0} transition(s) set to ${ed.profile} style.`;
    toast("Style profile applied to the plan");
  } catch (e) {
    msg.textContent = "";
    toast("Apply failed: " + e.message, "err");
  }
}

/* ---------------------------------------------------------------- locks */
function currentLocks() {
  const ed = editingState() || {};
  return ed.locks || {};
}

function renderScenes() {
  const box = document.getElementById("ed-scenes");
  const P = S.project;
  const segs = (P && P.plan && P.plan.segments) || [];
  if (!segs.length) {
    box.innerHTML = `<div class="ed-empty">No scenes yet — run Automatic Editing first.</div>`;
    return;
  }
  const locks = currentLocks();
  const clips = (P.timeline && P.timeline.clips) || [];
  const bySeg = {};
  for (const c of clips) bySeg[c.segmentId] = c;
  box.innerHTML = "";
  for (const s of segs) {
    const c = bySeg[s.id];
    const locked = !!locks[String(s.index)] || !!(c && c.locked);
    const row = document.createElement("div");
    row.className = "ed-scene";
    row.innerHTML = `<span class="t" title="${esc(s.text || "")}">#${s.index} · ` +
      `${esc((c && c.title) || (s.text || "").slice(0, 40))}</span>`;
    const b = document.createElement("button");
    b.className = "ed-lock" + (locked ? " on" : "");
    b.textContent = locked ? "🔒" : "🔓";
    b.title = locked ? "Unlock scene" : "Lock scene (protects it from regeneration)";
    b.onclick = () => toggleLock(s.index, s.id, !locked, b);
    row.appendChild(b);
    box.appendChild(row);
  }
}

async function toggleLock(idx, segId, locked, btn) {
  btn.disabled = true;
  try {
    const r = await post("/api/editing/lock",
      { project_id: projectId(), scene_idx: idx, locked });
    const ed = editingState();
    ed.locks = r.locks || {};
    // Real protection: the pipeline refuses to regenerate locked clips.
    mutate(locked ? "Lock scene" : "Unlock scene", () => {
      const P = S.project;
      const clip = (P.timeline.clips || []).find((c) => c.segmentId === segId);
      if (clip) clip.locked = locked;
    });
    markDirty(); scheduleAutosave();
    btn.classList.toggle("on", locked);
    btn.textContent = locked ? "🔒" : "🔓";
    toast(locked ? `Scene ${idx} locked` : `Scene ${idx} unlocked`);
  } catch (e) {
    toast("Lock failed: " + e.message, "err");
  } finally {
    btn.disabled = false;
  }
}

/* ------------------------------------------------------------------- QC */
async function runQC() {
  const out = document.getElementById("ed-qc-out");
  if (!S.project || !(S.project.plan && S.project.plan.segments)) {
    out.innerHTML = `<div class="ed-empty">No scenes yet — run Automatic Editing first.</div>`;
    return;
  }
  out.innerHTML = `<div class="ed-empty">Checking…</div>`;
  try {
    const r = await post("/api/editing/qc", { project: qcPayload() });
    lastFindings = r.findings || [];
    renderFindings(out, lastFindings, r.counts || {});
  } catch (e) {
    out.innerHTML = `<div class="ed-empty">QC failed: ${esc(e.message)}</div>`;
  }
}

function renderFindings(out, findings, counts) {
  if (!findings.length) {
    out.innerHTML = `<div class="ed-empty">✅ No issues found — project is clean.</div>`;
    return;
  }
  out.innerHTML = `<div class="ed-empty" style="margin-bottom:8px">` +
    `${counts.error || 0} error(s) · ${counts.warning || 0} warning(s) · ${counts.info || 0} info</div>`;
  for (const f of findings) {
    const d = document.createElement("div");
    d.className = `ed-find ${f.severity}`;
    d.innerHTML = `<div class="sev">${esc(f.severity)}</div>` +
      `<div>${esc(f.message)}</div>` +
      (f.fix_hint ? `<div class="hint">💡 ${esc(f.fix_hint)}</div>` : "");
    if (f.fixable) {
      const b = document.createElement("button");
      b.className = "btn sm";
      b.textContent = "Fix automatically";
      b.onclick = () => fixFinding(f.id, b);
      d.appendChild(b);
    }
    out.appendChild(d);
  }
}

async function fixFinding(findingId, btn) {
  btn.disabled = true;
  btn.textContent = "Fixing…";
  try {
    const r = await post("/api/editing/fix",
      { project: qcPayload(), finding_id: findingId });
    if (!r.ok) throw new Error(r.message || "fix failed");
    mergeFixedProject(r.project || {});
    renderTimeline();
    markDirty(); scheduleAutosave();
    toast("Fixed: " + (r.message || "done"));
    runQC();   // refresh the findings list from real state
  } catch (e) {
    toast("Fix failed: " + e.message, "err");
    btn.disabled = false;
    btn.textContent = "Fix automatically";
  }
}

/** Merge an auto-fixed QC project back into the live timeline. Only fields
 *  the fixer touches are copied (subtitles timing, segment file swaps). */
function mergeFixedProject(qp) {
  const P = S.project;
  if (!P) return;
  mutate("Auto-fix QC issue", () => {
    if (qp.subtitles && P.timeline.subtitles.length === qp.subtitles.length) {
      qp.subtitles.forEach((s, i) => {
        P.timeline.subtitles[i].start = s.start;
        P.timeline.subtitles[i].end = s.end;
      });
    }
    for (const s of (qp.segments || [])) {
      const planSeg = (P.plan.segments || []).find((x) => x.index === s.index);
      if (!planSeg) continue;
      const clip = (P.timeline.clips || []).find((c) => c.segmentId === planSeg.id);
      if (clip && s.file && clip.assetId) {
        const base = String(s.file).split("/").pop();
        const match = Object.keys(P.assets || {})
          .find((k) => k === s.file || k.endsWith(base));
        if (match && match !== clip.assetId) clip.assetId = match;
      }
    }
  });
}

/* ---------------------------------------------------------------- report */
async function openReport() {
  if (!S.project || !(S.project.plan && S.project.plan.segments)) {
    toast("Run Automatic Editing first");
    return;
  }
  let rep;
  try {
    const r = await post("/api/editing/report", { project: qcPayload() });
    rep = r.report;
  } catch (e) {
    toast("Report failed: " + e.message, "err");
    return;
  }
  closeModal();
  const m = document.createElement("div");
  m.id = "ed-report-modal";
  const stats = [
    ["Duration", fmtTime(rep.duration)],
    ["Clips", rep.clip_count],
    ["B-roll clips", rep.broll_count],
    ["Your footage", rep.user_clips],
    ["Images", rep.images],
    ["Subtitles", rep.subtitles],
    ["Text overlays", rep.overlays],
    ["Transitions", rep.transitions],
    ["Format", rep.format],
    ["Style profile", rep.profile || "—"],
  ];
  m.innerHTML = `<div class="ed-modal">
    <h3 style="margin:0 0 4px">📋 Completion report</h3>
    <div class="ed-empty">Built from the live project data — no estimates.</div>
    <div class="ed-grid">${stats.map(([k, v]) =>
      `<div class="ed-stat"><b>${esc(String(v))}</b><span>${esc(k)}</span></div>`).join("")}
    </div>
    <h4 style="margin:8px 0">Low-confidence scenes (${rep.low_confidence.length})</h4>
    <div>${rep.low_confidence.length ? rep.low_confidence.map((l) =>
      `<div class="ed-low">🎬 Scene ${l.scene_idx} · ${(l.confidence * 100).toFixed(0)}% · ` +
      `${esc(l.file || "")}<br><span class="ed-empty">${esc(l.text || "")}</span></div>`).join("")
      : `<div class="ed-empty">None — every scene is confident.</div>`}</div>
    <div class="ed-actions">
      <button class="btn sm" id="edr-review">⚠ Review low-confidence</button>
      <button class="btn sm primary" id="edr-export">⤓ Export</button>
      <button class="btn sm" id="edr-close">Close</button>
    </div></div>`;
  document.body.appendChild(m);
  m.querySelector("#edr-close").onclick = closeModal;
  m.onclick = (e) => { if (e.target === m) closeModal(); };
  m.querySelector("#edr-review").onclick = () => {
    closeModal();
    window.dispatchEvent(new CustomEvent("open-review"));  // real review queue
  };
  m.querySelector("#edr-export").onclick = () => {
    const clips = (S.project.timeline && S.project.timeline.clips) || [];
    if (!clips.length) {
      toast("Nothing to export yet — run Automatic Editing first");
      return;
    }
    closeModal();
    // Same trigger as the real Export button (exporter.js listens for it).
    window.dispatchEvent(new CustomEvent("open-export"));
  };
}

function closeModal() {
  const m = document.getElementById("ed-report-modal");
  if (m) m.remove();
}

/* ------------------------------------------------------------------ init */
function refresh() {
  if (!document.getElementById("editing-drawer")) return;
  fillSelectors();
  renderScenes();
}

async function init() {
  if (window.EditingUI && window.EditingUI._ready) return;
  try {
    const [m, p] = await Promise.all([get("/api/editing/modes"), get("/api/editing/profiles")]);
    MODES = m; PROFILES = p;
  } catch (e) {
    // Backend unreachable: drawer still opens but explains honestly.
    MODES = { source_modes: [], creative_modes: {}, source_mode_info: {}, creative_mode_info: {} };
    PROFILES = { profiles: {}, info: {} };
    console.warn("[editing] backend unreachable:", e.message);
  }
  ensureDrawer();
  // Inject the toolbar button (no index.html change).
  const bar = document.getElementById("topbar");
  if (bar && !document.getElementById("btn-editing")) {
    const b = document.createElement("button");
    b.className = "btn sm";
    b.id = "btn-editing";
    b.title = "Scene locks, style profiles & quality check";
    b.textContent = "✂️ Editing";
    const exp = document.getElementById("btn-export");
    // exp lives inside .tb-right, not directly under #topbar, so use
    // .before() (sibling insert) instead of bar.insertBefore which throws
    // when the reference node isn't a direct child.
    if (exp && exp.parentNode) exp.before(b); else bar.appendChild(b);
    b.onclick = () => toggleDrawer();
  }
  window.addEventListener("project-opened", refresh);
  window.addEventListener("project", refresh);
  window.EditingUI._ready = true;
}

window.EditingUI = {
  init, refresh, runQC, openReport,
  getSettings() {
    const ed = (S.project && S.project.editing) || {};
    return {
      sourceMode: ed.source_mode || null,
      creativeMode: ed.creative_mode || null,
      profile: ed.profile || null,
    };
  },
  _ready: false,
};

export const EditingUI = window.EditingUI;
