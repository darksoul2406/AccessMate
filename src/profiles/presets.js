import { createDefaultSettings } from "../shared/defaults.js";

/** @typedef {import("../shared/contracts.js").Preset} Preset */
/** @typedef {import("../shared/contracts.js").Settings} Settings */

/**
 * Protect the shared template and its settings groups. Settings currently
 * contain only primitive values, so freezing these two levels is sufficient.
 *
 * @param {Preset} preset
 * @returns {Readonly<Preset>}
 */
function freezePreset(preset) {
  for (const group of Object.values(preset.settings)) Object.freeze(group);
  Object.freeze(preset.settings);
  return Object.freeze(preset);
}

/** @type {Array<Preset>} */
const definitions = [
  {
    id: "low-vision",
    name: "Visually Impaired / Low Vision",
    description: "Enlarges text, controls, and the cursor, increases contrast, and highlights keyboard focus.",
    optionalAdvice: "In Assistance, try Read aloud, Page navigation for headings and sections, or Image assistance for descriptions and OCR.",
    settings: {
      visual: {
        textScale: 150,
        lineHeight: 1.6,
        highContrast: true,
      },
      interaction: {
        targetSize: 44,
        cursorSize: "large",
        highlightFocus: true,
      },
    },
  },
  {
    id: "sensory-cognitive",
    name: "Sensory & Cognitive-Friendly",
    description: "Pauses supported animations, reduces flashing, stops autoplay, and hides common pop-ups, banners, and extra widgets.",
    optionalAdvice: "Try Reading Mode in Assistance for a simpler article view.",
    settings: {
      sensory: {
        reduceMotion: true,
        motionBehavior: "pause",
        reduceFlashing: true,
        stopAutoplay: true,
      },
      content: {
        popups: "hide",
        banners: "hide",
        clutter: "hide",
      },
    },
  },
  {
    id: "color-vision",
    name: "Color Vision Support",
    description: "Adds labels, icons, and patterns to help identify supported colour-coded information.",
    optionalAdvice: "In Customize, choose a colour filter or turn on higher contrast if it helps.",
    settings: {
      colorVision: {
        addLabels: true,
        addIcons: true,
        addPatterns: true,
      },
    },
  },
  {
    id: "enhanced",
    name: "General / Enhanced User",
    description: "Makes text larger, adds space between lines, and hides promotional banners.",
    optionalAdvice: "Try Reading Mode, adjust Page zoom, or choose what to hide in Distractions. Save your choices under This website only to keep them for this site.",
    settings: {
      visual: {
        textScale: 125,
        lineHeight: 1.6,
      },
      content: {
        banners: "hide",
      },
    },
  },
];

/**
 * Read-only starting templates, not diagnoses or fixed user categories.
 * Presets leave the user's network blocking and colour filter choices intact.
 * Applying, previewing, saving, and mixing preferences belong to other modules.
 *
 * @type {ReadonlyArray<Readonly<Preset>>}
 */
export const PRESETS = Object.freeze(definitions.map(freezePreset));

/**
 * Look up a read-only template; unknown IDs have no implicit fallback.
 *
 * @param {string} presetId
 * @returns {Readonly<Preset> | null}
 */
export function getPreset(presetId) {
  return PRESETS.find((preset) => preset.id === presetId) ?? null;
}

/**
 * Create independent, editable settings by layering this preset over defaults.
 * This is a fresh start, not a merge into an existing user's saved preferences.
 * A future profile manager will handle that choice and site/preview precedence.
 * No existing profile is modified and no setting is applied to a website here.
 *
 * @param {string} presetId
 * @returns {Settings}
 * @throws {RangeError} If the preset ID is unknown.
 */
export function createSettingsFromPreset(presetId) {
  const preset = getPreset(presetId);
  if (!preset) throw new RangeError("Unknown AccessMate preset ID.");

  const settings = createDefaultSettings();
  for (const [group, overrides] of Object.entries(preset.settings)) {
    // These overrides are trusted local definitions, not unvalidated input.
    Object.assign(settings[group], overrides);
  }
  return settings;
}
