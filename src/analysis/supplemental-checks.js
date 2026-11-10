const CANDIDATE_LIMIT = 500;
const SUSTAINED_MOTION_MS = 5000;
const VISUAL_PROPERTIES = [
  "transform", "translate", "rotate", "scale", "offsetDistance",
  "top", "right", "bottom", "left", "backgroundPosition",
  "color", "backgroundColor", "opacity", "visibility", "filter",
];
const COLOUR = "(?:red|green|blue|yellow|orange|purple|pink|grey|gray|black|white)";
const COLOUR_STATE = /\b(?:required|mandatory|optional|invalid|valid|errors?|warnings?|selected|correct|incorrect|passed|failed)\b/i;
const COLOUR_INSTRUCTION = new RegExp(
  "\\b(?:(?:shown|marked|highlighted|indicated|displayed|labelled|labeled) in (?:the colou?r )?" + COLOUR +
  "|" + COLOUR + " (?:indicates?|means?|denotes?|shows?|marks?))\\b",
  "i",
);

/** Collect bounded, local review signals without changing or retaining page content. */
export function collectSupplementalFindings(page) {
  const view = page.defaultView;
  let limited = false;
  function bounded(candidates) {
    if (candidates.length > CANDIDATE_LIMIT) limited = true;
    return Array.prototype.slice.call(candidates, 0, CANDIDATE_LIMIT);
  }
  function rendered(element) {
    return element instanceof view.Element && element.getRootNode() === page &&
      element.getClientRects().length > 0 && view.getComputedStyle(element).visibility === "visible";
  }
  function sustainedMotion(animation) {
    const effect = animation.effect;
    if (animation.playState !== "running" || animation instanceof view.CSSTransition ||
      !(effect instanceof view.KeyframeEffect) || !rendered(effect.target)) return false;
    const speed = Math.abs(animation.playbackRate);
    const { activeDuration, progress } = effect.getComputedTiming();
    if (!speed || typeof activeDuration !== "number" || progress === null ||
      activeDuration / speed <= SUSTAINED_MOTION_MS) return false;
    const frames = effect.getKeyframes();
    return VISUAL_PROPERTIES.some((property) => {
      const first = frames[0]?.[property];
      return frames.length === 1 ? first !== undefined : frames.some((frame) => frame[property] !== first);
    });
  }

  const motion = bounded(page.getAnimations()).filter(sustainedMotion).map((animation) => animation.effect.target);
  const autoplay = bounded(page.querySelectorAll("video[autoplay], audio[autoplay]"))
    .filter((media) => !media.paused && !media.ended && media.readyState >= media.HAVE_CURRENT_DATA &&
      (rendered(media) || (!media.muted && media.volume > 0)));
  const colourInstructions = bounded(page.querySelectorAll("p, li, legend, small, [role='note']"))
    .filter((element) => {
      if (!rendered(element) || element.closest("[contenteditable]:not([contenteditable='false'])")) return false;
      const text = element.innerText?.slice(0, 1000) ?? "";
      return COLOUR_STATE.test(text) && COLOUR_INSTRUCTION.test(text);
    });

  const rules = [];
  function addRule(id, elements, help, description, userImpact) {
    if (!elements.length) return;
    rules.push({
      id, help, description, userImpact, impact: null,
      nodes: [...new Set(elements)].map((element) => ({ element })),
    });
  }
  addRule("accessmate-sustained-motion", motion, "Sustained animation needs review",
    "An active visual animation runs longer than five seconds or repeats indefinitely. Check whether it starts unexpectedly and offers a pause or stop control.",
    "people who are sensitive to motion or who find moving content distracting");
  addRule("accessmate-autoplay-media", autoplay, "Playing media with autoplay enabled",
    "Media with an autoplay attribute is currently playing. Check whether it starts on its own and whether users can stop it.",
    "people sensitive to unexpected sound or motion, and people listening to a screen reader");
  addRule("accessmate-colour-instructions", colourInstructions, "Instructions may rely on colour",
    "The wording uses a colour to indicate a state. Check for a visible text label, symbol, or other cue that communicates the same meaning.",
    "people with colour vision differences or low vision");
  return { rules, limited };
}
