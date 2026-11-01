// Inbox dashboard. Talks to /api/inbox/* with the passkey session cookie, or
// with the inbox secret if the user typed one in instead. All item content is
// set with textContent, never innerHTML.
//
// To keep D1 reads down, the page loads once (GET /api/inbox/dashboard, one
// request) and again only when the refresh button is tapped. It never polls.
// An action updates the lists from its own response instead of reloading.
import { getPasskey, post } from "/webauthn.js";

const SECRET_KEY = "agent-inbox-secret";
const WINDOW_DAYS = 7; // the server sends 7 days; the page shows today and the 6 before
const DONE_LIMIT = 30;
const MIN_SPIN_MS = 500; // so a fast refresh still visibly happened
const TYPE_LABELS = {
  approval: "Approval",
  yes_no: "Yes/no",
  reply: "Reply",
  sign: "Sign",
  due_today: "Due today",
};
const AVATAR_COLORS = 8; // .av-0 … .av-7 in style.css
const $ = (sel) => document.querySelector(sel);
// Bots' test rows are hidden unless the page itself is opened with ?include_test=1.
const INCLUDE_TEST = ["1", "true"].includes(new URLSearchParams(location.search).get("include_test"));
// At this width and up the three panes sit side by side; below it they're tabs.
const wide = matchMedia("(min-width: 1024px)");

const state = {
  waiting: [],
  snoozed: [],
  done: [],
  rejected: [],
  activity: [],
  events: [],
  bot: "",
  day: "all",
  pane: "waiting",
  tab: "in_progress",
  open: null, // id of the expanded waiting card
  showOlder: false,
};

// --- api ----------------------------------------------------------------

function secret() {
  return localStorage.getItem(SECRET_KEY);
}

async function api(method, path, body) {
  const headers = { "Content-Type": "application/json" };
  if (secret()) headers.Authorization = `Bearer ${secret()}`;
  if (INCLUDE_TEST && method === "GET") path += `${path.includes("?") ? "&" : "?"}include_test=1`;
  const res = await fetch(path, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (res.status === 401) {
    showLogin(secret() ? "Wrong secret." : "");
    localStorage.removeItem(SECRET_KEY);
    throw new Error("unauthorized");
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error || `HTTP ${res.status}`), { status: res.status, data });
  return data;
}

// Loads everything in one request, so the bot filter, date tabs and layout
// switches all work from the same data without a round trip.
let loading = false;
async function load({ spin = false } = {}) {
  if (loading) return;
  loading = true;
  const button = $("#refresh");
  button.classList.add("loading");
  button.disabled = true;
  button.setAttribute("aria-busy", "true");
  try {
    const [data] = await Promise.all([
      api("GET", "/api/inbox/dashboard"),
      spin ? new Promise((r) => setTimeout(r, MIN_SPIN_MS)) : null,
    ]);
    const { waiting, snoozed, done, rejected, activity, events } = data;
    Object.assign(state, { waiting, snoozed, done, rejected, activity, events });
    button.title = `Refresh · updated ${new Date().toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}`;
    fillBotFilter();
    render();
  } catch (err) {
    if (err.message !== "unauthorized") toast(`Couldn't load: ${err.message}`, true);
  } finally {
    loading = false;
    button.classList.remove("loading");
    button.disabled = false;
    button.removeAttribute("aria-busy");
  }
}

// --- screens ------------------------------------------------------------

function showLogin(message = "") {
  $("#login").hidden = false;
  $("#dashboard").hidden = true;
  $("#refresh").hidden = true;
  $("#signout").hidden = true;
  $("#filter-phone").hidden = true;
  if (message) toast(message, true);
  $("#passkey").focus();
  fetch("/api/auth/status")
    .then((res) => res.json())
    .then((s) => ($("#no-passkey").hidden = s.passkeys !== false))
    .catch(() => {});
}

function showInbox() {
  $("#login").hidden = true;
  $("#dashboard").hidden = false;
  $("#refresh").hidden = false;
  $("#signout").hidden = false;
  $("#filter-phone").hidden = false;
  load();
}

let toastTimer;
function toast(text, error = false) {
  const el = $("#status");
  el.textContent = text;
  el.classList.toggle("error", error);
  el.classList.toggle("show", Boolean(text));
  clearTimeout(toastTimer);
  if (text) toastTimer = setTimeout(() => el.classList.remove("show"), error ? 6000 : 3500);
}

