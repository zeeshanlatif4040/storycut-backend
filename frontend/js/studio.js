// Studio panel: lower-thirds/callouts editor, kinetic typography presets,
// audio FX (analyze/enhance via /api/audiofx/*), debug stage timings,
// performance dashboard (real /api/metrics data), and localStorage autosave.
//
// Integrates with the EXISTING overlay system — overlays use the exact
// format from analysis.py / pipeline.js / preview.js:
//   {id, segmentId, kind, text, style, start, end, trackId, size, color}
// and render through the existing drawTextOverlay (preview) and drawtext
// (export) paths. Style ids reused: lower-third, stat-pop, pop, slide,
// fade, type-on. No parallel overlay format is invented.
import { get, post, toast, fmtTime, esc, uid } from "./api.js";
import { S, tl, mutate, scheduleAutosave } from "./store.js";
import { transport } from "./timeline.js";

const LS_KEY = "storycut_projects";
const MAX_VERSIONS = 10;

// ---------------- style presets (all real in preview.js + export.py) ----------------
const STYLE_PRESETS = [
  { id: "lower-third", label: "Lower Third", style: "lower-third", size: 56, color: "#FFFFFF",
    hint: "Name/title bar, bottom-left. Renders in preview + export." },
  { id: "callout", label: "Callout Box", style: "pop", size: 64, color: "#FFFFFF",
    hint: "Centered pop-in box. Renders in preview; export falls back to fade." },
  { id: "highlight", label: "Highlight", style: "stat-pop", size: 84, color: "#FFE08A",
    hint: "Big centered stat/keyword with pop + animated counter for numbers." },
];
const KINETIC = [
  { id: "fade", label: "Fade", style: "fade" },
  { id: "slide", label: "Slide up", style: "slide" },
  { id: "type-on", label: "Typewriter", style: "type-on" },
  { id: "pop", label: "Pop", style: "pop" },
];

// ---------------- tiny DOM helpers ----------------
function el(html) {
  const t = document.createElement("template");
  t.innerHTML = html.trim();
  return t.content.firstElementChild;
}
function injectCss() {
  if (document.getElementById("studio-css")) return;
  const s = document.createElement("style");
  s.id = "studio-css";
  s.textContent = `
  #studio-dock{position:fixed;top:64px;right:12px;width:360px;max-height:calc(100vh - 90px);
    background:#14171f;border:1px solid #2a3040;border-radius:12px;z-index:9000;
    display:flex;flex-direction:column;box-shadow:0 12px 40px rgba(0,0,0,.5);
    font-size:13px;color:#e8eaf0}
  #studio-dock.hidden{display:none}
  #studio-bar{display:flex;align-items:center;gap:6px;padding:8px 10px;
    border-bottom:1px solid #2a3040;cursor:default}
  #studio-bar b{flex:1;font-size:13px}
  #studio-tabs{display:flex;gap:2px;padding:6px 8px 0;flex-wrap:wrap}
  #studio-tabs button{background:none;border:none;color:#9aa3b8;padding:6px 8px;
    cursor:pointer;border-bottom:2px solid transparent;font-size:12px}
  #studio-tabs button.on{color:#fff;border-bottom-color:#6c8cff}
  #studio-body{padding:10px;overflow-y:auto;min-height:120px}
  #studio-body input,#studio-body select{background:#0e1118;border:1px solid #2a3040;
    color:#e8eaf0;border-radius:6px;padding:5px 7px;font-size:12px;width:100%;
    box-sizing:border-box;margin:2px 0}
  #studio-body .row{display:flex;gap:6px;align-items:center;margin:4px 0}
  #studio-body .row>*{flex:1}
  .sbtn{background:#232838;border:1px solid #343c52;color:#e8eaf0;border-radius:7px;
    padding:6px 10px;cursor:pointer;font-size:12px}
  .sbtn:hover{background:#2c3448}
  .sbtn.primary{background:#3b5bff;border-color:#3b5bff;color:#fff}
  .sbtn.danger{background:#5a2230;border-color:#7a2f40}
  .sbtn:disabled{opacity:.45;cursor:default}
  .sov{border:1px solid #2a3040;border-radius:8px;padding:6px 8px;margin:6px 0;background:#10141c}
  .sov .t{font-weight:600;word-break:break-word}
  .sov .m{color:#9aa3b8;font-size:11px;margin-top:2px}
  .sov .ops{display:flex;gap:4px;margin-top:5px}
  .sov .ops .sbtn{padding:3px 8px;font-size:11px}
  .smetric{display:flex;justify-content:space-between;padding:4px 2px;border-bottom:1px dashed #232838}
  .smetric b{font-variant-numeric:tabular-nums}
  .sok{color:#5fd68a}.sbad{color:#ff7a90}.smut{color:#9aa3b8;font-size:11px}
  #studio-toggle{position:fixed;right:12px;bottom:12px;z-index:9001;
    background:#3b5bff;color:#fff;border:none;border-radius:24px;
    padding:10px 16px;cursor:pointer;font-size:13px;box-shadow:0 6px 20px rgba(0,0,0,.4)}
  .sver{border:1px solid #2a3040;border-radius:8px;padding:6px 8px;margin:6px 0;background:#10141c}
  table.stable{width:100%;border-collapse:collapse;font-size:12px}
  table.stable td,table.stable th{border-bottom:1px solid #232838;padding:4px 6px;text-align:left}
  #studio-recover{background:#3a2b12;border:1px solid #8a6a2a;border-radius:8px;
    padding:8px;margin-bottom:8px}`;
  document.head.appendChild(s);
}

