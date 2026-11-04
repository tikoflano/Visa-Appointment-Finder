import { registerSystemIconsFromSelf } from "./shoelace-base.js";
import "@shoelace-style/shoelace/dist/themes/light.css";
import "@shoelace-style/shoelace/dist/components/alert/alert.js";
import "@shoelace-style/shoelace/dist/components/badge/badge.js";
import "@shoelace-style/shoelace/dist/components/button/button.js";
import "@shoelace-style/shoelace/dist/components/card/card.js";
import "@shoelace-style/shoelace/dist/components/checkbox/checkbox.js";
import "@shoelace-style/shoelace/dist/components/dialog/dialog.js";
import "@shoelace-style/shoelace/dist/components/dropdown/dropdown.js";
import "@shoelace-style/shoelace/dist/components/icon/icon.js";
import "@shoelace-style/shoelace/dist/components/icon-button/icon-button.js";
import "@shoelace-style/shoelace/dist/components/input/input.js";
import "@shoelace-style/shoelace/dist/components/menu/menu.js";
import "@shoelace-style/shoelace/dist/components/menu-item/menu-item.js";
import "@shoelace-style/shoelace/dist/components/option/option.js";
import "@shoelace-style/shoelace/dist/components/select/select.js";
import "@shoelace-style/shoelace/dist/components/switch/switch.js";
import "@shoelace-style/shoelace/dist/components/tab/tab.js";
import "@shoelace-style/shoelace/dist/components/tab-group/tab-group.js";
import "@shoelace-style/shoelace/dist/components/tab-panel/tab-panel.js";
import "@shoelace-style/shoelace/dist/components/tooltip/tooltip.js";
import "./app.css";

registerSystemIconsFromSelf();

const REFRESH_MS = 10000;
const LIVE_CLOCK_MS = 1000;
const $ = (selector, root = document) => root.querySelector(selector);
const named = (form, name) => form.querySelector(`[name="${name}"]`);

const HIDE_DISABLED_KEY = "hideDisabledProfiles";

let profiles = [];
let checkIntervalMinutes = 5;
let hideDisabled = localStorage.getItem(HIDE_DISABLED_KEY) === "1";
let refreshTimer;
let liveClockTimer;
let setupMode = false;
let confirmResolve;
/** Profile ids currently waiting on an enable-time AIS probe. */
const probingIds = new Set();

let loginMode = "user";
let mfaStep = false;
let sessionRole = null;
let realSessionRole = null;
let impersonating = false;
let registerToken = "";
let turnstileSiteKey = null;
let turnstileRequiredFlag = false;
let turnstileScriptPromise = null;
const turnstileWidgets = new Map();

function isAdminPath() {
  return (
    location.pathname === "/admin" || location.pathname.startsWith("/admin/")
  );
}

function isLivePath() {
  return (
    location.pathname === "/admin/live" ||
    location.pathname === "/admin/live/"
  );
}

function loadTurnstileScript() {
  if (window.turnstile) return Promise.resolve();
  if (turnstileScriptPromise) return turnstileScriptPromise;
  turnstileScriptPromise = new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";
    script.async = true;
    script.onload = () => resolve();
    script.onerror = () => reject(new Error("Failed to load bot check"));
    document.head.appendChild(script);
  });
  return turnstileScriptPromise;
}

async function mountTurnstile(containerId) {
  const container = $(`#${containerId}`);
  if (!container) return;
  if (!turnstileSiteKey) {
    container.hidden = true;
    container.innerHTML = "";
    turnstileWidgets.delete(containerId);
    return;
  }
  container.hidden = false;
  await loadTurnstileScript();
  if (turnstileWidgets.has(containerId)) {
    try {
      window.turnstile.reset(turnstileWidgets.get(containerId));
    } catch {
      /* ignore */
    }
    return;
  }
  container.innerHTML = "";
  const widgetId = window.turnstile.render(container, {
    sitekey: turnstileSiteKey,
    theme: "light",
  });
  turnstileWidgets.set(containerId, widgetId);
}

function readTurnstileToken(containerId) {
  const widgetId = turnstileWidgets.get(containerId);
  if (!turnstileSiteKey) {
    if (turnstileRequiredFlag) {
      throw new Error("Bot check is required but not configured");
    }
    return undefined;
  }
  if (widgetId == null || !window.turnstile) {
    throw new Error("Bot check required");
  }
  const token = window.turnstile.getResponse(widgetId);
  if (!token) throw new Error("Complete the bot check");
  return token;
}

function resetTurnstile(containerId) {
  const widgetId = turnstileWidgets.get(containerId);
  if (widgetId != null && window.turnstile) {
    try {
      window.turnstile.reset(widgetId);
    } catch {
      /* ignore */
    }
  }
}

