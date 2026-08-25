// The SQL the in-memory fakes stand in for. Every other coach-automation suite
// injects a hand-written database so it can run under plain node; that means a
// WHERE clause can be wrong in database.ts and every one of them still passes.
// This one opens a real SQLite file, which is why it runs under Electron:
// better-sqlite3 is built for the Electron ABI and will not dlopen otherwise.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const repoRoot = path.resolve(import.meta.dirname, "..");
const distUrl = (file) =>
  `${pathToFileURL(path.join(repoRoot, "dist-electron", file)).href}?cacheBust=${Date.now()}`;
const database = await import(distUrl("database.js"));

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "coroslink-coach-sql-"));
database.initializeDatabase(tempRoot);

const run = (patch) => ({
  id: patch.id,
  automation_id: patch.automation_id ?? "auto-1",
  binding_id: patch.binding_id ?? "bind-1",
  status: patch.status ?? "success",
  trigger_kind: patch.trigger_kind ?? "activity",
  trigger_payload_json: null,
  session_id: patch.session_id ?? null,
  summary: null,
  model: null,
  effort: null,
  error: null,
  skip_reason: patch.skip_reason ?? null,
  seen_at: patch.seen_at ?? null,
  started_at: patch.started_at ?? "2026-08-25T07:00:00.000Z",
  finished_at: patch.finished_at ?? "2026-08-25T07:00:04.000Z"
});

// Distinct timestamps throughout: ordering has to be a property of the SQL,
// not of the order the rows happened to be inserted in.
const rows = [
  run({
    id: "r-read",
    session_id: "s-a",
    started_at: "2026-08-25T07:01:00.000Z",
    seen_at: "2026-08-25T08:00:00.000Z"
  }),
  run({ id: "r-unread", session_id: "s-a", started_at: "2026-08-25T07:02:00.000Z" }),
  run({
    id: "r-silent",
    session_id: "s-a",
    status: "silent",
    started_at: "2026-08-25T07:03:00.000Z"
  }),
  run({
    id: "r-skip",
    session_id: "s-a",
    status: "skipped",
    skip_reason: "cooldown",
    started_at: "2026-08-25T07:04:00.000Z"
  }),
  run({ id: "r-other", session_id: "s-b", started_at: "2026-08-25T07:05:00.000Z" }),
  run({ id: "r-orphan", started_at: "2026-08-25T07:06:00.000Z" }),
  run({
    id: "r-old",
    session_id: "s-a",
    started_at: "2026-08-01T07:00:00.000Z",
    finished_at: "2026-08-01T07:00:04.000Z"
  })
];
for (const row of rows) database.insertCoachAutomationRunRow(row);

const ids = (filter) =>
  database.listCoachAutomationRunRows(filter).map((row) => row.id).sort();

// --- the filters, one at a time -------------------------------------------
assert.deepEqual(ids({ sessionId: "s-b" }), ["r-other"]);
assert.deepEqual(ids({ statuses: ["silent"] }), ["r-silent"]);
assert.deepEqual(
  ids({ since: "2026-08-20T00:00:00.000Z" }).includes("r-old"),
  false,
  "`since` is an inclusive lower bound on started_at"
);
assert.deepEqual(
  ids({ unseenOnly: true }).includes("r-read"),
  false,
  "a run already stamped seen_at is not unseen"
);
assert.equal(
  ids({ unseenOnly: true }).length,
  rows.length - 1,
  "and every other run still is"
);

// --- combined, which is how the conversation list asks --------------------
// This is the exact query behind the unread dot (9.3), and it is the one the
// hand-written fakes cannot vouch for.
assert.deepEqual(
  ids({ sessionId: "s-a", statuses: ["success", "silent"], unseenOnly: true }),
  ["r-old", "r-silent", "r-unread"],
  "unread runs that wrote something, in one conversation"
);

// Stamping one clears it from that answer and leaves the rest alone.
const stamped = database.getCoachAutomationRunRow("r-unread");
database.updateCoachAutomationRunRow({
  ...stamped,
  seen_at: "2026-08-25T09:00:00.000Z"
});
assert.deepEqual(
  ids({ sessionId: "s-a", statuses: ["success", "silent"], unseenOnly: true }),
  ["r-old", "r-silent"],
  "seen_at is what removes a run from the unread answer"
);
assert.equal(
  database.listCoachAutomationRunRows({ sessionId: "s-a" }).length,
  5,
  "and nothing was deleted along the way"
);

// --- ordering and the cap -------------------------------------------------
assert.deepEqual(
  database
    .listCoachAutomationRunRows({ sessionId: "s-a", limit: 2 })
    .map((row) => row.id),
  ["r-skip", "r-silent"],
  "newest first, so a limit keeps the most recent"
);

// --- the index the activity scan leans on (3.2) ---------------------------
// A per-binding watermark asks "what landed after this timestamp" on every
// trigger, once per binding. Without the index that is a full scan of the
// athlete's whole history.
const plan = database
  .requireDatabase()
  .prepare(
    `EXPLAIN QUERY PLAN
     SELECT activity_id FROM training_activities
     WHERE start_time IS NOT NULL AND start_time > ?
     ORDER BY start_time DESC LIMIT ?`
  )
  .all(0, 10)
  .map((step) => step.detail)
  .join(" | ");
assert.match(
  plan,
  /idx_training_activities_start_time/,
  `the activity scan must use its index, got: ${plan}`
);

fs.rmSync(tempRoot, { recursive: true, force: true });
console.log("coach automation sql tests passed");
