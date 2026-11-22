// Runs in Zotero's Settings window. The plugin exposes its backend API on Zotero.AiopsZoteroMcp
// while it's loaded (listBackends, saveBackend, removeBackend, testConnection, providers).
(function aiopsAssistantPrefs() {
  if (window.aiopsLlmPrefsWired) return;
  window.aiopsLlmPrefsWired = true;

  const PREFIX = "extensions.aiops-zotero-mcp.llm.";
  const HTML = "http://www.w3.org/1999/xhtml";
  const api = () => Zotero.AiopsZoteroMcp;
  const $ = (id) => document.getElementById(id);
  const el = (tag, text) => {
    const node = document.createElementNS(HTML, tag);
    if (text !== undefined) node.textContent = text;
    return node;
  };
  const button = (label, onClick) => {
    const b = el("button", label);
    b.style.marginLeft = "6px";
    b.addEventListener("click", onClick);
    return b;
  };
  const say = (id, text) => {
    const target = $(id);
    if (target) target.value = text;
  };
  const message = (e) => (e && e.message ? e.message : String(e));

  function renderBackends() {
    const box = $("aiops-llm-backends");
    if (!box || !api()) return;
    box.replaceChildren();
    const list = api().listBackends();
    if (!list.length) box.append(el("div", "None yet: add a provider below."));
    for (const b of list) {
      const row = el("div");
      row.style.margin = "2px 0";
      row.append(el("strong", b.name), el("span", ` ${b.active ? "(in use) " : ""}— ${b.source === "file" ? "settings file" : "provider"}: ${b.where}`));
      if (!b.active) {
        row.append(
          button("Use", () => {
            Zotero.Prefs.set(`${PREFIX}activeProfile`, b.name, true);
            renderAll();
          }),
        );
      }
      row.append(
        button("Test", async (event) => {
          event.target.disabled = true;
          say("aiops-llm-backends-result", `Testing ${b.name}…`);
          try {
            say("aiops-llm-backends-result", await api().testConnection(b.name));
          } catch (e) {
            say("aiops-llm-backends-result", `${b.name}: ${message(e)}`);
          } finally {
            event.target.disabled = false;
          }
        }),
      );
      if (b.source === "settings") {
        row.append(
          button("Remove", async () => {
            await api().removeBackend(b.name);
            say("aiops-llm-backends-result", `Removed ${b.name} and its key.`);
            renderAll();
          }),
        );
      }
      box.append(row);
    }
  }

  function renderPerBackendModels() {
    const box = $("aiops-llm-per-backend");
    if (!box || !api()) return;
    box.replaceChildren();
    const input = (pref) => {
      const field = el("input");
      field.type = "text";
      field.value = String(Zotero.Prefs.get(pref, true) || "");
      field.placeholder = "(shared)";
      field.style.width = "9em";
      field.addEventListener("change", () => {
        const v = field.value.trim();
        if (v) Zotero.Prefs.set(pref, v, true);
        else Zotero.Prefs.clear(pref, true);
      });
      return field;
    };
    for (const b of api().listBackends()) {
      const row = el("div");
      row.style.margin = "2px 0";
      row.append(
        document.createTextNode(`${b.name}: chat `),
        input(`${PREFIX}chatModel.${b.name}`),
        document.createTextNode("  actions "),
        input(`${PREFIX}actionModel.${b.name}`),
      );
      box.append(row);
    }
  }

  function setUpAddForm() {
    const select = $("aiops-llm-add-provider");
    if (!select || select.dataset.ready || !api()) return;
    select.dataset.ready = "1";
    const presets = api().providers();
    for (const [id, p] of Object.entries(presets)) {
      const option = el("option", p.title);
      option.value = id;
      select.append(option);
    }
    const custom = el("option", "Other (any https endpoint, or http on this computer, that speaks the Anthropic Messages API)");
    custom.value = "custom";
    select.append(custom);
    const fill = () => {
      const p = presets[select.value];
      $("aiops-llm-add-name").value = p ? select.value : "";
      $("aiops-llm-add-url").value = p ? p.baseURL : "https://";
      $("aiops-llm-add-auth").value = p ? p.auth : "x-api-key";
      for (const tier of ["default", "opus", "sonnet", "haiku"]) $(`aiops-llm-add-m-${tier}`).value = p ? p.models[tier] || "" : "";
    };
    select.addEventListener("change", fill);
    fill();
    $("aiops-llm-add-save").addEventListener("click", async (event) => {
      event.target.disabled = true;
      try {
        const models = {};
        for (const tier of ["default", "opus", "sonnet", "haiku"]) {
          const v = $(`aiops-llm-add-m-${tier}`).value.trim();
          if (v) models[tier] = v;
        }
        const result = await api().saveBackend({
          name: $("aiops-llm-add-name").value.trim(),
          baseURL: $("aiops-llm-add-url").value.trim(),
          auth: $("aiops-llm-add-auth").value,
          models,
          key: $("aiops-llm-add-key").value,
        });
        $("aiops-llm-add-key").value = "";
        say("aiops-llm-add-result", result);
        renderAll();
      } catch (e) {
        say("aiops-llm-add-result", message(e));
      } finally {
        event.target.disabled = false;
      }
    });
  }

  function renderAll() {
    renderBackends();
    renderPerBackendModels();
    setUpAddForm();
  }

  // The pane's fragment may be inserted after this script runs.
  const ready = () => Boolean($("aiops-llm-backends") && api());
  if (ready()) renderAll();
  else {
    const observer = new window.MutationObserver(() => {
      if (ready()) {
        observer.disconnect();
        renderAll();
      }
    });
    observer.observe(document, { childList: true, subtree: true });
  }
  document.addEventListener("change", (event) => {
    if (event.target && event.target.id === "aiops-llm-profile-files") renderAll();
  });
})();
