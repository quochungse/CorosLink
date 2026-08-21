import assert from "node:assert/strict";
import path from "node:path";
import { pathToFileURL } from "node:url";

const repoRoot = path.resolve(import.meta.dirname, "..");
const distUrl = (file) =>
  pathToFileURL(path.join(repoRoot, "dist-electron", file)).href;

const {
  DEFAULT_AUTOMATION_CONDITIONS,
  cancelStaleCoachAutomationRuns,
  listCoachAutomationRuns,
  recordCoachAutomationRun,
  countCoachAutomationBindings,
  createCoachAutomation,
  deleteCoachAutomation,
  getCoachAutomation,
  listCoachAutomations,
  normalizeAutomationConditions,
  normalizeAutomationRuntime,
  normalizeAutomationTrigger,
  setCoachAutomationEnabled,
  updateCoachAutomation
} = await import(`${distUrl("coachAutomationStore.js")}?cacheBust=${Date.now()}`);

// better-sqlite3 is built for the Electron ABI and will not dlopen under plain
// node, so the store is exercised through its injectable database interface.
function createMemoryDatabase() {
  /** @type {Map<string, Record<string, unknown>>} */
  const rows = new Map();
  /** @type {Map<string, number>} */
  const bindings = new Map();
  /** @type {Array<Record<string, unknown>>} */
  const runs = [];

  return {
    _rows: rows,
    _bindings: bindings,
    _runs: runs,
    listAutomations() {
      return [...rows.values()].sort((left, right) =>
        left.created_at.localeCompare(right.created_at)
      );
    },
    getAutomation(id) {
      const row = rows.get(id);
      return row ? { ...row } : undefined;
    },
    insertAutomation(row) {
      assert.ok(!rows.has(row.id), "duplicate automation id");
      rows.set(row.id, { ...row });
    },
    updateAutomation(row) {
      assert.ok(rows.has(row.id), "update of unknown automation");
      rows.set(row.id, { ...row });
    },
    deleteAutomation(id) {
      rows.delete(id);
    },
    deleteBindingsForAutomation(automationId) {
      bindings.delete(automationId);
    },
    countBindings(automationId) {
      return bindings.get(automationId) ?? 0;
    },
    listRuns(filter = {}) {
      return runs.filter((run) =>
        filter.statuses ? filter.statuses.includes(run.status) : true
      );
    },
    getRun(id) {
      const row = runs.find((run) => run.id === id);
      return row ? { ...row } : undefined;
    },
    insertRun(row) {
      runs.push({ ...row });
    },
    updateRun(row) {
      const index = runs.findIndex((run) => run.id === row.id);
      if (index >= 0) runs[index] = { ...row };
    }
  };
}

const db = createMemoryDatabase();

// --- create: defaults applied, trigger round-trips -------------------------
const daily = createCoachAutomation(
  {
    name: "  Morning briefing  ",
    role: "Strict marathon coach, injury-prevention first",
    playbook: "Summarise yesterday and set today's focus.",
    trigger: { kind: "schedule", cadence: "daily", timeOfDay: "07:30" }
  },
  db
);

assert.equal(daily.name, "Morning briefing");
assert.equal(daily.role, "Strict marathon coach, injury-prevention first");
assert.equal(daily.enabled, true);
assert.deepEqual(daily.trigger, {
  kind: "schedule",
  cadence: "daily",
  timeOfDay: "07:30"
});
assert.deepEqual(daily.conditions, DEFAULT_AUTOMATION_CONDITIONS);
assert.deepEqual(daily.runtime, {});
assert.equal(daily.createdAt, daily.updatedAt);
assert.equal(daily.presetId, undefined);

// Persisted shape is the snake_case row the schema declares.
const storedRow = db._rows.get(daily.id);
assert.equal(storedRow.enabled, 1);
assert.equal(storedRow.preset_id, null);
assert.equal(JSON.parse(storedRow.trigger_json).timeOfDay, "07:30");

// --- create: required fields ------------------------------------------------
assert.throws(
  () => createCoachAutomation({ name: "  ", playbook: "x", trigger: { kind: "manual" } }, db),
  /name is required/
);
assert.throws(
  () => createCoachAutomation({ name: "x", playbook: "", trigger: { kind: "manual" } }, db),
  /playbook is required/
);

// A half-filled schedule must not silently become a never-firing "manual".
assert.throws(
  () =>
    createCoachAutomation(
      { name: "x", playbook: "y", trigger: { kind: "schedule", cadence: "daily" } },
      db
    ),
  /trigger "schedule" is incomplete/
);

