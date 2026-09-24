// Export: real server-side FFmpeg render + fast in-browser capture.
// Both produce genuine video files; nothing is faked.
import { post, get, toast, fmtTime, API_BASE } from "./api.js";
import { S, tl } from "./store.js";
import { transport, setTime, togglePlay, stopPlay, onTransport } from "./timeline.js";
import { getCanvasStream } from "./preview.js";

export function initExporter() {
  window.addEventListener("open-export", openExportModal);
}

function openExportModal() {
  const T = tl();
  const main = T.clips.filter(c => c.trackId === "v_main");
  if (!main.length) { toast("Timeline is empty — nothing to export", "bad"); return; }
  const missing = main.filter(c => c.sourceType === "broll" && !S.project.assets[c.assetId]);
  const root = document.getElementById("modal-root");
  root.innerHTML = `<div class="modal"><div class="modal-box">
    <h2>⤓ Export video</h2>
    <div class="kv"><span>Timeline</span><b>${fmtTime(T.duration)} · ${main.length} clips · ${S.project.format}</b></div>
    ${missing.length ? `<p style="color:var(--warn)">⚠ ${missing.length} B-roll clip(s) were never downloaded and will render as black. Replace them first.</p>` : ""}
    <div class="wz-field"><label>Render method</label>
      <div class="radio-row">
        <div class="radio-pill sel" data-m="server">🖥 Server render (FFmpeg)</div>
        <div class="radio-pill" data-m="fast">⚡ Fast capture (this browser)</div>
      </div>
      <div class="muted" style="font-size:12px;margin-top:6px" id="ex-desc">
        Best quality: re-renders every clip with transitions, text, subtitles, ducked audio.</div></div>
    <div id="ex-server-opts">
      <div class="insp-row">
        <div class="wz-field"><label>Resolution</label><select id="ex-q">
          <option>720p</option><option selected>1080p</option><option>1440p</option><option>4K</option></select></div>
        <div class="wz-field"><label>Frame rate</label><select id="ex-fps">
          <option>24</option><option selected>30</option><option>60</option></select></div>
      </div>
      <p class="muted" style="font-size:11.5px">Hardware acceleration is used when available. 4K is only offered as a true 4K render — never an upscale label.</p>
    </div>
    <div id="ex-prog" class="hidden">
      <div class="proc-bar"><div id="ex-fill" style="height:100%;width:0;background:linear-gradient(90deg,var(--acc),var(--acc2))"></div></div>
      <div id="ex-step" class="proc-step">Starting…</div>
    </div>
    <div id="ex-done" class="hidden" style="margin-top:10px"></div>
    <div class="modal-foot">
      <button class="btn" id="ex-close">Cancel</button>
      <button class="btn primary" id="ex-go">Start export</button>
    </div>
  </div></div>`;
  let method = "server";
  root.querySelectorAll("[data-m]").forEach(p => p.onclick = () => {
    method = p.dataset.m;
    root.querySelectorAll("[data-m]").forEach(x => x.classList.toggle("sel", x === p));
    root.querySelector("#ex-server-opts").classList.toggle("hidden", method !== "server");
    root.querySelector("#ex-desc").textContent = method === "server"
      ? "Best quality: re-renders every clip with transitions, text, subtitles, ducked audio."
      : "Records the live preview in real time — fastest, exactly what you see and hear.";
  });
  root.querySelector("#ex-close").onclick = () => { root.innerHTML = ""; };
  root.querySelector("#ex-go").onclick = async () => {
    root.querySelector("#ex-go").disabled = true;
    root.querySelector("#ex-prog").classList.remove("hidden");
    try {
      if (method === "server") await serverRender(root);
      else await fastCapture(root);
    } catch (e) {
      root.querySelector("#ex-step").textContent = "Failed: " + e.message;
      root.querySelector("#ex-go").disabled = false;
    }
  };
}