// ---------------- overlay editor ----------------
function overlayRows(body) {
  const T = S.project ? tl() : null;
  const list = T ? T.overlays : [];
  const wrap = el(`<div></div>`);
  if (!S.project) { wrap.innerHTML = `<p class="smut">No project open.</p>`; return wrap; }
  wrap.appendChild(el(`<div class="smut">${list.length} overlay(s) on the gfx track.
    They render in the preview and in the export.</div>`));
  for (const o of [...list].sort((a, b) => a.start - b.start)) {
    const row = el(`<div class="sov">
      <div class="t">${esc(o.text).replace(/\n/g, "<br>")}</div>
      <div class="m">${fmtTime(o.start)} → ${fmtTime(o.end)} · style: ${esc(o.style)} ·
        size ${o.size || "—"}</div>
      <div class="ops">
        <button class="sbtn" data-act="kinetic">✨ Kinetic</button>
        <button class="sbtn" data-act="edit">✏️ Edit</button>
        <button class="sbtn danger" data-act="del">Delete</button>
      </div></div>`);
    row.querySelector('[data-act="del"]').onclick = () => {
      mutate("Delete overlay", () => {
        tl().overlays = tl().overlays.filter(x => x.id !== o.id);
      });
      window.dispatchEvent(new CustomEvent("timeline-progress"));
      renderTab(body, "overlays");
    };
    row.querySelector('[data-act="edit"]').onclick = () =>
      openOverlayEditor(body, o);
    row.querySelector('[data-act="kinetic"]').onclick = () =>
      openKineticPicker(body, o);
    wrap.appendChild(row);
  }
  // add form
  const f = el(`<div class="sov"><b>Add overlay</b>
    <input data-f="text" placeholder="Overlay text">
    <div class="row">
      <select data-f="preset">${STYLE_PRESETS.map(p =>
        `<option value="${p.id}">${esc(p.label)}</option>`).join("")}</select>
      <select data-f="kinetic">${KINETIC.map(k =>
        `<option value="${k.id}">${esc(k.label)}</option>`).join("")}</select>
    </div>
    <div class="smut" data-f="hint"></div>
    <div class="row">
      <input data-f="start" type="number" step="0.1" min="0" title="start (s)">
      <input data-f="end" type="number" step="0.1" min="0" title="end (s)">
    </div>
    <button class="sbtn primary" data-f="add" style="width:100%">＋ Add overlay</button>
  </div>`);
  const q = (n) => f.querySelector(`[data-f="${n}"]`);
  q("start").value = transport.time.toFixed(1);
  q("end").value = (transport.time + 4).toFixed(1);
  const syncHint = () => {
    const p = STYLE_PRESETS.find(p => p.id === q("preset").value);
    q("hint").textContent = p ? p.hint : "";
  };
  q("preset").onchange = syncHint; syncHint();
  q("add").onclick = () => {
    const text = q("text").value.trim();
    if (!text) { toast("Overlay text is empty", "bad"); return; }
    const preset = STYLE_PRESETS.find(p => p.id === q("preset").value);
    const kin = KINETIC.find(k => k.id === q("kinetic").value);
    const start = Math.max(0, +q("start").value || 0);
    const end = Math.max(start + 0.5, +q("end").value || start + 4);
    // kinetic choice overrides the preset's motion style, preset keeps size/color
    mutate("Add overlay", () => {
      tl().overlays.push({
        id: uid("ov"), segmentId: null, kind: "custom",
        text, style: kin.style, start, end, trackId: "gfx",
        size: preset.size, color: preset.color,
        preset: preset.id,
      });
    });
    scheduleAutosave();
    window.dispatchEvent(new CustomEvent("timeline-progress"));
    toast("Overlay added", "ok");
    renderTab(body, "overlays");
  };
  wrap.appendChild(f);
  return wrap;
}

