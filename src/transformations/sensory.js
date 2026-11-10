const FLASH_PROPERTIES = ["opacity", "visibility", "color", "backgroundColor", "borderColor",
  "borderTopColor", "borderRightColor", "borderBottomColor", "borderLeftColor", "fill", "stroke", "filter"];
const FLASH_ANIMATION_LIMIT = 100;

/** Project saved sensory modes through one reversible page history. */
export function createSensoryAdapter(changes, page = document) {
  const view = page.defaultView;
  const root = page.documentElement;
  const token = Array.from(view.crypto.getRandomValues(new Uint32Array(4)),
    (value) => value.toString(16)).join("");
  const motionMarker = "--accessmate-motion-" + token;
  const flashingMarker = "--accessmate-flashing-" + token;
  const paused = new Map();
  let sheet = null;
  let timer = null;
  const enabled = (marker) => root.style.getPropertyValue(marker) === "enabled";

  function projectMotion(reduceMotion) {
    if (reduceMotion && !sheet) {
      sheet = new view.CSSStyleSheet();
      // Short durations let completion events fire. Scrolling attachment
      // reduces the parallax effect of backgrounds fixed to the viewport.
      sheet.replaceSync(`
        *, *::before, *::after {
          animation-duration: 0.01ms !important;
          animation-delay: 0s !important;
          animation-iteration-count: 1 !important;
          transition-duration: 0.01ms !important;
          transition-delay: 0s !important;
          scroll-behavior: auto !important;
          background-attachment: scroll !important;
        }
      `);
    }
    const existing = page.adoptedStyleSheets;
    if (reduceMotion && !existing.includes(sheet)) page.adoptedStyleSheets = [...existing, sheet];
    if (!reduceMotion && sheet && existing.includes(sheet)) {
      page.adoptedStyleSheets = existing.filter((entry) => entry !== sheet);
    }
  }

  function signature(animation) {
    const effect = animation.effect;
    return JSON.stringify([effect.getKeyframes(), effect.getTiming(), animation.playbackRate]);
  }

  function ownsPause(animation, record) {
    return animation.effect === record.effect && animation.effect.target === record.target &&
      animation.playState === "paused" && animation.currentTime === record.holdTime &&
      signature(animation) === record.signature;
  }

  function releaseFlashes() {
    if (timer !== null) view.clearTimeout(timer);
    timer = null;
    for (const [animation, record] of paused) {
      if (!ownsPause(animation, record)) continue;
      animation.currentTime = record.resumeTime;
      animation.play();
    }
    paused.clear();
  }

  function holdVisibleFrame(animation, effect, frames, initialTime, duration, delay) {
    const visibleOpacity = () => {
      const style = view.getComputedStyle(effect.target, effect.pseudoElement || null);
      return style.visibility === "visible" ? Number(style.opacity) : 0;
    };
    let opacity = visibleOpacity();
    let bestTime = initialTime;
    // An opacity blink can be invisible at the instant Pause is selected.
    // Sample a bounded set of authored phases and keep the clearest one.
    for (const frame of frames.slice(0, 12)) {
      if (opacity >= 1) break;
      if (frame.opacity === undefined && frame.visibility === undefined) continue;
      const offset = frame.computedOffset ?? frame.offset;
      if (!Number.isFinite(offset)) continue;
      animation.currentTime = delay + duration * Math.min(offset, 0.999999);
      const candidate = visibleOpacity();
      if (candidate > opacity) {
        opacity = candidate;
        bestTime = animation.currentTime;
      }
    }
    animation.currentTime = bestTime;
    return opacity > 0;
  }

  function pauseFlash(animation) {
    const effect = animation.effect;
    const target = effect?.target;
    const resumeTime = animation.currentTime;
    if (animation.playState !== "running" || animation.playbackRate === 0 || !Number.isFinite(resumeTime) ||
      animation instanceof view.CSSTransition || !(target instanceof view.Element) ||
      target.getRootNode() !== page || !target.getClientRects().length) return;
    const { iterations, delay } = effect.getTiming();
    const { duration } = effect.getComputedTiming();
    if (iterations <= 1 || !Number.isFinite(duration) || duration <= 0) return;
    const frames = effect.getKeyframes();
    const changesProperty = (property) => new Set(frames.map((frame) => frame[property]).filter((value) => value !== undefined)).size > 1;
    if (!FLASH_PROPERTIES.some(changesProperty)) return;
    const originalSignature = signature(animation);
    animation.pause();
    animation.currentTime = resumeTime;
    if ((changesProperty("opacity") || changesProperty("visibility")) &&
      !holdVisibleFrame(animation, effect, frames, resumeTime, duration, delay)) {
      animation.play();
      return;
    }
    paused.set(animation, { effect, target, resumeTime, holdTime: animation.currentTime, signature: originalSignature });
  }

  function refreshFlashes() {
    for (const [animation, record] of paused) {
      if (!ownsPause(animation, record)) paused.delete(animation);
      else if (record.target.getRootNode() !== page) {
        animation.currentTime = record.resumeTime;
        animation.play();
        paused.delete(animation);
      }
    }
    for (const animation of page.getAnimations().slice(0, FLASH_ANIMATION_LIMIT)) {
      if (paused.size >= FLASH_ANIMATION_LIMIT) break;
      if (!paused.has(animation)) pauseFlash(animation);
    }
    if (timer === null) timer = view.setTimeout(() => {
      timer = null;
      if (enabled(flashingMarker) && !enabled(motionMarker)) refreshFlashes();
      else releaseFlashes();
    }, 250);
  }

  function sync(syncMotion = () => {}) {
    const reduceMotion = enabled(motionMarker);
    const reduceFlashing = enabled(flashingMarker) && !reduceMotion;
    // Release targeted pauses before applying broader motion settings. When
    // switching back, let the motion adapter resume its effects before sampling.
    if (!reduceFlashing) releaseFlashes();
    projectMotion(reduceMotion);
    syncMotion();
    if (reduceFlashing) refreshFlashes();
  }

  return Object.freeze({
    apply({ reduceMotion, reduceFlashing }) {
      if (typeof reduceMotion !== "boolean" || typeof reduceFlashing !== "boolean") throw new TypeError("Invalid sensory preferences.");
      if (reduceMotion) changes.setStyle(root, motionMarker, "enabled");
      else changes.resetProperty(root, motionMarker);
      if (reduceFlashing) changes.setStyle(root, flashingMarker, "enabled");
      else changes.resetProperty(root, flashingMarker);
    },
    sync,
  });
}
