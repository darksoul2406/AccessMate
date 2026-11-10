import { DISTRACTION_KEYS } from "../shared/messages.js";
import { HIGH_CONTRAST_PALETTE } from "../transformations/visual.js";

/** User-facing names for both editable fields and the full preference review. */
const GROUP_NAMES = {
  visual: "Visual", interaction: "Interaction", sensory: "Sensory comfort",
  content: "Ads and distractions", reading: "Reading", colorVision: "Color vision",
};
const LABELS = {
  textScale: "Text scale", lineHeight: "Line spacing", letterSpacing: "Letter spacing",
  highContrast: "Increase contrast", textColor: "Text color", backgroundColor: "Background color",
  zoom: "Page zoom", targetSize: "Minimum control size", cursorSize: "Cursor size",
  highlightFocus: "Highlight keyboard focus", keyboardNavigation: "Keyboard assistance",
  reduceMotion: "Reduce motion", motionBehavior: "Motion behavior", reduceFlashing: "Reduce flashing", stopAutoplay: "Stop autoplay",
  muteAudio: "Mute media audio", ads: "Advertisements", popups: "Nonessential pop-ups",
  banners: "Promotional banners", recommendations: "Recommendations", sidebars: "Optional sidebars",
  clutter: "Extra widgets", readAloudEnabled: "Read-aloud availability", voiceName: "Voice",
  speechRate: "Speech speed", readingMode: "Reading mode", filter: "Color filter",
  addLabels: "Add color-safe labels", addIcons: "Add color-safe icons", addPatterns: "Add color-safe patterns",
};
const ACTIONS = { allow: "Allow", minimize: "Minimize", hide: "Hide", block: "Block supported requests" };
const COLOR_FILTER_LABELS = Object.freeze({
  none: "Original colours",
  protanopia: "Red–green adjustment (protan)",
  deuteranopia: "Red–green adjustment (deutan)",
  tritanopia: "Blue–yellow adjustment (tritan)",
  grayscale: "Grayscale",
});

/** Shared native disclosure: concise controls, with optional guidance on demand. */
export function createHelpDetails(title, paragraphs = [], page = document) {
  const details = page.createElement("details");
  details.className = "feature-help";
  const summary = page.createElement("summary");
  summary.textContent = "More info — " + title;
  details.append(summary);
  for (const text of paragraphs) {
    const paragraph = page.createElement("p");
    paragraph.textContent = text;
    details.append(paragraph);
  }
  return details;
}

function compactHelp(note, shortText, title, extra = []) {
  const details = createHelpDetails(title, [note.textContent, ...extra]);
  note.textContent = shortText;
  note.classList.add("feature-note");
  note.after(details);
  return details;
}

const COLOR_SCHEMES = Object.freeze([
  Object.freeze({ id: "red-green", name: "Red–green colour blindness", textColor: "#003366", backgroundColor: "#ffffff" }),
  Object.freeze({ id: "blue-yellow", name: "Blue–yellow colour blindness", textColor: "#660000", backgroundColor: "#ffffff" }),
  Object.freeze({ id: "black-white", name: "Complete colour blindness (black & white)", textColor: "#000000", backgroundColor: "#ffffff" }),
]);