async function api(method, url, body) {
  const response = await fetch(url, {
    method,
    headers: body === undefined ? {} : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await response.json().catch(() => ({}));
  const authExempt =
    url === "/api/login" ||
    url === "/api/user/login" ||
    url === "/api/user/register" ||
    url.startsWith("/api/user/invite") ||
    url === "/api/session" ||
    url === "/api/setup";
  if (response.status === 401 && !authExempt) {
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
  if (!iso) return "";
  const date = new Date(iso);
  if (Number.isNaN(+date)) return String(iso);
  const pad = (n) => String(n).padStart(2, "0");
  return `${pad(date.getMonth() + 1)}/${pad(date.getDate())}/${date.getFullYear()} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
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
  const rank = (profile) =>
    profile.intakeStatus === "pending" ? 0 : profile.intakeStatus === "expired" ? 1 : 2;
  return [...profiles].sort((left, right) => {
    const byRank = rank(left) - rank(right);
    if (byRank) return byRank;
    const leftAt = left.nextRunAt ? Date.parse(left.nextRunAt) : Number.POSITIVE_INFINITY;
    const rightAt = right.nextRunAt ? Date.parse(right.nextRunAt) : Number.POSITIVE_INFINITY;
    if (leftAt !== rightAt) return leftAt - rightAt;
    return String(left.name || "").localeCompare(String(right.name || ""));
  });
}

function intakeOpen(profile) {
  return profile?.intakeStatus === "pending" || profile?.intakeStatus === "expired";
}

function displayPhone(id) {
  return String(id || "").replace(/@c\.us$/i, "");
}

function intakePhaseLines(profile) {
  if (profile.intakeStatus === "expired") return ["Intake stopped"];
  if (profile.intakeStatus !== "pending") return [];
  if (!profile.intakeWindowStartedMs) return ["WhatsApp prompt not sent"];
  const age = Date.now() - Number(profile.intakeWindowStartedMs);
  const cadence =
    age < 10 * 60 * 1000
      ? "Checking every minute"
      : age < 70 * 60 * 1000
        ? "Checking every 5 minutes"
        : "Checking hourly";
  const top = ["Waiting for WhatsApp"];
  if (profile.intakeExpiresAt) {
    top.push(`until ${formatTimestamp(profile.intakeExpiresAt)}`);
  }
  const bottom = [cadence];
  if (profile.intakeNextPollAt) {
    const next = nextRunLabel(profile.intakeNextPollAt);
    bottom.push(next === "due" ? "next check due" : `next check ${next}`);
  }
  if (profile.intakeLastPollMs) {
    bottom.push(
      `last check ${relativeTime(new Date(Number(profile.intakeLastPollMs)).toISOString())}`,
    );
  }
  return [top.join(" · "), bottom.join(" · ")];
}

function intakePhaseLabel(profile) {
  return intakePhaseLines(profile).join("\n");
}

function intakePhaseTitle(profile) {
  if (profile.intakeStatus !== "pending" || !profile.intakeWindowStartedMs) {
    return "";
  }
  const lines = [];
  if (profile.intakeNextPollAt) {
    lines.push(`Next check: ${formatTimestamp(profile.intakeNextPollAt)}`);
  }
  if (profile.intakeLastPollMs) {
    lines.push(
      `Last check: ${formatTimestamp(new Date(Number(profile.intakeLastPollMs)).toISOString())}`,
    );
  }
  if (profile.intakeExpiresAt) {
    lines.push(`Watch ends: ${formatTimestamp(profile.intakeExpiresAt)}`);
  }
  return lines.join("\n");
}

function visibleProfiles() {
  const list = sortedProfiles();
  return hideDisabled
    ? list.filter((profile) => profile.enabled || intakeOpen(profile))
    : list;
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

function rescheduleLimitLabel(remaining, maximum) {
  if (!Number.isInteger(remaining) || !Number.isInteger(maximum)) return "";
  return `${remaining}/${maximum} available`;
}

function rescheduleLimitCell(profile) {
  const remaining = profile.rescheduleRemaining;
  const maximum = profile.rescheduleMaximum;
  const label = rescheduleLimitLabel(remaining, maximum);
  if (!label) return el("span", { class: "hint" }, "—");
  const tone = remaining <= 0 ? "bad" : remaining === 1 ? "warn" : "ok";
  const tip =
    remaining <= 0
      ? `No reschedules left. AIS allows ${maximum}, and reaching that limit locks the appointment.`
      : `${remaining} of ${maximum} reschedules remaining before AIS locks the appointment.`;
  const node = el(
    "sl-tooltip",
    { class: "reschedule-tip", placement: "top", hoist: true },
    el("span", { slot: "content" }, tip),
    el("span", { class: `reschedule-limit ${tone}`, tabindex: "0" }, label),
  );
  node.setAttribute("hoist", "");
  return node;
}

function dateWindow(profile) {
  if (intakeOpen(profile)) return el("span", { class: "hint" }, "—");
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
  const emails = String(profile.emailDestination || "")
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
  const phones = String(profile.whatsappDestination || "")
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean)
    .map((id) => `WhatsApp ${id}`);
  return [...emails, ...phones];
}

function actionBadge(action, profile) {
  const node = badge(
    action,
    action === "reschedule" ? "ok" : action === "notify" ? "warn" : "muted",
  );
  if (action === "reschedule") return [node, badge("experimental", "warn")];
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

function toast(message, variant = "danger", duration = 4000) {
  const node = el("sl-alert", { variant, closable: true }, message);
  node.duration = duration;
  document.body.append(node);
  node.toast();
  return node;
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

function parseHashRoute() {
  const hash = location.hash.replace(/^#/, "");
  if (hash.startsWith("/register")) {
    const query = hash.includes("?") ? hash.slice(hash.indexOf("?") + 1) : "";
    return {
      name: "register",
      token: new URLSearchParams(query).get("token") || "",
    };
  }
  return { name: "app", token: "" };
}

async function boot() {
  const route = parseHashRoute();
  if (route.name === "register" && route.token) {
    if (isAdminPath()) {
      location.replace(`/${location.search}${location.hash}`);
      return;
    }
    await showRegister(route.token);
    return;
  }
  const session = await api("GET", "/api/session");
  turnstileSiteKey = session.turnstileSiteKey || null;
  turnstileRequiredFlag = !!session.turnstileRequired;
  if (session.authenticated) {
    await applySession(session);
    return;
  }
  if (session.mfaPending && isAdminPath()) {
    await showLogin(false, { mfaPending: true });
    return;
  }
  if (session.setupRequired && !isAdminPath()) {
    location.replace(`/admin${location.search}`);
    return;
  }
  await showLogin(session.setupRequired);
}

async function applySession(session) {
  sessionRole = session.role;
  realSessionRole = session.realRole || session.role;
  impersonating = !!session.impersonating;
  turnstileSiteKey = session.turnstileSiteKey || turnstileSiteKey;
  turnstileRequiredFlag = !!session.turnstileRequired;
  const adminPath = isAdminPath();
  if (session.role === "user" || session.impersonating) {
    if (adminPath) {
      location.replace("/");
      return;
    }
    showUserPortal(session);
  } else {
    if (!adminPath) history.replaceState(null, "", "/admin");
    showApp(session.dev);
  }
}

async function stopImpersonation() {
  await api("POST", "/api/admin/stop-impersonation", {});
  const session = await api("GET", "/api/session");
  if (!session.authenticated || session.impersonating) {
    throw new Error("Could not return to admin session");
  }
  await applySession(session);
}

function applyLoginMode() {
  const email = $("#login-email");
  const password = $("#login-password");
  const totp = $("#login-totp");
  const confirm = $("#confirm-row");
  email.hidden = mfaStep || loginMode !== "user";
  email.required = !mfaStep && loginMode === "user";
  password.hidden = mfaStep;
  password.required = !mfaStep;
  password.label =
    loginMode === "admin" ? "Admin password" : "Portal password";
  confirm.hidden = mfaStep || !setupMode;
  totp.hidden = !mfaStep;
  totp.required = mfaStep;
  $("#setup-hint").hidden = mfaStep || !setupMode;
  $("#mfa-hint").hidden = !mfaStep;
  if (mfaStep) $("#login-turnstile").hidden = true;
}

async function showLogin(setupRequired, options = {}) {
  clearInterval(refreshTimer);
  stopLiveView();
  $("#app-view").hidden = true;
  $("#user-view").hidden = true;
  $("#register-view").hidden = true;
  $("#app-toolbar").hidden = true;
  $("#login-view").hidden = false;
  document.body.classList.add("is-login");
  document.body.classList.remove("is-app");
  const adminPath = isAdminPath();
  setupMode = !!setupRequired && adminPath;
  loginMode = adminPath ? "admin" : "user";
  mfaStep = !!options.mfaPending && loginMode === "admin";
  $(".login-title").textContent = mfaStep
    ? "Authenticator"
    : setupMode
      ? "Create password"
      : "Sign in";
  $("#login-submit").textContent = mfaStep
    ? "Verify"
    : setupMode
      ? "Create password"
      : "Sign in";
  const form = $("#login-form");
  named(form, "password").autocomplete = setupMode
    ? "new-password"
    : "current-password";
  named(form, "confirm").required = setupMode && !mfaStep;
  applyLoginMode();
  if (mfaStep) {
    $("#login-turnstile").hidden = true;
    $("#login-totp").focus?.();
  } else {
    await mountTurnstile("login-turnstile");
  }
}

function hideAuthViews() {
  $("#login-view").hidden = true;
  $("#register-view").hidden = true;
  document.body.classList.remove("is-login");
}

let appDevMode = false;

function showApp(dev) {
  hideAuthViews();
  $("#user-view").hidden = true;
  $("#app-view").hidden = false;
  $("#app-toolbar").hidden = false;
  document.body.classList.add("is-app");
  appDevMode = !!dev;
  document.body.classList.toggle("is-dev", appDevMode);
  setBanner("#dev-banner", !!dev);
  setBanner("#live-dev-banner", !!dev);
  for (const id of [
    "#new-profile",
    "#open-live",
    "#open-all-runs",
    "#open-calendar",
    "#open-notifications",
    "#open-portal-audit",
    "#open-settings",
  ]) {
    const node = $(id)?.closest("sl-tooltip") || $(id);
    if (node) node.hidden = false;
  }
  applyAdminPanel();
  refresh();
  scheduleRefreshTimer();
}

function scheduleRefreshTimer() {
  clearInterval(refreshTimer);
  // Live page uses SSE for profile/run state — no polling there.
  if (isLivePath()) return;
  refreshTimer = setInterval(refresh, REFRESH_MS);
}

function applyAdminPanel() {
  const live = isLivePath();
  $("#profiles-panel").hidden = live;
  $("#live-view").hidden = !live;
  document.body.classList.toggle("is-live", live);
  if (live) startLiveView();
  else stopLiveView();
  scheduleRefreshTimer();
}

function goAdminHome() {
  if (location.pathname !== "/admin") {
    history.pushState(null, "", "/admin");
  }
  applyAdminPanel();
  refresh();
}

function goLiveView() {
  if (!isLivePath()) {
    history.pushState(null, "", "/admin/live");
  }
  applyAdminPanel();
  refresh();
}

function showUserPortal(session) {
  hideAuthViews();
  stopLiveView();
  $("#app-view").hidden = true;
  $("#user-view").hidden = false;
  $("#app-toolbar").hidden = false;
  document.body.classList.add("is-app");
  for (const id of [
    "#new-profile",
    "#open-all-runs",
    "#open-calendar",
    "#open-notifications",
    "#open-portal-audit",
    "#open-settings",
  ]) {
    const tip = $(id)?.closest("sl-tooltip");
    if (tip) tip.hidden = true;
    else if ($(id)) $(id).hidden = true;
  }
  const banner = $("#impersonation-banner");
  const disabledBanner = $("#portal-disabled-banner");
  if (session.impersonating) {
    banner.hidden = false;
    $("#impersonation-banner-text").textContent =
      `Viewing as ${session.profileName || "user"} (${session.visaEmail || ""})`;
    const exitBtn = $("#stop-impersonation");
    if (exitBtn) exitBtn.textContent = "Back to admin";
  } else {
    banner.hidden = true;
  }
  disabledBanner.hidden = !(session.impersonating && session.portalAccessEnabled === false);
  refreshUserPortal();
  clearInterval(refreshTimer);
  refreshTimer = setInterval(refreshUserPortal, REFRESH_MS);
}

async function showRegister(token) {
  clearInterval(refreshTimer);
  registerToken = token;
  $("#app-view").hidden = true;
  $("#user-view").hidden = true;
  $("#login-view").hidden = true;
  $("#app-toolbar").hidden = true;
  $("#register-view").hidden = false;
  document.body.classList.add("is-login");
  document.body.classList.remove("is-app");
  setError($("#register-form"));
  try {
    const session = await api("GET", "/api/session");
    turnstileSiteKey = session.turnstileSiteKey || null;
    turnstileRequiredFlag = !!session.turnstileRequired;
    const info = await api("GET", `/api/user/invite?token=${encodeURIComponent(token)}`);
    $("#register-identity").textContent = `${info.name} · ${info.visaEmail}`;
    await mountTurnstile("register-turnstile");
  } catch (error) {
    $("#register-identity").textContent = "";
    setError($("#register-form"), error.message);
  }
}

$("#login-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.target;
  setError(form);
  try {
    if (mfaStep) {
      await api("POST", "/api/login/totp", {
        code: named(form, "totp").value,
      });
      form.reset();
      mfaStep = false;
      const session = await api("GET", "/api/session");
      await applySession(session);
      return;
    }
    const turnstileToken = readTurnstileToken("login-turnstile");
    if (setupMode) {
      if (named(form, "password").value !== named(form, "confirm").value) {
        throw new Error("Passwords do not match");
      }
      await api("POST", "/api/setup", {
        password: named(form, "password").value,
        turnstileToken,
      });
    } else if (loginMode === "admin") {
      const result = await api("POST", "/api/login", {
        password: named(form, "password").value,
        turnstileToken,
      });
      if (result?.mfaRequired) {
        named(form, "password").value = "";
        named(form, "totp").value = "";
        await showLogin(false, { mfaPending: true });
        return;
      }
    } else {
      await api("POST", "/api/user/login", {
        email: named(form, "email").value,
        password: named(form, "password").value,
        turnstileToken,
      });
    }
    form.reset();
    const session = await api("GET", "/api/session");
    await applySession(session);
  } catch (error) {
    if (!mfaStep) resetTurnstile("login-turnstile");
    setError(form, error.message);
  }
});

$("#register-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.target;
  setError(form);
  try {
    if (named(form, "password").value !== named(form, "confirm").value) {
      throw new Error("Passwords do not match");
    }
    await api("POST", "/api/user/register", {
      token: registerToken,
      password: named(form, "password").value,
      turnstileToken: readTurnstileToken("register-turnstile"),
    });
    location.hash = "";
    const session = await api("GET", "/api/session");
    await applySession(session);
  } catch (error) {
    resetTurnstile("register-turnstile");
    setError(form, error.message);
  }
});

$("#logout").addEventListener("click", async () => {
  // Impersonation: logout returns to admin instead of destroying the session.
  if (impersonating) {
    try {
      await stopImpersonation();
      toast("Returned to admin", "success");
    } catch (error) {
      toast(error.message);
    }
    return;
  }
  const adminLogout = sessionRole === "admin" || realSessionRole === "admin";
  await api("POST", "/api/logout", {});
  sessionRole = null;
  realSessionRole = null;
  impersonating = false;
  if (adminLogout) {
    if (!isAdminPath()) location.assign("/admin");
    else await showLogin(false);
  } else if (isAdminPath()) {
    location.assign("/");
  } else {
    await showLogin(false);
  }
});

$("#stop-impersonation").addEventListener("click", async () => {
  try {
    await stopImpersonation();
  } catch (error) {
    toast(error.message);
  }
});

let userPortalMe = null;

function statusField(label, value, edit) {
  const title = el("dt", { class: "status-label" }, label);
  if (edit) {
    title.append(
      el("sl-icon-button", {
        class: "status-edit",
        name: "pencil",
        label: edit.label,
        onclick: edit.onClick,
      }),
    );
  }
  return el("div", { class: "status-field" }, title, el("dd", {}, value));
}

function openUserDatesDialog() {
  const form = $("#user-dates-form");
  setError(form);
  named(form, "minDate").value = userPortalMe?.minDate || "";
  named(form, "maxDate").value = userPortalMe?.maxDate || "";
  $("#user-dates-dialog").show();
}

function openUserPasswordDialog() {
  const form = $("#user-password-form");
  setError(form);
  form.reset();
  $("#user-password-dialog").show();
}

function openUserPortalPasswordDialog() {
  const form = $("#user-portal-password-form");
  setError(form);
  form.reset();
  const current = $("#portal-current-password");
  // Impersonating admins can set a new portal password without the current one.
  current.hidden = !!impersonating;
  current.required = !impersonating;
  $("#user-portal-password-dialog").show();
}

async function refreshUserPortal() {
  try {
    const [me, runsPayload] = await Promise.all([
      api("GET", "/api/user/me"),
      api("GET", "/api/user/runs?limit=30"),
    ]);
    userPortalMe = me;
    const dateWindow = `${me.minDate ? formatDate(me.minDate) : "…"} → ${
      me.maxDate
        ? formatDate(me.maxDate)
        : me.currentAppointmentDate
          ? `before ${formatDate(me.currentAppointmentDate)}`
          : "…"
    }`;
    const status = $("#user-status");
    status.replaceChildren(
      el("h2", {}, me.name || "Your profile"),
      el("p", { class: "sub" }, me.visaEmail || ""),
      el(
        "div",
        { class: "status-grid" },
        statusField("Search", me.enabled ? "Enabled" : "Disabled"),
        statusField(
          "Booked appointment",
          me.currentAppointmentDate ? formatDate(me.currentAppointmentDate) : "—",
        ),
        statusField(
          "Reschedules left",
          me.rescheduleRemaining != null && me.rescheduleMaximum != null
            ? `${me.rescheduleRemaining} / ${me.rescheduleMaximum}`
            : "—",
        ),
        statusField(
          "Visa classes",
          (me.visaClasses && me.visaClasses.length
            ? me.visaClasses.join(", ")
            : me.visaFingerprint) || "—",
        ),
        statusField("Date window", dateWindow, {
          label: "Edit search dates",
          onClick: openUserDatesDialog,
        }),
        statusField(
          "Last run",
          me.lastRun ? relativeTime(me.lastRun.startedAt) : "never",
        ),
        statusField("Next run", nextRunLabel(me.nextRunAt)),
        statusField("AIS password", me.hasPassword ? "Saved" : "Missing", {
          label: "Edit AIS password",
          onClick: openUserPasswordDialog,
        }),
        statusField(
          "Portal password",
          me.portalRegistered ? "Set" : "Not registered",
          me.portalRegistered
            ? {
                label: "Change portal password",
                onClick: openUserPortalPasswordDialog,
              }
            : undefined,
        ),
      ),
    );
    const tbody = $("#user-runs");
    const runs = runsPayload.runs || [];
    tbody.replaceChildren(
      ...runs.map((run) =>
        el(
          "tr",
          {},
          el("td", { class: "nowrap" }, formatTimestamp(run.startedAt)),
          el("td", {}, run.status),
          el("td", {}, run.result?.outcome || "—"),
          el(
            "td",
            {},
            run.result?.dates?.length
              ? run.result.dates.map(formatDate).join(", ")
              : "—",
          ),
        ),
      ),
    );
    if (!runs.length) {
      tbody.append(el("tr", {}, el("td", { colspan: "4", class: "hint" }, "No runs yet")));
    }
  } catch (error) {
    toast(error.message);
  }
}

$("#user-dates-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.target;
  setError(form);
  try {
    await api("PATCH", "/api/user/dates", {
      minDate: named(form, "minDate").value || null,
      maxDate: named(form, "maxDate").value || null,
    });
    $("#user-dates-dialog").hide();
    toast("Dates saved", "success");
    refreshUserPortal();
  } catch (error) {
    setError(form, error.message);
  }
});

$("#user-password-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.target;
  setError(form);
  try {
    await api("PATCH", "/api/user/visa-password", {
      visaPassword: named(form, "visaPassword").value,
    });
    form.reset();
    $("#user-password-dialog").hide();
    toast("AIS password updated", "success");
    refreshUserPortal();
  } catch (error) {
    setError(form, error.message);
  }
});

$("#user-portal-password-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.target;
  setError(form);
  try {
    const next = named(form, "newPassword").value;
    if (next !== named(form, "confirmPassword").value) {
      throw new Error("Passwords do not match");
    }
    await api("PATCH", "/api/user/portal-password", {
      currentPassword: named(form, "currentPassword").value,
      newPassword: next,
    });
    form.reset();
    $("#user-portal-password-dialog").hide();
    toast("Portal password updated", "success");
    refreshUserPortal();
  } catch (error) {
    setError(form, error.message);
  }
});

window.addEventListener("hashchange", () => {
  const route = parseHashRoute();
  if (route.name === "register" && route.token) showRegister(route.token);
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
    setBanner(
      "#settings-warning",
      settings.emailEnabled &&
        !(settings.gmailUser && settings.hasGmailAppPassword),
    );
    const openwaReady = !!(
      settings.whatsappGatewayReady && settings.openwaSessionId
    );
    const wantsWhatsapp = profileList.some(
      (profile) =>
        profile.intakeStatus === "pending" ||
        (profile.actions?.includes("notify") && profile.whatsappDestination),
    );
    const partialOpenwa = !!(
      settings.openwaSessionId || settings.whatsappAdminDestination
    );
    setBanner(
      "#openwa-warning",
      settings.whatsappEnabled &&
        (wantsWhatsapp || partialOpenwa) &&
        !openwaReady,
    );
    setQueueWarning();
    if (!isLivePath()) renderProfiles();
  } catch (error) {
    console.error(error);
  } finally {
    if (isLivePath()) {
      try {
        renderLiveGrid();
        tickLiveClocks();
      } catch (error) {
        console.error(error);
      }
    }
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
      openAvailableDates(profile, run.result.dates || []);
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

function menuAction(name, label, onclick, className) {
  const item = el(
    "sl-menu-item",
    { class: className || "" },
    el("sl-icon", { slot: "prefix", name }),
    label,
  );
  item._runAction = onclick;
  return item;
}

/** Hamburger menu of row actions. Hoisted + flip so bottom rows open upward. */
function rowActionsMenu(actions) {
  const items = actions.filter(Boolean);
  const menu = el("sl-menu", {}, ...items);
  const dropdown = el(
    "sl-dropdown",
    {
      class: "row-actions-menu",
      placement: "bottom-end",
      distance: 6,
      hoist: true,
    },
    el(
      "sl-icon-button",
      {
        slot: "trigger",
        name: "list",
        label: "Actions",
        class: "row-action-trigger",
      },
    ),
    menu,
  );
  // Shoelace emits sl-select on the menu; host click listeners on items are unreliable.
  menu.addEventListener("sl-select", (event) => {
    const item = event.detail?.item;
    const run = item?._runAction;
    dropdown.hide?.();
    if (typeof run === "function") {
      Promise.resolve()
        .then(() => run())
        .catch((error) => toast(error.message || String(error)));
    }
  });
  return el("div", { class: "row-actions" }, dropdown);
}

function formatVisaFingerprint(fingerprint) {
  if (!fingerprint) return "";
  return String(fingerprint)
    .split(",")
    .map((part) => part.replace(/x(\d+)$/i, "×$1"))
    .join(", ");
}

/** Enable-time AIS probe in flight (local optimistic set or server run). */
function isProbing(profile) {
  if (probingIds.has(profile.id)) return true;
  if (profile.state === "idle") return false;
  return (
    profile.lastRun?.trigger === "probe" && profile.lastRun?.status === "running"
  );
}

function enableSwitch(profile) {
  const probing = isProbing(profile);
  const waiting = intakeOpen(profile);
  const toggle = document.createElement("sl-switch");
  toggle.size = "small";
  toggle.checked = !!profile.enabled;
  toggle.disabled = probing || waiting;
  toggle.title = waiting
    ? "Waiting for visa account details"
    : probing
      ? "Checking AIS…"
      : profile.enabled
        ? "Disable"
        : "Enable";
  toggle.setAttribute(
    "aria-label",
    probing
      ? "Checking AIS"
      : waiting
        ? "Waiting for visa account details"
        : profile.enabled
          ? "Disable profile"
          : "Enable profile",
  );
  toggle.addEventListener("sl-change", (event) => {
    toggleEnabled(profile, event.target.checked);
  });
  return toggle;
}

function renderProfiles() {
  const visible = visibleProfiles();
  const tbody = $("#profile-rows");
  tbody.replaceChildren(
    ...visible.map((profile) => {
      const busy = profile.state !== "idle";
      const waiting = intakeOpen(profile);
      const nextLabel = nextRunLabel(profile.nextRunAt);
      const rowClass =
        profile.intakeStatus === "pending"
          ? "intake"
          : profile.intakeStatus === "expired"
            ? "intake stopped"
            : profile.enabled
              ? ""
              : "disabled";

      return el(
        "tr",
        { class: rowClass },
        el("td", { class: "col-enabled" }, enableSwitch(profile)),
        el(
          "td",
          {},
          el("strong", {}, profile.name),
          el(
            "div",
            { class: "sub" },
            waiting ? displayPhone(profile.contactPhone) : profile.visaEmail,
          ),
          ...(waiting
            ? intakePhaseLines(profile).map((line) =>
                el("div", { class: "sub", title: intakePhaseTitle(profile) }, line),
              )
            : [
                el(
                  "div",
                  { class: "sub" },
                  isProbing(profile)
                    ? "Checking AIS…"
                    : formatVisaFingerprint(profile.visaFingerprint) ||
                        el("span", { class: "hint" }, "visas unknown"),
                ),
                el(
                  "div",
                  { class: "sub hint" },
                  profile.portalAccessEnabled === false
                    ? "Portal disabled"
                    : profile.portalRegistered
                      ? "Portal registered"
                      : profile.portalInviteExpiresAt
                        ? "Portal invite pending"
                        : "Portal not invited",
                ),
              ]),
          waiting && profile.intakeError
            ? el("div", { class: "sub hint" }, profile.intakeError)
            : null,
        ),
        el(
          "td",
          { class: "nowrap" },
          profile.currentAppointmentDate
            ? formatDate(profile.currentAppointmentDate)
            : el(
                "span",
                { class: "hint" },
                profile.hasSuccessfulRun ? "none" : "unknown",
              ),
        ),
        el("td", { class: "nowrap" }, rescheduleLimitCell(profile)),
        el("td", { class: "nowrap" }, dateWindow(profile)),
        el(
          "td",
          {},
          !waiting && profile.actions.length
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
          { class: "col-actions" },
          rowActionsMenu([
            waiting
              ? menuAction(
                  "arrow-clockwise",
                  "Resend WhatsApp",
                  () => resendIntake(profile),
                )
              : busy
                ? menuAction(
                    "stop-circle",
                    "Stop",
                    () => cancelRun(profile),
                    "danger",
                  )
                : menuAction(
                    "play-circle",
                    "Run now",
                    () => runNow(profile),
                    "play",
                  ),
            !waiting
              ? menuAction("person-badge", "Impersonate", () =>
                  impersonateProfile(profile),
                )
              : null,
            !waiting
              ? menuAction(
                  "envelope",
                  profile.portalRegistered
                    ? "Resend portal invite"
                    : "Send portal invite",
                  () => inviteProfile(profile),
                )
              : null,
            !waiting
              ? menuAction(
                  profile.portalAccessEnabled === false ? "unlock" : "lock",
                  profile.portalAccessEnabled === false
                    ? "Enable portal access"
                    : "Disable portal access",
                  () => togglePortalAccess(profile),
                )
              : null,
            menuAction("clock-history", "Runs", () => openRuns(profile), "history"),
            menuAction("pencil", "Edit", () => openProfile(profile), "edit"),
            menuAction(
              "trash",
              "Delete",
              () => deleteProfile(profile),
              "danger",
            ),
          ]),
        ),
      );
    }),
  );
  $("#empty-state").hidden = profiles.length > 0;
  $("#empty-enabled").hidden = profiles.length === 0 || visible.length > 0;
}

const hideDisabledSwitch = $("#hide-disabled");
hideDisabledSwitch.checked = hideDisabled;
hideDisabledSwitch.addEventListener("sl-change", () => {
  hideDisabled = hideDisabledSwitch.checked;
  localStorage.setItem(HIDE_DISABLED_KEY, hideDisabled ? "1" : "0");
  renderProfiles();
});

async function toggleEnabled(profile, enabled) {
  if (enabled) {
    probingIds.add(profile.id);
    renderProfiles();
    toast("Checking AIS account…");
  }
  try {
    await api("POST", `/api/profiles/${profile.id}/enabled`, { enabled });
  } catch (error) {
    toast(error.message);
  } finally {
    probingIds.delete(profile.id);
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

async function resendIntake(profile) {
  try {
    await api("POST", `/api/profiles/${profile.id}/intake/resend`, {});
    toast("WhatsApp sent", "success");
  } catch (error) {
    toast(error.message);
  }
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

async function inviteProfile(profile) {
  try {
    const result = await api("POST", `/api/profiles/${profile.id}/invite`, {});
    const channels = [
      result.emailed ? "email" : null,
      result.whatsapped ? "WhatsApp" : null,
    ]
      .filter(Boolean)
      .join(" and ");
    toast(`Invite sent via ${channels || "channel"}`, "success");
    refresh();
  } catch (error) {
    toast(error.message);
  }
}

async function impersonateProfile(profile) {
  try {
    const result = await api("POST", "/api/admin/impersonate", {
      profileId: profile.id,
    });
    const session = await api("GET", "/api/session");
    if (session.authenticated && session.impersonating) {
      await applySession(session);
      return;
    }
    // If the session cookie did not pick up the overlay, still enter the portal.
    await applySession({
      authenticated: true,
      role: "user",
      impersonating: true,
      profileId: result.profileId,
      profileName: result.name,
      visaEmail: result.visaEmail,
      portalAccessEnabled: result.portalAccessEnabled,
      dev: !!session.dev,
    });
  } catch (error) {
    toast(error.message);
  }
}

async function togglePortalAccess(profile) {
  const enable = profile.portalAccessEnabled === false;
  const ok = await confirmAction(
    enable
      ? `Enable portal access for "${profile.name}"?`
      : `Disable portal access for "${profile.name}"? They will not be able to sign in.`,
    { okLabel: enable ? "Enable" : "Disable", variant: enable ? "primary" : "danger" },
  );
  if (!ok) return;
  try {
    await api("POST", `/api/profiles/${profile.id}/portal-access`, {
      enabled: enable,
    });
    toast(enable ? "Portal access enabled" : "Portal access disabled", "success");
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
let profileMode = "ask";

function setProfileMode(mode) {
  profileMode = mode;
  const ask = mode === "ask";
  named(profileForm, "name").classList.toggle("wide", !ask);
  $("#profile-manual").hidden = ask;
  const phone = $("#profile-phone");
  phone.hidden = !ask;
  phone.disabled = !ask;
  phone.required = ask;
  for (const input of $("#profile-manual").querySelectorAll("sl-input, sl-checkbox")) {
    input.disabled = ask;
    if (input.name === "visaEmail" || input.name === "visaProcessId") {
      input.required = !ask;
    }
  }
  $("#profile-show-manual").hidden = !ask;
  $("#profile-send-whatsapp").hidden = !ask;
  $("#profile-save").hidden = ask;
  $("#profile-show-ask").hidden = ask || !!editingProfile;
  $("#profile-send-whatsapp").type = ask ? "submit" : "button";
  $("#profile-save").type = ask ? "button" : "submit";
  const password = named(profileForm, "visaPassword");
  password.required = !ask && !editingProfile?.hasPassword;
  password.placeholder =
    !ask && editingProfile?.hasPassword
      ? "Leave empty to keep the stored password"
      : "";

  const hint = $("#profile-intake-hint");
  if (editingProfile && intakeOpen(editingProfile)) {
    const phase = intakePhaseLabel(editingProfile);
    hint.hidden = false;
    hint.textContent = editingProfile.intakeError
      ? `${phase}. ${editingProfile.intakeError} You can also fill this form and save.`
      : `${phase}. You can also fill this form and save.`;
  } else {
    hint.hidden = true;
    hint.textContent = "";
  }
}

function openProfile(profile) {
  editingProfile = profile || null;
  profileForm.reset();
  setError(profileForm);
  profileDialog.label = profile ? `Edit ${profile.name}` : "New profile";

  const values = profile || {
    actions: ["notify"],
    enabled: false,
  };
  for (const field of [
    "name",
    "visaProcessId",
    "visaEmail",
    "emailDestination",
    "whatsappDestination",
    "minDate",
    "maxDate",
  ]) {
    named(profileForm, field).value = values[field] ?? "";
  }
  for (const checkbox of actionCheckboxes(profileForm)) {
    checkbox.checked = values.actions.includes(checkbox.value);
  }
  named(profileForm, "enabled").checked = !!values.enabled;
  named(profileForm, "contactPhone").value = displayPhone(values.contactPhone);

  const testTip = $("#test-profile-notification-tip");
  testTip.hidden = !profile || intakeOpen(profile);
  setProfileMode(profile ? "manual" : "ask");

  profileDialog.show();
}

$("#profile-show-manual").addEventListener("click", () => setProfileMode("manual"));
$("#profile-show-ask").addEventListener("click", () => setProfileMode("ask"));

$("#new-profile").addEventListener("click", () => openProfile(null));

profileForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  setError(profileForm);
  const form = profileForm;
  if (profileMode === "ask") {
    const sendButton = $("#profile-send-whatsapp");
    if (sendButton.loading) return;
    const name = named(form, "name").value.trim();
    sendButton.loading = true;
    sendButton.disabled = true;
    sendButton.textContent = "Sending…";
    const notice = toast(
      name ? `Sending message to ${name}` : "Sending WhatsApp message",
      "primary",
      Infinity,
    );
    try {
      const created = await api("POST", "/api/profiles/intake", {
        name: named(form, "name").value,
        phone: named(form, "contactPhone").value,
      });
      notice.hide();
      profileDialog.hide();
      toast(
        created.intakeError || (name ? `Message sent to ${name}` : "WhatsApp sent"),
        created.intakeError ? "danger" : "success",
      );
      refresh();
    } catch (error) {
      notice.hide();
      setError(profileForm, error.message);
    } finally {
      sendButton.loading = false;
      sendButton.disabled = false;
      sendButton.textContent = "Send WhatsApp";
    }
    return;
  }
  const actions = actionCheckboxes(form)
    .filter((checkbox) => checkbox.checked)
    .map((checkbox) => checkbox.value);

  if (
    actions.includes("reschedule") &&
    !(editingProfile?.actions || []).includes("reschedule") &&
    !(await confirmAction(
      "Automatic rescheduling is experimental and will book the first matching date without asking. Continue?",
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
    whatsappDestination: named(form, "whatsappDestination").value,
    minDate: named(form, "minDate").value || null,
    maxDate: named(form, "maxDate").value || null,
    actions,
    enabled: named(form, "enabled").checked,
  };

  const turningOn =
    body.enabled && (!editingProfile || !editingProfile.enabled);
  try {
    if (turningOn) toast("Checking AIS account…");
    if (editingProfile) {
      await api("PUT", `/api/profiles/${editingProfile.id}`, body);
    } else {
      await api("POST", "/api/profiles", body);
    }
    profileDialog.hide();
    refresh();
  } catch (error) {
    setError(profileForm, error.message);
    // Create/update may have saved a disabled profile before enable failed.
    refresh();
  }
});

function notificationChannelLabel(channel) {
  return channel === "whatsapp" ? "WhatsApp" : "email";
}

$("#test-profile-notification").addEventListener("click", async () => {
  if (!editingProfile) return;
  const button = $("#test-profile-notification");
  setError(profileForm);
  button.loading = true;
  try {
    const result = await api(
      "POST",
      `/api/profiles/${editingProfile.id}/test-notification`,
      {
        emailDestination: named(profileForm, "emailDestination").value,
        whatsappDestination: named(profileForm, "whatsappDestination").value,
      },
    );
    const channels = result.channels || [];
    const sent = channels.filter((channel) => channel.status === "sent");
    const failed = channels.filter((channel) => channel.status !== "sent");
    if (!failed.length) {
      toast("Test notification sent", "success");
      return;
    }
    const detail = failed
      .map(
        (channel) =>
          `${notificationChannelLabel(channel.channel)}: ${channel.error || "failed"}`,
      )
      .join(". ");
    if (sent.length) {
      const sentLabel = sent
        .map((channel) => notificationChannelLabel(channel.channel))
        .join(" and ");
      toast(`Sent by ${sentLabel}. ${detail}`, "warning");
    }
    setError(profileForm, detail);
  } catch (error) {
    setError(profileForm, error.message);
  } finally {
    button.loading = false;
  }
});

// ---- Settings dialog ----

const settingsDialog = $("#settings-dialog");
const settingsForm = $("#settings-form");

async function refreshTotpSettingsUi() {
  const statusEl = $("#totp-status");
  const setupPanel = $("#totp-setup-panel");
  const disablePanel = $("#totp-disable-panel");
  const actions = $("#totp-actions");
  const beginBtn = $("#totp-begin-setup");
  const disableBtn = $("#totp-disable");
  setupPanel.hidden = true;
  disablePanel.hidden = true;
  actions.hidden = false;
  try {
    const status = await api("GET", "/api/admin/totp");
    if (status.enabled) {
      statusEl.textContent = "Authenticator is enabled. Admin sign-in requires a code.";
      beginBtn.textContent = "Replace authenticator";
      beginBtn.hidden = false;
      disableBtn.hidden = false;
    } else {
      statusEl.textContent = "Authenticator is off. Admin sign-in uses password only.";
      beginBtn.textContent = "Set up authenticator";
      beginBtn.hidden = false;
      disableBtn.hidden = true;
    }
  } catch (error) {
    statusEl.textContent = error.message || "Could not load authenticator status";
    beginBtn.hidden = true;
    disableBtn.hidden = true;
  }
}

$("#open-settings").addEventListener("click", async () => {
  settingsForm.reset();
  setError(settingsForm);
  await refreshTotpSettingsUi();
  const settings = await api("GET", "/api/settings");
  for (const field of [
    "gmailUser",
    "emailAdminDestination",
    "openwaSessionId",
    "whatsappAdminDestination",
    "intervalMinutes",
    "maxConcurrentRuns",
    "runTimeoutMinutes",
    "failureAlarmThreshold",
    "publicBaseUrl",
  ]) {
    named(settingsForm, field).value = settings[field] ?? "";
  }
  named(settingsForm, "gmailAppPassword").placeholder = settings.hasGmailAppPassword
    ? "Leave empty to keep the stored password"
    : "Not set";
  named(settingsForm, "heartbeatEnabled").checked = !!settings.heartbeatEnabled;
  named(settingsForm, "heartbeatTime").value = utcTimeToLocal(
    settings.heartbeatTimeUtc || "00:00",
  );
  syncHeartbeatTimeHint();
  named(settingsForm, "emailEnabled").checked = !!settings.emailEnabled;
  named(settingsForm, "whatsappEnabled").checked = !!settings.whatsappEnabled;
  named(settingsForm, "botDebug").checked = !!settings.botDebug;
  $("#last-heartbeat").textContent = lastHeartbeatLabel(settings.lastHeartbeatAt);
  resetOpenwaLinkUi();
  $("sl-tab-group", settingsForm)?.show("notifications");
  settingsDialog.show();
  if (settings.whatsappGatewayReady && settings.openwaSessionId) {
    refreshOpenwaStatus().catch(() => {});
  }
});

function lastHeartbeatLabel(iso) {
  if (!iso) return "Last sent: never";
  return `Last sent: ${formatTimestamp(iso)} (${relativeTime(iso)})`;
}

function pad2(value) {
  return String(value).padStart(2, "0");
}

function utcTimeToLocal(utc) {
  const match = /^(\d{2}):(\d{2})/.exec(utc || "");
  if (!match) return "";
  const now = new Date();
  const instant = new Date(
    Date.UTC(
      now.getUTCFullYear(),
      now.getUTCMonth(),
      now.getUTCDate(),
      Number(match[1]),
      Number(match[2]),
    ),
  );
  return `${pad2(instant.getHours())}:${pad2(instant.getMinutes())}`;
}

function localTimeToUtc(local) {
  const match = /^(\d{2}):(\d{2})/.exec(local || "");
  if (!match) return "00:00";
  const now = new Date();
  const instant = new Date(
    now.getFullYear(),
    now.getMonth(),
    now.getDate(),
    Number(match[1]),
    Number(match[2]),
    0,
    0,
  );
  return `${pad2(instant.getUTCHours())}:${pad2(instant.getUTCMinutes())}`;
}

function syncHeartbeatTimeHint() {
  const local = named(settingsForm, "heartbeatTime").value;
  const utc = localTimeToUtc(local);
  $("#heartbeat-time-utc").textContent = local
    ? `Sends at ${utc} UTC`
    : "Empty uses 00:00 UTC";
}

named(settingsForm, "heartbeatTime").addEventListener("sl-input", syncHeartbeatTimeHint);
named(settingsForm, "heartbeatTime").addEventListener("sl-change", syncHeartbeatTimeHint);

let openwaPollTimer = 0;

function openwaAuthPayload() {
  const form = settingsForm;
  return {
    openwaSessionId: named(form, "openwaSessionId").value,
  };
}

function stopOpenwaPoll() {
  if (openwaPollTimer) {
    clearTimeout(openwaPollTimer);
    openwaPollTimer = 0;
  }
}

function resetOpenwaLinkUi() {
  stopOpenwaPoll();
  $("#openwa-session-status").textContent = "Not linked";
  $("#openwa-qr-panel").hidden = true;
  $("#openwa-qr").removeAttribute("src");
}

function openwaStatusLabel(session) {
  const status = String(session?.status || "").toLowerCase();
  if (status === "ready") {
    return session.phone
      ? `Linked · ${session.phone}${session.pushName ? ` (${session.pushName})` : ""}`
      : "Linked";
  }
  if (status === "qr_ready") return "Scan the QR code with WhatsApp";
  if (status === "authenticating") return "QR scanned · finishing link…";
  if (status === "initializing") return "Starting WhatsApp session…";
  if (status === "action_required") {
    return session.lastError || "WhatsApp needs a tap on the phone";
  }
  if (status === "failed") return session.lastError || "Link failed";
  if (status === "disconnected") return "Disconnected · click Link WhatsApp";
  return status ? `Session: ${status}` : "Not linked";
}

function applyOpenwaLink(result) {
  if (result?.session?.id) {
    named(settingsForm, "openwaSessionId").value = result.session.id;
  }
  $("#openwa-session-status").textContent = openwaStatusLabel(result?.session);
  const qr = $("#openwa-qr");
  const panel = $("#openwa-qr-panel");
  if (result?.qrCode) {
    qr.src = result.qrCode;
    panel.hidden = false;
  } else {
    qr.removeAttribute("src");
    panel.hidden = true;
  }
  const status = String(result?.session?.status || "").toLowerCase();
  return status === "ready" || status === "failed";
}

function scheduleOpenwaPoll(remaining) {
  stopOpenwaPoll();
  if (remaining <= 0) {
    $("#openwa-session-status").textContent = "Still waiting for a scan. Click Link WhatsApp to refresh the QR.";
    return;
  }
  openwaPollTimer = window.setTimeout(async () => {
    try {
      const result = await api("POST", "/api/settings/openwa/session/status", openwaAuthPayload());
      if (!applyOpenwaLink(result)) scheduleOpenwaPoll(remaining - 1);
    } catch (error) {
      setError(settingsForm, error.message);
    }
  }, 2000);
}

async function refreshOpenwaStatus() {
  const result = await api("POST", "/api/settings/openwa/session/status", openwaAuthPayload());
  applyOpenwaLink(result);
}

$("#link-openwa").addEventListener("click", async () => {
  const button = $("#link-openwa");
  setError(settingsForm);
  button.loading = true;
  stopOpenwaPoll();
  try {
    const result = await api("POST", "/api/settings/openwa/session", openwaAuthPayload());
    if (!applyOpenwaLink(result)) scheduleOpenwaPoll(60);
    else if (result.session?.status === "ready") toast("WhatsApp is linked", "success");
  } catch (error) {
    setError(settingsForm, error.message);
  } finally {
    button.loading = false;
  }
});

settingsDialog.addEventListener("sl-hide", stopOpenwaPoll);

function settingsTestPayload(channel) {
  const form = settingsForm;
  return {
    channel,
    gmailUser: named(form, "gmailUser").value,
    gmailAppPassword: named(form, "gmailAppPassword").value || undefined,
    emailAdminDestination: named(form, "emailAdminDestination").value,
    openwaSessionId: named(form, "openwaSessionId").value,
    whatsappAdminDestination: named(form, "whatsappAdminDestination").value,
  };
}

const NOTIFICATION_METHOD_REQUIRED =
  "At least one notification method must stay enabled";

function notificationMethodsEnabled() {
  return (
    named(settingsForm, "emailEnabled").checked ||
    named(settingsForm, "whatsappEnabled").checked
  );
}

let revertingNotificationMethod = false;

function guardNotificationMethods(changed) {
  if (revertingNotificationMethod) return true;
  if (notificationMethodsEnabled()) return true;
  revertingNotificationMethod = true;
  changed.checked = true;
  revertingNotificationMethod = false;
  setError(settingsForm, NOTIFICATION_METHOD_REQUIRED);
  const body = settingsDialog.shadowRoot?.querySelector(".dialog__body");
  if (body) body.scrollTop = body.scrollHeight;
  return false;
}

for (const name of ["emailEnabled", "whatsappEnabled"]) {
  named(settingsForm, name).addEventListener("sl-change", (event) => {
    guardNotificationMethods(event.target);
  });
}

async function sendNotificationTest(channel, button) {
  setError(settingsForm);
  const method = named(
    settingsForm,
    channel === "whatsapp" ? "whatsappEnabled" : "emailEnabled",
  );
  if (!method.checked) {
    setError(
      settingsForm,
      channel === "whatsapp"
        ? "WhatsApp notifications are turned off"
        : "Email notifications are turned off",
    );
    return;
  }
  button.loading = true;
  try {
    await api("POST", "/api/settings/test-notification", settingsTestPayload(channel));
    toast(
      channel === "whatsapp" ? "WhatsApp test sent" : "Email test sent",
      "success",
    );
  } catch (error) {
    setError(settingsForm, error.message);
  } finally {
    button.loading = false;
  }
}

$("#totp-begin-setup").addEventListener("click", async () => {
  setError(settingsForm);
  const button = $("#totp-begin-setup");
  button.loading = true;
  try {
    const result = await api("POST", "/api/admin/totp/setup", {});
    $("#totp-qr").src = result.qrDataUrl;
    $("#totp-secret").textContent = result.secret;
    $("#totp-confirm-code").value = "";
    $("#totp-setup-panel").hidden = false;
    $("#totp-disable-panel").hidden = true;
    $("#totp-actions").hidden = true;
    $("#totp-status").textContent =
      "Scan the QR with your authenticator app, then enter a code to enable.";
  } catch (error) {
    setError(settingsForm, error.message);
  } finally {
    button.loading = false;
  }
});

$("#totp-cancel-setup").addEventListener("click", async () => {
  setError(settingsForm);
  $("#totp-setup-panel").hidden = true;
  $("#totp-actions").hidden = false;
  await refreshTotpSettingsUi();
});

$("#totp-confirm").addEventListener("click", async () => {
  setError(settingsForm);
  const button = $("#totp-confirm");
  button.loading = true;
  try {
    await api("POST", "/api/admin/totp/confirm", {
      code: $("#totp-confirm-code").value,
    });
    $("#totp-setup-panel").hidden = true;
    $("#totp-actions").hidden = false;
    toast("Authenticator enabled", "success");
    await refreshTotpSettingsUi();
  } catch (error) {
    setError(settingsForm, error.message);
  } finally {
    button.loading = false;
  }
});

$("#totp-disable").addEventListener("click", () => {
  setError(settingsForm);
  named(settingsForm, "totpDisablePassword").value = "";
  named(settingsForm, "totpDisableCode").value = "";
  $("#totp-disable-panel").hidden = false;
  $("#totp-setup-panel").hidden = true;
  $("#totp-actions").hidden = true;
});

$("#totp-disable-cancel").addEventListener("click", async () => {
  $("#totp-disable-panel").hidden = true;
  $("#totp-actions").hidden = false;
  await refreshTotpSettingsUi();
});

$("#totp-disable-confirm").addEventListener("click", async () => {
  setError(settingsForm);
  const button = $("#totp-disable-confirm");
  button.loading = true;
  try {
    await api("POST", "/api/admin/totp/disable", {
      password: named(settingsForm, "totpDisablePassword").value,
      code: named(settingsForm, "totpDisableCode").value,
    });
    $("#totp-disable-panel").hidden = true;
    $("#totp-actions").hidden = false;
    toast("Authenticator disabled", "success");
    await refreshTotpSettingsUi();
  } catch (error) {
    setError(settingsForm, error.message);
  } finally {
    button.loading = false;
  }
});

$("#test-email").addEventListener("click", () => {
  sendNotificationTest("email", $("#test-email"));
});

$("#test-whatsapp").addEventListener("click", () => {
  sendNotificationTest("whatsapp", $("#test-whatsapp"));
});

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
  if (!notificationMethodsEnabled()) {
    setError(form, NOTIFICATION_METHOD_REQUIRED);
    return;
  }
  try {
    await api("PUT", "/api/settings", {
      gmailUser: named(form, "gmailUser").value,
      gmailAppPassword: named(form, "gmailAppPassword").value || undefined,
      emailAdminDestination: named(form, "emailAdminDestination").value,
      emailEnabled: named(form, "emailEnabled").checked,
      openwaSessionId: named(form, "openwaSessionId").value,
      whatsappAdminDestination: named(form, "whatsappAdminDestination").value,
      whatsappEnabled: named(form, "whatsappEnabled").checked,
      intervalMinutes: Number(named(form, "intervalMinutes").value),
      heartbeatEnabled: named(form, "heartbeatEnabled").checked,
      heartbeatTimeUtc: localTimeToUtc(named(form, "heartbeatTime").value),
      maxConcurrentRuns: Number(named(form, "maxConcurrentRuns").value),
      runTimeoutMinutes: Number(named(form, "runTimeoutMinutes").value),
      failureAlarmThreshold: Number(named(form, "failureAlarmThreshold").value),
      botDebug: named(form, "botDebug").checked,
      publicBaseUrl: named(form, "publicBaseUrl").value,
    });
    settingsDialog.hide();
    refresh();
  } catch (error) {
    setError(form, error.message);
  }
});

// ---- Portal audit ----

const portalAuditDialog = $("#portal-audit-dialog");

async function openPortalAudit() {
  const select = $("#audit-profile");
  const current = select.value || "any";
  select.replaceChildren(el("sl-option", { value: "any" }, "All profiles"));
  for (const profile of profiles) {
    select.append(el("sl-option", { value: String(profile.id) }, profile.name));
  }
  select.value = current;
  await loadPortalAudit();
  portalAuditDialog.show();
}

async function loadPortalAudit() {
  const params = new URLSearchParams({ limit: "200" });
  const profileId = $("#audit-profile").value;
  const action = $("#audit-action").value;
  if (profileId && profileId !== "any") params.set("profileId", profileId);
  if (action && action !== "any") params.set("action", action);
  const data = await api("GET", `/api/portal-audit?${params}`);
  const tbody = $("#portal-audit-rows");
  const rows = data.audits || [];
  tbody.replaceChildren(
    ...rows.map((row) =>
      el(
        "tr",
        {},
        el("td", { class: "nowrap" }, formatTimestamp(row.createdAt)),
        el("td", {}, row.profileName || (row.profileId != null ? `#${row.profileId}` : "—")),
        el("td", {}, row.actor),
        el("td", {}, row.action),
        el(
          "td",
          { class: "sub" },
          row.detail ? JSON.stringify(row.detail) : "—",
        ),
      ),
    ),
  );
  if (!rows.length) {
    tbody.append(
      el("tr", {}, el("td", { colspan: "5", class: "hint" }, "No audit events")),
    );
  }
}

