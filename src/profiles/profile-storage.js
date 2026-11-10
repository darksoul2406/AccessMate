import { PROFILE_SCHEMA_VERSION, PRESET_IDS } from "../shared/contracts.js";
import { validateSettings, validateSettingsOverrides } from "./profile-manager.js";
import { DEFAULT_SETTINGS } from "../shared/defaults.js";

export const PERSONAL_PROFILE_KEY = "accessmate:profile:personal";
const SITE_PREFIX = "accessmate:profile:site:";

/** Reject paths, credentials, queries, and fragments; store an origin only. */
export function siteProfileKey(origin) {
  if (typeof origin !== "string" || origin.length > 2048) {
    throw new TypeError("A valid website origin is required.");
  }
  const url = new URL(origin);
  if (!["http:", "https:"].includes(url.protocol) || url.origin !== origin) {
    throw new TypeError("Use a canonical HTTP or HTTPS origin without a path.");
  }
  return SITE_PREFIX + encodeURIComponent(origin);
}

function requireRecord(value, fields) {
  if (value === null || typeof value !== "object") throw new TypeError("Invalid profile data.");
  const proto = Object.getPrototypeOf(value);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (
    (proto !== Object.prototype && proto !== null) ||
    Object.getOwnPropertySymbols(value).length ||
    Object.keys(descriptors).length !== fields.length ||
    fields.some((key) => !Object.hasOwn(descriptors, key)) ||
    Object.values(descriptors).some((entry) => !entry.enumerable || !Object.hasOwn(entry, "value"))
  ) throw new TypeError("Invalid profile fields.");
}

function requireMetadata(profile) {
  if (profile.schemaVersion !== PROFILE_SCHEMA_VERSION) {
    throw new TypeError("Saved profile version is unsupported. Saved data was not changed.");
  }
  if (
    typeof profile.updatedAt !== "string" ||
    !Number.isFinite(Date.parse(profile.updatedAt)) ||
    new Date(profile.updatedAt).toISOString() !== profile.updatedAt
  ) throw new TypeError("Invalid profile timestamp.");
}

function requirePersonalProfile(profile) {
  requireRecord(profile, ["schemaVersion", "id", "name", "presetId", "settings", "updatedAt"]);
  requireMetadata(profile);
  // This additive preference did not exist in older version-1 profiles. Add it
  // only to the returned value, without writing storage or filling other gaps.
  // First validate the original groups/values so accessors, unknown fields, and
  // invalid existing preferences cannot be hidden by copying or normalization.
  if (validateSettingsOverrides(profile.settings).valid && Object.hasOwn(profile.settings, "sensory") &&
    !Object.hasOwn(profile.settings.sensory, "motionBehavior")) {
    profile = {
      ...profile,
      settings: {
        ...profile.settings,
        sensory: { ...profile.settings.sensory, motionBehavior: DEFAULT_SETTINGS.sensory.motionBehavior },
      },
    };
  }
  if (
    profile.id !== "personal" || profile.name !== "My preferences" ||
    (profile.presetId !== null && !PRESET_IDS.includes(profile.presetId)) ||
    !validateSettings(profile.settings).valid
  ) throw new TypeError("Invalid personal preferences.");
  return profile;
}

function requireSiteProfile(profile, origin) {
  requireRecord(profile, ["schemaVersion", "origin", "overrides", "autoApply", "updatedAt"]);
  requireMetadata(profile);
  if (
    profile.origin !== origin || typeof profile.autoApply !== "boolean" ||
    !validateSettingsOverrides(profile.overrides).valid
  ) throw new TypeError("Invalid website preferences.");
}

/**
 * Use chrome.storage.local, not webpage storage or cloud sync. An injected
 * storage area allows testing without touching the user's real preferences.
 * Each site has its own key, avoiding read/modify/write of a shared site list.
 * Invalid or future-version records are rejected, never erased or overwritten
 * automatically. Storage failures propagate to the UI for a visible retry.
 */
export function createProfileStorage(area = globalThis.chrome?.storage?.local) {
  if (!area || typeof area.get !== "function" || typeof area.set !== "function") {
    throw new Error("Local extension storage is unavailable.");
  }

  return Object.freeze({
    async loadPersonalProfile() {
      const result = await area.get(PERSONAL_PROFILE_KEY);
      if (!Object.hasOwn(result, PERSONAL_PROFILE_KEY)) return null;
      const profile = requirePersonalProfile(result[PERSONAL_PROFILE_KEY]);
      return structuredClone(profile);
    },

    async savePersonalProfile(settings, presetId = null) {
      if (!validateSettings(settings).valid) throw new TypeError("Invalid personal preferences.");
      const profile = {
        schemaVersion: PROFILE_SCHEMA_VERSION,
        id: "personal",
        name: "My preferences",
        presetId,
        settings: structuredClone(settings),
        updatedAt: new Date().toISOString(),
      };
      requirePersonalProfile(profile);
      // Refuse to replace a corrupt or incompatible existing record.
      await this.loadPersonalProfile();
      await area.set({ [PERSONAL_PROFILE_KEY]: profile });
      return structuredClone(profile);
    },

    async loadSiteProfile(origin) {
      const key = siteProfileKey(origin);
      const result = await area.get(key);
      if (!Object.hasOwn(result, key)) return null;
      const profile = result[key];
      requireSiteProfile(profile, origin);
      return structuredClone(profile);
    },

    async saveSiteProfile(origin, overrides, autoApply = false) {
      const key = siteProfileKey(origin);
      if (!validateSettingsOverrides(overrides).valid) throw new TypeError("Invalid website preferences.");
      const profile = {
        schemaVersion: PROFILE_SCHEMA_VERSION,
        origin,
        overrides: structuredClone(overrides),
        autoApply,
        updatedAt: new Date().toISOString(),
      };
      requireSiteProfile(profile, origin);
      await this.loadSiteProfile(origin);
      await area.set({ [key]: profile });
      return structuredClone(profile);
    },
  });
}
