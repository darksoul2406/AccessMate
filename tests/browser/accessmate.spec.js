import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";
import { build } from "esbuild";

const root = fileURLToPath(new URL("../../", import.meta.url));
let bundle;

test.beforeAll(async () => {
  const result = await build({
    stdin: {
      resolveDir: root,
      contents: `
        import { scanAccessibility } from "./src/analysis/accessibility-scanner.js";
        import { isScanReport } from "./src/shared/messages.js";
        import { applyPresetToSettings, resolveSettings } from "./src/profiles/profile-manager.js";
        import { pagePreviewPreferences } from "./src/background/auto-apply.js";
        import { createChangeManager } from "./src/transformations/change-manager.js";
        import { createSensoryAdapter } from "./src/transformations/sensory.js";
        import { createMediaAdapter } from "./src/transformations/media.js";
        import { createDistractionAdapter } from "./src/transformations/distractions.js";

        const changes = createChangeManager();
        const sensory = createSensoryAdapter(changes);
        const media = createMediaAdapter(changes);
        const distractions = createDistractionAdapter(changes);
        function sync() {
          sensory.sync();
          media.sync();
          distractions.sync();
        }
        window.accessMateTest = {
          async scan() {
            const phase = changes.getStatus().changedProperties ? "after" : "before";
            const report = await scanAccessibility({ pageSessionId: "test-page", phase });
            if (!isScanReport(report)) throw Error("Invalid scan report");
            return report;
          },
          previewCognitivePreset(overrides) {
            const preset = applyPresetToSettings("sensory-cognitive");
            const preferences = pagePreviewPreferences(resolveSettings(preset, overrides));
            changes.run("Sensory and cognitive preset", () => {
              sensory.apply(preferences);
              media.apply(preferences);
              distractions.apply(preferences.distractions);
            });
            sync();
          },
          undo() {
            changes.undo();
            sync();
          },
          restore() {
            changes.restore();
            sync();
          },
        };
      `,
    },
    bundle: true,
    platform: "browser",
    write: false,
  });
  bundle = result.outputFiles[0].text;
});

function wavFixture() {
  const samples = 8000;
  const audio = Buffer.alloc(44 + samples, 128);
  audio.write("RIFF", 0);
  audio.writeUInt32LE(audio.length - 8, 4);
  audio.write("WAVEfmt ", 8);
  audio.writeUInt32LE(16, 16);
  audio.writeUInt16LE(1, 20);
  audio.writeUInt16LE(1, 22);
  audio.writeUInt32LE(8000, 24);
  audio.writeUInt32LE(8000, 28);
  audio.writeUInt16LE(1, 32);
  audio.writeUInt16LE(8, 34);
  audio.write("data", 36);
  audio.writeUInt32LE(samples, 40);
  return audio;
}

async function openFixture(page, origin, title, body) {
  await page.route(origin + "/tone.wav", (route) => route.fulfill({
    contentType: "audio/wav", body: wavFixture(),
  }));
  await page.route(origin + "/", (route) => route.fulfill({
    contentType: "text/html",
    body: `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${title}</title>
      <style>
        @keyframes move { from { transform: translateX(0) } to { transform: translateX(20px) } }
        .moving { animation: move 6s infinite alternate }
      </style></head><body><main><h1>${title}</h1>${body}</main></body></html>`,
  }));
  await page.goto(origin + "/");
  await page.addScriptTag({ content: bundle });
}

function scan(page) {
  return page.evaluate(() => window.accessMateTest.scan());
}

function finding(report, id) {
  return report.issues.find((issue) => issue.ruleId === id);
}

