import "./shoelace-base.js";
import "@shoelace-style/shoelace/dist/themes/light.css";
import "@shoelace-style/shoelace/dist/components/alert/alert.js";
import "@shoelace-style/shoelace/dist/components/badge/badge.js";
import "@shoelace-style/shoelace/dist/components/button/button.js";
import "@shoelace-style/shoelace/dist/components/card/card.js";
import "@shoelace-style/shoelace/dist/components/checkbox/checkbox.js";
import "@shoelace-style/shoelace/dist/components/dialog/dialog.js";
import "@shoelace-style/shoelace/dist/components/icon-button/icon-button.js";
import "@shoelace-style/shoelace/dist/components/input/input.js";
import "@shoelace-style/shoelace/dist/components/switch/switch.js";
import "@shoelace-style/shoelace/dist/components/tab/tab.js";
import "@shoelace-style/shoelace/dist/components/tab-group/tab-group.js";
import "@shoelace-style/shoelace/dist/components/tab-panel/tab-panel.js";
import "@shoelace-style/shoelace/dist/components/tooltip/tooltip.js";
import "./app.css";

const REFRESH_MS = 10000;
const $ = (selector, root = document) => root.querySelector(selector);
const named = (form, name) => form.querySelector(`[name="${name}"]`);

let profiles = [];
let refreshTimer;
let setupMode = false;
let confirmResolve;

async function api(method, url, body) {
  const response = await fetch(url, {
    method,
    headers: body === undefined ? {} : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await response.json().catch(() => ({}));
  if (response.status === 401 && url !== "/api/login") {
    showLogin();
  }
  if (!response.ok) {
    throw new Error(data.error || `Request failed (${response.status})`);
  }
  return data;
}

function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (key === "class") node.className = value;
    else if (key.startsWith("on")) node.addEventListener(key.slice(2), value);
    else if (typeof value === "boolean") node[key] = value;
    else if (value != null) node.setAttribute(key, value);
  }
  for (const child of children.flat()) {
    if (child != null) node.append(child instanceof Node ? child : String(child));
  }
  return node;
}

function formatDate(iso) {
  if (!iso) return "";
  const [year, month, day] = iso.split("-");
  return `${month}/${day}/${year}`;
}

function formatTimestamp(iso) {
  return iso ? new Date(iso).toLocaleString() : "";
}

function relativeTime(iso) {
  if (!iso) return "never";
  const minutes = Math.round((Date.now() - new Date(iso)) / 60000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  if (minutes < 60 * 24) return `${Math.round(minutes / 60)}h ago`;
  return `${Math.round(minutes / 60 / 24)}d ago`;
}

function dateWindow(profile) {
  if (!profile.minDate && !profile.maxDate) return "before booked";
  return `${formatDate(profile.minDate) || "…"} – ${formatDate(profile.maxDate) || "booked"}`;
}

function badge(text, kind) {
  const variant =
    { ok: "success", bad: "danger", warn: "warning", info: "primary", muted: "neutral" }[kind] ||
    "neutral";
  return el("sl-badge", { variant, pill: true }, text);
}

function setError(form, message) {
  const alert = $("[data-error]", form);
  if (!alert) return;
  alert.innerHTML = message || "";
  alert.open = !!message;
}

function toast(message, variant = "danger") {
  const node = el("sl-alert", { variant, closable: true, duration: 4000 }, message);
  document.body.append(node);
  node.toast();
}

function confirmAction(message, { okLabel = "Continue", variant = "primary" } = {}) {
  const dialog = $("#confirm-dialog");
  $("[data-message]", dialog).textContent = message;
  const yes = $("[data-confirm-yes]", dialog);
  yes.textContent = okLabel;
  yes.variant = variant;
  dialog.show();
  return new Promise((resolve) => {
    confirmResolve = resolve;
  });
}

function settleConfirm(result) {
  if (!confirmResolve) return;
  const resolve = confirmResolve;
  confirmResolve = undefined;
  $("#confirm-dialog").hide();
  resolve(result);
}

function setBanner(id, visible) {
  const banner = $(id);
  banner.hidden = !visible;
  banner.open = !!visible;
}

// ---- Session ----

async function boot() {
  const session = await api("GET", "/api/session");
  if (session.authenticated) {
    showApp(session.dev);
  } else {
    showLogin(session.setupRequired);
  }
}

function showLogin(setupRequired) {
  clearInterval(refreshTimer);
  $("#app-view").hidden = true;
  $("#login-view").hidden = false;
  setupMode = !!setupRequired;
  $("#setup-hint").hidden = !setupMode;
  $("#confirm-row").hidden = !setupMode;
  $("#login-submit").textContent = setupMode ? "Create password" : "Sign in";
  const form = $("#login-form");
  named(form, "password").autocomplete = setupMode ? "new-password" : "current-password";
  named(form, "confirm").required = setupMode;
}

function showApp(dev) {
  $("#login-view").hidden = true;
  $("#app-view").hidden = false;
  setBanner("#dev-banner", !!dev);
  refresh();
  clearInterval(refreshTimer);
  refreshTimer = setInterval(refresh, REFRESH_MS);
}

$("#login-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.target;
  setError(form);
  try {
    if (setupMode) {
      if (named(form, "password").value !== named(form, "confirm").value) {
        throw new Error("Passwords do not match");
      }
      await api("POST", "/api/setup", { password: named(form, "password").value });
    } else {
      await api("POST", "/api/login", { password: named(form, "password").value });
    }
    form.reset();
    showApp();
  } catch (error) {
    setError(form, error.message);
  }
});