function payload() {
  const T = tl();
  return {
    timeline: {
      clips: T.clips, overlays: T.overlays, subtitles: T.subtitles,
      subtitleStyle: T.subtitleStyle, subtitlesEnabled: T.subtitlesEnabled,
      transitionsDisabled: !!T.transitionsDisabled,
      textAnimationsDisabled: !!T.textAnimationsDisabled,
      voicePath: T.voice?.name || null,
      musicPath: T.music?.name || null, musicEnabled: !!T.musicEnabled,
      ducking: T.ducking ?? 0.35,
    },
    settings: {
      format: S.project.format,
      quality: document.getElementById("ex-q").value,
      fps: +document.getElementById("ex-fps").value,
    },
  };
}

async function serverRender(root) {
  const step = root.querySelector("#ex-step"), fill = root.querySelector("#ex-fill");
  step.textContent = "Sending timeline to render server…";
  const r = await post("/api/export", payload());
  const t0 = Date.now();
  await new Promise((resolve, reject) => {
    const iv = setInterval(async () => {
      try {
        const s = await get(`/api/export/${r.job}`);
        fill.style.width = `${Math.round(s.progress * 100)}%`;
        step.textContent = `Rendering… ${Math.round(s.progress * 100)}% (${((Date.now() - t0) / 1000).toFixed(0)}s)`;
        if (s.status === "done") { clearInterval(iv); resolve(); }
        else if (s.status === "failed") { clearInterval(iv); reject(new Error(s.error || "render failed")); }
      } catch (e) { clearInterval(iv); reject(e); }
    }, 1200);
  });
  fill.style.width = "100%";
  step.textContent = "Done ✓";
  const done = root.querySelector("#ex-done");
  done.classList.remove("hidden");
  done.innerHTML = `<a class="btn primary" href="${API_BASE}/api/export/${r.job}/download" download
    style="text-decoration:none;display:inline-block">⬇ Download MP4</a>
    <span class="muted" style="margin-left:8px">Opens in a new download — keep this tab open until it finishes.</span>`;
  toast("Export complete", "ok");
}

async function fastCapture(root) {
  const step = root.querySelector("#ex-step"), fill = root.querySelector("#ex-fill");
  const { canvas, audioCtx, masterGain } = getCanvasStream();
  const stream = canvas.captureStream(30);
  let audioTrack = null;
  try {
    const dest = audioCtx.createMediaStreamDestination();
    masterGain.connect(dest);
    audioTrack = dest.stream.getAudioTracks()[0];
    if (audioTrack) stream.addTrack(audioTrack);
  } catch { /* video-only fallback */ }
  const mime = ["video/webm;codecs=vp9,opus", "video/webm;codecs=vp8,opus", "video/webm"]
    .find(m => window.MediaRecorder?.isTypeSupported(m)) || "";
  if (!window.MediaRecorder) throw new Error("MediaRecorder not supported in this browser");
  const rec = new MediaRecorder(stream, mime ? { mimeType: mime, videoBitsPerSecond: 12_000_000 } : undefined);
  const chunks = [];
  rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
  const doneP = new Promise((res) => rec.onstop = res);

  stopPlay();
  setTime(0);
  await new Promise(r => setTimeout(r, 600));
  rec.start(500);
  togglePlay(); // user gesture chain: Export click -> this handler
  step.textContent = "Capturing preview in real time…";
  await new Promise((resolve) => {
    const iv = setInterval(() => {
      const p = transport.duration ? transport.time / transport.duration : 0;
      fill.style.width = `${Math.round(p * 100)}%`;
      step.textContent = `Capturing… ${Math.round(p * 100)}%`;
      if (!transport.playing || transport.time >= transport.duration - 0.05) {
        clearInterval(iv); resolve();
      }
    }, 300);
  });
  if (transport.playing) togglePlay();
  rec.stop();
  await doneP;
  const blob = new Blob(chunks, { type: "video/webm" });
  const url = URL.createObjectURL(blob);
  const done = root.querySelector("#ex-done");
  done.classList.remove("hidden");
  done.innerHTML = `<a class="btn primary" href="${url}" download="storycut-fast-capture.webm"
    style="text-decoration:none;display:inline-block">⬇ Download WebM (${(blob.size / 1048576).toFixed(1)} MB)</a>`;
  step.textContent = "Done ✓";
  toast("Fast capture complete", "ok");
}