$("#open-portal-audit").addEventListener("click", () => {
  openPortalAudit().catch((error) => toast(error.message));
});
$("#audit-refresh").addEventListener("click", () => {
  loadPortalAudit().catch((error) => toast(error.message));
});
$("#audit-profile").addEventListener("sl-change", () => {
  loadPortalAudit().catch((error) => toast(error.message));
});
$("#audit-action").addEventListener("sl-change", () => {
  loadPortalAudit().catch((error) => toast(error.message));
});

// ---- Runs dialog ----

const runsDialog = $("#runs-dialog");
const datesDialog = $("#dates-dialog");
const errorDialog = $("#error-dialog");
const runsFrom = $("#runs-from");
const runsTo = $("#runs-to");
const runsProfile = $("#runs-profile");
const runsNotified = $("#runs-notified");
const runsOrder = $("#runs-order");
const runsClearFilter = $("#runs-clear-filter");
let runsCache = [];
let runsNotifiedMeta = { count: 0, firstAt: null, lastAt: null };
let runsProfileId = null;
let runsAllMode = false;
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
      (runsAllMode && runsProfile.value !== "any") ||
      runsNotified.value !== "any" ||
      runsOrder.value !== "desc",
  );
}

function updateRunsClearButton() {
  runsClearFilter.disabled = !runsFilterActive();
}

