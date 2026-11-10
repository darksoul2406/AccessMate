import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Resolve paths from this script, even when it is run from another directory.
const projectRoot = fileURLToPath(new URL("../", import.meta.url));
const outputRoot = path.join(projectRoot, "dist");

const scriptEntries = [
  {
    source: "src/background/service-worker.js",
    destination: "background/service-worker.js",
    format: "esm",
  },
  {
    source: "src/panel/panel.js",
    destination: "panel/panel.js",
    format: "esm",
  },
];

const staticEntries = [
  { source: "manifest.json", destination: "manifest.json" },
  { source: "src/panel/panel.html", destination: "panel/panel.html" },
  { source: "src/panel/panel.css", destination: "panel/panel.css" },
  { source: "src/blocking/ad-rules.json", destination: "blocking/ad-rules.json" },
  { source: "node_modules/tesseract.js/dist/worker.min.js", destination: "ocr/worker.min.js" },
  { source: "node_modules/tesseract.js/dist/worker.min.js.LICENSE.txt", destination: "ocr/worker.min.js.LICENSE.txt" },
  { source: "node_modules/tesseract.js/LICENSE.md", destination: "ocr/tesseract-LICENSE.md" },
  { source: "node_modules/tesseract.js-core/tesseract-core-lstm.js", destination: "ocr/tesseract-core-lstm.js" },
  { source: "node_modules/tesseract.js-core/tesseract-core-lstm.wasm", destination: "ocr/tesseract-core-lstm.wasm" },
  { source: "node_modules/tesseract.js-core/LICENSE", destination: "ocr/tesseract-core-LICENSE.txt" },
  { source: "node_modules/@tesseract.js-data/eng/4.0.0_best_int/eng.traineddata.gz", destination: "ocr/eng.traineddata.gz" },
];

