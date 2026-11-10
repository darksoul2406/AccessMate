const COMMUNITY_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export const COMMUNITY_RATINGS = Object.freeze([1, 2, 3, 4, 5]);
export const COMMUNITY_REPORT_REASONS = Object.freeze({
  "breaks-website": "Breaks the website",
  misleading: "Misleading profile",
  inappropriate: "Inappropriate profile",
});

export function isCommunityId(value) {
  return typeof value === "string" && COMMUNITY_ID.test(value);
}

export function isCommunityRating(value) {
  return COMMUNITY_RATINGS.includes(value);
}

export function isCommunityReportReason(value) {
  return typeof value === "string" && Object.hasOwn(COMMUNITY_REPORT_REASONS, value);
}

export function isCommunityRatingSummary(count, average) {
  return Number.isSafeInteger(count) && count >= 0 &&
    (count === 0 ? average === null : Number.isFinite(average) &&
      average >= COMMUNITY_RATINGS[0] && average <= COMMUNITY_RATINGS.at(-1));
}
