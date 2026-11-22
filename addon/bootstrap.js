// Zotero 7+ bootstrapped plugin. The bundle (content/aiops-zotero-mcp.js) defines AiopsZoteroMcp.
var AiopsZoteroMcp;
var chromeHandle;

async function startup({ id, version, rootURI }) {
  // chrome://aiops-zotero-mcp/content/ → the plugin's content/ folder, so it can open a window
  // (Zotero won't load a jar: URL as a chrome window).
  const aomStartup = Cc["@mozilla.org/addons/addon-manager-startup;1"].getService(Ci.amIAddonManagerStartup);
  chromeHandle = aomStartup.registerChrome(Services.io.newURI(rootURI + "manifest.json"), [
    ["content", "aiops-zotero-mcp", rootURI + "content/"],
  ]);
  // The startup cache keys scripts by path, not version, and Zotero only flushes it when replacing
  // an installed plugin; skip it (as Zotero does for bootstrap.js) so an upgrade never runs old code.
  // allowUnsafeURL: plugins load from jar:file: URIs (Mozilla bug 1974213), as in Zotero's own loader.
  Services.scriptloader.loadSubScriptWithOptions(rootURI + "content/aiops-zotero-mcp.js", {
    ignoreCache: true,
    allowUnsafeURL: true,
  });
  AiopsZoteroMcp.start({ id, version, rootURI });
}

function onMainWindowLoad({ window }) {
  AiopsZoteroMcp?.onMainWindowLoad(window);
}

function onMainWindowUnload({ window }) {
  AiopsZoteroMcp?.onMainWindowUnload(window);
}

function shutdown() {
  if (AiopsZoteroMcp) AiopsZoteroMcp.stop();
  AiopsZoteroMcp = undefined;
  chromeHandle?.destruct();
  chromeHandle = undefined;
}

function install() {}

function uninstall() {}
