const QUEUE_LIMIT = 50;
const PROFILE_ID = /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/;
const TRANSITIONS = new Map([
  ["approve", { from: "pending", to: "approved" }],
  ["reject", { from: "pending", to: "rejected" }],
  ["unpublish", { from: "approved", to: "rejected" }],
]);

export class ModerationError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export function createModerationService(database) {
  const listProfiles = database.prepare(
    "SELECT id, origin, name, settings_json AS settings, status, created_at AS createdAt FROM shared_profiles " +
    "WHERE status = ? ORDER BY created_at, id LIMIT ?",
  );
  const find = database.prepare("SELECT 1 FROM shared_profiles WHERE id = ?");
  const setStatus = database.prepare("UPDATE shared_profiles SET status = ? WHERE id = ? AND status = ?");
  const logDecision = database.prepare(
    "INSERT INTO moderation_decisions (profile_id, action, decided_at) VALUES (?, ?, ?)",
  );

  return Object.freeze({
    list(status = "pending") {
      if (!["pending", "approved", "rejected"].includes(status)) {
        throw new ModerationError(400, "Choose pending, approved, or rejected profiles.");
      }
      return listProfiles.all(status, QUEUE_LIMIT).map((row) => ({ ...row, settings: JSON.parse(row.settings) }));
    },
    decide(id, decision) {
      if (typeof id !== "string" || !PROFILE_ID.test(id)) {
        throw new ModerationError(400, "Use a valid profile ID.");
      }
      if (!decision || Object.getPrototypeOf(decision) !== Object.prototype ||
        Object.keys(decision).length !== 1 || !Object.hasOwn(decision, "action") || !TRANSITIONS.has(decision.action)) {
        throw new ModerationError(400, "Use approve, reject, or unpublish as the action.");
      }

      const { action } = decision;
      const { from, to } = TRANSITIONS.get(action);
      const decidedAt = new Date().toISOString();
      // Commit the status and its decision history together.
      database.exec("BEGIN IMMEDIATE;");
      try {
        if (!setStatus.run(to, id, from).changes) {
          if (!find.get(id)) throw new ModerationError(404, "Profile not found.");
          throw new ModerationError(409, "This decision is unavailable for the profile's current status.");
        }
        logDecision.run(id, action, decidedAt);
        database.exec("COMMIT;");
      } catch (error) {
        database.exec("ROLLBACK;");
        throw error;
      }
      return { id, status: to, action, decidedAt };
    },
  });
}
