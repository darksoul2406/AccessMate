import { extractReadableText } from "./text-extractor.js";

/** A text snapshot in an isolated modal view. Original page nodes stay intact. */
export function createReadingMode(changes, page = document, onUpdate = () => {}) {
  const view = page.defaultView;
  const marker = "--accessmate-reader-" + view.crypto.randomUUID();
  let dialog = null, snapshot = null, previousFocus = null, published = "";
  const observer = new view.MutationObserver(() => {
    if (dialog && (!dialog.isConnected || !dialog.open)) closeFromView();
  });
  const enabled = () => page.documentElement.style.getPropertyValue(marker) === "enabled";
  const getStatus = () => ({ enabled: !!dialog?.isConnected && dialog.open,
    characters: dialog ? snapshot?.text.length ?? 0 : 0, truncated: dialog ? snapshot?.truncated ?? false : false });
  function publish() {
    const status = getStatus(), serialized = JSON.stringify(status);
    if (serialized !== published) { published = serialized; onUpdate(status); }
  }
  function removeView() {
    observer.disconnect();
    const owned = dialog;
    dialog = null; snapshot = null;
    if (owned) { if (owned.open) owned.close(); owned.remove(); }
    if (previousFocus?.isConnected && typeof previousFocus.focus === "function") previousFocus.focus({ preventScroll: true });
    previousFocus = null;
  }
  function prepare() {
    if ([...page.querySelectorAll("dialog[open], [role='dialog'][aria-modal='true'], [role='alertdialog'][aria-modal='true']")].some((element) =>
      element instanceof view.HTMLDialogElement || (element.getClientRects().length && view.getComputedStyle(element).visibility === "visible"))) {
      throw new Error("Close the website dialog before opening reading mode.");
    }
    const result = extractReadableText("page", page);
    if (!result.text.trim()) throw new Error("No supported page text is available for reading mode.");
    return result;
  }
  function closeFromView() {
    if (!dialog) return;
    changes.run("Close reading mode", () => changes.resetProperty(page.documentElement, marker));
    sync();
  }
  function openView() {
    const result = snapshot ?? prepare();
    const host = page.createElement("dialog");
    host.setAttribute("aria-label", "AccessMate reading mode");
    host.setAttribute("data-accessmate-reading-mode", "");
    // These are new, owned nodes. Inline resets protect the outer shells from
    // website selectors; a constructed shadow stylesheet protects the reader.
    host.style.cssText = "all:initial!important;display:block!important;position:fixed!important;inset:0!important;margin:0!important;padding:0!important;border:0!important;width:100vw!important;height:100dvh!important;max-width:none!important;max-height:none!important;overflow:auto!important;visibility:visible!important;opacity:1!important;background:#fff!important;color:#111!important;box-sizing:border-box!important;";
    const shell = page.createElement("div");
    shell.style.cssText = "all:initial!important;display:block!important;visibility:visible!important;opacity:1!important;";
    const shadow = shell.attachShadow({ mode: "open", delegatesFocus: true });
    const sheet = new view.CSSStyleSheet();
    sheet.replaceSync(`
      :host { color-scheme:light; }
      * { box-sizing:border-box; }
      .reader { font:1.125rem/1.8 system-ui,sans-serif; color:#111; background:#fff;
        max-inline-size:72ch; margin-inline:auto; padding:clamp(.75rem,3vw,2rem); overflow-wrap:anywhere; }
      header { display:flex; flex-wrap:wrap; align-items:start; gap:1rem; }
      h1 { flex:1 1 15ch; font-size:1.7em; line-height:1.3; margin:0; }
      button { font:inherit; color:#111; background:#fff; border:2px solid #333; border-radius:.3rem;
        min-block-size:44px; padding:.35em .7em; cursor:pointer; max-inline-size:100%; }
      button:focus-visible { outline:3px solid #005fcc; outline-offset:3px; }
      p { margin-block:1em; white-space:pre-wrap; }
      .note { font-size:.9em; }
      @media(forced-colors:active) { button { border-color:ButtonText; } }
    `);
    shadow.adoptedStyleSheets = [sheet];
    const container = page.createElement("section"); container.className = "reader";
    const header = page.createElement("header");
    const title = page.createElement("h1"); title.textContent = page.title.trim().slice(0, 200) || "Reading mode";
    const close = page.createElement("button"); close.type = "button"; close.textContent = "Close reading mode";
    close.addEventListener("click", closeFromView);
    header.append(title, close);
    const note = page.createElement("p"); note.className = "note";
    note.textContent = "AccessMate text snapshot. Close or press Escape to return. In the extension panel, choose Main page content to read this view aloud." +
      (result.truncated ? " Some content was omitted due to reading limits." : "");
    const article = page.createElement("article"); article.setAttribute("aria-label", "Page text");
    article.lang = result.lang;
    // Text is never interpreted as markup or used to build executable content.
    const paragraph = page.createElement("p"); paragraph.textContent = result.text;
    article.append(paragraph); container.append(header, note, article);
    shadow.append(container); host.append(shell);
    previousFocus = page.activeElement;
    snapshot = result; dialog = host;
    host.addEventListener("cancel", (event) => { event.preventDefault(); closeFromView(); });
    host.addEventListener("close", () => { if (dialog === host) closeFromView(); });
    try {
      page.body.append(host); host.showModal(); close.focus({ preventScroll: true });
      observer.observe(page.documentElement, { childList: true, subtree: true });
      observer.observe(host, { attributes: true, attributeFilter: ["open"] });
    } catch (error) { removeView(); throw error; }
  }
  function sync() {
    if (!enabled()) removeView();
    else if (!dialog?.isConnected || !dialog.open) { if (dialog) removeView(); openView(); }
    publish();
  }
  return Object.freeze({
    setEnabled(value) {
      if (typeof value !== "boolean") throw new TypeError("Invalid reading-mode preference.");
      if (value) {
        if (!dialog) snapshot = prepare();
        changes.setStyle(page.documentElement, marker, "enabled");
      } else changes.resetProperty(page.documentElement, marker);
      sync();
    },
    sync,
    getStatus,
    getText(source) {
      if (!getStatus().enabled) return null;
      return source === "page" ? { ...snapshot } : { source: "selection", text: "", lang: snapshot.lang, truncated: false };
    },
  });
}
