# AccessMate

AccessMate is a Google Chrome extension for adapting existing websites to individual accessibility needs. It is a university Software Engineering project built with Manifest V3. The side panel lets users scan a page, preview changes, and save preferences they want to reuse.

## What AccessMate can do

- **Scan and report.** Review confirmed accessibility findings, examples, who may be affected, and items that need manual review. Preview suggestions for confirmed low contrast and small controls. Scan before and after a change to compare results when the page and scan coverage are comparable.
- **Customize the page.** Adjust text size, line and letter spacing, browser zoom, text and background colours, contrast, control size, cursor size, and keyboard focus highlighting.
- **Support colour vision.** Choose a red–green or blue–yellow adjustment or grayscale. Add labels, icons, or patterns to supported colour-coded states.
- **Reduce motion and distractions.** Reduce supported animations, GIF motion, flashing, and moving backgrounds. Pause supported video and audio, mute media, or hide recognized ads, promotional banners, pop-ups, recommendations, optional sidebars, and widgets.
- **Read and navigate.** Open Reading Mode for supported content. Read the main page or selected text aloud with a local voice and adjustable speed. Find visible headings, sections, links, and controls, then jump to a target.
- **Get help with images.** Extract English text from visible images with OCR, read website-provided image descriptions, and generate descriptions on supported Chrome setups. Either result can be read aloud.
- **Save and reverse changes.** Keep personal preferences or save overrides for one website. Use Discard to return to saved preferences, Undo to reverse the last page change, or Restore page to remove active page adaptations.
- **Share profiles and give feedback.** Submit website settings for moderation, preview and apply approved profiles, and rate or report profiles. Mark a previewed scan suggestion as helpful or not helpful.

### Preset suggestions

| Preset | Starting settings |
| --- | --- |
| **Visually Impaired / Low Vision** | 150% text, 1.6× line spacing, higher contrast, 44 px minimum control size, a larger cursor, and keyboard focus highlighting. |
| **Sensory & Cognitive-Friendly** | Pauses supported animations, reduces flashing, stops supported autoplay, and hides recognised pop-ups, promotional banners, and extra widgets. |
| **Color Vision Support** | Adds colour-safe labels, icons, and patterns to supported states. Choose filters and contrast separately in Customize. |
| **General / Enhanced User** | 125% text, 1.6× line spacing, and fewer promotional banners. |

Each preset shows what it would change and lists optional adjustments. Select **Use preset suggestions** to add its settings to your draft, then customize individual values as needed.

## Install and load in Chrome

**Requirements**

- Google Chrome 116 or newer, as declared in the manifest.
- Node.js 24 or newer and npm.

From the project folder, install the locked dependencies and build the extension. Set the Community Profiles URL before building to use the hosted service.

```powershell
npm.cmd ci
$env:ACCESSMATE_COMMUNITY_URL = 'https://accessmate-api-production.up.railway.app'
npm.cmd run build
```

On systems outside Windows, use `npm` in place of `npm.cmd` and set `ACCESSMATE_COMMUNITY_URL` in your shell. For an existing build, use `npm.cmd run build -- --overwrite` to replace the generated files in `dist/`.

1. Open `chrome://extensions` and enable **Developer mode**.
2. Select **Load unpacked** and choose the project's `dist` folder.
3. Open an HTTP or HTTPS website and click AccessMate's **gold triangle** in the toolbar to open the side panel. Pin it from Chrome's Extensions menu if desired.

After a source change, rebuild, click **Reload** on the extension card, and refresh the website before reopening the panel.

## Use the side panel

1. **Report** → **Scan current page** to check the page as it appears now. For an original-page baseline, use **Restore page** first if adaptations are active. The assessment score is the rounded percentage of conclusive, applicable axe-core rules that passed. Supplemental signals for sustained motion, playing media marked for autoplay, and common English colour instructions appear under **Needs manual review**. Assessing WCAG conformance also requires manual review.
2. **Profiles** → choose **Personal preferences — all websites** or **This website only**. The website profile inherits saved personal settings for fields without an override.
3. Preview a report suggestion, apply a preset, or adjust individual settings under **Customize**, **Distractions**, or **Assistance**.
4. Select **Save preferences** to keep the draft. For a website profile, enable **Automatically apply on this site** and grant site access when Chrome asks to reuse it on later visits.
5. Scan again to compare results, or use **Undo and restore** to reverse the active page changes. Manage saved preferences through **Profiles** or the relevant settings section.

### Image assistance

