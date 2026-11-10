import { createProfilesView } from "./profiles-view.js";
import { createReportView } from "./report-view.js";
import { createMediaView } from "./settings-view.js";
import { createPageMessage, isPageStatusResponse, isPageAccessGrantedMessage, isMotionUpdateMessage, isCueUpdateMessage, isDistractionUpdateMessage, isImageList, isImageDetails } from "../shared/messages.js";
import { AD_CHANNEL, isAdStatus } from "../shared/messages.js";
import { isReadingText } from "../shared/messages.js";
import { isReadingModeUpdate } from "../shared/messages.js";
import { createReadAloudView } from "../reading/read-aloud.js";
import { createNavigationView } from "./navigation-view.js";
import { createImageToolsView } from "./image-tools-view.js";
import { cropVisibleImage } from "../reading/image-analysis.js";
import { isNavigationList, isNavigationResult } from "../shared/messages.js";
import { createPageZoomController } from "../transformations/page-zoom.js";
import { createCommunityClient } from "../profiles/community-client.js";
import { matchesPageSession, pagePreviewPreferences, withPageAdaptationLock } from "../background/auto-apply.js";

const pageTitle = document.getElementById("current-page-title");
const pageStatus = document.getElementById("page-status");
const previewStatus = document.getElementById("customization-status");
const changesStatus = document.getElementById("changes-status");
const undoButton = document.getElementById("undo-change");
const restoreButton = document.getElementById("restore-page");
previewStatus.setAttribute("role", "status");
previewStatus.setAttribute("aria-atomic", "true");

function showPageStatus(title, message) {
  if (pageTitle.textContent !== title) pageTitle.textContent = title;
  if (pageStatus.textContent !== message) pageStatus.textContent = message;
}

function showMotionStatus(motion) {
  const element = document.getElementById("motion-runtime-status");
  if (!element) return;
  const text = motion.enabled
    ? `Motion ${motion.behavior}: ${motion.imagesPaused} static GIFs · ${motion.imagesHidden} hidden GIFs · ${motion.animationsPaused} paused animations · ${motion.animationsHidden} hidden animations.` +
      (motion.protectedItems ? ` ${motion.protectedItems} protected.` : "") + (motion.unavailable ? ` ${motion.unavailable} unavailable.` : "") + (motion.limited ? " Limit reached." : "")
    : "Motion controls off.";
  if (element.textContent !== text) element.textContent = text;
}

function showCueStatus(cues) {
  const element = document.getElementById("color-cues-status");
  if (!element) return;
  const text = cues.addLabels || cues.addIcons || cues.addPatterns
    ? `Cues: ${cues.labels} labels · ${cues.icons} icons · ${cues.patterns} patterns.` + (cues.skipped ? ` ${cues.skipped} skipped.` : "") + (cues.limited ? " Limit reached." : "")
    : "Colour-safe cues are off.";
  if (element.textContent !== text) element.textContent = text;
}

function showDistractionStatus(status) {
  const element = document.getElementById("distractions-status");
  element.setAttribute("role", "status");
  element.setAttribute("aria-atomic", "true");
  const counts = [`${status.hiddenAds} ads`, `${status.hiddenBanners} banners`, `${status.hiddenRecommendations} recommendations`, `${status.hiddenPopups} pop-ups`];
  if (status.sidebars === "hide") counts.push(`${status.hiddenSidebars} sidebars`);
  if (status.clutter === "hide") counts.push(`${status.hiddenWidgets} widgets`);
  const text = `Hidden: ${counts.join(" · ")}.` +
    (status.protectedItems ? ` ${status.protectedItems} protected.` : "") + (status.unavailable ? ` ${status.unavailable} unavailable.` : "") + (status.limited ? " Limit reached." : "");
  if (element.textContent !== text) element.textContent = text;
}

