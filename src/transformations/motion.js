import { MOTION_BEHAVIORS } from "../shared/contracts.js";

export const MOTION_LIMITS = Object.freeze({ images: 50, inspectedImages: 2000, animations: 100, imagePixels: 1000000, totalPixels: 4000000, anonymousLoads: 4, loadTimeout: 10000 });
const essential = "a[href], button, input, select, textarea, label, summary, [tabindex], [contenteditable], [role='button'], [role='link'], [role='status'], [role='alert'], [role='progressbar'], [aria-live]:not([aria-live='off'])";

/**
 * One tracked mode drives reversible projections onto existing DOM objects.
 * Static previews are local PNGs. A CORS-permitted anonymous reload of the
 * selected image may be used; there are no DOM replacements or new permissions.
 * Cross-origin/CSP failures stay unchanged and are counted, never bypassed.
 * Only opaque counts leave this module; source URLs and frames stay in memory.
 */
export function createMotionAdapter(changes, page = document, onUpdate = () => {}) {
  const view = page.defaultView;
  const marker = "--accessmate-extra-motion-" + view.crypto.randomUUID();
  const images = new Map();
  const animations = new Map();
  const hidden = new Map();
  const pendingLoads = new Set();
  let mode = null;
  let timer = null;
  let listening = false;
  let syncing = false;
  let limited = false;
  let pixels = 0;
  let lastPublished = "";
  let status = emptyStatus();
  const observer = new view.MutationObserver(() => schedule());
  const belongs = (element) => element instanceof view.HTMLElement && element.getRootNode() === page;
  const attrs = (image) => ({ src: image.getAttribute("src"), srcset: image.getAttribute("srcset") });
  const sameAttrs = (a, b) => a.src === b.src && a.srcset === b.srcset;
  const gifSource = (image) => {
    // A GIF fallback can be displayed as WebP by a responsive <picture>.
    const isGIF = (source) => {
      if (/^data:image\/gif[;,]/i.test(source)) return true;
      try { return /\.gif$/i.test(new URL(source, page.baseURI).pathname); }
      catch { return false; }
    };
    return [image.currentSrc, image.src].some(isGIF) ? image.currentSrc || image.src : null;
  };
  const pictureSources = (image) => image.parentElement?.localName === "picture"
    ? [...image.parentElement.children].filter((element) => element.localName === "source" &&
      (element.compareDocumentPosition(image) & view.Node.DOCUMENT_POSITION_FOLLOWING))
    : [];
  const sourceState = (image) => pictureSources(image).map((element) => ({
    element, media: element.getAttribute("media"), srcset: element.getAttribute("srcset"),
    type: element.getAttribute("type"), sizes: element.getAttribute("sizes"),
  }));
  const sameSources = (record, active = record.active) => {
    const current = sourceState(record.image);
    return current.length === record.sources.length && current.every((source, index) => {
      const original = record.sources[index];
      return source.element === original.element && source.srcset === original.srcset &&
        source.type === original.type && source.sizes === original.sizes &&
        source.media === (active ? "not all" : original.media);
    });
  };
  const decorative = (element) => {
    if (element.closest(essential) || element.querySelector(essential)) return false;
    return element.closest("[aria-hidden='true'], [role='presentation'], [role='none']") !== null ||
      (element instanceof view.HTMLImageElement && element.hasAttribute("alt") && element.alt.trim() === "");
  };

  function emptyStatus() {
    return { enabled: false, behavior: "pause", imagesPaused: 0, imagesHidden: 0, animationsPaused: 0, animationsHidden: 0, protectedItems: 0, unavailable: 0, limited: false };
  }

  function restoreImage(record) {
    if (!record.active) return;
    record.active = false;
    const changedSource = record.image.getAttribute("src") !== record.staticURL;
    // Restore each attribute only while it still has AccessMate's value.
    for (const [name, expected] of [["src", record.staticURL], ["srcset", record.staticURL + " 1x"]]) {
      // A new website source must not be overridden by an old responsive set.
      if (name === "srcset" && changedSource) {
        if (record.image.getAttribute(name) === expected) record.image.removeAttribute(name);
        continue;
      }
      if (record.image.getAttribute(name) !== expected) continue;
      const original = record.original[name];
      if (original === null) record.image.removeAttribute(name);
      else record.image.setAttribute(name, original);
    }
    // Responsive selectors must be disabled for a PNG fallback to take effect.
    // Restore only our media override, preserving a site's edited source set.
    if (!changedSource) for (const source of record.sources) {
      if (source.element.getAttribute("media") !== "not all") continue;
      if (source.media === null) source.element.removeAttribute("media");
      else source.element.setAttribute("media", source.media);
    }
  }

  function fitsBudget(record, image) {
    const area = image.naturalWidth * image.naturalHeight;
    if (area > MOTION_LIMITS.imagePixels || pixels + area > MOTION_LIMITS.totalPixels) {
      limited = true;
      record.failed = true;
      return false;
    }
    return area > 0;
  }

  function captureFrame(record, image) {
    // naturalWidth/Height on a responsive <img> include srcset density
    // correction. Preserve those intrinsic dimensions in the PNG, even when
    // the anonymously loaded file has smaller physical pixel dimensions.
    if (!fitsBudget(record, record.image)) return false;
    const width = record.image.naturalWidth;
    const height = record.image.naturalHeight;
    const canvas = page.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    try {
      canvas.getContext("2d").drawImage(image, 0, 0, width, height);
      record.staticURL = canvas.toDataURL("image/png");
      record.pixels = width * height;
      pixels += record.pixels;
      return true;
    } catch (error) {
      if (error.name === "SecurityError") record.needsAnonymous = true;
      else record.failed = true;
      return false;
    } finally { canvas.width = canvas.height = 0; }
  }

  function cancelLoad(record, retry = false) {
    const pending = record.pending;
    if (!pending) return;
    record.pending = null;
    if (retry) record.anonymousTried = false;
    pendingLoads.delete(pending);
    view.clearTimeout(pending.timeout);
    pending.image.onload = pending.image.onerror = null;
    pending.image.removeAttribute("src");
  }

  function anonymousFrame(record) {
    if (record.pending || record.anonymousTried || pendingLoads.size >= MOTION_LIMITS.anonymousLoads) return;
    const selected = record.image.currentSrc || record.image.src;
    try { if (!["http:", "https:"].includes(new URL(selected).protocol)) { record.failed = true; return; } }
    catch { record.failed = true; return; }
    if (!fitsBudget(record, record.image)) return;
    record.anonymousTried = true;
    const image = new view.Image();
    image.crossOrigin = "anonymous";
    image.referrerPolicy = "no-referrer";
    const pending = { image, timeout: null };
    record.pending = pending;
    pendingLoads.add(pending);
    const valid = () => record.pending === pending && images.get(record.image) === record && belongs(record.image) &&
      MOTION_BEHAVIORS.includes(page.documentElement.style.getPropertyValue(marker)) &&
      !(page.documentElement.style.getPropertyValue(marker) === "hide" && decorative(record.image)) &&
      sameAttrs(attrs(record.image), record.original) && sameSources(record, false) &&
      (record.image.currentSrc || record.image.src) === selected;
    const finish = (loaded) => {
      if (valid()) {
        const aspectError = Math.abs(image.naturalWidth * record.image.naturalHeight - image.naturalHeight * record.image.naturalWidth);
        if (!loaded || !image.naturalWidth || aspectError > image.naturalWidth + image.naturalHeight ||
          !captureFrame(record, image)) record.failed = true;
      }
      cancelLoad(record);
      schedule();
    };
    image.onload = () => finish(true);
    image.onerror = () => finish(false);
    pending.timeout = view.setTimeout(() => finish(false), MOTION_LIMITS.loadTimeout);
    // Reload only the already-selected image. Cross-origin cookies are omitted;
    // the browser still requires the server's CORS approval and the page's CSP.
    image.src = selected;
  }

  function freezeImage(record) {
    if (record.active) return true;
    if (record.failed) return false;
    const image = record.image;
    if (!image.complete || !image.naturalWidth) return false;
    if (!record.staticURL && !record.needsAnonymous) captureFrame(record, image);
    if (!record.staticURL) {
      if (record.needsAnonymous && !record.failed) anonymousFrame(record);
      return false;
    }
    for (const source of record.sources) source.element.setAttribute("media", "not all");
    record.active = true;
    // An explicit 1x fallback also clears the density inherited from a picture
    // source's width descriptor, preventing the static image from being scaled
    // a second time when the browser reports its intrinsic size.
    image.setAttribute("srcset", record.staticURL + " 1x");
    image.setAttribute("src", record.staticURL);
    return true;
  }

  const opacity = (element) => ({ value: element.style.getPropertyValue("opacity"), priority: element.style.getPropertyPriority("opacity") });
  const ours = (value) => value.value === "0" && value.priority === "important";
  function hide(element) {
    let record = hidden.get(element);
    const actual = opacity(element);
    if (!record) {
      record = { element, baseline: actual, hadStyle: element.hasAttribute("style") };
      hidden.set(element, record);
    } else if (!ours(actual)) {
      record.baseline = actual;
      record.hadStyle = element.hasAttribute("style");
    }
    if (!ours(actual)) element.style.setProperty("opacity", "0", "important");
  }
  function unhide(record) {
    if (!ours(opacity(record.element))) return;
    const { value, priority } = record.baseline;
    if (value) record.element.style.setProperty("opacity", value, priority);
    else record.element.style.removeProperty("opacity");
    if (!record.hadStyle && record.element.style.length === 0) {
      record.element.getAttribute("style");
      record.element.removeAttribute("style");
    }
  }

  const signature = (animation) => JSON.stringify({ frames: animation.effect?.getKeyframes(), timing: animation.effect?.getTiming(), rate: animation.playbackRate });
  function pause(record) {
    const animation = record.animation;
    const current = signature(animation);
    if (record.owned && (current !== record.signature ||
      (!record.settling && animation.playState === "paused" && animation.currentTime !== record.time))) record.owned = false;
    if (animation.playState !== "running") return;
    try {
      animation.pause();
      record.owned = true;
      record.time = animation.currentTime;
      record.signature = current;
      record.settling = animation.pending;
      const revision = record.revision = (record.revision ?? 0) + 1;
      if (record.settling) void animation.ready.then(() => {
        if (record.owned && record.revision === revision && animation.playState === "paused" && signature(animation) === record.signature) {
          // Native pause commits on the animation timeline. Its settled hold
          // time can differ slightly from the time read immediately after pause.
          record.time = animation.currentTime;
          record.settling = false;
        }
      }, () => { if (record.revision === revision) record.owned = false; });
    } catch { record.failed = true; }
  }
  function resume(record) {
    const animation = record.animation;
    if (record.owned && animation.playState === "paused" && animation.currentTime === record.time &&
      signature(animation) === record.signature) {
      // A site-paused, cancelled, finished, retimed, or otherwise edited effect
      // is never started. Continue only the playback AccessMate itself paused.
      void animation.play();
    }
    record.owned = false;
  }

  function capture() {
    for (const animation of page.getAnimations()) {
      const target = animation.effect?.target;
      if (!belongs(target) || animation instanceof view.CSSTransition || animation.effect.pseudoElement) continue;
      if (animations.has(animation)) continue;
      if (animations.size >= MOTION_LIMITS.animations) { limited = true; break; }
      animations.set(animation, { animation, target, css: animation instanceof view.CSSAnimation, owned: false, failed: false });
    }
  }

  function onImageEvent(event) {
    const record = images.get(event.target);
    if (event.type === "error" && record?.active) {
      restoreImage(record);
      record.failed = true;
    }
    schedule();
  }
  function schedule() {
    if (!mode || timer !== null || syncing) return;
    timer = view.setTimeout(() => { timer = null; sync(); }, 250);
  }

  function sync() {
    if (syncing) return;
    syncing = true;
    try {
      const requested = page.documentElement.style.getPropertyValue(marker);
      mode = MOTION_BEHAVIORS.includes(requested) ? requested : null;
      if (timer !== null) { view.clearTimeout(timer); timer = null; }
      status = emptyStatus();
      if (!mode) {
        observer.disconnect();
        page.removeEventListener("load", onImageEvent, true);
        page.removeEventListener("error", onImageEvent, true);
        listening = false;
        for (const record of images.values()) { cancelLoad(record); restoreImage(record); }
        for (const record of hidden.values()) unhide(record);
        for (const record of animations.values()) resume(record);
        images.clear(); hidden.clear(); animations.clear();
        pixels = 0; limited = false;
      } else {
        status.enabled = true;
        status.behavior = mode;
        const desiredHidden = new Set();
        for (const [image, record] of images) {
          if (!belongs(image)) {
            cancelLoad(record);
            restoreImage(record);
            pixels -= record.pixels;
            images.delete(image);
          } else if (record.active && (!sameAttrs(attrs(image), { src: record.staticURL, srcset: record.staticURL + " 1x" }) || !sameSources(record))) {
            // A website changed the source. Release the remaining owned values
            // and stop trying to replace this item until it changes again.
            cancelLoad(record);
            restoreImage(record);
            record.failed = true;
            record.original = attrs(image);
            record.sources = sourceState(image);
            record.selectedSource = null;
          } else if (!record.active && (!sameAttrs(attrs(image), record.original) || !sameSources(record, false) ||
            (image.complete && image.naturalWidth > 0 && record.selectedSource !== null &&
              (image.currentSrc || image.src) !== record.selectedSource))) {
            cancelLoad(record);
            pixels -= record.pixels;
            images.delete(image);
          } else if (record.selectedSource === null && image.complete && image.naturalWidth > 0) {
            record.selectedSource = image.currentSrc || image.src;
          }
        }
        const candidates = page.querySelectorAll("img");
        if (candidates.length > MOTION_LIMITS.inspectedImages) limited = true;
        for (let index = 0; index < Math.min(candidates.length, MOTION_LIMITS.inspectedImages); index++) {
          const image = candidates[index];
          if (images.has(image) || !gifSource(image)) continue;
          if (images.size >= MOTION_LIMITS.images) { limited = true; break; }
          images.set(image, { image, original: attrs(image), sources: sourceState(image), selectedSource: image.currentSrc || image.src,
            staticURL: null, active: false, failed: false, pixels: 0, needsAnonymous: false, anonymousTried: false, pending: null });
        }
        for (const record of images.values()) {
          if (mode === "hide" && decorative(record.image)) {
            cancelLoad(record, true);
            restoreImage(record);
            desiredHidden.add(record.image);
            status.imagesHidden++;
          } else {
            if (mode === "hide") status.protectedItems++;
            if (freezeImage(record)) status.imagesPaused++;
            else status.unavailable++;
          }
        }
        capture();
        for (const [animation, record] of animations) {
          if (!belongs(record.target) || animation.playState === "idle") {
            resume(record);
            animations.delete(animation);
            continue;
          }
          if (mode === "hide" && decorative(record.target)) {
            desiredHidden.add(record.target);
            status.animationsHidden++;
          } else if (mode === "hide") status.protectedItems++;
          // Existing CSS motion is handled by the sensory stylesheet. Never
          // pause its completion events or the font transitions used for sizing.
          if (!record.css) {
            pause(record);
            if (record.failed) status.unavailable++;
            else if (animation.playState === "paused") status.animationsPaused++;
          }
        }
        for (const [element, record] of hidden) {
          if (!desiredHidden.has(element)) { unhide(record); hidden.delete(element); }
        }
        for (const element of desiredHidden) hide(element);
        status.limited = limited;
        if (!listening) {
          page.addEventListener("load", onImageEvent, true);
          page.addEventListener("error", onImageEvent, true);
          observer.observe(page.documentElement, { subtree: true, childList: true, attributes: true, attributeFilter: ["src", "srcset", "media", "type", "sizes", "alt", "aria-hidden", "role", "tabindex", "href", "aria-live"] });
          listening = true;
        }
      }
      const serialized = JSON.stringify(status);
      if (serialized !== lastPublished) { lastPublished = serialized; onUpdate({ ...status }); }
    } finally {
      syncing = false;
      schedule();
    }
  }

  return Object.freeze({
    capture,
    apply({ enabled, behavior }) {
      if (typeof enabled !== "boolean" || !MOTION_BEHAVIORS.includes(behavior)) throw new TypeError("Invalid motion preferences.");
      if (enabled) changes.setStyle(page.documentElement, marker, behavior);
      else changes.resetProperty(page.documentElement, marker);
    },
    sync,
    getStatus: () => ({ ...status }),
  });
}