// --- create: weekly + activity + runtime overrides --------------------------
const weekly = createCoachAutomation(
  {
    name: "Long run debrief",
    playbook: "Debrief the long run.",
    enabled: false,
    presetId: "long-run-debrief",
    trigger: {
      kind: "activity",
      sportTypes: [100, "junk", 102],
      minDurationSec: 3600.4,
      minDistanceM: -5
    },
    conditions: { cooldownMin: 30, quietHours: { start: "22:00", end: "06:30" } },
    runtime: { provider: "claude-api", model: "claude-opus-5", effort: "high" }
  },
  db
);

assert.equal(weekly.enabled, false);
assert.equal(weekly.presetId, "long-run-debrief");
assert.deepEqual(weekly.trigger, {
  kind: "activity",
  sportTypes: [100, 102],
  minDurationSec: 3600
});
assert.equal(weekly.trigger.minDistanceM, undefined, "non-positive filter dropped");
assert.deepEqual(weekly.conditions, {
  batchWindowMin: 20,
  cooldownMin: 30,
  maxRunsPerDay: 3,
  quietHours: { start: "22:00", end: "06:30" }
});
assert.deepEqual(weekly.runtime, {
  provider: "claude-api",
  model: "claude-opus-5",
  effort: "high"
});

// --- list: insertion order by created_at -----------------------------------
const listed = listCoachAutomations(db);
assert.equal(listed.length, 2);
assert.deepEqual(
  listed.map((entry) => entry.id),
  [daily.id, weekly.id]
);
assert.deepEqual(getCoachAutomation(daily.id, db), daily);
assert.equal(getCoachAutomation("missing", db), null);

// --- update: patches only what it is given ---------------------------------
const renamed = updateCoachAutomation(
  daily.id,
  { name: "Evening briefing", conditions: { maxRunsPerDay: 1 } },
  db
);
assert.equal(renamed.name, "Evening briefing");
assert.equal(renamed.playbook, daily.playbook);
assert.equal(renamed.role, daily.role, "untouched role survives");
assert.deepEqual(renamed.trigger, daily.trigger);
assert.equal(renamed.conditions.maxRunsPerDay, 1);
assert.equal(
  renamed.conditions.cooldownMin,
  DEFAULT_AUTOMATION_CONDITIONS.cooldownMin,
  "partial conditions patch keeps the other guard rails"
);
assert.equal(renamed.createdAt, daily.createdAt);
assert.ok(renamed.updatedAt >= daily.updatedAt);

// A partial conditions patch on a customised automation keeps the custom values.
const rebatched = updateCoachAutomation(weekly.id, { conditions: { batchWindowMin: 5 } }, db);
assert.equal(rebatched.conditions.batchWindowMin, 5);
assert.equal(rebatched.conditions.cooldownMin, 30, "custom cooldown preserved");
assert.deepEqual(rebatched.conditions.quietHours, { start: "22:00", end: "06:30" });

// Explicit null clears the quiet window.
const noQuiet = updateCoachAutomation(weekly.id, { conditions: { quietHours: null } }, db);
assert.equal(noQuiet.conditions.quietHours, undefined);

// Clearing an optional string removes the key rather than storing "".
const roleless = updateCoachAutomation(daily.id, { role: "  " }, db);
assert.equal(roleless.role, undefined);
assert.equal(db._rows.get(daily.id).role, null);

assert.equal(updateCoachAutomation("missing", { name: "x" }, db), null);
assert.throws(() => updateCoachAutomation(daily.id, { name: "" }, db), /name is required/);

// --- enable toggle ----------------------------------------------------------
assert.equal(setCoachAutomationEnabled(weekly.id, true, db).enabled, true);
assert.equal(db._rows.get(weekly.id).enabled, 1);
assert.equal(setCoachAutomationEnabled(weekly.id, false, db).enabled, false);
assert.equal(db._rows.get(weekly.id).enabled, 0);
assert.equal(setCoachAutomationEnabled("missing", true, db), null);

// --- normalizers: corrupt rows degrade instead of throwing ------------------
assert.deepEqual(normalizeAutomationTrigger(null), { kind: "manual" });
assert.deepEqual(normalizeAutomationTrigger({ kind: "nope" }), { kind: "manual" });
assert.deepEqual(normalizeAutomationTrigger({ kind: "schedule", timeOfDay: "25:00" }), {
  kind: "manual"
});
assert.deepEqual(
  normalizeAutomationTrigger({ kind: "schedule", cadence: "weekly", timeOfDay: "06:00", dayOfWeek: 9 }),
  { kind: "schedule", cadence: "weekly", timeOfDay: "06:00", dayOfWeek: 6 }
);
assert.deepEqual(normalizeAutomationTrigger({ kind: "threshold", metric: "sleepDebt" }), {
  kind: "manual"
});
assert.deepEqual(
  normalizeAutomationTrigger({ kind: "threshold", metric: "acuteChronicRamp", value: 25 }),
  { kind: "threshold", metric: "acuteChronicRamp", value: 25 }
);

