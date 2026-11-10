import { ISSUE_SEVERITIES, MOTION_BEHAVIORS } from "./contracts.js";
import { SETTINGS_LIMITS, validateSettingsOverrides } from "../profiles/profile-manager.js";
import { SCORING_VERSION, calculateScore } from "../analysis/scoring.js";

export const PAGE_CHANNEL = "accessmate.page.v1";
export const AD_CHANNEL = "accessmate.ad-blocking.v1";
export const DISTRACTION_KEYS = Object.freeze(["ads", "banners", "recommendations", "popups", "sidebars", "clutter"]);
const DEFAULT_DISTRACTIONS = Object.freeze(Object.fromEntries(DISTRACTION_KEYS.map((key) => [key, "allow"])));

export function isAdCommand(value) {
  return isRecord(value) && Object.keys(value).length === 2 && value.channel === AD_CHANNEL &&
    ["status", "sync-profiles"].includes(value.action);
}

export function isAdStatus(value) {
  return isRecord(value) && value.ok === true && typeof value.ready === "boolean" && typeof value.enabled === "boolean" &&
    Array.isArray(value.allowedDomains) && value.allowedDomains.length <= 1000 && value.allowedDomains.every((domain) => isText(domain, 253)) &&
    isRecord(value.filter) && isText(value.filter.name, 100) && isText(value.filter.version, 100) && isCount(value.filter.rules) &&
    (value.error === null || isText(value.error)) && value.reloadRequired === true;
}
export const PAGE_ACTIONS = Object.freeze(["status", "preview", "undo", "restore", "scan", "allow-media", "restrict-media", "read-text", "reading-mode", "navigation-list", "navigation-focus", "image-list", "image-details"]);
export const READING_LIMITS = Object.freeze({ characters: 30000, nodes: 20000 });
export const IMAGE_LIMITS = Object.freeze({ inspected: 2000, items: 50, description: 1000 });
export const NAVIGATION_CATEGORIES = Object.freeze(["headings", "sections", "links", "controls"]);
export const NAVIGATION_LIMITS = Object.freeze({ inspected: 2000, items: 200 });
export function isNavigationList(value) {
  return isRecord(value) && Object.keys(value).length === 4 && NAVIGATION_CATEGORIES.includes(value.category) &&
    isToken(value.listId) && typeof value.limited === "boolean" && Array.isArray(value.items) && value.items.length <= NAVIGATION_LIMITS.items &&
    new Set(value.items.map((item) => item?.id)).size === value.items.length &&
    value.items.every((item) => isRecord(item) && Object.keys(item).length === 3 && isToken(item.id) &&
      isText(item.label, 160) && item.label.length > 0 && isText(item.kind, 80) && item.kind.length > 0);
}
export function isNavigationResult(value) {
  return isRecord(value) && Object.keys(value).length === 2 && isToken(value.listId) && isToken(value.targetId);
}

export function isImageList(value) {
  return isRecord(value) && Object.keys(value).length === 3 && isToken(value.listId) &&
    typeof value.limited === "boolean" && Array.isArray(value.items) && value.items.length <= IMAGE_LIMITS.items &&
    new Set(value.items.map((item) => item?.id)).size === value.items.length &&
    value.items.every((item) => isRecord(item) && Object.keys(item).length === 3 && isToken(item.id) &&
      isText(item.label, 100) && item.label.length > 0 && typeof item.hasDescription === "boolean");
}

export function isImageDetails(value) {
  if (!isRecord(value) || Object.keys(value).length !== 4 || !isToken(value.listId) ||
    !isToken(value.targetId) || !isText(value.description, IMAGE_LIMITS.description)) return false;
  const bounds = value.bounds;
  if (!isRecord(bounds) || Object.keys(bounds).length !== 6) return false;
  const { left, top, right, bottom, viewportWidth, viewportHeight } = bounds;
  return [left, top, right, bottom, viewportWidth, viewportHeight].every(Number.isFinite) &&
    left >= 0 && top >= 0 && right > left && bottom > top && right <= viewportWidth && bottom <= viewportHeight;
}