$("#logout").addEventListener("click", async () => {
  await api("POST", "/api/logout", {});
  showLogin(false);
});

$("[data-confirm-yes]").addEventListener("click", () => settleConfirm(true));
$("[data-confirm-no]").addEventListener("click", () => settleConfirm(false));
$("#confirm-dialog").addEventListener("sl-request-close", () => settleConfirm(false));

// ---- Profiles table ----

async function refresh() {
  try {
    const [profileList, settings] = await Promise.all([
      api("GET", "/api/profiles"),
      api("GET", "/api/settings"),
    ]);
    profiles = profileList;
    setBanner("#settings-warning", !(settings.gmailUser && settings.hasGmailAppPassword));
    renderProfiles();
  } catch (error) {
    console.error(error);
  }
}

function runBadge(profile) {
  if (profile.state === "running") return badge("running", "info");
  if (profile.state === "queued") return badge("queued", "info");
  const run = profile.lastRun;
  if (!run) return badge("never run", "muted");
  const kind = run.status === "success" ? "ok" : run.status === "cancelled" ? "muted" : "bad";
  return badge(run.status, kind);
}

function enableSwitch(profile) {
  const toggle = document.createElement("sl-switch");
  toggle.size = "small";
  toggle.checked = !!profile.enabled;
  toggle.title = profile.enabled ? "Disable" : "Enable";
  toggle.setAttribute(
    "aria-label",
    profile.enabled ? "Disable profile" : "Enable profile",
  );
  toggle.addEventListener("sl-change", (event) => {
    toggleEnabled(profile, event.target.checked);
  });
  return toggle;
}

function renderProfiles() {
  const tbody = $("#profile-rows");
  tbody.replaceChildren(
    ...profiles.map((profile) => {
      const busy = profile.state !== "idle";

      return el(
        "tr",
        { class: profile.enabled ? "" : "disabled" },
        el("td", { class: "col-enabled" }, enableSwitch(profile)),
        el("td", {}, el("strong", {}, profile.name), el("div", { class: "sub" }, profile.visaEmail)),
        el("td", { class: "mono nowrap" }, profile.visaProcessId),
        el("td", { class: "nowrap" }, dateWindow(profile)),
        el(
          "td",
          {},
          profile.actions.length
            ? profile.actions.map((action) =>
                badge(action, action === "reschedule" ? "warn" : "muted"),
              )
            : badge("none", "muted"),
        ),
        el("td", { class: "nowrap" }, runBadge(profile)),
        el(
          "td",
          { class: "nowrap hint", title: formatTimestamp(profile.lastRun?.startedAt) },
          relativeTime(profile.lastRun?.startedAt),
        ),
        el(
          "td",
          { class: "message" },
          profile.lastLog
            ? el("div", { class: "clamp", title: profile.lastLog.message }, profile.lastLog.message.split("\n")[0])
            : el("span", { class: "sub" }, "—"),
        ),
        el(
          "td",
          {},
          el(
            "div",
            { class: "row-actions" },
            busy
              ? el("sl-button", { size: "small", variant: "danger", onclick: () => cancelRun(profile) }, "Stop")
              : el("sl-button", { size: "small", onclick: () => runNow(profile) }, "Run now"),
            el("sl-button", { size: "small", onclick: () => openLogs(profile) }, "Logs"),
            el("sl-button", { size: "small", onclick: () => openProfile(profile) }, "Edit"),
          ),
        ),
      );
    }),
  );
  $("#empty-state").hidden = profiles.length > 0;
}