function initializePanel() {
  if (typeof chrome === "undefined" || !chrome.runtime?.id || !chrome.tabs?.query) {
    showPageStatus("Panel preview", "Open AccessMate from its Chrome toolbar icon to connect to a webpage.");
    return;
  }

  let activeTab = null;
  let epoch = 0;
  let target = null;
  let connecting = null;
  let latestPreview = 0;
  let suggestionPreview = null;
  let reportVersion = 0;
  let commandChain = Promise.resolve();
  let refreshVersion = 0;
  let profiles = null;
  let explicitZoomEdit = false, explicitZoomChoice = null, zoomPending = false, zoomState = null, zoomRefreshQueued = false;
  const zoom = createPageZoomController({
    async isCurrent(page) {
      const pinned = target, version = epoch;
      if (!pinned || pinned.tabId !== page.tabId || pinned.documentId !== page.documentId || pinned.url !== page.url ||
        activeTab?.id !== page.tabId || activeTab.status === "loading") return false;
      try {
        // Check the content script's session marker directly. A full status
        // request refreshes the page's adapters on every zoom safety check.
        const matched = await matchesPageSession(chrome, pinned);
        return epoch === version && target === pinned && matched;
      } catch { return false; }
    },
  });
  function updateChangeButtons(canUndo, changedProperties) {
    undoButton.disabled = !canUndo;
    restoreButton.disabled = changedProperties === 0 && !zoomPending && !zoomState?.changed;
    changesStatus.textContent = changedProperties > 0
      ? changedProperties + " active changes."
      : zoomPending ? "Zoom needs retrying."
      : zoomState?.changed ? "Page zoom is active."
      : "No active changes.";
  }
  async function syncZoom(page, response, explicit) {
    try {
      const status = await zoom.apply(page, response.zoom, { preserveManual: !explicit, force: explicit });
      if (target?.documentId !== page.documentId || target?.tabId !== page.tabId || target?.url !== page.url) return null;
      zoomState = status; zoomPending = false;
      if (explicitZoomChoice?.origin === new URL(page.url).origin && explicitZoomChoice.zoom === response.zoom) explicitZoomChoice = null;
      document.getElementById("page-zoom-status").textContent = `Page zoom: ${status.percentage}%. ` +
        (status.manualOverride ? "Manual Chrome zoom kept." : response.zoom === null ? "Original." : "Live preview.");
      document.getElementById("retry-page-zoom").hidden = true;
      return status;
    } catch {
      if (target?.documentId !== page.documentId || target?.tabId !== page.tabId || target?.url !== page.url) return null;
      zoomPending = true;
      document.getElementById("page-zoom-status").textContent = "Zoom could not update. Other changes may have applied. Retry below.";
      document.getElementById("retry-page-zoom").hidden = false;
      return null;
    }
  }
  let modeEnabled = false, modeBusy = false;
  const modeButton = document.getElementById("toggle-reading-mode");
  const modeStatus = document.createElement("p");
  modeStatus.id = "reading-mode-status";
  modeStatus.setAttribute("role", "status"); modeStatus.setAttribute("aria-atomic", "true");
  document.getElementById("assistance-controls").after(modeStatus);
  function showReadingMode(mode) {
    const changed = modeEnabled !== mode.enabled;
    modeEnabled = mode.enabled;
    navigation.setAvailable(!!activeTab && activeTab.status !== "loading" && !modeEnabled);
    imageTools.setAvailable(!!activeTab && activeTab.status !== "loading" && !modeEnabled);
    modeButton.setAttribute("aria-pressed", String(modeEnabled));
    modeButton.textContent = modeEnabled ? "Close reading mode" : "Reading mode";
    modeButton.disabled = modeBusy || !activeTab || activeTab.status === "loading";
    modeStatus.textContent = modeEnabled ? `Reading mode: ${mode.characters.toLocaleString()} characters. Escape to close.${mode.truncated ? " Content limited." : ""}` : "Reading mode closed.";
    if (changed) reading.stop("Reading stopped. Choose Main page content to read this view.");
  }
  let networkVersion = 0;
  async function refreshNetwork(sync = false) {
    const version = ++networkVersion;
    const element = document.getElementById("network-blocking-status");
    if (!element) return;
    try {
      const result = await chrome.runtime.sendMessage({ channel: AD_CHANNEL, action: sync ? "sync-profiles" : "status" });
      if (version !== networkVersion) return;
      if (!isAdStatus(result) || !result.ready || result.error) throw new Error("Network blocking unavailable.");
      const hostname = activeTab ? new URL(activeTab.url).hostname : null;
      const excepted = hostname && result.allowedDomains.some((domain) => hostname === domain || hostname.endsWith("." + domain));
      element.textContent = result.enabled
        ? `Network blocking ON · ${result.filter.rules.toLocaleString()} ${result.filter.name} rules.${excepted ? " This site is allowed." : ""} Reload after changes.`
        : "Network blocking OFF.";
      document.getElementById("retry-network-settings").hidden = true;
    } catch {
      if (version === networkVersion) {
        element.textContent = "Network blocking unavailable. Preferences kept; retry below.";
        document.getElementById("retry-network-settings").hidden = false;
      }
      throw new Error("Network blocking could not update.");
    }
  }
  const mediaView = createMediaView({
    onAction: (mediaId, allow) => { void queueCommand(allow ? "allow-media" : "restrict-media", { mediaId }); },
    onRefresh: () => { void queueCommand("status"); },
  });
  const community = createCommunityClient();
  const report = createReportView({
    onScan: startScan,
    onSuggestionFeedback: community.rateSuggestion,
    onPreviewSuggestion(sessionId, scope, suggestion) {
      if (!target || target.sessionId !== sessionId || activeTab?.id !== target.tabId ||
        activeTab.url !== target.url || activeTab.status === "loading") return false;
      if (profiles?.getDraft(new URL(target.url).origin)?.scope !== scope) return false;
      const version = latestPreview + 1;
      profiles.edit(suggestion.settings);
      if (latestPreview !== version) return false;
      suggestionPreview = { version, suggestion };
      return true;
    },
  });
  function invalidateReport() {
    reportVersion++;
    report.markStale();
  }
  const reading = createReadAloudView({
    onEdit: (patch) => profiles?.edit({ reading: patch }),
    onSave: () => profiles?.save(),
    onDiscard: () => profiles?.discard(),
    async readText(source) {
      const expectedEpoch = epoch;
      const page = await connect(expectedEpoch);
      const response = await chrome.tabs.sendMessage(page.tabId, createPageMessage("read-text", { source, url: page.url, sessionId: page.sessionId }), { documentId: page.documentId });
      if (epoch !== expectedEpoch || response?.ok !== true || response.sessionId !== page.sessionId ||
        response.url !== page.url || !isReadingText(response.reading) || response.reading.source !== source) throw new Error("Reading page changed.");
      return response.reading;
    },
  });
  async function navigationCommand(action, fields) {
    const expectedEpoch = epoch;
    if (modeEnabled) throw new Error("Close reading mode first.");
    reading.stop("Reading stopped before page navigation.");
    const page = await connect(expectedEpoch);
    const response = await chrome.tabs.sendMessage(page.tabId, createPageMessage(action, { ...fields, url: page.url, sessionId: page.sessionId }), { documentId: page.documentId });
    if (epoch !== expectedEpoch || response?.ok !== true || response.sessionId !== page.sessionId || response.url !== page.url ||
      !(action === "navigation-list" ? isNavigationList(response.navigation) && response.navigation.category === fields.category :
        isNavigationResult(response.navigation) && response.navigation.listId === fields.listId && response.navigation.targetId === fields.targetId)) throw new Error("Navigation page changed.");
    return response.navigation;
  }
  const navigation = createNavigationView({
    load: (category) => navigationCommand("navigation-list", { category }),
    jump: (listId, targetId) => navigationCommand("navigation-focus", { listId, targetId }),
  });

  async function imageCommand(action, fields = {}, expectedEpoch = epoch) {
    if (modeEnabled) throw new Error("Close Reading Mode to choose an image.");
    const page = await connect(expectedEpoch).catch(() => {
      throw new Error("Reopen AccessMate from the toolbar on this website and try again.");
    });
    const message = createPageMessage(action, { ...fields, url: page.url, sessionId: page.sessionId });
    const response = await chrome.tabs.sendMessage(page.tabId, message, { documentId: page.documentId }).catch(() => null);
    const images = response?.images;
    if (epoch !== expectedEpoch || modeEnabled || response?.ok !== true || response.url !== page.url ||
      response.sessionId !== page.sessionId || !(action === "image-list" ? isImageList(images) :
        isImageDetails(images) && images.listId === fields.listId && images.targetId === fields.targetId)) {
      throw new Error("The page or image changed. Bring the image into view and find visible images again.");
    }
    return images;
  }

  async function captureImage(listId, targetId, signal) {
    const tab = activeTab;
    const expectedEpoch = epoch;
    const details = () => imageCommand("image-details", { listId, targetId }, expectedEpoch);
    const before = await details();
    async function checkActiveTab() {
      signal.throwIfAborted();
      const [current] = await chrome.tabs.query({ windowId: tab.windowId, active: true });
      if (epoch !== expectedEpoch || current?.id !== tab.id || current.url !== tab.url || current.status === "loading") {
        throw new Error("The active page changed. Find visible images again.");
      }
    }
    await checkActiveTab();
    const screenshot = await chrome.tabs.captureVisibleTab(tab.windowId, { format: "png" }).catch(() => {
      throw new Error("Chrome could not capture the image. Click AccessMate’s toolbar icon on this website and try again.");
    });
    const after = await details();
    await checkActiveTab();
    if (JSON.stringify(before.bounds) !== JSON.stringify(after.bounds)) {
      throw new Error("The image moved during capture. Keep it in view and try again.");
    }
    return cropVisibleImage(screenshot, before.bounds, signal);
  }

  const imageTools = createImageToolsView({
    listImages: () => imageCommand("image-list"),
    getDetails: (listId, targetId) => imageCommand("image-details", { listId, targetId }),
    getPixels: captureImage,
    speakResult: reading.speakResult,
  });

  function clearTarget() {
    explicitZoomEdit = false; explicitZoomChoice = null; zoomPending = false; zoomState = null;
    const zoomStatus = document.getElementById("page-zoom-status");
    if (zoomStatus) zoomStatus.textContent = "Connect a website to preview page zoom.";
    const zoomRetry = document.getElementById("retry-page-zoom");
    if (zoomRetry) zoomRetry.hidden = true;
    navigation.setAvailable(false);
    navigation.reset("Open a website and click AccessMate to navigate.");
    imageTools.setAvailable(false);
    reading.stop();
    reading.setAvailable(false);
    epoch++;
    latestPreview++;
    suggestionPreview = null;
    activeTab = null;
    modeBusy = false;
    showReadingMode({ enabled: false, characters: 0, truncated: false });
    void refreshNetwork().catch(() => {});
    target = null;
    connecting = null;
    mediaView.reset();
    const motionStatus = document.getElementById("motion-runtime-status");
    if (motionStatus) motionStatus.textContent = "Connect a website to apply motion preferences.";
    const cueStatus = document.getElementById("color-cues-status");
    if (cueStatus) cueStatus.textContent = "Connect a website to apply colour-safe cues.";
    document.getElementById("distractions-status").textContent = "Connect a website to preview Allow/Hide preferences.";
    report.setAvailable(false);
    report.reset("Connect a website to scan.");
    undoButton.disabled = true;
    restoreButton.disabled = true;
    changesStatus.textContent = "Connect a website to manage changes.";
  }

  function updateChanges(response) {
    updateChangeButtons(response.canUndo, response.changedProperties);
    mediaView.show(response.media);
    showMotionStatus(response.motion);
    showCueStatus(response.cues);
    showDistractionStatus(response.distractions);
    showReadingMode(response.readingMode);
  }

  function checkResponse(response) {
    if (!isPageStatusResponse(response)) throw new Error("The webpage did not return a valid adaptation status.");
    return response;
  }

  async function connect(expectedEpoch) {
    if (target) return target;
    if (connecting) return connecting;
    const tab = activeTab;
    if (!tab || tab.status === "loading") throw new Error("Wait for the webpage to finish loading.");
    const attempt = (async () => {
      const results = await chrome.scripting.executeScript({
        target: { tabId: tab.id, frameIds: [0] },
        files: ["content/content.js"],
        world: "ISOLATED",
      });
      if (epoch !== expectedEpoch) throw new Error("Page changed during connection.");
      const documentId = results.find((entry) => entry.frameId === 0)?.documentId;
      if (!documentId) throw new Error("The page document could not be identified.");
      const response = checkResponse(await chrome.tabs.sendMessage(tab.id,
        createPageMessage("status", { url: tab.url }), { documentId }));
      if (epoch !== expectedEpoch || response.url !== tab.url) throw new Error("Page changed during connection.");
      target = { tabId: tab.id, documentId, sessionId: response.sessionId, url: tab.url };
      updateChanges(response);
      return target;
    })();
    connecting = attempt;
    try { return await attempt; }
    finally { if (connecting === attempt) connecting = null; }
  }

  function queueCommand(action, preferences = {}, previewVersion = null, explicitZoom = false) {
    const expectedEpoch = epoch;
    const tabId = activeTab?.id;
    if (action !== "scan" && action !== "status") invalidateReport();
    const scanVersion = reportVersion;
    const task = async () => {
      if (epoch !== expectedEpoch || (previewVersion !== null && previewVersion !== latestPreview)) return;
      try {
        const page = await connect(expectedEpoch);
        if (epoch !== expectedEpoch || (previewVersion !== null && previewVersion !== latestPreview)) return;
        mediaView.setBusy(true);
        const message = createPageMessage(action, { url: page.url, sessionId: page.sessionId, ...preferences });
        const response = checkResponse(await chrome.tabs.sendMessage(page.tabId, message, { documentId: page.documentId }));
        if (epoch !== expectedEpoch || (previewVersion !== null && previewVersion !== latestPreview)) return;
        if (response.sessionId !== page.sessionId || response.url !== page.url) throw new Error("The page session changed.");
        const zoomResult = await syncZoom(page, response, explicitZoom ||
          (explicitZoomChoice?.origin === new URL(page.url).origin && explicitZoomChoice.zoom === response.zoom));
        if (epoch !== expectedEpoch || (previewVersion !== null && previewVersion !== latestPreview)) return;
        updateChanges(response);
        if (action === "status" || action === "reading-mode") return;
        if (action === "scan") {
          if (response.report?.pageSessionId !== page.sessionId) throw new Error("The scan belongs to another document.");
          const votes = await community.loadSuggestionVotes().catch(() => ({}));
          if (epoch !== expectedEpoch) return;
          const current = scanVersion === reportVersion;
          report.show(response.report, current ? profiles?.getDraft(new URL(page.url).origin) : null, votes);
          if (!current) report.markStale();
          return;
        }
        if (action === "restore") {
          previewStatus.textContent = "Page restored. Paused media stays paused." + (zoomResult ? "" : " Zoom needs retrying.");
        } else if (action === "undo") {
          previewStatus.textContent = "Last change undone. Saved preferences kept." + (zoomResult ? "" : " Zoom needs retrying.");
        } else if (action === "allow-media" || action === "restrict-media") {
          previewStatus.textContent = action === "allow-media"
            ? "Playback allowed. Use the website's Play button."
            : "Playback restricted.";
        } else {
          previewStatus.textContent = "Preview applied." +
            (!zoomResult ? " Zoom needs retrying." : zoomResult.manualOverride ? " Manual Chrome zoom kept." : "") +
            (response.limited ? " Some page elements were skipped." : "") +
            (response.contrastSkipped > 0 ? " Image/gradient backgrounds kept; review contrast." : "");
          if (action === "preview" && suggestionPreview?.version === previewVersion) {
            report.showSuggestionFeedback(suggestionPreview.suggestion);
            suggestionPreview = null;
          }
        }
      } catch {
        if (epoch !== expectedEpoch) return;
        if (action === "reading-mode") {
          modeStatus.textContent = "Close website dialogs and check for readable text, then retry.";
          return;
        }
        target = null;
        mediaView.reset("Reconnect AccessMate, then refresh the media list.");
        if (action === "scan") {
          report.fail("Scan failed. Refresh the website and reconnect AccessMate.");
          return;
        }
        previewStatus.textContent = "Preview unavailable. Refresh the website and reconnect AccessMate.";
      }
    };
    // Serialize operations; newer preview values supersede queued older ones.
    const run = () => tabId === undefined ? task() : withPageAdaptationLock(tabId, task);
    commandChain = commandChain.then(run, run);
    return commandChain;
  }

  function startScan() {
    if (!activeTab || activeTab.status === "loading") {
      report.fail("Wait for the website to load, then reconnect AccessMate.");
      return;
    }
    report.begin();
    void queueCommand("scan");
  }

  function preview({ origin, settings }) {
    const explicitZoom = explicitZoomEdit;
    explicitZoomEdit = false;
    if (!activeTab) {
      previewStatus.textContent = "Click AccessMate on the website to connect.";
      return;
    }
    if (activeTab.status === "loading") {
      previewStatus.textContent = "Wait for the website to finish loading.";
      return;
    }
    if (origin !== new URL(activeTab.url).origin) {
      previewStatus.textContent = "Loading website preferences…";
      return;
    }
    const version = ++latestPreview;
    // Carry an explicit selection through coalesced previews and Retry. A quick
    // text-size edit must not turn that zoom selection into a passive refresh.
    if (explicitZoom) explicitZoomChoice = { origin, zoom: settings.visual.zoom };
    void queueCommand("preview", pagePreviewPreferences(settings), version, explicitZoom);
  }

  try {
    profiles = createProfilesView(undefined, {
      onPreview: preview,
      onSaved: () => refreshNetwork(true),
      onRender: reading.setProfileState,
    });
    document.getElementById("page-zoom").addEventListener("change", () => { explicitZoomEdit = true; }, { capture: true });
    document.getElementById("retry-page-zoom").addEventListener("click", () => { void queueCommand("status"); });
    for (const id of ["cancel-preview", "discard-distractions", "discard-reading-preferences", "undo-change", "restore-page", "apply-preset", "inherit-personal"]) {
      document.getElementById(id)?.addEventListener("click", () => { explicitZoomChoice = null; }, { capture: true });
    }
    document.getElementById("profile-scope").addEventListener("change", () => { explicitZoomChoice = null; }, { capture: true });
    document.getElementById("retry-network-settings").addEventListener("click", () => { void refreshNetwork(true).catch(() => {}); });
    void refreshNetwork(true).catch(() => {});
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === "local" && Object.hasOwn(changes, "accessmate:ad-blocking:v1")) void refreshNetwork().catch(() => {});
    });
    document.querySelector("#profiles > p:nth-of-type(2)").textContent =
      "Changes preview on this website.";
    previewStatus.textContent = "Adjust a setting to preview.";
  } catch {
    const message = "Local preference storage is unavailable.";
    document.getElementById("profiles-status").textContent = message;
    reading.setProfileState(null, { enabled: false, busy: false, message });
  }

  undoButton.addEventListener("click", () => {
    reading.stop("Reading stopped before Undo.");
    latestPreview++;
    void queueCommand("undo");
  });
  restoreButton.addEventListener("click", () => {
    reading.stop("Reading stopped before Restore.");
    latestPreview++;
    void queueCommand("restore");
  });

  modeButton.addEventListener("click", () => {
    if (modeBusy || !activeTab) return;
    const expectedEpoch = epoch;
    modeBusy = true; modeButton.disabled = true;
    reading.stop("Preparing reading mode…");
    void queueCommand("reading-mode", { enabled: !modeEnabled }).finally(() => {
      if (epoch === expectedEpoch) { modeBusy = false; modeButton.disabled = !activeTab || activeTab.status === "loading"; }
    });
  });

  async function refreshCurrentPage(forceReconnect = false) {
    const version = ++refreshVersion;
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (version !== refreshVersion) return;
      if (!tab?.url) {
        clearTarget();
        profiles?.setCurrentOrigin(null);
        showPageStatus("Page details unavailable", "Click AccessMate on a regular website.");
        previewStatus.textContent = "Click AccessMate on the website to connect.";
        return;
      }
      const url = new URL(tab.url);
      if (!["http:", "https:"].includes(url.protocol)) {
        clearTarget();
        profiles?.setCurrentOrigin(null);
        showPageStatus("Unsupported page", "Open an HTTP or HTTPS website.");
        previewStatus.textContent = "Preview unavailable on this page.";
        return;
      }
      const changed = forceReconnect || !activeTab || activeTab.id !== tab.id || activeTab.url !== tab.url;
      if (changed) clearTarget();
      activeTab = tab;
      reading.setAvailable(tab.status !== "loading");
      navigation.setAvailable(tab.status !== "loading" && !modeEnabled);
      imageTools.setAvailable(tab.status !== "loading" && !modeEnabled);
      modeButton.disabled = modeBusy || tab.status === "loading";
      void refreshNetwork().catch(() => {});
      report.setAvailable(tab.status !== "loading");
      profiles?.setCurrentOrigin(url.origin);
      showPageStatus(tab.title?.trim() || url.hostname,
        tab.status === "loading" ? "Page loading…" :
          "Ready to customize or scan.");
      if (changed || !target) profiles?.previewCurrent();
    } catch {
      if (version !== refreshVersion) return;
      clearTarget();
      profiles?.setCurrentOrigin(null);
      showPageStatus("Page details unavailable", "Reopen AccessMate from the toolbar.");
      previewStatus.textContent = "Page unavailable. Reconnect AccessMate.";
    }
  }

  chrome.tabs.onActivated.addListener(({ tabId }) => {
    if (activeTab?.id !== tabId) invalidateReport();
    void refreshCurrentPage();
  });
  chrome.runtime.onMessage.addListener((message, sender) => {
    if (sender.id === chrome.runtime.id && isReadingModeUpdate(message)) {
      if (target && sender.tab?.id === target.tabId && sender.documentId === target.documentId &&
        message.sessionId === target.sessionId && message.url === target.url) {
        showReadingMode(message.readingMode);
        updateChangeButtons(message.canUndo, message.changedProperties);
        invalidateReport();
      }
      return;
    }
    if (sender.id === chrome.runtime.id && isDistractionUpdateMessage(message)) {
      if (target && sender.tab?.id === target.tabId && sender.documentId === target.documentId &&
        message.sessionId === target.sessionId && message.url === target.url) showDistractionStatus(message.distractions);
      return;
    }
    if (sender.id === chrome.runtime.id && isCueUpdateMessage(message)) {
      if (target && sender.tab?.id === target.tabId && sender.documentId === target.documentId &&
        message.sessionId === target.sessionId && message.url === target.url) showCueStatus(message.cues);
      return;
    }
    if (sender.id === chrome.runtime.id && isMotionUpdateMessage(message)) {
      if (target && sender.tab?.id === target.tabId && sender.documentId === target.documentId &&
        message.sessionId === target.sessionId && message.url === target.url) showMotionStatus(message.motion);
      return;
    }
    if (
      sender.id !== chrome.runtime.id || sender.tab ||
      !isPageAccessGrantedMessage(message)
    ) return;
    // Runtime messages reach every open panel. Refresh only the window whose
    // toolbar was clicked, without requesting access to other websites.
    void chrome.windows.getCurrent().then((current) => {
      if (current.id === message.windowId) void refreshCurrentPage();
    }).catch(() => {});
  });
  chrome.tabs.onUpdated.addListener((tabId, changes, tab) => {
    if (tab.active && ("status" in changes || "url" in changes || "title" in changes)) {
      const isCurrent = activeTab?.id === tabId;
      // Invalidate synchronously: a fast same-URL reload may finish before the
      // asynchronous tab queries return, but the old document must stay invalid.
      if (changes.status === "loading" && isCurrent) clearTarget();
      else if (changes.url && isCurrent && changes.url !== activeTab.url) invalidateReport();
      void refreshCurrentPage(changes.status === "loading" && isCurrent);
    }
  });
  chrome.tabs.onZoomChange.addListener(({ tabId }) => {
    if (target?.tabId !== tabId) return;
    invalidateReport();
    if (zoomRefreshQueued) return;
    zoomRefreshQueued = true;
    void queueCommand("status").finally(() => { zoomRefreshQueued = false; });
  });
  showPageStatus("Checking current tab…", "Reading available page details.");
  void refreshCurrentPage();
}

initializePanel();

