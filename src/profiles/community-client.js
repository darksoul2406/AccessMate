import { COMMUNITY_LIST_LIMIT, requireCommunityOrigin, requireCommunitySubmission } from "../shared/community-profiles.js";
import { isCommunityId, isCommunityRating, isCommunityRatingSummary, isCommunityReportReason } from "../shared/community-feedback.js";
import { isSuggestionId, SUGGESTION_IDS } from "../analysis/recommendations.js";

const API_ORIGIN = typeof __ACCESSMATE_COMMUNITY_ORIGIN__ === "undefined"
  ? "http://127.0.0.1:8787" : __ACCESSMATE_COMMUNITY_ORIGIN__;
const permission = { origins: [API_ORIGIN + "/*"] };
const suggestionVoteKey = (id) => "accessmate:suggestion-vote:" + id;

export const COMMUNITY_MODERATOR_URL = API_ORIGIN + "/moderator";
export const COMMUNITY_UNAVAILABLE_MESSAGE = "Community Profiles is temporarily unavailable. Try again later.";
export class CommunityAccessDeclinedError extends Error {}

export function createCommunityClient({
  fetcher = globalThis.fetch,
  permissions = globalThis.chrome?.permissions,
  storage = globalThis.chrome?.storage?.local,
  locks = globalThis.navigator?.locks,
} = {}) {
  async function request(path, options) {
    let response;
    try {
      response = await fetcher(API_ORIGIN + path, {
        ...options,
        cache: "no-store",
        credentials: "omit",
        redirect: "error",
        signal: AbortSignal.timeout(5000),
      });
    } catch {
      throw new Error("Community Profiles request failed.");
    }
    if (!response.ok) throw new Error("Community Profiles request returned HTTP " + response.status + ".");
    try {
      return await response.json();
    } catch {
      throw new Error("Community Profiles returned an invalid response.");
    }
  }

  function send(path, method, body) {
    return request(path, {
      method,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  function getFeedbackId(scope) {
    const key = "accessmate:community-feedback:" + scope;
    // A separate ID for each profile or suggestion limits what can be linked.
    // The lock also keeps simultaneous first submissions on one ID.
    return locks.request(key, async () => {
      const existing = (await storage.get(key))[key];
      if (isCommunityId(existing)) return existing;
      const clientId = crypto.randomUUID();
      await storage.set({ [key]: clientId });
      return clientId;
    });
  }

  async function allowAccess() {
    // Chrome requires this permission request to start in the click handler.
    if (!await permissions.request(permission)) {
      throw new CommunityAccessDeclinedError("Access was declined. Allow access in Chrome to use Community Profiles.");
    }
  }

  return Object.freeze({
    async connect() {
      await allowAccess();
      if ((await request("/health"))?.ok !== true) throw new Error("Community Profiles returned an invalid health response.");
    },
    async browse(origin) {
      requireCommunityOrigin(origin);
      const data = await request("/profiles?origin=" + encodeURIComponent(origin));
      if (!Array.isArray(data?.profiles) || data.profiles.length > COMMUNITY_LIST_LIMIT) {
        throw new Error("Community Profiles returned an invalid profile list.");
      }
      const ids = new Set();
      return data.profiles.map((profile) => {
        if (!isCommunityId(profile?.id) || ids.has(profile.id) || profile.origin !== origin) {
          throw new Error("Community Profiles returned an invalid profile.");
        }
        const { name, settings } = requireCommunitySubmission({ origin, name: profile.name, settings: profile.settings });
        const { ratingCount, averageRating } = profile;
        const oldBackend = ratingCount === undefined && averageRating === undefined;
        if (!oldBackend && !isCommunityRatingSummary(ratingCount, averageRating)) {
          throw new Error("Community Profiles returned an invalid rating summary.");
        }
        ids.add(profile.id);
        return { id: profile.id, origin, name, settings, ratingCount: ratingCount ?? null, averageRating: averageRating ?? null };
      });
    },
    async submit(submission) {
      const body = requireCommunitySubmission(submission);
      const data = await send("/profiles", "POST", body);
      if (!isCommunityId(data?.id) || data.status !== "pending") {
        throw new Error("The submission result could not be confirmed.");
      }
      return data.id;
    },
    async rate(profileId, rating) {
      if (!isCommunityId(profileId)) throw new Error("Choose a valid community profile.");
      if (!isCommunityRating(rating)) throw new Error("Choose a whole-number rating from 1 to 5.");
      const clientId = await getFeedbackId(profileId);
      const data = await send("/profiles/" + profileId + "/rating", "PUT", { clientId, rating });
      if (data?.rating !== rating) throw new Error("The rating result could not be confirmed.");
    },
    async report(profileId, reason) {
      if (!isCommunityId(profileId)) throw new Error("Choose a valid community profile.");
      if (!isCommunityReportReason(reason)) throw new Error("Choose a supported report reason.");
      const clientId = await getFeedbackId(profileId);
      const data = await send("/profiles/" + profileId + "/report", "POST", { clientId, reason });
      if (data?.received !== true) throw new Error("The report result could not be confirmed.");
    },
    async loadSuggestionVotes() {
      const ids = Object.values(SUGGESTION_IDS);
      const records = await storage.get(ids.map(suggestionVoteKey));
      const votes = {};
      for (const id of ids) {
        const vote = records[suggestionVoteKey(id)];
        if (typeof vote === "boolean") votes[id] = vote;
      }
      return votes;
    },
    async rateSuggestion(suggestionId, helpful) {
      if (!isSuggestionId(suggestionId) || typeof helpful !== "boolean") throw new Error("Choose a valid suggestion vote.");
      // Start the permission request during the click and save the local vote
      // even when permission is declined or the sharing service is offline.
      const canShare = allowAccess().then(() => true, () => false);
      const key = suggestionVoteKey(suggestionId);
      return locks.request(key, async () => {
        await storage.set({ [key]: helpful });
        if (!await canShare) return { shared: false };
        try {
          const clientId = await getFeedbackId("suggestion:" + suggestionId);
          const data = await send("/feedback/suggestions", "PUT", { suggestionId, clientId, helpful });
          return { shared: data?.helpful === helpful };
        } catch {
          return { shared: false };
        }
      });
    },
  });
}
