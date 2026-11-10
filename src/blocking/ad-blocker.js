/*!
 * Packaged ad-rules.json is adapted from EasyList by The EasyList authors
 * (https://easylist.to/), licensed under CC BY-SA 3.0 Unported:
 * https://creativecommons.org/licenses/by-sa/3.0/
 * Source: https://easylist.to/easylist/easylist.txt
 * Version 202611071246; commit f3d328cc6e927d8ed29c69e84834918673c5fe8d
 * Source SHA-256: faf9aa1dc224f8d117e1481ea17a3e3378e8124b2e6d16124c1a293a2bc05a75
 * Converted using @adguard/dnr-converter 2.0.0 (build tool, not shipped).
 * Changes: retain block/allow/allowAllRequests rules; remove main-frame blocking;
 * omit metadata, redirects and header changes; assign sequential IDs.
 * 3,001 converter diagnostics indicate unsupported source rules. Cosmetic rules
 * and scriptlets are not part of this network ruleset. No remote code executes.
 * The adapted rule data retains the CC BY-SA 3.0 licence. This notice must
 * accompany that data, including copies of the built extension.
 */

import { createProfileStorage, PERSONAL_PROFILE_KEY, siteProfileKey } from "../profiles/profile-storage.js";
import { AD_CHANNEL, isAdCommand } from "../shared/messages.js";

export const AD_RULESET_ID = "accessmate_ads";
export const AD_CONFIG_KEY = "accessmate:ad-blocking:v1";
export const FILTER_INFO = Object.freeze({
  name: "EasyList", version: "202611071246", rules: 49907,
  converter: "@adguard/dnr-converter 2.0.0", unsupportedRules: 3001,
  source: "https://easylist.to/easylist/easylist.txt",
  licence: "https://creativecommons.org/licenses/by-sa/3.0/",
});
const EXCEPTION_IDS = [9000001, 9000002];
const EXCEPTION_PRIORITY = 2147483647;
const neutral = () => ({ version: 1, enabled: false, allowedDomains: [] });

/** Domain exceptions cover the named host and its subdomains, on HTTP/HTTPS. */
export function validateAdConfiguration(value) {
  if (!value || Object.getPrototypeOf(value) !== Object.prototype ||
    Object.keys(value).length !== 3 || value.version !== 1 || typeof value.enabled !== "boolean" ||
    !Array.isArray(value.allowedDomains) || value.allowedDomains.length > 1000) {
    throw new TypeError("Invalid ad-blocking configuration.");
  }
  const domains = value.allowedDomains.map((domain) => {
    if (typeof domain !== "string" || domain.length > 253 ||
      !/^[a-z0-9]+(?:[a-z0-9.-]*[a-z0-9])?$/.test(domain) ||
      domain.split(".").some((label) => !label || label.length > 63 || label.startsWith("-") || label.endsWith("-")) ||
      new URL("https://" + domain).hostname !== domain) {
      throw new TypeError("Use lowercase hostnames for website exceptions, without paths or ports.");
    }
    return domain;
  });
  return { version: 1, enabled: value.enabled, allowedDomains: [...new Set(domains)].sort() };
}

/**
 * Browser-native blocking: no browsing-history collection or remote updates.
 * This engine owns one static ruleset and two dynamic exception rules only.
 * Commands are serialized because Chrome can wake/stop the worker at any time.
 * Saved configuration is independent of appearance drafts until panel wiring.
 */
