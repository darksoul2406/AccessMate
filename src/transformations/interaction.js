import { SETTINGS_LIMITS } from "../profiles/profile-manager.js";

/**
 * Reversible minimum control sizes, larger cursors, and keyboard-focus decoration.
 * Focus uses native :focus-visible. Tab order, roles, and focus movement stay
 * with the website/browser; pointer clicks do not force a ring.
 *
 * The requested mode is a tracked custom property, so one undo group can include
 * this mode and visual preferences. The stylesheet is a reversible projection
 * of that mode, not a new history entry every time the user presses Tab.
 */
export function createInteractionAdapter(changes, page = document) {
  const token = Array.from(page.defaultView.crypto.getRandomValues(new Uint32Array(4)),
    (value) => value.toString(16)).join("");
  const marker = "--accessmate-focus-" + token;
  const cursorMarker = "--accessmate-cursor-" + token;
  const cursorAttribute = "data-accessmate-cursor-" + token;
  const cursorRecords = new Map();
  const originallyStyleless = new Set();
  const observer = new page.defaultView.MutationObserver(schedule);
  let sizeTargets = [], timer = null, listening = false, busy = false, serial = 0;
  let sheet = null;
  const cursorImages = new Map();
  function image(size, hand) {
    const key = size + String(hand);
    if (!cursorImages.has(key)) {
      const path = hand ? "M12 29V16L8 12Q6 9 8 8Q9 7 11 9L13 12V4Q13 1 16 2Q18 2 18 5V12Q21 10 22 13Q25 11 26 15Q29 14 29 18L27 29Z" : "M3 2L3 27L10 20L15 30L20 27L15 18L25 18Z";
      const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 32 32"><path d="${path}" fill="none" stroke="white" stroke-width="4" stroke-linejoin="round"/><path d="${path}" fill="${hand ? "white" : "black"}" stroke="black" stroke-width="1.5" stroke-linejoin="round"/></svg>`;
      const hotX = Math.round((hand ? 16 : 3) * size / 32), hotY = Math.round(2 * size / 32);
      cursorImages.set(key, `url("data:image/svg+xml,${encodeURIComponent(svg)}") ${hotX} ${hotY}, ${hand ? "pointer" : "auto"}`);
    }
    return cursorImages.get(key);
  }
  const cursorMode = () => page.documentElement.style.getPropertyValue(cursorMarker).trim();
  function schedule() {
    if (busy || timer !== null || !["large", "extra-large"].includes(cursorMode())) return;
    timer = page.defaultView.setTimeout(() => { timer = null; sync(); }, 100);
  }
  function release(record) {
    if (record.element.getAttribute(cursorAttribute) !== record.id) return;
    if (record.original === null) record.element.removeAttribute(cursorAttribute);
    else record.element.setAttribute(cursorAttribute, record.original);
  }
  function cleanEmptyStyles() {
    for (const element of originallyStyleless) if (element.style.length === 0) {
      element.getAttribute("style"); element.removeAttribute("style");
    }
  }

  function sync() {
    if (busy) return;
    busy = true;
    observer.disconnect();
    if (timer !== null) { page.defaultView.clearTimeout(timer); timer = null; }
    try {
      cleanEmptyStyles();
      // Inspect the site's current cursors without our stylesheet masking them.
      if (sheet) page.adoptedStyleSheets = page.adoptedStyleSheets.filter((entry) => entry !== sheet);
      const enabled = page.documentElement.style.getPropertyValue(marker) === "enabled";
      const mode = cursorMode(), customCursor = ["large", "extra-large"].includes(mode);
      const rules = enabled ? `
          :focus-visible {
            outline: 3px solid #005fcc !important;
            outline-offset: 3px !important;
            box-shadow: 0 0 0 3px #ffffff !important;
          }
          @media (forced-colors: active) {
            :focus-visible { outline-color: Highlight !important; box-shadow: none !important; }
          }
        ` : "";
      const current = new Set();
      const cursorValues = [];
      if (customCursor) {
        const elements = page.querySelectorAll("*");
        for (let index = 0; index < Math.min(elements.length, 3000); index++) {
          const element = elements[index];
          const existing = cursorRecords.get(element);
          if (element.hasAttribute(cursorAttribute) && element.getAttribute(cursorAttribute) !== existing?.id) continue;
          const original = page.defaultView.getComputedStyle(element).cursor;
          // Preserve text, resize, wait, disabled, custom-image and other semantic
          // cursors. Explicit baseline rules prevent inheritance from our arrows.
          const protectedCursor = element.closest("textarea,[contenteditable]:not([contenteditable='false']),[role='textbox']") ||
            (element.matches("input") && !["button", "submit", "reset", "checkbox", "radio"].includes(element.type)) ||
            element.shadowRoot || element.localName.includes("-") || element.matches("iframe,canvas,svg,math,:disabled,[aria-disabled='true']");
          const value = !protectedCursor && ["auto", "default", "pointer"].includes(original) ? image(mode === "large" ? 32 : 48, original === "pointer") : original;
          const record = existing ?? { element, id: "cursor" + ++serial, original: element.getAttribute(cursorAttribute) };
          cursorRecords.set(element, record); current.add(element);
          if (element.getAttribute(cursorAttribute) !== record.id) element.setAttribute(cursorAttribute, record.id);
          cursorValues.push([record.id, value]);
        }
      }
      for (const [element, record] of cursorRecords) if (!current.has(element)) { release(record); cursorRecords.delete(element); }
      if (rules || cursorValues.length) {
        if (!sheet) sheet = new page.defaultView.CSSStyleSheet();
        sheet.replaceSync(rules);
        for (const [id, value] of cursorValues) {
          const index = sheet.insertRule(`[${cursorAttribute}="${id}"] {}`, sheet.cssRules.length);
          // Use CSSOM for website-derived values; never interpolate them as CSS.
          sheet.cssRules[index].style.setProperty("cursor", value, "important");
        }
        page.adoptedStyleSheets = [...page.adoptedStyleSheets, sheet];
      }
      if (customCursor) observer.observe(page.documentElement, { subtree: true, childList: true, attributes: true,
        attributeFilter: ["class", "id", "style", "disabled", "aria-disabled", "href", "type", "contenteditable"] });
      if (customCursor !== listening) {
        for (const event of ["pointerover", "focusin"]) page[customCursor ? "addEventListener" : "removeEventListener"](event, schedule, true);
        page.defaultView[customCursor ? "addEventListener" : "removeEventListener"]("resize", schedule);
        listening = customCursor;
      }
    } finally { busy = false; }
  }
  function setFocus(enabled) {
    if (typeof enabled !== "boolean") throw new TypeError("Invalid focus preference.");
    if (!page.documentElement.hasAttribute("style")) originallyStyleless.add(page.documentElement);
    if (enabled) changes.setStyle(page.documentElement, marker, "enabled");
    else changes.resetProperty(page.documentElement, marker);
  }

  return Object.freeze({
    setEnabled(enabled) {
      setFocus(enabled);
      sync();
    },
    apply({ highlightFocus, targetSize = null, cursorSize = "original" }) {
      const limits = SETTINGS_LIMITS.targetSize;
      if ((targetSize !== null && (typeof targetSize !== "number" || !Number.isFinite(targetSize) || targetSize < limits.min || targetSize > limits.max)) ||
        !["original", "large", "extra-large"].includes(cursorSize) || typeof highlightFocus !== "boolean") throw new TypeError("Invalid interaction preferences.");
      setFocus(highlightFocus);
      if (cursorSize === "original") changes.resetProperty(page.documentElement, cursorMarker);
      else changes.setStyle(page.documentElement, cursorMarker, cursorSize);
      const candidates = [...page.querySelectorAll("button,input,select,textarea,a[href],[role='button']")].slice(0, 2000);
      // Measure authored minimums with the current font customization. Restoring
      // every original style would otherwise measure em-based minimums at the
      // old font size, potentially shrinking a larger authored control.
      const fonts = new Map(candidates.map((element) => [element, { value: element.style.getPropertyValue("font-size"), priority: element.style.getPropertyPriority("font-size") }]));
      const existingAnimations = new Set(page.getAnimations());
      const measured = changes.withOriginalStyles(() => {
        const baselineFonts = new Map();
        try {
          for (const [element, font] of fonts) {
            baselineFonts.set(element, { value: element.style.getPropertyValue("font-size"), priority: element.style.getPropertyPriority("font-size") });
            if (font.value) element.style.setProperty("font-size", font.value, font.priority);
            else element.style.removeProperty("font-size");
            void page.defaultView.getComputedStyle(element).fontSize;
            for (const animation of element.getAnimations()) if (animation instanceof page.defaultView.CSSTransition &&
              animation.transitionProperty === "font-size" && animation.effect?.target === element && !existingAnimations.has(animation)) animation.finish();
          }
          return candidates.filter((element) => element instanceof page.defaultView.HTMLElement &&
            !element.closest("[hidden],[inert],[aria-hidden='true'],[aria-disabled='true'],[contenteditable]:not([contenteditable='false'])") &&
            !element.matches(":disabled,input[type='hidden'],input[type='checkbox'],input[type='radio'],input[type='range'],input[type='color'],input[type='file'],input[type='image']") &&
            element.getClientRects().length && !["inline", "contents", "none"].includes(page.defaultView.getComputedStyle(element).display)
          ).map((element) => {
            const style = page.defaultView.getComputedStyle(element);
            return { element, minWidth: style.minWidth, minHeight: style.minHeight };
          });
        } finally {
          for (const [element, font] of baselineFonts) {
            if (font.value) element.style.setProperty("font-size", font.value, font.priority);
            else element.style.removeProperty("font-size");
          }
        }
      });
      const current = new Set(measured.map(({ element }) => element));
      for (const element of sizeTargets) if (!current.has(element)) {
        changes.resetProperty(element, "min-width"); changes.resetProperty(element, "min-height");
      }
      for (const { element, minWidth, minHeight } of measured) {
        if (!element.hasAttribute("style")) originallyStyleless.add(element);
        for (const [property, minimum] of [["min-width", minWidth], ["min-height", minHeight]]) {
          if (targetSize === null) changes.resetProperty(element, property);
          else changes.setStyle(element, property, page.defaultView.CSS.supports(property, `max(${minimum}, ${targetSize}px)`) ? `max(${minimum}, ${targetSize}px)` : targetSize + "px");
        }
      }
      sizeTargets = [...current];
    },
    // Undo/Restore change tracked modes; reflect them in focus/cursor decoration.
    sync,
  });
}