async function toggleEnabled(profile, enabled) {
  try {
    await api("POST", `/api/profiles/${profile.id}/enabled`, { enabled });
  } catch (error) {
    toast(error.message);
  }
  refresh();
}

async function runNow(profile) {
  try {
    await api("POST", `/api/profiles/${profile.id}/run`, {});
  } catch (error) {
    toast(error.message);
  }
  refresh();
}

async function cancelRun(profile) {
  await api("POST", `/api/profiles/${profile.id}/cancel`, {});
  refresh();
}

function actionCheckboxes(form) {
  return [...form.querySelectorAll("sl-checkbox[name=action]")];
}

// ---- Profile dialog ----

const profileDialog = $("#profile-dialog");
const profileForm = $("#profile-form");
let editingProfile = null;

function openProfile(profile) {
  editingProfile = profile || null;
  profileForm.reset();
  setError(profileForm);
  profileDialog.label = profile ? `Edit ${profile.name}` : "New profile";
  $("[data-delete]").hidden = !profile;

  const values = profile || {
    actions: ["notify"],
    enabled: true,
  };
  for (const field of ["name", "visaProcessId", "visaEmail", "emailDestination", "minDate", "maxDate"]) {
    named(profileForm, field).value = values[field] ?? "";
  }
  for (const checkbox of actionCheckboxes(profileForm)) {
    checkbox.checked = values.actions.includes(checkbox.value);
  }
  named(profileForm, "enabled").checked = !!values.enabled;

  const password = named(profileForm, "visaPassword");
  password.required = !profile;
  password.placeholder = profile ? "Leave empty to keep the stored password" : "";

  profileDialog.show();
}

$("#new-profile").addEventListener("click", () => openProfile(null));

profileForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  setError(profileForm);
  const form = profileForm;
  const actions = actionCheckboxes(form)
    .filter((checkbox) => checkbox.checked)
    .map((checkbox) => checkbox.value);

  if (
    actions.includes("reschedule") &&
    !(editingProfile?.actions || []).includes("reschedule") &&
    !(await confirmAction(
      "Automatic rescheduling will book the first matching date without asking. Continue?",
      { okLabel: "Enable reschedule", variant: "warning" },
    ))
  ) {
    return;
  }

  const body = {
    name: named(form, "name").value,
    visaProcessId: named(form, "visaProcessId").value,
    visaEmail: named(form, "visaEmail").value,
    visaPassword: named(form, "visaPassword").value || undefined,
    emailDestination: named(form, "emailDestination").value,
    minDate: named(form, "minDate").value || null,
    maxDate: named(form, "maxDate").value || null,
    actions,
    enabled: named(form, "enabled").checked,
  };

  try {
    if (editingProfile) {
      await api("PUT", `/api/profiles/${editingProfile.id}`, body);
    } else {
      await api("POST", "/api/profiles", body);
    }
    profileDialog.hide();
    refresh();
  } catch (error) {
    setError(profileForm, error.message);
  }
});

$("[data-delete]").addEventListener("click", async () => {
  if (
    !editingProfile ||
    !(await confirmAction(`Delete profile "${editingProfile.name}"? Its stored password will be removed.`, {
      okLabel: "Delete",
      variant: "danger",
    }))
  ) {
    return;
  }
  try {
    await api("DELETE", `/api/profiles/${editingProfile.id}`, {});
    profileDialog.hide();
    refresh();
  } catch (error) {
    setError(profileForm, error.message);
  }
});

// ---- Settings dialog ----

const settingsDialog = $("#settings-dialog");
const settingsForm = $("#settings-form");