1. Bring the image into view on the website and open **Assistance → Image assistance**.
2. Click **Find visible images** and choose one from the list.
3. Click **Extract text (OCR)** to recognise English text, or **Describe image** to read the website's description or caption. When there is no website description, AccessMate can generate one if Chrome's on-device AI is available. Check AI-generated descriptions and OCR results for errors. [Chrome Prompt API](https://developer.chrome.com/docs/ai/prompt-api)
4. Click **Read result aloud** to hear the result using your local voice and speed settings.

### Community Profiles

1. Open the target website and choose **Profiles → This website only → Community profiles**. Click **Connect to Community Profiles** and allow access when Chrome asks.
2. To share, add website-specific settings, enter a name, click **Review settings to share**, then **Submit for review**. Approved profiles appear for that website after moderation.
3. To use a profile, click **Browse approved profiles**, select one, and use **Preview profile** to try its settings or **Apply to this website** to apply and save them for that site. Use **Profile feedback** to rate or report an approved profile.

After previewing a suggestion from an accessibility report, use **Helpful** or **Not helpful** to send feedback.

### Moderator review

1. Open **Profiles → Moderator tools → Sign in as moderator**. The private review page opens in a new tab.
2. Enter the moderator key configured as `ACCESSMATE_MODERATOR_TOKEN` on the server. Keep the key private.
3. Under **Pending profiles**, use **View submitted settings** to review a profile, then choose **Approve** or **Reject**. Use **Refresh queue** to see new submissions.
4. Under **Reported profiles**, review reports and choose **Unpublish profile** if it should be removed from Community Profiles. Select **Sign out** when finished.

The hosted service stores submissions, moderation decisions, ratings, reports, and suggestion votes in SQLite. For local development, build without `ACCESSMATE_COMMUNITY_URL` and start the backend with `node server/index.js`. The local backend uses `http://127.0.0.1:8787` and stores its database under `server/data/` by default. Set `ACCESSMATE_MODERATOR_TOKEN` before starting the local backend to enable moderator sign-in.

### Ad blocking

- On the current page, **Advertisements → Hide** previews hiding recognized ad elements.
- To block matching network requests across sites, choose **Personal preferences — all websites**, set **Advertisements** to **Hide**, save, and reload the website. Save **Allow** in the personal profile to turn network blocking off.
- To allow a site while global blocking is enabled, choose **This website only**, set **Advertisements** to **Allow**, save, and reload. This exception covers the hostname and its subdomains. A saved website **Hide** replaces the exception.
- The browser uses a bundled EasyList-derived ruleset. Some ads, including ads embedded in video streams or page content, may still appear. [Filter source and attribution](https://easylist.to/), [CC BY-SA 3.0 licence](https://creativecommons.org/licenses/by-sa/3.0/), [conversion and version details](src/blocking/ad-blocker.js).

## Test and verify

```powershell
npm.cmd test
npm.cmd run test:e2e
```

- **Unit tests** cover preset settings, profile storage and precedence, scoring, and recommendations. [Unit test suite](tests/core.test.js).
- **Backend tests** cover profile publication, moderator sign-in and decisions, and feedback. [Backend test suite](tests/backend.test.js).
- **Playwright tests** use installed Google Chrome and two controlled websites. They check scanner findings, preset previews, autoplay, dynamic content, and Undo/Restore. [Browser test suite](tests/browser/accessmate.spec.js).

For a manual check, scan an article, preview **General / Enhanced User**, then rescan and try **Undo**. Check Reading Mode, page navigation, and OCR on an image with clear text. For Community Profiles, submit a test profile, approve it as a moderator, and browse and apply it as a customer. Repeat the demo on the websites and computer you plan to use for your presentation.

## Project structure

| Path | Responsibility |
| --- | --- |
| `manifest.json` | Declares the Chrome extension, its permissions, the toolbar action, and the side panel. |
| `src/background/` | Opens the panel and coordinates saved website auto-apply. |
| `src/panel/` | Renders reports, profile drafts, settings, and assistance controls. |
| `src/content/` | Runs page analysis and adaptation commands in the current website document. |
| `src/analysis/` | DOM analysis, axe-core scanning, supplemental checks, scoring, and recommendations. |
| `src/profiles/` and `src/shared/` | Presets, saved settings, defaults, shared data shapes, and message validation. |
| `src/transformations/` and `src/blocking/` | Reversible page changes, browser zoom, and network ad blocking. |
| `src/reading/` and `src/navigation/` | Reading Mode, text extraction, speech, image assistance, and semantic page navigation. |
| `server/` | Community Profiles API, SQLite storage, feedback, and the private moderator page. |
| `scripts/build.mjs` and `tests/` | Build tooling and automated verification. |

The panel sends validated commands to the current document. The content script runs scans and coordinates the page adapters. The service worker manages browser capabilities such as site auto-apply and network blocking. Generated extension files are loaded from `dist/`. Make changes in the source files and rebuild.

## Privacy and coverage

- Preferences and website origins are saved in Chrome's local extension storage. Scan results stay in the current panel session. Page analysis runs in the browser and read-aloud uses voices Chrome reports as local.
- OCR and image descriptions process the selected image on the device. Image results are cleared when leaving the page.
- Community submissions send the reviewed settings, profile name, and website origin to the backend. Ratings, reports, and suggestion votes use randomly generated feedback IDs.
- Clicking the toolbar icon grants temporary page access through `activeTab`. Site auto-apply uses the site's optional host permission. Chrome's declarative request rules handle supported network blocking.
- Page tools focus on supported content in the main document. Embedded players, shadow content, and custom controls may have limited coverage. Rescan after the website changes and review uncertain findings manually.
- Undo and Restore manage page adaptations. To change saved network ad blocking, save the desired ad setting and reload the website.

## Remaining project work

- Prepare the UML diagrams, project report, and final demo. Verify the demo flows on selected real websites.
- **Deferred features** include Task Mode, the optional developer accessibility dashboard, and using feedback to improve future suggestions.
- **Stretch scope** includes AI-assisted recommendations and natural-language task planning.