function openOverlayEditor(body, o) {
  const box = el(`<div class="sov"><b>Edit overlay</b>
    <input data-f="text" value="${esc(o.text).replace(/"/g, "&quot;")}">
    <div class="row">
      <select data-f="style">
        ${["lower-third", "stat-pop", "pop", "slide", "fade", "type-on"].map(s =>
          `<option value="${s}" ${o.style === s ? "selected" : ""}>${s}</option>`).join("")}
      </select>
      <input data-f="size" type="number" value="${o.size || 56}" title="size">
    </div>
    <div class="row">
      <input data-f="start" type="number" step="0.1" value="${o.start}" title="start (s)">
      <input data-f="end" type="number" step="0.1" value="${o.end}" title="end (s)">
    </div>
    <div class="row">
      <button class="sbtn primary" data-f="save">Save</button>
      <button class="sbtn" data-f="cancel">Cancel</button>
    </div></div>`);
  const q = (n) => box.querySelector(`[data-f="${n}"]`);
  q("cancel").onclick = () => renderTab(body, "overlays");
  q("save").onclick = () => {
    const text = q("text").value.trim();
    if (!text) { toast("Overlay text is empty", "bad"); return; }
    mutate("Edit overlay", () => {
      const t = tl().overlays.find(x => x.id === o.id);
      if (t) {
        t.text = text; t.style = q("style").value;
        t.size = Math.max(12, +q("size").value || 56);
        t.start = Math.max(0, +q("start").value || 0);
        t.end = Math.max(t.start + 0.5, +q("end").value || t.start + 4);
      }
    });
    scheduleAutosave();
    window.dispatchEvent(new CustomEvent("timeline-progress"));
    renderTab(body, "overlays");
  };
  body.prepend(box);
  box.scrollIntoView({ block: "nearest" });
}

