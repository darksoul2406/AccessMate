import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdtempSync, rmdirSync, rmSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { test } from "node:test";
import { openProfileDatabase } from "../server/database.js";
import { createApiServer, readRuntimeConfig } from "../server/index.js";
import { createModerationService } from "../server/moderation-service.js";
import { createProfileService } from "../server/profile-service.js";

const origin = "https://articles.example";
const submission = {
  origin,
  name: "Reader's larger text",
  settings: { visual: { textScale: 150 }, content: { banners: "hide" } },
};

async function startTestServer(t, options) {
  const database = openProfileDatabase(":memory:");
  const server = createApiServer(database, options);
  t.after(async () => {
    try {
      if (server.listening) {
        await new Promise((resolve, reject) => {
          server.close((error) => error ? reject(error) : resolve());
        });
      }
    } finally {
      database.close();
    }
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return { database, baseUrl: "http://127.0.0.1:" + server.address().port };
}

async function submit(baseUrl, data) {
  return fetch(baseUrl + "/profiles", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  });
}

async function sendFeedback(baseUrl, profileId, kind, data) {
  const response = await fetch(baseUrl + "/profiles/" + profileId + "/" + kind, {
    method: kind === "rating" ? "PUT" : "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  });
  return { status: response.status, body: await response.json() };
}

test("shared profiles survive a database reopen with pending status", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "accessmate-backend-"));
  const filename = join(directory, "profiles.sqlite");
  let database;
  t.after(() => {
    database?.close();
    rmSync(filename, { force: true });
    rmdirSync(directory);
  });
  database = openProfileDatabase(filename);
  const result = createProfileService(database).submit(submission);
  assert.equal(result.status, "pending");
  database.close();
  database = null;

  database = openProfileDatabase(filename);
  const row = database.prepare(
    "SELECT origin, name, settings_json, status FROM shared_profiles WHERE id = ?",
  ).get(result.id);
  assert.equal(row.origin, origin);
  assert.equal(row.name, submission.name);
  assert.equal(row.status, "pending");
  assert.deepEqual(JSON.parse(row.settings_json), submission.settings);
  assert.deepEqual(createProfileService(database).listApproved(origin), []);
});

test("the local API publishes only approved profiles for the requested origin", async (t) => {
  const { database, baseUrl } = await startTestServer(t);
  const health = await fetch(baseUrl + "/health");
  assert.equal(health.status, 200);
  assert.deepEqual(await health.json(), { ok: true });
  const moderationUnavailable = await fetch(baseUrl + "/moderation/profiles");
  assert.equal(moderationUnavailable.status, 503);
  await moderationUnavailable.json();

  const posted = await submit(baseUrl, { ...submission, name: " " + submission.name + " " });
  assert.equal(posted.status, 201);
  const { id, status } = await posted.json();
  assert.match(id, /^[\da-f-]{36}$/);
  assert.equal(status, "pending");
  const listUrl = baseUrl + "/profiles?origin=" + encodeURIComponent(origin);
  assert.deepEqual(await (await fetch(listUrl)).json(), { profiles: [] });

  const profiles = createProfileService(database);
  profiles.submit({ ...submission, name: "Still pending" });
  const rejected = profiles.submit({ ...submission, name: "Rejected" });
  const different = profiles.submit({ ...submission, origin: "https://forms.example" });
  const moderation = createModerationService(database);
  moderation.decide(id, { action: "approve" });
  moderation.decide(different.id, { action: "approve" });
  moderation.decide(rejected.id, { action: "reject" });

  const published = await fetch(listUrl);
  assert.equal(published.status, 200);
  const { profiles: results } = await published.json();
  assert.equal(results.length, 1);
  const { createdAt, ...profile } = results[0];
  assert.ok(Number.isFinite(Date.parse(createdAt)));
  assert.deepEqual(profile, { id, ...submission, ratingCount: 0, averageRating: null });
});

