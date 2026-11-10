import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

const TOKEN_FORMAT = /^[A-Za-z0-9_-]{32,128}$/;
const SESSION_COOKIE = "accessmate_moderator";
const SESSION_SECONDS = 30 * 60;
const MAX_SESSIONS = 64;

export class ModeratorAuthError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function digest(token) {
  return createHash("sha256").update(token).digest();
}

function sessionId(request) {
  const cookie = request.headers.cookie?.split(";").find((part) =>
    part.trimStart().startsWith(SESSION_COOKIE + "="),
  );
  return cookie?.trim().slice(SESSION_COOKIE.length + 1);
}

export function createModeratorSessions(token, publicOrigin) {
  if ((publicOrigin || token !== undefined) && (typeof token !== "string" || !TOKEN_FORMAT.test(token))) {
    throw new TypeError("Use a moderator token of 32 to 128 letters, digits, hyphens, or underscores.");
  }
  const expectedDigest = token === undefined ? null : digest(token);
  const sessions = new Map();

  function checkEnabled() {
    if (!expectedDigest) throw new ModeratorAuthError(503, "Moderator sign-in is unavailable.");
  }

  function validToken(value) {
    return typeof value === "string" && TOKEN_FORMAT.test(value) && timingSafeEqual(digest(value), expectedDigest);
  }

  function checkOrigin(request) {
    const port = request.socket.localPort;
    const origin = publicOrigin ?? "http://127.0.0.1" + (port === 80 ? "" : ":" + port);
    if (request.headers.origin !== origin) {
      throw new ModeratorAuthError(403, "Open the AccessMate moderator page to continue.");
    }
  }

  function cookie(id, maxAge) {
    return SESSION_COOKIE + "=" + id + "; Path=/moderation; HttpOnly; SameSite=Strict; Max-Age=" + maxAge +
      (publicOrigin ? "; Secure" : "");
  }

  return {
    signIn(request, body) {
      checkEnabled();
      checkOrigin(request);
      if (!validToken(body?.token)) throw new ModeratorAuthError(401, "That moderator key did not work.");

      const now = Date.now();
      sessions.delete(sessionId(request));
      for (const [id, expiry] of sessions) {
        if (expiry <= now) sessions.delete(id);
      }
      if (sessions.size >= MAX_SESSIONS) sessions.delete(sessions.keys().next().value);
      const id = randomBytes(32).toString("base64url");
      sessions.set(id, now + SESSION_SECONDS * 1000);
      return cookie(id, SESSION_SECONDS);
    },
    authorize(request) {
      checkEnabled();
      if (request.headers.authorization !== undefined) {
        const bearer = /^Bearer ([A-Za-z0-9_-]{32,128})$/i.exec(request.headers.authorization)?.[1];
        if (!validToken(bearer)) throw new ModeratorAuthError(401, "A valid moderator token is required.");
        return;
      }
      const id = sessionId(request);
      if (!(sessions.get(id) > Date.now())) {
        sessions.delete(id);
        throw new ModeratorAuthError(401, "Sign in to review community profiles.");
      }
      if (request.method !== "GET") checkOrigin(request);
    },
    signOut(request) {
      checkOrigin(request);
      sessions.delete(sessionId(request));
      return cookie("", 0);
    },
  };
}