let datesCursor = { year: new Date().getFullYear(), month: new Date().getMonth() };
let datesAvailable = new Set();
let datesProfile = null;
let datesSelected = null;

function isoYearMonth(iso) {
  const [year, month] = String(iso || "").split("-").map(Number);
  if (!year || !month) return null;
  return { year, month: month - 1 };
}

function monthIndex(year, month) {
  return year * 12 + month;
}

function datesBookedIso() {
  return datesProfile?.currentAppointmentDate || null;
}

function datesOutsideMonth(cursor, direction) {
  const current = monthIndex(cursor.year, cursor.month);
  let count = 0;
  const marks = new Set(datesAvailable);
  const booked = datesBookedIso();
  if (booked) marks.add(booked);
  for (const iso of marks) {
    const ym = isoYearMonth(iso);
    if (!ym) continue;
    const key = monthIndex(ym.year, ym.month);
    if (direction < 0 && key < current) count += 1;
    if (direction > 0 && key > current) count += 1;
  }
  return count;
}

function markDatesNav(button, count, earlier) {
  const base = earlier ? "Previous" : "Next";
  button.textContent = count ? `${base} · ${count}` : base;
  button.classList.toggle("has-more", count > 0);
  button.title = count
    ? `${count} matching ${count === 1 ? "date" : "dates"} in ${
        earlier ? "earlier" : "later"
      } months`
    : "";
}

