import { isCommunityId, isCommunityRating, isCommunityReportReason } from "../src/shared/community-feedback.js";
import { isSuggestionId } from "../src/analysis/recommendations.js";

const REPORT_QUEUE_LIMIT = 50;

export class FeedbackError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function requireFeedback(profileId, body, field) {
  if (!isCommunityId(profileId)) {
    throw new FeedbackError(400, "Use a valid profile ID.");
  }
  if (!body || Object.getPrototypeOf(body) !== Object.prototype || Object.keys(body).length !== 2 ||
    !Object.hasOwn(body, field) || !Object.hasOwn(body, "clientId") ||
    !isCommunityId(body.clientId)) {
    throw new FeedbackError(400, "Include a valid feedback client ID and " + field + ".");
  }
}

export function createFeedbackService(database) {
  // Check approval in the write itself, so concurrent moderation cannot leave
  // feedback on a profile that had already been taken down.
  const saveRating = database.prepare(`
    INSERT INTO profile_ratings (profile_id, client_id, rating)
    SELECT id, ?, ? FROM shared_profiles WHERE id = ? AND status = 'approved'
    ON CONFLICT (profile_id, client_id) DO UPDATE SET rating = excluded.rating
  `);
  const saveReport = database.prepare(`
    INSERT INTO profile_reports (profile_id, client_id, reason, reported_at)
    SELECT id, ?, ?, ? FROM shared_profiles WHERE id = ? AND status = 'approved'
    ON CONFLICT (profile_id, client_id) DO UPDATE SET reported_at = profile_reports.reported_at
  `);
  const activeReports = database.prepare(`
    SELECT report.id, report.profile_id AS profileId, profile.name AS profileName,
      profile.origin, report.reason, report.reported_at AS reportedAt
    FROM profile_reports AS report
    JOIN shared_profiles AS profile ON profile.id = report.profile_id
    WHERE profile.status = 'approved'
    ORDER BY report.reported_at, report.id
    LIMIT ?
  `);
  const saveSuggestion = database.prepare(`
    INSERT INTO suggestion_feedback (suggestion_id, client_id, helpful) VALUES (?, ?, ?)
    ON CONFLICT (suggestion_id, client_id) DO UPDATE SET helpful = excluded.helpful
  `);

  return Object.freeze({
    rate(profileId, body) {
      requireFeedback(profileId, body, "rating");
      const { clientId, rating } = body;
      if (!isCommunityRating(rating)) {
        throw new FeedbackError(400, "Choose a whole-number rating from 1 to 5.");
      }
      if (!saveRating.run(clientId, rating, profileId).changes) {
        throw new FeedbackError(404, "Only approved profiles can receive feedback.");
      }
      return { rating };
    },
    report(profileId, body) {
      requireFeedback(profileId, body, "reason");
      const { clientId, reason } = body;
      if (!isCommunityReportReason(reason)) throw new FeedbackError(400, "Choose a supported report reason.");
      // Repeated submissions keep the original reason and time.
      if (!saveReport.run(clientId, reason, new Date().toISOString(), profileId).changes) {
        throw new FeedbackError(404, "Only approved profiles can receive feedback.");
      }
      return { received: true };
    },
    listReports() {
      return activeReports.all(REPORT_QUEUE_LIMIT);
    },
    rateSuggestion(body) {
      if (!body || Object.getPrototypeOf(body) !== Object.prototype || Object.keys(body).length !== 3 ||
        !["suggestionId", "clientId", "helpful"].every((key) => Object.hasOwn(body, key)) ||
        !isSuggestionId(body.suggestionId) || !isCommunityId(body.clientId) || typeof body.helpful !== "boolean") {
        throw new FeedbackError(400, "Choose a supported suggestion and a helpfulness vote.");
      }
      saveSuggestion.run(body.suggestionId, body.clientId, Number(body.helpful));
      return { helpful: body.helpful };
    },
  });
}
