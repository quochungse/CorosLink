import assert from "node:assert/strict";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const Module = require("node:module");
const repoRoot = path.resolve(import.meta.dirname, "..");

// The watcher reaches trainingHubService and the runner, which pull in electron
// and the better-sqlite3 native binding at require time. Every collaborator is
// injected per instance, so the stubs only exist to get the module loaded.
const fakeElectron = {
  BrowserWindow: Object.assign(class {}, { getAllWindows: () => [] }),
  app: { getPath: () => "/tmp", on: () => {}, whenReady: () => Promise.resolve() },
  safeStorage: { isEncryptionAvailable: () => false },
  shell: { openExternal: () => {} },
  net: { request: () => {} },
  session: { defaultSession: {} }
};
const originalLoad = Module._load;
Module._load = function patchedLoad(request, ...rest) {
  if (request === "electron") return fakeElectron;
  if (request === "better-sqlite3") return class FakeDatabase {};
  return originalLoad.call(this, request, ...rest);
};

const {
  ACTIVITY_LOOKBACK_DAYS,
  ACTIVITY_POLL_INTERVAL_MS,
  CoachActivityWatcher,
  activityMatchesAutomation
} = require(path.join(repoRoot, "dist-electron", "coachActivityWatcher.js"));

assert.equal(ACTIVITY_POLL_INTERVAL_MS, 15 * 60_000, "3.2: default poll is 15 minutes");
assert.equal(ACTIVITY_LOOKBACK_DAYS, 7);

// ---------------------------------------------------------------------------
// Matching (3.2 step 3)
// ---------------------------------------------------------------------------

// Inside the watcher's 7-day lookback from the world clock below.
const NOW_EPOCH = Math.floor(Date.parse("2026-08-21T09:00:00.000Z") / 1000);

const activity = (patch = {}) => ({
  activity_id: "act-1",
  name: "Morning run",
  sport_type: 100,
  sport_name: "Run",
  start_time: NOW_EPOCH - 3600,
  duration: 3600,
  distance: 12000,
  ...patch
});

const activityAutomation = (trigger = {}, patch = {}) => ({
  id: "a1",
  name: "Debrief",
  playbook: "Debrief {{activity.name}}.",
  enabled: true,
  trigger: { kind: "activity", sportTypes: [], ...trigger },
  conditions: { batchWindowMin: 20, cooldownMin: 0, maxRunsPerDay: 9 },
  runtime: {},
  createdAt: "2026-08-01T00:00:00.000Z",
  updatedAt: "2026-08-01T00:00:00.000Z",
  ...patch
});

// An empty sportTypes means every sport.
assert.equal(activityMatchesAutomation(activity(), activityAutomation()), true);
assert.equal(
  activityMatchesAutomation(activity(), activityAutomation({ sportTypes: [100, 101] })),
  true
);
assert.equal(
  activityMatchesAutomation(activity({ sport_type: 200 }), activityAutomation({ sportTypes: [100] })),
  false
);
assert.equal(
  activityMatchesAutomation(activity({ duration: 600 }), activityAutomation({ minDurationSec: 3600 })),
  false
);
assert.equal(
  activityMatchesAutomation(activity({ duration: 3600 }), activityAutomation({ minDurationSec: 3600 })),
  true
);
assert.equal(
  activityMatchesAutomation(activity({ distance: 5000 }), activityAutomation({ minDistanceM: 10000 })),
  false
);
// A missing metric fails a floor rather than passing it by accident.
assert.equal(
  activityMatchesAutomation(activity({ duration: null }), activityAutomation({ minDurationSec: 1 })),
  false
);
assert.equal(
  activityMatchesAutomation(activity({ distance: null }), activityAutomation({ minDistanceM: 1 })),
  false
);
// Only "activity" triggers ever match here.
assert.equal(
  activityMatchesAutomation(
    activity(),
    activityAutomation({}, { trigger: { kind: "schedule", cadence: "daily", timeOfDay: "07:00" } })
  ),
  false
);

// ---------------------------------------------------------------------------
// A world to drive the watcher against
// ---------------------------------------------------------------------------

