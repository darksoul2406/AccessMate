import { createDefaultSettings } from "../shared/defaults.js";
import { COMMUNITY_MODERATOR_URL, createCommunityClient } from "../profiles/community-client.js";
import { createProfileStorage, siteProfileKey } from "../profiles/profile-storage.js";
import { PRESETS, getPreset } from "../profiles/presets.js";
import { applyPresetToSettings, resolveSettings, validateSettingsOverrides } from "../profiles/profile-manager.js";
import { createSettingsView, describePresetChanges } from "./settings-view.js";
import { createCommunityProfilesView } from "./community-profiles-view.js";
import { sitePermission } from "../background/auto-apply.js";

/**
 * Coordinate draft preferences and storage. Each website keeps a separate draft
 * while this panel is open. No draft is saved merely by switching tabs/scopes.
 */
export function createProfilesView(storage = createProfileStorage(), { onPreview = () => {}, onSaved = async () => {}, onRender = () => {} } = {}) {
  const controls = document.getElementById("profile-controls");
  const scopeSelect = document.getElementById("profile-scope");
  const siteOption = scopeSelect.querySelector('option[value="site"]');
  const presetSelect = document.getElementById("profile-preset");
  const apply = document.getElementById("apply-preset");
  const inherit = document.getElementById("inherit-personal");
  const status = document.getElementById("profiles-status");
  const contextLabel = document.getElementById("profile-context");
  const description = document.getElementById("preset-description");
  const changes = document.getElementById("preset-changes");
  const optionalAdvice = document.createElement("p");
  optionalAdvice.className = "feature-note";
  optionalAdvice.hidden = true;
  changes.after(optionalAdvice);
  const retry = document.getElementById("retry-profiles");
  const autoApply = document.getElementById("auto-apply-site");
  const siteAccessNote = document.getElementById("site-access-note");
  let origin = null;
  let preferredScope = "auto";
  let personal = null;
  let personalLoad = null;
  let displayed = null;
  let loadVersion = 0;
  const sites = new Map();
  const siteLoads = new Map();

  document.querySelector("#profiles > p:nth-of-type(2)").textContent =
    "Text-size previews affect the current website. Other adaptations are not available yet.";
  document.getElementById("customization-status").textContent =
    "Text size previews on the current page. Other preferences are saved for later use.";
  document.getElementById("cancel-preview").textContent = "Discard edits and preview";

  function notifyPreview() {
    if (displayed) onPreview({ origin, settings: structuredClone(resolved(displayed)) });
  }

  // Build chooser text from the canonical definitions rather than stored HTML.
  presetSelect.replaceChildren(new Option("Custom preferences / choose suggestions", ""));
  for (const preset of PRESETS) presetSelect.add(new Option(preset.name, preset.id));

  const settingsView = createSettingsView({ onEdit: edit, onSave: saveCurrent, onDiscard: discard });
  const community = createCommunityProfilesView({
    client: createCommunityClient(),
    applyProfile: applyCommunityProfile,
    preview(profile) {
      if (displayed?.kind !== "site" || displayed.origin !== profile.origin || displayed.saving) return false;
      edit(profile.settings);
      return true;
    },
  });
  const moderatorTools = document.createElement("details");
  moderatorTools.className = "feature-help";
  const moderatorHeading = document.createElement("summary");
  moderatorHeading.textContent = "Moderator tools";
  const moderatorLink = document.createElement("a");
  moderatorLink.href = COMMUNITY_MODERATOR_URL;
  moderatorLink.target = "_blank";
  moderatorLink.rel = "noopener noreferrer";
  moderatorLink.textContent = "Sign in as moderator";
  const moderatorNote = document.createElement("p");
  moderatorNote.textContent = "Opens the private review page in a new tab.";
  moderatorTools.append(moderatorHeading, moderatorLink, moderatorNote);
  controls.after(community.element, moderatorTools);

  function edit(patch) {
    if (!displayed || displayed.saving) return;
    try {
      if (displayed.kind === "personal") {
        displayed.settings = resolveSettings(displayed.settings, patch);
        displayed.presetId = null;
      } else displayed.overrides = mergeOverrides(displayed.overrides, patch);
      displayed.candidateId = "";
      displayed.message = "Unsaved preference changes. Review and save, or discard your edits.";
    } catch {
      displayed.message = "That preference value is not valid. Your previous draft was kept.";
    }
    render();
    if (Object.keys(patch).some((group) => group !== "reading")) notifyPreview();
  }

  function discard() {
    if (!displayed || displayed.saving) return;
    if (displayed.kind === "personal") {
      displayed.settings = structuredClone(displayed.savedSettings);
      displayed.presetId = displayed.savedPresetId;
      displayed.candidateId = displayed.savedPresetId ?? "";
    } else {
      displayed.overrides = structuredClone(displayed.savedOverrides);
      displayed.autoApply = displayed.savedAutoApply;
      displayed.candidateId = "";
    }
    displayed.message = "Unsaved edits discarded.";
    render();
    notifyPreview();
  }

  function mergeOverrides(base, patch) {
    if (!validateSettingsOverrides(patch).valid) throw new TypeError("Invalid preference changes.");
    const result = structuredClone(base);
    for (const [group, values] of Object.entries(patch)) {
      result[group] = { ...result[group], ...values };
    }
    return result;
  }

  async function loadPersonal() {
    if (personal) return personal;
    if (!personalLoad) {
      personalLoad = (async () => {
        const profile = await storage.loadPersonalProfile();
        const settings = profile?.settings ?? createDefaultSettings();
        personal = {
          kind: "personal", settings: structuredClone(settings),
          savedSettings: structuredClone(settings), presetId: profile?.presetId ?? null,
          savedPresetId: profile?.presetId ?? null, candidateId: profile?.presetId ?? "",
          saving: false,
          message: profile ? "Saved personal preferences loaded." : "Using original preferences. Nothing has been saved yet.",
        };
        return personal;
      })().finally(() => { personalLoad = null; });
    }
    return personalLoad;
  }

  async function loadSite(siteOrigin) {
    if (sites.has(siteOrigin)) return sites.get(siteOrigin);
    if (!siteLoads.has(siteOrigin)) {
      const promise = (async () => {
        const profile = await storage.loadSiteProfile(siteOrigin);
        const overrides = profile?.overrides ?? {};
        const context = {
          kind: "site", origin: siteOrigin, overrides: structuredClone(overrides),
          savedOverrides: structuredClone(overrides), autoApply: profile?.autoApply ?? false,
          savedAutoApply: profile?.autoApply ?? false,
          candidateId: "", saving: false,
          message: profile ? "Saved website preferences loaded." : "This website inherits your saved personal preferences.",
        };
        sites.set(siteOrigin, context);
        return context;
      })().finally(() => { siteLoads.delete(siteOrigin); });
      siteLoads.set(siteOrigin, promise);
    }
    return siteLoads.get(siteOrigin);
  }

  function resolved(context) {
    return context.kind === "personal"
      ? context.settings
      : resolveSettings(personal.savedSettings, context.overrides);
  }

  function isDirty(context) {
    return context.kind === "personal"
      ? JSON.stringify(context.settings) !== JSON.stringify(context.savedSettings) ||
          context.presetId !== context.savedPresetId
      : JSON.stringify(context.overrides) !== JSON.stringify(context.savedOverrides) || context.autoApply !== context.savedAutoApply;
  }

  function render() {
    if (!displayed) return;
    const context = displayed;
    const settings = resolved(context);
    controls.disabled = context.saving;
    scopeSelect.disabled = context.saving;
    siteOption.disabled = !origin;
    scopeSelect.value = context.kind;
    contextLabel.textContent = context.kind === "personal"
      ? "Editing personal preferences for all websites."
      : `Editing preferences for ${context.origin}. Other values inherit saved personal preferences.`;
    status.textContent = context.message;
    retry.hidden = true;
    inherit.hidden = context.kind !== "site";
    autoApply.disabled = context.kind !== "site" || context.saving;
    autoApply.checked = context.kind === "site" && context.autoApply;
    siteAccessNote.textContent = context.kind === "site"
      ? "Save to apply on later visits. Chrome may ask for site access."
      : "Choose This website only to enable automatic application.";
    presetSelect.value = context.candidateId;
    const preset = getPreset(context.candidateId);
    description.textContent = preset?.description ?? "Choose a preset to see its suggested settings.";
    optionalAdvice.textContent = preset?.optionalAdvice ?? "";
    optionalAdvice.hidden = !preset;
    const suggestions = preset ? describePresetChanges(settings, preset.settings) : [];
    changes.replaceChildren();
    if (preset && !suggestions.length) suggestions.push("These values already match your current draft.");
    for (const text of suggestions) {
      const item = document.createElement("li");
      item.textContent = text;
      changes.append(item);
    }
    apply.disabled = !preset || context.saving;
    const state = { enabled: true, dirty: isDirty(context), busy: context.saving };
    settingsView.render(settings, state);
    community.setContext(context.kind === "site" ? context : null);
    onRender(settings.reading, { ...state, scope: context.kind, message: context.message });
  }

  async function showContext() {
    const version = ++loadVersion;
    const siteOrigin = preferredScope !== "personal" ? origin : null;
    displayed = null;
    community.setContext(null);
    controls.disabled = true;
    scopeSelect.disabled = true;
    settingsView.setEnabled(false);
    status.textContent = "Loading saved preferences…";
    retry.hidden = true;
    onRender(null, { enabled: false, busy: true, message: status.textContent });
    try {
      const global = await loadPersonal();
      let context = siteOrigin ? await loadSite(siteOrigin) : global;
      // Prefer saved website overrides on opening, unless the user chose a scope.
      if (preferredScope === "auto" && context.kind === "site" && !context.autoApply && !Object.keys(context.overrides).length) {
        context = global;
      }
      if (version !== loadVersion) return;
      displayed = context;
      render();
      notifyPreview();
    } catch {
      if (version !== loadVersion) return;
      status.textContent = "Could not load saved preferences. Saved data was left unchanged. Retry when ready.";
      // Keep the scope chooser usable if only one website's record is invalid.
      siteOption.disabled = !origin;
      scopeSelect.value = siteOrigin ? "site" : "personal";
      scopeSelect.disabled = false;
      retry.hidden = false;
      retry.disabled = false;
      onRender(null, { enabled: false, busy: false, message: status.textContent });
    }
  }

  async function saveCurrent() {
    const context = displayed;
    if (!context || context.saving || !isDirty(context)) return;
    context.saving = true;
    context.message = "Saving preferences…";
    render();
    try {
      // Capture the context before awaiting. A tab switch cannot change the target.
      if (context.kind === "personal") {
        const profile = await storage.savePersonalProfile(context.settings, context.presetId);
        context.savedSettings = structuredClone(profile.settings);
        context.savedPresetId = profile.presetId;
      } else {
        const permission = sitePermission(context.origin);
        // Request access during the Save click, before any asynchronous storage work.
        if (context.autoApply && !await chrome.permissions.request(permission)) {
          context.message = "Site access declined. Allow access or turn off automatic application to save.";
          return;
        }
        const removeAccess = context.savedAutoApply && !context.autoApply;
        await saveSitePreferences(context, context.overrides, context.autoApply);
        if (removeAccess) await chrome.permissions.remove(permission).catch(() => false);
      }
      context.message = await afterSave("Preferences saved locally.");
    } catch {
      context.message = "Could not save preferences. Your edits are still here; try saving again.";
    } finally {
      context.saving = false;
      render();
      notifyPreview();
    }
  }

  async function saveSitePreferences(context, overrides, autoApply) {
    const profile = await storage.saveSiteProfile(context.origin, overrides, autoApply);
    context.savedOverrides = structuredClone(profile.overrides);
    context.savedAutoApply = profile.autoApply;
  }

  async function afterSave(message) {
    try { await onSaved(); }
    catch { return message + " Network blocking could not update. Use Retry network settings under Ads and distractions."; }
    return message;
  }

  async function applyCommunityProfile(profile) {
    const context = displayed;
    if (context?.kind !== "site" || context.origin !== profile.origin || context.saving) {
      return "Switch to this website’s preferences and try again.";
    }

    context.saving = true;
    context.message = "Applying community profile…";
    render();
    let saved = false;
    try {
      // Save just the selected fields. Keep unrelated edits in the draft.
      const draft = mergeOverrides(context.overrides, profile.settings);
      const overrides = mergeOverrides(context.savedOverrides, profile.settings);
      await saveSitePreferences(context, overrides, context.savedAutoApply);
      context.overrides = draft;
      context.candidateId = "";
      saved = true;
      const message = "Profile saved for this website.";
      context.message = await afterSave(isDirty(context) ? message + " Other edits are still in your draft." : message);
    } catch {
      context.message = "Could not save the profile. Try applying it again.";
    } finally {
      context.saving = false;
      if (displayed === context) {
        render();
        if (saved) notifyPreview();
      }
    }
    return context.message;
  }

  scopeSelect.addEventListener("change", () => {
    preferredScope = scopeSelect.value;
    void showContext();
  });
  autoApply.addEventListener("change", () => {
    if (displayed?.kind !== "site" || displayed.saving) return;
    displayed.autoApply = autoApply.checked;
    displayed.message = "Unsaved preference changes. Save or discard your edits.";
    render();
  });
  presetSelect.addEventListener("change", () => {
    if (!displayed || displayed.saving) return;
    displayed.candidateId = presetSelect.value;
    render();
  });
  apply.addEventListener("click", () => {
    if (!displayed || displayed.saving) return;
    const preset = getPreset(displayed.candidateId);
    if (!preset) return;
    if (displayed.kind === "personal") {
      displayed.settings = applyPresetToSettings(preset.id, displayed.settings);
      displayed.presetId = preset.id;
    } else displayed.overrides = mergeOverrides(displayed.overrides, preset.settings);
    displayed.message = "Preset suggestions added to your draft. Review all preferences before saving.";
    render();
    notifyPreview();
  });
  inherit.addEventListener("click", () => {
    if (!displayed || displayed.saving || displayed.kind !== "site") return;
    displayed.overrides = {};
    displayed.candidateId = "";
    displayed.message = "Website overrides cleared in this draft. Save to inherit personal preferences.";
    render();
    notifyPreview();
  });
  retry.addEventListener("click", () => { void showContext(); });

  void showContext();
  return Object.freeze({
    edit,
    save: saveCurrent,
    discard,
    getDraft(expectedOrigin) {
      if (!displayed || displayed.saving || origin !== expectedOrigin) return null;
      return { scope: displayed.kind, settings: structuredClone(resolved(displayed)) };
    },
    previewCurrent() { notifyPreview(); },
    setCurrentOrigin(nextOrigin) {
      if (nextOrigin !== null) siteProfileKey(nextOrigin);
      if (nextOrigin === origin) return;
      origin = nextOrigin;
      void showContext();
    },
  });
}
