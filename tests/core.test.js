import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { pagePreviewPreferences } from "../src/background/auto-apply.js";
import { recommendAdaptations } from "../src/analysis/recommendations.js";
import { calculateScore } from "../src/analysis/scoring.js";
import { createCommunityClient } from "../src/profiles/community-client.js";
import { applyPresetToSettings, resolveSettings, validateSettingsOverrides } from "../src/profiles/profile-manager.js";
import { PRESETS } from "../src/profiles/presets.js";
import { createProfileStorage, PERSONAL_PROFILE_KEY } from "../src/profiles/profile-storage.js";
import { isCommunityId, isCommunityRating, isCommunityRatingSummary, isCommunityReportReason } from "../src/shared/community-feedback.js";

test("presets use supported controls and preserve existing ad, filter, and voice choices", () => {
  assert.deepEqual(PRESETS.map(({ name }) => name), [
    "Visually Impaired / Low Vision",
    "Sensory & Cognitive-Friendly",
    "Color Vision Support",
    "General / Enhanced User",
  ]);
  const current = resolveSettings({
    content: { ads: "hide" },
    colorVision: { filter: "deuteranopia", addPatterns: true },
    reading: { speechRate: 1.5 },
    sensory: { muteAudio: true, stopAutoplay: true },
  });

  for (const preset of PRESETS) {
    assert.equal(validateSettingsOverrides(preset.settings).valid, true, preset.id);
    assert.ok(Object.values(preset.settings.content ?? {}).every((mode) => ["allow", "hide"].includes(mode)));
    assert.equal(preset.settings.reading, undefined);
    assert.equal(preset.settings.interaction?.keyboardNavigation, undefined);
    const result = applyPresetToSettings(preset.id, current);
    assert.equal(result.content.ads, "hide");
    assert.equal(result.colorVision.filter, "deuteranopia");
    assert.equal(result.colorVision.addPatterns, true);
    assert.equal(result.reading.speechRate, 1.5);
    assert.equal(result.sensory.muteAudio, true);
    assert.equal(result.sensory.stopAutoplay, true);
  }

  const fresh = pagePreviewPreferences(applyPresetToSettings("sensory-cognitive"));
  assert.deepEqual(fresh.distractions, {
    ads: "allow", banners: "hide", recommendations: "allow", popups: "hide", sidebars: "allow", clutter: "hide",
  });
  assert.equal(fresh.reduceMotion, true);
  assert.equal(fresh.reduceFlashing, true);
  assert.equal(fresh.motionBehavior, "pause");
  assert.equal(fresh.stopAutoplay, true);
  assert.equal(current.content.sidebars, "allow");

  const colour = applyPresetToSettings("color-vision");
  assert.equal(colour.colorVision.addLabels, true);
  assert.equal(colour.colorVision.addIcons, true);
  assert.equal(colour.colorVision.addPatterns, true);
  assert.equal(colour.colorVision.filter, "none");
  assert.equal(colour.visual.highContrast, false);

  const reading = applyPresetToSettings("enhanced");
  assert.equal(reading.visual.textScale, 125);
  assert.equal(reading.visual.lineHeight, 1.6);
  assert.equal(reading.content.banners, "hide");

  const lowVision = applyPresetToSettings("low-vision");
  assert.equal(lowVision.visual.textScale, 150);
  assert.equal(lowVision.visual.lineHeight, 1.6);
  assert.equal(lowVision.visual.highContrast, true);
  assert.equal(lowVision.interaction.highlightFocus, true);
  assert.equal(lowVision.interaction.cursorSize, "large");
  assert.equal(lowVision.interaction.targetSize, 44);
});

test("saved profiles retain legacy values, and site and preview settings take precedence", async () => {
  const records = {};
  const storage = createProfileStorage({
    get: async (key) => Object.hasOwn(records, key) ? { [key]: structuredClone(records[key]) } : {},
    set: async (values) => Object.assign(records, structuredClone(values)),
  });
  const site = "https://forms.example";
  const other = "https://articles.example";
  const personal = resolveSettings({ visual: { textScale: 125 }, content: { banners: "minimize" } });
  await storage.savePersonalProfile(personal);
  await storage.saveSiteProfile(site, { visual: { textScale: 150 } }, true);
  const saved = await storage.loadPersonalProfile();
  const siteProfile = await storage.loadSiteProfile(site);
  assert.equal(siteProfile.autoApply, true);
  assert.equal(await storage.loadSiteProfile(other), null);
  assert.equal(saved.settings.content.banners, "minimize");
  assert.equal(pagePreviewPreferences(saved.settings).distractions.banners, "allow");
  assert.equal(resolveSettings(saved.settings, siteProfile.overrides).visual.textScale, 150);
  assert.equal(resolveSettings(saved.settings, siteProfile.overrides, { visual: { textScale: 175 } }).visual.textScale, 175);
  assert.equal(records[PERSONAL_PROFILE_KEY].settings.visual.textScale, 125);
});

