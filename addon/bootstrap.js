// Zotero 7+ bootstrapped plugin. The bundle (content/aiops-zotero-mcp.js) defines AiopsZoteroMcp.
var AiopsZoteroMcp;

async function startup({ id, version, rootURI }) {
  // The startup cache keys scripts by path, not version, and Zotero only flushes it when replacing
  // an installed plugin; skip it (as Zotero does for bootstrap.js) so an upgrade never runs old code.
  // allowUnsafeURL: plugins load from jar:file: URIs (Mozilla bug 1974213), as in Zotero's own loader.
  Services.scriptloader.loadSubScriptWithOptions(rootURI + "content/aiops-zotero-mcp.js", {
    ignoreCache: true,
    allowUnsafeURL: true,
  });
  AiopsZoteroMcp.start({ id, version, rootURI });
}

function shutdown() {
  if (AiopsZoteroMcp) AiopsZoteroMcp.stop();
  AiopsZoteroMcp = undefined;
}

function install() {}

function uninstall() {}
