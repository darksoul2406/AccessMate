import { SETTINGS_LIMITS } from "../profiles/profile-manager.js";

const CONTRAST_PROPERTIES = ["color", "background-color", "-webkit-text-fill-color", "text-shadow", "text-decoration-line"];
// Data only: the panel uses the same fixed palette when explaining precedence.
export const HIGH_CONTRAST_PALETTE = Object.freeze({ textColor: "#111111", backgroundColor: "#ffffff", linkColor: "#004b91" });
const isColor = (value) => value === null || (typeof value === "string" && /^#[0-9a-f]{6}$/i.test(value));
const isSpacing = (value, limits) => value === null || (typeof value === "number" && Number.isFinite(value) && value >= limits.min && value <= limits.max);
const SVG_NS = "http://www.w3.org/2000/svg";

// Rows of the Machado, Oliveira and Fernandes simulation matrices for the
// affected channel (doi:10.1109/TVCG.2009.113). The weights below redistribute
// some of that channel difference to the other channels for recolouring.
const RECOLOUR_PRESETS = Object.freeze({
  protanopia: { channel: 0, simulated: [0.152286, 1.052583, -0.204868], weights: [0, 0.15, 0.5] },
  deuteranopia: { channel: 1, simulated: [0.280085, 0.672501, 0.047413], weights: [0.15, 0, 0.5] },
  tritanopia: { channel: 2, simulated: [0.004733, 0.691367, 0.3039], weights: [0.5, 0.15, 0] },
});

function recolourMatrix({ channel, simulated, weights }) {
  const difference = simulated.map((value, index) => (index === channel ? 1 : 0) - value);
  // Keep the difference zero on neutral greys despite rounded source values.
  difference[2] = -difference[0] - difference[1];
  const rows = weights.map((weight, row) => {
    const rgb = difference.map((value, column) => (row === column ? 1 : 0) + weight * value);
    return [...rgb, 0, 0];
  });
  return [...rows.flat(), 0, 0, 0, 1, 0].map((value) => Number(value.toFixed(6))).join(" ");
}

/**
 * Apply text size, spacing, custom colours, contrast, and page colour filters.
 * The caller supplies one change-manager group for the entire preference update.
 * Page colour filters use a document-root effect with local SVG definitions.
 */
export function createVisualAdapter(changes, page = document) {
  let targets = [];
  const originallyStyleless = new Set();
  const excluded = "script, style, noscript, template, svg, math, canvas, iframe, video, audio, [aria-hidden='true']";
  const maxTargets = 5000;
  const spacingExcluded = "input,textarea,select,button,option,[role='button'],[contenteditable]:not([contenteditable='false']),pre,code,kbd,samp";
  const root = page.documentElement;
  const filterToken = Array.from(page.defaultView.crypto.getRandomValues(new Uint32Array(4)),
    (value) => value.toString(16).padStart(8, "0")).join("");
  const filterId = `accessmate-colour-${filterToken}-`;
  const filterProperty = `--${filterId}`;
  const filterModes = [...Object.keys(RECOLOUR_PRESETS), "grayscale"];
  let filterDefinitions = null;
  let filterSheet = null;

  function cleanEmptyStyles() {
    // Several tracked properties can share one inline style attribute. After
    // Undo/Restore, clean an empty attribute only if this adapter found none
    // originally. Unrelated website style properties are preserved.
    for (const element of originallyStyleless) {
      if (element.style.length === 0) {
        element.getAttribute("style");
        element.removeAttribute("style");
      }
    }
  }

  function createFilterDefinitions() {
    const svg = page.createElementNS(SVG_NS, "svg");
    svg.setAttribute("aria-hidden", "true");
    svg.setAttribute("focusable", "false");
    svg.setAttribute("data-accessmate-colour-filters", "");
    for (const [property, value] of Object.entries({ position: "absolute", width: "0", height: "0", overflow: "hidden", "pointer-events": "none" })) {
      svg.style.setProperty(property, value, "important");
    }
    const defs = page.createElementNS(SVG_NS, "defs");
    for (const [mode, preset] of Object.entries(RECOLOUR_PRESETS)) {
      const filter = page.createElementNS(SVG_NS, "filter");
      filter.id = filterId + mode;
      filter.setAttribute("color-interpolation-filters", "linearRGB");
      const matrix = page.createElementNS(SVG_NS, "feColorMatrix");
      matrix.setAttribute("type", "matrix");
      matrix.setAttribute("values", recolourMatrix(preset));
      filter.append(matrix);
      defs.append(filter);
    }
    svg.append(defs);
    return svg;
  }

  function currentFilter() {
    const style = root.style.getPropertyValue("filter");
    return filterModes.find((mode) => style.includes(`${filterProperty}${mode},`));
  }

  function sync() {
    cleanEmptyStyles();
    const mode = currentFilter();
    if (!mode) {
      filterDefinitions?.remove();
      if (filterSheet && page.adoptedStyleSheets.includes(filterSheet)) {
        page.adoptedStyleSheets = page.adoptedStyleSheets.filter((sheet) => sheet !== filterSheet);
      }
      return;
    }
    if (mode === "grayscale") filterDefinitions?.remove();
    else {
      filterDefinitions ??= createFilterDefinitions();
      if (!filterDefinitions.isConnected) page.body.append(filterDefinitions);
    }
    if (!filterSheet) {
      filterSheet = new page.defaultView.CSSStyleSheet();
      const declarations = filterModes.map((name) => {
        const effect = name === "grayscale" ? "grayscale(1)" : `url("#${filterId}${name}")`;
        return `${filterProperty}${name}: ${effect};`;
      });
      // Outside this media query the inline filter falls back to neutral brightness.
      filterSheet.replaceSync(`@media (forced-colors: none) { :root { ${declarations.join(" ")} } }`);
    }
    if (!page.adoptedStyleSheets.includes(filterSheet)) page.adoptedStyleSheets = [...page.adoptedStyleSheets, filterSheet];
  }

  function inspectRootFilter(existingTransitions) {
    const style = page.defaultView.getComputedStyle(root);
    void style.filter;
    for (const animation of root.getAnimations()) {
      if (animation instanceof page.defaultView.CSSTransition && animation.transitionProperty === "filter" &&
        animation.effect?.target === root && !existingTransitions.has(animation)) animation.finish();
    }
    return style.filter;
  }

  function inspectTargets(existingTransitions) {
    if (!page.body) throw new Error("The page body is not ready.");
    const result = [];
    let limited = false;
    for (const element of [page.body, ...page.body.querySelectorAll("*")]) {
      if (!(element instanceof page.defaultView.HTMLElement) || element.closest(excluded)) continue;
      if (element.matches("input[type='hidden']")) continue;
      const hasText = [...element.childNodes].some(
        (node) => node.nodeType === 3 && node.nodeValue.trim().length > 0,
      );
      if (!hasText && !element.matches("input, textarea, select, button, option, a[href], summary, [role='link'], [role='button']")) continue;
      if (result.length >= maxTargets) { limited = true; break; }
      const style = page.defaultView.getComputedStyle(element);
      // Resolve styles first: restoring an original font can start a new CSS
      // transition whose first frame still has AccessMate's enlarged size.
      // Finish only font transitions created by this measurement, never an
      // existing transition, a pseudo-element effect, or a scripted animation.
      void style.fontSize;
      for (const animation of element.getAnimations()) {
        if (animation instanceof page.defaultView.CSSTransition &&
          animation.transitionProperty === "font-size" && animation.effect?.target === element &&
          !existingTransitions.has(animation)) animation.finish();
      }
      const size = Number.parseFloat(style.fontSize);
      if (Number.isFinite(size) && size > 0) result.push({
        element, size, complexBackground: style.backgroundImage !== "none",
      });
    }
    return {
      targets: result, limited,
      foundations: [page.documentElement, page.body].map((element) => ({
        element, complexBackground: page.defaultView.getComputedStyle(element).backgroundImage !== "none",
      })),
    };
  }

  function resetContrast(element) {
    for (const property of CONTRAST_PROPERTIES) changes.resetProperty(element, property);
  }

  return Object.freeze({
    apply({ textScale, highContrast, textColor = null, backgroundColor = null, lineHeight = null, letterSpacing = null, colorFilter = "none" }) {
      const { min, max } = SETTINGS_LIMITS.textScale;
      if (typeof textScale !== "number" || !Number.isFinite(textScale) || textScale < min || textScale > max ||
        typeof highContrast !== "boolean" || !isColor(textColor) || !isColor(backgroundColor) ||
        (colorFilter !== "none" && !filterModes.includes(colorFilter)) ||
        !isSpacing(lineHeight, SETTINGS_LIMITS.lineHeight) || !isSpacing(letterSpacing, SETTINGS_LIMITS.letterSpacing)) throw new TypeError("Invalid visual preferences.");
      // The fixed contrast mode takes precedence without discarding custom
      // settings. A null custom component preserves the corresponding site value.
      const foreground = highContrast ? HIGH_CONTRAST_PALETTE.textColor : textColor;
      const background = highContrast ? HIGH_CONTRAST_PALETTE.backgroundColor : backgroundColor;
      const colorsRequested = foreground !== null || background !== null;

      // Measure without earlier AccessMate styles, avoiding repeated enlargement.
      // This also respects CSS/inline updates that the website made in the meantime.
      const existingTransitions = new Set(page.getAnimations().filter(
        (animation) => animation instanceof page.defaultView.CSSTransition,
      ));
      const inspected = changes.withOriginalStyles(() => {
        cleanEmptyStyles();
        const baseline = inspectTargets(existingTransitions);
        if (colorFilter !== "none") baseline.rootFilter = inspectRootFilter(existingTransitions);
        return baseline;
      });
      for (const { element } of [...inspected.targets, ...inspected.foundations]) {
        if (!element.hasAttribute("style")) originallyStyleless.add(element);
      }
      const current = new Set(inspected.targets.map((target) => target.element));
      for (const { element } of targets) {
        if (!current.has(element)) {
          changes.resetProperty(element, "font-size");
          changes.resetProperty(element, "line-height");
          changes.resetProperty(element, "letter-spacing");
          resetContrast(element);
        }
      }
      let contrastSkipped = 0;
      for (const { element, size, complexBackground } of inspected.targets) {
        if (textScale === 100) changes.resetProperty(element, "font-size");
        else changes.setStyle(element, "font-size", Number((size * textScale / 100).toFixed(4)) + "px");

        // Compact controls, editable content and code can depend on exact text
        // metrics. Preserve their spacing, including text nested inside them.
        // Also skip containing text blocks: spacing is inherited, so changing
        // such a block could otherwise change a nested button or code fragment.
        const supportedSpacing = !element.closest(spacingExcluded) && !element.querySelector(spacingExcluded);
        if (lineHeight === null || !supportedSpacing) changes.resetProperty(element, "line-height");
        else changes.setStyle(element, "line-height", String(lineHeight));
        if (letterSpacing === null || !supportedSpacing) changes.resetProperty(element, "letter-spacing");
        else changes.setStyle(element, "letter-spacing", String(letterSpacing) + "em");

        if (!colorsRequested || complexBackground) {
          resetContrast(element);
          if (colorsRequested && complexBackground) contrastSkipped++;
          continue;
        }
        const isLink = Boolean(element.closest("a[href], [role='link']"));
        if (foreground !== null) {
          changes.setStyle(element, "color", highContrast && isLink ? HIGH_CONTRAST_PALETTE.linkColor : foreground);
          changes.setStyle(element, "-webkit-text-fill-color", "currentColor");
          changes.setStyle(element, "text-shadow", "none");
        } else for (const property of ["color", "-webkit-text-fill-color", "text-shadow"]) changes.resetProperty(element, property);
        if (background !== null) changes.setStyle(element, "background-color", background);
        else changes.resetProperty(element, "background-color");
        if (isLink) changes.setStyle(element, "text-decoration-line", "underline");
        else changes.resetProperty(element, "text-decoration-line");
      }

      // Colour the page foundation without removing its image backgrounds.
      for (const { element, complexBackground } of inspected.foundations) {
        if (background !== null && !complexBackground) changes.setStyle(element, "background-color", background);
        else changes.resetProperty(element, "background-color");
      }
      if (colorFilter === "none") changes.resetProperty(root, "filter");
      else {
        // A filter on the document root keeps fixed descendants viewport-relative.
        const original = inspected.rootFilter === "none" ? "" : inspected.rootFilter + " ";
        changes.setStyle(root, "filter", `${original}var(${filterProperty}${colorFilter}, brightness(1))`);
      }
      targets = inspected.targets;
      return { limited: inspected.limited, targetCount: targets.length, contrastSkipped };
    },
    hasColorFilter() { return Boolean(currentFilter()) && !page.defaultView.matchMedia("(forced-colors: active)").matches; },
    sync,
  });
}