test("invalid profile submissions and oversized requests leave the database empty", async (t) => {
  const { database, baseUrl } = await startTestServer(t);
  const invalid = [
    { ...submission, origin: origin + "/article" },
    { ...submission, origin: "chrome://settings" },
    { ...submission, name: " " },
    { ...submission, settings: {} },
    { ...submission, settings: { visual: { textScale: 999 } } },
    { ...submission, settings: { reading: { voiceName: "Local device voice" } } },
    { ...submission, settings: { content: { banners: "minimize" } } },
    { ...submission, autoApply: true },
  ];
  for (const data of invalid) {
    const response = await submit(baseUrl, data);
    assert.equal(response.status, 400);
    assert.equal(typeof (await response.json()).error, "string");
  }
  const badJson = await fetch(baseUrl + "/profiles", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: "{",
  });
  assert.equal(badJson.status, 400);
  await badJson.json();
  const nonJson = await fetch(baseUrl + "/profiles", { method: "POST", body: "text" });
  assert.equal(nonJson.status, 415);
  await nonJson.json();

  for (const [body, duplex] of [
    ["x".repeat(8193), undefined],
    [Readable.from(["x".repeat(4096), "x".repeat(4097)]), "half"],
  ]) {
    const oversized = await fetch(baseUrl + "/profiles", {
      method: "POST", headers: { "Content-Type": "application/json" }, body, duplex,
    });
    assert.equal(oversized.status, 413);
    await oversized.json();
  }
  const badQuery = await fetch(baseUrl + "/profiles?origin=" + encodeURIComponent(origin) + "&origin=duplicate");
  assert.equal(badQuery.status, 400);
  await badQuery.json();
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM shared_profiles").get().count, 0);
});

test("only authorized moderators can see the queue and record decisions", async (t) => {
  const moderatorToken = randomBytes(32).toString("hex");
  const { database, baseUrl } = await startTestServer(t, { moderatorToken });
  const queueUrl = baseUrl + "/moderation/profiles";
  const { id } = await (await submit(baseUrl, submission)).json();
  const decisionUrl = queueUrl + "/" + id + "/decision";

  for (const headers of [{}, { Authorization: "Bearer " + randomBytes(32).toString("hex") }]) {
    const queue = await fetch(queueUrl, { headers });
    assert.equal(queue.status, 401);
    assert.equal(queue.headers.get("www-authenticate"), "Bearer");
    await queue.json();
    const denied = await fetch(decisionUrl, {
      method: "POST", headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({ action: "approve" }),
    });
    assert.equal(denied.status, 401);
    await denied.json();
  }

  const headers = { Authorization: "Bearer " + moderatorToken };
  const queue = await fetch(queueUrl, { headers });
  assert.equal(queue.status, 200);
  const { profiles } = await queue.json();
  assert.equal(profiles.length, 1);
  assert.equal(profiles[0].id, id);
  assert.equal(profiles[0].status, "pending");
  assert.deepEqual(profiles[0].settings, submission.settings);
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM moderation_decisions").get().count, 0);
});

