/**
 * The library assistant window (Tools → Library assistant…). Its document is a plain shell
 * (addon/static/assistant.xhtml, served at chrome://aiops-zotero-mcp/content/ by bootstrap.js);
 * the plugin builds the chat into it from here.
 */
import { libraryChatConfig, mountChat, setDraft, stopChatByKey, unmountChat } from "./chat.js";

const URL = "chrome://aiops-zotero-mcp/content/assistant.xhtml";
let win: Window | undefined;

export function openLibraryAssistant(draft?: string): void {
  const config = libraryChatConfig();
  if (win && !win.closed) {
    win.focus();
    if (draft) setDraft(config.key, draft);
    return;
  }
  const main = Zotero.getMainWindow();
  if (!main) return;
  const opened = main.openDialog(URL, "aiops-library-assistant", "chrome,resizable,centerscreen,dialog=no,width=620,height=760");
  if (!opened) return;
  win = opened;
  opened.addEventListener(
    "load",
    () => {
      const root = opened.document.getElementById("root");
      if (!root) return;
      mountChat(root, opened.document, config, () => {}, "calc(100vh - 220px)");
      if (draft) setDraft(config.key, draft);
      // Only now: the initial about:blank page also fires unload when the real document replaces it.
      opened.addEventListener(
        "unload",
        () => {
          unmountChat(root);
          // A change can't wait for approval in a window that's gone.
          stopChatByKey(config.key);
          if (win === opened) win = undefined;
        },
        { once: true },
      );
    },
    { once: true },
  );
}

export function closeLibraryAssistant(): void {
  if (win && !win.closed) win.close();
  win = undefined;
}
