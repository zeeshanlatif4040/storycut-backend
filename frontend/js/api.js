// Minimal fetch wrapper for the backend API.
// API_BASE is "" (same origin) by default; override via window.STORYCUT_API_BASE
// in static/js/config.js when the frontend is hosted separately (e.g. Netlify).
export const API_BASE = String(window.STORYCUT_API_BASE || "").replace(/\/+$/, "");
const u = (p) => API_BASE + p;

const UNREACHABLE_MSG =
  "Cannot reach the app server — the backend is not deployed here. " +
  "This page is only the design; uploads, analysis and rendering need the " +
  "Python backend running (see DEPLOY.md).";

function unreachable() {
  return new Error(UNREACHABLE_MSG);
}

/** Read a fetch Response as JSON, translating HTML/empty bodies (typical of
 *  static hosts like Netlify answering /api/* with a 404 page) into the
 *  friendly unreachable message instead of "Unexpected token '<'". */
async function readJson(res) {
  const ct = (res.headers.get("content-type") || "").toLowerCase();
  if (ct.includes("text/html")) throw unreachable();
  let data = null;
  try { data = await res.json(); }
  catch { throw unreachable(); }
  return data;
}

export async function api(path, opts = {}) {
  let res;
  try {
    res = await fetch(u(path), opts);
  } catch {
    throw unreachable();
  }
  const data = await readJson(res);
  if (!res.ok) throw new Error((data && (data.message || data.error)) || `HTTP ${res.status}`);
  if (data && data.ok === false) throw new Error(data.message || data.error || "request failed");
  return data;
}
export const get = (p) => api(p);
export const post = (p, body) =>
  api(p, { method: "POST", headers: { "Content-Type": "application/json" },
           body: JSON.stringify(body || {}) });
/** Upload files with a real progress callback, using CHUNKED RESUMABLE uploads.
 *  Each file is split into ~4MB pieces. The server records which pieces it
 *  already has, so if the connection drops, retrying resumes from the first
 *  missing piece instead of starting the file over.
 *  onProgress(frac, confirmedBytes, totalBytes) — frac is 0..1 and counts
 *  only bytes the SERVER confirmed (honest progress, not bytes-sent).
 *  The returned promise has a .cancel() method (aborts the in-flight piece;
 *  already-confirmed pieces stay on the server for resume). */
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
// Remembers the server session per File object so a Retry reuses it and the
// server can report which pieces it already has (true resume, not restart).
const _resumeIds = new WeakMap();
export function uploadFiles(files, kind = "media", onProgress) {
  let cancelled = false;
  let activeXhr = null;
  const p = new Promise((resolve, reject) => {
    (async () => {
      const metas = [];
      const totalBytes = files.reduce((n, f) => n + (f.size || 0), 0) || 1;
      let confirmedBase = 0; // server-confirmed bytes of finished files
      const report = (confirmed) => {
        try { onProgress && onProgress(confirmed / totalBytes, confirmed, totalBytes); } catch {}
      };
      const postChunk = (uploadId, index, blob, chunkBase) => new Promise((res, rej) => {
        const fd = new FormData();
        fd.append("upload_id", uploadId);
        fd.append("index", String(index));
        fd.append("chunk", blob, "chunk");
        const xhr = new XMLHttpRequest();
        activeXhr = xhr;
        xhr.open("POST", u("/api/uploads/chunk"));
        xhr.upload.onprogress = (e) => {
          if (e.lengthComputable) report(chunkBase + e.loaded);
        };
        xhr.onload = () => {
          activeXhr = null;
          let data = null;
          try { data = JSON.parse(xhr.responseText); } catch {}
          if (xhr.status >= 200 && xhr.status < 300 && data && data.ok !== false) res(data);
          else rej(new Error((data && data.error) || `piece upload failed (HTTP ${xhr.status})`));
        };
        xhr.onerror = () => { activeXhr = null; rej(new Error("connection lost")); };
        xhr.onabort = () => { activeXhr = null; rej(new Error("upload cancelled")); };
        xhr.send(fd);
      });
      for (const file of files) {
        if (cancelled) throw new Error("upload cancelled");
        // (Re)open a session. Passing the previous upload_id lets the server
        // resume an interrupted upload from its confirmed pieces.
        let init, uploadId, chunkSize, totalChunks, have;
        const openSession = async (resume) => {
          init = await post("/api/uploads/init",
            { filename: file.name, size: file.size, kind,
              upload_id: resume || undefined });
          uploadId = init.upload_id; chunkSize = init.chunk_size;
          totalChunks = init.total_chunks; have = new Set(init.received || []);
          _resumeIds.set(file, uploadId);
        };
        await openSession(_resumeIds.get(file));
        let confirmedFile = 0;
        for (const i of have)
          confirmedFile += Math.min(chunkSize, file.size - i * chunkSize);
        report(confirmedBase + confirmedFile);
        for (let i = 0; i < totalChunks; i++) {
          if (have.has(i)) continue;  // already on the server from a previous attempt
          if (cancelled) throw new Error("upload cancelled");
          const blob = file.slice(i * chunkSize,
            Math.min(file.size, (i + 1) * chunkSize));
          let done = false, lastErr = null;
          for (let attempt = 1; attempt <= 4 && !done; attempt++) {
            if (cancelled) throw new Error("upload cancelled");
            try {
              const r = await postChunk(uploadId, i, blob, confirmedBase + confirmedFile);
              done = true;
              confirmedFile = r.received_bytes;
              report(confirmedBase + confirmedFile);
            } catch (e) {
              lastErr = e;
              if (cancelled) throw new Error("upload cancelled");
              if (String(lastErr && lastErr.message).includes("expired")) {
                // Server lost the session (restart/cleanup) — start fresh.
                _resumeIds.delete(file);
                await openSession(null);
                confirmedFile = 0;
                i = -1; // restart the piece loop with the new session
                break;
              }
              if (attempt < 4) await sleep(1200 * attempt);
            }
          }
          if (i === -1) continue; // session was renewed above; loop restarts
          if (!done) {
            const pct = Math.round(100 * (confirmedBase + confirmedFile) / totalBytes);
            throw new Error(`connection lost during upload — Retry resumes from ${pct}%`);
          }
        }
        const fin = await post("/api/uploads/complete", { upload_id: uploadId });
        metas.push(...fin.files);
        _resumeIds.delete(file);
        confirmedBase += file.size;
        report(confirmedBase);
      }
      resolve(metas);
    })().catch(reject);
  });
  p.cancel = () => { cancelled = true; try { activeXhr && activeXhr.abort(); } catch {} };
  return p;
}
export const mediaUrl = (name) => u(`/api/media/file?name=${encodeURIComponent(name)}`);
export const thumbUrl = (name) => name ? u(`/api/media/thumb?name=${encodeURIComponent(name)}`) : "";

export function toast(msg, kind = "") {
  const root = document.getElementById("toast-root");
  const el = document.createElement("div");
  el.className = "toast " + kind;
  el.textContent = msg;
  root.appendChild(el);
  setTimeout(() => el.remove(), 5200);
}

export function fmtTime(s) {
  s = Math.max(0, s || 0);
  const m = Math.floor(s / 60), sec = s - m * 60;
  return `${m}:${sec.toFixed(1).padStart(4, "0")}`;
}

export function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, c =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

let _uid = 0;
export const uid = (p = "id") => `${p}_${Date.now().toString(36)}${(_uid++).toString(36)}`;