// --- render -------------------------------------------------------------

function render() {
  if ($("#dashboard").hidden) return;
  placeFilter();
  const mine = (list) => (state.bot ? list.filter((x) => x.bot === state.bot) : list);
  // "All" is the local days the date tabs show, not the server's rolling 7 days.
  const from = new Date(startOfDay(Date.now()) - (WINDOW_DAYS - 1) * 86_400_000).toISOString();
  const inDay = (iso) => (state.day === "all" ? iso >= from : dayKey(iso) === state.day);

  const waiting = mine(state.waiting).sort((a, b) => b.created_at.localeCompare(a.created_at));
  const running = mine(state.activity).filter((a) => a.status === "in_progress");
  const finished = mine(state.activity).filter((a) => a.status === "finished" && inDay(a.at));
  const closed = mine([...state.done, ...state.rejected])
    .filter((i) => inDay(i.updated_at))
    .sort((a, b) => b.updated_at.localeCompare(a.updated_at));
  const dayEntries = timelineEntries().filter((e) => inDay(e.at));
  const entries = mine(dayEntries);

  renderSummary({ waiting, running, finished, entries });
  renderWaiting(waiting, mine(state.snoozed));
  renderDateTabs();
  renderTimeline(entries);
  renderActivity({ running, finished, closed });
  // Every bot stays listed while one is picked, so you can switch straight to another.
  renderBots(dayEntries.filter((e) => e.byBot));

  $("#tab-waiting-n").textContent = waiting.length || "";
  for (const pane of document.querySelectorAll(".pane")) {
    pane.classList.toggle("active", pane.dataset.pane === state.pane);
  }
  for (const b of $("#tabs").querySelectorAll("button")) {
    b.classList.toggle("active", b.dataset.pane === state.pane);
  }
}

// On phones the bot filter sits in the header so it's there on every tab.
function placeFilter() {
  const filter = $("#bot-filter").closest(".pill-select");
  const home = wide.matches ? $("#filter-wide") : $("#filter-phone");
  if (filter.parentElement !== home) home.append(filter);
}

function fillBotFilter() {
  const select = $("#bot-filter");
  const bots = new Set(
    [...state.waiting, ...state.done, ...state.rejected, ...state.activity, ...state.events].map((x) => x.bot),
  );
  if (state.bot) bots.add(state.bot);
  select.replaceChildren(new Option("All bots", ""), ...[...bots].sort(byName).map((b) => new Option(b)));
  select.value = state.bot;
}

function rangeLabel() {
  if (state.day === "all") return "In the last 7 days";
  if (state.day === dayKey(Date.now())) return "Today";
  if (state.day === dayKey(Date.now() - 86_400_000)) return "Yesterday";
  return `On ${new Date(`${state.day}T12:00`).toLocaleDateString([], { weekday: "long" })}`;
}

function renderSummary({ waiting, running, finished, entries }) {
  const range = rangeLabel();
  const bots = new Set(entries.filter((e) => e.byBot).map((e) => e.bot));
  const asks = entries.filter((e) => e.kind === "ask").length;
  const who = state.bot || `${bots.size} ${plural(bots.size, "bot")}`;
  const parts = [];
  const strong = (text) => Object.assign(document.createElement("strong"), { textContent: text });

  if (entries.length === 0) {
    parts.push(`${range}, ${state.bot || "your bots"} ${state.bot ? "was" : "were"} quiet. `);
  } else {
    parts.push(`${range}, `, strong(who), " finished ", strong(String(finished.length)), ` ${plural(finished.length, "task")}`);
    parts.push(" and asked for ", strong(String(asks)), ` ${plural(asks, "decision")}. `);
  }
  const runningBots = [...new Set(running.map((a) => a.bot))].sort(byName);
  if (runningBots.length) {
    const live = document.createElement("span");
    live.className = "live";
    live.textContent = listOf(runningBots);
    parts.push(live, ` ${runningBots.length === 1 ? "is" : "are"} running now. `);
  } else {
    parts.push("Nothing is running. ");
  }
  const stats = document.createElement("span");
  stats.className = "stats";
  const stat = (n, label, cls = "") => {
    const s = document.createElement("span");
    s.className = `stat ${cls}`;
    s.append(strong(String(n)), ` ${label}`);
    return s;
  };
  stats.append(
    stat(waiting.length, "waiting on you", waiting.length ? "hot" : ""),
    stat(running.length, "in progress"),
    stat(finished.length, "finished"),
  );
  $("#summary").replaceChildren(...parts, stats);
}

