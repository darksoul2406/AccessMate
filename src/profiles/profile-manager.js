import { DEFAULT_SETTINGS, createDefaultSettings } from "../shared/defaults.js";
import { CONTENT_ACTIONS, MOTION_BEHAVIORS } from "../shared/contracts.js";
import { getPreset } from "./presets.js";

/** @typedef {import("../shared/contracts.js").Settings} Settings */
/** @typedef {import("../shared/contracts.js").SettingsOverrides} SettingsOverrides */
/** @typedef {{valid: boolean, errors: Array<string>}} ValidationResult */

// Project limits for customization, not claims about what every person needs.
// Future UI controls can import these limits rather than duplicating numbers.
export const SETTINGS_LIMITS = Object.freeze({
  textScale: Object.freeze({ min: 50, max: 300 }),
  lineHeight: Object.freeze({ min: 1, max: 3 }),
  letterSpacing: Object.freeze({ min: 0, max: 0.5 }),
  zoom: Object.freeze({ min: 50, max: 300 }),
  targetSize: Object.freeze({ min: 24, max: 96 }),
  speechRate: Object.freeze({ min: 0.1, max: 10 }),
});

function inRange(value, limits) {
  return (
    typeof value === "number" &&
    Number.isFinite(value) &&
    value >= limits.min &&
    value <= limits.max
  );
}