test("assessment scores count conclusive rules once", () => {
  const rules = (...ids) => ids.map((id) => ({ id }));
  const score = calculateScore({
    passes: rules("heading", "contrast", "size", "heading"),
    violations: rules("contrast"),
    incomplete: rules("size", "contrast"),
  });
  assert.equal(score.score, 50);
  assert.deepEqual(score.scoring, {
    passedRules: ["heading"], failedRules: ["contrast"], inconclusiveRules: ["size"],
  });
});

test("recommendations skip manual-review findings and settings the user already chose", () => {
  const report = {
    analysis: { stable: true },
    issues: [
      { ruleId: "color-contrast", status: "violation", affectedCount: 2 },
      { ruleId: "target-size", status: "violation", affectedCount: 1 },
      { ruleId: "accessmate-sustained-motion", status: "manual-review", affectedCount: 3 },
    ],
  };
  const settings = resolveSettings({ interaction: { targetSize: 56 } });
  const suggestions = recommendAdaptations(report, settings);
  assert.deepEqual(suggestions.map((suggestion) => suggestion.settings), [{ visual: { highContrast: true } }]);
  assert.deepEqual(recommendAdaptations({ ...report, analysis: { stable: false } }, settings), []);
  assert.equal(settings.visual.highContrast, false);
});

test("personal feedback ranks eligible suggestions and preserves the default order for ties", () => {
  const report = {
    analysis: { stable: true },
    issues: [
      { ruleId: "color-contrast", status: "violation", affectedCount: 2 },
      { ruleId: "target-size", status: "violation", affectedCount: 1 },
    ],
  };
  const settings = resolveSettings();
  const contrast = "increase-contrast";
  const controls = "minimum-control-size";
  const order = (votes) => recommendAdaptations(report, settings, votes).map(({ id }) => id);
  assert.deepEqual(order(), [contrast, controls]);
  assert.deepEqual(order({ [controls]: true }), [controls, contrast]);
  assert.deepEqual(order({ [contrast]: false }), [controls, contrast]);
  assert.deepEqual(order({ [contrast]: true, [controls]: true }), [contrast, controls]);
  assert.deepEqual(order({ [contrast]: true, [controls]: false }), [contrast, controls]);
  assert.deepEqual(order({ [contrast]: "false" }), [contrast, controls]);
  assert.deepEqual(
    recommendAdaptations(report, resolveSettings({ visual: { highContrast: true } }), { [contrast]: true, [controls]: false })
      .map(({ id }) => id),
    [controls],
  );
});

test("suggestion votes persist locally across clients even if permission or sharing fails", async () => {
  const records = {};
  const storage = {
    get: async (keys) => Object.fromEntries([keys].flat().filter((key) => Object.hasOwn(records, key))
      .map((key) => [key, records[key]])),
    set: async (values) => Object.assign(records, values),
  };
  let permissionGranted = false;
  let offline = true;
  const uploads = [];
  const options = {
    storage,
    locks: { request: (_key, task) => task() },
    permissions: { request: async () => permissionGranted },
    fetcher: async (url, { method, body }) => {
      const data = JSON.parse(body);
      uploads.push({ path: new URL(url).pathname, method, data });
      if (offline) throw new Error("Offline");
      return Response.json({ helpful: data.helpful });
    },
  };
  const contrast = "increase-contrast";
  const controls = "minimum-control-size";
  const client = createCommunityClient(options);
  assert.deepEqual(await client.loadSuggestionVotes(), {});
  await assert.rejects(client.rateSuggestion("invalid", true), /valid suggestion vote/);
  assert.deepEqual(await client.rateSuggestion(contrast, false), { shared: false });
  assert.deepEqual(uploads, []);

  permissionGranted = true;
  assert.deepEqual(await client.rateSuggestion(controls, true), { shared: false });
  assert.deepEqual(await createCommunityClient(options).loadSuggestionVotes(), { [contrast]: false, [controls]: true });

  offline = false;
  assert.deepEqual(await client.rateSuggestion(controls, false), { shared: true });
  assert.deepEqual(await createCommunityClient(options).loadSuggestionVotes(), { [contrast]: false, [controls]: false });
  const clientId = uploads[0].data.clientId;
  assert.ok(isCommunityId(clientId));
  assert.deepEqual(uploads, [true, false].map((helpful) => ({
    path: "/feedback/suggestions",
    method: "PUT",
    data: { suggestionId: controls, clientId, helpful },
  })));
});