function syncDatesTakeButton() {
  const button = $("#dates-take");
  if (!button) return;
  button.disabled = !datesSelected || !datesProfile;
}

function renderDatesCalendar() {
  const { year, month } = datesCursor;
  $("[data-dates-title]", datesDialog).textContent = new Date(
    year,
    month,
    1,
  ).toLocaleDateString("en-US", { month: "long", year: "numeric" });
  const count = datesAvailable.size;
  const selectedLabel = datesSelected
    ? formatDate(datesSelected) || datesSelected
    : "";
  $("[data-dates-hint]", datesDialog).textContent = selectedLabel
    ? `Selected ${selectedLabel}`
    : count
      ? `${count} matching ${count === 1 ? "date" : "dates"} — select one to take`
      : "No dates";
  markDatesNav($("#dates-prev"), datesOutsideMonth(datesCursor, -1), true);
  markDatesNav($("#dates-next"), datesOutsideMonth(datesCursor, 1), false);
  const today = localIsoDate();
  const booked = datesBookedIso();
  const nodes = WEEKDAYS.map((label) => el("div", { class: "calendar-weekday" }, label));
  for (const cell of monthCells(year, month)) {
    const hit = datesAvailable.has(cell.iso);
    const isBooked = booked === cell.iso;
    const selected = hit && datesSelected === cell.iso;
    const titleParts = [];
    if (hit) titleParts.push(formatDate(cell.iso) || cell.iso);
    if (isBooked) titleParts.push("Current appointment");
    const node = el(
      "div",
      {
        class: `calendar-cell${cell.outside ? " outside" : ""}${
          cell.iso === today ? " today" : ""
        }${hit ? " hit" : ""}${isBooked ? " booked" : ""}${
          selected ? " selected" : ""
        }`,
        title: titleParts.join(" · "),
      },
      el("div", { class: "calendar-daynum" }, String(cell.day)),
    );
    if (hit) {
      node.addEventListener("click", () => {
        datesSelected = cell.iso;
        renderDatesCalendar();
      });
    }
    nodes.push(node);
  }
  $("[data-dates]", datesDialog).replaceChildren(...nodes);
  syncDatesTakeButton();
}

