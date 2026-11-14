// Zotero 7+ bootstrapped plugin. The bundle (content/aiops-zotero-mcp.js) defines AiopsZoteroMcp.
var AiopsZoteroMcp;

async function startup({ id, version, rootURI }) {
  Services.scriptloader.loadSubScript(rootURI + "content/aiops-zotero-mcp.js");
  AiopsZoteroMcp.start({ id, version, rootURI });
}

function shutdown() {
  if (AiopsZoteroMcp) AiopsZoteroMcp.stop();
  AiopsZoteroMcp = undefined;
}

function install() {}

function uninstall() {}