async function isFile(relativePath) {
  try {
    return (await stat(path.join(projectRoot, relativePath))).isFile();
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}

async function main() {
  const args = process.argv.slice(2);
  if (args.some((argument) => argument !== "--overwrite")) {
    throw new Error("Usage: node scripts/build.mjs [--overwrite]");
  }
  const overwrite = args.includes("--overwrite");
  const communityOrigin = process.env.ACCESSMATE_COMMUNITY_URL;
  if (communityOrigin !== undefined) {
    let url;
    try { url = new URL(communityOrigin); } catch { /* Report the configuration error below. */ }
    if (url?.protocol !== "https:" || url.origin !== communityOrigin) {
      throw new Error("Set ACCESSMATE_COMMUNITY_URL to an HTTPS origin without a path, query, or fragment.");
    }
  }

  // Check the initial extension skeleton before loading tools or writing files.
  const missingSources = [];
  for (const entry of [...scriptEntries, ...staticEntries]) {
    if (!(await isFile(entry.source))) missingSources.push(entry.source);
  }
  if (missingSources.length > 0) {
    throw new Error(
      `Required source files are not ready:\n${missingSources
        .map((source) => `  - ${source}`)
        .join("\n")}\nNo build output was written.`,
    );
  }

  const manifest = JSON.parse(
    await readFile(path.join(projectRoot, "manifest.json"), "utf8"),
  );
  if (
    manifest.manifest_version !== 3 ||
    manifest.background?.service_worker !== scriptEntries[0].destination ||
    manifest.background?.type !== "module" ||
    manifest.side_panel?.default_path !== "panel/panel.html"
  ) {
    throw new Error("The manifest entry points do not match this build layout.");
  }

  const { FILTER_INFO, AD_RULESET_ID } = await import("../src/blocking/ad-blocker.js");
  const rulesets = manifest.declarative_net_request?.rule_resources;
  if (!manifest.permissions.includes("declarativeNetRequest") || rulesets?.length !== 1 ||
    rulesets[0].id !== AD_RULESET_ID || rulesets[0].enabled !== false ||
    rulesets[0].path !== "blocking/ad-rules.json") throw new Error("Unexpected ad-blocking manifest configuration.");
  const adRules = JSON.parse(await readFile(path.join(projectRoot, "src/blocking/ad-rules.json"), "utf8"));
  const ruleIds = new Set();
  if (!Array.isArray(adRules) || adRules.length !== FILTER_INFO.rules) throw new Error("Ad rule count does not match its provenance metadata.");
  for (const rule of adRules) {
    if (!Number.isSafeInteger(rule.id) || rule.id < 1 || ruleIds.has(rule.id) ||
      !["block", "allow", "allowAllRequests"].includes(rule.action?.type) || !rule.condition ||
      (rule.action.type === "block" && (rule.condition.resourceTypes
        ? rule.condition.resourceTypes.includes("main_frame")
        : !rule.condition.excludedResourceTypes?.includes("main_frame")))) {
      throw new Error("Invalid or unsafe packaged ad-blocking rule.");
    }
    ruleIds.add(rule.id);
  }

  // These features join the package only after their source files are added.
  if (await isFile("src/content/content.js")) {
    scriptEntries.push({
      source: "src/content/content.js",
      destination: "content/content.js",
      format: "iife",
    });
  }
  for (const size of [16, 32, 48, 128]) {
    const iconPath = `assets/icons/icon${size}.png`;
    if (await isFile(iconPath)) {
      staticEntries.push({ source: iconPath, destination: iconPath });
    }
  }

  let build;
  try {
    ({ build } = await import("esbuild"));
  } catch (error) {
    if (error.code !== "ERR_MODULE_NOT_FOUND") throw error;
    throw new Error(
      "esbuild is unavailable. Install the project dependencies after approving that step.",
      { cause: error },
    );
  }

  // Prepare everything in memory so a compilation failure leaves dist untouched.
  const outputs = new Map();
  function addOutput(filename, contents) {
    const relativePath = path.relative(outputRoot, filename);
    if (
      !relativePath ||
      relativePath === ".." ||
      relativePath.startsWith(`..${path.sep}`) ||
      path.isAbsolute(relativePath)
    ) {
      throw new Error(`Build output must stay inside dist: ${filename}`);
    }
    if (outputs.has(filename)) {
      throw new Error(`Two build inputs produce the same output: ${relativePath}`);
    }
    outputs.set(filename, contents);
  }

  for (const entry of staticEntries) {
    addOutput(
      path.join(outputRoot, entry.destination),
      await readFile(path.join(projectRoot, entry.source)),
    );
  }
  for (const entry of scriptEntries) {
    const result = await build({
      absWorkingDir: projectRoot,
      entryPoints: [entry.source],
      outfile: path.join(outputRoot, entry.destination),
      bundle: true,
      platform: "browser",
      target: "chrome116",
      format: entry.format,
      minify: false,
      legalComments: "inline",
      logLevel: "silent",
      define: communityOrigin === undefined ? {} : { __ACCESSMATE_COMMUNITY_ORIGIN__: JSON.stringify(communityOrigin) },
      write: false,
    });
    for (const output of result.outputFiles) {
      addOutput(output.path, output.contents);
    }
    for (const warning of result.warnings) {
      console.warn(`[AccessMate build] ${warning.text}`);
    }
  }

  if (!overwrite) {
    for (const filename of outputs.keys()) {
      if (await isFile(path.relative(projectRoot, filename))) {
        throw new Error(
          "Build output already exists. To explicitly allow replacing generated files, " +
            "use npm run build -- --overwrite. No build output was written.",
        );
      }
    }
  }

  // Only generated paths inside dist are written; no source files are changed.
  for (const [filename, contents] of outputs) {
    await mkdir(path.dirname(filename), { recursive: true });
    await writeFile(filename, contents, { flag: overwrite ? "w" : "wx" });
  }
  console.log(`[AccessMate build] Created ${outputs.size} files in ${outputRoot}`);
  console.log("Load the dist folder as an unpacked extension in Chrome.");
}

main().catch((error) => {
  console.error(`[AccessMate build] ${error.message}`);
  process.exitCode = 1;
});