/** WCAG relative-luminance ratio for a pair of opaque six-digit sRGB colours. */
export function calculateColorContrast(textColor, backgroundColor) {
  if (![textColor, backgroundColor].every((color) => typeof color === "string" && /^#[0-9a-f]{6}$/i.test(color))) return null;
  const luminance = (color) => {
    const channels = [1, 3, 5].map((index) => {
      const value = parseInt(color.slice(index, index + 2), 16) / 255;
      return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
    });
    return channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722;
  };
  const a = luminance(textColor), b = luminance(backgroundColor);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

/** Pair controls use existing visual preferences; no separate colour profile. */
function createColorControls(onEdit) {
  const group = document.createElement("div");
  group.id = "color-controls";
  group.setAttribute("role", "group");
  group.setAttribute("aria-labelledby", "color-controls-heading");
  const legend = document.createElement("h3");
  legend.id = "color-controls-heading";
  legend.textContent = "Text and background colours";
  const label = document.createElement("label");
  label.htmlFor = "color-scheme";
  label.textContent = "Colour scheme";
  label.style.display = "block";
  const scheme = document.createElement("select");
  scheme.id = "color-scheme";
  scheme.setAttribute("aria-describedby", "color-controls-note");
  scheme.add(new Option("Keep website colours", "website"));
  scheme.add(new Option("Increase contrast — fixed palette", "high-contrast"));
  for (const preset of COLOR_SCHEMES) scheme.add(new Option(preset.name, preset.id));
  scheme.add(new Option("Custom colours", "custom"));
  const note = document.createElement("p");
  note.id = "color-controls-note";
  note.textContent = "These three schemes are adjustable starting points, not colour-vision correction filters. The black-and-white scheme changes supported text and backgrounds only; images and videos keep their colours. Selecting a scheme or editing a colour turns off the fixed Increase contrast palette. Turning Increase contrast back on keeps your custom colours for later. Some image/gradient backgrounds keep their original appearance. Links are underlined when colours are applied.";
  const pickers = document.createElement("div");
  pickers.id = "custom-color-controls";
  pickers.setAttribute("role", "group");
  pickers.setAttribute("aria-labelledby", "color-pair-heading");
  const pickerLegend = document.createElement("h4");
  pickerLegend.id = "color-pair-heading";
  pickerLegend.textContent = "Adjust the colour pair";
  pickers.append(pickerLegend);
  const controls = {};
  for (const [key, id, title] of [["textColor", "text-color", "Text colour"], ["backgroundColor", "background-color", "Background colour"]]) {
    const pickerLabel = document.createElement("label");
    pickerLabel.htmlFor = id;
    pickerLabel.textContent = title;
    pickerLabel.style.display = "block";
    const input = document.createElement("input");
    input.id = id;
    input.type = "color";
    input.style.inlineSize = "100%";
    input.style.minBlockSize = "2.75rem";
    input.setAttribute("aria-describedby", id + "-value color-pair-note");
    const value = document.createElement("p");
    value.id = id + "-value";
    controls[key] = { input, value };
    input.addEventListener("change", () => onEdit({ visual: {
      highContrast: false, textColor: controls.textColor.input.value, backgroundColor: controls.backgroundColor.input.value,
    } }));
    pickers.append(pickerLabel, input, value);
  }
  const pairNote = document.createElement("p");
  pairNote.id = "color-pair-note";
  pairNote.textContent = "Editing a colour applies both displayed colours.";
  pickers.append(pairNote);
  const contrast = document.createElement("p");
  contrast.id = "color-contrast-status";
  contrast.setAttribute("role", "status");
  contrast.setAttribute("aria-atomic", "true");
  const coverage = document.createElement("p");
  coverage.textContent = "This indicator checks only the selected opaque colour pair, not the whole webpage. Use Scan current page to check actual page contrast. Colour changes do not interpret colour-only charts or status indicators.";
  group.append(legend, label, scheme, note, pickers, contrast);
  compactHelp(note, "Changes supported text and backgrounds.", "Colour schemes", [coverage.textContent]);
  scheme.addEventListener("change", () => {
    if (scheme.value === "high-contrast") onEdit({ visual: { highContrast: true } });
    else if (scheme.value === "website") onEdit({ visual: { highContrast: false, textColor: null, backgroundColor: null } });
    else {
      const preset = COLOR_SCHEMES.find((entry) => entry.id === scheme.value);
      onEdit({ visual: {
        highContrast: false,
        textColor: preset?.textColor ?? controls.textColor.input.value,
        backgroundColor: preset?.backgroundColor ?? controls.backgroundColor.input.value,
      } });
    }
  });
  return Object.freeze({
    element: group,
    render(visual) {
      const { highContrast, textColor, backgroundColor } = visual;
      const match = COLOR_SCHEMES.find((preset) => preset.textColor === textColor?.toLowerCase() && preset.backgroundColor === backgroundColor?.toLowerCase());
      scheme.value = highContrast ? "high-contrast" : textColor === null && backgroundColor === null ? "website" : match?.id ?? "custom";
      pickers.hidden = highContrast || (textColor === null && backgroundColor === null);
      for (const [key, entry] of Object.entries(controls)) {
        const value = visual[key];
        entry.input.value = value ?? HIGH_CONTRAST_PALETTE[key];
        entry.input.disabled = pickers.hidden;
        entry.value.textContent = value === null ? `Website colour; picker starts at ${entry.input.value}.` : value;
      }
      const pair = highContrast ? HIGH_CONTRAST_PALETTE : visual;
      const ratio = calculateColorContrast(pair.textColor, pair.backgroundColor);
      // Truncate the display and use the raw ratio for classification, so a
      // value just below 4.5 cannot be presented as meeting that benchmark.
      const text = ratio === null
        ? "Pair contrast: website colours in use."
        : `Selected pair: ${(Math.floor(ratio * 100) / 100).toFixed(2)}:1 — ${ratio >= 4.5 ? "meets" : "below"} 4.5:1.${ratio < 4.5 ? " Choose a stronger contrast." : ""}`;
      if (contrast.textContent !== text) contrast.textContent = text;
    },
  });
}

function formatValue(key, value) {
  if (key === "filter") return COLOR_FILTER_LABELS[value];
  if (value === null) return key === "voiceName" ? "Suitable local voice" : "Keep original";
  if (typeof value === "boolean") return value ? "On" : "Off";
  if (key === "motionBehavior") return value === "pause" ? "Pause (keep visible)" : "Hide decorative animations";
  if (["textScale", "zoom"].includes(key)) return `${value}%`;
  if (key === "targetSize") return `${value} pixels`;
  if (key === "letterSpacing") return `${value} em`;
  if (["lineHeight", "speechRate"].includes(key)) return `${value}×`;
  if (["ads", "popups", "banners", "recommendations", "sidebars", "clutter"].includes(key)) {
    return ACTIONS[value];
  }
  if (value === "none") return "None";
  if (value === "original") return "Original";
  if (value === "extra-large") return "Extra large";
  return String(value);
}

/** Describe preset changes without hiding settings that have no editable control yet. */
export function describePresetChanges(current, overrides) {
  const changes = [];
  for (const [group, fields] of Object.entries(overrides)) {
    for (const [key, value] of Object.entries(fields)) {
      if (current[group][key] !== value) {
        changes.push(`${LABELS[key]}: ${formatValue(key, current[group][key])} → ${formatValue(key, value)}`);
      }
    }
  }
  return changes;
}

/** Bind only the preferences implemented in this milestone. No page mutations. */
export function createSettingsView({ onEdit, onSave, onDiscard }) {
  const fieldset = document.getElementById("customization-controls");
  const save = document.getElementById("save-settings");
  const discard = document.getElementById("cancel-preview");
  const summary = document.getElementById("preferences-summary");
  const distractionControls = document.getElementById("distraction-controls");
  const adBehavior = document.getElementById("ad-behavior");
  adBehavior.replaceChildren(new Option("Allow", "allow"), new Option("Hide", "hide"));
  const popupRow = document.createElement("div");
  popupRow.className = "setting-row";
  const popupControl = document.createElement("input");
  popupControl.type = "checkbox";
  popupControl.id = "hide-popups";
  popupControl.setAttribute("aria-describedby", "popup-preferences-note");
  const popupLabel = document.createElement("label");
  popupLabel.htmlFor = popupControl.id;
  popupLabel.textContent = "Hide notification and promotional pop-ups";
  popupRow.append(popupControl, popupLabel);
  const popupNote = document.createElement("p");
  popupNote.id = "popup-preferences-note";
  popupNote.textContent = "Hides recognised website prompts such as supported MoEngage, OneSignal, Webpushr, and iZooto prompts, including prompts added after loading. Notification permissions stay unchanged. Login, payment, consent, native/modal dialogs, focused prompts, and prompts that lock the page stay available. Chrome permission bubbles, new browser windows, embedded frames, shadow content, and unrecognised prompts are not controlled. Undo or Restore brings hidden prompts back.";
  distractionControls.append(popupRow, popupNote);
  popupControl.addEventListener("change", () => onEdit({ content: { popups: popupControl.checked ? "hide" : "allow" } }));
  const secondaryNote = document.createElement("p");
  secondaryNote.id = "secondary-distractions-note";
  secondaryNote.className = "feature-note";
  secondaryNote.textContent = "Hides recognized related panels and decorative or sharing widgets. Navigation, forms, and dialogs stay available.";
  const secondaryControls = new Map();
  for (const [key, name] of [["sidebars", "Hide optional sidebars"], ["clutter", "Hide extra widgets"]]) {
    const row = document.createElement("div");
    row.className = "setting-row";
    const control = document.createElement("input");
    control.type = "checkbox";
    control.id = "hide-" + key;
    control.setAttribute("aria-describedby", secondaryNote.id);
    const label = document.createElement("label");
    label.htmlFor = control.id;
    label.textContent = name;
    row.append(control, label);
    distractionControls.append(row);
    secondaryControls.set(key, control);
    control.addEventListener("change", () => onEdit({ content: { [key]: control.checked ? "hide" : "allow" } }));
  }
  distractionControls.append(secondaryNote);
  const distractionNote = document.createElement("p");
  distractionNote.id = "distraction-preferences-note";
  distractionNote.textContent = "Hiding previews immediately on this page. To block advertising downloads across websites, choose Personal preferences — all websites, set Advertisements to Hide, save, then reload the website. Personal Allow turns network blocking off. Website Allow creates a network exception for that hostname and its subdomains across HTTP/HTTPS and ports. Website Hide removes its exception; global blocking must be on first. Network changes apply only after saving. Discard, Undo, and Restore affect page previews; to undo saved blocking, save Allow and reload. Banners and recommendations use page hiding. Some ads, including video ads, may remain.";
  const legacyNote = document.createElement("p");
  legacyNote.hidden = true;
  legacyNote.textContent = "A saved or suggested Minimize/Block value is not applied in this version. Choose Allow or Hide to replace it, then save.";
  distractionControls.append(distractionNote, legacyNote);
  const distractionButtons = document.createElement("div");
  distractionButtons.className = "button-group";
  const distractionSave = document.createElement("button");
  distractionSave.id = "save-distractions";
  distractionSave.type = "button";
  distractionSave.textContent = "Save preferences";
  distractionSave.addEventListener("click", () => { void onSave(); });
  const distractionDiscard = document.createElement("button");
  distractionDiscard.id = "discard-distractions";
  distractionDiscard.type = "button";
  distractionDiscard.textContent = "Discard edits and preview";
  distractionDiscard.addEventListener("click", onDiscard);
  distractionButtons.append(distractionSave, distractionDiscard);
  distractionControls.append(distractionButtons);
  const networkStatus = document.createElement("p");
  networkStatus.id = "network-blocking-status";
  networkStatus.setAttribute("role", "status");
  networkStatus.setAttribute("aria-atomic", "true");
  networkStatus.textContent = "Checking network blocking…";
  const networkRetry = document.createElement("button");
  networkRetry.type = "button";
  networkRetry.id = "retry-network-settings";
  networkRetry.textContent = "Retry network settings";
  // Keep recovery available even when profile loading disables the fieldset.
  distractionControls.after(networkStatus, networkRetry);
  adBehavior.setAttribute("aria-describedby", distractionNote.id);
  adBehavior.addEventListener("change", () => onEdit({ content: { ads: adBehavior.value } }));
  for (const [id, key] of [["hide-promotions", "banners"], ["hide-recommendations", "recommendations"]]) {
    const control = document.getElementById(id);
    control.setAttribute("aria-describedby", distractionNote.id);
    control.addEventListener("change", () => onEdit({ content: { [key]: control.checked ? "hide" : "allow" } }));
  }
  const colorControls = createColorControls(onEdit);
  document.getElementById("high-contrast").closest(".setting-row").after(colorControls.element);
  const filterLabel = document.createElement("label");
  filterLabel.htmlFor = "color-filter";
  filterLabel.textContent = "Colour filter";
  const filterSelect = document.createElement("select");
  filterSelect.id = "color-filter";
  filterSelect.setAttribute("aria-describedby", "color-filter-note");
  for (const [value, name] of Object.entries(COLOR_FILTER_LABELS)) filterSelect.add(new Option(name, value));
  const filterNote = document.createElement("p");
  filterNote.id = "color-filter-note";
  filterNote.className = "feature-note";
  filterNote.textContent = "Adjusts page content and images.";
  const filterHelp = createHelpDetails("Colour filters", [
    "Compare filters on charts or images and choose the colours that are easiest to distinguish. Text, icons and patterns can also help explain colour-coded information.",
    "System forced colours take priority. Review filtered contrast visually when comparing scan results.",
  ]);
  colorControls.element.after(filterLabel, filterSelect, filterNote, filterHelp);
  const cueGroup = document.createElement("div");
  cueGroup.setAttribute("role", "group");
  cueGroup.setAttribute("aria-labelledby", "color-cues-heading");
  const cueHeading = document.createElement("h3");
  cueHeading.id = "color-cues-heading";
  cueHeading.textContent = "Colour-safe state cues";
  const cueNote = document.createElement("p");
  cueNote.id = "color-cues-note";
  cueNote.textContent = "Add visible cues to supported required, invalid, checked/mixed, and selected states declared by the website. Charts, image colours, undeclared meanings, and controls without a safe tag position need manual review.";
  cueGroup.append(cueHeading, cueNote);
  for (const [id, title] of [["color-safe-labels", "Add colour-safe labels"], ["color-safe-icons", "Add colour-safe icons"], ["color-safe-patterns", "Add colour-safe patterns"]]) {
    const row = document.createElement("div");
    row.className = "setting-row";
    const input = document.createElement("input");
    input.type = "checkbox";
    input.id = id;
    input.setAttribute("aria-describedby", cueNote.id);
    const label = document.createElement("label");
    label.htmlFor = id;
    label.textContent = title;
    row.append(input, label);
    cueGroup.append(row);
  }
  const legend = document.createElement("details");
  const legendTitle = document.createElement("summary");
  legendTitle.textContent = "More info — Colour-safe cues";
  legend.className = "feature-help";
  const legendText = document.createElement("p");
  legendText.textContent = "Required: * and dotted border. Invalid: ! and dashed border. Checked: ✓ and solid border. Selected: ◆ and double border. Mixed: − and grooved border. If several states apply, the border follows Invalid, then Required, Mixed, Selected, Checked. Labels and icons can show all supported states. Visual tags supplement the website's existing states; their appearance can take a moment to update.";
  legend.append(legendTitle, legendText);
  const cueCoverage = document.createElement("p"); cueCoverage.textContent = cueNote.textContent;
  legend.append(cueCoverage);
  cueNote.textContent = "Adds visible cues to supported states.";
  cueNote.className = "feature-note";
  const cueStatus = document.createElement("p");
  cueStatus.id = "color-cues-status";
  cueStatus.setAttribute("role", "status");
  cueStatus.setAttribute("aria-atomic", "true");
  cueStatus.textContent = "Connect a website to apply colour-safe cues.";
  cueGroup.append(legend, cueStatus);
  filterHelp.after(cueGroup);
  const motionLabel = document.createElement("label");
  motionLabel.htmlFor = "motion-behavior";
  motionLabel.textContent = "When Reduce motion is on";
  const motionBehavior = document.createElement("select");
  motionBehavior.id = "motion-behavior";
  motionBehavior.name = "motionBehavior";
  motionBehavior.add(new Option("Pause", "pause"));
  motionBehavior.add(new Option("Hide", "hide"));
  motionBehavior.setAttribute("aria-describedby", "motion-behavior-note");
  const motionNote = document.createElement("p");
  motionNote.id = "motion-behavior-note";
  motionNote.textContent = "Pause shows static previews for supported GIF candidates and pauses supported JavaScript animations. Hide conceals clearly decorative animated content; meaningful text and essential controls stay visible. CSS text motion is reduced in both modes. Some images cannot be paused because of image security, page policy, or format restrictions.";
  const motionStatus = document.createElement("p");
  motionStatus.id = "motion-runtime-status";
  motionStatus.setAttribute("role", "status");
  motionStatus.setAttribute("aria-atomic", "true");
  motionStatus.textContent = "Connect a website to apply motion preferences.";
  for (const element of [motionLabel, motionBehavior, motionNote]) element.hidden = true;
  document.getElementById("reduce-motion-note").textContent = "Reduces supported CSS animations, transitions, smooth scrolling, and fixed background movement. The same control also manages supported GIFs and JavaScript animations. Newly added content is checked periodically, so motion may appear briefly. Video and audio have separate media controls.";
  document.getElementById("reduce-motion-note").after(motionLabel, motionBehavior, motionNote, motionStatus);
  const flashingRow = document.createElement("div");
  flashingRow.className = "setting-row";
  const flashingControl = document.createElement("input");
  flashingControl.id = "reduce-flashing";
  flashingControl.type = "checkbox";
  flashingControl.setAttribute("aria-describedby", "reduce-flashing-note");
  const flashingLabel = document.createElement("label");
  flashingLabel.htmlFor = flashingControl.id;
  flashingLabel.textContent = "Reduce flashing";
  flashingRow.append(flashingControl, flashingLabel);
  const flashingNote = document.createElement("p");
  flashingNote.id = "reduce-flashing-note";
  flashingNote.className = "feature-note";
  flashingNote.textContent = "Pauses supported repeating blinks and colour pulses.";
  const flashingHelp = createHelpDetails("Flashing", [
    "This switch targets repeating opacity and colour changes in supported page animations. Reduce motion applies broader controls when both switches are enabled.",
    "New effects can appear before AccessMate pauses them. Flashing in videos, images, or canvas needs separate review.",
  ]);
  motionStatus.after(flashingRow, flashingNote, flashingHelp);
  // These controls join the existing fieldset, so its disabled/loading state,
  // saving, preset updates, and discard behavior apply to them automatically.
  const mediaNote = document.createElement("p");
  mediaNote.id = "media-preferences-note";
  mediaNote.textContent = "Stop autoplay pauses existing and newly started main-page video/audio, including attempts to play manually. Choose Allow playback in the media list below, then use the website's Play control. Muting is independent. Turning restrictions off or restoring never starts playback. Embedded players, shadow content, Web Audio, and GIFs are not controlled. A brief start may occur before media is paused.";
  const mediaControls = document.createDocumentFragment();
  for (const [id, label] of [["stop-autoplay", "Stop autoplay"], ["mute-audio", "Mute media audio"]]) {
    const row = document.createElement("div");
    row.className = "setting-row";
    const input = document.createElement("input");
    input.type = "checkbox";
    input.id = id;
    input.setAttribute("aria-describedby", mediaNote.id);
    const text = document.createElement("label");
    text.htmlFor = id;
    text.textContent = label;
    row.append(input, text);
    mediaControls.append(row);
  }
  mediaControls.append(mediaNote);
  fieldset.querySelector(".button-group").before(mediaControls);
  const spacingNote = document.createElement("p");
  spacingNote.id = "spacing-preferences-note";
  spacingNote.textContent = "Original keeps the website's spacing. Line spacing is relative to text size; letter spacing is measured in em. Changes preview on supported page text. Compact controls, editable fields, code, and text blocks containing them keep their spacing. Embedded frames and shadow content are excluded. Spacing may change wrapping; check fixed-size website layouts. Save to keep preferences, or use Discard, Undo, or Restore.";
  const spacingControls = document.createDocumentFragment();
  for (const [id, title, choices] of [
    ["line-spacing", "Line spacing", [["Original", "original"], ["1.5×", "1.5"], ["1.75×", "1.75"], ["2×", "2"]]],
    ["letter-spacing", "Letter spacing", [["Original", "original"], ["0.05 em", "0.05"], ["0.1 em", "0.1"], ["0.15 em", "0.15"]]],
  ]) {
    const label = document.createElement("label"); label.htmlFor = id; label.textContent = title; label.style.display = "block";
    const select = document.createElement("select"); select.id = id; select.setAttribute("aria-describedby", spacingNote.id);
    for (const [name, value] of choices) select.add(new Option(name, value));
    spacingControls.append(label, select);
  }
  spacingControls.append(spacingNote);
  document.getElementById("text-scale").after(spacingControls);
  const zoomLabel = document.createElement("label");
  zoomLabel.htmlFor = "page-zoom"; zoomLabel.textContent = "Page zoom"; zoomLabel.style.display = "block";
  const zoomControl = document.createElement("select");
  zoomControl.id = "page-zoom"; zoomControl.setAttribute("aria-describedby", "page-zoom-note");
  zoomControl.add(new Option("Original — keep existing Chrome zoom", "original"));
  for (const percent of [100, 125, 150, 175, 200]) zoomControl.add(new Option(`${percent}%`, String(percent)));
  const zoomNote = document.createElement("p");
  zoomNote.id = "page-zoom-note";
  zoomNote.textContent = "Page zoom previews on the current tab, enlarging text, images, and controls together. Original restores the Chrome zoom from before AccessMate; 100% explicitly requests normal size. Text scale combines with page zoom. Later manual Chrome zoom changes are preserved until you explicitly choose a zoom here. Save keeps the preference; Discard, Undo, and Restore also update the preview. Chrome resets per-tab zoom on navigation; saved preferences reapply when AccessMate connects.";
  const zoomStatus = document.createElement("p");
  zoomStatus.id = "page-zoom-status"; zoomStatus.setAttribute("role", "status"); zoomStatus.setAttribute("aria-atomic", "true");
  zoomStatus.textContent = "Connect a website to preview page zoom.";
  const zoomRetry = document.createElement("button");
  zoomRetry.id = "retry-page-zoom"; zoomRetry.type = "button"; zoomRetry.textContent = "Retry page zoom"; zoomRetry.hidden = true;
  spacingNote.after(zoomLabel, zoomControl, zoomNote, zoomStatus, zoomRetry);
  const interactionNote = document.createElement("p"); interactionNote.id = "interaction-preferences-note";
  interactionNote.textContent = "Minimum size enlarges supported buttons, standard fields, and already-boxed links without shrinking larger authored minimums. Inline text links, checkboxes/radio buttons, range/colour/file controls, disabled controls, frames, and shadow content keep their dimensions. Check fixed website layouts for overlap. Large and Extra large use 32px and 48px arrow/hand cursors; text-entry, resize, busy, and custom website cursors are preserved where supported. Cursor images may fall back to native cursors if blocked by the website. Size previews cover up to 2,000 candidates; cursors cover up to 3,000 page elements. Save, Discard, Undo, and Restore apply.";
  const interactionControls = document.createDocumentFragment();
  for (const [id, title, choices] of [
    ["target-size", "Minimum control size", [["Original", "original"], ["32 px", "32"], ["44 px", "44"], ["56 px", "56"]]],
    ["cursor-size", "Cursor size", [["Original", "original"], ["Large", "large"], ["Extra large", "extra-large"]]],
  ]) {
    const label = document.createElement("label"); label.htmlFor = id; label.textContent = title; label.style.display = "block";
    const select = document.createElement("select"); select.id = id; select.setAttribute("aria-describedby", interactionNote.id);
    for (const [name, value] of choices) select.add(new Option(name, value));
    interactionControls.append(label, select);
  }
  interactionControls.append(interactionNote);
  document.getElementById("highlight-focus").closest(".setting-row").after(interactionControls);
  compactHelp(popupNote, "Hides supported prompts; essential dialogs stay visible.", "Pop-ups");
  compactHelp(distractionNote, "Global ad blocking: Personal → Hide → Save, then reload.", "Ads and distractions");
  compactHelp(document.getElementById("reduce-motion-note"), "Reduces animations, GIFs and fixed background motion.", "Motion", [motionNote.textContent]);
  motionNote.textContent = "Pause keeps content visible; Hide conceals decorative motion.";
  motionNote.className = "feature-note";
  compactHelp(mediaNote, "Allow individual media below to enable playback.", "Video and audio");
  compactHelp(spacingNote, "Original keeps the website's spacing.", "Text spacing");
  const zoomHelp = compactHelp(zoomNote, "Enlarges the whole page; combines with text scale.", "Page zoom");
  zoomRetry.after(zoomHelp);
  compactHelp(interactionNote, "Enlarges supported controls and the pointer.", "Controls and cursor");
  const fields = [
    ["text-scale", "visual", "textScale"],
    ["page-zoom", "visual", "zoom"],
    ["line-spacing", "visual", "lineHeight"],
    ["letter-spacing", "visual", "letterSpacing"],
    ["high-contrast", "visual", "highContrast"],
    ["reduce-motion", "sensory", "reduceMotion"],
    ["reduce-flashing", "sensory", "reduceFlashing"],
    ["motion-behavior", "sensory", "motionBehavior"],
    ["highlight-focus", "interaction", "highlightFocus"],
    ["target-size", "interaction", "targetSize"],
    ["cursor-size", "interaction", "cursorSize"],
    ["stop-autoplay", "sensory", "stopAutoplay"],
    ["mute-audio", "sensory", "muteAudio"],
    ["color-safe-labels", "colorVision", "addLabels"],
    ["color-filter", "colorVision", "filter"],
    ["color-safe-icons", "colorVision", "addIcons"],
    ["color-safe-patterns", "colorVision", "addPatterns"],
  ];
  for (const [id, group, key] of fields) {
    const control = document.getElementById(id);
    control.addEventListener("change", () => {
      const value = control.type === "checkbox" ? control.checked : ["lineHeight", "letterSpacing", "targetSize", "zoom"].includes(key)
        ? control.value === "original" ? null : Number(control.value)
        : key === "textScale" ? Number(control.value) : control.value;
      onEdit({ [group]: { [key]: value } });
    });
  }
  save.addEventListener("click", () => { void onSave(); });
  discard.addEventListener("click", onDiscard);

  return {
    setEnabled(enabled) { fieldset.disabled = !enabled; distractionControls.disabled = !enabled; },
    render(settings, { enabled, dirty, busy }) {
      fieldset.disabled = !enabled || busy;
      distractionControls.disabled = !enabled || busy;
      distractionSave.disabled = !dirty || busy;
      distractionDiscard.disabled = !dirty || busy;
      adBehavior.value = settings.content.ads === "hide" ? "hide" : "allow";
      document.getElementById("hide-promotions").checked = settings.content.banners === "hide";
      document.getElementById("hide-recommendations").checked = settings.content.recommendations === "hide";
      popupControl.checked = settings.content.popups === "hide";
      for (const [key, control] of secondaryControls) control.checked = settings.content[key] === "hide";
      legacyNote.hidden = DISTRACTION_KEYS.every((key) => ["allow", "hide"].includes(settings.content[key]));
      save.disabled = !dirty || busy;
      discard.disabled = !dirty || busy;
      colorControls.render(settings.visual);
      for (const element of [motionLabel, motionBehavior, motionNote]) element.hidden = !settings.sensory.reduceMotion;
      motionBehavior.disabled = !settings.sensory.reduceMotion;
      for (const [id, group, key] of fields) {
        const control = document.getElementById(id);
        const value = settings[group][key];
        if (control.type === "checkbox") control.checked = value;
        else {
          // Preserve valid saved scales that are absent from the initial menu.
          if (key === "textScale" && ![...control.options].some((option) => option.value === String(value))) {
            control.add(new Option(`${value}%`, String(value)));
          }
          if (["lineHeight", "letterSpacing", "targetSize", "zoom"].includes(key)) {
            if (value !== null && ![...control.options].some((option) => option.value === String(value))) {
              control.add(new Option(key === "lineHeight" ? `${value}×` : key === "targetSize" ? `${value} px` : key === "zoom" ? `${value}%` : `${value} em`, String(value)));
            }
            control.value = value === null ? "original" : String(value);
          } else control.value = String(value);
        }
      }
      const fragment = document.createDocumentFragment();
      for (const [group, values] of Object.entries(settings)) {
        const heading = document.createElement("h3");
        heading.textContent = GROUP_NAMES[group];
        const list = document.createElement("dl");
        for (const [key, value] of Object.entries(values)) {
          const term = document.createElement("dt");
          const detail = document.createElement("dd");
          term.textContent = LABELS[key];
          detail.textContent = formatValue(key, value);
          list.append(term, detail);
        }
        fragment.append(heading, list);
      }
      summary.replaceChildren(fragment);
    },
  };
}

/** Session-only playback exceptions are separate from saved preferences. */
export function createMediaView({ onAction, onRefresh }) {
  const container = document.createElement("div");
  const heading = document.createElement("h3");
  heading.textContent = "Videos and audio on this page";
  const status = document.createElement("p");
  status.id = "media-status";
  status.setAttribute("role", "status");
  status.setAttribute("aria-atomic", "true");
  const refresh = document.createElement("button");
  refresh.type = "button";
  refresh.id = "refresh-media";
  refresh.textContent = "Refresh media list";
  refresh.addEventListener("click", onRefresh);
  const list = document.createElement("ul");
  list.id = "media-list";
  container.append(heading, status, refresh, list);
  document.getElementById("customization").append(container);
  let available = false;
  let busy = false;
  let restricting = false;
  let signature = "";
  const update = () => {
    refresh.disabled = !available || busy;
    list.setAttribute("aria-busy", String(busy));
    for (const button of list.querySelectorAll("button")) button.disabled = !available || busy || !restricting;
  };
  const view = Object.freeze({
    reset(message = "Connect a website to list its media.") {
      available = false;
      busy = false;
      signature = "";
      status.textContent = message;
      list.replaceChildren();
      update();
    },
    setBusy(value) { busy = value; update(); },
    show(media) {
      available = true;
      busy = false;
      restricting = media.stopAutoplay;
      status.textContent = `${media.items.length} media · autoplay ${media.stopAutoplay ? "blocked" : "allowed"} · audio ${media.muteAudio ? "muted" : "unmuted"}.${media.limited ? " First 100 items only." : ""}`;
      // Reuse the controls when possible, retaining keyboard focus on updates.
      const nextSignature = media.items.map((item) => item.id).join(",");
      if (signature !== nextSignature) {
        signature = nextSignature;
        list.replaceChildren(...media.items.map((item) => {
          const row = document.createElement("li");
          const text = document.createElement("p");
          const button = document.createElement("button");
          button.type = "button";
          button.dataset.mediaId = item.id;
          button.addEventListener("click", () => onAction(item.id, button.dataset.allowed !== "true"));
          row.append(text, button);
          return row;
        }));
      }
      media.items.forEach((item, index) => {
        const row = list.children[index];
        row.firstElementChild.textContent = `${item.label}: ${item.paused ? "paused" : "playing"}; ${item.muted ? "muted" : "unmuted"}. Playback ${!media.stopAutoplay || item.allowed ? "allowed" : "restricted"}.`;
        const button = row.lastElementChild;
        button.dataset.allowed = String(item.allowed);
        button.textContent = `${item.allowed ? "Restrict" : "Allow"} playback — ${item.label}`;
      });
      update();
    },
  });
  view.reset();
  return view;
}