// multiActivity is opt-in: a definition written before the option existed keeps
// the "newest activity only" behaviour it already had, and nothing but an
// explicit true turns the catch-up on.
assert.equal(
  normalizeAutomationTrigger({ kind: "activity", sportTypes: [] }).multiActivity,
  undefined
);
assert.equal(
  normalizeAutomationTrigger({ kind: "activity", sportTypes: [], multiActivity: "yes" })
    .multiActivity,
  undefined
);
assert.equal(
  normalizeAutomationTrigger({ kind: "activity", sportTypes: [], multiActivity: true })
    .multiActivity,
  true
);

assert.deepEqual(normalizeAutomationConditions("not json"), DEFAULT_AUTOMATION_CONDITIONS);
assert.equal(normalizeAutomationConditions({ maxRunsPerDay: 0 }).maxRunsPerDay, 1);
assert.equal(normalizeAutomationConditions({ maxRunsPerDay: 999 }).maxRunsPerDay, 24);
assert.equal(normalizeAutomationConditions({ cooldownMin: -5 }).cooldownMin, 0);
assert.equal(
  normalizeAutomationConditions({ quietHours: { start: "9pm", end: "6am" } }).quietHours,
  undefined
);

assert.deepEqual(normalizeAutomationRuntime({ provider: "openai", effort: "turbo" }), {});
assert.deepEqual(normalizeAutomationRuntime({ model: "  gpt  " }), { model: "gpt" });

// A row whose JSON is unparseable still yields a usable automation.
db._rows.set("corrupt", {
  id: "corrupt",
  name: "Corrupt",
  role: null,
  playbook: "p",
  enabled: 1,
  preset_id: null,
  trigger_json: "{not json",
  conditions_json: "{not json",
  runtime_json: null,
  created_at: "2026-08-21T00:00:00.000Z",
  updated_at: "2026-08-21T00:00:00.000Z"
});
const corrupt = getCoachAutomation("corrupt", db);
assert.deepEqual(corrupt.trigger, { kind: "manual" });
assert.deepEqual(corrupt.conditions, DEFAULT_AUTOMATION_CONDITIONS);
assert.deepEqual(corrupt.runtime, {});
db._rows.delete("corrupt");

// --- delete: takes the bindings, leaves everything else --------------------
db._bindings.set(weekly.id, 3);
assert.equal(countCoachAutomationBindings(weekly.id, db), 3);
assert.equal(countCoachAutomationBindings(daily.id, db), 0);

deleteCoachAutomation(weekly.id, db);
assert.equal(getCoachAutomation(weekly.id, db), null);
assert.equal(db._bindings.has(weekly.id), false, "bindings deleted with the definition");
assert.equal(listCoachAutomations(db).length, 1);

deleteCoachAutomation("missing", db); // no-op

// --- a run in flight when the app quit is reconciled at startup ------------
// Nothing is left to finish it, so without this the run log spins forever.
const runsAutomation = createCoachAutomation(
  { name: "Runs", playbook: "p", trigger: { kind: "manual" } },
  db
);
const inFlight = recordCoachAutomationRun(
  {
    automationId: runsAutomation.id,
    bindingId: "b1",
    status: "running",
    triggerKind: "manual"
  },
  db
);
const finished = recordCoachAutomationRun(
  {
    automationId: runsAutomation.id,
    bindingId: "b1",
    status: "success",
    triggerKind: "manual",
    summary: "All good.",
    finishedAt: "2026-08-21T09:00:00.000Z"
  },
  db
);

assert.equal(cancelStaleCoachAutomationRuns(db), 1, "only the in-flight run is stale");
const afterStartup = listCoachAutomationRuns({}, db);
const reconciled = afterStartup.find((run) => run.id === inFlight.id);
assert.equal(reconciled.status, "cancelled");
assert.ok(reconciled.finishedAt, "a reconciled run is no longer open-ended");
assert.match(reconciled.error, /app closed/);
assert.equal(
  afterStartup.find((run) => run.id === finished.id).status,
  "success",
  "a run that already finished is untouched"
);
assert.equal(cancelStaleCoachAutomationRuns(db), 0, "the second startup finds nothing");

console.log("coach automation store tests passed");
