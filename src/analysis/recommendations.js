const SUGGESTED_CONTROL_SIZE = 44;
export const SUGGESTION_IDS = Object.freeze({
  contrast: "increase-contrast",
  controls: "minimum-control-size",
});

export function isSuggestionId(value) {
  return Object.values(SUGGESTION_IDS).includes(value);
}

/** Suggest page-wide adaptations from confirmed findings in a validated report. */
export function recommendAdaptations(report, settings, votes = {}) {
  if (!report.analysis.stable) return [];

  const confirmed = report.issues.filter((issue) => issue.status === "violation" && issue.affectedCount > 0);
  const recommendations = [];
  const contrast = confirmed.find((issue) => issue.ruleId === "color-contrast");
  if (contrast && !settings.visual.highContrast) {
    const count = contrast.affectedCount;
    const customColours = settings.visual.textColor !== null || settings.visual.backgroundColor !== null;
    recommendations.push({
      id: SUGGESTION_IDS.contrast,
      title: "Increase contrast",
      reason: `Low text contrast was detected in ${count} ${count === 1 ? "element" : "elements"}. A high-contrast palette can make supported text easier to read.` +
        (customColours ? " It takes precedence over your custom colours while enabled." : ""),
      settings: { visual: { highContrast: true } },
    });
  }

  const smallTargets = confirmed.find((issue) => issue.ruleId === "target-size");
  if (smallTargets && (settings.interaction.targetSize ?? 0) < SUGGESTED_CONTROL_SIZE) {
    const count = smallTargets.affectedCount;
    recommendations.push({
      id: SUGGESTION_IDS.controls,
      title: `${SUGGESTED_CONTROL_SIZE} px minimum control size`,
      reason: `The scan flagged ${count} small ${count === 1 ? "target" : "targets"}. Enlarging supported controls can make them easier to click or tap.`,
      settings: { interaction: { targetSize: SUGGESTED_CONTROL_SIZE } },
    });
  }

  const priority = ({ id }) => votes[id] === true ? 1 : votes[id] === false ? -1 : 0;
  return recommendations.sort((first, second) => priority(second) - priority(first));
}