test("community feedback uses fixed choices and coherent rating summaries", () => {
  for (const value of [1, 2, 3, 4, 5]) assert.equal(isCommunityRating(value), true);
  for (const value of [0, 1.5, 6, "5", null]) assert.equal(isCommunityRating(value), false);
  for (const reason of ["breaks-website", "misleading", "inappropriate"]) {
    assert.equal(isCommunityReportReason(reason), true);
  }
  for (const reason of ["", "other", "__proto__", "constructor", null]) {
    assert.equal(isCommunityReportReason(reason), false);
  }
  assert.equal(isCommunityRatingSummary(0, null), true);
  assert.equal(isCommunityRatingSummary(2, 4.5), true);
  for (const [count, average] of [[0, 5], [1, null], [-1, 3], [1, "4"], [1, 6], [0.5, 4]]) {
    assert.equal(isCommunityRatingSummary(count, average), false);
  }
});

test("the community client keeps one feedback ID per profile across rating and reporting", async () => {
  const records = {};
  const storage = {
    get: async (key) => Object.hasOwn(records, key) ? { [key]: records[key] } : {},
    set: async (values) => Object.assign(records, values),
  };
  const pending = new Map();
  const locks = {
    request(key, task) {
      const next = (pending.get(key) ?? Promise.resolve()).then(task);
      pending.set(key, next.catch(() => {}));
      return next;
    },
  };
  const calls = [];
  const fetcher = async (url, { method, body }) => {
    const data = JSON.parse(body);
    calls.push({ path: new URL(url).pathname, method, data });
    return Response.json(method === "PUT" ? { rating: data.rating } : { received: true });
  };
  const options = { storage, locks, fetcher };
  const client = createCommunityClient(options);
  const first = randomUUID();
  const second = randomUUID();
  await assert.rejects(client.rate(first, 6), /rating from 1 to 5/);
  await assert.rejects(client.report(first, "other"), /supported report reason/);
  assert.deepEqual(records, {});

  await Promise.all([client.rate(first, 4), client.report(first, "breaks-website")]);
  await createCommunityClient(options).rate(first, 5);
  await client.rate(second, 3);
  assert.equal(Object.keys(records).length, 2);
  const firstId = calls[0].data.clientId;
  const secondId = calls[3].data.clientId;
  assert.ok(isCommunityId(firstId) && isCommunityId(secondId));
  assert.notEqual(firstId, secondId);
  assert.deepEqual(calls, [
    { path: "/profiles/" + first + "/rating", method: "PUT", data: { clientId: firstId, rating: 4 } },
    { path: "/profiles/" + first + "/report", method: "POST", data: { clientId: firstId, reason: "breaks-website" } },
    { path: "/profiles/" + first + "/rating", method: "PUT", data: { clientId: firstId, rating: 5 } },
    { path: "/profiles/" + second + "/rating", method: "PUT", data: { clientId: secondId, rating: 3 } },
  ]);
});

test("community browsing accepts earlier lists and validates supplied rating summaries", async () => {
  const origin = "https://example.com";
  const profile = { id: randomUUID(), origin, name: "Reading profile", settings: { visual: { textScale: 125 } } };
  let served = profile;
  const client = createCommunityClient({ fetcher: async () => Response.json({ profiles: [served] }) });
  assert.deepEqual(await client.browse(origin), [{ ...profile, ratingCount: null, averageRating: null }]);
  served = { ...profile, ratingCount: 2, averageRating: 4.5 };
  assert.deepEqual(await client.browse(origin), [served]);
  served = { ...profile, ratingCount: 0, averageRating: 5 };
  await assert.rejects(client.browse(origin), /invalid rating summary/);
});
