/* Creative Director — story map renderer (rule-based results only).
 * window.DirectorUI.renderStoryMap(storyMap, containerEl)
 * storyMap: response.storyMap from POST /api/director/analyze.
 * Units may carry an optional `visual` object:
 *   { candidate, score, reasons, why, confidence:{level,reasons} }
 * produced via the backend director helpers — when absent the UI says
 * "no visual assigned yet" instead of inventing one.
 */
(function () {
  "use strict";

  var CONF_STYLE = {
    High:   { color: "var(--ok)",   border: "#43c98a55", bg: "#43c98a12", label: "High confidence" },
    Medium: { color: "var(--warn)", border: "#ffb84d55", bg: "#ffb84d12", label: "Medium confidence" },
    Low:    { color: "var(--bad)",  border: "#ff6b6b55", bg: "#ff6b6b12",  label: "Low confidence" }
  };

  var FLAG_LABEL = {
    "static-risk": "static-risk: long unit, add a cut or motion",
    "boring-risk": "boring-risk: few entities + long duration",
    "rushed": "rushed: very short unit"
  };

  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  function chip(text, warn) {
    var c = el("span", "chip" + (warn ? " warn" : ""), text);
    return c;
  }

  function fmtT(s) {
    s = Math.max(0, Number(s) || 0);
    var m = Math.floor(s / 60), sec = (s % 60).toFixed(1);
    return m + ":" + (sec < 10 ? "0" : "") + sec;
  }

  function sectionHead(title, note) {
    var h = el("h4", "sec", title);
    if (note) {
      var s = el("span", "muted", " — " + note);
      s.style.cssText = "text-transform:none;letter-spacing:0;font-weight:400";
      h.appendChild(s);
    }
    return h;
  }

  function renderUnit(u) {
    var card = el("div", null);
    card.style.cssText = "background:rgba(255,255,255,.025);border:1px solid var(--line2);" +
      "border-radius:10px;padding:10px 12px;margin:0 0 10px";

    var top = el("div", null);
    top.style.cssText = "display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-bottom:6px";
    var kind = el("span", "chip", u.type.toUpperCase());
    top.appendChild(kind);
    top.appendChild(el("span", "muted", "#" + (u.index + 1) + " · " + fmtT(u.start) + " → " + fmtT(u.end) +
      " (" + u.duration + "s)"));
    (u.flags || []).forEach(function (f) {
      top.appendChild(chip("⚠ " + (FLAG_LABEL[f] || f), true));
    });
    card.appendChild(top);

    var p = el("p", null, u.text);
    p.style.cssText = "margin:6px 0;font-size:13px";
    card.appendChild(p);

    var meta = el("div", "muted");
    meta.style.cssText = "font-size:12px;display:flex;gap:10px;flex-wrap:wrap;margin-bottom:6px";
    if (u.searchQuery) meta.appendChild(el("span", null, "🔎 " + u.searchQuery));
    if (u.entities && u.entities.length) {
      var ents = u.entities.map(function (e) { return e.value + " (" + e.kind + ")"; }).join(", ");
      meta.appendChild(el("span", null, "🏷 " + ents));
    }
    card.appendChild(meta);

    // Visual / confidence block
    var v = u.visual || null;
    if (v && v.candidate) {
      var st = CONF_STYLE[(v.confidence && v.confidence.level) || "Low"] || CONF_STYLE.Low;
      var badge = el("span", null, "● " + st.label +
        (v.score != null ? " · score " + v.score : ""));
      badge.style.cssText = "display:inline-block;font-size:11.5px;font-weight:700;color:" + st.color +
        ";border:1px solid " + st.border + ";background:" + st.bg +
        ";border-radius:99px;padding:3px 12px;margin:4px 0 6px";
      card.appendChild(badge);
      var why = el("div", null, v.why || "No explanation available.");
      why.style.cssText = "font-size:12.5px;color:var(--muted);border-left:3px solid var(--line2);" +
        "padding:4px 10px;margin:2px 0 4px";
      card.appendChild(why);
      if (v.confidence && v.confidence.reasons && v.confidence.reasons.length) {
        var rs = el("div", "muted", "confidence: " + v.confidence.reasons.join("; "));
        rs.style.fontSize = "11.5px";
        card.appendChild(rs);
      }
    } else {
      card.appendChild(el("div", "muted", "No visual assigned yet — run B-roll search to score candidates for this unit."));
    }
    return card;
  }

  function renderStoryMap(storyMap, containerEl) {
    var root = containerEl;
    root.innerHTML = "";
    if (!storyMap || !storyMap.units) {
      root.appendChild(el("p", "muted", "No story map to display."));
      return;
    }

    var head = el("div", null);
    head.style.cssText = "display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-bottom:4px";
    var mood = (storyMap.mood && storyMap.mood.mood) || "neutral";
    head.appendChild(el("strong", null, "🎬 Story Map"));
    head.appendChild(chip("mood: " + mood));
    head.appendChild(chip("rule-based", false));
    if (!storyMap.timingReal) head.appendChild(chip("timing estimated", true));
    root.appendChild(head);
    var sub = el("p", "muted",
      storyMap.unitCount + " units · " + storyMap.sentenceCount + " sentences" +
      (storyMap.ctaDetected ? " · CTA detected" : " · no CTA detected") +
      " — " + (storyMap.timingNote || ""));
    sub.style.cssText = "font-size:12px;margin:2px 0 10px";
    root.appendChild(sub);

    var order = ["hook", "body", "cta"];
    var titles = { hook: "Hook", body: "Body", cta: "Call to action" };
    order.forEach(function (kind) {
      var units = storyMap.units.filter(function (u) { return u.type === kind; });
      if (!units.length) return;
      root.appendChild(sectionHead(titles[kind], kind === "hook" ? "first 1–2 sentences (rule)" :
        kind === "cta" ? "last sentence: imperative / question / CTA keyword (rule)" :
        "grouped by topic-word overlap (rule)"));
      units.forEach(function (u) { root.appendChild(renderUnit(u)); });
    });
  }

  window.DirectorUI = { renderStoryMap: renderStoryMap };
})();
