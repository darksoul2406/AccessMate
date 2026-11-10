import { DISTRACTION_KEYS } from "../shared/messages.js";

// Match recognizable optional regions. Generic asides can contain essential content.
const SELECTORS = Object.freeze({
  ads: ".adsbygoogle, .advertisement, .ad-container, [data-ad-slot], [data-ad-client], [data-ad-unit], [data-testid='ad-slot'], [aria-label='advertisement' i], iframe[id^='google_ads_iframe']",
  banners: ".promo-banner, .promotional-banner, [data-testid='promo-banner'], [aria-label='promotional banner' i]",
  recommendations: ".recommendations, .recommended-content, [data-testid='recommendations'], [aria-label='recommended content' i]",
  popups: "#moe-push-div, .moe-push-class, #onesignal-slidedown-container, .onesignal-slidedown-container, #onesignal-popover-container, #webpushr-prompt-wrapper, #izooto-optin, .notification-prompt-wrapper, .push-notification-prompt, .promo-popup, [data-testid='promotional-popup']",
  sidebars: ".optional-sidebar, .related-sidebar, .recommended-sidebar, .related-content-sidebar, [data-testid='optional-sidebar'], [data-testid='related-sidebar'], :is(aside, [role='complementary']):is([aria-label='related articles' i], [aria-label='related content' i], [aria-label='recommended content' i])",
  clutter: ".decorative-widget, .social-share, .share-widget, .share-strip, [data-testid='decorative-widget'], [data-testid='share-strip']",
});
// Observed publisher wrappers, scoped to the exact site. In particular, do not
// hide TpGnAd_sec: it contains the site's navigation as well as its top ad.
const SITE_AD_SELECTORS = Object.freeze({
  "ndtv.com": ".TpGnAd_ad-cn, .ads-wrp, div[id^='adslot']:not([id^='adslottemp'])",
});
const POPUP_ESSENTIAL = "form, label, input, select, textarea, nav, header, footer, main, article, dialog, [popover], [role='form'], [role='search'], [role='navigation'], [role='main'], [aria-modal='true'], [contenteditable]:not([contenteditable='false']), [id*='consent' i], [class*='consent' i], [id*='cookie' i], [class*='cookie' i], [id*='login' i], [class*='login' i], [id*='checkout' i], [class*='checkout' i], [id*='payment' i], [class*='payment' i]";
const COUNT_KEYS = Object.freeze({ ads: "hiddenAds", banners: "hiddenBanners", recommendations: "hiddenRecommendations", popups: "hiddenPopups", sidebars: "hiddenSidebars", clutter: "hiddenWidgets" });
const ESSENTIAL = "form, label, input, select, textarea, nav, header, footer, main, article, dialog, [role='form'], [role='search'], [role='dialog'], [role='alertdialog'], [role='navigation'], [role='main'], [role='alert'], [aria-modal='true'], [contenteditable]:not([contenteditable='false']), [id*='consent' i], [class*='consent' i], [id*='cookie' i], [class*='cookie' i], [id*='login' i], [class*='login' i], [id*='checkout' i], [class*='checkout' i]";
const PROTECTED_ANCESTORS = "form, nav, header, footer, dialog, [role='dialog'], [role='alertdialog'], [role='navigation'], [aria-modal='true'], [id*='consent' i], [class*='consent' i], [id*='cookie' i], [class*='cookie' i], [id*='login' i], [class*='login' i], [id*='checkout' i], [class*='checkout' i]";
const SECONDARY_ESSENTIAL = "button, details, summary, iframe, audio, video, canvas, embed, object, progress, [popover], [accesskey], [aria-controls], [aria-expanded], [aria-live]:not([aria-live='off']), [role='button'], [role='switch'], [role='menu'], [role='menubar'], [role='tab'], [role='tablist'], [role='status'], [role='search'], [id*='payment' i], [class*='payment' i]";
const EMPTY_STATUS = Object.freeze({
  ...Object.fromEntries(DISTRACTION_KEYS.map((key) => [key, "allow"])),
  ...Object.fromEntries(Object.values(COUNT_KEYS).map((key) => [key, 0])),
  protectedItems: 0, unavailable: 0, limited: false,
});
export const DISTRACTION_LIMIT = 500;