function openKineticPicker(body, o) {
  const box = el(`<div class="sov"><b>Kinetic typography — pick motion</b>
    <div class="smut">Applies to this overlay; rendered by the existing
    preview + export text pipeline (no new format).</div>
    <div class="row" style="flex-wrap:wrap"></div></div>`);
  const row = box.querySelector(".row");
  for (const k of KINETIC) {
    const b = el(`<button class="sbtn" style="flex:1;min-width:70px">${esc(k.label)}</button>`);
    b.onclick = () => {
      mutate("Kinetic style", () => {
        const t = tl().overlays.find(x => x.id === o.id);
        if (t) t.style = k.style;
      });
      scheduleAutosave();
      window.dispatchEvent(new CustomEvent("timeline-progress"));
      toast(`Motion: ${k.label}`, "ok");
      renderTab(body, "overlays");
    };
    row.appendChild(b);
  }
  const c = el(`<button class="sbtn" style="width:100%;margin-top:4px">Cancel</button>`);
  c.onclick = () => renderTab(body, "overlays");
  box.appendChild(c);
  body.prepend(box);
  box.scrollIntoView({ block: "nearest" });
}

// ---------------- audio FX ----------------
function audioFiles() {
  if (!S.project) return [];
  const out = Object.values(S.project.assets || {}).filter(a => a.kind === "audio");
  if (S.project.voiceName && !out.some(a => a.name === S.project.voiceName))
    out.unshift({ name: S.project.voiceName, original: S.project.voiceName + " (voice)" });
  return out;
}

function audioTab(body) {
  const wrap = el(`<div></div>`);
  if (!S.project) { wrap.innerHTML = `<p class="smut">No project open.</p>`; return wrap; }
  const files = audioFiles();
  if (!files.length) {
    wrap.innerHTML = `<p class="smut">No audio in this project yet — upload a
      voice-over first (wizard → Script → Audio).</p>`;
    return wrap;
  }
  const f = el(`<div>
    <div class="smut">Real FFmpeg analysis + enhancement. Nothing is simulated.</div>
    <select data-f="file">${files.map(a =>
      `<option value="${esc(a.name)}">${esc(a.original || a.name)}</option>`).join("")}</select>
    <div class="row" style="margin-top:6px">
      <button class="sbtn primary" data-f="analyze">🔍 Analyze</button>
    </div>
    <div data-f="aresult"></div>
    <hr style="border-color:#232838">
    <b>Enhance</b>
    <label class="smut"><input type="checkbox" data-f="norm" checked style="width:auto">
      Normalize (EBU R128 loudnorm)</label><br>
    <label class="smut"><input type="checkbox" data-f="denoise" style="width:auto">
      Denoise (afftdn, light)</label><br>
    <label class="smut"><input type="checkbox" data-f="dynamic" style="width:auto">
      Dynamic normalize (dynaudnorm)</label>
    <div class="row"><span class="smut">Target LUFS</span>
      <input data-f="lufs" type="number" value="-16" step="0.5" min="-30" max="-8"></div>
    <button class="sbtn primary" data-f="enhance" style="width:100%">✨ Enhance audio</button>
    <div data-f="eresult"></div>
  </div>`);
  const q = (n) => f.querySelector(`[data-f="${n}"]`);
  q("analyze").onclick = async () => {
    q("analyze").disabled = true;
    q("aresult").innerHTML = `<p class="smut">Analyzing…</p>`;
    try {
      const r = await post("/api/audiofx/analyze", { name: q("file").value });
      const a = r.analysis, L = a.loudness || {};
      const sil = (a.silence_ranges || []).map(s => `${s[0]}–${s[1]}s`).join(", ") || "none";
      const onsets = (r.rhythm_hints && r.rhythm_hints.onsets) || [];
      q("aresult").innerHTML = `
        <table class="stable">
          <tr><td>Duration</td><td><b>${a.duration}s</b></td></tr>
          <tr><td>Peak level</td><td><b>${a.peak_db ?? "—"} dB</b></td></tr>
          <tr><td>RMS level</td><td><b>${a.rms_db ?? "—"} dB</b></td></tr>
          <tr><td>Clipping</td><td>${a.clipping
            ? '<b class="sbad">YES — peaks hit full scale</b>'
            : '<b class="sok">no</b>'}</td></tr>
          <tr><td>Integrated loudness</td><td><b>${L.integrated_lufs ?? "—"} LUFS</b></td></tr>
          <tr><td>True peak</td><td><b>${L.true_peak_dbfs ?? "—"} dBFS</b></td></tr>
          <tr><td>Silences (${a.silence_count})</td><td class="smut">${esc(sil)}</td></tr>
          <tr><td>Rhythm hints</td><td><b>${onsets.length}</b>
            <span class="smut">energy onsets — not beat tracking</span></td></tr>
        </table>
        ${onsets.length ? `<div class="smut">First onsets: ${onsets.slice(0, 8).map(o =>
          `${o.t}s`).join(", ")}</div>` : ""}`;
    } catch (e) {
      q("aresult").innerHTML = `<p class="sbad">Analysis failed: ${esc(e.message)}</p>`;
    }
    q("analyze").disabled = false;
  };
  q("enhance").onclick = async () => {
    q("enhance").disabled = true;
    q("eresult").innerHTML = `<p class="smut">Enhancing (two-pass loudnorm)…</p>`;
    try {
      const r = await post("/api/audiofx/enhance", {
        name: q("file").value,
        normalize: q("norm").checked,
        denoise: q("denoise").checked,
        dynamic: q("dynamic").checked,
        target_lufs: +q("lufs").value || -16,
      });
      const rep = r.report, b = rep.before, af = rep.after;
      mutate("Add enhanced audio", () => {
        S.project.assets[r.asset.name] = r.asset;
      });
      scheduleAutosave();
      window.dispatchEvent(new CustomEvent("timeline-progress"));
      q("eresult").innerHTML = `
        <table class="stable">
          <tr><td>Filter chain</td><td class="smut">${rep.filter_chain.map(esc).join("<br>")}</td></tr>
          <tr><td>Loudness</td><td><b>${b.integrated_lufs ?? "—"}</b> →
            <b class="sok">${af.integrated_lufs ?? "—"} LUFS</b> (target ${rep.target_lufs})</td></tr>
          <tr><td>Peak</td><td>${b.peak_db ?? "—"} → <b>${af.peak_db ?? "—"} dB</b></td></tr>
        </table>
        ${rep.dynamic_filter ? `<p class="smut">${esc(rep.dynamic_filter)}</p>` : ""}
        <p class="sok">✅ Enhanced file added to project assets as
        <b>${esc(r.asset.name)}</b>.</p>`;
    } catch (e) {
      q("eresult").innerHTML = `<p class="sbad">Enhance failed: ${esc(e.message)}</p>`;
    }
    q("enhance").disabled = false;
  };
  wrap.appendChild(f);
  return wrap;
}

