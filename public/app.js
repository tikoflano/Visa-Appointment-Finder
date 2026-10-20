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
import "@shoelace-style/shoelace/dist/components/option/option.js";
import "@shoelace-style/shoelace/dist/components/select/select.js";
import "@shoelace-style/shoelace/dist/components/switch/switch.js";
import "@shoelace-style/shoelace/dist/components/tooltip/tooltip.js";
import "./app.css";

const REFRESH_MS = 10000;
const $ = (selector, root = document) => root.querySelector(selector);
const named = (form, name) => form.querySelector(`[name="${name}"]`);

let profiles = [];
let checkIntervalMinutes = 5;
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

function toDatetimeLocalValue(date) {
  const pad = (n) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(
    date.getHours(),
  )}:${pad(date.getMinutes())}`;
}

function last24HoursRange() {
  const to = new Date();
  const from = new Date(to.getTime() - 24 * 60 * 60 * 1000);
  return { from: toDatetimeLocalValue(from), to: toDatetimeLocalValue(to) };
}

function relativeTime(iso) {
  if (!iso) return "never";
  const minutes = Math.round((Date.now() - new Date(iso)) / 60000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  if (minutes < 60 * 24) return `${Math.round(minutes / 60)}h ago`;
  return `${Math.round(minutes / 60 / 24)}d ago`;
}

function nextRunLabel(iso) {
  if (!iso) return "—";
  const minutes = Math.round((new Date(iso) - Date.now()) / 60000);
  if (minutes <= 0) return "due";
  if (minutes < 60) return `in ${minutes}m`;
  if (minutes < 60 * 24) return `in ${Math.round(minutes / 60)}h`;
  return `in ${Math.round(minutes / 60 / 24)}d`;
}

function sortedProfiles() {
  return [...profiles].sort((left, right) => {
    const leftAt = left.nextRunAt ? Date.parse(left.nextRunAt) : Number.POSITIVE_INFINITY;
    const rightAt = right.nextRunAt ? Date.parse(right.nextRunAt) : Number.POSITIVE_INFINITY;
    if (leftAt !== rightAt) return leftAt - rightAt;
    return String(left.name || "").localeCompare(String(right.name || ""));
  });
}

function liveBookedDate(label, stored) {
  const tip = stored
    ? "Uses the appointment currently booked on AIS. This date can change after a check or reschedule."
    : "No booked date stored yet. A successful check will fill this in, and it can change later.";
  const tipNode = el(
    "sl-tooltip",
    { class: "date-live-tip", placement: "top", hoist: true },
    el("span", { slot: "content" }, tip),
    el("span", { class: "date-live", tabindex: "0" }, label),
  );
  tipNode.setAttribute("hoist", "");
  return tipNode;
}

function dateWindow(profile) {
  const stored = !!profile.currentAppointmentDate;
  const booked = stored ? formatDate(profile.currentAppointmentDate) : "booked";
  if (!profile.minDate && !profile.maxDate) {
    return el(
      "span",
      { class: "date-window" },
      el("span", { class: "date-window-text" }, "before "),
      liveBookedDate(booked, stored),
    );
  }
  if (profile.maxDate) {
    return `${formatDate(profile.minDate) || "…"} – ${formatDate(profile.maxDate)}`;
  }
  return el(
    "span",
    { class: "date-window" },
    el("span", { class: "date-window-text" }, `${formatDate(profile.minDate) || "…"} – `),
    liveBookedDate(booked, stored),
  );
}

function notifyAddresses(profile) {
  return String(profile.emailDestination || "")
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
}

function actionBadge(action, profile) {
  const node = badge(
    action,
    action === "reschedule" ? "ok" : action === "notify" ? "warn" : "muted",
  );
  if (action !== "notify") return node;
  const lines = notifyAddresses(profile);
  const tip = el(
    "sl-tooltip",
    { class: "notify-tip", placement: "top", hoist: true },
    el(
      "span",
      { slot: "content", class: "notify-tip-list" },
      lines.length ? lines.join("\n") : "No notify addresses",
    ),
    node,
  );
  tip.setAttribute("hoist", "");
  return tip;
}

function badge(text, kind) {
  const variant =
    { ok: "success", bad: "danger", warn: "warning", info: "primary", muted: "neutral", idle: "neutral" }[
      kind
    ] || "neutral";
  const node = el("sl-badge", { variant, pill: true }, text);
  if (kind === "idle") node.classList.add("idle-badge");
  return node;
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

function setQueueWarning() {
  const behind = profiles.filter((profile) => profile.behind);
  const banner = $("#queue-warning");
  const visible = behind.length > 0;
  if (visible) {
    const names = behind.map((profile) => profile.name);
    const shown = names.slice(0, 5).join(", ");
    const extra = names.length > 5 ? ` and ${names.length - 5} more` : "";
    $("#queue-warning-text").textContent =
      `Scheduler is behind the ${checkIntervalMinutes}-minute check interval. Still running or queued: ${shown}${extra}. Raise Max concurrent runs, enable fewer profiles, or increase Check every.`;
  }
  banner.hidden = !visible;
  banner.open = visible;
}

function formatDuration(ms) {
  const minutes = Math.max(1, Math.round(Number(ms) / 60000));
  return `${minutes}m`;
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
  $("#app-toolbar").hidden = true;
  $("#login-view").hidden = false;
  document.body.classList.add("is-login");
  document.body.classList.remove("is-app");
  setupMode = !!setupRequired;
  $("#setup-hint").hidden = !setupMode;
  $("#confirm-row").hidden = !setupMode;
  $(".login-title").textContent = setupMode ? "Create password" : "Sign in";
  $("#login-submit").textContent = setupMode ? "Create password" : "Sign in";
  const form = $("#login-form");
  named(form, "password").autocomplete = setupMode ? "new-password" : "current-password";
  named(form, "confirm").required = setupMode;
}

function showApp(dev) {
  $("#login-view").hidden = true;
  $("#app-view").hidden = false;
  $("#app-toolbar").hidden = false;
  document.body.classList.add("is-app");
  document.body.classList.remove("is-login");
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
    checkIntervalMinutes = Number(settings.intervalMinutes) || 5;
    setBanner("#settings-warning", !(settings.gmailUser && settings.hasGmailAppPassword));
    setQueueWarning();
    renderProfiles();
  } catch (error) {
    console.error(error);
  }
}

function outcomeLabel(outcome) {
  if (outcome === "none") return "none available";
  if (outcome === "available") return "available";
  if (outcome === "error") return "error";
  return outcome || "";
}

function runBadge(profile) {
  if (profile.state === "running" || profile.state === "queued") {
    const node = badge(profile.state, profile.behind ? "warn" : "info");
    if (!profile.behind) return node;
    return el(
      "sl-tooltip",
      { placement: "top", hoist: true },
      el(
        "span",
        { slot: "content" },
        `This profile has been ${profile.state} for ${formatDuration(profile.behindMs)} (check interval is ${checkIntervalMinutes}m).`,
      ),
      node,
    );
  }
  const run = profile.lastRun;
  if (!run) return badge("never run", "muted");
  const outcome = run.result?.outcome;
  if (outcome === "none") return badge("none available", "idle");
  if (outcome === "available") {
    const node = badge("available", "ok");
    node.classList.add("clickable-badge");
    node.addEventListener("click", (event) => {
      event.stopPropagation();
      openAvailableDates(run.result.dates || []);
    });
    return node;
  }
  if (outcome === "error") {
    const node = badge("error", "bad");
    node.classList.add("clickable-badge");
    node.addEventListener("click", (event) => {
      event.stopPropagation();
      openRunError(run);
    });
    return node;
  }
  const kind = run.status === "success" ? "ok" : run.status === "cancelled" ? "muted" : "bad";
  if (kind === "bad") {
    const node = badge(run.status, kind);
    node.classList.add("clickable-badge");
    node.addEventListener("click", (event) => {
      event.stopPropagation();
      openRunError(run);
    });
    return node;
  }
  return badge(run.status, kind);
}

function iconAction(name, label, onclick, className) {
  return el(
    "sl-tooltip",
    { placement: "top", hoist: true },
    el("span", { slot: "content" }, label),
    el("sl-icon-button", { name, label, class: className || "row-action", onclick }),
  );
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
    ...sortedProfiles().map((profile) => {
      const busy = profile.state !== "idle";
      const nextLabel = nextRunLabel(profile.nextRunAt);

      return el(
        "tr",
        { class: profile.enabled ? "" : "disabled" },
        el("td", { class: "col-enabled" }, enableSwitch(profile)),
        el("td", {}, el("strong", {}, profile.name), el("div", { class: "sub" }, profile.visaEmail)),
        el(
          "td",
          { class: "nowrap" },
          profile.currentAppointmentDate
            ? formatDate(profile.currentAppointmentDate)
            : el("span", { class: "hint" }, "unknown"),
        ),
        el("td", { class: "nowrap" }, dateWindow(profile)),
        el(
          "td",
          {},
          profile.actions.length
            ? profile.actions.map((action) => actionBadge(action, profile))
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
          {
            class: nextLabel === "due" ? "nowrap" : "nowrap hint",
            title: profile.nextRunAt
              ? formatTimestamp(profile.nextRunAt)
              : "Disabled — not scheduled",
          },
          nextLabel,
        ),
        el(
          "td",
          {},
          el(
            "div",
            { class: "row-actions" },
            busy
              ? iconAction("stop-circle", "Stop", () => cancelRun(profile), "row-action stop")
              : iconAction("play-circle", "Run now", () => runNow(profile), "row-action play"),
            iconAction("clock-history", "Runs", () => openRuns(profile), "row-action history"),
            iconAction("pencil", "Edit", () => openProfile(profile), "row-action edit"),
            iconAction("trash", "Delete", () => deleteProfile(profile), "row-action danger"),
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

async function deleteProfile(profile) {
  if (
    !(await confirmAction(`Delete profile "${profile.name}"? Its stored password will be removed.`, {
      okLabel: "Delete",
      variant: "danger",
    }))
  ) {
    return;
  }
  try {
    await api("DELETE", `/api/profiles/${profile.id}`, {});
    refresh();
  } catch (error) {
    toast(error.message);
  }
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

  const values = profile || {
    actions: ["notify"],
    enabled: false,
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
    "failureAlarmThreshold",
  ]) {
    named(settingsForm, field).value = settings[field] ?? "";
  }
  named(settingsForm, "gmailAppPassword").placeholder = settings.hasGmailAppPassword
    ? "Leave empty to keep the stored password"
    : "Not set";
  named(settingsForm, "heartbeatEnabled").checked = !!settings.heartbeatEnabled;
  named(settingsForm, "botDebug").checked = !!settings.botDebug;
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
      failureAlarmThreshold: Number(named(form, "failureAlarmThreshold").value),
      botDebug: named(form, "botDebug").checked,
    });
    settingsDialog.hide();
    refresh();
  } catch (error) {
    setError(form, error.message);
  }
});

// ---- Runs dialog ----

const runsDialog = $("#runs-dialog");
const datesDialog = $("#dates-dialog");
const errorDialog = $("#error-dialog");
const runsFrom = $("#runs-from");
const runsTo = $("#runs-to");
const runsNotified = $("#runs-notified");
const runsOrder = $("#runs-order");
const runsClearFilter = $("#runs-clear-filter");
let runsCache = [];
let runsNotifiedMeta = { count: 0, firstAt: null, lastAt: null };
let runsProfileId = null;
let runsLoadGen = 0;
let expandedRunId = null;
let expandedRun = null;

function localDateTimeToIso(value, endOfMinute = false) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  if (endOfMinute && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value)) {
    date.setSeconds(59, 999);
  }
  return date.toISOString();
}

function runsFilterActive() {
  return Boolean(
    runsFrom.value ||
      runsTo.value ||
      runsNotified.value !== "any" ||
      runsOrder.value !== "desc",
  );
}

function updateRunsClearButton() {
  runsClearFilter.disabled = !runsFilterActive();
}

function openAvailableDates(dates) {
  const items = (dates || []).map((iso) => el("li", {}, formatDate(iso) || iso));
  $("[data-dates]", datesDialog).replaceChildren(
    ...(items.length ? items : [el("li", { class: "sub" }, "No dates")]),
  );
  datesDialog.show();
}

function fillErrorDialog(run) {
  $("[data-error-when]", errorDialog).textContent = run.startedAt
    ? formatTimestamp(run.startedAt)
    : "";
  $("[data-error-message]", errorDialog).textContent =
    run.result?.error ||
    (run.status === "timeout" ? "The check timed out." : "") ||
    (run.status === "interrupted" ? "The check was interrupted." : "") ||
    `The check ${run.status || "failed"}.`;
  const output = $("[data-error-output]", errorDialog);
  if (run.output) {
    output.hidden = false;
    output.textContent = run.output;
  } else {
    output.hidden = true;
    output.textContent = "";
  }
}

async function openRunError(run) {
  fillErrorDialog(run);
  errorDialog.show();
  if (!run.id) return;
  try {
    fillErrorDialog(await api("GET", `/api/runs/${run.id}`));
  } catch (error) {
    $("[data-error-message]", errorDialog).textContent = error.message;
  }
}

function runStatusBadge(run) {
  const outcome = run.result?.outcome;
  if (outcome) {
    const kind = outcome === "available" ? "ok" : outcome === "error" ? "bad" : outcome === "none" ? "idle" : "muted";
    return badge(outcomeLabel(outcome), kind);
  }
  const kind = run.status === "success" ? "ok" : run.status === "running" ? "info" : run.status === "cancelled" ? "muted" : "bad";
  return badge(run.status, kind);
}

function resultDetail(run) {
  const result = run.result;
  const rows = [];
  if (!result) {
    rows.push(["Status", run.status]);
  } else {
    if (result.outcome === "error") rows.push(["Error", result.error || "Unknown error"]);
    rows.push(["Booked appointment", formatDate(result.currentAppointment) || "—"]);
    if (result.dates?.length) {
      rows.push(["Dates", result.dates.map((iso) => formatDate(iso) || iso).join(", ")]);
    }
    rows.push(["Notified", result.notified ? "yes" : "no"]);
    rows.push(["Rescheduled", result.rescheduled ? "yes" : "no"]);
  }
  const table = el(
    "table",
    { class: "run-result" },
    ...rows.map(([label, value]) => el("tr", {}, el("th", {}, label), el("td", {}, value))),
  );
  if (!run.output) return table;
  return [table, el("pre", { class: "run-debug" }, run.output)];
}

function runMixKind(run) {
  if (run.result?.outcome === "error") return "bad";
  if (run.status === "success") return "ok";
  if (run.status === "failed" || run.status === "timeout" || run.status === "interrupted") {
    return "bad";
  }
  return "other";
}

function renderNotifiedRange() {
  const node = $("[data-runs-notified-range]");
  const { count, firstAt, lastAt } = runsNotifiedMeta;
  node.hidden = false;
  if (!count) {
    node.textContent = runsFrom.value || runsTo.value ? "No notifications in this range" : "Never notified";
    return;
  }
  if (count === 1) {
    node.textContent = `Notified once · ${formatTimestamp(firstAt)}`;
    return;
  }
  node.textContent = `Notified ${count} times · first ${formatTimestamp(firstAt)} · last ${formatTimestamp(lastAt)}`;
}

function renderRunsMix() {
  const root = $("#runs-mix");
  const okSeg = $("[data-runs-mix-ok]", root);
  const badSeg = $("[data-runs-mix-bad]", root);
  const otherSeg = $("[data-runs-mix-other]", root);
  if (!runsCache.length) {
    root.hidden = true;
    return;
  }
  let ok = 0;
  let bad = 0;
  let other = 0;
  for (const run of runsCache) {
    const kind = runMixKind(run);
    if (kind === "ok") ok += 1;
    else if (kind === "bad") bad += 1;
    else other += 1;
  }
  const setSeg = (node, count) => {
    node.hidden = count === 0;
    node.style.flexGrow = String(count);
  };
  setSeg(okSeg, ok);
  setSeg(badSeg, bad);
  setSeg(otherSeg, other);
  const parts = [`${ok} succeeded`, `${bad} errored`];
  if (other) parts.push(`${other} other`);
  const summary = parts.join(" · ");
  $("[data-runs-mix-legend]", root).textContent = summary;
  $("[data-runs-mix-bar]", root).setAttribute("aria-label", parts.join(", "));
  root.hidden = false;
}

function renderRunRows(emptyMessage) {
  renderNotifiedRange();
  renderRunsMix();
  const body = $("[data-runs]", runsDialog);
  if (!runsCache.length) {
    body.replaceChildren(
      el(
        "tr",
        {},
        el(
          "td",
          { class: "sub", colspan: "4" },
          emptyMessage || (runsFilterActive() ? "No runs in this range" : "No runs yet"),
        ),
      ),
    );
    return;
  }
  const nodes = [];
  for (const run of runsCache) {
    const expanded = expandedRunId === run.id;
    nodes.push(
      el(
        "tr",
        { class: expanded ? "clickable expanded" : "clickable", onclick: () => toggleRun(run) },
        el("td", { class: "mono nowrap" }, formatTimestamp(run.startedAt)),
        el(
          "td",
          {},
          runStatusBadge(run),
          run.result?.notified ? badge("notified", "info") : null,
        ),
        el("td", { class: "sub" }, run.trigger),
        el(
          "td",
          { class: "sub" },
          run.finishedAt ? `${Math.round((new Date(run.finishedAt) - new Date(run.startedAt)) / 1000)}s` : "",
        ),
      ),
    );
    if (expanded) {
      nodes.push(
        el(
          "tr",
          { class: "run-detail" },
          el("td", { colspan: "4" }, resultDetail(expandedRun || run)),
        ),
      );
    }
  }
  body.replaceChildren(...nodes);
}

async function loadRuns() {
  if (!runsProfileId) return;
  const from = localDateTimeToIso(runsFrom.value);
  const to = localDateTimeToIso(runsTo.value, true);
  if (from && to && from > to) {
    runsCache = [];
    runsNotifiedMeta = { count: 0, firstAt: null, lastAt: null };
    renderRunRows("From must be before To");
    return;
  }
  const params = new URLSearchParams({
    limit: runsFilterActive() ? "500" : "100",
    order: runsOrder.value === "asc" ? "asc" : "desc",
  });
  if (from) params.set("from", from);
  if (to) params.set("to", to);
  if (runsNotified.value === "yes") params.set("notified", "yes");
  if (runsNotified.value === "no") params.set("notified", "no");
  const gen = ++runsLoadGen;
  try {
    const data = await api("GET", `/api/profiles/${runsProfileId}/runs?${params}`);
    if (gen !== runsLoadGen) return;
    runsCache = data.runs || [];
    runsNotifiedMeta = data.notified || { count: 0, firstAt: null, lastAt: null };
    renderRunRows();
  } catch (error) {
    if (gen !== runsLoadGen) return;
    runsCache = [];
    runsNotifiedMeta = { count: 0, firstAt: null, lastAt: null };
    renderRunRows(error.message);
  }
}

function resetRunsFilters({ keepRange = false } = {}) {
  if (!keepRange) {
    runsFrom.value = "";
    runsTo.value = "";
  }
  runsNotified.value = "any";
  runsOrder.value = "desc";
  updateRunsClearButton();
}

async function openRuns(profile) {
  expandedRunId = null;
  expandedRun = null;
  runsProfileId = profile.id;
  const range = last24HoursRange();
  runsFrom.value = range.from;
  runsTo.value = range.to;
  resetRunsFilters({ keepRange: true });
  runsDialog.label = `Runs — ${profile.name}`;
  runsDialog.show();
  await loadRuns();
}

async function toggleRun(run) {
  if (expandedRunId === run.id) {
    expandedRunId = null;
    expandedRun = null;
    renderRunRows();
    return;
  }
  expandedRunId = run.id;
  expandedRun = await api("GET", `/api/runs/${run.id}`);
  renderRunRows();
}

runsFrom.addEventListener("sl-change", () => {
  updateRunsClearButton();
  loadRuns();
});
runsTo.addEventListener("sl-change", () => {
  updateRunsClearButton();
  loadRuns();
});
runsNotified.addEventListener("sl-change", () => {
  updateRunsClearButton();
  loadRuns();
});
runsOrder.addEventListener("sl-change", () => {
  updateRunsClearButton();
  loadRuns();
});
runsClearFilter.addEventListener("click", () => {
  resetRunsFilters();
  loadRuns();
});

for (const button of document.querySelectorAll("[data-close]")) {
  button.addEventListener("click", () => button.closest("sl-dialog").hide());
}

boot();
