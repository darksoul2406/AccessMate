import { NAVIGATION_CATEGORIES, NAVIGATION_LIMITS } from "../shared/messages.js";

const SELECTORS = Object.freeze({
  headings: "h1,h2,h3,h4,h5,h6,[role='heading']",
  sections: "main,nav,aside,header,footer,section,[role='main'],[role='navigation'],[role='banner'],[role='contentinfo'],[role='complementary'],[role='region'],[role='search'],[role='form']",
  links: "a[href],area[href],[role='link']",
  controls: "button,input:not([type='hidden']),select,textarea,[role='button'],[role='checkbox'],[role='radio'],[role='switch'],[role='combobox'],[role='textbox'],[role='slider'],[role='spinbutton'],[role='tab']",
});
const EXCLUDED = "script,style,noscript,template,svg,math,canvas,iframe,[hidden],[inert],[aria-hidden='true']";

/** Semantic targets only, with opaque references and bounded visible labels. */
export function createPageNavigator(page = document) {
  const view = page.defaultView;
  let currentList = null, targets = new Map(), focusRecord = null, sheet = null;
  const attribute = "data-accessmate-navigation-" + view.crypto.randomUUID();
  const observer = new view.MutationObserver(() => { if (focusRecord && !eligible(focusRecord.element)) cleanup(); });
  function visible(element) {
    if (!(element instanceof view.HTMLElement) || element.getRootNode() !== page || element.closest(EXCLUDED)) return false;
    for (let ancestor = element; ancestor; ancestor = ancestor.parentElement) {
      const style = view.getComputedStyle(ancestor);
      if (style.display === "none" || style.visibility !== "visible" || Number(style.opacity) === 0) return false;
    }
    return element.getClientRects().length > 0;
  }
  function eligible(element) {
    return element?.isConnected && visible(element) && !element.matches(":disabled") && !element.closest("[aria-disabled='true']");
  }
  function modalOpen() {
    return !!page.querySelector(":modal") || [...page.querySelectorAll("[aria-modal='true']")].some(visible);
  }
  function text(element) {
    if (!visible(element) || element.matches("input,textarea,select,[contenteditable]:not([contenteditable='false'])")) return "";
    const walker = page.createTreeWalker(element, view.NodeFilter.SHOW_TEXT);
    let result = "", node, count = 0;
    while ((node = walker.nextNode()) && ++count <= 100 && result.length < 160) {
      const parent = node.parentElement;
      if (!parent.closest("input,textarea,select,option,[contenteditable]:not([contenteditable='false'])") && visible(parent)) result += " " + node.data.slice(0, 160);
    }
    return result.replace(/\s+/g, " ").trim().slice(0, 160);
  }
  function describe(element, category) {
    const heading = /^h[1-6]$/.test(element.localName) ? element.localName.slice(1) : element.getAttribute("aria-level");
    let kind = category === "headings" ? "Heading" + (/^[1-6]$/.test(heading ?? "") ? " " + heading : "") :
      category === "links" ? "Link" : category === "sections" ? "Section" : "Control";
    if (category === "controls") {
      kind = element.localName === "input" ? ({ password: "Password field", checkbox: "Checkbox", radio: "Radio button", submit: "Submit button", file: "File input" }[element.type] ?? "Input field") :
        element.localName === "select" ? "Dropdown" : element.localName === "textarea" ? "Text area" : "Control";
    }
    let label = element.getAttribute("aria-label")?.trim().slice(0, 160) ?? "";
    if (!label) label = (element.getAttribute("aria-labelledby") ?? "").split(/\s+/).slice(0, 10).map((id) => text(page.getElementById(id))).join(" ").trim().slice(0, 160);
    if (!label && "labels" in element) label = [...(element.labels ?? [])].slice(0, 3).map(text).join(" ").trim().slice(0, 160);
    if (!label && category === "sections") label = text(element.querySelector("h1,h2,h3,h4,h5,h6,[role='heading']"));
    if (!label && category !== "sections" && !element.matches("[role='textbox'],[role='combobox'],[role='slider'],[role='spinbutton']")) label = text(element);
    return { label: label || "Unnamed " + kind.toLowerCase(), kind };
  }
  function cleanup() {
    observer.disconnect();
    const record = focusRecord; focusRecord = null;
    if (record) {
      record.element.removeEventListener("blur", cleanup);
      if (record.addedTabindex && record.element.getAttribute("tabindex") === "-1") record.element.removeAttribute("tabindex");
      if (record.element.getAttribute(attribute) === "focused") {
        if (record.previousMarker === null) record.element.removeAttribute(attribute);
        else record.element.setAttribute(attribute, record.previousMarker);
      }
    }
    if (sheet) page.adoptedStyleSheets = page.adoptedStyleSheets.filter((entry) => entry !== sheet);
  }
  view.addEventListener("pagehide", cleanup);
  return Object.freeze({
    clearFocus: cleanup,
    list(category) {
      if (!NAVIGATION_CATEGORIES.includes(category) || modalOpen()) throw new Error("Close reading mode or the website dialog before navigating.");
      const elements = page.querySelectorAll(SELECTORS[category]);
      const items = []; targets = new Map();
      const listId = view.crypto.randomUUID();
      let limited = elements.length > NAVIGATION_LIMITS.inspected;
      for (let i = 0; i < Math.min(elements.length, NAVIGATION_LIMITS.inspected); i++) {
        const element = elements[i];
        if (!eligible(element)) continue;
        if (items.length === NAVIGATION_LIMITS.items) { limited = true; break; }
        const id = "target" + items.length, description = describe(element, category);
        items.push({ id, ...description }); targets.set(id, { element, ...description });
      }
      currentList = { category, listId };
      return { category, listId, items, limited };
    },
    focus(listId, targetId) {
      const record = targets.get(targetId);
      if (!currentList || listId !== currentList.listId || !record || modalOpen() || !eligible(record.element) ||
        !record.element.matches(SELECTORS[currentList.category])) throw new Error("Navigation target changed. Refresh the list.");
      const description = describe(record.element, currentList.category);
      if (description.label !== record.label || description.kind !== record.kind) throw new Error("Navigation label changed. Refresh the list.");
      cleanup();
      const element = record.element;
      const addedTabindex = !element.hasAttribute("tabindex") && !element.matches("a[href],button,input,select,textarea,area[href]");
      if (addedTabindex) element.setAttribute("tabindex", "-1");
      focusRecord = { element, addedTabindex, previousMarker: element.getAttribute(attribute) };
      element.addEventListener("blur", cleanup, { once: true });
      element.setAttribute(attribute, "focused");
      if (!sheet) { sheet = new view.CSSStyleSheet(); sheet.replaceSync(`[${attribute}="focused"] { outline:3px solid #005fcc !important; outline-offset:3px !important; box-shadow:0 0 0 3px #ffffff !important; }`); }
      page.adoptedStyleSheets = [...page.adoptedStyleSheets, sheet];
      try {
        element.focus({ preventScroll: true });
        if (page.activeElement !== element) throw new Error("Target could not receive focus.");
        element.scrollIntoView({ block: "center", inline: "nearest", behavior: "instant" });
        observer.observe(page.documentElement, { subtree: true, childList: true, attributes: true, attributeFilter: ["hidden", "inert", "aria-hidden", "aria-disabled", "disabled", "style", "class"] });
      } catch (error) { cleanup(); throw error; }
      return { listId, targetId };
    },
  });
}