// ---------------- debug: real stage timings ----------------
let debugTimer = null;
function debugTab(body) {
  const wrap = el(`<div>
    <label class="smut"><input type="checkbox" data-f="dbg" style="width:auto">
      Debug mode — live stage timings (refreshes every 2s)</label>
    <div data-f="stages"><p class="smut">Debug mode is off.</p></div>
    <p class="smut">Timings are recorded by real code paths via
    <code>record_stage()</code> (currently audiofx). Provider search
    latency/cache stats live in the Perf tab from the /api/metrics event log.</p>
  </div>`);
  const q = (n) => wrap.querySelector(`[data-f="${n}"]`);
  const render = async () => {
    try {
      const r = await get("/api/metrics/stages");
      const st = r.stages || {};
      const names = Object.keys(st);
      if (!names.length) {
        q("stages").innerHTML = `<p class="smut">No stages recorded yet —
          run Audio FX → Analyze/Enhance to generate timings.</p>`;
        return;
      }
      q("stages").innerHTML = `<table class="stable">
        <tr><th>stage</th><th>n</th><th>avg</th><th>last</th><th>max</th></tr>
        ${names.map(n => `<tr><td>${esc(n)}</td><td>${st[n].count}</td>
          <td><b>${st[n].avg_s}s</b></td><td>${st[n].last_s}s</td>
          <td>${st[n].max_s}s</td></tr>`).join("")}</table>
        ${Object.keys(r.counters || {}).length
          ? `<div class="smut" style="margin-top:6px">counters: ${Object.entries(r.counters)
            .map(([k, v]) => `${esc(k)}=${v}`).join(" · ")}</div>` : ""}`;
    } catch (e) {
      q("stages").innerHTML = `<p class="sbad">metrics unreachable: ${esc(e.message)}
        <br><span class="smut">Is register_metrics() wired? See WIRING.txt.</span></p>`;
      q("dbg").checked = false;
      clearInterval(debugTimer); debugTimer = null;
    }
  };
  q("dbg").onchange = () => {
    clearInterval(debugTimer); debugTimer = null;
    if (q("dbg").checked) { render(); debugTimer = setInterval(render, 2000); }
    else q("stages").innerHTML = `<p class="smut">Debug mode is off.</p>`;
  };
  wrap._cleanup = () => { clearInterval(debugTimer); debugTimer = null; };
  return wrap;
}

