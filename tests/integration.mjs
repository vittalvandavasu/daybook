// Run with npm install && npm test inside tests/. Uses an isolated in-memory database.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";

const { PGlite } = await import(
  process.env.PGLITE_MODULE || "@electric-sql/pglite"
);
const db = new PGlite();
const mallik = randomUUID();
const vittal = randomUUID();
const stranger = randomUUID();
const emails = {
  [mallik]: "mallik.fico@gmail.com",
  [vittal]: "vittalvandavasu16@gmail.com",
  [stranger]: "outsider@example.org",
};
const today = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Asia/Kolkata",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
}).format(new Date());
const query = async (sql, params = []) => (await db.query(sql, params)).rows;
const value = async (sql, params) => (await query(sql, params))[0].result;
async function become(user) {
  await db.exec("reset role");
  await query(
    "select set_config('request.jwt.claim.sub',$1,false), set_config('request.jwt.claims',$2,false)",
    [
      user,
      JSON.stringify({ sub: user, email: emails[user], role: "authenticated" }),
    ],
  );
  await db.exec("set role authenticated");
}
const snapshot = (start = today, end = today) =>
  value("select public.snapshot($1::date,$2::date) result", [start, end]);
const act = (action, id, revision, details = {}) =>
  query("select public.act($1,$2,$3,$4::jsonb)", [
    action,
    id,
    revision,
    JSON.stringify(details),
  ]);
const getSession = async (id) =>
  (await snapshot()).sessions.find((s) => s.id === id);
const setRate = (rate, increment = 0) =>
  query("select public.set_rate($1,'INR',$2)", [rate, increment]);
const correct = (id, rev, points, end, reason) =>
  query("select public.correct_session($1,$2,$3::jsonb,$4,$5)", [
    id,
    rev,
    JSON.stringify(points),
    end,
    reason,
  ]);
async function denied(operation, label) {
  await assert.rejects(operation, undefined, label);
}
async function clockCycle(user, rate, count, stopOnBreak = false) {
  await become(user);
  await setRate(rate);
  const id = randomUUID();
  await act("start", id, 0, {
    category: "Research",
    project: "Testing",
    client: "Internal",
  });
  await denied(() => act("start", randomUUID(), 0), "second active session");
  let active = await getSession(id);
  assert.equal(active.user_id, user);
  assert.equal(active.ended_at, null);
  const startingRevision = active.revision;
  await denied(
    () => act("resume", id, startingRevision),
    "resume while working",
  );
  for (let i = 0; i < count; i++) {
    await delay(1050);
    await act("break", id, active.revision);
    await denied(
      () => act("break", id, startingRevision),
      "stale duplicate break",
    );
    active = await getSession(id);
    if (!(stopOnBreak && i === count - 1)) {
      await delay(1050);
      await act("resume", id, active.revision);
      active = await getSession(id);
    }
  }
  await delay(1050);
  await act("stop", id, active.revision);
  await denied(() => act("stop", id, active.revision), "duplicate stop");
  const done = await getSession(id);
  assert.ok(done.ended_at);
  assert.equal(Number(done.rate), rate);
  assert.ok(done.work_seconds > 0 && done.break_seconds > 0);
  assert.equal(done.billable_seconds, done.work_seconds);
  assert.equal(done.timeline.filter((p) => p.kind === "break").length, count);
  assert.equal(
    done.work_seconds + done.break_seconds,
    Math.floor(
      (Date.parse(done.ended_at) - Date.parse(done.timeline[0].at)) / 1000,
    ),
  );
  await setRate(rate * 2);
  const preserved = await getSession(id);
  assert.equal(Number(preserved.rate), rate);
  assert.equal(preserved.amount, done.amount);
  return done;
}

