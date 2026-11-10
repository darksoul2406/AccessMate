import { READING_LIMITS } from "../shared/messages.js";

const EXCLUDED = "script, style, noscript, template, svg, math, canvas, iframe, form, input, textarea, select, button, [contenteditable]:not([contenteditable='false']), [hidden], [inert], [aria-hidden='true']";
const CHROME = "nav, header, footer, aside, [role='navigation'], [role='dialog'], [role='alertdialog']";

/** Read visible text nodes only; never input values, HTML, or hidden content. */
export function extractReadableText(source, page = document) {
  if (!["page", "selection"].includes(source)) throw new TypeError("Invalid reading source.");
  const view = page.defaultView;
  const excluded = EXCLUDED + (source === "page" ? ", " + CHROME : "");
  const visibility = new WeakMap();
  function visible(element) {
    if (!element || !(element instanceof view.HTMLElement) || element.closest(excluded)) return false;
    if (visibility.has(element)) return visibility.get(element);
    const style = view.getComputedStyle(element);
    const result = style.display !== "none" && style.visibility === "visible" && Number(style.opacity) !== 0 &&
      (!element.parentElement || visible(element.parentElement));
    visibility.set(element, result);
    return result;
  }
  let root = page.body;
  if (source === "page") {
    for (const candidate of [...page.querySelectorAll("main, [role='main'], article")].slice(0, 30)) {
      if (visible(candidate)) { root = candidate; break; }
    }
  }
  const ranges = [];
  if (source === "selection") {
    const selection = page.getSelection();
    if (selection && !selection.isCollapsed) for (let i = 0; i < Math.min(selection.rangeCount, 10); i++) ranges.push(selection.getRangeAt(i).cloneRange());
  }
  const result = { source, text: "", lang: (root?.lang || page.documentElement.lang || "").slice(0, 64), truncated: false };
  if (!root || (source === "selection" && !ranges.length)) return result;
  let inspected = 0;
  const walker = page.createTreeWalker(root, view.NodeFilter.SHOW_ELEMENT | view.NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      if (node.nodeType === view.Node.ELEMENT_NODE) return visible(node) ? view.NodeFilter.FILTER_ACCEPT : view.NodeFilter.FILTER_REJECT;
      return visible(node.parentElement) ? view.NodeFilter.FILTER_ACCEPT : view.NodeFilter.FILTER_REJECT;
    },
  });
  let node;
  while ((node = walker.nextNode())) {
    if (++inspected > READING_LIMITS.nodes) { result.truncated = true; break; }
    if (node.nodeType !== view.Node.TEXT_NODE) continue;
    const bounds = page.createRange();
    bounds.selectNodeContents(node);
    if (![...bounds.getClientRects()].some((rect) => rect.width > 0 && rect.height > 0)) continue;
    let text = node.data;
    if (source === "selection") {
      text = ranges.filter((range) => range.intersectsNode(node)).map((range) => {
        const part = bounds.cloneRange();
        if (range.compareBoundaryPoints(view.Range.START_TO_START, part) > 0) part.setStart(range.startContainer, range.startOffset);
        if (range.compareBoundaryPoints(view.Range.END_TO_END, part) < 0) part.setEnd(range.endContainer, range.endOffset);
        return part.toString();
      }).join(" ");
    }
    text = text.replace(/\s+/g, " ").trim();
    if (!text) continue;
    const remaining = READING_LIMITS.characters - result.text.length;
    const addition = (result.text ? "\n" : "") + text;
    if (addition.length > remaining) { result.text += addition.slice(0, remaining); result.truncated = true; break; }
    result.text += addition;
  }
  result.text = result.text.replace(/[\uD800-\uDBFF]$/, "");
  return result;
}