// ---------------- performance dashboard (real data only) ----------------
function perfTab(body) {
  const wrap = el(`<div>
    <div class="row"><b style="flex:1">Performance</b>
      <button class="sbtn" data-f="refresh">↻ Refresh</button></div>
    <div data-f="cards"><p class="smut">Loading…</p></div>
    <p class="smut">Every number below comes from the real /api/metrics event
    log. Empty = “no data yet”, never invented.</p>
  </div>`);
  const q = (n) => wrap.querySelector(`[data-f="${n}"]`);
  const avg = (a) => a.length ? a.reduce((x, y) => x + y, 0) / a.length : null;
  const fmt = (v, unit = "") => v == null ? `<span class="smut">no data yet</span>`
    : `<b>${typeof v === "number" ? v.toFixed(v < 10 ? 2 : 0) : esc(v)}${unit}</b>`;
  const render = async () => {
    let events = [];
    try { events = (await get("/api/metrics")).events || []; }
    catch (e) { q("cards").innerHTML = `<p class="sbad">${esc(e.message)}</p>`; return; }
    const of = (ev) => events.filter(e => e.event === ev);
    const searches = of("search"), hits = of("search_cache_hit"),
      fails = of("search_failed"), dl = of("broll_downloaded"),
      va = of("voice_analyzed"), ex = of("export_done"),
      axa = of("audiofx_analyzed"), axe = of("audiofx_enhanced");
    const searchMs = searches.map(e => e.ms).filter(v => typeof v === "number");
    const hitRate = (hits.length + searches.length)
      ? (100 * hits.length / (hits.length + searches.length)) : null;
    const lastDl = dl.length ? dl[dl.length - 1].ms : null;
    const lastVa = va.length ? va[va.length - 1].elapsed : null;
    const lastEx = ex.length ? ex[ex.length - 1].elapsed : null;
    const projMs = S.project?.metrics?.autoEditMs;
    q("cards").innerHTML = `
      <div class="smetric"><span>Search latency (avg, ${searches.length} searches)</span>${fmt(avg(searchMs), " ms")}</div>
      <div class="smetric"><span>Cache hit rate</span>${fmt(hitRate, "%")}</div>
      <div class="smetric"><span>Failed provider requests</span>${fails.length ? `<b class="sbad">${fails.length}</b>` : `<b>0</b>`}</div>
      <div class="smetric"><span>B-roll download (last)</span>${fmt(lastDl, " ms")}</div>
      <div class="smetric"><span>Voice analysis (last)</span>${fmt(lastVa != null ? lastVa * 1000 : null, " ms")}</div>
      <div class="smetric"><span>Export render (last)</span>${fmt(lastEx, " s")}</div>
      <div class="smetric"><span>Audio FX analyzed</span><b>${axa.length}</b></div>
      <div class="smetric"><span>Audio FX enhanced</span><b>${axe.length}</b></div>
      <div class="smetric"><span>Auto-edit time (this project)</span>${fmt(projMs, " ms")}</div>
      ${fails.length ? `<div class="smut">Last failure: ${esc((fails[fails.length - 1].error || "").slice(0, 120))}</div>` : ""}`;
  };
  q("refresh").onclick = render;
  render();
  return wrap;
}