test("article scan reports supported review signals and explains who may be affected", async ({ page }) => {
  await openFixture(page, "https://articles.example", "Article", `
    <p id="faint" style="color:#aaa;background:#fff">Light grey text on white.</p>
    <p id="css" class="moving">Moving content</p>
    <p id="waapi">Another visual effect</p>
    <p id="short" style="animation:move 1s">A short effect</p>
    <p id="paused" class="moving" style="animation-play-state:paused">Paused effect</p>
    <p id="hidden-motion" class="moving" hidden>Hidden effect</p>
    <audio id="autoplay" src="/tone.wav" autoplay controls loop></audio>
    <audio id="click-to-play" src="/tone.wav" controls></audio>
    <audio id="blocked" autoplay controls></audio>
    <p id="instruction">Fields <strong>marked in red</strong> are required.</p>
    <p id="benign">The garden is shown in green.</p>
    <p id="hidden-instruction" hidden>Green means valid.</p>
    <p id="editable" contenteditable="true">Red indicates an error.</p>
    <label>Private field <input value="private-test-value"></label>
  `);
  await page.locator("#waapi").evaluate((element) => {
    element.animate([{ opacity: 1 }, { opacity: 0.7 }], { duration: 1500, iterations: Infinity });
  });
  await expect.poll(() => page.locator("#autoplay").evaluate((media) => media.paused)).toBe(false);

  const report = await scan(page);
  const motion = finding(report, "accessmate-sustained-motion");
  const autoplay = finding(report, "accessmate-autoplay-media");
  const colour = finding(report, "accessmate-colour-instructions");
  expect(motion.targets.map((item) => item.label)).toEqual(["p#css", "p#waapi"]);
  expect(autoplay.targets.map((item) => item.label)).toEqual(["audio#autoplay"]);
  expect(colour.targets.map((item) => item.label)).toEqual(["p#instruction"]);
  for (const issue of [motion, autoplay, colour]) {
    expect(issue.status).toBe("manual-review");
    expect(issue.description).toContain("May affect people");
    expect(report.coverage.checkedRules).not.toContain(issue.ruleId);
    expect(Object.values(report.scoring).flat()).not.toContain(issue.ruleId);
  }
  expect(report.summary.manualReviewTypes).toBeGreaterThanOrEqual(3);
  expect(finding(report, "color-contrast").description).toContain("people with low vision");
  expect(JSON.stringify(report)).not.toContain("private-test-value");
  await page.evaluate(() => window.accessMateTest.previewCognitivePreset({ sensory: { stopAutoplay: false } }));
  expect(await page.locator("#autoplay").evaluate((media) => media.paused)).toBe(false);
  await page.evaluate(() => window.accessMateTest.previewCognitivePreset());
  await expect.poll(() => page.locator("#autoplay").evaluate((media) => media.paused)).toBe(true);
  expect(finding(await scan(page), "accessmate-autoplay-media")).toBeUndefined();
});

test("form-site rescans reflect dynamic content and preset changes are reversible", async ({ page }) => {
  await openFixture(page, "https://forms.example", "Registration", `
    <nav aria-label="Sections"><a href="#form">Registration form</a></nav>
    <div class="decorative-widget" id="essential">
      <form id="form"><label>Preferred name <input id="name"></label></form>
    </div>
    <aside id="related" class="optional-sidebar">Related topics</aside>
    <div id="promo" class="promo-banner">Optional announcement</div>
    <p id="motion" class="moving">Moving accent</p>
  `);
  await page.locator("#name").fill("Test reader");
  await expect.poll(() => page.locator("#motion").evaluate((element) =>
    element.getAnimations().some((animation) => animation.effect.getComputedTiming().progress !== null))).toBe(true);
  const original = await scan(page);
  expect(finding(original, "accessmate-sustained-motion")).toBeDefined();
  expect(finding(original, "accessmate-colour-instructions")).toBeUndefined();

  await page.evaluate(() => window.accessMateTest.previewCognitivePreset());
  await expect(page.locator("#related")).toBeVisible();
  await page.evaluate(() => window.accessMateTest.previewCognitivePreset({ content: { sidebars: "hide" } }));
  await expect(page.locator("#related")).toBeHidden();
  await expect(page.locator("#promo")).toBeHidden();
  await expect(page.locator("#essential")).toBeVisible();
  await expect(page.getByRole("navigation")).toBeVisible();
  await page.locator("main").evaluate((element) => element.insertAdjacentHTML("beforeend",
    '<div id="late" class="decorative-widget">Late widget</div><p id="late-instruction">Yellow indicates a warning.</p>'));
  await expect(page.locator("#late")).toBeHidden();

  const after = await scan(page);
  expect(after.phase).toBe("after");
  expect(finding(after, "accessmate-sustained-motion")).toBeUndefined();
  expect(finding(after, "accessmate-colour-instructions").targets[0].label).toBe("p#late-instruction");
  await page.evaluate(() => window.accessMateTest.undo());
  await expect(page.locator("#related")).toBeVisible();
  await expect(page.locator("#late")).toBeHidden();
  await page.evaluate(() => window.accessMateTest.undo());
  for (const id of ["related", "promo", "late"]) await expect(page.locator("#" + id)).toBeVisible();
  await page.evaluate(() => {
    window.accessMateTest.previewCognitivePreset();
    window.accessMateTest.restore();
  });
  await expect(page.locator("#related")).toBeVisible();
  await expect(page.locator("#late")).toBeVisible();
  await expect(page.locator("#name")).toHaveValue("Test reader");
});