export function createAdBlocker(api = chrome) {
  let configuration = neutral();
  let ready = false;
  let failure = null;
  let chain = Promise.resolve();
  const dnr = api.declarativeNetRequest;
  function enqueue(task) {
    const next = chain.then(task, task);
    chain = next.catch(() => {});
    return next;
  }
  function exceptionRules(config) {
    if (!config.enabled || !config.allowedDomains.length) return [];
    return [
      { id: EXCEPTION_IDS[0], priority: EXCEPTION_PRIORITY, action: { type: "allow" },
        condition: { initiatorDomains: config.allowedDomains, urlFilter: "|http", excludedResourceTypes: ["main_frame"] } },
      // A document exception also covers advertising requests from its nested
      // third-party frames. Reload is required for already-loaded documents.
      { id: EXCEPTION_IDS[1], priority: EXCEPTION_PRIORITY, action: { type: "allowAllRequests" },
        condition: { requestDomains: config.allowedDomains, urlFilter: "|http", resourceTypes: ["main_frame", "sub_frame"] } },
    ];
  }
  async function apply(config) {
    if (!config.enabled) {
      await dnr.updateEnabledRulesets({ disableRulesetIds: [AD_RULESET_ID] });
      await dnr.updateDynamicRules({ removeRuleIds: EXCEPTION_IDS });
      return;
    }
    // Install exceptions before activating broad blocking.
    await dnr.updateDynamicRules({ removeRuleIds: EXCEPTION_IDS, addRules: exceptionRules(config) });
    await dnr.updateEnabledRulesets({ enableRulesetIds: [AD_RULESET_ID] });
  }
  async function initializeInternal() {
    if (ready) return;
    try {
      const stored = await api.storage.local.get(AD_CONFIG_KEY);
      configuration = Object.hasOwn(stored, AD_CONFIG_KEY) ? validateAdConfiguration(stored[AD_CONFIG_KEY]) : neutral();
      await apply(configuration);
      ready = true;
      failure = null;
    } catch (error) {
      // Keep malformed preferences intact for recovery; leave browsing usable.
      await dnr.updateEnabledRulesets({ disableRulesetIds: [AD_RULESET_ID] }).catch(() => {});
      failure = "Ad blocking could not initialize. Check saved settings and available browser rule capacity.";
      throw error;
    }
  }
  async function statusInternal() {
    const enabled = (await dnr.getEnabledRulesets()).includes(AD_RULESET_ID);
    return { ready, enabled, allowedDomains: [...configuration.allowedDomains], filter: { ...FILTER_INFO },
      error: failure, reloadRequired: true };
  }
  return Object.freeze({
    initialize: () => enqueue(async () => { await initializeInternal(); return statusInternal(); }),
    getStatus: () => enqueue(statusInternal),
    configure: (value) => enqueue(async () => {
      const next = validateAdConfiguration(value);
      // An explicit valid command can repair an invalid saved configuration.
      // Initialization itself never overwrites that record automatically.
      if (!ready) {
        try { await initializeInternal(); }
        catch { configuration = neutral(); }
      }
      const previous = configuration;
      try {
        await apply(next);
        await api.storage.local.set({ [AD_CONFIG_KEY]: next });
        configuration = next;
        ready = true;
        failure = null;
      } catch (error) {
        try { await apply(previous); }
        catch { await dnr.updateEnabledRulesets({ disableRulesetIds: [AD_RULESET_ID] }).catch(() => {}); }
        failure = "Ad-blocking changes could not be saved or applied. Reload after retrying.";
        throw error;
      }
      return statusInternal();
    }),
  });
}

/** Only the extension's own panel may configure the engine, never a webpage. */
export function registerAdBlocker(api = chrome) {
  const engine = createAdBlocker(api);
  let profileQueue = Promise.resolve();
  let profileError = null;
  function syncProfiles() {
    const task = profileQueue.then(async () => {
      // Validate one consistent snapshot, rather than mixing concurrent saves.
      const snapshot = await api.storage.local.get(null);
      const profiles = createProfileStorage({
        get: async () => snapshot,
        set: async () => { throw new Error("Profile synchronization uses a read-only snapshot."); },
      });
      const personal = await profiles.loadPersonalProfile();
      const allowedDomains = [];
      for (const key of Object.keys(snapshot)) {
        if (!key.startsWith("accessmate:profile:site:")) continue;
        const origin = decodeURIComponent(key.slice("accessmate:profile:site:".length));
        if (siteProfileKey(origin) !== key) throw new TypeError("Invalid saved website key.");
        const site = await profiles.loadSiteProfile(origin);
        if (site.overrides.content?.ads === "allow") allowedDomains.push(new URL(origin).hostname);
      }
      const status = await engine.configure({ version: 1, enabled: personal?.settings.content.ads === "hide", allowedDomains: [...new Set(allowedDomains)] });
      profileError = null;
      return status;
    });
    profileQueue = task.catch(() => { profileError = "Saved ad preferences could not be synchronized. Retry network settings."; });
    return task;
  }
  api.runtime.onMessage.addListener((message, sender, respond) => {
    // A panel opened in a normal extension tab is also trusted. Content scripts
    // have the webpage URL, so they cannot pass this exact extension-URL check.
    if (sender.id !== api.runtime.id ||
      sender.url?.split("#")[0] !== api.runtime.getURL("panel/panel.html") ||
      message?.channel !== AD_CHANNEL) return;
    const keys = Object.keys(message);
    const validStatus = isAdCommand(message) && message.action === "status";
    const validSync = isAdCommand(message) && message.action === "sync-profiles";
    const validConfigure = message.action === "configure" && keys.length === 3 && Object.hasOwn(message, "configuration");
    if (!validStatus && !validConfigure && !validSync) { respond({ ok: false, error: "Invalid ad-blocking command." }); return; }
    const task = validSync ? syncProfiles() : validStatus
      ? engine.getStatus().then((status) => ({ ...status, error: profileError ?? status.error }))
      : engine.configure(message.configuration);
    const reply = (value) => { try { respond(value); } catch {} };
    void task.then((status) => reply({ ok: true, ...status }), () => reply({ ok: false, error: "Ad blocking could not apply the requested configuration." }));
    return true;
  });
  // Running at worker evaluation handles install, update, startup and later wake.
  void engine.initialize().catch(() => console.error("[AccessMate] Ad-blocking initialization failed; blocking is disabled."));
  void syncProfiles().catch(() => console.error("[AccessMate] Saved ad preferences could not be synchronized."));
  api.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && Object.keys(changes).some((key) => key === PERSONAL_PROFILE_KEY || key.startsWith("accessmate:profile:site:"))) {
      void syncProfiles().catch(() => console.error("[AccessMate] Saved ad preferences could not be synchronized."));
    }
  });
  return engine;
}