function shiftDatesCalendar(delta) {
  const date = new Date(datesCursor.year, datesCursor.month + delta, 1);
  datesCursor = { year: date.getFullYear(), month: date.getMonth() };
  renderDatesCalendar();
}

function openAvailableDates(profile, dates) {
  datesProfile = profile;
  datesSelected = null;
  datesAvailable = new Set((dates || []).filter(Boolean));
  const first = [...datesAvailable].sort()[0];
  datesCursor = isoYearMonth(first) || {
    year: new Date().getFullYear(),
    month: new Date().getMonth(),
  };
  datesDialog.show();
  renderDatesCalendar();
}

async function takeSelectedDate() {
  if (!datesProfile || !datesSelected) return;
  const label = formatDate(datesSelected) || datesSelected;
  if (
    !(await confirmAction(
      `Reschedule "${datesProfile.name}" to ${label}? The bot will log into AIS and update the appointment if that date is still available.`,
      { okLabel: "Take this date", variant: "warning" },
    ))
  ) {
    return;
  }
  const profileId = datesProfile.id;
  const date = datesSelected;
  try {
    await api("POST", `/api/profiles/${profileId}/reschedule`, { date });
    datesDialog.hide();
    toast(`Reschedule queued for ${label}`, "success");
  } catch (error) {
    toast(error.message);
  }
  refresh();
}

$("#dates-prev").addEventListener("click", () => shiftDatesCalendar(-1));
$("#dates-next").addEventListener("click", () => shiftDatesCalendar(1));
$("#dates-today").addEventListener("click", () => {
  const now = new Date();
  datesCursor = { year: now.getFullYear(), month: now.getMonth() };
  renderDatesCalendar();
});
$("#dates-take").addEventListener("click", () => {
  void takeSelectedDate();
});

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
  if (run.profileName) rows.push(["Profile", run.profileName]);
  if (!result) {
    rows.push(["Status", run.status]);
  } else {
    if (result.error) rows.push(["Error", result.error]);
    rows.push(["Booked appointment", formatDate(result.currentAppointment) || "—"]);
    if (result.visaClasses?.length) {
      const counts = new Map();
      for (const code of result.visaClasses) {
        counts.set(code, (counts.get(code) || 0) + 1);
      }
      const fingerprint = [...counts.keys()]
        .sort((a, b) => a.localeCompare(b))
        .map((code) => `${code}x${counts.get(code)}`)
        .join(",");
      rows.push(["Visa classes", formatVisaFingerprint(fingerprint)]);
    }
    if (result.dates?.length) {
      rows.push(["Dates", result.dates.map((iso) => formatDate(iso) || iso).join(", ")]);
    }
    const limitLabel = rescheduleLimitLabel(
      result.rescheduleLimit?.remaining,
      result.rescheduleLimit?.maximum,
    );
    if (limitLabel) rows.push(["Reschedules", limitLabel]);
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
  const decided = ok + bad;
  const parts = [];
  if (decided) {
    parts.push(`${ok} succeeded (${Math.round((ok / decided) * 100)}%)`);
    parts.push(`${bad} errored (${Math.round((bad / decided) * 100)}%)`);
  } else {
    parts.push(`${ok} succeeded`);
    parts.push(`${bad} errored`);
  }
  if (other) parts.push(`${other} other`);
  const summary = parts.join(" · ");
  $("[data-runs-mix-legend]", root).textContent = summary;
  $("[data-runs-mix-bar]", root).setAttribute("aria-label", parts.join(", "));
  root.hidden = false;
}

function renderRunRows(emptyMessage) {
  renderNotifiedRange();
  renderRunsMix();
  const showProfile = runsAllMode;
  const cols = showProfile ? 5 : 4;
  const head = $("[data-runs-head]", runsDialog);
  head.replaceChildren(
    el(
      "tr",
      {},
      el("th", {}, "When"),
      showProfile ? el("th", {}, "Profile") : null,
      el("th", {}, "Result"),
      el("th", {}, "Trigger"),
      el("th", {}, "Duration"),
    ),
  );
  const body = $("[data-runs]", runsDialog);
  if (!runsCache.length) {
    body.replaceChildren(
      el(
        "tr",
        {},
        el(
          "td",
          { class: "sub", colspan: String(cols) },
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
        showProfile ? el("td", {}, run.profileName || el("span", { class: "hint" }, "—")) : null,
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
          el("td", { colspan: String(cols) }, resultDetail(expandedRun || run)),
        ),
      );
    }
  }
  body.replaceChildren(...nodes);
}