test("the moderator page signs in, protects decisions, and revokes sessions on sign-out", async (t) => {
  const moderatorToken = randomBytes(32).toString("hex");
  const { baseUrl } = await startTestServer(t, { moderatorToken });
  const { id } = await (await submit(baseUrl, submission)).json();
  const queue = baseUrl + "/moderation/profiles";
  const session = baseUrl + "/moderation/session";
  const page = await fetch(baseUrl + "/moderator");
  assert.equal(page.status, 200);
  assert.match(page.headers.get("content-security-policy"), /frame-ancestors 'none'/);
  const html = await page.text();
  assert.match(html, /Moderator key/);
  assert.doesNotMatch(html, /Reader's larger text/);
  const script = await fetch(baseUrl + "/moderator/dashboard.js");
  assert.match(script.headers.get("content-type"), /^text\/javascript/);
  await script.text();
  assert.equal((await fetch(queue)).status, 401);

  function login(token, pageOrigin = baseUrl) {
    return fetch(session, {
      method: "POST",
      headers: { Origin: pageOrigin, "Content-Type": "application/json" },
      body: JSON.stringify({ token }),
    });
  }
  const crossSite = await login(moderatorToken, "https://other.example");
  assert.equal(crossSite.status, 403);
  assert.equal(crossSite.headers.get("set-cookie"), null);
  const wrongKey = await login("a".repeat(32));
  assert.equal(wrongKey.status, 401);
  assert.equal(wrongKey.headers.get("set-cookie"), null);

  const signedIn = await login(moderatorToken);
  assert.equal(signedIn.status, 200);
  const sessionCookie = signedIn.headers.get("set-cookie");
  assert.match(sessionCookie, /^accessmate_moderator=[\w-]{43}; Path=\/moderation; HttpOnly; SameSite=Strict; Max-Age=1800$/);
  const Cookie = sessionCookie.split(";")[0];
  const pending = await fetch(queue, { headers: { Cookie } });
  assert.equal(pending.status, 200);
  assert.equal((await pending.json()).profiles[0].id, id);
  const reports = await fetch(baseUrl + "/moderation/reports", { headers: { Cookie } });
  assert.deepEqual(await reports.json(), { reports: [] });

  function approve(Origin) {
    return fetch(queue + "/" + id + "/decision", {
      method: "POST",
      headers: { Cookie, Origin, "Content-Type": "application/json" },
      body: JSON.stringify({ action: "approve" }),
    });
  }
  assert.equal((await approve("https://other.example")).status, 403);
  assert.equal((await approve(baseUrl)).status, 200);
  const published = await fetch(baseUrl + "/profiles?origin=" + encodeURIComponent(origin));
  assert.equal((await published.json()).profiles[0].id, id);

  const logout = await fetch(session, { method: "DELETE", headers: { Origin: baseUrl, Cookie } });
  assert.equal(logout.status, 200);
  assert.match(logout.headers.get("set-cookie"), /Max-Age=0/);
  assert.equal((await fetch(queue, { headers: { Cookie } })).status, 401);
});

test("approval, rejection, and unpublishing update public visibility and record decisions", async (t) => {
  const moderatorToken = randomBytes(32).toString("hex");
  const { database, baseUrl } = await startTestServer(t, { moderatorToken });
  const profiles = createProfileService(database);
  const pending = profiles.submit(submission);
  const other = profiles.submit({ ...submission, name: "Second submission" });
  const queueUrl = baseUrl + "/moderation/profiles";
  const publicUrl = baseUrl + "/profiles?origin=" + encodeURIComponent(origin);
  const headers = { Authorization: "Bearer " + moderatorToken, "Content-Type": "application/json" };
  async function decide(id, action) {
    const response = await fetch(queueUrl + "/" + id + "/decision", {
      method: "POST", headers, body: JSON.stringify({ action }),
    });
    return { status: response.status, body: await response.json() };
  }

  assert.equal((await decide(pending.id, "publish")).status, 400);
  assert.equal((await decide(pending.id, "unpublish")).status, 409);
  assert.equal((await decide("00000000-0000-0000-0000-000000000000", "approve")).status, 404);

  const attempts = await Promise.all([decide(pending.id, "approve"), decide(pending.id, "approve")]);
  assert.deepEqual(attempts.map((attempt) => attempt.status).sort(), [200, 409]);
  assert.equal(attempts.find((attempt) => attempt.status === 200).body.status, "approved");
  const published = await (await fetch(publicUrl)).json();
  assert.deepEqual(published.profiles.map((profile) => profile.id), [pending.id]);

  const approvedQueue = await (await fetch(queueUrl + "?status=approved", { headers })).json();
  assert.deepEqual(approvedQueue.profiles.map((profile) => profile.id), [pending.id]);
  assert.equal((await decide(other.id, "reject")).body.status, "rejected");
  const removed = await decide(pending.id, "unpublish");
  assert.equal(removed.status, 200);
  assert.equal(removed.body.action, "unpublish");
  assert.deepEqual(await (await fetch(publicUrl)).json(), { profiles: [] });
  const rejectedQueue = await (await fetch(queueUrl + "?status=rejected", { headers })).json();
  assert.deepEqual(new Set(rejectedQueue.profiles.map((profile) => profile.id)), new Set([pending.id, other.id]));

  const history = database.prepare(
    "SELECT profile_id, action, decided_at FROM moderation_decisions ORDER BY id",
  ).all();
  assert.deepEqual(history.map((row) => [row.profile_id, row.action]), [
    [pending.id, "approve"], [other.id, "reject"], [pending.id, "unpublish"],
  ]);
  assert.ok(history.every((row) => Number.isFinite(Date.parse(row.decided_at))));
});

test("a failed decision record rolls back the profile status", (t) => {
  const database = openProfileDatabase(":memory:");
  t.after(() => database.close());
  const { id } = createProfileService(database).submit(submission);
  database.exec(`
    CREATE TRIGGER fail_decision BEFORE INSERT ON moderation_decisions
    BEGIN
      SELECT RAISE(ABORT, 'Test decision write failure');
    END;
  `);
  const moderation = createModerationService(database);
  assert.throws(() => moderation.decide(id, { action: "approve" }), /Test decision write failure/);
  assert.equal(moderation.list("pending")[0].id, id);
  assert.deepEqual(createProfileService(database).listApproved(origin), []);
});

test("ratings are validated and updated once per client and approved profile", async (t) => {
  const { database, baseUrl } = await startTestServer(t);
  const { id } = createProfileService(database).submit(submission);
  const clientId = randomUUID();
  const rate = (data) => sendFeedback(baseUrl, id, "rating", data);
  assert.equal((await rate({ clientId, rating: 4 })).status, 404);
  const moderation = createModerationService(database);
  moderation.decide(id, { action: "approve" });

  for (const input of [
    { clientId: "invalid", rating: 4 },
    { clientId, rating: 0 },
    { clientId, rating: 6 },
    { clientId, rating: 2.5 },
    { clientId, rating: "5" },
    { clientId, rating: 4, note: "Unexpected field" },
  ]) {
    assert.equal((await rate(input)).status, 400);
  }
  assert.deepEqual(await rate({ clientId, rating: 2 }), { status: 200, body: { rating: 2 } });
  assert.equal((await rate({ clientId: randomUUID(), rating: 5 })).status, 200);
  assert.deepEqual(await rate({ clientId, rating: 4 }), { status: 200, body: { rating: 4 } });
  assert.equal((await rate({ clientId, rating: 4 })).status, 200);

  const published = await (await fetch(baseUrl + "/profiles?origin=" + encodeURIComponent(origin))).json();
  assert.equal(published.profiles[0].ratingCount, 2);
  assert.equal(published.profiles[0].averageRating, 4.5);
  assert.ok(!JSON.stringify(published).includes(clientId));
  moderation.decide(id, { action: "unpublish" });
  assert.equal((await rate({ clientId, rating: 3 })).status, 404);
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM profile_ratings").get().count, 2);
});

test("reports are deduplicated and visible only in the protected moderator queue", async (t) => {
  const moderatorToken = randomBytes(32).toString("hex");
  const { database, baseUrl } = await startTestServer(t, { moderatorToken });
  const { id } = createProfileService(database).submit(submission);
  const clientId = randomUUID();
  const report = (data) => sendFeedback(baseUrl, id, "report", data);
  assert.equal((await report({ clientId, reason: "breaks-website" })).status, 404);
  const moderation = createModerationService(database);
  moderation.decide(id, { action: "approve" });
  assert.equal((await report({ clientId, reason: "Free-text reason" })).status, 400);
  assert.deepEqual(await report({ clientId, reason: "breaks-website" }), { status: 200, body: { received: true } });
  assert.deepEqual(await report({ clientId, reason: "inappropriate" }), { status: 200, body: { received: true } });

  const queueUrl = baseUrl + "/moderation/reports";
  const denied = await fetch(queueUrl);
  assert.equal(denied.status, 401);
  await denied.json();
  const headers = { Authorization: "Bearer " + moderatorToken };
  const { reports } = await (await fetch(queueUrl, { headers })).json();
  assert.equal(reports.length, 1);
  const { id: reportId, reportedAt, ...details } = reports[0];
  assert.ok(Number.isInteger(reportId));
  assert.ok(Number.isFinite(Date.parse(reportedAt)));
  assert.deepEqual(details, {
    profileId: id, profileName: submission.name, origin, reason: "breaks-website",
  });

  moderation.decide(id, { action: "unpublish" });
  assert.deepEqual(await (await fetch(queueUrl, { headers })).json(), { reports: [] });
  assert.equal((await report({ clientId: randomUUID(), reason: "misleading" })).status, 404);
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM profile_reports").get().count, 1);
});

test("suggestion feedback stores a single vote per suggestion and client", async (t) => {
  const { database, baseUrl } = await startTestServer(t);
  const url = baseUrl + "/feedback/suggestions";
  const vote = { suggestionId: "increase-contrast", clientId: randomUUID(), helpful: true };
  async function send(data) {
    const response = await fetch(url, {
      method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(data),
    });
    return { status: response.status, body: await response.json() };
  }
  for (const invalid of [
    { ...vote, suggestionId: "unknown" },
    { ...vote, clientId: "bad ID" },
    { ...vote, helpful: "yes" },
    { ...vote, url: "https://example.com/" },
  ]) assert.equal((await send(invalid)).status, 400);

  assert.deepEqual(await send(vote), { status: 200, body: { helpful: true } });
  assert.deepEqual(await send({ ...vote, helpful: false }), { status: 200, body: { helpful: false } });
  assert.equal((await send({ ...vote, suggestionId: "minimum-control-size" })).status, 200);
  const rows = database.prepare("SELECT suggestion_id, helpful FROM suggestion_feedback ORDER BY suggestion_id").all();
  assert.deepEqual(rows.map((row) => [row.suggestion_id, row.helpful]), [
    ["increase-contrast", 0], ["minimum-control-size", 1],
  ]);
});

test("hosted runtime requires an HTTPS origin and an absolute storage directory", () => {
  const local = readRuntimeConfig({});
  assert.equal(local.host, "127.0.0.1");
  assert.equal(local.port, 8787);
  const env = { ACCESSMATE_PUBLIC_ORIGIN: "https://accessmate-api.example", ACCESSMATE_DATA_DIR: tmpdir(), PORT: "8080" };
  const hosted = readRuntimeConfig(env);
  assert.equal(hosted.host, "0.0.0.0");
  assert.equal(hosted.publicOrigin, env.ACCESSMATE_PUBLIC_ORIGIN);
  assert.equal(hosted.port, 8080);
  assert.equal(hosted.dataDirectory, tmpdir());
  assert.throws(() => readRuntimeConfig({ ...env, ACCESSMATE_PUBLIC_ORIGIN: "http://accessmate-api.example" }), /HTTPS/);
  assert.throws(() => readRuntimeConfig({ ...env, ACCESSMATE_PUBLIC_ORIGIN: env.ACCESSMATE_PUBLIC_ORIGIN + "/api" }), /HTTPS/);
  assert.throws(() => readRuntimeConfig({ ...env, ACCESSMATE_DATA_DIR: "data" }), /persistent volume/);
});

test("hosted API accepts its public host and restricts excess submissions", async (t) => {
  const publicOrigin = "https://accessmate-api.example";
  const { baseUrl } = await startTestServer(t, { publicOrigin, moderatorToken: randomBytes(32).toString("hex") });
  const health = await fetch(baseUrl + "/health");
  assert.equal(health.status, 200);
  await health.json();
  const wrongHost = await fetch(baseUrl + "/profiles?origin=" + encodeURIComponent(origin));
  assert.equal(wrongHost.status, 400);
  await wrongHost.json();

  const body = JSON.stringify({ suggestionId: "increase-contrast", clientId: randomUUID(), helpful: true });
  const headers = { Host: new URL(publicOrigin).host, "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) };
  function voteAtPublicHost() {
    return new Promise((resolve, reject) => {
      const outgoing = request(baseUrl + "/feedback/suggestions", { method: "PUT", headers }, (incoming) => {
        incoming.on("error", reject);
        incoming.on("end", () => resolve({ status: incoming.statusCode, retryAfter: incoming.headers["retry-after"] }));
        incoming.resume();
      });
      outgoing.on("error", reject);
      outgoing.end(body);
    });
  }
  const forwarded = await fetch(baseUrl + "/profiles?origin=" + encodeURIComponent(origin), {
    headers: { "X-Forwarded-Host": new URL(publicOrigin).host, "X-Forwarded-Proto": "https" },
  });
  assert.equal(forwarded.status, 200);
  await forwarded.json();
  for (let i = 0; i < 120; i++) {
    const response = await voteAtPublicHost();
    assert.equal(response.status, 200);
  }
  assert.deepEqual(await voteAtPublicHost(), { status: 429, retryAfter: "60" });
});
