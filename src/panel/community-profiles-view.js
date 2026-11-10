import { COMMUNITY_NAME_LIMIT, pickCommunitySettings, requireCommunitySubmission } from "../shared/community-profiles.js";
import { COMMUNITY_RATINGS, COMMUNITY_REPORT_REASONS, isCommunityRating, isCommunityReportReason } from "../shared/community-feedback.js";
import { COMMUNITY_UNAVAILABLE_MESSAGE, CommunityAccessDeclinedError } from "../profiles/community-client.js";

function describeSetting(key, value) {
  const label = key.replace(/[A-Z]/g, (letter) => " " + letter.toLowerCase());
  const unit = ["textScale", "zoom"].includes(key) ? "%" :
    ["lineHeight", "speechRate"].includes(key) ? "×" : key === "targetSize" ? " px" : key === "letterSpacing" ? " em" : "";
  const display = value === null ? "Original" : typeof value === "boolean" ? value ? "On" : "Off" : String(value) + unit;
  return label[0].toUpperCase() + label.slice(1) + " — " + display;
}

export function createCommunityProfilesView({ client, preview, applyProfile }, page = document) {
  function element(tag, text) {
    const node = page.createElement(tag);
    if (text) node.textContent = text;
    return node;
  }
  function button(id, text) {
    const node = element("button", text);
    node.id = id;
    node.type = "button";
    return node;
  }
  function label(text, control) {
    const node = element("label", text);
    node.htmlFor = control.id;
    return node;
  }
  function showSettings(list, settings) {
    list.replaceChildren(...Object.values(settings).flatMap((group) =>
      Object.entries(group).map(([key, value]) => element("li", describeSetting(key, value)))));
  }

  const group = element("fieldset");
  group.id = "community-profiles";
  const note = element("p", "Share your settings for this website or browse profiles approved for it.");
  const connect = button("community-connect", "Connect to Community Profiles");
  const browse = button("community-browse", "Browse approved profiles");
  const actions = element("div");
  actions.className = "button-group";
  actions.append(connect, browse);
  const status = element("p");
  status.id = "community-status";
  status.setAttribute("role", "status");
  status.setAttribute("aria-atomic", "true");
  group.setAttribute("aria-describedby", status.id);

  const results = element("div");
  const picker = element("select");
  picker.id = "community-approved-profile";
  const importedSettings = element("ul");
  const use = button("community-preview", "Preview profile");
  const apply = button("community-apply", "Apply to this website");
  const profileActions = element("div");
  profileActions.className = "button-group";
  profileActions.append(use, apply);
  const ratingSummary = element("p");
  ratingSummary.id = "community-rating-summary";
  ratingSummary.className = "feature-note";
  ratingSummary.setAttribute("aria-live", "polite");
  const feedback = element("fieldset");
  const rating = element("select");
  rating.id = "community-rating";
  rating.add(new page.defaultView.Option("Choose a rating", ""));
  for (const value of COMMUNITY_RATINGS) rating.add(new page.defaultView.Option(value + " out of 5", String(value)));
  const rate = button("community-rate", "Save rating");
  const reason = element("select");
  reason.id = "community-report-reason";
  reason.add(new page.defaultView.Option("Choose a report reason", ""));
  for (const [value, text] of Object.entries(COMMUNITY_REPORT_REASONS)) {
    reason.add(new page.defaultView.Option(text, value));
  }
  const report = button("community-report", "Send report");
  feedback.append(element("legend", "Profile feedback"), label("Your rating", rating), rating, rate,
    label("Report reason", reason), reason, report);
  results.append(label("Approved profiles for this website", picker), picker, importedSettings, profileActions, ratingSummary, feedback);

  const name = element("input");
  name.id = "community-profile-name";
  name.type = "text";
  name.maxLength = COMMUNITY_NAME_LIMIT;
  name.autocomplete = "off";
  const review = button("community-review", "Review settings to share");
  const reviewBox = element("div");
  const reviewSummary = element("p");
  const reviewedSettings = element("ul");
  const submit = button("community-submit", "Submit for review");
  reviewBox.append(reviewSummary, reviewedSettings, submit);
  group.append(element("legend", "Community profiles"), note, actions, status, results,
    label("Name for your shared profile", name), name, review, reviewBox);

  let context = null;
  let settings = {};
  let reviewed = null;
  let profiles = [];
  let connected = false;
  let busy = false;
  let version = 0;
  const selected = () => profiles.find((profile) => profile.id === picker.value);

  function render() {
    const profile = selected();
    const canGiveFeedback = connected && !busy && Number.isSafeInteger(profile?.ratingCount);
    group.disabled = !context || context.saving;
    connect.disabled = busy;
    connect.textContent = connected ? "Reconnect" : "Connect to Community Profiles";
    browse.disabled = !connected || busy;
    name.disabled = !connected || busy;
    review.disabled = !connected || busy || !Object.keys(settings).length;
    reviewBox.hidden = !reviewed;
    submit.disabled = !reviewed || !connected || busy;
    results.hidden = !profiles.length;
    picker.disabled = busy;
    use.disabled = busy || !profile;
    apply.disabled = use.disabled;
    feedback.hidden = !Number.isSafeInteger(profile?.ratingCount);
    feedback.disabled = !canGiveFeedback;
    rate.disabled = !isCommunityRating(Number(rating.value));
    report.disabled = !isCommunityReportReason(reason.value);
  }

  async function run(message, operation, done) {
    if (!context || context.saving || busy) return;
    const current = version;
    busy = true;
    status.textContent = message;
    render();
    try {
      const result = await operation();
      if (current === version) done(result);
    } catch (error) {
      if (current === version) {
        status.textContent = error instanceof CommunityAccessDeclinedError ? error.message : COMMUNITY_UNAVAILABLE_MESSAGE;
      }
    } finally {
      if (current === version) {
        busy = false;
        render();
      }
    }
  }

  function showSelected() {
    const profile = selected();
    showSettings(importedSettings, profile?.settings ?? {});
    rating.value = "";
    reason.value = "";
    if (!profile) ratingSummary.textContent = "";
    else if (profile.ratingCount === null) ratingSummary.textContent = "Ratings and reports are temporarily unavailable.";
    else if (profile.ratingCount === 0) ratingSummary.textContent = "No ratings yet.";
    else {
      const count = profile.ratingCount;
      ratingSummary.textContent = profile.averageRating.toFixed(1) + " out of 5 from " + count + (count === 1 ? " rating." : " ratings.");
    }
    render();
  }

  function showProfiles(found, preferredId = picker.value) {
    profiles = found;
    picker.replaceChildren(...profiles.map((profile) => new page.defaultView.Option(profile.name, profile.id)));
    if (profiles.some((profile) => profile.id === preferredId)) picker.value = preferredId;
    showSelected();
  }

  connect.addEventListener("click", () => {
    if (!context || context.saving || busy) return;
    connected = false;
    void run("Connecting to Community Profiles…", client.connect, () => {
      connected = true;
      status.textContent = Object.keys(settings).length
        ? "Connected. Browse approved profiles or review your website settings to share."
        : "Connected. Browse profiles or change a website preference to share one.";
    });
  });
  browse.addEventListener("click", () => {
    if (!connected || !context || busy) return;
    const { origin } = context;
    void run("Finding approved profiles…", () => client.browse(origin), (found) => {
      showProfiles(found);
      status.textContent = profiles.length ? "Preview a profile or apply it to this website." : "No approved profiles for this website yet.";
    });
  });
  picker.addEventListener("change", showSelected);
  rating.addEventListener("change", render);
  reason.addEventListener("change", render);
  rate.addEventListener("click", () => {
    const profile = selected();
    const value = Number(rating.value);
    if (!connected || profile?.origin !== context?.origin || !Number.isSafeInteger(profile?.ratingCount) ||
      !isCommunityRating(value)) return;
    const current = version;
    void run("Saving your rating…", async () => {
      await client.rate(profile.id, value);
      return current === version ? client.browse(profile.origin).catch(() => null) : null;
    }, (found) => {
      rating.value = "";
      if (found) showProfiles(found, profile.id);
      status.textContent = found ? "Rating saved." : "Rating saved. Browse again to refresh the rating summary.";
    });
  });
  report.addEventListener("click", () => {
    const profile = selected();
    const value = reason.value;
    if (!connected || profile?.origin !== context?.origin || !Number.isSafeInteger(profile?.ratingCount) ||
      !isCommunityReportReason(value)) return;
    void run("Sending the report…", () => client.report(profile.id, value), () => {
      reason.value = "";
      status.textContent = "Report received for moderation.";
    });
  });
  use.addEventListener("click", () => {
    const profile = selected();
    if (!profile || busy || profile.origin !== context?.origin) return;
    status.textContent = preview(profile)
      ? "Preview added. Click Apply to this website to keep these settings."
      : "The website draft is unavailable. Select This website only and try again.";
  });
  apply.addEventListener("click", () => {
    const profile = selected();
    if (!profile || profile.origin !== context?.origin) return;
    void run("Applying profile…", () => applyProfile(profile), (message) => {
      status.textContent = message;
    });
  });
  name.addEventListener("input", () => {
    if (!reviewed) return;
    reviewed = null;
    status.textContent = "Review the updated name before submitting.";
    render();
  });
  review.addEventListener("click", () => {
    if (!connected || !context || context.saving || busy) return;
    try {
      reviewed = requireCommunitySubmission({ origin: context.origin, name: name.value, settings });
      reviewSummary.textContent = reviewed.name + " for " + reviewed.origin;
      showSettings(reviewedSettings, reviewed.settings);
      status.textContent = "Review the name, website, and settings below before submitting.";
    } catch (error) {
      reviewed = null;
      status.textContent = error.message;
    }
    render();
  });
  submit.addEventListener("click", () => {
    if (!connected || !reviewed) return;
    const submission = reviewed;
    void run("Submitting the reviewed profile…", () => client.submit(submission), (id) => {
      reviewed = null;
      status.textContent = "Submitted for moderation. Profile ID " + id + ".";
    });
  });

  function setContext(next) {
    const updated = next ? pickCommunitySettings(next.overrides) : {};
    if (context?.origin !== next?.origin) {
      version++;
      busy = false;
      profiles = [];
      picker.replaceChildren();
      importedSettings.replaceChildren();
      ratingSummary.textContent = "";
      rating.value = "";
      reason.value = "";
      name.value = "";
      reviewed = null;
      status.textContent = next ? "Ready for " + next.origin + "." : "Choose This website only to use community profiles.";
    } else if (reviewed && JSON.stringify(settings) !== JSON.stringify(updated)) {
      reviewed = null;
      status.textContent = "Website settings changed. Review them again before submitting.";
    }
    context = next;
    settings = updated;
    render();
  }

  status.textContent = "Choose This website only to use community profiles.";
  render();
  return Object.freeze({ element: group, setContext });
}
