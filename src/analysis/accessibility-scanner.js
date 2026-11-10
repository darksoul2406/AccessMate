import axe from "axe-core";
import { ISSUE_SEVERITIES } from "../shared/contracts.js";
import { REPORT_LIMITS } from "../shared/messages.js";
import { analyzeDOM } from "./dom-analyzer.js";
import { calculateScore } from "./scoring.js";
import { collectSupplementalFindings } from "./supplemental-checks.js";

const TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"];
const clip = (value, length = 1000) => String(value ?? "").slice(0, length);
const RULE_IMPACT = new Map([
  ["color-contrast", "people with low vision or difficulty distinguishing text from its background"],
  ["link-in-text-block", "people with colour vision differences or low vision"],
  ["target-size", "people with limited dexterity or people using touch or assistive pointing devices"],
  ["label-content-name-mismatch", "people who operate controls with voice commands"],
  ["aria-hidden-focus", "people navigating by keyboard or screen reader"],
  ["video-caption", "people who are deaf or hard of hearing"],
  ["audio-caption", "people who are deaf or hard of hearing"],
  ["no-autoplay-audio", "people listening to a screen reader or sensitive to unexpected sound"],
  ["meta-viewport", "people who zoom in to read or interact with the page"],
  ["css-orientation-lock", "people whose device is mounted in a fixed orientation"],
  ["avoid-inline-spacing", "people who adjust text spacing to read more comfortably"],
  ["blink", "people who are sensitive to flashing or distracting movement"],
  ["marquee", "people who are sensitive to motion or need more time to read"],
]);
const CATEGORY_IMPACT = new Map([
  ["cat.aria", "people using screen readers or other assistive technology"],
  ["cat.name-role-value", "people using screen readers or voice control"],
  ["cat.forms", "people who rely on clear labels and predictable form controls"],
  ["cat.keyboard", "people who navigate by keyboard or with switch controls"],
  ["cat.language", "people using screen readers or text-to-speech tools"],
  ["cat.structure", "people navigating by page structure with assistive technology"],
  ["cat.tables", "people using a screen reader to navigate data tables"],
  ["cat.semantics", "people who rely on the page's structure or control names"],
  ["cat.text-alternatives", "people using screen readers or other text alternatives"],
  ["cat.time-and-media", "people who need time to read or control media playback"],
]);

function describeFinding(rule) {
  const category = rule.tags?.find((tag) => CATEGORY_IMPACT.has(tag));
  const impact = rule.userImpact ?? RULE_IMPACT.get(rule.id) ?? CATEGORY_IMPACT.get(category) ??
    "people who use assistive technology or adjust how the page is presented";
  const description = clip(rule.description, 800).trimEnd();
  const punctuation = /[.!?]$/.test(description) ? "" : ".";
  return description + punctuation + " May affect " + impact + ".";
}

function contrastDetails(node) {
  const check = [...node.any, ...node.all, ...node.none].find((item) => item.id === "color-contrast");
  if (!check?.data) return null;
  const { fgColor, bgColor, contrastRatio, expectedContrastRatio } = check.data;
  const color = (value) => typeof value === "string" && /^#[\da-f]{6}$/i.test(value) ? value : null;
  const ratio = (value) => {
    const number = typeof value === "number" ? value : Number.parseFloat(value);
    return Number.isFinite(number) && number >= 1 && number <= 21 ? number : null;
  };
  return { foreground: color(fgColor), background: color(bgColor), ratio: ratio(contrastRatio), requiredRatio: ratio(expectedContrastRatio) };
}