function renderWaiting(list, snoozed) {
  $("#waiting-n").textContent = list.length;
  const note = $("#snoozed-note");
  note.hidden = !snoozed.length;
  if (snoozed.length) {
    const next = snoozed.map((i) => i.snooze_until).sort()[0];
    const when = new Date(next);
    const day = dayKey(next) === dayKey(Date.now()) ? "today" : dayKey(next) === dayKey(Date.now() + 86_400_000) ? "tomorrow" : when.toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" });
    note.textContent = `${snoozed.length} snoozed · next back ${day} at ${when.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}`;
  }
  const body = $("#waiting-list");
  if (!list.length) {
    body.replaceChildren(empty("All clear", state.bot ? `${state.bot} isn't waiting on you.` : "Nothing is waiting on you."));
    return;
  }
  body.replaceChildren(...list.map(renderAsk));
}

function renderAsk(item) {
  const el = $("#ask-tpl").content.firstElementChild.cloneNode(true);
  fillAvatar(el.querySelector(".avatar"), item.bot);
  el.querySelector(".bot").textContent = item.bot;
  const pill = el.querySelector(".type-pill");
  if (item.type) {
    pill.textContent = TYPE_LABELS[item.type] ?? item.type;
    pill.classList.add(`t-${item.type}`);
  } else {
    pill.remove();
  }
  setTime(el.querySelector("time"), item.created_at);
  el.querySelector(".ask-title").textContent = item.title;
  el.querySelector(".note").textContent = item.note || "";
  const links = el.querySelector(".links");
  for (const link of item.links) {
    const a = document.createElement("a");
    a.href = link.url; // server only accepts http(s)
    a.textContent = link.label || hostOf(link.url);
    a.target = "_blank";
    a.rel = "noopener noreferrer";
    const li = document.createElement("li");
    li.append(a);
    links.append(li);
  }

  const main = el.querySelector(".card-main");
  const more = el.querySelector(".card-more");
  const setOpen = (open) => {
    more.hidden = !open;
    main.setAttribute("aria-expanded", String(open));
    el.classList.toggle("open", open);
  };
  setOpen(state.open === item.id);
  main.addEventListener("click", () => {
    const open = more.hidden;
    for (const other of document.querySelectorAll(".ask.open")) {
      if (other !== el) other.querySelector(".card-main").click();
    }
    state.open = open ? item.id : null;
    setOpen(open);
  });

  el.querySelector(".done").addEventListener("click", () => act(el, item, "done"));
  el.querySelector(".reject").addEventListener("click", () => act(el, item, "reject"));
  const snooze = el.querySelector(".snooze select");
  snooze.addEventListener("change", () => {
    if (snooze.value) act(el, item, "snooze", snoozeBody(snooze.value));
  });
  const form = el.querySelector(".reply-form");
  const textarea = form.querySelector("textarea");
  el.querySelector(".reply").addEventListener("click", () => {
    form.hidden = !form.hidden;
    if (!form.hidden) textarea.focus();
  });
  form.querySelector(".cancel").addEventListener("click", () => {
    form.hidden = true;
  });
  textarea.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) form.requestSubmit();
  });
  form.addEventListener("submit", (e) => {
    e.preventDefault();
    act(el, item, "reply", { text: textarea.value });
  });
  return el;
}

function renderDateTabs() {
  const days = [{ key: "all", label: "All" }];
  for (let i = 0; i < WINDOW_DAYS; i++) {
    const t = Date.now() - i * 86_400_000;
    const d = new Date(t);
    // Within 7 days a weekday names one day, and keeps all 8 tabs in view.
    const label = i === 0 ? "Today" : i === 1 ? "Yesterday" : d.toLocaleDateString([], { weekday: "short" });
    days.push({ key: dayKey(t), label, title: d.toLocaleDateString([], { weekday: "long", month: "short", day: "numeric" }) });
  }
  $("#date-tabs").replaceChildren(
    ...days.map(({ key, label, title }) => {
      const b = document.createElement("button");
      b.type = "button";
      b.setAttribute("role", "tab");
      b.dataset.day = key;
      b.textContent = label;
      if (title) b.title = title;
      b.setAttribute("aria-selected", String(key === state.day));
      return b;
    }),
  );
}

