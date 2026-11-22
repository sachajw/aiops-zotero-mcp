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
