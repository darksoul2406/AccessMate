import { createHelpDetails } from "../panel/settings-view.js";
import { DEFAULT_SETTINGS } from "../shared/defaults.js";

/** Bounded utterances avoid sending an entire article to one speech request. */
export function splitSpeech(text, limit = 220) {
  if (typeof text !== "string" || !Number.isInteger(limit) || limit < 2) throw new TypeError("Invalid speech chunk input.");
  const chunks = [];
  for (let rest = text.trim(); rest;) {
    let end = Math.min(limit, rest.length);
    if (end < rest.length) {
      const gap = rest.lastIndexOf(" ", end);
      if (gap > limit / 2) end = gap;
    }
    // Keep surrogate pairs intact, including emoji at a chunk boundary.
    if (end < rest.length && /[\uD800-\uDBFF]/.test(rest[end - 1])) end--;
    chunks.push(rest.slice(0, end));
    rest = rest.slice(end).trimStart();
  }
  return chunks;
}

/** Speech belongs to the extension panel; page speech/DOM is never rewritten. */
export function createReadAloudView({ readText, onEdit, onSave, onDiscard }, page = document, speech = page.defaultView.speechSynthesis) {
  const view = page.defaultView;
  const fieldset = page.getElementById("assistance-controls");
  const status = page.getElementById("assistance-status");
  const read = page.getElementById("read-aloud");
  const stop = page.getElementById("stop-reading");
  const pause = page.createElement("button");
  pause.id = "pause-reading"; pause.type = "button"; pause.textContent = "Pause";
  stop.before(pause);
  status.setAttribute("role", "status"); status.setAttribute("aria-atomic", "true");
  function select(id, title, entries) {
    const label = page.createElement("label"); label.htmlFor = id; label.textContent = title; label.style.display = "block";
    const control = page.createElement("select"); control.id = id;
    for (const [name, value] of entries) control.add(new view.Option(name, value));
    fieldset.insertBefore(label, fieldset.querySelector(".button-group"));
    label.after(control);
    return control;
  }
  const source = select("reading-source", "Text to read", [["Main page content", "page"], ["Selected text", "selection"]]);
  const voiceSelect = select("reading-voice", "Local voice", []);
  const rate = select("reading-speed", "Reading speed", [["0.75× — slower", ".75"], ["1× — normal", "1"], ["1.25×", "1.25"], ["1.5×", "1.5"], ["2× — faster", "2"]]);
  rate.value = "1";
  const voiceNote = page.createElement("p");
  voiceNote.id = "reading-voice-note";
  voiceNote.className = "feature-note";
  voiceNote.hidden = true;
  voiceSelect.setAttribute("aria-describedby", voiceNote.id);
  voiceSelect.after(voiceNote);
  const help = page.createElement("p");
  help.textContent = "Reads supported visible text using local voices. Form values, editable fields, hidden content, images, embedded frames, and shadow content are excluded. Voice and speed follow the selected profile. Save and Discard apply to the whole profile draft. Changing reading options stops playback. Choose Main page content to read the focused view in Reading mode.";
  const helpDetails = createHelpDetails("Read aloud", [help.textContent], page);
  help.textContent = "Choose page content, or select text on the website first. Uses local voices.";
  help.className = "feature-note";
  fieldset.append(help, helpDetails);
  const profileStatus = page.createElement("p");
  profileStatus.className = "feature-note";
  const preferenceButtons = page.createElement("div");
  preferenceButtons.className = "button-group";
  function preferenceButton(id, label, action) {
    const button = page.createElement("button");
    button.id = id;
    button.type = "button";
    button.textContent = label;
    button.addEventListener("click", () => { void action(); });
    preferenceButtons.append(button);
    return button;
  }
  const save = preferenceButton("save-reading-preferences", "Save preferences", onSave);
  const discard = preferenceButton("discard-reading-preferences", "Discard edits", onDiscard);
  if (onEdit) fieldset.append(profileStatus, preferenceButtons);
  const supported = !!speech && typeof view.SpeechSynthesisUtterance === "function" &&
    ["getVoices", "speak", "pause", "resume", "cancel", "addEventListener"].every((method) => typeof speech[method] === "function");
  let voices = [], available = false, generation = 0, current = null, chunks = [], position = 0, state = "idle", watchdog = null, continuation = null;
  let preferences = DEFAULT_SETTINGS.reading;
  let profile = { enabled: false, busy: Boolean(onEdit), message: "Loading preferences…" };
  let customRate = null;
  function render() {
    fieldset.disabled = false;
    page.getElementById("toggle-reading-mode").disabled = !available;
    read.disabled = !supported || !available || !voices.length || state === "loading" || (profile.busy && !profile.enabled);
    pause.disabled = !["speaking", "paused"].includes(state);
    pause.textContent = state === "paused" ? "Resume" : "Pause";
    stop.disabled = state === "idle";
    source.disabled = !supported || state === "loading";
    voiceSelect.disabled = source.disabled || profile.busy || !voices.length;
    rate.disabled = source.disabled || profile.busy;
    save.disabled = discard.disabled = !profile.enabled || !profile.dirty || profile.busy;
    const scope = profile.scope === "site" ? "Website profile" : "Personal profile";
    profileStatus.textContent = profile.enabled ? `${scope} · ${profile.message}` : profile.message;
  }
  function clearWatchdog() { if (watchdog !== null) view.clearTimeout(watchdog); watchdog = null; }
  function finish(message) {
    generation++; clearWatchdog();
    const owned = current !== null;
    current = null; chunks = []; position = 0; state = "idle"; continuation = null;
    if (owned) { speech.cancel(); speech.resume(); }
    status.textContent = message; render();
  }
  function refreshVoices() {
    if (!supported) { status.textContent = "Read aloud is unavailable in this browser."; render(); return; }
    try { voices = speech.getVoices().filter((voice) => voice.localService === true); }
    catch { voices = []; }
    renderVoiceOptions();
    if (!voices.length) {
      finish("No local speech voices are available yet. Install a speech voice in your operating system if needed, then reopen AccessMate.");
    } else if (state === "idle") status.textContent = "Ready to read.";
    render();
  }
  const preferredVoiceIndex = () => voices.findIndex((voice) => voice.name === preferences.voiceName);
  const defaultVoice = () => voices.find((voice) => voice.default) ?? voices[0];
  function renderVoiceOptions() {
    voiceSelect.replaceChildren(new view.Option("Automatic local voice", ""));
    voices.forEach((voice, index) => voiceSelect.add(new view.Option(`${voice.name} (${voice.lang})`, String(index))));
    const index = preferredVoiceIndex();
    const missing = preferences.voiceName !== null && index === -1;
    if (missing) {
      const option = new view.Option(`${preferences.voiceName} (unavailable)`, "missing");
      option.disabled = true;
      voiceSelect.add(option);
    }
    voiceSelect.value = missing ? "missing" : index === -1 ? "" : String(index);
    const fallback = defaultVoice();
    voiceNote.textContent = missing && fallback ? `Using ${fallback.name} while your preferred voice is unavailable.` : "";
    voiceNote.hidden = !voiceNote.textContent;
  }
  function applyPreferences(next) {
    const changed = next.voiceName !== preferences.voiceName || next.speechRate !== preferences.speechRate;
    preferences = next;
    renderVoiceOptions();
    customRate?.remove();
    customRate = null;
    let option = [...rate.options].find((entry) => Number(entry.value) === next.speechRate);
    if (!option) {
      option = new view.Option(`${next.speechRate}×`, String(next.speechRate));
      rate.add(option);
      customRate = option;
    }
    rate.value = option.value;
    if (changed && state !== "idle") finish("Reading options changed. Press Read aloud to restart.");
    else render();
  }
  function editPreferences(patch) {
    if (profile.busy) return;
    if (profile.enabled) onEdit(patch);
    else applyPreferences({ ...preferences, ...patch });
  }
  function speakNext(token, voice, speed, lang, truncated) {
    if (token !== generation) return;
    if (position >= chunks.length) { finish(truncated ? "Finished reading the extracted portion. Some content was omitted due to limits." : "Finished reading."); return; }
    const utterance = new view.SpeechSynthesisUtterance(chunks[position]);
    current = utterance; utterance.voice = voice; utterance.lang = voice.lang || lang; utterance.rate = speed;
    state = "speaking"; render();
    status.textContent = `Reading part ${position + 1} of ${chunks.length}.${truncated ? " Content was limited." : ""}`;
    watchdog = view.setTimeout(() => { if (token === generation && current === utterance) finish("Speech did not start. Try Read aloud again or choose another local voice."); }, 10000);
    utterance.onstart = () => { if (token === generation) clearWatchdog(); };
    utterance.onend = () => {
      if (token !== generation || current !== utterance) return;
      clearWatchdog(); current = null; position++;
      if (state !== "paused") speakNext(token, voice, speed, lang, truncated);
    };
    utterance.onerror = () => { if (token === generation && current === utterance) finish("Speech could not continue. Choose another local voice or try again."); };
    // Keep the current utterance strongly referenced until its end/error event.
    try { speech.speak(utterance); } catch { finish("Speech could not start. Try another local voice."); }
  }
  async function startReading(loadText, emptyMessage, errorMessage) {
    finish("Preparing text…");
    const token = generation;
    const voice = voices[preferredVoiceIndex()] ?? defaultVoice();
    if (!available || !voice || voice.localService !== true) return false;
    state = "loading"; render();
    try {
      const result = await loadText();
      if (token !== generation) return false;
      if (!result.text.trim()) { finish(emptyMessage); return false; }
      chunks = splitSpeech(result.text); position = 0;
      const language = result.lang;
      continuation = () => speakNext(token, voice, preferences.speechRate, language, result.truncated);
      speech.resume(); continuation();
      return state === "speaking";
    } catch {
      if (token === generation) finish(errorMessage);
      return false;
    }
  }
  read.addEventListener("click", () => {
    const selected = source.value;
    void startReading(() => readText(selected), selected === "selection"
      ? "No supported selected text. Select visible text on the webpage first." : "No supported visible page text was found.",
    "Could not read this page. Click AccessMate on the website, then try again.");
  });
  pause.addEventListener("click", () => {
    if (state === "speaking") { clearWatchdog(); state = "paused"; speech.pause(); status.textContent = "Reading paused."; }
    else if (state === "paused") { state = "speaking"; speech.resume(); if (!current) continuation?.(); status.textContent = "Reading resumed."; }
    render();
  });
  stop.addEventListener("click", () => finish("Reading stopped."));
  source.addEventListener("change", () => finish("Reading source changed. Press Read aloud to start."));
  voiceSelect.addEventListener("change", () => {
    if (voiceSelect.value === "missing") return;
    const voice = voiceSelect.value === "" ? null : voices[Number(voiceSelect.value)];
    if (voice !== undefined) editPreferences({ voiceName: voice?.name ?? null });
  });
  rate.addEventListener("change", () => editPreferences({ speechRate: Number(rate.value) }));
  if (supported) speech.addEventListener("voiceschanged", refreshVoices);
  view.addEventListener("pagehide", () => finish("Reading stopped."));
  page.addEventListener("visibilitychange", () => { if (page.hidden) finish("Reading stopped because the panel is hidden."); });
  refreshVoices();
  return Object.freeze({
    setProfileState(next, nextProfile) {
      profile = nextProfile;
      if (next) applyPreferences(next);
      else if (profile.busy && state !== "idle") finish("Reading stopped.");
      else render();
    },
    setAvailable(value) { available = value; render(); },
    speakResult(text) {
      return startReading(() => ({ text, lang: "en", truncated: false }), "There is no image result to read.",
        "Could not start reading the image result. Try again or choose another local voice.");
    },
    stop(message = "Page changed. Press Read aloud to read the new page.") { finish(message); },
  });
}
