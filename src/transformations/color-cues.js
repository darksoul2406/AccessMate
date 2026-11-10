export const CUE_LIMITS = Object.freeze({ inspected: 500, anchors: 200 });
const candidates = "[required], [aria-required], [aria-invalid], input[type='checkbox'], input[type='radio'], [aria-checked], [aria-selected]";
const excluded = "[hidden], [inert], [aria-hidden='true'], script, style, noscript, template, svg, math, canvas, iframe, option, optgroup";
const requiredRoles = new Set(["checkbox", "combobox", "gridcell", "listbox", "radiogroup", "spinbutton", "textbox", "tree", "columnheader", "rowheader", "searchbox", "switch", "treegrid"]);
const checkedRoles = new Set(["checkbox", "radio", "menuitemcheckbox", "menuitemradio", "switch"]);
const selectedRoles = new Set(["option", "tab", "row", "gridcell", "columnheader", "rowheader", "treeitem"]);
// Order is also border precedence when an item declares several states.
const states = Object.freeze([
  { id: "invalid", text: "Invalid", icon: "!", pattern: "dashed" },
  { id: "required", text: "Required", icon: "*", pattern: "dotted" },
  { id: "mixed", text: "Mixed", icon: "−", pattern: "groove" },
  { id: "selected", text: "Selected", icon: "◆", pattern: "double" },
  { id: "checked", text: "Checked", icon: "✓", pattern: "solid" },
]);

/**
 * Visible non-colour cues derived only from native/ARIA states, never RGB values
 * or form contents. Generated tags use an empty speech alternative: original
 * accessible names and already-exposed control states remain the source for AT.
 * No nodes, labels, values, validation attributes, or focus styles are replaced.
 */