/** Run locally on the current rendered appearance; never save or send raw axe results. */
export async function scanAccessibility({ pageSessionId, phase }, page = document) {
  const initialAnalysis = await analyzeDOM(page);
  const result = await axe.run(page, {
    runOnly: { type: "tag", values: TAGS },
    resultTypes: ["violations", "incomplete"],
    elementRef: true,
    iframes: false,
    preload: false,
  });
  const supplemental = collectSupplementalFindings(page);
  const finalAnalysis = await analyzeDOM(page);
  const elementIds = new WeakMap();
  const locatorIds = new Map();
  let nextId = 0;
  function identify(node) {
    const element = node.element;
    if (element && element.nodeType === 1) {
      if (!elementIds.has(element)) elementIds.set(element, `element-${++nextId}`);
      return elementIds.get(element);
    }
    // The fallback still deduplicates a target shared by multiple rules.
    const key = JSON.stringify(node.target);
    if (!locatorIds.has(key)) locatorIds.set(key, `element-${++nextId}`);
    return locatorIds.get(key);
  }
  const confirmed = new Set();
  const manual = new Set();
  const confirmedRules = new Set();
  const manualRules = new Set();
  const issues = [];
  let detailsTruncated = false;
  for (const [status, results] of [
    ["violation", result.violations],
    ["manual-review", [...supplemental.rules, ...result.incomplete]],
  ]) {
    for (const rule of results) {
      const affected = new Set();
      const targets = [];
      const globalElements = status === "violation" ? confirmed : manual;
      (status === "violation" ? confirmedRules : manualRules).add(rule.id);
      for (const node of rule.nodes) {
        const elementId = identify(node);
        globalElements.add(elementId);
        if (affected.has(elementId)) continue;
        affected.add(elementId);
        if (targets.length >= REPORT_LIMITS.targetsPerIssue) { detailsTruncated = true; continue; }
        const element = node.element;
        const tag = element?.tagName?.toLowerCase() ?? "element";
        const id = element?.getAttribute("id");
        targets.push({
          elementId, frameId: 0,
          label: clip(id ? `${tag}#${id}` : `${tag} (${elementId})`, 200),
          contrast: rule.id === "color-contrast" ? contrastDetails(node) : null,
        });
      }
      if (issues.length >= REPORT_LIMITS.issues) { detailsTruncated = true; continue; }
      issues.push({
        id: `${status}:${rule.id}`, ruleId: rule.id, status,
        severity: ISSUE_SEVERITIES.includes(rule.impact) ? rule.impact : null,
        message: rule.id === "color-contrast"
          ? (status === "violation" ? "Low text-to-background contrast" : "Text-to-background contrast needs manual review")
          : clip(rule.help),
        description: describeFinding(rule), affectedCount: affected.size, targets,
      });
    }
  }
  const checkedRules = [...new Set([
    ...result.violations, ...result.incomplete, ...result.passes, ...result.inapplicable,
  ].map((rule) => rule.id))].sort();
  return {
    id: crypto.randomUUID(), pageSessionId, createdAt: new Date().toISOString(), phase,
    ...calculateScore(result),
    analysis: { ...finalAnalysis, stable: initialAnalysis.fingerprint === finalAnalysis.fingerprint },
    engine: { name: "axe-core", version: axe.version }, issues,
    summary: {
      issueTypes: confirmedRules.size, affectedElements: confirmed.size,
      manualReviewTypes: manualRules.size, manualReviewElements: manual.size,
    },
    coverage: {
      checkedRules, manualReviewRequired: true, detailsTruncated,
      unsupportedAreas: [
        "Embedded frames are not scanned in this version.",
        "Closed shadow roots and text drawn into images or canvas are not fully inspected.",
        "Hidden states, complete task usability, and the meaning of descriptions require separate review.",
        "Results describe the rendered page at scan time. Rescan after dynamic content or appearance changes.",
        "Complex image or gradient backgrounds can require manual contrast review.",
        "AccessMate checks supported active animations, playing media marked for autoplay, and common English colour instructions. Review GIFs, scripted autoplay without an autoplay attribute, and other colour cues manually.",
        ...(supplemental.limited ? ["AccessMate’s extra checks inspected the first 500 candidates in each category."] : []),
      ],
    },
  };
}