// Activity entries plus inbox events, newest first. Edits and wake-ups are
// left out: they're noise on a timeline.
function timelineEntries() {
  const out = [];
  for (const a of state.activity) {
    out.push({ at: a.at, bot: a.bot, text: a.text, kind: a.status === "in_progress" ? "running" : "finished", byBot: true });
  }
  for (const e of state.events) {
    const p = e.payload;
    const you = p.source === "inbox";
    let kind = you ? "you" : "bot";
    let text;
    if (e.type === "created") {
      kind = p.status === "done" ? "fyi" : "ask";
      text = p.status === "done" ? e.title : `Asked: ${e.title}`;
    } else if (e.type === "done") {
      text = you ? `Done: ${e.title}` : `Closed: ${e.title}`;
    } else if (e.type === "rejected") {
      text = `Rejected: ${e.title}`;
    } else if (e.type === "reply" || e.type === "note") {
      text = `Replied “${p.text ?? p.note}”`;
    } else if (e.type === "snoozed") {
      text = `Snoozed: ${e.title}`;
    } else {
      continue;
    }
    out.push({ at: e.at, bot: e.bot, text, kind, you, byBot: !you });
  }
  return out.sort((a, b) => b.at.localeCompare(a.at));
}

function renderTimeline(entries) {
  const body = $("#timeline");
  if (!entries.length) {
    body.replaceChildren(
      empty("No activity", state.day === "all" ? "Nothing logged in the last 7 days." : "Nothing logged on this day."),
    );
    return;
  }
  const groups = new Map();
  for (const e of entries) {
    const key = dayKey(e.at);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(e);
  }
  const out = [];
  for (const [key, list] of groups) {
    const h = document.createElement("h3");
    h.className = "day";
    const label = document.createElement("span");
    label.textContent = dayLabel(key);
    const n = document.createElement("span");
    n.className = "day-n";
    n.textContent = `${list.length} ${plural(list.length, "event")}`;
    h.append(label, n);
    const ol = document.createElement("ol");
    ol.className = "tl";
    ol.append(...list.map(renderEntry));
    out.push(h, ol);
  }
  body.replaceChildren(...out);
}

