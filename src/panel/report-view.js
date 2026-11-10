import { isScanReport, REPORT_LIMITS } from "../shared/messages.js";
import { compareReports } from "../analysis/scoring.js";
import { recommendAdaptations } from "../analysis/recommendations.js";
import { createHelpDetails } from "./settings-view.js";

/** Accessible plain-text reporting. Raw website markup is never rendered. */
export function createReportView({ onScan, onPreviewSuggestion, onSuggestionFeedback }) {
  const button = document.getElementById("scan-page");
  const status = document.getElementById("scan-status");
  const score = document.getElementById("assessment-score");
  const count = document.getElementById("issue-count");
  const results = document.getElementById("scan-results");
  let available = false;
  let busy = false;
  let hasReport = false;
  let stale = false;
  let baseline = null;
  let suggestionButtons = [];
  let activeSuggestion = null;
  let suggestionVotes = {};
  let feedbackVersion = 0;
  let feedbackBusy = false;
  const feedback = document.createElement("fieldset");
  const feedbackQuestion = document.createElement("legend");
  const feedbackStatus = paragraph("");
  feedbackStatus.id = "suggestion-feedback-status";
  feedbackStatus.setAttribute("role", "status");
  feedbackStatus.setAttribute("aria-atomic", "true");
  const feedbackButtons = document.createElement("div");
  feedbackButtons.className = "button-group";
  for (const [label, id, helpful] of [
    ["Helpful", "suggestion-helpful", true], ["Not helpful", "suggestion-not-helpful", false],
  ]) {
    const vote = document.createElement("button");
    vote.type = "button";
    vote.id = id;
    vote.textContent = label;
    vote.setAttribute("aria-pressed", "false");
    vote.addEventListener("click", () => { void submitFeedback(helpful); });
    feedbackButtons.append(vote);
  }
  feedback.id = "suggestion-feedback";
  feedback.hidden = true;
  feedback.append(feedbackQuestion, paragraph("Your vote helps order future suggestions on this device. Sharing uses the suggestion type and a random feedback ID."), feedbackButtons, feedbackStatus);
  results.before(feedback);
  score.previousElementSibling.textContent = "AccessMate assessment score";
  status.setAttribute("role", "status");
  status.setAttribute("aria-atomic", "true");
  button.addEventListener("click", () => { if (available && !busy) void onScan(); });
  const updateButton = () => {
    button.disabled = !available || busy;
    button.textContent = busy ? "Scanning…" : "Scan current page";
    results.setAttribute("aria-busy", String(busy));
    for (const suggestion of suggestionButtons) suggestion.disabled = !available || busy || stale;
    feedback.disabled = !available || feedbackBusy;
  };
  function paragraph(text) {
    const element = document.createElement("p");
    element.textContent = text;
    return element;
  }
  function showSuggestionFeedback(suggestion) {
    activeSuggestion = suggestion;
    feedbackVersion++;
    feedbackBusy = false;
    feedback.hidden = !suggestion;
    feedbackQuestion.textContent = suggestion ? `Did “${suggestion.title}” help?` : "";
    feedbackStatus.textContent = "";
    showSelectedVote(suggestionVotes[suggestion?.id]);
    updateButton();
  }

  function showSelectedVote(vote) {
    feedbackButtons.children[0].setAttribute("aria-pressed", String(vote === true));
    feedbackButtons.children[1].setAttribute("aria-pressed", String(vote === false));
  }

  async function submitFeedback(helpful) {
    if (!available || !activeSuggestion || feedbackBusy) return;
    const current = feedbackVersion;
    const id = activeSuggestion.id;
    feedbackBusy = true;
    feedbackStatus.textContent = "Saving feedback…";
    updateButton();
    try {
      const { shared } = await onSuggestionFeedback(id, helpful);
      if (current !== feedbackVersion) return;
      suggestionVotes[id] = helpful;
      showSelectedVote(helpful);
      feedbackStatus.textContent = shared ? "Feedback saved for future suggestions and shared." :
        "Feedback saved on this device for future suggestions. Sharing is unavailable.";
    } catch {
      if (current === feedbackVersion) {
        feedbackStatus.textContent = "Could not save feedback on this device. Try again.";
      }
    } finally {
      if (current === feedbackVersion) {
        feedbackBusy = false;
        updateButton();
      }
    }
  }
  function finding(issue) {
    const details = document.createElement("details");
    const summary = document.createElement("summary");
    const severity = issue.severity ? issue.severity[0].toUpperCase() + issue.severity.slice(1) : "Not rated";
    summary.textContent = `${issue.message} — ${severity} — ${issue.affectedCount} affected element(s)`;
    details.append(summary, paragraph(issue.description));
    const list = document.createElement("ul");
    for (const target of issue.targets) {
      const item = document.createElement("li");
      item.textContent = target.label;
      const contrast = target.contrast;
      if (contrast) {
        const parts = [];
        if (contrast.foreground) parts.push(`Text ${contrast.foreground}`);
        if (contrast.background) parts.push(`background ${contrast.background}`);
        if (contrast.ratio !== null) parts.push(`contrast ${contrast.ratio}:1`);
        if (contrast.requiredRatio !== null) parts.push(`required ${contrast.requiredRatio}:1`);
        if (parts.length) item.append(paragraph(parts.join("; ")));
      }
      list.append(item);
    }
    details.append(list);
    if (issue.targets.length < issue.affectedCount) {
      details.append(paragraph(`Showing ${issue.targets.length} examples of ${issue.affectedCount} affected elements.`));
    }
    return details;
  }

  function appendSuggestions(fragment, report, draft, votes) {
    if (!report.analysis.stable || !draft) return;
    const heading = document.createElement("h3");
    heading.textContent = "Suggested changes";
    fragment.append(heading);
    const recommendations = recommendAdaptations(report, draft.settings, votes);
    if (!recommendations.length) {
      fragment.append(paragraph("No new settings are suggested by this scan."));
      return;
    }
    const scope = draft.scope === "site" ? "this website’s" : "your personal";
    const note = paragraph(`Previews use ${scope} preference draft. Save preferences to keep a change.`);
    if (recommendations.length > 1 && recommendations.some(({ id }) => Object.hasOwn(votes, id))) {
      note.append(" Suggestions are ordered using your feedback.");
    }
    const list = document.createElement("ul");
    for (const recommendation of recommendations) {
      const item = document.createElement("li");
      const preview = document.createElement("button");
      preview.type = "button";
      preview.textContent = `Preview ${recommendation.title}`;
      preview.addEventListener("click", () => {
        if (!available || busy || stale || !preview.isConnected) return;
        const accepted = onPreviewSuggestion(report.pageSessionId, draft.scope, recommendation);
        stale = true;
        status.textContent = accepted
          ? "Suggestion added to your draft. Scan again to update findings."
          : "Suggestion unavailable for the current page or preference draft. Scan again.";
        updateButton();
        button.focus();
      });
      suggestionButtons.push(preview);
      item.append(paragraph(recommendation.reason), preview);
      list.append(item);
    }
    fragment.append(note, list);
  }

  return Object.freeze({
    setAvailable(value) { available = value; updateButton(); },
    showSuggestionFeedback,
    reset(message = "No scan results yet.") {
      busy = false;
      hasReport = false;
      stale = false;
      baseline = null;
      suggestionButtons = [];
      showSuggestionFeedback(null);
      score.textContent = "Not assessed";
      count.textContent = "Not assessed";
      status.textContent = message;
      results.replaceChildren(paragraph("No scan results for the current page."));
      updateButton();
    },
    begin() {
      busy = true;
      status.textContent = "Scanning, including text/background contrast…";
      updateButton();
    },
    fail(message) {
      busy = false;
      stale = true;
      status.textContent = message;
      updateButton();
    },
    markStale() {
      if (!hasReport || busy || stale) return;
      stale = true;
      status.textContent = "Page changed. Scan again to update findings.";
      updateButton();
    },
    show(report, draft = null, votes = {}) {
      if (!isScanReport(report)) throw new TypeError("Invalid accessibility report.");
      suggestionVotes = { ...votes };
      busy = false;
      hasReport = true;
      stale = false;
      suggestionButtons = [];
      score.textContent = report.score === null ? "Not assessed" : `${report.score}/100`;
      const summary = report.summary;
      count.textContent = `${summary.issueTypes} types · ${summary.affectedElements} elements`;
      status.textContent = `Scan complete · ${summary.issueTypes} issue types · ${summary.manualReviewTypes} need review.`;
      const fragment = document.createDocumentFragment();
      fragment.append(paragraph(`${new Date(report.createdAt).toLocaleTimeString()} · ${report.phase === "after" ? "Changes active" : "Original appearance"}.`));
      if (!report.analysis.stable) fragment.append(paragraph("Page changed during scanning. Results are provisional; scan again."));
      appendSuggestions(fragment, report, draft, votes);
      const scoreHelp = createHelpDetails("Score and scan coverage");
      const passed = report.scoring.passedRules.length;
      const failed = report.scoring.failedRules.length;
      scoreHelp.append(
        paragraph(`Passed rules: ${passed}; failed rules: ${failed}; uncertain-only rules excluded: ${report.scoring.inconclusiveRules.length}.`),
        paragraph(passed + failed ? `Score = rounded 100 × ${passed} ÷ ${passed + failed}. Each conclusive applicable rule counts once.` : "No conclusive applicable rules were available, so no score is assigned."),
        paragraph("The score uses conclusive axe-core rules. AccessMate’s motion, autoplay, and colour instruction signals appear under Needs manual review."),
        paragraph("Even a score of 100/100 requires manual review for WCAG compliance."));
      const structureHelp = createHelpDetails("Page structure");
      const analysis = report.analysis;
      structureHelp.append(paragraph(`${analysis.elements} elements; ${Object.values(analysis.headings).reduce((total, value) => total + value, 0)} headings; ${analysis.forms} forms; ${analysis.links} links; ${analysis.buttons} buttons; ${analysis.fields} fields; ${analysis.landmarks} landmarks.`),
        paragraph("Structure counts include hidden elements in the main document. Embedded and shadow content are excluded from this summary."));
      const comparisonHeading = document.createElement("h3");
      comparisonHeading.textContent = "Before/after comparison";
      fragment.append(comparisonHeading);
      if (report.phase === "before") {
        baseline = report.analysis.stable ? structuredClone(report) : null;
        fragment.append(paragraph(baseline ? "Baseline saved. Apply changes and scan again." : "Page changed; no baseline saved."));
      } else {
        const comparison = compareReports(baseline, report);
        if (comparison.comparable) {
          const sign = comparison.points > 0 ? "+" : "";
          fragment.append(paragraph(`Comparable score: ${comparison.beforeScore} → ${comparison.afterScore} (${sign}${comparison.points}).`),
            paragraph(`Issue types: ${baseline.summary.issueTypes} → ${summary.issueTypes}. Elements: ${baseline.summary.affectedElements} → ${summary.affectedElements}.`),
            createHelpDetails("Comparison", [
              `${comparison.comparedRules} shared conclusive rules compared; ${comparison.excludedRules} rules excluded due to differing applicability or certainty.`,
              "Comparison scores use shared rules and may differ from headline scores. Matching structure, text, rules, and engine allow comparison; other visual changes can still affect results.",
            ]));
        } else fragment.append(paragraph(comparison.reason));
      }
      for (const [kind, headingText] of [["violation", "Confirmed findings"], ["manual-review", "Needs manual review"]]) {
        const heading = document.createElement("h3");
        heading.textContent = headingText;
        fragment.append(heading);
        const issues = report.issues.filter((issue) => issue.status === kind);
        if (!issues.length) fragment.append(paragraph(kind === "violation" ? "No confirmed issues were detected by these checks." : "No uncertain findings were returned by these checks."));
        for (const issue of issues) fragment.append(finding(issue));
      }
      fragment.append(paragraph(`Manual review: ${summary.manualReviewElements} elements.`));
      scoreHelp.append(paragraph(`${report.coverage.checkedRules.length} rules evaluated by axe-core ${report.engine.version}. Automated checks do not establish complete accessibility. An element may appear in both confirmed and manual-review findings.`));
      for (const limitation of report.coverage.unsupportedAreas) scoreHelp.append(paragraph(limitation));
      if (report.coverage.detailsTruncated) fragment.append(paragraph("Some finding examples were omitted; counts include all results."));
      scoreHelp.append(paragraph(`Example details are limited to ${REPORT_LIMITS.targetsPerIssue} elements per finding and ${REPORT_LIMITS.issues} findings.`));
      fragment.append(scoreHelp, structureHelp);
      results.replaceChildren(fragment);
      updateButton();
    },
  });
}