export function createColorCueAdapter(changes, page = document, onUpdate = () => {}) {
  const view = page.defaultView;
  const token = view.crypto.randomUUID();
  const attribute = "data-accessmate-cues-" + token;
  const markers = Object.fromEntries(["addLabels", "addIcons", "addPatterns"].map((key) => [key, "--accessmate-" + key.toLowerCase() + "-" + token]));
  const records = new Map();
  const observer = new view.MutationObserver(() => schedule(60));
  let serial = 0;
  let sheet = null;
  let previousRules = "";
  let timer = null;
  let busy = false;
  let listening = false;
  let published = "";
  let status = emptyStatus();
  const belongs = (element) => element instanceof view.HTMLElement && element.getRootNode() === page;
  const value = (element, name) => element.getAttribute(name)?.trim().toLowerCase();
  const role = (element) => value(element, "role")?.split(/\s+/)[0];
  const flags = () => Object.fromEntries(Object.entries(markers).map(([key, marker]) => [key, page.documentElement.style.getPropertyValue(marker) === "enabled"]));
  const active = () => Object.values(flags()).some(Boolean);

  function emptyStatus() {
    return { addLabels: false, addIcons: false, addPatterns: false, elements: 0, states: 0, labels: 0, icons: 0, patterns: 0, skipped: 0, limited: false };
  }

  function declaredStates(element) {
    const found = new Set();
    const nativeField = element instanceof view.HTMLInputElement || element instanceof view.HTMLSelectElement || element instanceof view.HTMLTextAreaElement;
    const input = element instanceof view.HTMLInputElement;
    const elementRole = role(element);
    if (value(element, "aria-invalid") === "true") found.add("invalid");
    if ((nativeField && element.required && (!input || !["hidden", "range", "color", "button", "submit", "reset", "image"].includes(element.type))) ||
      ((nativeField || requiredRoles.has(elementRole)) && value(element, "aria-required") === "true")) found.add("required");
    if (input && ["checkbox", "radio"].includes(element.type)) {
      if (element.type === "checkbox" && element.indeterminate) found.add("mixed");
      else if (element.checked) found.add("checked");
    } else if (checkedRoles.has(elementRole)) {
      const checked = value(element, "aria-checked");
      if (checked === "mixed" && ["checkbox", "menuitemcheckbox"].includes(elementRole)) found.add("mixed");
      else if (checked === "true") found.add("checked");
    }
    if (selectedRoles.has(elementRole) && value(element, "aria-selected") === "true") found.add("selected");
    return found;
  }

  function visible(element) {
    if (!belongs(element) || element.closest(excluded) || element.matches("input[type='hidden']") ||
      element.closest("[aria-disabled='true']") || element.matches(":disabled") || !element.getClientRects().length) return false;
    const style = view.getComputedStyle(element);
    return style.display !== "none" && style.visibility === "visible";
  }

  function slot(element) {
    if (!visible(element) || !view.CSS.supports("content", '"cue" / ""')) return null;
    // Replaced/native controls cannot reliably display generated tags.
    if (element.matches("input, select, textarea, img, video, audio, br, hr, table, thead, tbody, tfoot, tr, col, colgroup")) return null;
    for (const side of ["after", "before"]) {
      const content = view.getComputedStyle(element, "::" + side).content;
      if (content === "none" || content === "normal") return { element, side };
    }
    return null;
  }

  function anchorFor(element) {
    if (element instanceof view.HTMLInputElement || element instanceof view.HTMLSelectElement || element instanceof view.HTMLTextAreaElement) {
      for (const label of element.labels ?? []) {
        const available = slot(label);
        if (available) return available;
      }
      return null;
    }
    // Table row states are tagged in a cell, keeping native table structure.
    if (element.localName === "tr") return slot(element.querySelector(":scope > th, :scope > td"));
    return slot(element);
  }

  function release(record) {
    if (record.element.getAttribute(attribute) !== record.id) return;
    if (record.original === null) record.element.removeAttribute(attribute);
    else record.element.setAttribute(attribute, record.original);
  }

  function schedule(delay = 500) {
    if (!active() || timer !== null || busy) return;
    timer = view.setTimeout(() => { timer = null; sync(); }, delay);
  }

  function sync() {
    if (busy) return;
    busy = true;
    observer.disconnect();
    if (timer !== null) { view.clearTimeout(timer); timer = null; }
    try {
      // Inspect the site's own pseudo-elements without our sheet masking them.
      if (sheet && page.adoptedStyleSheets.includes(sheet)) page.adoptedStyleSheets = page.adoptedStyleSheets.filter((entry) => entry !== sheet);
      const enabled = flags();
      status = { ...emptyStatus(), ...enabled };
      const groups = new Map();
      if (Object.values(enabled).some(Boolean)) {
        const elements = page.querySelectorAll(candidates);
        if (elements.length > CUE_LIMITS.inspected) status.limited = true;
        for (let index = 0; index < Math.min(elements.length, CUE_LIMITS.inspected); index++) {
          const element = elements[index];
          const declared = declaredStates(element);
          if (!declared.size) continue;
          if (!visible(element)) { status.skipped++; continue; }
          const anchor = anchorFor(element);
          if (!anchor) { status.skipped++; continue; }
          const existing = records.get(anchor.element);
          if (anchor.element.hasAttribute(attribute) && anchor.element.getAttribute(attribute) !== existing?.id) { status.skipped++; continue; }
          let group = groups.get(anchor.element);
          if (!group) {
            if (groups.size >= CUE_LIMITS.anchors) { status.limited = true; status.skipped++; continue; }
            group = { ...anchor, states: new Set(), elements: 0 };
            groups.set(anchor.element, group);
          }
          for (const state of declared) group.states.add(state);
          group.elements++;
        }
      }
      for (const [element, record] of records) {
        if (!groups.has(element)) { release(record); records.delete(element); }
      }
      const rules = [];
      for (const [element, group] of groups) {
        let record = records.get(element);
        if (!record) {
          record = { element, id: "cue" + ++serial, original: element.getAttribute(attribute) };
          records.set(element, record);
        }
        if (element.getAttribute(attribute) !== record.id) element.setAttribute(attribute, record.id);
        const cues = states.filter((state) => group.states.has(state.id));
        const content = cues.map((state) => [enabled.addIcons ? state.icon : "", enabled.addLabels ? state.text : ""].filter(Boolean).join(" ")).filter(Boolean).join(" · ");
        const border = enabled.addPatterns ? `${["double", "groove"].includes(cues[0].pattern) ? "4px" : "2px"} ${cues[0].pattern} #111111` : "0";
        rules.push(`[${attribute}="${record.id}"]::${group.side} {
          all: initial !important; content: ${JSON.stringify(content)} / "" !important;
          display: inline-block !important; box-sizing: border-box !important;
          font: inherit !important; font-weight: 700 !important; line-height: 1.4 !important;
          color: #111111 !important; background: #ffffff !important;
          -webkit-text-fill-color: currentColor !important; text-shadow: none !important;
          border: ${border} !important; border-radius: .2em !important;
          margin-inline-start: .35em !important; padding: .08em .3em !important;
          min-inline-size: 1em !important; min-block-size: 1em !important; max-inline-size: 100% !important;
          vertical-align: baseline !important; white-space: normal !important;
          overflow-wrap: anywhere !important; pointer-events: none !important;
          direction: inherit !important; unicode-bidi: isolate !important;
        }`);
        status.elements += group.elements;
        status.states += cues.length;
        if (enabled.addLabels) status.labels += cues.length;
        if (enabled.addIcons) status.icons += cues.length;
        if (enabled.addPatterns) status.patterns++;
      }
      if (rules.length) {
        if (!sheet) sheet = new view.CSSStyleSheet();
        const css = rules.join("\n");
        if (css !== previousRules) { sheet.replaceSync(css); previousRules = css; }
        page.adoptedStyleSheets = [...page.adoptedStyleSheets, sheet];
      }
      const anyEnabled = Object.values(enabled).some(Boolean);
      if (anyEnabled) {
        observer.observe(page.documentElement, { subtree: true, childList: true, attributes: true,
          attributeFilter: ["required", "disabled", "readonly", "hidden", "inert", "type", "role", "aria-required", "aria-invalid", "aria-selected", "aria-checked", "aria-disabled", "aria-hidden", "id", "for", "class", "style"] });
      }
      if (anyEnabled && !listening) {
        for (const event of ["input", "change", "focusin", "focusout"]) page.addEventListener(event, onEvent, true);
        view.addEventListener("resize", onEvent);
        listening = true;
      } else if (!anyEnabled && listening) {
        for (const event of ["input", "change", "focusin", "focusout"]) page.removeEventListener(event, onEvent, true);
        view.removeEventListener("resize", onEvent);
        listening = false;
      }
      const serialized = JSON.stringify(status);
      if (serialized !== published) { published = serialized; onUpdate({ ...status }); }
    } finally { busy = false; schedule(); }
  }
  function onEvent() { schedule(60); }

  return Object.freeze({
    apply(preferences) {
      if (!preferences || Object.keys(markers).some((key) => typeof preferences[key] !== "boolean")) throw new TypeError("Invalid colour cue preferences.");
      for (const [key, marker] of Object.entries(markers)) {
        if (preferences[key]) changes.setStyle(page.documentElement, marker, "enabled");
        else changes.resetProperty(page.documentElement, marker);
      }
    },
    sync,
    getStatus: () => ({ ...status }),
  });
}