// ---------------- autosave: versions in localStorage ----------------
function readStore() {
  try {
    const d = JSON.parse(localStorage.getItem(LS_KEY) || "{}");
    return { versions: Array.isArray(d.versions) ? d.versions : [] };
  } catch { return { versions: [] }; }
}
function writeStore(d) {
  try { localStorage.setItem(LS_KEY, JSON.stringify(d)); }
  catch { /* quota — keep app running */ }
}
function snapshotProject(auto) {
  if (!S.project) return;
  const d = readStore();
  d.versions.unshift({
    vid: uid("ver"), name: S.project.name || "Untitled",
    savedAt: Date.now(), dirty: !!auto, auto: !!auto,
    project: JSON.parse(JSON.stringify(S.project)),
  });
  // cap: drop oldest *auto* snapshots first
  while (d.versions.length > MAX_VERSIONS) {
    const i = d.versions.map(v => v.auto).lastIndexOf(true);
    d.versions.splice(i === -1 ? d.versions.length - 1 : i, 1);
  }
  writeStore(d);
}
let autosaveTimer = null;
function startAutosave() {
  if (autosaveTimer) return;
  autosaveTimer = setInterval(() => {
    if (S.project && S.dirty) {
      snapshotProject(true);
      const elx = document.querySelector('[data-studio="autosave-state"]');
      if (elx) elx.textContent =
        `autosaved ${new Date().toLocaleTimeString()}`;
    }
  }, 30000);
}

function versionsTab(body) {
  const wrap = el(`<div>
    <div class="row"><b style="flex:1">Project versions</b>
      <button class="sbtn" data-f="snap">💾 Save version now</button></div>
    <div class="smut" data-studio="autosave-state">autosave: every 30s while dirty</div>
    <div data-f="list"></div>
  </div>`);
  const q = (n) => wrap.querySelector(`[data-f="${n}"]`);
  const render = () => {
    const d = readStore();
    q("list").innerHTML = "";
    if (!d.versions.length) {
      q("list").innerHTML = `<p class="smut">No snapshots yet.</p>`;
      return;
    }
    for (const v of d.versions) {
      const row = el(`<div class="sver">
        <div><b>${esc(v.name)}</b>
          <span class="smut">${new Date(v.savedAt).toLocaleString()}
          ${v.auto ? " · auto" : " · manual"}${v.dirty ? " · unsaved-changes" : ""}</span></div>
        <div class="ops" style="display:flex;gap:4px;margin-top:5px">
          <button class="sbtn" data-a="restore">Restore</button>
          <button class="sbtn" data-a="dup">Duplicate</button>
          <button class="sbtn danger" data-a="del">Delete</button>
        </div></div>`);
      row.querySelector('[data-a="restore"]').onclick = () => {
        S.project = JSON.parse(JSON.stringify(v.project));
        S.selection.clear(); S.undoStack = []; S.redoStack = []; S.dirty = true;
        window.dispatchEvent(new CustomEvent("project-opened"));
        scheduleAutosave();
        toast(`Restored version from ${new Date(v.savedAt).toLocaleTimeString()}`, "ok");
      };
      row.querySelector('[data-a="dup"]').onclick = () => {
        const d2 = readStore();
        const cp = JSON.parse(JSON.stringify(v));
        cp.vid = uid("ver"); cp.savedAt = Date.now(); cp.auto = false;
        cp.name = v.name + " (copy)";
        d2.versions.unshift(cp);
        writeStore(d2); render();
        toast("Version duplicated", "ok");
      };
      row.querySelector('[data-a="del"]').onclick = () => {
        const d2 = readStore();
        d2.versions = d2.versions.filter(x => x.vid !== v.vid);
        writeStore(d2); render();
      };
      q("list").appendChild(row);
    }
  };
  q("snap").onclick = () => {
    if (!S.project) { toast("No project open", "bad"); return; }
    snapshotProject(false); render(); toast("Version saved", "ok");
  };
  render();
  return wrap;
}