function renderEntry(e) {
  const li = document.createElement("li");
  li.className = `tl-entry k-${e.kind}`;
  const time = document.createElement("time");
  time.className = "tl-time";
  time.dateTime = e.at;
  time.textContent = new Date(e.at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  time.title = new Date(e.at).toLocaleString();
  const av = document.createElement("span");
  av.className = "avatar sm";
  fillAvatar(av, e.bot);
  const text = document.createElement("p");
  text.className = "tl-text";
  const bot = document.createElement("span");
  bot.className = "bot";
  bot.textContent = e.bot;
  text.append(bot);
  if (e.you) {
    const you = document.createElement("span");
    you.className = "you";
    you.textContent = "You";
    text.append(you);
  }
  const action = document.createElement("span");
  action.className = "tl-action";
  action.textContent = e.text;
  text.append(action);
  text.title = `${e.bot}: ${e.text}`;
  li.append(time, av, text);
  if (e.kind === "running") {
    const tag = document.createElement("span");
    tag.className = "tag running";
    tag.textContent = "Running";
    li.append(tag);
  }
  return li;
}

function renderActivity({ running, finished, closed }) {
  const tabs = $("#activity-tabs");
  tabs.querySelector('[data-tab="in_progress"] .n').textContent = running.length;
  tabs.querySelector('[data-tab="finished"] .n').textContent = finished.length;
  for (const b of tabs.querySelectorAll("button")) {
    b.classList.toggle("active", b.dataset.tab === state.tab);
    b.setAttribute("aria-selected", String(b.dataset.tab === state.tab));
  }
  const body = $("#activity-list");
  if (state.tab === "in_progress") {
    body.replaceChildren(
      ...(running.length
        ? running.map((a) => mini(a.bot, a.text, a.at, "running", "Running"))
        : [empty("Nothing running", "No bot is working on anything right now.")]),
    );
  } else if (state.tab === "finished") {
    body.replaceChildren(
      ...(finished.length
        ? finished.map((a) => mini(a.bot, a.text, a.at, "finished", "Finished"))
        : [empty("Nothing finished", state.day === "all" ? "Finished work shows up here." : "Nothing finished on this day.")]),
    );
  } else {
    if (!closed.length) {
      body.replaceChildren(empty("Nothing done", "Items you close or reject land here."));
      return;
    }
    const shown = state.showOlder ? closed : closed.slice(0, DONE_LIMIT);
    body.replaceChildren(
      ...shown.map((i) =>
        mini(i.bot, i.title, i.updated_at, i.status, i.status === "rejected" ? "Rejected" : "Done"),
      ),
    );
    if (shown.length < closed.length) {
      const older = document.createElement("button");
      older.className = "ghost older";
      older.textContent = `Show older (${closed.length - shown.length})`;
      older.addEventListener("click", () => {
        state.showOlder = true;
        render();
      });
      body.append(older);
    }
  }
}

// How much each bot did in the selected range; a row click filters to it.
function renderBots(entries) {
  const counts = new Map();
  for (const e of entries) counts.set(e.bot, (counts.get(e.bot) ?? 0) + 1);
  const rows = [...counts].sort((a, b) => b[1] - a[1] || byName(a[0], b[0]));
  const max = Math.max(1, ...counts.values());
  $("#bots-range").textContent = rangeLabel().replace(/^In the l/, "L");
  $("#bots-list").replaceChildren(
    ...rows.map(([bot, n]) => {
      const li = document.createElement("li");
      const b = document.createElement("button");
      b.type = "button";
      b.className = "bot-row";
      b.classList.toggle("active", state.bot === bot);
      b.title = state.bot === bot ? "Show all bots" : `Only ${bot}`;
      const av = document.createElement("span");
      av.className = "avatar sm";
      fillAvatar(av, bot);
      const name = document.createElement("span");
      name.className = "bot-name";
      name.textContent = bot;
      const bar = document.createElement("span");
      bar.className = "bar";
      const fill = document.createElement("span");
      fill.className = `fill av-${avatarColor(bot)}`;
      fill.style.width = `${Math.round((n / max) * 100)}%`; // CSSOM, allowed by the CSP
      bar.append(fill);
      const count = document.createElement("span");
      count.className = "bot-n";
      count.textContent = n;
      b.append(av, name, bar, count);
      b.addEventListener("click", () => {
        state.bot = state.bot === bot ? "" : bot;
        $("#bot-filter").value = state.bot;
        render();
      });
      li.append(b);
      return li;
    }),
  );
  $(".bots").hidden = !rows.length;
  $(".bots").classList.toggle("filtered", Boolean(state.bot));
}

function mini(botName, text, at, stateClass, stateLabel) {
  const el = $("#mini-tpl").content.firstElementChild.cloneNode(true);
  fillAvatar(el.querySelector(".avatar"), botName);
  el.querySelector(".bot").textContent = botName;
  const s = el.querySelector(".state");
  s.textContent = stateLabel;
  s.classList.add(stateClass);
  setTime(el.querySelector("time"), at);
  el.querySelector(".mini-text").textContent = text;
  return el;
}

function empty(title, text) {
  const div = document.createElement("div");
  div.className = "empty";
  const icon = document.createElement("span");
  icon.className = "empty-icon";
  icon.setAttribute("aria-hidden", "true");
  const h = document.createElement("p");
  h.className = "empty-title";
  h.textContent = title;
  const p = document.createElement("p");
  p.className = "muted";
  p.textContent = text;
  div.append(icon, h, p);
  return div;
}

// --- actions ------------------------------------------------------------

function snoozeBody(value) {
  if (value !== "tomorrow") return { minutes: Number(value) };
  const d = new Date();
  d.setDate(d.getDate() + 1);
  d.setHours(9, 0, 0, 0);
  return { until: d.toISOString() };
}

async function act(el, item, action, body) {
  const controls = el.querySelectorAll(".card-more button, .card-more select, .card-more textarea");
  for (const c of controls) c.disabled = true;
  try {
    const res = await api("POST", `/api/inbox/items/${item.id}/${action}`, body);
    const label = { done: "Done", reject: "Rejected", reply: "Reply sent", snooze: "Snoozed" }[action];
    const fwd = res.forwarded === "queued" ? " · sent to your webhook" : "";
    if (action !== "reply") state.open = null;
    applyAction(res.item, res.event);
    toast(`${label}: ${item.title}${fwd}`);
  } catch (err) {
    if (err.message === "unauthorized") return;
    // 409: the card was stale (a bot or another tab closed it first). Nothing
    // was recorded; the response has the item as it is, so move the card.
    if (err.status === 409 && err.data?.item) {
      state.open = null;
      applyAction(err.data.item);
      toast(`Not changed: ${item.title} is already ${err.data.item.status}`, true);
      return;
    }
    toast(`Failed: ${err.message}`, true);
    for (const c of controls) c.disabled = false;
  }
}

// An action's response has the item as it now stands and the event it wrote,
// which is all the page needs to redraw without reading everything again.
function applyAction(item, event) {
  for (const key of ["waiting", "snoozed", "done", "rejected"]) {
    state[key] = state[key].filter((i) => i.id !== item.id);
  }
  state[item.status]?.unshift(item);
  if (event) state.events.unshift({ ...event, bot: item.bot, title: item.title, item_type: item.type });
  render();
}

// --- helpers ------------------------------------------------------------

// Same name, same color, everywhere: FNV-1a over the name picks a palette slot.
function avatarColor(name) {
  let h = 0x811c9dc5;
  for (const ch of name.toLowerCase()) {
    h ^= ch.codePointAt(0);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h % AVATAR_COLORS;
}

function initials(name) {
  const words = name
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .split(/[\s_\-.]+/)
    .filter(Boolean);
  if (!words.length) return "?";
  const letters = words.length > 1 ? words[0][0] + words[1][0] : words[0][0];
  return letters.toUpperCase();
}

function fillAvatar(el, name) {
  el.textContent = initials(name);
  el.classList.add(`av-${avatarColor(name)}`);
  el.setAttribute("aria-hidden", "true");
}

function setTime(el, iso) {
  el.dateTime = iso;
  el.textContent = ago(iso);
  el.title = new Date(iso).toLocaleString();
}

function ago(iso) {
  const s = Math.round((Date.now() - Date.parse(iso)) / 1000);
  if (s < 60) return "now";
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  if (s < 7 * 86400) return `${Math.floor(s / 86400)}d`;
  return new Date(iso).toLocaleDateString([], { month: "short", day: "numeric" });
}

function startOfDay(t) {
  const d = new Date(t);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

// Local calendar day, YYYY-MM-DD.
function dayKey(t) {
  const d = new Date(t);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function dayLabel(key) {
  if (key === dayKey(Date.now())) return "Today";
  if (key === dayKey(Date.now() - 86_400_000)) return "Yesterday";
  return new Date(`${key}T12:00`).toLocaleDateString([], { weekday: "long", month: "short", day: "numeric" });
}

function hostOf(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

function plural(n, word) {
  return n === 1 ? word : `${word}s`;
}

function listOf(names) {
  if (names.length <= 1) return names.join("");
  if (names.length === 2) return `${names[0]} and ${names[1]}`;
  return `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
}

function byName(a, b) {
  return a.localeCompare(b, undefined, { sensitivity: "base" });
}

// --- wiring -------------------------------------------------------------

$("#tabs").addEventListener("click", (e) => {
  const btn = e.target.closest("button[data-pane]");
  if (!btn) return;
  state.pane = btn.dataset.pane;
  render();
});

$("#activity-tabs").addEventListener("click", (e) => {
  const btn = e.target.closest("button[data-tab]");
  if (!btn) return;
  state.tab = btn.dataset.tab;
  render();
});

$("#date-tabs").addEventListener("click", (e) => {
  const btn = e.target.closest("button[data-day]");
  if (!btn) return;
  state.day = btn.dataset.day;
  state.showOlder = false;
  render();
});

$("#bot-filter").addEventListener("change", (e) => {
  state.bot = e.target.value;
  state.showOlder = false;
  render();
});

wide.addEventListener("change", render);

$("#passkey").addEventListener("click", async () => {
  $("#passkey").disabled = true;
  try {
    const options = await post("/api/auth/login/options");
    await post("/api/auth/login/verify", { response: await getPasskey(options) });
    showInbox();
  } catch (err) {
    toast(`Passkey sign-in failed: ${err.message}`, true);
  } finally {
    $("#passkey").disabled = false;
  }
});

$("#secret-form").addEventListener("submit", (e) => {
  e.preventDefault();
  localStorage.setItem(SECRET_KEY, $("#secret").value.trim());
  $("#secret").value = "";
  showInbox();
});

$("#signout").addEventListener("click", async () => {
  localStorage.removeItem(SECRET_KEY);
  await post("/api/auth/logout").catch(() => {});
  showLogin();
});

$("#refresh").addEventListener("click", () => load({ spin: true }));

// A passkey session lives in an HttpOnly cookie the page can't see, so just
// try loading; a 401 shows the sign-in screen.
showInbox();
