import { randomUUID } from "node:crypto";
import { COMMUNITY_LIST_LIMIT, requireCommunityOrigin, requireCommunitySubmission } from "../src/shared/community-profiles.js";

export { ProfileInputError } from "../src/shared/community-profiles.js";

export function createProfileService(database) {
  const insert = database.prepare(
    "INSERT INTO shared_profiles (id, origin, name, settings_json, created_at) VALUES (?, ?, ?, ?, ?)",
  );
  const selectApproved = database.prepare(`
    WITH approved AS (
      SELECT id, origin, name, settings_json, created_at FROM shared_profiles
      WHERE origin = ? AND status = 'approved' ORDER BY created_at DESC, id DESC LIMIT ?
    )
    SELECT profile.*, COUNT(rating.rating) AS rating_count, ROUND(AVG(rating.rating), 1) AS average_rating
    FROM approved AS profile
    LEFT JOIN profile_ratings AS rating ON rating.profile_id = profile.id
    GROUP BY profile.id
    ORDER BY profile.created_at DESC, profile.id DESC
  `);

  return Object.freeze({
    submit(submission) {
      const { origin, name, settings } = requireCommunitySubmission(submission);
      const id = randomUUID();
      insert.run(id, origin, name, JSON.stringify(settings), new Date().toISOString());
      return { id, status: "pending" };
    },
    listApproved(origin) {
      requireCommunityOrigin(origin);
      return selectApproved.all(origin, COMMUNITY_LIST_LIMIT).map((row) => ({
        id: row.id,
        origin: row.origin,
        name: row.name,
        settings: JSON.parse(row.settings_json),
        createdAt: row.created_at,
        ratingCount: row.rating_count,
        averageRating: row.average_rating,
      }));
    },
  });
}