function checkCrashRecovery(body) {
  const d = readStore();
  const dirty = d.versions.filter(v => v.dirty);
  if (!dirty.length) return;
  // show recovery prompt for the newest dirty snapshot
  const v = dirty[0];
  const banner = el(`<div id="studio-recover">
    <b>⚠ Unsaved work found</b>
    <div class="smut">Autosave from ${new Date(v.savedAt).toLocaleString()}
    (“${esc(v.name)}”) was never saved to the server. It may be from a crash
    or a closed tab.</div>
    <div class="row" style="margin-top:6px">
      <button class="sbtn primary" data-a="restore">Restore it</button>
      <button class="sbtn" data-a="discard">Discard</button>
    </div></div>`);
  banner.querySelector('[data-a="restore"]').onclick = () => {
    S.project = JSON.parse(JSON.stringify(v.project));
    S.selection.clear(); S.undoStack = []; S.redoStack = []; S.dirty = true;
    window.dispatchEvent(new CustomEvent("project-opened"));
    banner.remove();
    toast("Recovered autosave", "ok");
  };
  banner.querySelector('[data-a="discard"]').onclick = () => {
    const d2 = readStore();
    d2.versions = d2.versions.filter(x => x.vid !== v.vid);
    writeStore(d2);
    banner.remove();
  };
  body.prepend(banner);
}

// ---------------- panel shell ----------------
const TABS = [
  ["overlays", "📝 Overlays", overlayRows],
  ["audio", "🎚 Audio FX", audioTab],
  ["debug", "🐞 Debug", debugTab],
  ["perf", "📊 Perf", perfTab],
  ["versions", "💾 Versions", versionsTab],
];
let curTab = "overlays";
let dock = null;

function renderTab(body, name) {
  curTab = name;
  if (body._cleanup) { body._cleanup(); body._cleanup = null; }
  body.innerHTML = "";
  checkCrashRecovery(body);
  const tab = TABS.find(t => t[0] === name);
  body.appendChild(tab[2](body));
  dock.querySelectorAll("#studio-tabs button").forEach(b =>
    b.classList.toggle("on", b.dataset.tab === name));
}

function buildDock() {
  injectCss();
  dock = el(`<div id="studio-dock" class="hidden">
    <div id="studio-bar"><b>🎬 Studio</b>
      <button class="sbtn" data-a="close">✕</button></div>
    <div id="studio-tabs">${TABS.map(t =>
      `<button data-tab="${t[0]}">${t[1]}</button>`).join("")}</div>
    <div id="studio-body"></div>
  </div>`);
  const body = dock.querySelector("#studio-body");
  dock.querySelectorAll("#studio-tabs button").forEach(b =>
    b.onclick = () => renderTab(body, b.dataset.tab));
  dock.querySelector('[data-a="close"]').onclick = () => dock.classList.add("hidden");
  document.body.appendChild(dock);
  const toggle = el(`<button id="studio-toggle">🎬 Studio</button>`);
  toggle.onclick = () => {
    dock.classList.toggle("hidden");
    if (!dock.classList.contains("hidden")) renderTab(body, curTab);
  };
  document.body.appendChild(toggle);
}

const StudioUI = {
  init() {
    if (dock) return;
    buildDock();
    startAutosave();
  },
  openTab(name) {
    this.init();
    dock.classList.remove("hidden");
    renderTab(dock.querySelector("#studio-body"), name);
  },
  snapshot(auto) { snapshotProject(!!auto); },
  versions() { return readStore().versions; },
};

window.StudioUI = StudioUI;
if (document.readyState === "loading")
  document.addEventListener("DOMContentLoaded", () => StudioUI.init());
else
  StudioUI.init();

export default StudioUI;
