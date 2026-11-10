export const SCORING_VERSION = "rule-pass-v1";

/**
 * Rule-based automated score, not a percentage of WCAG compliance.
 * Each applicable rule contributes once. A violation takes precedence over a
 * pass; an uncertain result takes precedence over a pass. Inapplicable rules
 * do not inflate the score. Uncertain-only rules are excluded and disclosed.
 * Formula: round(100 * passed / (passed + failed)); no conclusive rules => null.
 * Node counts and severity remain separate report measures.
 */
export function calculateScore(results) {
  const failed = new Set(results.violations.map((rule) => rule.id));
  const uncertain = new Set(results.incomplete.map((rule) => rule.id).filter((id) => !failed.has(id)));
  const passed = new Set(results.passes.map((rule) => rule.id).filter((id) => !failed.has(id) && !uncertain.has(id)));
  const details = {
    passedRules: [...passed].sort(), failedRules: [...failed].sort(), inconclusiveRules: [...uncertain].sort(),
  };
  const denominator = passed.size + failed.size;
  return { score: denominator ? Math.round(100 * passed.size / denominator) : null, scoringVersion: SCORING_VERSION, scoring: details };
}

/** Pure comparison: the UI retains a baseline only in its current page session. */
export function compareReports(before, after) {
  if (!before || before.phase !== "before") return { comparable: false, reason: "Restore the original appearance and scan it first to establish a baseline." };
  if (after.phase !== "after") return { comparable: false, reason: "Apply an adaptation, then scan again for a before/after comparison." };
  const sorted = (values) => JSON.stringify([...values].sort());
  const sameRules = (a, b) => sorted(a) === sorted(b);
  if (before.pageSessionId !== after.pageSessionId || before.engine.version !== after.engine.version ||
    before.scoringVersion !== after.scoringVersion || before.analysis.fingerprintVersion !== after.analysis.fingerprintVersion ||
    before.analysis.fingerprint !== after.analysis.fingerprint || !before.analysis.stable || !after.analysis.stable ||
    !sameRules(before.coverage.checkedRules, after.coverage.checkedRules)) {
    return { comparable: false, reason: "The page, content, engine, applicable rules, or scan coverage changed. These scores are not directly comparable." };
  }
  const beforeRules = new Set([...before.scoring.passedRules, ...before.scoring.failedRules]);
  const afterRules = new Set([...after.scoring.passedRules, ...after.scoring.failedRules]);
  const shared = [...beforeRules].filter((id) => afterRules.has(id));
  if (!shared.length) return { comparable: false, reason: "There are no shared conclusive applicable rules to compare." };
  const commonScore = (report) => Math.round(100 * shared.filter((id) => report.scoring.passedRules.includes(id)).length / shared.length);
  const beforeScore = commonScore(before);
  const afterScore = commonScore(after);
  return {
    comparable: true, beforeScore, afterScore, comparedRules: shared.length,
    excludedRules: new Set([...beforeRules, ...afterRules]).size - shared.length,
    points: afterScore - beforeScore,
    issueTypes: after.summary.issueTypes - before.summary.issueTypes,
    affectedElements: after.summary.affectedElements - before.summary.affectedElements,
  };
}