$("#open-settings").addEventListener("click", async () => {
  settingsForm.reset();
  setError(settingsForm);
  const settings = await api("GET", "/api/settings");
  for (const field of [
    "gmailUser",
    "emailAdminDestination",
    "intervalMinutes",
    "heartbeatMinutes",
    "maxConcurrentRuns",
    "runTimeoutMinutes",
  ]) {
    named(settingsForm, field).value = settings[field] ?? "";
  }
  named(settingsForm, "gmailAppPassword").placeholder = settings.hasGmailAppPassword
    ? "Leave empty to keep the stored password"
    : "Not set";
  named(settingsForm, "heartbeatEnabled").checked = !!settings.heartbeatEnabled;
  $("#last-heartbeat").textContent = lastHeartbeatLabel(settings.lastHeartbeatAt);
  settingsDialog.show();
});

function lastHeartbeatLabel(iso) {
  if (!iso) return "Last sent: never";
  return `Last sent: ${formatTimestamp(iso)} (${relativeTime(iso)})`;
}

$("#send-heartbeat").addEventListener("click", async () => {
  const button = $("#send-heartbeat");
  setError(settingsForm);
  button.loading = true;
  try {
    const result = await api("POST", "/api/heartbeat", {});
    $("#last-heartbeat").textContent = lastHeartbeatLabel(result.lastHeartbeatAt);
    toast("Heartbeat sent", "success");
  } catch (error) {
    setError(settingsForm, error.message);
  } finally {
    button.loading = false;
  }
});

settingsForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = settingsForm;
  setError(form);
  try {
    await api("PUT", "/api/settings", {
      gmailUser: named(form, "gmailUser").value,
      gmailAppPassword: named(form, "gmailAppPassword").value || undefined,
      emailAdminDestination: named(form, "emailAdminDestination").value,
      intervalMinutes: Number(named(form, "intervalMinutes").value),
      heartbeatEnabled: named(form, "heartbeatEnabled").checked,
      heartbeatMinutes: Number(named(form, "heartbeatMinutes").value),
      maxConcurrentRuns: Number(named(form, "maxConcurrentRuns").value),
      runTimeoutMinutes: Number(named(form, "runTimeoutMinutes").value),
    });
    settingsDialog.hide();
    refresh();
  } catch (error) {
    setError(form, error.message);
  }
});

// ---- Logs dialog ----

const logsDialog = $("#logs-dialog");

async function openLogs(profile) {
  logsDialog.label = `Logs — ${profile.name}`;
  $("[data-output]", logsDialog).hidden = true;
  $("sl-tab-group", logsDialog).show("messages");
  logsDialog.show();

  const [messages, runs] = await Promise.all([
    api("GET", `/api/profiles/${profile.id}/logs?limit=300`),
    api("GET", `/api/profiles/${profile.id}/runs?limit=100`),
  ]);

  $("[data-messages]", logsDialog).replaceChildren(
    ...messages.map((log) =>
      el("tr", {}, el("td", { class: "mono nowrap" }, log.timestamp), el("td", {}, log.message)),
    ),
  );
  if (!messages.length) {
    $("[data-messages]", logsDialog).append(el("tr", {}, el("td", { class: "sub" }, "No messages yet")));
  }

  $("[data-runs]", logsDialog).replaceChildren(
    ...runs.map((run) =>
      el(
        "tr",
        { class: "clickable", onclick: () => showRunOutput(run.id) },
        el("td", { class: "mono nowrap" }, formatTimestamp(run.startedAt)),
        el("td", {}, badge(run.status, run.status === "success" ? "ok" : run.status === "running" ? "info" : "bad")),
        el("td", { class: "sub" }, run.trigger),
        el(
          "td",
          { class: "sub" },
          run.finishedAt ? `${Math.round((new Date(run.finishedAt) - new Date(run.startedAt)) / 1000)}s` : "",
        ),
      ),
    ),
  );
  if (!runs.length) {
    $("[data-runs]", logsDialog).append(el("tr", {}, el("td", { class: "sub" }, "No runs yet")));
  }
}

async function showRunOutput(runId) {
  const run = await api("GET", `/api/runs/${runId}`);
  const output = $("[data-output]", logsDialog);
  output.textContent = run.output || "(no output)";
  output.hidden = false;
  $("sl-tab-group", logsDialog).show("runs");
  output.scrollIntoView({ block: "nearest" });
}

for (const button of document.querySelectorAll("[data-close]")) {
  button.addEventListener("click", () => button.closest("sl-dialog").hide());
}

boot();
