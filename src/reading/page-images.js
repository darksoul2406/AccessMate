import { IMAGE_LIMITS } from "../shared/messages.js";

/** Inspect only rendered images in the current document. Keep their URLs private to this script. */
export function createPageImages(page = document) {
  const view = page.defaultView;
  let listId = null;
  let targets = new Map();

  function boundsOf(image) {
    if (!image.isConnected || !image.complete || !image.naturalWidth ||
      image.closest("[hidden], [inert], [contenteditable]:not([contenteditable='false'])") ||
      !image.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })) return null;
    if (view.visualViewport && view.visualViewport.scale !== 1) return null;
    const rect = image.getBoundingClientRect();
    const viewportWidth = view.innerWidth;
    const viewportHeight = view.innerHeight;
    const left = Math.max(0, rect.left), top = Math.max(0, rect.top);
    const right = Math.min(viewportWidth, page.documentElement.clientWidth, rect.right);
    const bottom = Math.min(viewportHeight, page.documentElement.clientHeight, rect.bottom);
    if (right - left < 16 || bottom - top < 16) return null;
    // Exclude images covered by a dialog, overlay, or other page element.
    const visible = [[.5, .5], [.12, .12], [.88, .12], [.12, .88], [.88, .88]].every(([x, y]) =>
      page.elementFromPoint(left + (right - left) * x, top + (bottom - top) * y) === image,
    );
    return visible ? { left, top, right, bottom, viewportWidth, viewportHeight } : null;
  }

  function descriptionOf(image) {
    const normalize = (text = "") => text.replace(/\s+/g, " ").trim().slice(0, IMAGE_LIMITS.description);
    const label = normalize(image.getAttribute("aria-label") ?? "") || normalize(image.alt);
    const figure = image.closest("figure");
    const caption = figure?.querySelector(":scope > figcaption");
    return label || (caption?.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true }) ? normalize(caption.innerText) : "");
  }

  return Object.freeze({
    list() {
      const items = [];
      targets = new Map();
      listId = view.crypto.randomUUID();
      const images = page.images;
      let limited = images.length > IMAGE_LIMITS.inspected;
      for (let index = 0; index < Math.min(images.length, IMAGE_LIMITS.inspected); index++) {
        const image = images[index];
        if (!boundsOf(image)) continue;
        if (items.length >= IMAGE_LIMITS.items) { limited = true; break; }
        const id = "image-" + (items.length + 1);
        const description = descriptionOf(image);
        const label = `Image ${items.length + 1} · ` + (description ? description.slice(0, 80) : `${image.naturalWidth} × ${image.naturalHeight}`);
        items.push({ id, label, hasDescription: Boolean(description) });
        targets.set(id, { image, source: image.currentSrc, description });
      }
      return { listId, items, limited };
    },
    details(expectedList, targetId) {
      const record = targets.get(targetId);
      if (listId !== expectedList || !record || record.image.currentSrc !== record.source ||
        descriptionOf(record.image) !== record.description) throw new Error("The image changed.");
      const bounds = boundsOf(record.image);
      if (!bounds) throw new Error("The image is no longer visible.");
      return { listId, targetId, description: record.description, bounds };
    },
  });
}
