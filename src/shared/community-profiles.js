import { validateSettingsOverrides } from "../profiles/profile-manager.js";
import { siteProfileKey } from "../profiles/profile-storage.js";

export const COMMUNITY_NAME_LIMIT = 80;
export const COMMUNITY_LIST_LIMIT = 50;

export class ProfileInputError extends Error {}

export function requireCommunityOrigin(origin) {
  try {
    siteProfileKey(origin);
  } catch {
    throw new ProfileInputError("Use an HTTP or HTTPS origin without a path, query, or fragment.");
  }
}

function shareable(group, key, value) {
  if (group === "reading") return key === "speechRate";
  if (group === "interaction" && key === "keyboardNavigation") return false;
  if (group === "content") return value === "allow" || value === "hide";
  return true;
}

/** Copy only supported, portable fields from a website's overrides. */
export function pickCommunitySettings(overrides) {
  if (!validateSettingsOverrides(overrides).valid) {
    throw new ProfileInputError("Choose valid AccessMate settings.");
  }
  const settings = {};
  for (const [group, values] of Object.entries(overrides)) {
    const fields = Object.entries(values).filter(([key, value]) => shareable(group, key, value));
    if (fields.length) settings[group] = Object.fromEntries(fields);
  }
  return settings;
}

export function requireCommunitySubmission(submission) {
  if (!submission || Object.getPrototypeOf(submission) !== Object.prototype ||
    Object.keys(submission).length !== 3 ||
    !["origin", "name", "settings"].every((key) => Object.hasOwn(submission, key))) {
    throw new ProfileInputError("A submission needs an origin, name, and settings.");
  }
  const { origin, name, settings } = submission;
  requireCommunityOrigin(origin);
  if (typeof name !== "string" || !name.trim() || name.trim().length > COMMUNITY_NAME_LIMIT || /\p{Cc}/u.test(name)) {
    throw new ProfileInputError("Use a profile name of 1 to 80 characters without control characters.");
  }
  const portable = pickCommunitySettings(settings);
  if (Object.entries(settings).some(([group, values]) =>
    Object.keys(values).some((key) => !Object.hasOwn(portable[group] ?? {}, key)))) {
    throw new ProfileInputError("Choose settings that can be shared across devices.");
  }
  if (!Object.keys(portable).length) {
    throw new ProfileInputError("Share at least one valid AccessMate setting.");
  }
  return { origin, name: name.trim(), settings: portable };
}
