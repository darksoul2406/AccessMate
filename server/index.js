import { mkdir, readFile, stat } from "node:fs/promises";
import { createServer } from "node:http";
import { isAbsolute, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { openProfileDatabase } from "./database.js";
import { createFeedbackService, FeedbackError } from "./feedback-service.js";
import { createModerationService, ModerationError } from "./moderation-service.js";
import { createModeratorSessions, ModeratorAuthError } from "./moderator-session.js";
import { createProfileService, ProfileInputError } from "./profile-service.js";

const HOST = "127.0.0.1";
const DEFAULT_PORT = 8787;
const MAX_BODY_BYTES = 8192;
const SESSION_PATH = "/moderation/session";
const MODERATION_PATH = "/moderation/profiles";
const REPORT_QUEUE_PATH = "/moderation/reports";
const SUGGESTION_FEEDBACK_PATH = "/feedback/suggestions";
const DECISION_PATH = /^\/moderation\/profiles\/([^/]+)\/decision$/;
const FEEDBACK_PATH = /^\/profiles\/([^/]+)\/(rating|report)$/;
const HOSTED_WRITES_PER_MINUTE = 120;
const MODERATOR_ASSETS = new Map([
  ["/moderator", ["index.html", "text/html"]],
  ["/moderator/", ["index.html", "text/html"]],
  ["/moderator/dashboard.js", ["dashboard.js", "text/javascript"]],
]);

class RequestError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function sendJson(response, status, data, headers = {}) {
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    ...headers,
  });
  response.end(JSON.stringify(data));
}

async function readJson(request) {
  if (request.headers["content-type"]?.split(";")[0].trim().toLowerCase() !== "application/json") {
    throw new RequestError(415, "Send the request body as application/json.");
  }
  if (Number(request.headers["content-length"]) > MAX_BODY_BYTES) {
    throw new RequestError(413, "The request body is too large.");
  }

  const chunks = [];
  let size = 0;
  for await (const chunk of request.iterator({ destroyOnReturn: false })) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new RequestError(413, "The request body is too large.");
    chunks.push(chunk);
  }

  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)));
  } catch {
    throw new RequestError(400, "Send a valid UTF-8 JSON body.");
  }
}

async function sendModeratorAsset(request, response, [filename, contentType]) {
  if (request.method !== "GET") {
    sendJson(response, 405, { error: "Use GET to open the moderator page." }, { Allow: "GET" });
    return;
  }
  const body = await readFile(new URL("./moderator/" + filename, import.meta.url));
  response.writeHead(200, {
    "Content-Type": contentType + "; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "X-Robots-Tag": "noindex",
    "Referrer-Policy": "no-referrer",
    "Content-Security-Policy": "default-src 'none'; script-src 'self'; style-src 'unsafe-inline'; " +
      "connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
  });
  response.end(body);
}

function hostedAddress(value) {
  if (value === undefined) return null;
  let url;
  try { url = new URL(value); }
  catch { throw new TypeError("Use an HTTPS origin for ACCESSMATE_PUBLIC_ORIGIN."); }
  if (url.protocol !== "https:" || url.origin !== value) {
    throw new TypeError("Use an HTTPS origin without a path, query, or fragment for ACCESSMATE_PUBLIC_ORIGIN.");
  }
  return url;
}

export function readRuntimeConfig(env = process.env) {
  const publicOrigin = hostedAddress(env.ACCESSMATE_PUBLIC_ORIGIN)?.origin;
  const port = Number(env.ACCESSMATE_PORT ?? (publicOrigin ? env.PORT : undefined) ?? DEFAULT_PORT);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("Use a port from 1 to 65535.");
  }
  const dataDirectory = env.ACCESSMATE_DATA_DIR;
  if ((publicOrigin || dataDirectory !== undefined) && (!dataDirectory || !isAbsolute(dataDirectory))) {
    throw new Error("Set ACCESSMATE_DATA_DIR to an absolute path on the persistent volume.");
  }
  return { publicOrigin, port, host: publicOrigin ? "0.0.0.0" : HOST, dataDirectory, moderatorToken: env.ACCESSMATE_MODERATOR_TOKEN };
}

async function handleModeration(request, response, url, moderation) {
  if (url.pathname === MODERATION_PATH) {
    if (request.method !== "GET") {
      sendJson(response, 405, { error: "Use GET for the moderation queue." }, { Allow: "GET" });
      return;
    }
    const { searchParams } = url;
    if (searchParams.size > 1 || (searchParams.size === 1 && !searchParams.has("status"))) {
      throw new RequestError(400, "Use a single status query parameter.");
    }
    sendJson(response, 200, { profiles: moderation.list(searchParams.get("status") ?? undefined) });
    return;
  }
  const match = DECISION_PATH.exec(url.pathname);
  if (!match) {
    sendJson(response, 404, { error: "Endpoint not found." });
    return;
  }
  if (request.method !== "POST") {
    sendJson(response, 405, { error: "Use POST to record a decision." }, { Allow: "POST" });
    return;
  }
  sendJson(response, 200, moderation.decide(match[1], await readJson(request)));
}

async function handleFeedback(request, response, feedback, profileId, action, limitWrite) {
  const method = action === "rating" ? "PUT" : "POST";
  if (request.method !== method) {
    sendJson(response, 405, { error: "Use " + method + " for this feedback route." }, { Allow: method });
    return;
  }
  limitWrite();
  const body = await readJson(request);
  const result = action === "rating" ? feedback.rate(profileId, body) : feedback.report(profileId, body);
  sendJson(response, 200, result);
}