try {
  await db.exec(`create role anon;
    create role authenticated;
    create role service_role bypassrls;
    create schema auth;
    create table auth.users (id uuid primary key, email text unique, email_confirmed_at timestamptz default now());
    create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
    create function auth.jwt() returns jsonb language sql stable as $$select nullif(current_setting('request.jwt.claims',true),'')::jsonb$$;
    grant usage on schema auth to anon,authenticated;
    create publication supabase_realtime;`);
  for (const [id, email] of Object.entries(emails))
    await query("insert into auth.users(id,email) values ($1,$2)", [id, email]);
  await db.exec(
    await readFile(new URL("../migration.sql", import.meta.url), "utf8"),
  );
  console.log("PASS migration applied to clean PostgreSQL");
  await db.exec("set role anon");
  await denied(() => snapshot(), "anonymous reporting");
  await become(stranger);
  await denied(() => act("start", randomUUID(), 0), "outsider clock action");
  assert.equal((await query("select id from public.work_sessions")).length, 0);
  await become(mallik);
  const first = await clockCycle(mallik, 3600, 2);
  console.log(
    "PASS Mallik multiple breaks, stale/invalid actions, active-session uniqueness, preserved rate",
  );
  const second = await clockCycle(vittal, 7200, 1, true);
  console.log("PASS Vittal clock-out on break and preserved rate");
  assert.ok((await getSession(first.id)).ended_at);
  await denied(
    () =>
      correct(
        first.id,
        first.revision,
        first.timeline,
        first.ended_at,
        "cross-user change",
      ),
    "self-only corrections",
  );
  await denied(
    () =>
      query("update public.work_sessions set revision=revision+1 where id=$1", [
        second.id,
      ]),
    "direct write",
  );
  await become(mallik);
  const points = [
    { kind: "work", at: "2020-01-01T18:29:00Z" },
    { kind: "break", at: "2020-01-01T18:29:30Z" },
    { kind: "work", at: "2020-01-01T18:30:30Z" },
  ];
  const end = "2020-01-01T18:31:00Z";
  await denied(
    () => correct(first.id, first.revision, points, end, " "),
    "reason required",
  );
  await denied(
    () =>
      correct(
        first.id,
        first.revision,
        [points[2], points[1]],
        end,
        "reversed",
      ),
    "chronological ordering",
  );
  await denied(
    () =>
      correct(
        first.id,
        first.revision,
        [points[0], points[2]],
        end,
        "two starts",
      ),
    "alternating intervals",
  );
  await correct(
    first.id,
    first.revision,
    points,
    end,
    "Corrected from meeting notes",
  );
  await denied(
    () =>
      correct(first.id, first.revision, points, end, "duplicate correction"),
    "stale correction",
  );
  const historical = await snapshot("2020-01-01", "2020-01-02");
  const updated = historical.sessions.find((s) => s.id === first.id);
  assert.equal(Number(updated.work_seconds), 60);
  assert.equal(Number(updated.break_seconds), 60);
  assert.equal(Number(updated.amount), 60);
  const days = historical.days
    .filter((d) => d.session_id === first.id)
    .sort((a, b) => a.day.localeCompare(b.day));
  assert.deepEqual(
    days.map((d) => [
      d.day,
      Number(d.work_seconds),
      Number(d.break_seconds),
      Number(d.amount),
    ]),
    [
      ["2020-01-01", 30, 30, 30],
      ["2020-01-02", 30, 30, 30],
    ],
  );
  const audit = historical.audit.find(
    (row) => row.reason === "Corrected from meeting notes",
  );
  assert.deepEqual(audit.before_data.timeline, first.timeline);
  assert.deepEqual(audit.after_data.timeline, updated.timeline);
  assert.deepEqual(
    days.map((d) => d.completed),
    [false, true],
  );
  console.log(
    "PASS corrections, audit, shared visibility, direct writes denied, IST midnight allocation",
  );
  await setRate(60, 900);
  const roundedId = randomUUID();
  await act("start", roundedId, 0);
  const open = await getSession(roundedId);
  const historicalWhileOpen = await snapshot("2020-01-01", "2020-01-01");
  assert.ok(
    historicalWhileOpen.sessions.some(
      (s) => s.id === roundedId && s.ended_at === null,
    ),
  );
  assert.ok(historicalWhileOpen.days.every((d) => d.session_id !== roundedId));
  await correct(
    roundedId,
    open.revision,
    [{ kind: "work", at: "2020-01-02T18:29:59Z" }],
    "2020-01-02T18:30:01Z",
    "Finish forgotten session",
  );
  const roundedReport = await snapshot("2020-01-02", "2020-01-03");
  const rounded = roundedReport.sessions.find((s) => s.id === roundedId);
  assert.equal(rounded.work_seconds, 2);
  assert.equal(rounded.billable_seconds, 900);
  assert.equal(rounded.amount, 15);
  const slices = roundedReport.days.filter((d) => d.session_id === roundedId);
  assert.equal(
    slices.reduce((sum, d) => sum + d.billable_seconds, 0),
    900,
  );
  assert.equal(
    slices.reduce((sum, d) => sum + Math.round(100 * d.amount), 0),
    1500,
  );
  console.log(
    "PASS active-session recovery, opt-in increments, cent allocation across dates",
  );
} catch (error) {
  console.error(error.message);
  if (error.where) console.error(error.where);
  process.exitCode = 1;
} finally {
  await db.close();
}
