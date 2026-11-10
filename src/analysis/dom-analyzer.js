const identities = new WeakMap();
let nextIdentity = 0;
const ignored = "script, style, noscript, template";

/**
 * Analyze the top document's light DOM. No field values or raw page content are
 * returned. The digest compares structure, text, and semantic attributes, not
 * inline appearance styles changed by AccessMate. Identity detects replacement
 * of otherwise identical nodes. Digests are session-local, not persistent IDs.
 */
export async function analyzeDOM(page = document) {
  const elements = [...page.querySelectorAll("*")].filter((element) => !element.closest(ignored));
  const structure = elements.map((element) => {
    if (!identities.has(element)) identities.set(element, ++nextIdentity);
    const attributes = [...element.attributes]
      .filter(({ name }) => ["id", "class", "role", "alt", "type", "disabled", "href", "lang", "tabindex", "for"].includes(name) || name.startsWith("aria-"))
      .map(({ name, value }) => [name, value]).sort(([a], [b]) => a.localeCompare(b));
    const text = element.matches("input, textarea") ? "" : [...element.childNodes]
      .filter((node) => node.nodeType === 3).map((node) => node.nodeValue.replace(/\s+/g, " ").trim()).join(" ");
    return [identities.get(element), identities.get(element.parentElement) ?? 0, element.tagName, attributes, text];
  });
  const bytes = new TextEncoder().encode(JSON.stringify(structure));
  const digest = await page.defaultView.crypto.subtle.digest("SHA-256", bytes);
  const fingerprint = Array.from(new Uint8Array(digest), (value) => value.toString(16).padStart(2, "0")).join("");
  const count = (selector) => page.querySelectorAll(selector).length;
  return {
    fingerprintVersion: "dom-v1", fingerprint,
    elements: elements.length,
    headings: Object.fromEntries([1, 2, 3, 4, 5, 6].map((level) => ["h" + level, count("h" + level)])),
    forms: count("form"), links: count("a[href]"), buttons: count("button, [role='button']"),
    fields: count("input:not([type='hidden']), select, textarea"),
    landmarks: count("main, nav, header, footer, aside, [role='main'], [role='navigation'], [role='banner'], [role='contentinfo'], [role='complementary']"),
  };
}