function isColor(value) {
  return value === null || (typeof value === "string" && /^#[0-9a-f]{6}$/i.test(value));
}

// Boolean fields are checked against their boolean defaults below. These rules
// cover the remaining values; no string-to-number or truthiness coercion occurs.
const valueRules = {
  visual: {
    textScale: (value) => inRange(value, SETTINGS_LIMITS.textScale),
    lineHeight: (value) => value === null || inRange(value, SETTINGS_LIMITS.lineHeight),
    letterSpacing: (value) => value === null || inRange(value, SETTINGS_LIMITS.letterSpacing),
    textColor: isColor,
    backgroundColor: isColor,
    // Existing numeric version-1 preferences remain valid, including 100.
    // null adds an explicit Original choice without rewriting saved profiles.
    zoom: (value) => value === null || inRange(value, SETTINGS_LIMITS.zoom),
  },
  interaction: {
    targetSize: (value) => value === null || inRange(value, SETTINGS_LIMITS.targetSize),
    cursorSize: (value) => ["original", "large", "extra-large"].includes(value),
  },
  sensory: {
    motionBehavior: (value) => MOTION_BEHAVIORS.includes(value),
  },
  content: Object.fromEntries(
    Object.keys(DEFAULT_SETTINGS.content).map((key) => [
      key,
      (value) => CONTENT_ACTIONS.includes(value) && (key === "ads" || value !== "block"),
    ]),
  ),
  reading: {
    voiceName: (value) =>
      value === null ||
      (typeof value === "string" &&
        value.trim().length > 0 &&
        value.length <= 200 &&
        !/[\u0000-\u001f\u007f]/.test(value)),
    speechRate: (value) => inRange(value, SETTINGS_LIMITS.speechRate),
  },
  colorVision: {
    filter: (value) =>
      ["none", "protanopia", "deuteranopia", "tritanopia", "grayscale"].includes(value),
  },
};

// Accept JSON-style objects, including null-prototype records. Reject arrays,
// class instances, symbols, and getters before inspecting property values.
function isDataRecord(value) {
  if (value === null || typeof value !== "object") return false;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return false;
  if (Object.getOwnPropertySymbols(value).length > 0) return false;
  return Object.values(Object.getOwnPropertyDescriptors(value)).every(
    (descriptor) => descriptor.enumerable && Object.hasOwn(descriptor, "value"),
  );
}

/** @param {unknown} value @param {boolean} partial @returns {ValidationResult} */
function validate(value, partial) {
  const errors = [];
  if (!isDataRecord(value)) {
    return { valid: false, errors: ["Settings must be a plain data object."] };
  }

  for (const group of Object.keys(value)) {
    if (!Object.hasOwn(DEFAULT_SETTINGS, group)) {
      // Do not echo untrusted property names or values into user-facing errors.
      errors.push("Unknown settings group.");
    }
  }

  for (const [group, defaults] of Object.entries(DEFAULT_SETTINGS)) {
    if (!Object.hasOwn(value, group)) {
      if (!partial) errors.push(`Missing settings group: ${group}.`);
      continue;
    }
    const supplied = value[group];
    if (!isDataRecord(supplied)) {
      errors.push(`Settings group ${group} must be a plain data object.`);
      continue;
    }

    for (const key of Object.keys(supplied)) {
      if (!Object.hasOwn(defaults, key)) errors.push(`Unknown setting in ${group}.`);
    }
    for (const [key, defaultValue] of Object.entries(defaults)) {
      if (!Object.hasOwn(supplied, key)) {
        if (!partial) errors.push(`Missing setting: ${group}.${key}.`);
        continue;
      }
      const valid =
        typeof defaultValue === "boolean"
          ? typeof supplied[key] === "boolean"
          : valueRules[group][key](supplied[key]);
      if (!valid) errors.push(`Invalid value for ${group}.${key}.`);
    }
  }
  return { valid: errors.length === 0, errors };
}

/**
 * Check a complete settings object without changing it. All groups and fields
 * are required; unknown fields and invalid values are rejected.
 *
 * @param {unknown} settings
 * @returns {ValidationResult}
 */
export function validateSettings(settings) {
  return validate(settings, false);
}

/**
 * Check partial overrides. An empty object is valid; a supplied undefined or
 * null group is not. A nullable individual setting may explicitly contain null.
 *
 * @param {unknown} overrides
 * @returns {ValidationResult}
 */
export function validateSettingsOverrides(overrides) {
  return validate(overrides, true);
}

/**
 * Merge only validated, known fields into a fresh settings object. Every setting
 * is primitive, so copying fields introduces no nested references to inputs.
 * Validation failures throw instead of silently discarding user preferences.
 *
 * @param {Array<SettingsOverrides>} layers
 * @returns {Settings}
 */
function mergeLayers(layers) {
  // Validate every layer before merging any of them.
  for (const layer of layers) {
    const result = validateSettingsOverrides(layer);
    if (!result.valid) throw new TypeError(result.errors.join(" "));
  }
  const settings = createDefaultSettings();
  for (const layer of layers) {
    for (const [group, overrides] of Object.entries(layer)) {
      Object.assign(settings[group], overrides);
    }
  }
  return settings;
}

/**
 * Resolve settings in ascending priority: defaults, global preferences, site
 * overrides, temporary preview. Later supplied fields win. Missing fields
 * inherit; false, 0, and null remain explicit values where their rules allow.
 * This function does not save or apply settings, or check site permissions.
 *
 * @param {SettingsOverrides} [globalSettings={}]
 * @param {SettingsOverrides} [siteOverrides={}]
 * @param {SettingsOverrides} [previewOverrides={}]
 * @returns {Settings}
 * @throws {TypeError} If any layer contains invalid settings.
 */
export function resolveSettings(
  globalSettings = {},
  siteOverrides = {},
  previewOverrides = {},
) {
  return mergeLayers([globalSettings, siteOverrides, previewOverrides]);
}

/**
 * Overlay a selected preset's suggestions onto complete personal settings.
 * Unrelated custom choices remain. Pass fresh defaults for a fresh preset start.
 * The caller must explain which settings the preset changes before applying it.
 *
 * @param {string} presetId
 * @param {Settings} [currentSettings]
 * @returns {Settings} Independent, editable result; inputs stay unchanged.
 * @throws {RangeError} If the preset ID is unknown.
 * @throws {TypeError} If current settings are incomplete or invalid.
 */
export function applyPresetToSettings(presetId, currentSettings = createDefaultSettings()) {
  const preset = getPreset(presetId);
  if (!preset) throw new RangeError("Unknown AccessMate preset ID.");
  const result = validateSettings(currentSettings);
  if (!result.valid) throw new TypeError(result.errors.join(" "));
  return mergeLayers([currentSettings, preset.settings]);
}
