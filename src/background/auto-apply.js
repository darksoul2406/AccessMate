import { createProfileStorage } from "../profiles/profile-storage.js";
import { resolveSettings } from "../profiles/profile-manager.js";
import { DISTRACTION_KEYS, isPageStatusResponse } from "../shared/messages.js";
import { createPageZoomController } from "../transformations/page-zoom.js";

export function sitePermission(origin) {
  return { origins: [`${origin}/*`] };
}

// The panel and worker share a lock so page history and native zoom advance together.
export function withPageAdaptationLock(tabId, run) {
  return navigator.locks.request(`accessmate:adaptation:${tabId}`, run);
}

export async function matchesPageSession(api, page) {
  const [probe] = await api.scripting.executeScript({
    target: { tabId: page.tabId, documentIds: [page.documentId] },
    world: "ISOLATED",
    injectImmediately: true,
    func: (url, sessionId) => location.href === url && globalThis.__accessmatePageSessionV1 === sessionId,
    args: [page.url, page.sessionId],
  });
  return probe?.documentId === page.documentId && probe.frameId === 0 && probe.result === true;
}

export function pagePreviewPreferences(settings) {
  const { visual, interaction, sensory, colorVision, content } = settings;
  return {
    textScale: visual.textScale,
    zoom: visual.zoom,
    lineHeight: visual.lineHeight,
    letterSpacing: visual.letterSpacing,
    highContrast: visual.highContrast,
    textColor: visual.textColor,
    backgroundColor: visual.backgroundColor,
    highlightFocus: interaction.highlightFocus,
    targetSize: interaction.targetSize,
    cursorSize: interaction.cursorSize,
    reduceMotion: sensory.reduceMotion,
    reduceFlashing: sensory.reduceFlashing,
    motionBehavior: sensory.motionBehavior,
    stopAutoplay: sensory.stopAutoplay,
    muteAudio: sensory.muteAudio,
    addLabels: colorVision.addLabels,
    addIcons: colorVision.addIcons,
    addPatterns: colorVision.addPatterns,
    colorFilter: colorVision.filter,
    // Legacy Minimize and Block preferences require a new explicit choice.
    distractions: Object.fromEntries(DISTRACTION_KEYS
      .map((key) => [key, content[key] === "hide" ? "hide" : "allow"])),
  };
}

export function registerAutoApply(api = chrome) {
  const profiles = createProfileStorage(api.storage.local);
  const visits = new Map();
  const zoom = createPageZoomController({
    tabs: api.tabs,
    storage: api.storage.session,
    async isCurrent(page) {
      const visit = visits.get(page.tabId);
      if (!visit || visit.url !== page.url || visit.documentId !== page.documentId) return false;
      try {
        return await api.permissions.contains(visit.permission) &&
          await matchesPageSession(api, { ...page, sessionId: visit.sessionId }) && visits.get(page.tabId) === visit;
      } catch { return false; }
    },
  });

  async function applyVisit(tabId, visit) {
    const site = await profiles.loadSiteProfile(visit.origin);
    if (!site?.autoApply || !await api.permissions.contains(visit.permission)) return;
    const personal = await profiles.loadPersonalProfile();
    const settings = resolveSettings(personal?.settings, site.overrides);
    const tab = await api.tabs.get(tabId);
    if (visits.get(tabId) !== visit || tab.url !== visit.url || tab.status !== "complete") return;
    const results = await api.scripting.executeScript({
      target: { tabId, frameIds: [0] }, files: ["content/content.js"], world: "ISOLATED",
    });
    visit.documentId = results.find((entry) => entry.frameId === 0)?.documentId;
    if (!visit.documentId || !await api.permissions.contains(visit.permission) || visits.get(tabId) !== visit) return;
    const [applied] = await api.scripting.executeScript({
      target: { tabId, documentIds: [visit.documentId] },
      world: "ISOLATED",
      injectImmediately: true,
      func: (url, preferences) => globalThis.__accessmateApplySavedProfileV1?.(url, preferences) ?? null,
      args: [visit.url, pagePreviewPreferences(settings)],
    });
    const response = applied?.result;
    if (visits.get(tabId) !== visit || !isPageStatusResponse(response) || response.url !== visit.url || response.zoom === null) return;
    visit.sessionId = response.sessionId;
    await zoom.apply({ tabId, documentId: visit.documentId, url: visit.url }, response.zoom, { preserveManual: true });
  }

  api.tabs.onUpdated.addListener((tabId, change, tab) => {
    if (change.status === "loading" || change.url) visits.delete(tabId);
    if (change.status !== "complete" || !tab.url) return;
    const url = new URL(tab.url);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) return;
    const visit = { url: tab.url, origin: url.origin, permission: sitePermission(url.origin) };
    visits.set(tabId, visit);
    void withPageAdaptationLock(tabId, async () => {
      if (visits.get(tabId) !== visit) return;
      try { await applyVisit(tabId, visit); }
      finally { if (visits.get(tabId) === visit) visits.delete(tabId); }
    }).catch(() => {
      // A tab can close, navigate, or lose site access during an automatic visit.
    });
  });
  api.tabs.onRemoved.addListener((tabId) => visits.delete(tabId));
}