function createWorld(overrides = {}) {
  const state = {
    now: new Date("2026-08-21T09:00:00.000Z"),
    rows: new Map(), // activity_id -> { row, seen: boolean }
    automations: [],
    settings: new Map(),
    authenticated: true,
    refreshes: [],
    triggers: [],
    errors: []
  };

  const deps = {
    now: () => state.now,
    refreshActivityIndex: async (startDay, endDay) => {
      state.refreshes.push([startDay, endDay]);
    },
    listUnseenActivities: (since) =>
      [...state.rows.values()]
        .filter((entry) => !entry.seen)
        .filter(
          (entry) =>
            !since || entry.row.start_time === null || entry.row.start_time >= since
        )
        .map((entry) => entry.row)
        .sort((left, right) => (right.start_time ?? 0) - (left.start_time ?? 0)),
    markSeen: (ids) => {
      for (const id of ids) {
        const entry = state.rows.get(id);
        if (entry) entry.seen = true;
      }
    },
    markAllSeen: () => {
      let changed = 0;
      for (const entry of state.rows.values()) {
        if (!entry.seen) {
          entry.seen = true;
          changed += 1;
        }
      }
      return changed;
    },
    listAutomations: () => state.automations.map((entry) => ({ ...entry })),
    isCorosAuthenticated: () => state.authenticated,
    getSetting: (key) => state.settings.get(key),
    setSetting: (key, value) => state.settings.set(key, value),
    runTrigger: async (event) => {
      state.triggers.push(event);
      return [{ id: `run-${state.triggers.length}`, status: "success" }];
    },
    onError: (error) => state.errors.push(error),
    ...overrides
  };

  state.deps = deps;
  state.addActivity = (patch) => {
    const row = activity(patch);
    state.rows.set(row.activity_id, { row, seen: false });
    return row;
  };
  state.unseenIds = () =>
    [...state.rows.values()].filter((entry) => !entry.seen).map((entry) => entry.row.activity_id);
  // Pretend the cold start already happened.
  state.markInitialized = () =>
    state.settings.set("coachAutomation.activityWatcherInitializedAt", "2026-08-01T00:00:00.000Z");
  return state;
}

const advance = (world, minutes) => {
  world.now = new Date(world.now.getTime() + minutes * 60_000);
};

// ---------------------------------------------------------------------------
// Cold start: the athlete's history is not "new"
// ---------------------------------------------------------------------------

{
  const world = createWorld();
  world.automations = [activityAutomation({}, { conditions: { batchWindowMin: 0, cooldownMin: 0, maxRunsPerDay: 9 } })];
  for (let index = 0; index < 40; index += 1) {
    world.addActivity({ activity_id: `old-${index}` });
  }

  const watcher = new CoachActivityWatcher(world.deps);
  await watcher.tick();

  assert.deepEqual(world.triggers, [], "the first tick fires nothing");
  assert.deepEqual(world.unseenIds(), [], "everything on disk is stamped as seen");
  assert.ok(world.settings.get("coachAutomation.activityWatcherInitializedAt"));
  assert.equal(world.refreshes.length, 1, "the index is still refreshed");
  assert.deepEqual(world.refreshes[0], ["20260814", "20260821"], "7-day window");

  // Only what arrives after the cold start counts.
  world.addActivity({ activity_id: "fresh" });
  await watcher.tick();
  assert.equal(world.triggers.length, 1);
  assert.equal(world.triggers[0].automationId, "a1");
}

// ---------------------------------------------------------------------------
// Nothing runs while COROS is not connected
// ---------------------------------------------------------------------------

{
  const world = createWorld();
  world.markInitialized();
  world.authenticated = false;
  world.automations = [activityAutomation()];
  world.addActivity({ activity_id: "act-1" });

  const watcher = new CoachActivityWatcher(world.deps);
  await watcher.tick();
  assert.deepEqual(world.refreshes, [], "no network call");
  assert.deepEqual(world.triggers, []);
  assert.deepEqual(world.unseenIds(), ["act-1"], "the row stays unseen for later");
}

// ---------------------------------------------------------------------------
// 3.2 step 5: batching inside batchWindowMin
// ---------------------------------------------------------------------------

{
  const world = createWorld();
  world.markInitialized();
  world.automations = [activityAutomation()]; // batchWindowMin 20
  world.addActivity({ activity_id: "act-1", name: "Long run", start_time: NOW_EPOCH - 900 });

  const watcher = new CoachActivityWatcher(world.deps);
  await watcher.tick();
  assert.deepEqual(world.triggers, [], "held inside the batch window");
  assert.deepEqual(watcher.pendingBatchSizes(), { a1: 1 });
  assert.deepEqual(
    world.unseenIds(),
    ["act-1"],
    "a batched row is not stamped until it fires, so a quit does not lose it"
  );

  // A second activity 15 minutes later joins the same batch.
  advance(world, 15);
  world.addActivity({ activity_id: "act-2", name: "Evening swim", start_time: NOW_EPOCH - 800 });
  await watcher.tick();
  assert.deepEqual(world.triggers, [], "still inside the window");
  assert.deepEqual(watcher.pendingBatchSizes(), { a1: 2 });

  // Past the window, both collapse into ONE trigger carrying both ids.
  advance(world, 10);
  await watcher.tick();
  assert.equal(world.triggers.length, 1, "several activities produce one run");
  const [fired] = world.triggers;
  assert.equal(fired.automationId, "a1");
  assert.equal(fired.kind, "activity");
  // The batch decides *when* to fire; which activities each binding then
  // analyses is the runner's call, from that binding's own watermark — so the
  // trigger deliberately carries no activity payload.
  assert.equal(fired.payload, undefined);
  assert.deepEqual(world.unseenIds(), [], "stamped once it fired");
  assert.deepEqual(watcher.pendingBatchSizes(), {});

  // The same activity is never fired twice.
  await watcher.tick();
  assert.equal(world.triggers.length, 1);
}

