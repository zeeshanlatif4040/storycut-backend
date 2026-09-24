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
  if (!res.ok) throw new Error((data && data.error) || `HTTP ${res.status}`);
  if (data && data.ok === false) throw new Error(data.error || "request failed");
  return data;
}
export const get = (p) => api(p);
export const post = (p, body) =>
  api(p, { method: "POST", headers: { "Content-Type": "application/json" },
           body: JSON.stringify(body || {}) });
export async function uploadFiles(files, kind = "media") {
  const fd = new FormData();
  for (const f of files) fd.append("files", f);
  fd.append("kind", kind);
  let res;
  try {
    res = await fetch(u("/api/uploads"), { method: "POST", body: fd });
  } catch {
    throw unreachable();
  }
  const data = await readJson(res);
  if (!res.ok || data.ok === false) throw new Error(data.error || "upload failed");
  return data.files;
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
