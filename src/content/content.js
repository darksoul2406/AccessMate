import { createChangeManager } from "../transformations/change-manager.js";
import { createVisualAdapter } from "../transformations/visual.js";
import { createInteractionAdapter } from "../transformations/interaction.js";
import { createSensoryAdapter } from "../transformations/sensory.js";
import { createMediaAdapter } from "../transformations/media.js";
import { createMotionAdapter } from "../transformations/motion.js";
import { createColorCueAdapter } from "../transformations/color-cues.js";
import { createDistractionAdapter } from "../transformations/distractions.js";
import { scanAccessibility } from "../analysis/accessibility-scanner.js";
import { extractReadableText } from "../reading/text-extractor.js";
import { createReadingMode } from "../reading/reading-mode.js";
import { createPageNavigator } from "../navigation/page-navigation.js";
import { createPageImages } from "../reading/page-images.js";
import { PAGE_CHANNEL, createPageMessage, isPageMessage } from "../shared/messages.js";
import { SETTINGS_LIMITS } from "../profiles/profile-manager.js";

// One controller per document in the extension's isolated JavaScript world.
const sessionKey = "__accessmatePageSessionV1";
if (!globalThis[sessionKey]) {
  const sessionId = crypto.randomUUID();
  const changes = createChangeManager();
  // Track the requested browser zoom in the SAME undo group as page styles.
  // This private custom property has no visual CSS effect. The panel projects
  // its validated value through Chrome's tab zoom API after each command.
  const zoomMarker = "--accessmate-page-zoom-" + sessionId;
  const requestedZoom = () => {
    const value = document.documentElement.style.getPropertyValue(zoomMarker).trim();
    const percentage = Number(value);
    return value && Number.isFinite(percentage) && percentage >= SETTINGS_LIMITS.zoom.min && percentage <= SETTINGS_LIMITS.zoom.max ? percentage : null;
  };
  const navigator = createPageNavigator();
  const pageImages = createPageImages();
  const visual = createVisualAdapter(changes);
  const interaction = createInteractionAdapter(changes);
  const sensory = createSensoryAdapter(changes);
  const media = createMediaAdapter(changes);
  // Reloading the extension disconnects scripts already running in open tabs.
  // sendMessage can throw before returning a Promise, so catch both forms of
  // failure here. A missing panel must not interrupt webpage adaptations either.
  async function publishUpdate(type, details) {
    try {
      if (!chrome.runtime.id) return;
      await chrome.runtime.sendMessage({ type, sessionId, url: location.href, ...details });
    } catch {
      // The user can reconnect this page by refreshing it after an extension reload.
    }
  }
  const cues = createColorCueAdapter(changes, document, (status) => {
    void publishUpdate("ACCESSMATE_CUES_UPDATED", { cues: status });
  });
  const motion = createMotionAdapter(changes, document, (status) => {
    void publishUpdate("ACCESSMATE_MOTION_UPDATED", { motion: status });
  });
  const distractions = createDistractionAdapter(changes, document, (status) => {
    void publishUpdate("ACCESSMATE_DISTRACTIONS_UPDATED", { distractions: status });
  });
  const reader = createReadingMode(changes, document, (readingMode) => {
    queueMicrotask(() => { void publishUpdate("ACCESSMATE_READING_MODE_UPDATED", { readingMode, ...changes.getStatus() }); });
  });
  let visualCoverage = { limited: false, targetCount: 0, contrastSkipped: 0 };
  let work = Promise.resolve();
  let preferencesApplied = false;

  function queuePageCommand(message, automatic = false) {
    // Serialize scanning and adaptations, including commands from other open
    // extension views, so a scan is not mixed with a text-size preview.
    const task = work.then(async () => {
      if (message.url !== location.href || (message.action !== "status" && message.sessionId !== sessionId)) {
        throw new Error("The page session changed.");
      }
      if (automatic && preferencesApplied) return null;
      let report;
      if (["navigation-list", "navigation-focus"].includes(message.action)) {
        const navigation = message.action === "navigation-list" ? navigator.list(message.category) : navigator.focus(message.listId, message.targetId);
        if (message.url !== location.href) throw new Error("Page changed during navigation.");
        return { ok: true, sessionId, url: location.href, navigation };
      }
      if (message.action === "read-text") {
        // Reading is a read-only operation, without adapter synchronization or
        // history changes. Text goes only to the requesting extension panel.
        return { ok: true, sessionId, url: location.href, reading: reader.getText(message.source) ?? extractReadableText(message.source) };
      }
      if (message.action === "image-list" || message.action === "image-details") {
        if (reader.getStatus().enabled) throw new Error("Close Reading Mode before choosing an image.");
        const images = message.action === "image-list" ? pageImages.list() : pageImages.details(message.listId, message.targetId);
        return { ok: true, sessionId, url: location.href, images };
      }
      if (message.action === "reading-mode") {
        try { changes.run("Reading mode", () => reader.setEnabled(message.enabled)); }
        catch (error) { reader.sync(); throw error; }
      }
      if (message.action === "scan") {
        report = await scanAccessibility({
          pageSessionId: sessionId,
          phase: changes.getStatus().changedProperties > 0 ? "after" : "before",
        });
        if (visual.hasColorFilter()) report.coverage.unsupportedAreas.push("Review filtered colours visually. The scan uses underlying page styles for contrast.");
      }
      if (message.action === "preview") {
        const previousCoverage = visualCoverage;
        try {
          if (message.reduceMotion) motion.capture();
          changes.run(automatic ? "Automatically applied site preferences" : "Appearance, distractions, colour cues, motion, and media preferences", () => {
            visualCoverage = visual.apply({
              textScale: message.textScale, highContrast: message.highContrast,
              lineHeight: message.lineHeight, letterSpacing: message.letterSpacing,
              textColor: message.textColor, backgroundColor: message.backgroundColor,
              colorFilter: message.colorFilter,
            });
            interaction.apply({ highlightFocus: message.highlightFocus, targetSize: message.targetSize, cursorSize: message.cursorSize });
            sensory.apply({ reduceMotion: message.reduceMotion, reduceFlashing: message.reduceFlashing });
            motion.apply({ enabled: message.reduceMotion, behavior: message.motionBehavior });
            media.apply({ stopAutoplay: message.stopAutoplay, muteAudio: message.muteAudio });
            cues.apply({ addLabels: message.addLabels, addIcons: message.addIcons, addPatterns: message.addPatterns });
            distractions.apply(message.distractions);
            if (message.zoom === null) changes.resetProperty(document.documentElement, zoomMarker);
            else changes.setStyle(document.documentElement, zoomMarker, String(message.zoom));
          });
          preferencesApplied = true;
        } catch (error) {
          visualCoverage = previousCoverage;
          interaction.sync();
          sensory.sync(motion.sync);
          media.sync();
          visual.sync();
          cues.sync();
          distractions.sync();
          throw error;
        }
      }
      if (message.action === "allow-media" || message.action === "restrict-media") {
        changes.run("Media playback exception", () => media.setAllowed(message.mediaId, message.action === "allow-media"));
      }
      if (["undo", "restore"].includes(message.action)) {
        preferencesApplied = true;
        navigator.clearFocus();
      }
      if (message.action === "undo") changes.undo();
      if (message.action === "restore") changes.restore();
      interaction.sync();
      sensory.sync(motion.sync);
      media.sync();
      visual.sync();
      cues.sync();
      distractions.sync();
      reader.sync();
      if (message.url !== location.href) throw new Error("The page changed during the request.");
      const response = { ok: true, sessionId, url: location.href, zoom: requestedZoom(), ...changes.getStatus(), ...visualCoverage, media: media.getStatus(), motion: motion.getStatus(), cues: cues.getStatus(), distractions: distractions.getStatus(), readingMode: reader.getStatus() };
      if (report) response.report = report;
      return response;
    });
    work = task.then(() => {}, () => {});
    return task;
  }

  // The worker calls this entry point only in AccessMate's isolated world.
  // Both application paths use the same validation and change history.
  Object.defineProperty(globalThis, "__accessmateApplySavedProfileV1", {
    value: (url, preferences) => queuePageCommand(createPageMessage("preview", { ...preferences, url, sessionId }), true),
  });

  chrome.runtime.onMessage.addListener((message, sender, respond) => {
    if (
      sender.id !== chrome.runtime.id || sender.tab ||
      sender.url?.split("#")[0] !== chrome.runtime.getURL("panel/panel.html") ||
      !message || message.channel !== PAGE_CHANNEL
    ) return;
    if (!isPageMessage(message)) {
      respond({ ok: false, error: "Invalid AccessMate page command." });
      return;
    }
    const task = queuePageCommand(message);
    // A navigation can close the message port while a scan is still completing.
    const reply = (value) => { try { respond(value); } catch {} };
    void task.then(reply, () => reply({
      ok: false,
      error: message.action === "scan"
        ? "The scan could not complete. The page may have changed; try again."
        : message.action === "reading-mode" ? "Reading mode could not open. Close any website dialog first and check that the page contains readable text."
        : "The page could not apply those accessibility preferences. Refresh the media list if the item changed.",
    }));
    // Keep the response channel alive for asynchronous scans on Chrome 116+.
    return true;
  });
  Object.defineProperty(globalThis, sessionKey, { value: sessionId });
}