// batchWindowMin 0 fires on the same tick.
{
  const world = createWorld();
  world.markInitialized();
  world.automations = [
    activityAutomation({}, { conditions: { batchWindowMin: 0, cooldownMin: 0, maxRunsPerDay: 9 } })
  ];
  world.addActivity({ activity_id: "act-1" });

  const watcher = new CoachActivityWatcher(world.deps);
  await watcher.tick();
  assert.equal(world.triggers.length, 1);
  assert.deepEqual(world.unseenIds(), []);
}

// ---------------------------------------------------------------------------
// Fan-out across automations, and non-matching rows
// ---------------------------------------------------------------------------

{
  const world = createWorld();
  world.markInitialized();
  const zero = { batchWindowMin: 0, cooldownMin: 0, maxRunsPerDay: 9 };
  world.automations = [
    activityAutomation({ sportTypes: [100] }, { id: "runs", conditions: zero }),
    activityAutomation({ sportTypes: [200] }, { id: "swims", conditions: zero }),
    activityAutomation({ sportTypes: [100] }, { id: "off", conditions: zero, enabled: false })
  ];
  world.addActivity({ activity_id: "run-1", sport_type: 100, start_time: NOW_EPOCH - 700 });
  world.addActivity({ activity_id: "swim-1", sport_type: 200, start_time: NOW_EPOCH - 800 });
  world.addActivity({ activity_id: "hike-1", sport_type: 999, start_time: NOW_EPOCH - 900 });

  const watcher = new CoachActivityWatcher(world.deps);
  await watcher.tick();

  assert.deepEqual(
    world.triggers.map((trigger) => trigger.automationId).sort(),
    ["runs", "swims"],
    "a disabled automation is never matched"
  );
  assert.deepEqual(
    world.unseenIds(),
    [],
    "an activity nothing matched is still handled, not re-examined forever"
  );
}

// ---------------------------------------------------------------------------
// With no activity automation configured the marker still advances
// ---------------------------------------------------------------------------

{
  const world = createWorld();
  world.markInitialized();
  world.automations = [
    activityAutomation({}, { trigger: { kind: "schedule", cadence: "daily", timeOfDay: "07:00" } })
  ];
  world.addActivity({ activity_id: "act-1" });

  const watcher = new CoachActivityWatcher(world.deps);
  await watcher.tick();
  assert.deepEqual(world.triggers, []);
  assert.deepEqual(
    world.unseenIds(),
    [],
    "otherwise a rule added next week would fire for the whole backlog"
  );
}

// ---------------------------------------------------------------------------
// An automation switched off mid-window drops its batch
// ---------------------------------------------------------------------------

{
  const world = createWorld();
  world.markInitialized();
  world.automations = [activityAutomation()];
  world.addActivity({ activity_id: "act-1" });

  const watcher = new CoachActivityWatcher(world.deps);
  await watcher.tick();
  assert.deepEqual(watcher.pendingBatchSizes(), { a1: 1 });

  world.automations[0].enabled = false;
  advance(world, 30);
  await watcher.tick();
  assert.deepEqual(world.triggers, []);
  assert.deepEqual(watcher.pendingBatchSizes(), {});
  assert.deepEqual(world.unseenIds(), [], "and stops holding the rows back");
}

// ---------------------------------------------------------------------------
// Lifecycle: the timer belongs to the process, not a window
// ---------------------------------------------------------------------------

{
  const world = createWorld();
  world.markInitialized();
  const watcher = new CoachActivityWatcher(world.deps);

  assert.equal(watcher.isRunning(), false);
  watcher.start(60_000);
  assert.equal(watcher.isRunning(), true);
  // start() ticks immediately so a slot that came due while the app was closed
  // is handled at launch rather than up to one interval later.
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(world.refreshes.length, 1);

  watcher.start(60_000); // idempotent
  assert.equal(watcher.isRunning(), true);

  watcher.stop();
  assert.equal(watcher.isRunning(), false);
  watcher.stop(); // idempotent
}

// A failing tick is reported, not thrown, so the interval survives it.
{
  const world = createWorld({
    refreshActivityIndex: async () => {
      throw new Error("COROS timed out");
    }
  });
  world.markInitialized();
  world.automations = [activityAutomation()];

  const watcher = new CoachActivityWatcher(world.deps);
  await watcher.tick();
  assert.equal(world.errors.length, 1);
  assert.match(world.errors[0].message, /COROS timed out/);
}

// Overlapping ticks do not double-fire.
{
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const world = createWorld({
    refreshActivityIndex: async () => {
      await gate;
    }
  });
  world.markInitialized();
  world.automations = [
    activityAutomation({}, { conditions: { batchWindowMin: 0, cooldownMin: 0, maxRunsPerDay: 9 } })
  ];
  world.addActivity({ activity_id: "act-1" });

  const watcher = new CoachActivityWatcher(world.deps);
  const first = watcher.tick();
  const second = watcher.tick();
  release();
  await Promise.all([first, second]);
  assert.equal(world.triggers.length, 1, "a slow tick is not re-entered");
}

Module._load = originalLoad;
console.log("coach activity watcher tests passed");
