export const MEDIA_LIMIT = 100;

/**
 * Main-document HTML media only. No source URLs, playback positions, volume,
 * native controls, or autoplay attributes are changed. Playback exceptions are
 * explicit and local to this document; allowing an item never calls play().
 *
 * Private style properties let the existing change manager undo mode/exception
 * edits as a group. Media effects are synchronized only after that group commits.
 * Muting records its prior value; releasing restrictions never resumes playback.
 */
export function createMediaAdapter(changes, page = document) {
  const token = page.defaultView.crypto.randomUUID();
  const stopMarker = "--accessmate-media-stop-" + token;
  const muteMarker = "--accessmate-media-mute-" + token;
  const allowMarker = "--accessmate-media-allow-" + token;
  const records = new Map();
  const byId = new Map();
  let ordinal = 0;
  let listening = false;
  let limited = false;
  let stopAutoplay = false;
  let muteAudio = false;
  const observer = new page.defaultView.MutationObserver(() => sync());
  const enabled = (marker) => page.documentElement.style.getPropertyValue(marker) === "enabled";
  const allowed = (record) => record.element.style.getPropertyValue(allowMarker) === "enabled";
  const belongs = (element) => element instanceof page.defaultView.HTMLMediaElement && element.getRootNode() === page;

  function releaseMute(record) {
    if (!record.ownsMute) return;
    record.ownsMute = false;
    // Preserve a website/user change that has not yet delivered volumechange.
    if (record.element.muted === true) record.element.muted = record.muteBaseline;
  }

  function register(element) {
    if (!belongs(element)) return null;
    if (records.has(element)) return records.get(element);
    if (records.size >= MEDIA_LIMIT) { limited = true; return null; }
    const record = {
      element, id: page.defaultView.crypto.randomUUID(),
      label: `${element.localName === "video" ? "Video" : "Audio"} ${++ordinal}`,
      ownsMute: false, muteBaseline: false,
    };
    records.set(element, record);
    byId.set(record.id, record);
    return record;
  }

  function enforce(record) {
    const element = record.element;
    if (muteAudio) {
      if (!record.ownsMute) {
        record.muteBaseline = element.muted;
        record.ownsMute = true;
      } else if (!element.muted) record.muteBaseline = false;
      if (!element.muted) element.muted = true;
    } else releaseMute(record);
    if (stopAutoplay && !allowed(record) && !element.paused) element.pause();
  }

  function onMediaEvent(event) {
    const record = register(event.target);
    if (record) enforce(record);
  }

  function sync() {
    stopAutoplay = enabled(stopMarker);
    muteAudio = enabled(muteMarker);
    for (const [element, record] of records) {
      if (belongs(element)) continue;
      releaseMute(record);
      records.delete(element);
      byId.delete(record.id);
    }
    const elements = page.querySelectorAll("video, audio");
    limited = elements.length > MEDIA_LIMIT;
    for (const element of elements) register(element);
    const active = stopAutoplay || muteAudio;
    if (active && !listening) {
      // play/volumechange do not bubble; capture also covers new media elements.
      page.addEventListener("play", onMediaEvent, true);
      page.addEventListener("volumechange", onMediaEvent, true);
      observer.observe(page.documentElement, { childList: true, subtree: true });
      listening = true;
    } else if (!active && listening) {
      page.removeEventListener("play", onMediaEvent, true);
      page.removeEventListener("volumechange", onMediaEvent, true);
      observer.disconnect();
      listening = false;
    }
    for (const record of records.values()) enforce(record);
  }

  return Object.freeze({
    apply({ stopAutoplay: stop, muteAudio: mute }) {
      if (typeof stop !== "boolean" || typeof mute !== "boolean") throw new TypeError("Invalid media preferences.");
      for (const [marker, value] of [[stopMarker, stop], [muteMarker, mute]]) {
        if (value) changes.setStyle(page.documentElement, marker, "enabled");
        else changes.resetProperty(page.documentElement, marker);
      }
      if (!stop) for (const record of records.values()) changes.resetProperty(record.element, allowMarker);
    },
    setAllowed(id, value) {
      const record = byId.get(id);
      if (typeof value !== "boolean" || !enabled(stopMarker) || !record || !belongs(record.element)) {
        throw new Error("Refresh the media list and enable Stop autoplay before changing playback exceptions.");
      }
      if (value) changes.setStyle(record.element, allowMarker, "enabled");
      else changes.resetProperty(record.element, allowMarker);
    },
    sync,
    getStatus() {
      return {
        stopAutoplay, muteAudio, limited,
        items: [...records.values()].map((record) => ({
          id: record.id, kind: record.element.localName, label: record.label,
          allowed: allowed(record), paused: record.element.paused, muted: record.element.muted,
        })),
      };
    },
  });
}
