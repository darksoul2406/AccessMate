/**
 * Shared vocabulary and data shapes for AccessMate modules.
 *
 * JSDoc typedefs document objects and help editors explain their properties.
 * They do not validate values at runtime. Storage and messaging modules must
 * validate incoming data before using it. This file has no browser side effects.
 *
 * Profiles, reports, and recommendations use plain JSON-compatible data.
 * ChangeRecord is the exception: it stays in memory inside its page session.
 */

export const PROFILE_SCHEMA_VERSION = 1;

/** @typedef {"low-vision" | "sensory-cognitive" | "color-vision" | "enhanced"} PresetId */
/** @type {ReadonlyArray<PresetId>} */
export const PRESET_IDS = Object.freeze([
  "low-vision",
  "sensory-cognitive",
  "color-vision",
  "enhanced",
]);

/** @typedef {"minor" | "moderate" | "serious" | "critical"} IssueSeverity */
/** @type {ReadonlyArray<IssueSeverity>} */
export const ISSUE_SEVERITIES = Object.freeze([
  "minor",
  "moderate",
  "serious",
  "critical",
]);

/** @typedef {"allow" | "minimize" | "hide"} DisplayAction */
/** @typedef {DisplayAction | "block"} ContentAction */
/** @type {ReadonlyArray<ContentAction>} */
export const CONTENT_ACTIONS = Object.freeze(["allow", "minimize", "hide", "block"]);

/** @typedef {"pause" | "hide"} MotionBehavior */
/** @type {ReadonlyArray<MotionBehavior>} */
export const MOTION_BEHAVIORS = Object.freeze(["pause", "hide"]);

/**
 * null means preserve the website's original value. Custom colors are six-digit
 * hex strings such as "#17253a"; arbitrary CSS is not a settings value.
 *
 * @typedef {Object} VisualSettings
 * @property {number} textScale Percentage relative to original text size; 100 preserves it.
 * @property {number | null} lineHeight Unitless line-height, or null for the original.
 * @property {number | null} letterSpacing Letter spacing in em, or null for the original.
 * @property {boolean} highContrast Whether to request a high-contrast presentation.
 * @property {string | null} textColor Custom text color, or null for the original.
 * @property {string | null} backgroundColor Custom background color, or null for the original.
 * @property {number | null} zoom Absolute Chrome page zoom percentage; null preserves/restores the pre-AccessMate zoom. Unlike null, 100 explicitly requests 100%.
 */

/**
 * @typedef {Object} InteractionSettings
 * @property {number | null} targetSize Minimum control target size in CSS pixels.
 * @property {"original" | "large" | "extra-large"} cursorSize Preferred pointer size.
 * @property {boolean} highlightFocus Whether to strengthen keyboard focus indicators.
 * @property {boolean} keyboardNavigation Whether to offer additional navigation assistance.
 */

/**
 * These are requests for supported adaptations, not guarantees that all motion,
 * flashing, or media on every website can be detected or controlled.
 *
 * @typedef {Object} SensorySettings
 * @property {boolean} reduceMotion Whether to reduce supported animations and transitions.
 * @property {MotionBehavior} motionBehavior Preferred pause/static or decorative-content hiding behavior when reduceMotion is on. Meaningful text and essential controls remain available; adapters disclose unsupported content.
 * @property {boolean} reduceFlashing Whether to suppress supported flashing content.
 * @property {boolean} stopAutoplay Whether to stop supported autoplay media.
 * @property {boolean} muteAudio Whether to mute supported page media.
 */

/**
 * Network blocking is an ad-specific capability requiring separate browser
 * support and permissions. Other categories use reversible display actions.
 * Essential content protection is mandatory, not a user-disableable setting.
 *
 * @typedef {Object} ContentSettings
 * @property {ContentAction} ads Preferred action for supported advertisements.
 * @property {DisplayAction} popups Preferred action for nonessential pop-ups.
 * @property {DisplayAction} banners Preferred action for promotional banners.
 * @property {DisplayAction} recommendations Preferred action for recommended content.
 * @property {DisplayAction} sidebars Preferred action for nonessential sidebars.
 * @property {DisplayAction} clutter Preferred action for other supported distractions.
 */

/**
 * @typedef {Object} ReadingSettings
 * @property {boolean} readAloudEnabled Whether read-aloud assistance is enabled.
 * @property {string | null} voiceName Selected voice name, or null for a suitable local voice.
 * @property {number} speechRate Speech speed multiplier; 1 is normal speed.
 * @property {boolean} readingMode Whether to request a focused reading presentation.
 */

/**
 * Filters are optional visual aids, not universal corrections for color vision.
 * Labels/icons/patterns may be added only where the underlying meaning is known.
 *
 * @typedef {Object} ColorVisionSettings
 * @property {"none" | "protanopia" | "deuteranopia" | "tritanopia" | "grayscale"} filter Requested visual filter.
 * @property {boolean} addLabels Whether to supplement supported color-only information with text.
 * @property {boolean} addIcons Whether to add meaningful redundant icons where supported.
 * @property {boolean} addPatterns Whether to add redundant patterns where supported.
 */

/**
 * A complete, resolved set of individual preferences. A preset is a starting
 * point; no user is required to remain within one category.
 *
 * @typedef {Object} Settings
 * @property {VisualSettings} visual
 * @property {InteractionSettings} interaction
 * @property {SensorySettings} sensory
 * @property {ContentSettings} content
 * @property {ReadingSettings} reading
 * @property {ColorVisionSettings} colorVision
 */