/** Main-document hiding only. No nodes, form values, or network requests change. */
export function createDistractionAdapter(changes, page = document, onUpdate = () => {}) {
  const view = page.defaultView;
  const hostname = page.location.hostname.toLowerCase().replace(/^www\./, "");
  const siteAds = Object.hasOwn(SITE_AD_SELECTORS, hostname) ? SITE_AD_SELECTORS[hostname] : "";
  const selectors = { ...SELECTORS, ads: [SELECTORS.ads, siteAds].filter(Boolean).join(","),
    popups: SELECTORS.popups + (hostname === "timesofindia.indiatimes.com" ? ", #izootoCustomPopup" : "") };
  const token = view.crypto.randomUUID();
  const attribute = "data-accessmate-distraction-" + token;
  const markers = Object.fromEntries(DISTRACTION_KEYS.map((key) => [key, "--accessmate-hide-" + key + "-" + token]));
  const records = new Map();
  const observer = new view.MutationObserver(() => schedule());
  let sheet = null, timer = null, serial = 0, listening = false, busy = false, published = "";
  let status = { ...EMPTY_STATUS };
  const preferences = () => Object.fromEntries(Object.entries(markers).map(([key, marker]) => [key, page.documentElement.style.getPropertyValue(marker) === "hide" ? "hide" : "allow"]));
  function release(record) {
    if (record.element.getAttribute(attribute) !== record.id) return;
    if (record.original === null) record.element.removeAttribute(attribute);
    else record.element.setAttribute(attribute, record.original);
  }
  function schedule() {
    if (busy || timer !== null || !Object.values(preferences()).includes("hide")) return;
    timer = view.setTimeout(() => { timer = null; sync(); }, 100);
  }
  function protectedElement(element) {
    // Keep essential structure, dialogs, forms, and currently focused content.
    return element.matches(ESSENTIAL) || element.closest(PROTECTED_ANCESTORS) ||
      element.querySelector(ESSENTIAL) || element.contains(page.activeElement);
  }
  function protectedSecondary(element) {
    return element.shadowRoot || element.localName.includes("-") ||
      element.closest(SECONDARY_ESSENTIAL) || element.querySelector(SECONDARY_ESSENTIAL);
  }
  function protectedPopup(element) {
    // A known non-modal notification prompt may use role=dialog/alertdialog.
    // Preserve native/modal dialogs and anything with essential content, focus,
    // background inertness or a page scroll lock rather than strand the user.
    if (element.matches("iframe") || element.querySelector("iframe") || element.shadowRoot) return true;
    if (element.matches(POPUP_ESSENTIAL) || element.querySelector(POPUP_ESSENTIAL) || element.contains(page.activeElement)) return true;
    if (element.parentElement?.closest(PROTECTED_ANCESTORS + ", [id*='payment' i], [class*='payment' i]")) return true;
    if (page.querySelector("main[inert], [role='main'][inert], main[aria-hidden='true'], [role='main'][aria-hidden='true']")) return true;
    return [page.documentElement, page.body].some((root) => root &&
      ["hidden", "clip"].includes(view.getComputedStyle(root).overflowY) && page.documentElement.scrollHeight > view.innerHeight);
  }
  function sync() {
    if (busy) return;
    busy = true;
    observer.disconnect();
    if (timer !== null) { view.clearTimeout(timer); timer = null; }
    try {
      // Measure the site's own visibility without our hiding sheet.
      if (sheet && page.adoptedStyleSheets.includes(sheet)) page.adoptedStyleSheets = page.adoptedStyleSheets.filter((entry) => entry !== sheet);
      const modes = preferences();
      status = { ...EMPTY_STATUS, ...modes };
      const activeKeys = DISTRACTION_KEYS.filter((key) => modes[key] === "hide");
      const selected = new Set();
      if (activeKeys.length) {
        const candidates = page.querySelectorAll(activeKeys.map((key) => selectors[key]).join(","));
        status.limited = candidates.length > DISTRACTION_LIMIT;
        for (let index = 0; index < Math.min(candidates.length, DISTRACTION_LIMIT); index++) {
          const element = candidates[index];
          if (!(element instanceof view.HTMLElement) || element.getRootNode() !== page) continue;
          const isPopup = element.matches(selectors.popups);
          if (isPopup && modes.popups !== "hide") continue;
          const category = isPopup ? "popups" : activeKeys.find((key) => element.matches(selectors[key]));
          // Popup protection also applies when a notification prompt happens to
          // carry an ad/promotion class and would otherwise match another mode.
          const secondary = category === "sidebars" || category === "clutter";
          if (isPopup ? protectedPopup(element) : protectedElement(element) || (secondary && protectedSecondary(element))) {
            status.protectedItems++;
            continue;
          }
          if (element.closest("[hidden], [inert], [aria-hidden='true']") || !element.getClientRects().length || view.getComputedStyle(element).visibility !== "visible") continue;
          if ([...selected].some((parent) => parent.contains(element))) continue;
          const existing = records.get(element);
          // A site edit to even our private attribute wins over our own value.
          if (element.hasAttribute(attribute) && element.getAttribute(attribute) !== existing?.id) continue;
          selected.add(element);
          status[COUNT_KEYS[category]]++;
        }
      }
      for (const [element, record] of records) if (!selected.has(element)) { release(record); records.delete(element); }
      for (const element of selected) {
        let record = records.get(element);
        if (!record) { record = { element, id: "item" + ++serial, original: element.getAttribute(attribute) }; records.set(element, record); }
        if (element.getAttribute(attribute) !== record.id) element.setAttribute(attribute, record.id);
      }
      if (selected.size) {
        if (!sheet) {
          sheet = new view.CSSStyleSheet();
        }
        // Only the exact values currently owned by this adapter are styled.
        sheet.replaceSync([...records.values()].map((record) => `[${attribute}="${record.id}"]`).join(",") + " { display: none !important; }");
        page.adoptedStyleSheets = [...page.adoptedStyleSheets, sheet];
        // Stronger website rules (including inline !important) may win. Count
        // only containers we actually hid and leave unsuccessful targets alone.
        for (const [element, record] of records) {
          if (view.getComputedStyle(element).display === "none") continue;
          const category = element.matches(selectors.popups) ? "popups" : activeKeys.find((key) => element.matches(selectors[key]));
          status[COUNT_KEYS[category]]--;
          status.unavailable++;
          release(record);
          records.delete(element);
        }
        if (!records.size) page.adoptedStyleSheets = page.adoptedStyleSheets.filter((entry) => entry !== sheet);
      }
      if (activeKeys.length) observer.observe(page.documentElement, { subtree: true, childList: true, attributes: true,
        attributeFilter: ["class", "id", "style", "hidden", "inert", "role", "aria-label", "aria-hidden", "aria-modal", "aria-live", "aria-controls", "aria-expanded", "accesskey", "popover", "open", "contenteditable", "data-ad-slot", "data-ad-client", "data-ad-unit", "data-testid"] });
      if (!!activeKeys.length !== listening) {
        for (const event of ["focusin", "focusout"]) page[activeKeys.length ? "addEventListener" : "removeEventListener"](event, schedule, true);
        view[activeKeys.length ? "addEventListener" : "removeEventListener"]("resize", schedule);
        listening = !!activeKeys.length;
      }
      const serialized = JSON.stringify(status);
      if (serialized !== published) { published = serialized; onUpdate({ ...status }); }
    } finally { busy = false; }
  }
  return Object.freeze({
    apply(settings) {
      if (!settings || Object.keys(markers).some((key) => !["allow", "hide"].includes(settings[key]))) throw new TypeError("Invalid distraction preferences.");
      for (const [key, marker] of Object.entries(markers)) {
        if (settings[key] === "hide") changes.setStyle(page.documentElement, marker, "hide");
        else changes.resetProperty(page.documentElement, marker);
      }
    },
    sync,
    getStatus: () => ({ ...status }),
  });
}
