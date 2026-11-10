/** @typedef {import("./contracts.js").Settings} Settings */

/**
 * Neutral starting preferences. This object contains data only: importing it
 * does not apply styles, reset browser zoom, start speech, or hide content.
 *
 * null preserves a website value; 100 is the baseline percentage; false leaves
 * an optional adaptation off. Profiles can opt into individual changes later.
 * Every group is frozen as well as the outer object to protect shared defaults.
 *
 * @type {Readonly<Settings>}
 */
export const DEFAULT_SETTINGS = Object.freeze({
  visual: Object.freeze({
    textScale: 100,
    lineHeight: null,
    letterSpacing: null,
    highContrast: false,
    textColor: null,
    backgroundColor: null,
    zoom: null,
  }),

  interaction: Object.freeze({
    targetSize: null,
    cursorSize: "original",
    highlightFocus: false,
    keyboardNavigation: false,
  }),

  sensory: Object.freeze({
    reduceMotion: false,
    motionBehavior: "pause",
    reduceFlashing: false,
    stopAutoplay: false,
    muteAudio: false,
  }),

  content: Object.freeze({
    ads: "allow",
    popups: "allow",
    banners: "allow",
    recommendations: "allow",
    sidebars: "allow",
    clutter: "allow",
  }),

  reading: Object.freeze({
    readAloudEnabled: false,
    voiceName: null,
    speechRate: 1,
    readingMode: false,
  }),

  colorVision: Object.freeze({
    filter: "none",
    addLabels: false,
    addIcons: false,
    addPatterns: false,
  }),
});

/**
 * Create an independent, editable settings object for a profile or preview.
 * A shallow copy would still share nested groups; structuredClone copies them.
 * This creates settings only, not a saved profile or an active page adaptation.
 *
 * @returns {Settings}
 */
export function createDefaultSettings() {
  return structuredClone(DEFAULT_SETTINGS);
}
