import { DatabaseSync } from "node:sqlite";

export function openProfileDatabase(filename) {
  const database = new DatabaseSync(filename);
  try {
    database.exec(`
      PRAGMA busy_timeout = 1000;
      BEGIN;
      CREATE TABLE IF NOT EXISTS shared_profiles (
        id TEXT PRIMARY KEY NOT NULL,
        origin TEXT NOT NULL,
        name TEXT NOT NULL,
        settings_json TEXT NOT NULL CHECK (json_valid(settings_json)),
        status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
        created_at TEXT NOT NULL
      ) STRICT;
      CREATE INDEX IF NOT EXISTS shared_profiles_public
        ON shared_profiles (origin, created_at DESC, id DESC)
        WHERE status = 'approved';
      CREATE TABLE IF NOT EXISTS moderation_decisions (
        id INTEGER PRIMARY KEY,
        profile_id TEXT NOT NULL REFERENCES shared_profiles (id),
        action TEXT NOT NULL CHECK (action IN ('approve', 'reject', 'unpublish')),
        decided_at TEXT NOT NULL
      ) STRICT;
      CREATE TABLE IF NOT EXISTS profile_ratings (
        profile_id TEXT NOT NULL REFERENCES shared_profiles (id),
        client_id TEXT NOT NULL,
        rating INTEGER NOT NULL CHECK (rating BETWEEN 1 AND 5),
        PRIMARY KEY (profile_id, client_id)
      ) STRICT;
      CREATE TABLE IF NOT EXISTS profile_reports (
        id INTEGER PRIMARY KEY,
        profile_id TEXT NOT NULL REFERENCES shared_profiles (id),
        client_id TEXT NOT NULL,
        reason TEXT NOT NULL CHECK (reason IN ('breaks-website', 'misleading', 'inappropriate')),
        reported_at TEXT NOT NULL,
        UNIQUE (profile_id, client_id)
      ) STRICT;
      CREATE TABLE IF NOT EXISTS suggestion_feedback (
        suggestion_id TEXT NOT NULL,
        client_id TEXT NOT NULL,
        helpful INTEGER NOT NULL CHECK (helpful IN (0, 1)),
        PRIMARY KEY (suggestion_id, client_id)
      ) STRICT;
      COMMIT;
    `);
    return database;
  } catch (error) {
    database.close();
    throw error;
  }
}