/**
 * Only supplied properties override existing preferences. Omission means
 * inherit; false, 0, and null are explicit values, not missing properties.
 * Precedence: defaults < global settings < site overrides < temporary preview.
 * Preset overrides are merged when selected, rather than acting as a fixed layer.
 *
 * @typedef {Object} SettingsOverrides
 * @property {Partial<VisualSettings>} [visual]
 * @property {Partial<InteractionSettings>} [interaction]
 * @property {Partial<SensorySettings>} [sensory]
 * @property {Partial<ContentSettings>} [content]
 * @property {Partial<ReadingSettings>} [reading]
 * @property {Partial<ColorVisionSettings>} [colorVision]
 */

/**
 * @typedef {Object} Preset
 * @property {PresetId} id Stable preset identifier matching the panel choices.
 * @property {string} name User-facing name.
 * @property {string} description Explanation of the starting preferences.
 * @property {string} optionalAdvice Guidance for adjustments the user can choose.
 * @property {SettingsOverrides} settings Starting overrides to merge over defaults.
 */

/**
 * Saved personal preferences; no medical diagnosis or page contents are needed.
 *
 * @typedef {Object} UserProfile
 * @property {number} schemaVersion Must match a supported PROFILE_SCHEMA_VERSION.
 * @property {string} id Unique profile identifier.
 * @property {string} name User-selected profile name.
 * @property {PresetId | null} presetId Starting preset, or null for a custom profile.
 * @property {Settings} settings Complete global preferences.
 * @property {string} updatedAt ISO 8601 timestamp.
 */

/**
 * @typedef {Object} SiteProfile
 * @property {number} schemaVersion Must match a supported PROFILE_SCHEMA_VERSION.
 * @property {string} origin HTTP(S) origin only, without a path, query, or fragment.
 * @property {SettingsOverrides} overrides Preferences that differ for this site.
 * @property {boolean} autoApply User preference; actual application also requires granted site access.
 * @property {string} updatedAt ISO 8601 timestamp.
 */

/**
 * An opaque reference owned by a content-script session. It is not a DOM node
 * or a globally reusable selector. Resolve only within the matching pageSessionId.
 *
 * @typedef {Object} ElementTarget
 * @property {string} elementId Session-local element identifier.
 * @property {number} frameId Chrome frame identifier; 0 identifies the top frame.
 */

/** @typedef {"visual" | "sensory" | "cognitive" | "interaction" | "color-vision"} UserNeed */

/**
 * @typedef {Object} AccessibilityIssue
 * @property {string} id Unique finding identifier within a report.
 * @property {string} ruleId Stable scanner rule identifier.
 * @property {IssueSeverity} severity Reported impact, separate from detection certainty.
 * @property {"violation" | "manual-review"} status Whether the issue is established or needs review.
 * @property {string} message Plain-text explanation, without sensitive form values.
 * @property {Array<UserNeed>} affectedNeeds Relevant accessibility needs.
 * @property {Array<ElementTarget>} targets Affected elements in this report's session.
 */

/**
 * @typedef {Object} ScanCoverage
 * @property {Array<string>} checkedRules Rules actually evaluated.
 * @property {Array<string>} unsupportedAreas Areas not inspected, described without page contents.
 * @property {boolean} manualReviewRequired Whether human review remains necessary.
 */

/**
 * A scan describes one page session at one point in time. Before/after scores
 * are comparable only with a compatible scoring version and scan coverage.
 * Reports are temporary unless the user explicitly chooses a later export flow.
 *
 * @typedef {Object} ScanReport
 * @property {string} id Unique scan identifier.
 * @property {string} pageSessionId Identifies the document session; changes on navigation/reload.
 * @property {string} createdAt ISO 8601 timestamp.
 * @property {"before" | "after"} phase Whether adaptations were active for this scan.
 * @property {Array<AccessibilityIssue>} issues Findings, including manual-review items.
 * @property {number | null} score Documented project score from 0 to 100, or null when unassessed.
 * @property {string} scoringVersion Identifies the scoring method used.
 * @property {ScanCoverage} coverage Limits of this assessment; score is not WCAG certification.
 */

/**
 * A proposed change for user review; creating it does not apply anything.
 *
 * @typedef {Object} AdaptationRecommendation
 * @property {string} id Unique recommendation identifier.
 * @property {string} pageSessionId Document session for which it was proposed.
 * @property {Array<string>} issueIds Findings that justify the recommendation.
 * @property {string} reason Plain-text explanation of its benefit and relevant limits.
 * @property {SettingsOverrides} settings Suggested preference changes.
 * @property {Array<ElementTarget>} targets Relevant targets; empty for page-wide changes.
 * @property {boolean} requiresConfirmation Whether additional user confirmation is required.
 */

/**
 * Restore only AccessMate-owned changes. Do not overwrite unrelated site updates.
 * The implementation retains original values/references inside this callback.
 *
 * @callback UndoOperation
 * @returns {boolean | Promise<boolean>} True if restored; false if safely restoring is no longer possible.
 */

/**
 * Runtime-only history entry. Never serialize it, store it in chrome.storage,
 * or accept/send it through extension messaging: undo is executable code.
 * A change manager must stop offering this record after its document is gone.
 *
 * @typedef {Object} ChangeRecord
 * @property {string} id Unique change identifier.
 * @property {string} groupId Groups related changes for preview cancellation or grouped undo.
 * @property {string} pageSessionId Owning document session.
 * @property {string} description Plain-text explanation for the user.
 * @property {"applied" | "undone" | "skipped"} status Current restoration state.
 * @property {UndoOperation} undo Restoration callback owned by the change manager.
 */
