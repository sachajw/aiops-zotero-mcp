// Runs in Zotero's Settings window. The plugin exposes testConnection on Zotero while it's loaded.
if (!window.aiopsLlmPrefsWired) {
  window.aiopsLlmPrefsWired = true;
  document.addEventListener("click", async (event) => {
    if (event.target?.id !== "aiops-llm-test") return;
    const result = document.getElementById("aiops-llm-test-result");
    const api = Zotero.AiopsZoteroMcp;
    if (!api) {
      result.value = "The plugin isn't running.";
      return;
    }
    event.target.disabled = true;
    result.value = "Testing…";
    try {
      result.value = await api.testConnection();
    } catch (e) {
      result.value = e && e.message ? e.message : String(e);
    } finally {
      event.target.disabled = false;
    }
  });
}

// One row per configured backend for its own chat and actions models (extensions.aiops-zotero-mcp.llm.
// chatModel.<name> / actionModel.<name>). Built here because the backends come from a pref.
(function perBackendModels() {
  const PREFIX = "extensions.aiops-zotero-mcp.llm.";
  const HTML = "http://www.w3.org/1999/xhtml";
  const labels = () =>
    String(Zotero.Prefs.get(`${PREFIX}profileFiles`, true) || "")
      .split(/[\n,]/)
      .map((s) => s.trim())
      .filter(Boolean)
      .map((f) => f.split(/[\\/]/).pop().replace(/\.settings\.json$/, "").replace(/\.json$/, ""));
  const input = (pref) => {
    const el = document.createElementNS(HTML, "input");
    el.type = "text";
    el.value = String(Zotero.Prefs.get(pref, true) || "");
    el.placeholder = "(shared)";
    el.style.width = "9em";
    el.addEventListener("change", () => {
      const v = el.value.trim();
      if (v) Zotero.Prefs.set(pref, v, true);
      else Zotero.Prefs.clear(pref, true);
    });
    return el;
  };
  const build = () => {
    const box = document.getElementById("aiops-llm-per-backend");
    if (!box) return false;
    box.replaceChildren();
    for (const label of labels()) {
      const row = document.createElementNS(HTML, "div");
      row.style.margin = "2px 0";
      row.append(
        document.createTextNode(`${label}: chat `),
        input(`${PREFIX}chatModel.${label}`),
        document.createTextNode("  actions "),
        input(`${PREFIX}actionModel.${label}`),
      );
      box.append(row);
    }
    return true;
  };
  // The pane's fragment may be inserted after this script runs, and the backend list can change.
  if (!build()) {
    const observer = new window.MutationObserver(() => {
      if (build()) observer.disconnect();
    });
    observer.observe(document, { childList: true, subtree: true });
  }
  document.addEventListener("change", (event) => {
    if (event.target?.id === "aiops-llm-profile-files") build();
  });
})();