async function loadRuns() {
  if (!runsAllMode && !runsProfileId) return;
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
  let path = `/api/profiles/${runsProfileId}/runs`;
  if (runsAllMode) {
    path = "/api/runs";
    if (runsProfile.value !== "any") params.set("profileId", runsProfile.value);
  }
  const gen = ++runsLoadGen;
  try {
    const data = await api("GET", `${path}?${params}`);
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

function fillRunsProfileSelect() {
  const current = runsProfile.value || "any";
  runsProfile.replaceChildren(
    el("sl-option", { value: "any" }, "All profiles"),
    ...sortedProfiles().map((profile) =>
      el("sl-option", { value: String(profile.id) }, profile.name),
    ),
  );
  runsProfile.value = [...runsProfile.querySelectorAll("sl-option")].some(
    (option) => option.value === current,
  )
    ? current
    : "any";
}

function resetRunsFilters({ keepRange = false } = {}) {
  if (!keepRange) {
    runsFrom.value = "";
    runsTo.value = "";
  }
  runsProfile.value = "any";
  runsNotified.value = "any";
  runsOrder.value = "desc";
  updateRunsClearButton();
}

function prepareRunsDialog() {
  expandedRunId = null;
  expandedRun = null;
  const range = last24HoursRange();
  runsFrom.value = range.from;
  runsTo.value = range.to;
  resetRunsFilters({ keepRange: true });
}

async function openRuns(profile) {
  runsAllMode = false;
  runsProfileId = profile.id;
  runsProfile.hidden = true;
  prepareRunsDialog();
  runsDialog.label = `Runs — ${profile.name}`;
  runsDialog.show();
  await loadRuns();
}

async function openAllRuns() {
  runsAllMode = true;
  runsProfileId = null;
  fillRunsProfileSelect();
  runsProfile.hidden = false;
  prepareRunsDialog();
  runsDialog.label = "All runs";
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
runsProfile.addEventListener("sl-change", () => {
  updateRunsClearButton();
  loadRuns();
});
runsClearFilter.addEventListener("click", () => {
  resetRunsFilters();
  loadRuns();
});
$("#open-all-runs").addEventListener("click", () => openAllRuns());

// ---- Notifications dialog ----

const notesDialog = $("#notifications-dialog");
const notesFrom = $("#notes-from");
const notesTo = $("#notes-to");
const notesKind = $("#notes-kind");
const notesStatus = $("#notes-status");
const notesChannel = $("#notes-channel");
const notesClearFilter = $("#notes-clear-filter");
let notesCache = [];
let notesLoadGen = 0;
let expandedNoteId = null;

function notificationKindBadge(kind) {
  if (kind === "heartbeat") return badge("heartbeat", "info");
  if (kind === "failure") return badge("failure", "bad");
  if (kind === "test") return badge("test", "muted");
  if (kind === "intake") return badge("intake", "warn");
  return badge("appointment", "warn");
}

function notesFilterActive() {
  return Boolean(
    notesFrom.value ||
      notesTo.value ||
      notesKind.value !== "any" ||
      notesStatus.value !== "any" ||
      notesChannel.value !== "any",
  );
}

function updateNotesClearButton() {
  notesClearFilter.disabled = !notesFilterActive();
}

function notificationDetail(note) {
  const rows = [
    ["Recipients", note.recipients || "—"],
    ["Subject", note.subject || "—"],
  ];
  if (note.error) {
    rows.push([note.status === "skipped" ? "Reason" : "Error", note.error]);
  }
  return el(
    "table",
    { class: "run-result" },
    ...rows.map(([label, value]) => el("tr", {}, el("th", {}, label), el("td", {}, value))),
  );
}

function renderNotificationRows(emptyMessage) {
  const body = $("[data-notifications]", notesDialog);
  if (!notesCache.length) {
    body.replaceChildren(
      el(
        "tr",
        {},
        el(
          "td",
          { class: "sub", colspan: "5" },
          emptyMessage || (notesFilterActive() ? "No notifications in this range" : "No notifications yet"),
        ),
      ),
    );
    return;
  }
  const nodes = [];
  for (const note of notesCache) {
    const expanded = expandedNoteId === note.id;
    nodes.push(
      el(
        "tr",
        { class: expanded ? "clickable expanded" : "clickable", onclick: () => toggleNotification(note) },
        el("td", { class: "mono nowrap" }, formatTimestamp(note.sentAt)),
        el("td", {}, notificationKindBadge(note.kind)),
        el("td", {}, badge(note.channel || "email", note.channel === "whatsapp" ? "ok" : "info")),
        el("td", {}, note.profileName || el("span", { class: "hint" }, "—")),
        el(
          "td",
          {},
          badge(
            note.status,
            note.status === "sent" ? "ok" : note.status === "skipped" ? "muted" : "bad",
          ),
        ),
      ),
    );
    if (expanded) {
      nodes.push(
        el(
          "tr",
          { class: "run-detail" },
          el("td", { colspan: "5" }, notificationDetail(note)),
        ),
      );
    }
  }
  body.replaceChildren(...nodes);
}

async function loadNotifications() {
  const from = localDateTimeToIso(notesFrom.value);
  const to = localDateTimeToIso(notesTo.value, true);
  if (from && to && from > to) {
    notesCache = [];
    renderNotificationRows("From must be before To");
    return;
  }
  const params = new URLSearchParams({
    limit: notesFilterActive() ? "500" : "100",
  });
  if (from) params.set("from", from);
  if (to) params.set("to", to);
  if (notesKind.value !== "any") params.set("kind", notesKind.value);
  if (notesStatus.value !== "any") params.set("status", notesStatus.value);
  if (notesChannel.value !== "any") params.set("channel", notesChannel.value);
  const gen = ++notesLoadGen;
  try {
    const data = await api("GET", `/api/notifications?${params}`);
    if (gen !== notesLoadGen) return;
    notesCache = data.notifications || [];
    renderNotificationRows();
  } catch (error) {
    if (gen !== notesLoadGen) return;
    notesCache = [];
    renderNotificationRows(error.message);
  }
}

function resetNotesFilters({ keepRange = false } = {}) {
  if (!keepRange) {
    notesFrom.value = "";
    notesTo.value = "";
  }
  notesKind.value = "any";
  notesStatus.value = "any";
  notesChannel.value = "any";
  updateNotesClearButton();
}

async function openNotifications() {
  expandedNoteId = null;
  const range = last24HoursRange();
  notesFrom.value = range.from;
  notesTo.value = range.to;
  resetNotesFilters({ keepRange: true });
  notesDialog.show();
  await loadNotifications();
}

function toggleNotification(note) {
  expandedNoteId = expandedNoteId === note.id ? null : note.id;
  renderNotificationRows();
}

$("#open-notifications").addEventListener("click", () => openNotifications());

// ---- Calendar dialog ----

const calendarDialog = $("#calendar-dialog");
const PROFILE_COLORS = [
  "#2457d6",
  "#0f766e",
  "#a15c07",
  "#7c3aed",
  "#b42318",
  "#1d4ed8",
  "#c2410c",
  "#be185d",
  "#365314",
  "#0369a1",
];
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
let calendarCursor = { year: new Date().getFullYear(), month: new Date().getMonth() };

function profileColorIndex(id) {
  return Math.abs(Number(id) || 0) % PROFILE_COLORS.length;
}

function chipClass(id, extra = "") {
  return `calendar-chip tone-${profileColorIndex(id)}${extra ? ` ${extra}` : ""}`;
}

function addIsoDays(iso, days) {
  const [year, month, day] = iso.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day + days));
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}-${String(
    date.getUTCDate(),
  ).padStart(2, "0")}`;
}

function localIsoDate(date = new Date()) {
  const pad = (n) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function profileSearchRange(profile) {
  const booked = profile.currentAppointmentDate || null;
  if (profile.maxDate) {
    return { start: profile.minDate || null, end: profile.maxDate, booked, unknown: false };
  }
  if (!booked) {
    return { start: null, end: null, booked: null, unknown: true };
  }
  return {
    start: profile.minDate || null,
    end: addIsoDays(booked, -1),
    booked,
    unknown: false,
  };
}

function isoInWindow(iso, range) {
  if (range.unknown || !range.end) return false;
  if (range.start && iso < range.start) return false;
  return iso <= range.end;
}

function windowLabel(range) {
  if (range.unknown) return "no window yet";
  if (range.start && range.end && range.start > range.end) return "empty window";
  const start = formatDate(range.start) || "…";
  const end = formatDate(range.end) || "…";
  return `${start} – ${end}`;
}

function monthCells(year, month) {
  const first = new Date(year, month, 1);
  const start = new Date(year, month, 1 - first.getDay());
  const cells = [];
  for (let i = 0; i < 42; i++) {
    const date = new Date(start.getFullYear(), start.getMonth(), start.getDate() + i);
    cells.push({
      iso: localIsoDate(date),
      day: date.getDate(),
      outside: date.getMonth() !== month,
    });
  }
  while (cells.length > 7 && cells.slice(-7).every((cell) => cell.outside)) {
    cells.splice(-7, 7);
  }
  return cells;
}

function renderCalendar() {
  const { year, month } = calendarCursor;
  const title = new Date(year, month, 1).toLocaleDateString("en-US", {
    month: "long",
    year: "numeric",
  });
  $("[data-calendar-title]", calendarDialog).textContent = title;
  const today = localIsoDate();
  const enabled = profiles.filter((profile) => profile.enabled);
  const ranges = new Map(enabled.map((profile) => [profile.id, profileSearchRange(profile)]));

  const nodes = WEEKDAYS.map((label) => el("div", { class: "calendar-weekday" }, label));
  for (const cell of monthCells(year, month)) {
    const chips = [];
    for (const profile of enabled) {
      const range = ranges.get(profile.id);
      if (isoInWindow(cell.iso, range)) {
        chips.push(
          el(
            "span",
            {
              class: chipClass(profile.id),
              title: `${profile.name}: searching ${windowLabel(range)}`,
            },
            profile.name,
          ),
        );
      }
      if (range.booked === cell.iso) {
        chips.push(
          el(
            "span",
            {
              class: chipClass(profile.id, "booked"),
              title: `${profile.name}: booked appointment`,
            },
            `${profile.name} booked`,
          ),
        );
      }
    }
    nodes.push(
      el(
        "div",
        {
          class: `calendar-cell${cell.outside ? " outside" : ""}${cell.iso === today ? " today" : ""}`,
        },
        el("div", { class: "calendar-daynum" }, String(cell.day)),
        ...chips,
      ),
    );
  }
  $("[data-calendar]", calendarDialog).replaceChildren(...nodes);

  const legend = $("[data-calendar-legend]", calendarDialog);
  if (!enabled.length) {
    legend.replaceChildren(el("p", { class: "hint" }, "No enabled profiles."));
    return;
  }
  legend.replaceChildren(
    ...enabled.map((profile) => {
      const range = ranges.get(profile.id);
      return el(
        "div",
        { class: "calendar-legend-item" },
        el("span", { class: `calendar-legend-swatch tone-${profileColorIndex(profile.id)}` }),
        el(
          "span",
          {},
          profile.name,
          el("div", { class: "calendar-legend-meta" }, windowLabel(range)),
        ),
      );
    }),
  );
}

function shiftCalendar(delta) {
  const date = new Date(calendarCursor.year, calendarCursor.month + delta, 1);
  calendarCursor = { year: date.getFullYear(), month: date.getMonth() };
  renderCalendar();
}

function openCalendar() {
  const now = new Date();
  calendarCursor = { year: now.getFullYear(), month: now.getMonth() };
  calendarDialog.show();
  renderCalendar();
}

$("#open-calendar").addEventListener("click", () => openCalendar());
$("#calendar-prev").addEventListener("click", () => shiftCalendar(-1));
$("#calendar-next").addEventListener("click", () => shiftCalendar(1));
$("#calendar-today").addEventListener("click", () => {
  const now = new Date();
  calendarCursor = { year: now.getFullYear(), month: now.getMonth() };
  renderCalendar();
});

notesFrom.addEventListener("sl-change", () => {
  updateNotesClearButton();
  loadNotifications();
});
notesTo.addEventListener("sl-change", () => {
  updateNotesClearButton();
  loadNotifications();
});
notesKind.addEventListener("sl-change", () => {
  updateNotesClearButton();
  loadNotifications();
});
notesStatus.addEventListener("sl-change", () => {
  updateNotesClearButton();
  loadNotifications();
});
notesChannel.addEventListener("sl-change", () => {
  updateNotesClearButton();
  loadNotifications();
});
notesClearFilter.addEventListener("click", () => {
  resetNotesFilters();
  loadNotifications();
});

for (const button of document.querySelectorAll("[data-close]")) {
  button.addEventListener("click", () => button.closest("sl-dialog").hide());
}

// ---- Live bots ----

let liveSource = null;
let liveFrames = new Map();
let liveEnlargeProfileId = null;
let liveWanted = false;

function liveStreamUrl() {
  return "/api/live/stream";
}

function setLiveStatus(label, variant = "neutral") {
  const badge = $("#live-status");
  if (!badge) return;
  badge.textContent = label;
  badge.variant = variant;
}

function startLiveView() {
  liveWanted = true;
  clearInterval(liveClockTimer);
  liveClockTimer = setInterval(tickLiveClocks, LIVE_CLOCK_MS);
  if (liveSource && liveSource.readyState !== EventSource.CLOSED) {
    renderLiveGrid();
    tickLiveClocks();
    return;
  }
  setLiveStatus("Connecting…", "neutral");
  const source = new EventSource(liveStreamUrl());
  liveSource = source;
  source.addEventListener("open", () => {
    if (liveSource !== source) return;
    setLiveStatus("Watching", "success");
  });
  source.addEventListener("message", (event) => {
    if (liveSource !== source) return;
    let message;
    try {
      message = JSON.parse(event.data);
    } catch {
      return;
    }
    handleLiveMessage(message);
  });
  source.addEventListener("error", () => {
    if (liveSource !== source) return;
    if (!liveWanted || !isLivePath()) {
      setLiveStatus("Disconnected", "neutral");
      return;
    }
    // EventSource reconnects on its own; surface the gap to the UI.
    if (source.readyState === EventSource.CONNECTING) {
      setLiveStatus("Reconnecting…", "warning");
    } else if (source.readyState === EventSource.CLOSED) {
      liveSource = null;
      setLiveStatus("Stream failed", "danger");
      setTimeout(() => {
        if (liveWanted && isLivePath()) startLiveView();
      }, 1500);
    }
  });
  renderLiveGrid();
  tickLiveClocks();
}

function stopLiveView() {
  liveWanted = false;
  clearInterval(liveClockTimer);
  liveClockTimer = undefined;
  const source = liveSource;
  liveSource = null;
  if (source) {
    try {
      source.close();
    } catch {
      /* ignore */
    }
  }
  closeLiveEnlarge();
  setLiveStatus("Idle", "neutral");
}

function liveNextRunText(profile) {
  const nextLabel = nextRunLabel(profile.nextRunAt);
  if (nextLabel === "—") return "Next run: not scheduled";
  return `Next run: ${nextLabel}`;
}

function tickLiveClocks() {
  if (!isLivePath() || $("#live-view")?.hidden) return;
  for (const profile of liveCardProfiles()) {
    const meta = document.querySelector(
      `.live-card[data-profile-id="${profile.id}"] .live-card-meta`,
    );
    if (!meta) continue;
    meta.textContent = liveNextRunText(profile);
    meta.title = profile.nextRunAt
      ? formatTimestamp(profile.nextRunAt)
      : "Disabled — not scheduled";
  }
  if (liveEnlargeProfileId != null) {
    syncLiveEnlargeChrome(
      profiles.find((item) => item.id === liveEnlargeProfileId),
    );
  }
}

function handleLiveMessage(message) {
  if (message.type === "hello") {
    setLiveStatus(message.screencasting ? "Watching" : "Connected", "success");
    renderLiveGrid();
    return;
  }
  if (message.type === "screencasting") {
    setLiveStatus(message.on ? "Watching" : "Connected", "success");
    return;
  }
  if (message.type === "profiles" && Array.isArray(message.profiles)) {
    profiles = message.profiles;
    for (const profile of profiles) {
      if (profile.state === "idle" || profile.state === "queued") {
        liveFrames.delete(profile.id);
      }
    }
    renderLiveGrid();
    tickLiveClocks();
    return;
  }
  if (message.type === "bot") {
    if (message.event === "disconnected") {
      liveFrames.delete(message.profileId);
      if (liveEnlargeProfileId === message.profileId) {
        updateLiveEnlargeFrame();
      }
    }
    renderLiveGrid();
    return;
  }
  if (message.type === "frame") {
    liveFrames.set(message.profileId, message.jpeg);
    // Large player owns playback — keep storing frames but don't paint cards.
    if (liveEnlargeProfileId != null) {
      if (liveEnlargeProfileId === message.profileId) {
        updateLiveEnlargeFrame();
      }
      return;
    }
    updateLiveCardFrame(message.profileId, message.jpeg);
  }
}

function updateLiveCardFrame(profileId, jpeg) {
  const card = document.querySelector(
    `.live-card[data-profile-id="${profileId}"]`,
  );
  if (!card) return;
  const media = card.querySelector(".live-card-media");
  if (!media) return;
  let img = media.querySelector("img");
  if (!img) {
    img = el("img", { alt: "Live browser" });
    media.prepend(img);
  }
  img.src = `data:image/jpeg;base64,${jpeg}`;
  media.classList.add("has-frame");
}

function pauseLiveCardPlayback() {
  for (const media of document.querySelectorAll(".live-card-media")) {
    media.classList.remove("has-frame");
    const img = media.querySelector("img");
    if (img) img.removeAttribute("src");
    const placeholder = media.querySelector(".live-placeholder");
    if (placeholder) placeholder.textContent = "Playing in large view…";
  }
}

function liveCardProfiles() {
  return profiles.filter(
    (profile) =>
      profile.enabled ||
      profile.state === "running" ||
      profile.state === "queued",
  );
}

function renderLiveGrid() {
  const grid = $("#live-grid");
  if (!grid || $("#live-view").hidden) return;
  const cards = liveCardProfiles();
  $("#live-empty").hidden = cards.length > 0;
  grid.replaceChildren(
    ...cards.map((profile) => {
      const enlarged = liveEnlargeProfileId != null;
      const jpeg = !enlarged ? liveFrames.get(profile.id) : undefined;
      const due = nextRunLabel(profile.nextRunAt) === "due";
      const placeholderText = enlarged
        ? "Playing in large view…"
        : profile.state === "running"
          ? "Waiting for frames…"
          : profile.state === "queued"
            ? "Queued…"
            : due
              ? appDevMode
                ? "Due — Run now (or stop visa-ui so this page can start it)"
                : "Due — waiting for scheduler…"
              : "Idle — Run now to watch";
      const mediaChildren = [
        el("p", { class: "live-placeholder" }, placeholderText),
      ];
      if (jpeg) {
        mediaChildren.unshift(
          el("img", {
            alt: `${profile.name} live browser`,
            src: `data:image/jpeg;base64,${jpeg}`,
          }),
        );
      }
      const media = el(
        "div",
        {
          class: `live-card-media${jpeg ? " has-frame" : ""}`,
          title: "Click to enlarge",
        },
        ...mediaChildren,
      );
      media.addEventListener("click", () => openLiveEnlarge(profile.id));

      const busy =
        profile.state === "running" || profile.state === "queued";
      const actions = el(
        "div",
        { class: "live-card-actions" },
        (() => {
          const runBtn = el(
            "sl-button",
            {
              size: "small",
              variant: "primary",
              disabled: busy || !profile.enabled ? true : undefined,
            },
            "Run now",
          );
          runBtn.addEventListener("click", (event) => {
            event.stopPropagation();
            runNow(profile);
          });
          return runBtn;
        })(),
        busy
          ? (() => {
              const cancelBtn = el(
                "sl-button",
                { size: "small", variant: "default" },
                "Cancel",
              );
              cancelBtn.addEventListener("click", (event) => {
                event.stopPropagation();
                cancelRun(profile);
              });
              return cancelBtn;
            })()
          : null,
        (() => {
          const enlargeBtn = el(
            "sl-button",
            { size: "small", variant: "default" },
            "Enlarge",
          );
          enlargeBtn.addEventListener("click", (event) => {
            event.stopPropagation();
            openLiveEnlarge(profile.id);
          });
          return enlargeBtn;
        })(),
      );

      return el(
        "article",
        {
          class: `live-card${profile.state === "running" ? " is-running" : ""}`,
          "data-profile-id": String(profile.id),
        },
        media,
        el(
          "div",
          { class: "live-card-body" },
          el(
            "div",
            { class: "live-card-top" },
            el("div", { class: "live-card-name" }, profile.name),
            badge(
              profile.state === "running"
                ? "running"
                : profile.state === "queued"
                  ? "queued"
                  : "idle",
              profile.state === "running"
                ? "info"
                : profile.state === "queued"
                  ? "warn"
                  : "neutral",
            ),
          ),
          el(
            "div",
            {
              class: "live-card-meta",
              title: profile.nextRunAt
                ? formatTimestamp(profile.nextRunAt)
                : "Disabled — not scheduled",
            },
            liveNextRunText(profile),
          ),
          actions,
        ),
      );
    }),
  );
  if (liveEnlargeProfileId != null) updateLiveEnlargeFrame();
}

function openLiveEnlarge(profileId) {
  liveEnlargeProfileId = profileId;
  const overlay = $("#live-enlarge");
  overlay.hidden = false;
  pauseLiveCardPlayback();
  updateLiveEnlargeFrame();
}

function closeLiveEnlarge() {
  liveEnlargeProfileId = null;
  $("#live-enlarge").hidden = true;
  const stage = $("#live-enlarge-stage");
  const img = $("#live-enlarge-img");
  if (img) img.removeAttribute("src");
  stage?.classList.remove("has-frame");
  if (document.fullscreenElement === stage) {
    document.exitFullscreen?.().catch(() => {});
  }
  if (isLivePath()) renderLiveGrid();
}

function updateLiveEnlargeFrame() {
  const profile = profiles.find((item) => item.id === liveEnlargeProfileId);
  $("#live-enlarge-title").textContent = profile
    ? `Live — ${profile.name}`
    : "Live";
  syncLiveEnlargeChrome(profile);
  const jpeg = liveFrames.get(liveEnlargeProfileId);
  const stage = $("#live-enlarge-stage");
  const img = $("#live-enlarge-img");
  if (jpeg) {
    img.src = `data:image/jpeg;base64,${jpeg}`;
    stage.classList.add("has-frame");
  } else {
    img.removeAttribute("src");
    stage.classList.remove("has-frame");
  }
}

function syncLiveEnlargeChrome(profile) {
  const next = $("#live-enlarge-next");
  const runBtn = $("#live-enlarge-run");
  const cancelBtn = $("#live-enlarge-cancel");
  if (!profile) {
    next.textContent = "";
    runBtn.disabled = true;
    cancelBtn.hidden = true;
    return;
  }
  next.textContent = liveNextRunText(profile);
  next.title = profile.nextRunAt
    ? formatTimestamp(profile.nextRunAt)
    : "Disabled — not scheduled";
  const busy =
    profile.state === "running" || profile.state === "queued";
  runBtn.disabled = busy || !profile.enabled;
  cancelBtn.hidden = !busy;
}

$("#open-live").addEventListener("click", () => goLiveView());
$("#live-back").addEventListener("click", () => goAdminHome());
$("#live-enlarge-close").addEventListener("click", () => closeLiveEnlarge());
document
  .querySelectorAll("[data-live-enlarge-close]")
  .forEach((node) =>
    node.addEventListener("click", () => closeLiveEnlarge()),
  );
$("#live-enlarge-run").addEventListener("click", () => {
  const profile = profiles.find((item) => item.id === liveEnlargeProfileId);
  if (profile) runNow(profile);
});
$("#live-enlarge-cancel").addEventListener("click", () => {
  const profile = profiles.find((item) => item.id === liveEnlargeProfileId);
  if (profile) cancelRun(profile);
});
$("#live-enlarge-fullscreen").addEventListener("click", async () => {
  const stage = $("#live-enlarge-stage");
  try {
    if (document.fullscreenElement === stage) {
      await document.exitFullscreen();
    } else {
      await stage.requestFullscreen();
    }
  } catch (error) {
    toast(error.message || "Fullscreen unavailable");
  }
});

window.addEventListener("popstate", () => {
  if (!isAdminPath()) return;
  if ($("#app-view").hidden) return;
  applyAdminPanel();
  refresh();
});

document.querySelector(".brand")?.addEventListener("click", (event) => {
  if (!$("#app-view") || $("#app-view").hidden) return;
  if (!isLivePath()) return;
  event.preventDefault();
  goAdminHome();
});

boot();