export function isReadingText(value) {
  return isRecord(value) && Object.keys(value).length === 4 && ["page", "selection"].includes(value.source) &&
    isText(value.text, READING_LIMITS.characters) && isText(value.lang, 64) && typeof value.truncated === "boolean";
}
export function isReadingModeStatus(value) {
  return isRecord(value) && Object.keys(value).length === 3 && typeof value.enabled === "boolean" &&
    isCount(value.characters) && value.characters <= READING_LIMITS.characters && typeof value.truncated === "boolean";
}
export function isReadingModeUpdate(value) {
  return isRecord(value) && Object.keys(value).length === 6 && value.type === "ACCESSMATE_READING_MODE_UPDATED" &&
    isToken(value.sessionId) && isWebUrl(value.url) && isReadingModeStatus(value.readingMode) &&
    typeof value.canUndo === "boolean" && isCount(value.changedProperties);
}
export const REPORT_LIMITS = Object.freeze({ issues: 300, targetsPerIssue: 100 });

const isText = (value, limit = 1000) => typeof value === "string" && value.length <= limit;
const isCount = (value) => Number.isSafeInteger(value) && value >= 0;
const isToken = (value) => isText(value, 128) && value.length > 0;
const isColor = (value) => value === null || (typeof value === "string" && /^#[0-9a-f]{6}$/i.test(value));
const isZoom = (value) => value === null || (typeof value === "number" && Number.isFinite(value) &&
  value >= SETTINGS_LIMITS.zoom.min && value <= SETTINGS_LIMITS.zoom.max);

function isRecord(value) {
  if (!value || typeof value !== "object") return false;
  const prototype = Object.getPrototypeOf(value);
  return (prototype === Object.prototype || prototype === null) &&
    Object.getOwnPropertySymbols(value).length === 0 &&
    Object.values(Object.getOwnPropertyDescriptors(value)).every(
      (entry) => entry.enumerable && Object.hasOwn(entry, "value"),
    );
}

function isWebUrl(value) {
  if (!isText(value, 65536)) return false;
  try { return ["http:", "https:"].includes(new URL(value).protocol); }
  catch { return false; }
}

/** Strict commands: page-controlled values never become executable code. */
export function isPageMessage(value) {
  if (!isRecord(value)) return false;
  if (Object.keys(value).some((key) => !["channel", "action", "url", "sessionId", "textScale", "zoom", "lineHeight", "letterSpacing", "highContrast", "textColor", "backgroundColor", "highlightFocus", "targetSize", "cursorSize", "reduceMotion", "reduceFlashing", "motionBehavior", "stopAutoplay", "muteAudio", "addLabels", "addIcons", "addPatterns", "colorFilter", "distractions", "mediaId", "source", "enabled", "category", "listId", "targetId"].includes(key))) return false;
  if (value.channel !== PAGE_CHANNEL || !PAGE_ACTIONS.includes(value.action) || !isWebUrl(value.url)) return false;
  const hasPreferenceFields = ["textScale", "zoom", "lineHeight", "letterSpacing", "highContrast", "textColor", "backgroundColor", "highlightFocus", "targetSize", "cursorSize", "reduceMotion", "reduceFlashing", "motionBehavior", "stopAutoplay", "muteAudio", "addLabels", "addIcons", "addPatterns", "colorFilter", "distractions"].some((key) => Object.hasOwn(value, key));
  const hasMediaId = Object.hasOwn(value, "mediaId");
  const navigationFields = ["category", "listId", "targetId"];
  if (["navigation-list", "navigation-focus", "image-list", "image-details"].includes(value.action)) {
    if (!isToken(value.sessionId) || hasPreferenceFields || hasMediaId || Object.hasOwn(value, "enabled") || Object.hasOwn(value, "source")) return false;
    if (["navigation-focus", "image-details"].includes(value.action)) {
      return isToken(value.listId) && isToken(value.targetId) && !Object.hasOwn(value, "category");
    }
    if (Object.hasOwn(value, "listId") || Object.hasOwn(value, "targetId")) return false;
    return value.action === "navigation-list" ? NAVIGATION_CATEGORIES.includes(value.category) : !Object.hasOwn(value, "category");
  }
  if (navigationFields.some((key) => Object.hasOwn(value, key))) return false;
  if (value.action === "reading-mode") return isToken(value.sessionId) && !hasPreferenceFields && !hasMediaId &&
    !Object.hasOwn(value, "source") && typeof value.enabled === "boolean";
  if (Object.hasOwn(value, "enabled")) return false;
  if (value.action === "read-text") return isToken(value.sessionId) && !hasPreferenceFields && !hasMediaId && ["page", "selection"].includes(value.source);
  if (Object.hasOwn(value, "source")) return false;
  if (value.action === "status") return !Object.hasOwn(value, "sessionId") && !hasPreferenceFields && !hasMediaId;
  if (!isToken(value.sessionId)) return false;
  if (["allow-media", "restrict-media"].includes(value.action)) return !hasPreferenceFields && isToken(value.mediaId);
  if (hasMediaId) return false;
  if (value.action !== "preview") return !hasPreferenceFields;
  const spacing = (value, limits) => value === null || (typeof value === "number" && Number.isFinite(value) && value >= limits.min && value <= limits.max);
  const limits = SETTINGS_LIMITS.textScale;
  return typeof value.textScale === "number" && Number.isFinite(value.textScale) &&
    value.textScale >= limits.min && value.textScale <= limits.max &&
    isZoom(value.zoom) && spacing(value.lineHeight, SETTINGS_LIMITS.lineHeight) && spacing(value.letterSpacing, SETTINGS_LIMITS.letterSpacing) &&
    typeof value.highContrast === "boolean" && typeof value.highlightFocus === "boolean" &&
    spacing(value.targetSize, SETTINGS_LIMITS.targetSize) && ["original", "large", "extra-large"].includes(value.cursorSize) &&
    typeof value.reduceMotion === "boolean" && typeof value.reduceFlashing === "boolean" && MOTION_BEHAVIORS.includes(value.motionBehavior) && typeof value.stopAutoplay === "boolean" &&
    typeof value.muteAudio === "boolean" && isColor(value.textColor) && isColor(value.backgroundColor) &&
    ["addLabels", "addIcons", "addPatterns"].every((key) => typeof value[key] === "boolean") &&
    validateSettingsOverrides({ colorVision: { filter: value.colorFilter } }).valid && isDistractionPreferences(value.distractions);
}

export function createPageMessage(action, { url, sessionId, textScale, zoom = null, lineHeight = null, letterSpacing = null, highContrast = false, textColor = null, backgroundColor = null, highlightFocus = false, targetSize = null, cursorSize = "original", reduceMotion = false, reduceFlashing = false, motionBehavior = "pause", stopAutoplay = false, muteAudio = false, addLabels = false, addIcons = false, addPatterns = false, colorFilter = "none", distractions = DEFAULT_DISTRACTIONS, mediaId, source, enabled, category, listId, targetId } = {}) {
  const message = { channel: PAGE_CHANNEL, action, url };
  if (action !== "status") message.sessionId = sessionId;
  if (action === "navigation-list") message.category = category;
  if (action === "navigation-focus" || action === "image-details") Object.assign(message, { listId, targetId });
  if (action === "reading-mode") message.enabled = enabled;
  if (action === "read-text") message.source = source;
  if (action === "preview") Object.assign(message, { textScale, zoom, lineHeight, letterSpacing, highContrast, textColor, backgroundColor, highlightFocus, targetSize, cursorSize, reduceMotion, reduceFlashing, motionBehavior, stopAutoplay, muteAudio, addLabels, addIcons, addPatterns, colorFilter,
    distractions: isRecord(distractions) ? { sidebars: "allow", clutter: "allow", ...distractions } : distractions,
  });
  if (["allow-media", "restrict-media"].includes(action)) message.mediaId = mediaId;
  if (!isPageMessage(message)) throw new TypeError("Invalid AccessMate page command.");
  return message;
}

export function isPageStatusResponse(value) {
  return isRecord(value) && value.ok === true && isToken(value.sessionId) &&
    isWebUrl(value.url) && typeof value.canUndo === "boolean" &&
    isZoom(value.zoom) && isCount(value.changedProperties) && isCount(value.targetCount) && typeof value.limited === "boolean" &&
    (!Object.hasOwn(value, "contrastSkipped") || isCount(value.contrastSkipped)) && isMediaStatus(value.media) && isMotionStatus(value.motion) && isCueStatus(value.cues) && isDistractionStatus(value.distractions) && isReadingModeStatus(value.readingMode);
}

function isDistractionPreferences(value) {
  return isRecord(value) && Object.keys(value).length === DISTRACTION_KEYS.length &&
    DISTRACTION_KEYS.every((key) => ["allow", "hide"].includes(value[key]));
}

function isDistractionStatus(value) {
  return isRecord(value) && Object.keys(value).length === 15 &&
    DISTRACTION_KEYS.every((key) => ["allow", "hide"].includes(value[key])) &&
    typeof value.limited === "boolean" &&
    ["hiddenAds", "hiddenBanners", "hiddenRecommendations", "hiddenPopups", "hiddenSidebars", "hiddenWidgets", "protectedItems", "unavailable"]
      .every((key) => isCount(value[key]) && value[key] <= 500);
}

export function isDistractionUpdateMessage(value) {
  return isRecord(value) && Object.keys(value).length === 4 && value.type === "ACCESSMATE_DISTRACTIONS_UPDATED" &&
    isToken(value.sessionId) && isWebUrl(value.url) && isDistractionStatus(value.distractions);
}

function isCueStatus(value) {
  return isRecord(value) && Object.keys(value).length === 10 &&
    ["addLabels", "addIcons", "addPatterns", "limited"].every((key) => typeof value[key] === "boolean") &&
    ["elements", "states", "labels", "icons", "patterns", "skipped"].every((key) => isCount(value[key]) && value[key] <= 1000);
}

export function isCueUpdateMessage(value) {
  return isRecord(value) && Object.keys(value).length === 4 && value.type === "ACCESSMATE_CUES_UPDATED" &&
    isToken(value.sessionId) && isWebUrl(value.url) && isCueStatus(value.cues);
}

function isMotionStatus(value) {
  return isRecord(value) && Object.keys(value).length === 9 && typeof value.enabled === "boolean" && MOTION_BEHAVIORS.includes(value.behavior) &&
    typeof value.limited === "boolean" && ["imagesPaused", "imagesHidden", "animationsPaused", "animationsHidden", "protectedItems", "unavailable"].every(
      (key) => isCount(value[key]) && value[key] <= 1000,
    );
}

export function isMotionUpdateMessage(value) {
  return isRecord(value) && Object.keys(value).length === 4 && value.type === "ACCESSMATE_MOTION_UPDATED" &&
    isToken(value.sessionId) && isWebUrl(value.url) && isMotionStatus(value.motion);
}

function isMediaStatus(value) {
  if (!isRecord(value) || typeof value.stopAutoplay !== "boolean" || typeof value.muteAudio !== "boolean" ||
    typeof value.limited !== "boolean" || !Array.isArray(value.items) || value.items.length > 100) return false;
  const ids = new Set();
  return value.items.every((item) => {
    if (!isRecord(item) || !isToken(item.id) || ids.has(item.id) || !["video", "audio"].includes(item.kind) ||
      !isText(item.label, 100) || typeof item.allowed !== "boolean" || typeof item.paused !== "boolean" ||
      typeof item.muted !== "boolean") return false;
    ids.add(item.id);
    return true;
  });
}

export function isPageAccessGrantedMessage(value) {
  return isRecord(value) && Object.keys(value).length === 3 &&
    value.type === "ACCESSMATE_PAGE_ACCESS_GRANTED" && isCount(value.tabId) && isCount(value.windowId);
}

function isContrast(value) {
  if (value === null) return true;
  return isRecord(value) && ["foreground", "background"].every(
    (key) => value[key] === null || (isText(value[key], 9) && /^#[\da-f]{6}$/i.test(value[key])),
  ) && ["ratio", "requiredRatio"].every(
    (key) => value[key] === null || (typeof value[key] === "number" && Number.isFinite(value[key]) && value[key] >= 1 && value[key] <= 21),
  );
}

/**
 * Reports contain plain text and opaque element references, never raw HTML,
 * DOM objects, or input values. Unrated manual-review impact remains null.
 * Counts cover the full results; examples can be truncated independently.
 */
export function isScanReport(report) {
  if (!isRecord(report) || !isToken(report.id) || !isToken(report.pageSessionId) ||
    !isText(report.createdAt, 40) || !Number.isFinite(Date.parse(report.createdAt)) ||
    !["before", "after"].includes(report.phase) ||
    (report.score !== null && (!Number.isInteger(report.score) || report.score < 0 || report.score > 100)) ||
    report.scoringVersion !== SCORING_VERSION) return false;
  const scoring = report.scoring;
  if (!isRecord(scoring)) return false;
  const ruleLists = [scoring.passedRules, scoring.failedRules, scoring.inconclusiveRules];
  if (!ruleLists.every((list) => Array.isArray(list) && list.length <= 1000 && list.every((id) => isToken(id)))) return false;
  const allScoredRules = ruleLists.flat();
  if (new Set(allScoredRules).size !== allScoredRules.length) return false;
  const calculated = calculateScore({
    passes: scoring.passedRules.map((id) => ({ id })),
    violations: scoring.failedRules.map((id) => ({ id })),
    incomplete: scoring.inconclusiveRules.map((id) => ({ id })),
  });
  if (calculated.score !== report.score) return false;
  const analysis = report.analysis;
  if (!isRecord(analysis) || analysis.fingerprintVersion !== "dom-v1" ||
    typeof analysis.fingerprint !== "string" || !/^[a-f0-9]{64}$/.test(analysis.fingerprint) ||
    typeof analysis.stable !== "boolean" ||
    !["elements", "forms", "links", "buttons", "fields", "landmarks"].every((key) => isCount(analysis[key])) ||
    !isRecord(analysis.headings) || ![1, 2, 3, 4, 5, 6].every((level) => isCount(analysis.headings["h" + level]))) return false;
  if (!isRecord(report.engine) || report.engine.name !== "axe-core" || !isText(report.engine.version, 40)) return false;
  if (!isRecord(report.summary) || !["issueTypes", "affectedElements", "manualReviewTypes", "manualReviewElements"].every(
    (key) => isCount(report.summary[key]),
  )) return false;
  const coverage = report.coverage;
  if (!isRecord(coverage) || !Array.isArray(coverage.checkedRules) || coverage.checkedRules.length > 1000 ||
    !coverage.checkedRules.every((rule) => isText(rule, 100)) || !Array.isArray(coverage.unsupportedAreas) ||
    coverage.unsupportedAreas.length > 20 || !coverage.unsupportedAreas.every((area) => isText(area)) ||
    coverage.manualReviewRequired !== true || typeof coverage.detailsTruncated !== "boolean") return false;
  if (!allScoredRules.every((id) => coverage.checkedRules.includes(id))) return false;
  if (!Array.isArray(report.issues) || report.issues.length > REPORT_LIMITS.issues) return false;
  const ids = new Set();
  for (const issue of report.issues) {
    if (!isRecord(issue) || !isToken(issue.id) || ids.has(issue.id) || !isToken(issue.ruleId) ||
      !["violation", "manual-review"].includes(issue.status) ||
      (issue.severity !== null && !ISSUE_SEVERITIES.includes(issue.severity)) ||
      !isText(issue.message) || !isText(issue.description) || !isCount(issue.affectedCount) ||
      !Array.isArray(issue.targets) || issue.targets.length > REPORT_LIMITS.targetsPerIssue ||
      issue.affectedCount < issue.targets.length) return false;
    ids.add(issue.id);
    const targets = new Set();
    for (const target of issue.targets) {
      if (!isRecord(target) || !isToken(target.elementId) || targets.has(target.elementId) ||
        target.frameId !== 0 || !isText(target.label, 200) || !isContrast(target.contrast)) return false;
      targets.add(target.elementId);
    }
  }
  return true;
}