export function createApiServer(database, { moderatorToken, publicOrigin } = {}) {
  const publicAddress = hostedAddress(publicOrigin);
  const moderatorSessions = createModeratorSessions(moderatorToken, publicAddress?.origin);
  const profiles = createProfileService(database);
  const moderation = createModerationService(database);
  const feedback = createFeedbackService(database);
  let windowStart = Date.now();
  let writes = 0;
  function limitWrite() {
    if (!publicAddress) return;
    const now = Date.now();
    if (now - windowStart >= 60_000) { windowStart = now; writes = 0; }
    if (writes >= HOSTED_WRITES_PER_MINUTE) throw new RequestError(429, "Too many submissions. Try again shortly.");
    writes++;
  }
  return createServer({ requestTimeout: 10000, headersTimeout: 5000 }, async (request, response) => {
    try {
      const port = request.socket.localPort;
      const host = request.headers.host?.toLowerCase();
      const validHost = publicAddress
        ? host === publicAddress.host ||
          (request.headers["x-forwarded-proto"] === "https" &&
            request.headers["x-forwarded-host"]?.toLowerCase() === publicAddress.host) ||
          (request.method === "GET" && request.url === "/health")
        : host === HOST + ":" + port || (port === 80 && host === HOST);
      if (!validHost) throw new RequestError(400, "Use the configured AccessMate address.");
      if (!request.url?.startsWith("/") || request.url.startsWith("//")) {
        throw new RequestError(400, "Use a relative request path.");
      }
      const base = publicAddress?.origin ?? "http://" + HOST;
      const url = new URL(request.url, base);
      if (url.origin !== base) throw new RequestError(400, "Use a relative request path.");
      const feedbackRoute = FEEDBACK_PATH.exec(url.pathname);

      if (url.pathname === "/health") {
        if (request.method === "GET") sendJson(response, 200, { ok: true });
        else sendJson(response, 405, { error: "Use GET for the health check." }, { Allow: "GET" });
      } else if (url.pathname === "/profiles") {
        if (request.method === "POST") {
          limitWrite();
          const result = profiles.submit(await readJson(request));
          sendJson(response, 201, result);
        } else if (request.method === "GET") {
          if (url.searchParams.size !== 1 || !url.searchParams.has("origin")) {
            throw new RequestError(400, "Include one origin query parameter.");
          }
          sendJson(response, 200, { profiles: profiles.listApproved(url.searchParams.get("origin")) });
        } else {
          sendJson(response, 405, { error: "Use GET or POST for profiles." }, { Allow: "GET, POST" });
        }
      } else if (url.pathname === SUGGESTION_FEEDBACK_PATH) {
        if (request.method === "PUT") {
          limitWrite();
          sendJson(response, 200, feedback.rateSuggestion(await readJson(request)));
        } else sendJson(response, 405, { error: "Use PUT for suggestion feedback." }, { Allow: "PUT" });
      } else if (feedbackRoute) {
        await handleFeedback(request, response, feedback, feedbackRoute[1], feedbackRoute[2], limitWrite);
      } else if (MODERATOR_ASSETS.has(url.pathname)) {
        await sendModeratorAsset(request, response, MODERATOR_ASSETS.get(url.pathname));
      } else if (url.pathname === SESSION_PATH) {
        if (request.method === "POST") {
          const cookie = moderatorSessions.signIn(request, await readJson(request));
          sendJson(response, 200, { ok: true }, { "Set-Cookie": cookie });
        } else if (request.method === "DELETE") {
          const cookie = moderatorSessions.signOut(request);
          sendJson(response, 200, { ok: true }, { "Set-Cookie": cookie });
        } else {
          sendJson(response, 405, { error: "Use POST to sign in or DELETE to sign out." }, { Allow: "POST, DELETE" });
        }
      } else if (url.pathname === REPORT_QUEUE_PATH) {
        moderatorSessions.authorize(request);
        if (request.method === "GET") sendJson(response, 200, { reports: feedback.listReports() });
        else sendJson(response, 405, { error: "Use GET for the report queue." }, { Allow: "GET" });
      } else if (url.pathname === MODERATION_PATH || url.pathname.startsWith(MODERATION_PATH + "/")) {
        moderatorSessions.authorize(request);
        await handleModeration(request, response, url, moderation);
      } else {
        sendJson(response, 404, { error: "Endpoint not found." });
      }
    } catch (error) {
      if (response.destroyed) return;
      if (error instanceof RequestError || error instanceof ModeratorAuthError || error instanceof ProfileInputError ||
        error instanceof ModerationError || error instanceof FeedbackError) {
        request.resume();
        const status = error.status ?? 400;
        const headers = status === 401 ? { "WWW-Authenticate": "Bearer" } : status === 429 ? { "Retry-After": "60" } : {};
        sendJson(response, status, { error: error.message }, headers);
      } else {
        console.error("[AccessMate backend] Request failed.", error);
        sendJson(response, 500, { error: "The server could not complete the request." });
      }
    }
  });
}

async function start() {
  const config = readRuntimeConfig();
  const directory = config.dataDirectory ?? fileURLToPath(new URL("./data/", import.meta.url));
  if (config.publicOrigin) {
    if (!(await stat(directory)).isDirectory()) throw new Error("The persistent data directory is unavailable.");
  } else {
    await mkdir(directory, { recursive: true });
  }
  const database = openProfileDatabase(join(directory, "accessmate.sqlite"));
  try {
    const server = createApiServer(database, config);
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(config.port, config.host, () => {
        server.off("error", reject);
        resolve();
      });
    });
    server.once("close", () => database.close());
    console.log("[AccessMate backend] Listening on " + (config.publicOrigin ?? "http://" + config.host + ":" + config.port));
  } catch (error) {
    database.close();
    throw error;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  start().catch((error) => {
    console.error("[AccessMate backend]", error.message);
    process.exitCode = 1;
  });
}
