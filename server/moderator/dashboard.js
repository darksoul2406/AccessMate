const signIn = document.getElementById("sign-in");
const key = document.getElementById("moderator-key");
const dashboard = document.getElementById("dashboard");
const status = document.getElementById("status");
const pending = document.getElementById("pending");
const reports = document.getElementById("reports");
const refresh = document.getElementById("refresh");
const signOut = document.getElementById("sign-out");

const sessionPath = "/moderation/session";
const profilePath = "/moderation/profiles";
const reportPath = "/moderation/reports";
const dateFormat = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" });
const decisionMessages = {
  approve: "Profile approved and published.",
  reject: "Profile rejected.",
  unpublish: "Profile unpublished.",
};

async function api(path, method = "GET", body) {
  const response = await fetch(path, {
    method,
    credentials: "same-origin",
    headers: body === undefined ? undefined : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await response.json();
  if (!response.ok) {
    const error = new Error(data.error);
    error.status = response.status;
    throw error;
  }
  return data;
}

function element(tag, text) {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  return node;
}

function label(value) {
  const words = value.replace(/([a-z])([A-Z])/g, "$1 $2").replace(/[-_]/g, " ");
  return words.charAt(0).toUpperCase() + words.slice(1);
}

function settingsDetails(settings) {
  const details = element("details");
  details.append(element("summary", "View submitted settings"));
  for (const [group, preferences] of Object.entries(settings)) {
    const list = element("dl");
    for (const [name, value] of Object.entries(preferences)) {
      let description = typeof value === "boolean" ? (value ? "On" : "Off") : String(value);
      if (name === "textScale" || name === "pageZoom") description += "%";
      list.append(element("dt", label(name)), element("dd", description));
    }
    details.append(element("h4", label(group)), list);
  }
  return details;
}

function actionButton(text, id, action, heading) {
  const button = element("button", text);
  button.type = "button";
  if (action === "approve") button.className = "primary";
  button.addEventListener("click", () => run(async () => {
    const result = await api(profilePath + "/" + encodeURIComponent(id) + "/decision", "POST", { action });
    // Refresh both queues so a decision also removes any reports for that profile.
    try {
      await loadQueues();
      status.textContent = decisionMessages[result.action];
    } catch (error) {
      pending.replaceChildren();
      reports.replaceChildren();
      if (error.status === 401) showSignIn();
      status.textContent = decisionMessages[result.action] +
        (dashboard.hidden ? " Sign in to continue." : " Refresh the queue to see the latest profiles.");
    }
    if (!dashboard.hidden) document.getElementById(heading).focus();
  }));
  return button;
}

function renderPending(profiles) {
  if (!profiles.length) return [element("p", "No profiles are waiting for review.")];
  return profiles.map((profile) => {
    const card = element("article");
    const actions = element("div");
    actions.className = "actions";
    actions.append(
      actionButton("Approve", profile.id, "approve", "pending-heading"),
      actionButton("Reject", profile.id, "reject", "pending-heading"),
    );
    card.append(
      element("h3", profile.name),
      element("p", profile.origin),
      element("p", "Submitted " + dateFormat.format(new Date(profile.createdAt))),
      settingsDetails(profile.settings),
      actions,
    );
    return card;
  });
}

function renderReports(items) {
  if (!items.length) return [element("p", "No reports for published profiles.")];
  return items.map((report) => {
    const card = element("article");
    card.append(
      element("h3", report.profileName),
      element("p", report.origin),
      element("p", "Reason: " + label(report.reason)),
      element("p", "Reported " + dateFormat.format(new Date(report.reportedAt))),
      actionButton("Unpublish profile", report.profileId, "unpublish", "reports-heading"),
    );
    return card;
  });
}

async function loadQueues() {
  const [{ profiles }, { reports: items }] = await Promise.all([api(profilePath), api(reportPath)]);
  pending.replaceChildren(...renderPending(profiles));
  reports.replaceChildren(...renderReports(items));
  key.value = "";
  signIn.hidden = true;
  dashboard.hidden = false;
}

function showSignIn() {
  dashboard.hidden = true;
  pending.replaceChildren();
  reports.replaceChildren();
  key.value = "";
  signIn.hidden = false;
  key.focus();
}

let busy = false;
async function run(task, failureMessage) {
  if (busy) return;
  busy = true;
  dashboard.setAttribute("aria-busy", "true");
  const buttons = document.querySelectorAll("button");
  for (const button of buttons) button.disabled = true;
  status.textContent = "Working…";
  try {
    await task();
  } catch (error) {
    if (error.status === 401 || dashboard.hidden) showSignIn();
    status.textContent = failureMessage ?? (error.status ? error.message : "Could not reach AccessMate. Try again.");
  } finally {
    busy = false;
    dashboard.removeAttribute("aria-busy");
    for (const button of buttons) button.disabled = false;
  }
}

signIn.addEventListener("submit", (event) => {
  event.preventDefault();
  run(async () => {
    const token = key.value.trim();
    key.value = "";
    await api(sessionPath, "POST", { token });
    await loadQueues();
    status.textContent = "Signed in.";
    document.getElementById("pending-heading").focus();
  });
});

refresh.addEventListener("click", () => run(async () => {
  await loadQueues();
  status.textContent = "Queue refreshed.";
}));

signOut.addEventListener("click", () => run(async () => {
  await api(sessionPath, "DELETE");
  showSignIn();
  status.textContent = "Signed out.";
}, "Could not sign out. Try again."));

try {
  await loadQueues();
} catch (error) {
  showSignIn();
  if (error.status !== 401) status.textContent = error.status ? error.message : "Could not reach AccessMate. Try again.";
}
