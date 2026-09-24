// Central project state + undo/redo + persistence.
import { post, get, toast } from "./api.js";

export const TRACKS = [
  { id: "v_main",   label: "Main Video",  kind: "video", tall: true },
  { id: "v_overlay",label: "B-Roll / Overlay", kind: "video" },
  { id: "gfx",      label: "Text / Graphics", kind: "gfx" },
  { id: "subs",     label: "Subtitles",   kind: "subs" },
  { id: "a_voice",  label: "Voice-over",  kind: "audio", tall: true },
  { id: "a_music",  label: "Music / SFX", kind: "audio" },
];

const listeners = new Set();
export function onChange(fn) { listeners.add(fn); return () => listeners.delete(fn); }
function emit(what) { for (const fn of listeners) fn(what); }

export const S = {
  project: null,          // full project object
  selection: new Set(),   // selected clipIds
  undoStack: [],
  redoStack: [],
  dirty: false,
};

export function newProject(mode) {
  S.project = {
    id: null, name: "Untitled project", mode,           // broll | user | both
    format: "16:9", sourceMode: "balanced",
    script: "", voiceName: null, voiceDuration: 0,
    timed: [], plan: null,
    assets: {},                                        // assetId -> meta
    timeline: emptyTimeline(),
    metrics: { startedAt: Date.now() },
    review: [],                                        // low-confidence segment entries
  };
  S.selection.clear(); S.undoStack = []; S.redoStack = []; S.dirty = false;
  emit("project");
}

export function emptyTimeline() {
  return {
    clips: [], overlays: [], subtitles: [],
    subtitleStyle: { font: "DejaVu Sans", size: 44, weight: "bold",
      color: "#FFFFFF", outline: 2, background: "rgba(0,0,0,0.55)",
      position: "bottom", animation: "fade" },
    subtitlesEnabled: true,
    // Global switches (user-facing toggles in the Editing drawer).
    // transitionsDisabled: every junction renders as a hard cut (preview + export).
    // textAnimationsDisabled: all text overlays/subtitles render static
    //   (preview, subtitles, FFmpeg export, fast capture).
    transitionsDisabled: false,
    textAnimationsDisabled: false,
    voice: null, music: null, musicEnabled: false, ducking: 0.35,
    duration: 0,
  };
}

export function tl() { return S.project.timeline; }
export function asset(id) { return S.project.assets[id]; }

// ---------------- undo/redo (snapshot based, robust) ----------------
function snapshot() { return JSON.stringify(S.project.timeline); }
export function pushUndo(label) {
  S.undoStack.push({ label, snap: snapshot() });
  if (S.undoStack.length > 80) S.undoStack.shift();
  S.redoStack = [];
  markDirty();
}
function restore(snap) {
  S.project.timeline = JSON.parse(snap);
  S.selection.clear();
  markDirty(); emit("timeline");
}
export function undo() {
  const u = S.undoStack.pop();
  if (!u) return;
  S.redoStack.push({ label: u.label, snap: snapshot() });
  restore(u.snap); toast("Undid: " + u.label);
}
export function redo() {
  const r = S.redoStack.pop();
  if (!r) return;
  S.undoStack.push({ label: r.label, snap: snapshot() });
  restore(r.snap); toast("Redid: " + r.label);
}
export function mutate(label, fn) {
  pushUndo(label);
  fn();
  emit("timeline");
}
export function markDirty() {
  S.dirty = true;
  const el = document.getElementById("save-state");
  if (el) el.textContent = "● unsaved";
}

// ---------------- persistence ----------------
let saveTimer = null;
export function scheduleAutosave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => saveProject(true), 4000);
}
export async function saveProject(quiet) {
  const p = S.project;
  if (!p) return;
  p.updatedAt = Date.now();
  // strip bulky transient fields
  const payload = JSON.parse(JSON.stringify(p));
  try {
    const r = await post("/api/projects", payload);
    p.id = r.id;
    S.dirty = false;
    const el = document.getElementById("save-state");
    if (el) el.textContent = quiet ? "saved ✓" : "";
    if (!quiet) toast("Project saved", "ok");
  } catch (e) { if (!quiet) toast("Save failed: " + e.message, "bad"); }
}
export async function loadProject(id) {
  const r = await get(`/api/projects/${id}`);
  S.project = r.project;
  S.selection.clear(); S.undoStack = []; S.redoStack = []; S.dirty = false;
  emit("project");
}
