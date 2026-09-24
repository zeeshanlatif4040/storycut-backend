// App boot: wire all modules together.
import { initStartup } from "./wizard.js";
import { initTimeline, renderTimeline } from "./timeline.js";
import { initPreview } from "./preview.js";
import { initPanels } from "./panels.js";
import { initExporter } from "./exporter.js";
import { saveProject } from "./store.js";

initStartup();
initTimeline();
initPreview();
initPanels();
initExporter();

window.addEventListener("project-opened", () => {
  renderTimeline();
});

document.addEventListener("keydown", (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") {
    e.preventDefault();
    saveProject(false);
  }
});

window.addEventListener("error", (e) => {
  console.error("[StoryCut]", e.error || e.message);
});
console.log("%cStoryCut ready", "font-weight:bold;color:#6c8cff");
