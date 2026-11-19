const $ = (selector) => document.querySelector(selector);
const view = $("#view"),
  dialog = $("#dialog"),
  notice = $("#notice");
const zone = "Asia/Kolkata",
  dates = new Intl.DateTimeFormat("en-GB", {
    timeZone: zone,
    dateStyle: "medium",
  }),
  times = new Intl.DateTimeFormat("en-GB", {
    timeZone: zone,
    timeStyle: "medium",
    hour12: false,
  });
const dateInput = (ms) =>
  new Date(+new Date(ms) + 19800000).toISOString().slice(0, 19);
const dayAt = (ms) => dateInput(ms).slice(0, 10);
const shiftDay = (day, count) =>
  new Date(Date.parse(day + "T00:00:00Z") + 86400000 * count)
    .toISOString()
    .slice(0, 10);
const num = (v) => Number(v) || 0;
const duration = (s) => {
  s = Math.max(0, Math.floor(num(s)));
  return [Math.floor(s / 3600), Math.floor(s / 60) % 60, s % 60]
    .map((x) => String(x).padStart(2, "0"))
    .join(":");
};
const money = (value, currency = "INR") =>
  new Intl.NumberFormat("en-IN", {
    style: "currency",
    currency: currency || "INR",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(num(value));
const esc = (value) =>
  String(value ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
const msg = (value) => {
  notice.textContent = value;
  notice.hidden = !value;
};
const metric = (label, value) =>
  `<div class="metric"><span>${esc(label)}</span><strong>${esc(value)}</strong></div>`;
const opt = (value, label, current) =>
  `<option value="${esc(value)}"${value === current ? " selected" : ""}>${esc(label)}</option>`;
const field = (label, name, type = "text", value = "", extra = "") =>
  `<label>${esc(label)}<input name="${esc(name)}" type="${type}" value="${esc(value)}" ${extra}></label>`;
const prettyDate = (day) => dates.format(new Date(day + "T12:00:00Z"));
const btn = (label, command, style = "") =>
  `<button type="button" class="btn ${style}" data-do="${command}">${label}</button>`;
const heading = (name, sub, extra = "") =>
  `<div class="heading"><div><h1>${esc(name)}</h1><p class="sub">${esc(sub)}</p></div>${extra}</div>`;
const name = (id) => data.profiles.find((p) => p.id === id)?.name || "Member";
const active = (id) =>
  data.sessions.find((s) => s.user_id === id && !s.ended_at);
const table = (heads, rows, empty) =>
  `<div class="table-wrap">${rows.length ? `<table><thead><tr>${heads.map((h) => `<th scope="col">${esc(h)}</th>`).join("")}</tr></thead><tbody>${rows.map((cells) => `<tr>${cells.map((c) => `<td>${c}</td>`).join("")}</tr>`).join("")}</tbody></table>` : `<p class="empty">${esc(empty)}</p>`}</div>`;
let db,
  user,
  data,
  channel,
  revision = 0,
  anchor = 0,
  clock = 0,
  busy = false,
  detailsOpen = false,
  draft = {},
  selectedId,
  selectedVersion,
  reauth = 0,
  queued = false;
let page = "dashboard",
  range = { from: "", to: "", period: "month", person: "", group: "day" };
let records = [];
const now = () => (anchor ? anchor + (performance.now() - clock) : Date.now());
const today = () => dayAt(now());
const resetPeriod = (p) => {
  const day = today();
  let from = day,
    to = day;
  if (p === "week") {
    const d = new Date(day + "T00:00:00Z").getUTCDay();
    from = shiftDay(day, -((d + 6) % 7));
    to = shiftDay(from, 6);
  }
  if (p === "month") {
    from = day.slice(0, 7) + "-01";
    const next = new Date(day.slice(0, 7) + "-01T00:00:00Z");
    next.setUTCMonth(next.getUTCMonth() + 1);
    to = shiftDay(next.toISOString().slice(0, 10), -1);
  }
  Object.assign(range, { period: p, from, to });
};
const categories = [
  "Client call",
  "Google Meet",
  "Zoom",
  "Telephone",
  "Research",
  "Design",
  "Development",
  "General work",
  "Other",
];
function login(configured = true) {
  view.innerHTML = `<div class="signin"><div><p class="eyeline">Private workspace</p><h1>Time &amp; billing.</h1><p class="sub">Mallik and Vittal’s shared work ledger.</p></div><section class="panel"><h2>Sign in to Daybook</h2><form id="login" class="stack">${field("Email address", "email", "email", "", 'autocomplete="username" required')}${field("Password", "password", "password", "", 'autocomplete="current-password" required')}<button class="btn primary" ${configured ? "" : "disabled"}>Sign in</button></form></section></div>`;
}
function totals(rows) {
  const t = { work: 0, brk: 0, bill: 0, amounts: new Map(), count: 0 };
  for (const r of rows) {
    t.work += num(r.work_seconds);
    t.brk += num(r.break_seconds);
    t.bill += num(r.billable_seconds);
    t.count += r.completed === true ? 1 : num(r.completed);
    const c = r.currency || "INR";
    t.amounts.set(c, (t.amounts.get(c) || 0) + num(r.amount));
  }
  return t;
}
const amounts = (t, c = "INR") =>
  [...t.amounts].map(([cc, a]) => money(a, cc)).join(" + ") || money(0, c);
const metrics = (t, c) =>
  metric("Working time", duration(t.work)) +
  metric("Break time", duration(t.brk)) +
  metric("Billable time", duration(t.bill)) +
  metric("Estimated billing", amounts(t, c));
const summary = (rows, title) =>
  `<section class="summary"><h2>${title}</h2><div class="metrics">${metrics(totals(rows))}</div></section>`;
function detailFields() {
  return `<details id="details" ${detailsOpen ? "open" : ""}><summary>Session details</summary><div class="grid"><label>Activity<select name="category">${opt("", "No category", draft.category)}${categories.map((c) => opt(c, c, draft.category)).join("")}</select></label>${field("Client", "client", "text", draft.client)}${field("Project", "project", "text", draft.project)}${field("Meeting title", "title", "text", draft.title)}${field("Meeting URL", "url", "url", draft.url)}<label class="wide">Work notes<textarea name="notes">${esc(draft.notes)}</textarea></label></div></details>`;
}
function dashboard() {
  const ds = data.days.filter((d) => d.day === today());
  const panels = [...data.profiles]
    .sort((a, b) => Number(b.id === user.id) - Number(a.id === user.id))
    .map((p) => {
      const own = user.id === p.id,
        s = active(p.id),
        br = s?.timeline.at(-1)?.kind === "break",
        status = br ? "On break" : s ? "Working" : "Clocked out",
        t = totals(ds.filter((d) => d.user_id === p.id));
      const action = br
        ? ["Resume work", "resume"]
        : s
          ? ["Take a break", "break"]
          : ["Start work", "start"];
      return `<section class="panel"><div class="row"><div class="person"><span class="initial">${esc(p.name[0])}</span><div><b>${esc(p.name)}</b>${own ? "<div><small>Your workspace</small></div>" : ""}</div></div><span class="status ${br ? "break" : s ? "working" : ""}">${status}</span></div><div class="timer-label">${br ? "Current break" : "Session working time"}</div><div class="timer" data-timer="${esc(p.id)}">00:00:00</div>${own ? `<form id="clock-form" data-session="${esc(s?.id || "")}" data-revision="${esc(s?.revision || 0)}"><div class="actions"><button class="btn primary clock" name="action" value="${action[1]}">${action[0]}</button>${s ? '<button class="btn" name="action" value="stop">Clock out</button>' : ""}</div>${s ? "" : detailFields()}</form>` : ""}<div class="metrics">${metrics(t, p.currency)}${metric("Completed sessions", t.count)}</div></section>`;
    })
    .join("");
  view.innerHTML =
    heading("Workspace overview", prettyDate(today()) + " · Today") +
    `<div class="panels">${panels}</div>` +
    summary(ds, "Team totals") +
    `<div class="row sectionhead"><h2>Today’s sessions</h2><a href="#history" class="link">View history</a></div>` +
    historyTable(
      data.sessions
        .filter(
          (s) =>
            ds.some((d) => d.session_id === s.id) ||
            dayAt(s.timeline[0].at) === today(),
        )
        .slice(0, 8),
    );
  tick();
}
function tick() {
  for (const node of document.querySelectorAll("[data-timer]")) {
    const s = active(node.dataset.timer);
    if (!s) continue;
    const last = s.timeline.at(-1),
      extra = Math.floor((now() - Date.parse(last.at)) / 1000);
    node.textContent = duration(
      last.kind === "break"
        ? extra
        : num(s.work_seconds) +
            Math.max(0, Math.floor(now() / 1000) - Math.floor(anchor / 1000)),
    );
  }
}
function filters(group = false) {
  return `<form id="filters" class="filters"><label>Period<select name="period">${[
    ["day", "Today"],
    ["week", "This week"],
    ["month", "This month"],
    ["custom", "Custom dates"],
  ]
    .map((x) => opt(...x, range.period))
    .join(
      "",
    )}</select></label>${field("From", "from", "date", range.from, "required")}${field("Through", "to", "date", range.to, "required")}<label>Member<select name="person">${opt("", "Both members", range.person)}${data.profiles.map((p) => opt(p.id, p.name, range.person)).join("")}</select></label>${group ? `<label>Group by<select name="group">${["day", "member", "project", "client"].map((k) => opt(k, k[0].toUpperCase() + k.slice(1), range.group)).join("")}</select></label>` : ""}<button class="btn">Apply filters</button></form>`;
}
const filtered = (rows) =>
  rows.filter((r) => !range.person || range.person === r.user_id);
function flags(s) {
  const n = num(s.work_seconds) + num(s.break_seconds);
  return [
    !s.ended_at ? "Open session" : "",
    n > 12 * 3600 ? "Over 12 hours" : "",
  ]
    .filter(Boolean)
    .join(" · ");
}
function historyTable(rows) {
  return table(
    [
      "Member",
      "Started · IST",
      "Ended · IST",
      "Working",
      "Breaks",
      "Billable amount",
      "Session",
    ],
    [...rows]
      .sort(
        (a, b) => Date.parse(b.timeline[0].at) - Date.parse(a.timeline[0].at),
      )
      .map((s) => {
        const at = new Date(s.timeline[0].at),
          end = s.ended_at && new Date(s.ended_at);
        return [
          esc(name(s.user_id)),
          esc(dates.format(at) + " " + times.format(at)),
          end
            ? esc(dates.format(end) + " " + times.format(end))
            : "In progress",
          duration(s.work_seconds),
          duration(s.break_seconds),
          esc(money(s.amount, s.currency)),
          `<button class="link" data-inspect="${esc(s.id)}">Inspect</button> <small class="flag">${flags(s)}</small>`,
        ];
      }),
    "No sessions in this period.",
  );
}
function history() {
  const ids = new Set(data.days.map((d) => d.session_id));
  view.innerHTML =
    heading(
      "Session history",
      "Review recorded sessions, intervals and corrections.",
    ) +
    filters() +
    historyTable(
      filtered(data.sessions).filter(
        (s) =>
          ids.has(s.id) ||
          (s.timeline[0].at &&
            dayAt(s.timeline[0].at) >= range.from &&
            dayAt(s.timeline[0].at) <= range.to),
      ),
    );
}
function reports() {
  const rows = filtered(data.days),
    groups = new Map();
  for (const r of rows) {
    const key =
      range.group === "member"
        ? name(r.user_id)
        : range.group === "day"
          ? r.day
          : r[range.group] || "Unassigned";
    const id = JSON.stringify([key, r.currency]);
    if (!groups.has(id)) groups.set(id, { key, rows: [] });
    groups.get(id).rows.push(r);
  }
  records = [...groups.values()]
    .sort((a, b) => a.key.localeCompare(b.key))
    .map((g) => {
      const t = totals(g.rows),
        c = g.rows[0].currency;
      return [
        g.key,
        duration(t.work),
        duration(t.brk),
        duration(t.bill),
        c,
        (t.amounts.get(c) || 0).toFixed(2),
        String(t.count),
      ];
    });
  view.innerHTML =
    heading(
      "Billing reports",
      "Timesheets and billing by period.",
      `<div class="actions">${btn("Export CSV", "csv")}${btn("Print / PDF", "print")}</div>`,
    ) +
    filters(true) +
    `<p class="range">${esc(prettyDate(range.from))} – ${esc(prettyDate(range.to))} · ${esc(range.person ? name(range.person) : "Both members")} · IST</p>` +
    summary(rows, "Period totals") +
    table(
      reportHeads(),
      records.map((r) => r.map(esc)),
      "No billable activity in this period.",
    );
}
const reportHeads = () => [
  range.group[0].toUpperCase() + range.group.slice(1),
  "Working",
  "Breaks",
  "Billable",
  "Currency",
  "Amount",
  "Completed sessions",
];
function settings() {
  const p = data.profiles.find((p) => p.id === user.id);
  view.innerHTML =
    heading("Billing settings", "Rates apply when a session is completed.") +
    `<div class="settings">${table(
      ["Member", "Hourly rate", "Billing increment"],
      data.profiles.map((p) => [
        esc(p.name),
        esc(money(p.rate, p.currency)),
        p.increment_seconds
          ? esc(p.increment_seconds) + " seconds"
          : "Exact seconds",
      ]),
      "No profiles available.",
    )}<form id="rates" class="panel stack"><h2>Your billing rate</h2><div class="grid">${field("Hourly rate", "rate", "number", p.rate, 'min="0" step="0.01" required')}${field("Currency code", "currency", "text", p.currency, 'pattern="[A-Za-z]{3}" maxlength="3" required')}${field("Billing increment (seconds)", "increment", "number", p.increment_seconds, 'min="0" step="1" required')}</div><small>Use 0 for exact time. A positive increment rounds billable time up when a session is completed.</small><div><button class="btn primary">Save settings</button></div></form></div>`;
}
function render() {
  if (!data || !user) return;
  ({ dashboard, history, reports, settings })[page]();
}
function setNav() {
  document.querySelector("nav").hidden = !user;
  $("#signout").hidden = !user;
  for (const a of document.querySelectorAll("nav a")) {
    if (a.hash === "#" + page) a.setAttribute("aria-current", "page");
    else a.removeAttribute("aria-current");
  }
}
function periodArgs() {
  return page === "dashboard" || page === "settings"
    ? { p_from: today(), p_to: today() }
    : { p_from: range.from, p_to: range.to };
}
async function rpc(fn, args) {
  const { data, error } = await db.rpc(fn, args);
  if (error) throw Error(error.message);
  return data;
}
async function refresh(silent = false) {
  if (!user) return;
  const ticket = ++revision,
    who = user.id,
    where = page,
    args = periodArgs();
  if (!silent && !data) view.innerHTML = "<p>Loading workspace…</p>";
  try {
    const fresh = await rpc("snapshot", args);
    if (ticket !== revision || who !== user?.id || where !== page) return;
    if (!fresh.profiles.some((p) => p.id === who))
      throw Error("This account does not have workspace access.");
    data = fresh;
    anchor = Date.parse(fresh.now);
    clock = performance.now();
    if (
      (where === "dashboard" || where === "settings") &&
      today() !== args.p_from
    ) {
      await refresh();
      return;
    }
    const holdForm =
      view.contains(document.activeElement) &&
      ["INPUT", "SELECT", "TEXTAREA"].includes(document.activeElement.tagName);
    if (!silent || (!holdForm && !view.querySelector("[data-dirty]"))) render();
  } catch (e) {
    if (ticket === revision) {
      msg(e.message);
      if (!data) view.innerHTML = btn("Try again", "retry");
    }
  }
}
function notifyRefresh() {
  if (queued) return;
  queued = true;
  setTimeout(() => {
    queued = false;
    if (!busy && !document.hidden) refresh(true);
  }, 220);
}
async function activate(session) {
  const u = session?.user;
  if (u && user?.id === u.id) return;
  ++revision;
  const authTicket = ++reauth;
  if (channel) {
    const old = channel;
    channel = null;
    db.removeChannel(old);
  }
  if (dialog.open) dialog.close();
  user = u;
  data = null;
  draft = {};
  detailsOpen = false;
  anchor = 0;
  setNav();
  msg("");
  if (!user) {
    login();
    return;
  }
  resetPeriod("month");
  channel = db
    .channel("daybook-" + user.id)
    .on(
      "postgres_changes",
      { event: "*", schema: "public", table: "work_sessions" },
      notifyRefresh,
    )
    .on(
      "postgres_changes",
      { event: "*", schema: "public", table: "profiles" },
      notifyRefresh,
    )
    .subscribe();
  if (authTicket === reauth) await refresh();
}
function route() {
  const key = location.hash.slice(1);
  page = ["dashboard", "reports", "history", "settings"].includes(key)
    ? key
    : "dashboard";
  setNav();
  if (user) {
    view.innerHTML = "<p>Loading workspace…</p>";
    refresh();
  }
}
function inspect(id) {
  const s = data.sessions.find((r) => r.id === id);
  if (!s) return;
  selectedId = id;
  selectedVersion = s.revision;
  const d = s.details || {},
    p = data.profiles.find((p) => p.id === s.user_id),
    c = s.currency || p?.currency;
  $("#dialog-title").textContent = name(s.user_id) + " · Session";
  const audits = (data.audit || []).filter(
    (a) => a.session_id === id && a.action === "correction",
  );
  $("#dialog-body").innerHTML =
    `<div class="stack"><div><p>${esc(dates.format(new Date(s.timeline[0].at)))} · IST</p><small class="flag">${flags(s)}</small></div><div class="metrics">${metric("Elapsed", duration(num(s.work_seconds) + num(s.break_seconds)))}${metric("Working", duration(s.work_seconds))}${metric("Breaks", duration(s.break_seconds))}${metric("Billable", duration(s.billable_seconds))}${metric("Hourly rate", money(s.rate ?? p?.rate, c))}${metric("Amount", money(s.amount, c))}</div><section><h3>Work details</h3><div class="grid">${[
      ["category", "Activity"],
      ["client", "Client"],
      ["project", "Project"],
      ["title", "Meeting"],
      ["url", "Meeting URL"],
      ["notes", "Notes"],
    ]
      .map(
        ([k, l]) =>
          `<div><small>${l}</small><p style="overflow-wrap:anywhere;white-space:pre-wrap">${esc(d[k] || "—")}</p></div>`,
      )
      .join(
        "",
      )}</div></section><section><h3>Timeline</h3><ol class="timeline">${s.timeline
      .map((t, i) => {
        const end = s.timeline[i + 1]?.at || s.ended_at;
        return `<li><b>${t.kind === "work" ? "Work" : "Break"}</b> · ${esc(dateInput(t.at).replace("T", " "))} – ${end ? esc(dateInput(end).replace("T", " ")) : "ongoing"}</li>`;
      })
      .join(
        "",
      )}</ol></section>${audits.length ? `<section><h3>Corrections</h3>${audits.map((a) => `<details><summary>${esc(a.reason || "Correction")}</summary><pre>${esc(JSON.stringify(a, null, 2))}</pre></details>`).join("")}</section>` : ""}${s.user_id === user.id ? btn("Correct timestamps", "edit") : ""}</div>`;
  if (!dialog.open) dialog.showModal();
}
function editRow(t) {
  return `<div class="grid time-edit"><label>Interval<select name="kind">${opt("work", "Work", t.kind)}${opt("break", "Break", t.kind)}</select></label>${field("Start · IST", "at", "datetime-local", t.at ? dateInput(t.at) : "", 'step="1" required')}<div>${btn("Remove interval", "remove")}</div></div>`;
}
function edit() {
  const s = data.sessions.find((r) => r.id === selectedId);
  $("#dialog-title").textContent = "Correct timestamps";
  $("#dialog-body").innerHTML =
    `<form id="correction" class="stack"><div id="intervals" class="stack">${s.timeline.map(editRow).join("")}</div><div>${btn("Add interval", "add")}</div>${field("Clock out · IST (blank for an open session)", "end", "datetime-local", s.ended_at ? dateInput(s.ended_at) : "", 'step="1"')}<label>Reason for correction<textarea name="reason" required></textarea></label><p class="dialog-msg" role="status"></p><div class="form-actions"><button class="btn primary">Save correction</button>${btn("Cancel", "back")}</div></form>`;
}
function exportCsv() {
  const safe = (x) => {
    let s = String(x);
    if (/^[\s]*[=+\-@\t\r]/.test(s)) s = "'" + s;
    return '"' + s.replace(/"/g, '""') + '"';
  };
  const csv = [reportHeads(), ...records]
    .map((r) => r.map(safe).join(","))
    .join("\r\n");
  const a = document.createElement("a");
  a.href = URL.createObjectURL(
    new Blob(["\ufeff", csv], { type: "text/csv;charset=utf-8" }),
  );
  a.download = `daybook-${range.from}-${range.to}.csv`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}
function isActiveFilter() {
  return document.activeElement?.closest("#filters");
}
document.addEventListener("click", (e) => {
  const button = e.target.closest("button");
  if (!button) return;
  if (button.dataset.inspect) {
    inspect(button.dataset.inspect);
    return;
  }
  switch (button.dataset.do) {
    case "edit":
      edit();
      break;
    case "back":
      inspect(selectedId);
      break;
    case "add":
      $("#intervals").insertAdjacentHTML(
        "beforeend",
        editRow({
          kind:
            $("#intervals .time-edit:last-child select")?.value === "work"
              ? "break"
              : "work",
        }),
      );
      break;
    case "remove":
      button.closest(".time-edit").remove();
      break;
    case "csv":
      exportCsv();
      break;
    case "print":
      window.print();
      break;
    case "retry":
      refresh();
      break;
  }
});
document.addEventListener("input", (e) => {
  if (e.target.closest("#details")) draft[e.target.name] = e.target.value;
  const form = e.target.closest("#rates,#filters");
  if (form) form.dataset.dirty = "true";
});
document.addEventListener(
  "toggle",
  (e) => {
    if (e.target.id === "details" && e.target.isConnected)
      detailsOpen = e.target.open;
  },
  true,
);
document.addEventListener("change", (e) => {
  const f = e.target.closest("#filters");
  if (!f) return;
  f.dataset.dirty = "true";
  if (e.target.name === "period" && e.target.value !== "custom") {
    const saved = { ...range };
    resetPeriod(e.target.value);
    f.elements.from.value = range.from;
    f.elements.to.value = range.to;
    range = saved;
  } else if (["from", "to"].includes(e.target.name))
    f.elements.period.value = "custom";
});
document.addEventListener("submit", async (e) => {
  e.preventDefault();
  if (busy) return;
  const f = e.target,
    values = Object.fromEntries(new FormData(f)),
    button = e.submitter;
  busy = true;
  if (button) button.disabled = true;
  msg("");
  try {
    if (f.id === "login") {
      const { error } = await db.auth.signInWithPassword({
        email: values.email.trim(),
        password: values.password,
      });
      if (error) throw error;
    } else if (f.id === "filters") {
      if (values.from > values.to)
        throw Error("The end date must follow the start date.");
      Object.assign(range, values);
      await refresh();
    } else if (f.id === "clock-form") {
      const action = button.value;
      await rpc("act", {
        p_action: action,
        p_id: f.dataset.session || crypto.randomUUID(),
        p_revision: Number(f.dataset.revision),
        p_details:
          action === "start"
            ? Object.fromEntries(
                Object.entries(draft).filter(([, v]) => v.trim()),
              )
            : {},
      });
      if (action === "start") {
        draft = {};
        detailsOpen = false;
      }
      await refresh();
    } else if (f.id === "rates") {
      await rpc("set_rate", {
        p_rate: Number(values.rate),
        p_currency: values.currency.trim().toUpperCase(),
        p_increment: Number(values.increment),
      });
      await refresh();
      msg("Billing settings saved.");
    } else if (f.id === "correction") {
      const stamps = [...f.querySelectorAll(".time-edit")].map((row) => ({
        kind: row.querySelector("[name=kind]").value,
        at: new Date(
          row.querySelector("[name=at]").value + "+05:30",
        ).toISOString(),
      }));
      if (!stamps.length || !values.reason.trim())
        throw Error("Enter at least one interval and a correction reason.");
      await rpc("correct_session", {
        p_id: selectedId,
        p_revision: selectedVersion,
        p_timeline: stamps,
        p_end: values.end
          ? new Date(values.end + "+05:30").toISOString()
          : null,
        p_reason: values.reason.trim(),
      });
      dialog.close();
      await refresh();
      msg("Correction saved. Billing has been recalculated.");
    }
  } catch (err) {
    if (dialog.open && $(".dialog-msg"))
      $(".dialog-msg").textContent = err.message;
    else msg(err.message);
    if (f.id === "clock-form") await refresh(true);
  } finally {
    busy = false;
    if (button?.isConnected) button.disabled = false;
  }
});
$("#close").onclick = () => dialog.close();
$("#signout").onclick = async () => {
  const { error } = await db.auth.signOut({ scope: "local" });
  if (error) msg(error.message);
  else await activate(null);
};
window.addEventListener("hashchange", route);
document.addEventListener("visibilitychange", () => {
  if (!document.hidden) notifyRefresh();
});
window.addEventListener("online", notifyRefresh);
setInterval(() => {
  if (user && data && page === "dashboard") tick();
}, 500);
setInterval(() => {
  if (!busy && !document.hidden && !isActiveFilter()) notifyRefresh();
}, 15000);
async function boot() {
  route();
  login(false);
  try {
    const { url, key } = await import("./config.js");
    if (!url || !key) {
      msg(
        "Workspace setup is pending. Configure the Supabase URL and public key to enable sign-in.",
      );
      return;
    }
    db = window.supabase.createClient(url, key);
    db.auth.onAuthStateChange((_event, session) => {
      setTimeout(() => activate(session), 0);
    });
    login(true);
    const { data: auth, error } = await db.auth.getSession();
    if (error) throw error;
    await activate(auth.session);
  } catch (e) {
    msg("Could not open the workspace. " + e.message);
  }
}
boot();
