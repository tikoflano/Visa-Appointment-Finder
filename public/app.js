import "@shoelace-style/shoelace/dist/themes/light.css";
import "@shoelace-style/shoelace/dist/components/switch/switch.js";
import "./app.css";

const REFRESH_MS = 10000;
const $ = (selector, root = document) => root.querySelector(selector);

let profiles = [];
let refreshTimer;
let setupMode = false;

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
    else if (value === true) node.setAttribute(key, "");
    else if (value !== false && value != null) node.setAttribute(key, value);
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

function badge(text, kind) {
  return el("span", { class: `badge ${kind}` }, text);
}

function setError(form, message) {
  $("[data-error]", form).textContent = message || "";
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
  const password = $("#login-form").password;
  const confirm = $("#login-form").confirm;
  password.autocomplete = setupMode ? "new-password" : "current-password";
  confirm.required = setupMode;
}

function showApp(dev) {
  $("#login-view").hidden = true;
  $("#app-view").hidden = false;
  $("#dev-banner").hidden = !dev;
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
      if (form.password.value !== form.confirm.value) {
        throw new Error("Passwords do not match");
      }
      await api("POST", "/api/setup", { password: form.password.value });
    } else {
      await api("POST", "/api/login", { password: form.password.value });
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

// ---- Profiles table ----

async function refresh() {
  try {
    const [profileList, settings] = await Promise.all([
      api("GET", "/api/profiles"),
      api("GET", "/api/settings"),
    ]);
    profiles = profileList;
    $("#settings-warning").hidden = !!(settings.gmailUser && settings.hasGmailAppPassword);
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
      const window =
        profile.minDate || profile.maxDate
          ? `${formatDate(profile.minDate) || "…"} – ${formatDate(profile.maxDate) || "current"}`
          : "before current";
      const busy = profile.state !== "idle";

      return el(
        "tr",
        { class: profile.enabled ? "" : "disabled" },
        el(
          "td",
          { class: "col-enabled" },
          enableSwitch(profile),
        ),
        el("td", {}, el("strong", {}, profile.name), el("div", { class: "sub" }, profile.visaEmail)),
        el("td", { class: "mono nowrap" }, profile.visaProcessId),
        el("td", { class: "nowrap" }, window),
        el(
          "td",
          {},
          profile.actions.length
            ? profile.actions.map((action) =>
                badge(action, action === "reschedule" ? "warn" : "muted"),
              )
            : badge("none", "muted"),
          profile.heartbeat ? badge("heartbeat", "muted") : null,
        ),
        el("td", {}, `${profile.intervalMinutes}m`),
        el(
          "td",
          {},
          runBadge(profile),
          el(
            "div",
            { class: "sub", title: formatTimestamp(profile.lastRun?.startedAt) },
            relativeTime(profile.lastRun?.startedAt),
          ),
        ),
        el(
          "td",
          { class: "message" },
          profile.lastLog
            ? [
                el("div", { class: "clamp", title: profile.lastLog.message }, profile.lastLog.message.split("\n")[0]),
                el("div", { class: "sub" }, profile.lastLog.timestamp),
              ]
            : el("span", { class: "sub" }, "—"),
        ),
        el(
          "td",
          {},
          el(
            "div",
            { class: "row-actions" },
            busy
              ? el("button", { onclick: () => cancelRun(profile) }, "Stop")
              : el("button", { onclick: () => runNow(profile) }, "Run now"),
            el("button", { onclick: () => openLogs(profile) }, "Logs"),
            el("button", { onclick: () => openProfile(profile) }, "Edit"),
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
    alert(error.message);
  }
  refresh();
}

async function runNow(profile) {
  try {
    await api("POST", `/api/profiles/${profile.id}/run`, {});
  } catch (error) {
    alert(error.message);
  }
  refresh();
}

async function cancelRun(profile) {
  await api("POST", `/api/profiles/${profile.id}/cancel`, {});
  refresh();
}

// ---- Profile dialog ----

const profileDialog = $("#profile-dialog");
const profileForm = $("#profile-form");
let editingProfile = null;

function openProfile(profile) {
  editingProfile = profile || null;
  profileForm.reset();
  setError(profileForm);
  $("[data-title]", profileForm).textContent = profile ? `Edit ${profile.name}` : "New profile";
  $("[data-delete]", profileForm).hidden = !profile;

  const values = profile || {
    intervalMinutes: 5,
    actions: ["notify"],
    heartbeat: true,
    enabled: true,
  };
  for (const field of ["name", "visaProcessId", "visaEmail", "emailDestination", "minDate", "maxDate", "intervalMinutes"]) {
    profileForm[field].value = values[field] ?? "";
  }
  for (const checkbox of profileForm.querySelectorAll("[name=action]")) {
    checkbox.checked = values.actions.includes(checkbox.value);
  }
  profileForm.heartbeat.checked = !!values.heartbeat;
  profileForm.enabled.checked = !!values.enabled;

  const password = profileForm.visaPassword;
  password.required = !profile;
  password.placeholder = profile ? "Leave empty to keep the stored password" : "";

  profileDialog.showModal();
}

$("#new-profile").addEventListener("click", () => openProfile(null));

profileForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  setError(profileForm);
  const form = profileForm;
  const actions = [...form.querySelectorAll("[name=action]:checked")].map((input) => input.value);

  if (
    actions.includes("reschedule") &&
    !(editingProfile?.actions || []).includes("reschedule") &&
    !confirm("Automatic rescheduling will book the first matching date without asking. Continue?")
  ) {
    return;
  }

  const body = {
    name: form.name.value,
    visaProcessId: form.visaProcessId.value,
    visaEmail: form.visaEmail.value,
    visaPassword: form.visaPassword.value || undefined,
    emailDestination: form.emailDestination.value,
    minDate: form.minDate.value || null,
    maxDate: form.maxDate.value || null,
    intervalMinutes: Number(form.intervalMinutes.value),
    actions,
    heartbeat: form.heartbeat.checked,
    enabled: form.enabled.checked,
  };

  try {
    if (editingProfile) {
      await api("PUT", `/api/profiles/${editingProfile.id}`, body);
    } else {
      await api("POST", "/api/profiles", body);
    }
    profileDialog.close();
    refresh();
  } catch (error) {
    setError(profileForm, error.message);
  }
});

$("[data-delete]", profileForm).addEventListener("click", async () => {
  if (!editingProfile || !confirm(`Delete profile "${editingProfile.name}"? Its stored password will be removed.`)) {
    return;
  }
  try {
    await api("DELETE", `/api/profiles/${editingProfile.id}`, {});
    profileDialog.close();
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
    "heartbeatMinutes",
    "maxConcurrentRuns",
    "runTimeoutMinutes",
  ]) {
    settingsForm[field].value = settings[field] ?? "";
  }
  settingsForm.gmailAppPassword.placeholder = settings.hasGmailAppPassword
    ? "Leave empty to keep the stored password"
    : "Not set";
  settingsDialog.showModal();
});

settingsForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = settingsForm;
  setError(form);
  try {
    await api("PUT", "/api/settings", {
      gmailUser: form.gmailUser.value,
      gmailAppPassword: form.gmailAppPassword.value || undefined,
      emailAdminDestination: form.emailAdminDestination.value,
      heartbeatMinutes: Number(form.heartbeatMinutes.value),
      maxConcurrentRuns: Number(form.maxConcurrentRuns.value),
      runTimeoutMinutes: Number(form.runTimeoutMinutes.value),
    });
    settingsDialog.close();
    refresh();
  } catch (error) {
    setError(form, error.message);
  }
});

// ---- Logs dialog ----

const logsDialog = $("#logs-dialog");

async function openLogs(profile) {
  $("[data-title]", logsDialog).textContent = `Logs — ${profile.name}`;
  $("[data-output]", logsDialog).hidden = true;
  selectTab("messages");
  logsDialog.showModal();

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
  output.scrollIntoView({ block: "nearest" });
}

function selectTab(name) {
  for (const tab of logsDialog.querySelectorAll("[data-tab]")) {
    tab.classList.toggle("active", tab.dataset.tab === name);
  }
  for (const panel of logsDialog.querySelectorAll("[data-panel]")) {
    panel.hidden = panel.dataset.panel !== name;
  }
}

for (const tab of logsDialog.querySelectorAll("[data-tab]")) {
  tab.addEventListener("click", () => selectTab(tab.dataset.tab));
}

for (const button of document.querySelectorAll("[data-close]")) {
  button.addEventListener("click", () => button.closest("dialog").close());
}

boot();
