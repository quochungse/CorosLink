import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const Module = require("node:module");
const repoRoot = path.resolve(import.meta.dirname, "..");

// The runner pulls in electron and the better-sqlite3 native binding through
// chatService/database at require time, neither of which loads under plain
// node. Every real collaborator is injected per call, so the stubs are only
// needed to get the module loaded.
const fakeElectron = {
  BrowserWindow: Object.assign(class {}, { getAllWindows: () => [] }),
  app: { getPath: () => "/tmp", on: () => {}, whenReady: () => Promise.resolve() },
  safeStorage: { isEncryptionAvailable: () => false },
  shell: { openExternal: () => {} }
};
const originalLoad = Module._load;
Module._load = function patchedLoad(request, ...rest) {
  if (request === "electron") return fakeElectron;
  if (request === "better-sqlite3") return class FakeDatabase {};
  return originalLoad.call(this, request, ...rest);
};

const {
  AUTOMATION_OUTPUT_CONTRACT,
  AUTOMATION_DEFAULT_EFFORT,
  NOTHING_TO_REPORT,
  resolveAutomationRuntime,
  SESSION_BURST_PER_HOUR,
  expandTriggerToQueue,
  isWithinQuietHours,
  parseAutomationOutput,
  renderAutomationTemplate,
  resetAutomationQueueForTests,
  runAutomationNow,
  runAutomationTrigger
} = require(path.join(repoRoot, "dist-electron", "coachAutomationService.js"));

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

// --- output contract (5.5) --------------------------------------------------
// Line 1 is the headline, with no label to find: the contract stopped asking
// for one, so nothing has to be taken back out of the athlete's transcript.
assert.deepEqual(parseAutomationOutput("Load is ramping fast.\nMore detail."), {
  silent: false,
  summary: "Load is ramping fast."
});
assert.equal(
  parseAutomationOutput("**Bolded by the model**\n- detail").summary,
  "Bolded by the model",
  "emphasis is stripped from the badge, not from the conversation"
);
assert.equal(
  parseAutomationOutput(`${"x".repeat(300)}\nmore`).summary.length,
  140,
  "the summary is capped for the badge"
);
assert.deepEqual(parseAutomationOutput("Just some prose.\nSecond line."), {
  silent: false,
  summary: "Just some prose."
});

// Rule 2 tells the model what the first line is *for*, so the first line is
// simply read. No list of markdown constructs to skip — the single guard is
// that a line with no letters in it is not a sentence.
assert.equal(
  parseAutomationOutput("**Load is flat.**\n- Sleep is short.").summary,
  "Load is flat.",
  "markup is trimmed off both ends"
);
assert.equal(
  parseAutomationOutput("# Week in review\nLoad is flat.").summary,
  "Week in review"
);
assert.equal(
  parseAutomationOutput("---\n\n***\n\nRamp is steady.").summary,
  "Ramp is steady.",
  "a line with no letters is not a sentence, whatever syntax produced it"
);
assert.equal(
  parseAutomationOutput("| 33 | 412 |\nRamp is steady.").summary,
  "Ramp is steady.",
  "and that covers a numeric table row without naming tables"
);
// The trade-off this buys simplicity with: a model that ignores rule 2 and
// opens with a labelled table gets a poor row rather than a rescued one. The
// prompt is where that is prevented, not the parser.
assert.equal(
  parseAutomationOutput("| Week | Load |\n| --- | --- |\n\nRamp is steady.").summary,
  "| Week | Load |"
);
// Nothing but markup: something beats an empty row.
assert.equal(parseAutomationOutput("---").summary, "");

// The contract must stay additive, and must explain rather than enumerate.
assert.doesNotMatch(AUTOMATION_OUTPUT_CONTRACT, /observation|recommended action/i);
assert.doesNotMatch(
  AUTOMATION_OUTPUT_CONTRACT,
  /no heading|no bullet|no table/i,
  "prohibitions only teach the model about the cases someone thought of"
);
assert.match(AUTOMATION_OUTPUT_CONTRACT, /do\s*\n?not replace it/i);
assert.match(
  AUTOMATION_OUTPUT_CONTRACT,
  /shows that line on its own/i,
  "rule 2 gives the reason, which is what generalises"
);

// The silent marker is still a marker: it is what keeps a run that found
// nothing out of the athlete's conversation.
assert.deepEqual(parseAutomationOutput(NOTHING_TO_REPORT), { silent: true });
assert.deepEqual(parseAutomationOutput(`  ${NOTHING_TO_REPORT}\n`), { silent: true });
assert.deepEqual(
  parseAutomationOutput(`Nothing stands out.\n${NOTHING_TO_REPORT}`),
  { silent: true },
  "the marker still counts when the model adds preamble"
);
assert.deepEqual(parseAutomationOutput("`NOTHING_TO_REPORT`"), { silent: true });
assert.deepEqual(parseAutomationOutput(""), { silent: true });
assert.deepEqual(parseAutomationOutput("   \n  "), { silent: true });
// A sentence merely mentioning the marker is a real report, not silence.
assert.equal(
  parseAutomationOutput("I would have said NOTHING_TO_REPORT but load spiked.").silent,
  false
);
assert.match(AUTOMATION_OUTPUT_CONTRACT, new RegExp(NOTHING_TO_REPORT));

// --- the marker never reaches the athlete ----------------------------------
// It decides silent-vs-success and is not prose. The runner keeps it out of the
// transcript by persisting a one-line trace instead of anything the model
// wrote; the window has to keep it out of the live bubble too, where it arrives
// split across chunks. That second half lives in JSX, so it is asserted at the
// source level — the same trick test-ipc-surface.mjs uses for invariants
// TypeScript cannot see.
{
  const chatView = fs.readFileSync(
    path.join(repoRoot, "src", "chat", "ChatView.tsx"),
    "utf8"
  );
  assert.match(
    chatView,
    /NOTHING_TO_REPORT\.startsWith\(liveAutomation\.text\.trim\(\)\)/,
    "the live bubble must hold its text back while it could still be the marker"
  );
  assert.doesNotMatch(
    chatView,
    /content=\{liveAutomation\.text\}/,
    "the live bubble must render the guarded text, never the raw stream"
  );
  // The transcript trace replaced the toast that used to explain the bubble
  // disappearing. Both saying it would say it twice.
  assert.doesNotMatch(
    chatView,
    /found nothing new to report/,
    "the silent-run toast is retired by the transcript entry"
  );
  assert.match(
    chatView,
    /run\.status !== "success" && run\.status !== "silent"/,
    "a silent run must reload the transcript, like an answer does"
  );

  // The renderer rebuilds entries field by field in both directions. A missing
  // *branch* is a compile error, because the union has one; a missing *field*
  // is not, and would silently drop the timestamp on every reload.
  const chatTypes = fs.readFileSync(
    path.join(repoRoot, "src", "chat", "chatTypes.ts"),
    "utf8"
  );
  assert.equal(
    (
      chatTypes.match(
        /kind: "automationSilent",\s*automation: entry\.automation,\s*at: entry\.at/g
      ) ?? []
    ).length,
    2,
    "both chatTypes converters must carry the trace's marker and its timestamp"
  );

  // 5.6b: the window saves its whole timeline, so it has to tell the store how
  // much of the row that array accounts for. Without it, a save issued in the
  // moment between a run landing and the reload arriving deletes the answer.
  assert.match(
    chatView,
    /saveChatSession\(sessionId, persisted, \{ knownEntryCount \}\)/,
    "the window must declare what its array is based on when it saves"
  );
  // Advanced before the call, not in the reply: handlers run in send order, so
  // an earlier save's answer arriving late must not roll the base backwards.
  assert.match(
    chatView,
    /persistedBaseRef\.current = persisted\.length;\s*\n\s*void api/,
    "the base must advance at send time, not when the save replies"
  );
  assert.equal(
    (chatView.match(/persistedBaseRef\.current = entries\.length;/g) ?? []).length,
    2,
    "both paths that read the conversation from disk must re-base on it"
  );
  // A save waiting on the debounce holds the copy the reload is replacing. If
  // it fired afterwards it would write that copy back with a base that no
  // longer covers the run's entries, which is the loss the merge exists to
  // prevent — so the reload cancels it.
  assert.match(
    chatView,
    /if \(persistTimeoutRef\.current\) \{\s*\n\s*clearTimeout\(persistTimeoutRef\.current\);\s*\n\s*persistTimeoutRef\.current = null;\s*\n\s*\}\s*\n\s*persistedBaseRef\.current = entries\.length;/,
    "reloading the transcript must cancel a save still waiting on the debounce"
  );
}

// --- template rendering (2.5) ----------------------------------------------
assert.equal(
  renderAutomationTemplate("{{rule.name}} · {{activity.name}} · {{date}}", {
    rule: { name: "Debrief" },
    activity: { name: "Long run" },
    date: "2026-08-21"
  }),
  "Debrief · Long run · 2026-08-21"
);
assert.equal(
  renderAutomationTemplate("{{ week.range }} / {{activity.sport}}", {
    week: { range: "2026-08-16..2026-08-22" }
  }),
  "2026-08-16..2026-08-22 /",
  "an unknown variable collapses to nothing"
);
assert.equal(renderAutomationTemplate("{{nope}}", {}), "");

// --- quiet hours (4) --------------------------------------------------------
const at = (hh, mm) => new Date(2026, 7, 21, hh, mm, 0);
assert.equal(isWithinQuietHours(at(12, 0), undefined), false);
assert.equal(isWithinQuietHours(at(23, 0), { start: "22:00", end: "06:30" }), true);
assert.equal(isWithinQuietHours(at(3, 0), { start: "22:00", end: "06:30" }), true, "wraps midnight");
assert.equal(isWithinQuietHours(at(6, 30), { start: "22:00", end: "06:30" }), false, "end is exclusive");
assert.equal(isWithinQuietHours(at(12, 0), { start: "22:00", end: "06:30" }), false);
assert.equal(isWithinQuietHours(at(13, 0), { start: "09:00", end: "17:00" }), true);
assert.equal(isWithinQuietHours(at(13, 0), { start: "9am", end: "5pm" }), false, "junk is not a window");

// ---------------------------------------------------------------------------
// A world the runner can be driven against
// ---------------------------------------------------------------------------

function createWorld(overrides = {}) {
  const state = {
    now: new Date("2026-08-21T09:00:00.000Z"),
    automations: new Map(),
    bindings: new Map(),
    runs: [],
    sessions: new Map(), // id -> { title, entries }
    updates: [],
    streamCalls: [],
    corosResult: { ok: true },
    authenticated: true,
    // What the scripted collector reports back for the next run.
    outcome: { text: "Load is ramping fast.\nEase off Thursday.", entries: null },
    concurrent: 0,
    maxConcurrent: 0,
    sessionOrder: [],
    activities: [],
    cancelledRunIds: []
  };

  let sessionSeq = 0;
  let runSeq = 0;

  const deps = {
    now: () => state.now,
    getAutomation: (id) => state.automations.get(id) ?? null,
    listBindings: (automationId) =>
      [...state.bindings.values()]
        .filter((binding) => binding.automationId === automationId)
        .map((binding) => ({ ...binding })),
    getBinding: (id) => {
      const binding = state.bindings.get(id);
      return binding ? { ...binding } : null;
    },
    setBindingSchedule: (bindingId, schedule) => {
      const binding = state.bindings.get(bindingId);
      if (!binding) return;
      if (schedule.lastRunAt !== undefined) binding.lastRunAt = schedule.lastRunAt;
      if (schedule.nextRunAt !== undefined) binding.nextRunAt = schedule.nextRunAt;
      if (schedule.lastActivityAt !== undefined) {
        binding.lastActivityAt = schedule.lastActivityAt ?? undefined;
      }
    },
    setBindingSession: (bindingId, sessionId) => {
      state.bindings.get(bindingId).sessionId = sessionId;
    },
    setBindingEnabled: (bindingId, enabled) => {
      state.bindings.get(bindingId).enabled = enabled;
    },
    listRuns: (filter) =>
      state.runs.filter((run) => {
        if (filter.bindingId && run.bindingId !== filter.bindingId) return false;
        if (filter.sessionId && run.sessionId !== filter.sessionId) return false;
        if (filter.since && run.startedAt < filter.since) return false;
        if (filter.statuses && !filter.statuses.includes(run.status)) return false;
        return true;
      }),
    listActivitiesAfter: (after, limit) =>
      state.activities
        .filter(
          (row) =>
            row.start_time !== null &&
            (after === undefined || row.start_time > after)
        )
        .sort((left, right) => left.start_time - right.start_time)
        .slice(-limit)
        .map((row) => ({ ...row })),
    recordRun: (input) => {
      runSeq += 1;
      const run = {
        ...input,
        id: input.id ?? `run-${runSeq}`,
        startedAt: input.startedAt ?? state.now.toISOString()
      };
      state.runs.push(run);
      return { ...run };
    },
    updateRun: (id, patch) => {
      const run = state.runs.find((entry) => entry.id === id);
      if (!run) return null;
      Object.assign(run, patch);
      return { ...run };
    },
    getSessionEntries: (sessionId) => {
      const session = state.sessions.get(sessionId);
      return session ? [...session.entries] : undefined;
    },
    createSession: () => {
      sessionSeq += 1;
      const id = `session-new-${sessionSeq}`;
      state.sessions.set(id, { title: "New chat", entries: [] });
      return id;
    },
    saveSession: (sessionId, entries) => {
      state.sessions.get(sessionId).entries = entries;
    },
    setSessionTitle: (sessionId, title) => {
      state.sessions.get(sessionId).title = title;
    },
    getChatProvider: () => "claude-code",
    isProviderAuthenticated: () => state.authenticated,
    ensureCorosSession: async () => state.corosResult,
    createCollector: (marker) => {
      const outcome = state.outcome;
      const entries =
        outcome.entries ??
        (outcome.text
          ? [{ kind: "message", role: "assistant", content: outcome.text }]
          : []);
      return {
        emit: () => {},
        entries: () => entries.map((entry) => ({ ...entry })),
        finished: () => true,
        cancelled: () => outcome.cancelled === true,
        error: () => outcome.error,
        authError: () => outcome.authError === true,
        text: () => outcome.text ?? "",
        marker
      };
    },
    streamChat: async (sink, runId, messages, options) => {
      state.concurrent += 1;
      state.maxConcurrent = Math.max(state.maxConcurrent, state.concurrent);
      state.streamCalls.push({ runId, messages, options });
      if (state.outcome.throws) {
        state.concurrent -= 1;
        throw new Error(state.outcome.throws);
      }
      // Yield so a second run would interleave here if the queue let it.
      await new Promise((resolve) => setImmediate(resolve));
      state.concurrent -= 1;
    },
    emitRunUpdate: (run) => {
      state.updates.push({ id: run.id, status: run.status });
    },
    cancelRun: (runId) => {
      state.cancelledRunIds.push(runId);
    },
    idleTimeoutMs: 60_000,
    ...overrides
  };

  state.deps = deps;
  return state;
}

function addAutomation(world, id, patch = {}) {
  const automation = {
    id,
    name: `Automation ${id}`,
    playbook: "Summarise yesterday for {{date}}.",
    enabled: true,
    trigger: { kind: "schedule", cadence: "daily", timeOfDay: "07:30" },
    conditions: { batchWindowMin: 20, cooldownMin: 120, maxRunsPerDay: 3 },
    runtime: {},
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: "2026-08-01T00:00:00.000Z",
    ...patch
  };
  world.automations.set(id, automation);
  return automation;
}

function addBinding(world, id, patch = {}) {
  const binding = {
    id,
    automationId: "a1",
    mode: "existing",
    sessionId: "s1",
    enabled: true,
    sortOrder: 0,
    createdAt: "2026-08-01T00:00:00.000Z",
    ...patch
  };
  world.bindings.set(id, binding);
  return binding;
}

const RUNNER_NOW_EPOCH = Math.floor(Date.parse("2026-08-21T09:00:00.000Z") / 1000);

/** `daysAgo` is measured from the world clock, so the fixtures read as dates. */
function addActivity(world, id, daysAgo, patch = {}) {
  const row = {
    activity_id: id,
    name: `Activity ${id}`,
    sport_type: 100,
    sport_name: "Run",
    start_time: RUNNER_NOW_EPOCH - Math.round(daysAgo * 86_400),
    duration: 3600,
    distance: 12000,
    ...patch
  };
  world.activities.push(row);
  return row;
}

function addSession(world, id, entries = []) {
  world.sessions.set(id, { title: "Existing chat", entries });
}

// ---------------------------------------------------------------------------
// 2.3 fan-out and ordering
// ---------------------------------------------------------------------------

{
  const world = createWorld();
  addAutomation(world, "a1");
  addSession(world, "sA");
  addSession(world, "sB");
  addBinding(world, "b-late", { sessionId: "sB", sortOrder: 0 });
  addBinding(world, "b-second", { sessionId: "sA", sortOrder: 5 });
  addBinding(world, "b-first", { sessionId: "sA", sortOrder: 1 });
  addBinding(world, "b-off", { sessionId: "sB", sortOrder: 9, enabled: false });

  const queue = expandTriggerToQueue(
    { automationId: "a1", kind: "schedule" },
    world.deps
  );
  assert.deepEqual(
    queue.map((entry) => entry.binding.id),
    ["b-first", "b-second", "b-late"],
    "ordered by session then sort_order; the disabled binding is not queued"
  );

  // A disabled automation fans out to nothing at all.
  world.automations.get("a1").enabled = false;
  assert.deepEqual(expandTriggerToQueue({ automationId: "a1", kind: "schedule" }, world.deps), []);
  world.automations.get("a1").enabled = true;
  assert.deepEqual(expandTriggerToQueue({ automationId: "missing", kind: "schedule" }, world.deps), []);

  // bindingIds narrows the fan-out (manual run against one place).
  assert.deepEqual(
    expandTriggerToQueue(
      { automationId: "a1", kind: "manual", bindingIds: ["b-second"] },
      world.deps
    ).map((entry) => entry.binding.id),
    ["b-second"]
  );
}

// ---------------------------------------------------------------------------
// Serialization: same-conversation runs never overlap
// ---------------------------------------------------------------------------

{
  resetAutomationQueueForTests();
  const world = createWorld();
  addAutomation(world, "a1", { conditions: { batchWindowMin: 20, cooldownMin: 0, maxRunsPerDay: 9 } });
  addSession(world, "sA");
  addBinding(world, "b1", { sessionId: "sA", sortOrder: 0 });
  addBinding(world, "b2", { sessionId: "sA", sortOrder: 1 });
  addBinding(world, "b3", { sessionId: "sA", sortOrder: 2 });

  const runs = await runAutomationTrigger(
    { automationId: "a1", kind: "schedule" },
    world.deps
  );
  assert.equal(runs.length, 3);
  assert.equal(world.maxConcurrent, 1, "runs against one conversation are serialized");
  assert.deepEqual(
    world.streamCalls.map((call) => call.runId),
    runs.map((run) => run.id),
    "and execute in sort_order"
  );
  // Each later run sees the earlier one's message in its context (2.3).
  assert.ok(
    world.streamCalls[2].messages.length > world.streamCalls[0].messages.length,
    "a later coach sees what the earlier one wrote"
  );
}

// ---------------------------------------------------------------------------
// The happy path: options, persistence and attribution
// ---------------------------------------------------------------------------

{
  resetAutomationQueueForTests();
  const world = createWorld();
  addAutomation(world, "a1", {
    name: "Morning briefing",
    role: "Strict marathon coach",
    runtime: { model: "claude-opus-5", effort: "low" }
  });
  addSession(world, "s1", [
    { kind: "message", role: "user", content: "Hi" },
    { kind: "message", role: "assistant", content: "Hello" }
  ]);
  addBinding(world, "b1", { sessionId: "s1" });

  const [run] = await runAutomationTrigger(
    { automationId: "a1", kind: "schedule" },
    world.deps
  );

  assert.equal(run.status, "success");
  assert.equal(run.summary, "Load is ramping fast.");
  assert.equal(run.sessionId, "s1");
  assert.equal(run.model, "claude-opus-5");
  assert.equal(run.effort, "low");
  assert.ok(run.finishedAt);

  // streamChat is told this is a read-only run carrying the automation's role.
  const call = world.streamCalls[0];
  assert.equal(call.runId, run.id);
  assert.equal(call.options.toolPolicy, "read-only");
  assert.equal(call.options.roleInstructions, "Strict marathon coach");
  assert.deepEqual(call.options.runtime, { model: "claude-opus-5", effort: "low" });

  // Section 7: an explicit effort is honoured as written.
  assert.equal(AUTOMATION_DEFAULT_EFFORT, "low");

  // The conversation's history is replayed, then the rendered playbook.
  assert.equal(call.messages.length, 3);
  assert.deepEqual(call.messages.slice(0, 2), [
    { role: "user", content: "Hi" },
    { role: "assistant", content: "Hello" }
  ]);
  const playbook = call.messages[2];
  assert.equal(playbook.role, "user");
  assert.match(playbook.content, /Summarise yesterday for 2026-08-21\./);
  assert.ok(playbook.content.endsWith(AUTOMATION_OUTPUT_CONTRACT));

  // Persistence: existing entries, the synthetic user turn, then the answer.
  const saved = world.sessions.get("s1").entries;
  assert.equal(saved.length, 4);
  assert.deepEqual(saved.slice(0, 2), [
    { kind: "message", role: "user", content: "Hi" },
    { kind: "message", role: "assistant", content: "Hello" }
  ]);
  const marker = {
    runId: run.id,
    automationId: "a1",
    bindingId: "b1",
    name: "Morning briefing",
    triggerLabel: "Daily at 07:30"
  };
  assert.equal(saved[2].role, "user");
  assert.equal(saved[2].content, playbook.content);
  assert.deepEqual(saved[2].automation, marker, "the synthetic turn is attributed");
  assert.equal(saved[3].role, "assistant");
  assert.deepEqual(saved[3].automation, marker, "so is the answer");

  // The binding's clock advanced, and the renderer saw start then finish.
  assert.equal(world.bindings.get("b1").lastRunAt, world.now.toISOString());
  assert.deepEqual(world.updates, [
    { id: run.id, status: "running" },
    { id: run.id, status: "success" }
  ]);
}

// ---------------------------------------------------------------------------
// NOTHING_TO_REPORT
// ---------------------------------------------------------------------------

{
  resetAutomationQueueForTests();
  const world = createWorld();
  world.outcome = { text: NOTHING_TO_REPORT };
  addAutomation(world, "a1");
  addSession(world, "s1", [{ kind: "message", role: "user", content: "Hi" }]);
  addBinding(world, "b1", { sessionId: "s1" });

  const [run] = await runAutomationTrigger({ automationId: "a1", kind: "schedule" }, world.deps);
  assert.equal(run.status, "silent");
  assert.equal(run.summary, undefined, "a silent run carries no badge text");

  // Nothing the model wrote is persisted — the answer was a control token. What
  // lands is the trace of 5.5, so the conversation records that the coach ran.
  const entries = world.sessions.get("s1").entries;
  assert.equal(entries.length, 2, "the athlete's turn is kept, one trace is added");
  assert.deepEqual(entries[0], { kind: "message", role: "user", content: "Hi" });
  assert.equal(entries[1].kind, "automationSilent");
  assert.equal(entries[1].at, world.now.getTime(), "the trace records when it looked");
  assert.equal(entries[1].automation.runId, run.id);
  assert.equal(entries[1].automation.name, world.automations.get("a1").name);
  assert.equal(
    JSON.stringify(entries).includes(NOTHING_TO_REPORT),
    false,
    "and the marker itself never reaches the transcript"
  );

  assert.equal(world.runs.length, 1, "the run is still logged");
  assert.equal(world.bindings.get("b1").lastRunAt, world.now.toISOString());
}

// The trace appends to the conversation as it stands now, not to the snapshot
// taken before the stream — same hazard as a reported answer has.
{
  resetAutomationQueueForTests();
  const world = createWorld();
  world.outcome = { text: NOTHING_TO_REPORT };
  addAutomation(world, "a1");
  addSession(world, "s1", [{ kind: "message", role: "user", content: "before" }]);
  addBinding(world, "b1", { sessionId: "s1" });

  const original = world.deps.streamChat;
  world.deps.streamChat = async (...args) => {
    world.sessions.get("s1").entries.push({
      kind: "message",
      role: "user",
      content: "typed mid-run"
    });
    return original(...args);
  };

  await runAutomationTrigger({ automationId: "a1", kind: "schedule" }, world.deps);
  assert.deepEqual(
    world.sessions.get("s1").entries.map((entry) => entry.content ?? entry.kind),
    ["before", "typed mid-run", "automationSilent"],
    "the athlete's turn is not deleted by the trace's append"
  );
}

// --- section 7: silence means `low`, whatever the trigger ------------------
// The editor renders `runtime.effort ?? "low"`, so a definition saved without
// touching that control showed `low`. Before this default it then ran at the
// interactive chat's effort, and the run log recorded nothing at all.
{
  for (const trigger of [
    { kind: "activity", sportTypes: [] },
    { kind: "schedule", cadence: "daily", timeOfDay: "07:00" },
    { kind: "schedule", cadence: "weekly", dayOfWeek: 0, timeOfDay: "18:00" },
    { kind: "manual" }
  ]) {
    resetAutomationQueueForTests();
    const world = createWorld();
    addAutomation(world, "a1", { trigger, runtime: { model: "claude-opus-5" } });
    addSession(world, "s1");
    addBinding(world, "b1", { sessionId: "s1" });
    // Ignored by every trigger but the activity one, which otherwise has
    // nothing to analyse and skips before it reaches the provider.
    addActivity(world, "t1", 1);

    const [run] = await runAutomationTrigger(
      { automationId: "a1", kind: "manual", bypassGuards: true },
      world.deps
    );
    const label = `${trigger.kind}/${trigger.cadence ?? "-"}`;
    assert.equal(run.status, "success", label);
    assert.deepEqual(
      world.streamCalls[0].options.runtime,
      { model: "claude-opus-5", effort: AUTOMATION_DEFAULT_EFFORT },
      `${label}: the run must use the default, not the chat's effort`
    );
    assert.equal(
      run.effort,
      AUTOMATION_DEFAULT_EFFORT,
      `${label}: and the run log must record what it actually used`
    );
    // The definition is untouched: the default is resolved at run time, so the
    // athlete's blank stays blank and follows the default if it ever changes.
    assert.equal(world.automations.get("a1").runtime.effort, undefined, label);
  }

  // resolveAutomationRuntime is the one place that decision lives.
  assert.deepEqual(
    resolveAutomationRuntime({ runtime: {} }),
    { effort: AUTOMATION_DEFAULT_EFFORT }
  );
  assert.deepEqual(
    resolveAutomationRuntime({ runtime: { effort: "high", model: "m" } }),
    { effort: "high", model: "m" },
    "an explicit effort is never overridden"
  );
}

// ---------------------------------------------------------------------------
// Session resolution (2.1 / 2.4)
// ---------------------------------------------------------------------------

{
  resetAutomationQueueForTests();
  const world = createWorld();
  addAutomation(world, "a1", { name: "Debrief" });
  addBinding(world, "b1", {
    mode: "per-run",
    sessionId: null,
    titleTemplate: "{{rule.name}} · {{activity.name}}"
  });

  const [run] = await runAutomationTrigger(
    {
      automationId: "a1",
      kind: "activity",
      payload: { activityName: "Long run", activitySport: "run" }
    },
    world.deps
  );
  assert.equal(run.status, "success");
  const created = world.sessions.get(run.sessionId);
  assert.equal(created.title, "Debrief · Long run");
  assert.equal(created.entries.length, 2, "a fresh conversation holds only this run");
  assert.equal(
    world.bindings.get("b1").sessionId,
    null,
    "a per-run binding never adopts the conversation it created"
  );
  assert.deepEqual(run.triggerPayload, { activityName: "Long run", activitySport: "run" });
}

{
  resetAutomationQueueForTests();
  const world = createWorld();
  addAutomation(world, "a1", { name: "Daily briefing" });
  // The athlete deleted the conversation this dedicated binding wrote into.
  addBinding(world, "b1", { mode: "dedicated", sessionId: "s-gone" });

  const [run] = await runAutomationTrigger({ automationId: "a1", kind: "schedule" }, world.deps);
  assert.equal(run.status, "success");
  assert.notEqual(run.sessionId, "s-gone");
  assert.equal(world.sessions.get(run.sessionId).title, "Daily briefing");
  assert.equal(
    world.bindings.get("b1").sessionId,
    run.sessionId,
    "the dedicated binding is repointed at the conversation it rebuilt"
  );
  assert.equal(world.bindings.get("b1").enabled, true);
}

{
  resetAutomationQueueForTests();
  const world = createWorld();
  addAutomation(world, "a1");
  addBinding(world, "b1", { mode: "existing", sessionId: "s-gone" });

  const [run] = await runAutomationTrigger({ automationId: "a1", kind: "schedule" }, world.deps);
  assert.equal(run.status, "skipped");
  assert.equal(run.skipReason, "missing-session");
  assert.equal(
    world.bindings.get("b1").enabled,
    false,
    "an existing binding is disabled for the athlete to re-point"
  );
  assert.equal(world.streamCalls.length, 0, "no model call was made");
}

// ---------------------------------------------------------------------------
// Guard rails (4), in order
// ---------------------------------------------------------------------------

async function runWith(configure) {
  resetAutomationQueueForTests();
  const world = createWorld();
  addAutomation(world, "a1");
  addSession(world, "s1");
  addBinding(world, "b1", { sessionId: "s1" });
  configure(world);
  const [run] = await runAutomationTrigger(
    { automationId: "a1", kind: "schedule", ...(world.event ?? {}) },
    world.deps
  );
  return { world, run };
}

// 1. the automation was switched off between queue and run
{
  const { world, run } = await runWith((w) => {
    const original = w.deps.getAutomation;
    let calls = 0;
    w.deps.getAutomation = (id) => {
      calls += 1;
      const automation = original(id);
      // First call is the fan-out; the re-check inside the run sees it off.
      return calls > 1 ? { ...automation, enabled: false } : automation;
    };
  });
  assert.equal(run.status, "skipped");
  assert.equal(run.skipReason, "disabled");
  assert.equal(world.streamCalls.length, 0);
}

// 3. provider not authenticated
{
  const { run } = await runWith((w) => {
    w.authenticated = false;
  });
  assert.equal(run.skipReason, "no-auth");
  assert.equal(run.sessionId, "s1", "the resolved session is still recorded");
}

// 4. COROS unusable / 2FA
{
  const offline = await runWith((w) => {
    w.corosResult = { ok: false, twoFactorRequired: false };
  });
  assert.equal(offline.run.skipReason, "offline");

  const twoFactor = await runWith((w) => {
    w.corosResult = { ok: false, twoFactorRequired: true };
  });
  assert.equal(twoFactor.run.skipReason, "two-factor-required");
  assert.equal(twoFactor.world.streamCalls.length, 0);
}

// 5. quiet hours
{
  const { run } = await runWith((w) => {
    w.automations.get("a1").conditions.quietHours = { start: "00:00", end: "23:59" };
  });
  assert.equal(run.skipReason, "quiet-hours");
}

// 6. cooldown
{
  const { run } = await runWith((w) => {
    w.bindings.get("b1").lastRunAt = new Date(
      w.now.getTime() - 30 * 60_000
    ).toISOString();
  });
  assert.equal(run.skipReason, "cooldown", "30min since the last run, cooldown is 120min");

  const elapsed = await runWith((w) => {
    w.bindings.get("b1").lastRunAt = new Date(
      w.now.getTime() - 180 * 60_000
    ).toISOString();
  });
  assert.equal(elapsed.run.status, "success", "past the cooldown it runs");
}

// 7. maxRunsPerDay
{
  const { run } = await runWith((w) => {
    for (let index = 0; index < 3; index += 1) {
      w.runs.push({
        id: `earlier-${index}`,
        automationId: "a1",
        bindingId: "b1",
        status: "success",
        triggerKind: "schedule",
        sessionId: "s1",
        startedAt: new Date(w.now.getTime() - 60_000 * (index + 1)).toISOString()
      });
    }
  });
  assert.equal(run.skipReason, "budget");
}

// A skipped run does not consume the daily budget.
{
  const { run } = await runWith((w) => {
    for (let index = 0; index < 5; index += 1) {
      w.runs.push({
        id: `skipped-${index}`,
        automationId: "a1",
        bindingId: "b1",
        status: "skipped",
        triggerKind: "schedule",
        sessionId: "s1",
        startedAt: new Date(w.now.getTime() - 60_000).toISOString()
      });
    }
  });
  assert.equal(run.status, "success");
}

// 8. conversation burst guard (2.3)
{
  const { run } = await runWith((w) => {
    w.automations.get("a1").conditions.maxRunsPerDay = 50;
    for (let index = 0; index < SESSION_BURST_PER_HOUR; index += 1) {
      w.runs.push({
        id: `other-${index}`,
        automationId: "other",
        bindingId: `other-b${index}`,
        status: "success",
        triggerKind: "schedule",
        sessionId: "s1",
        startedAt: new Date(w.now.getTime() - 60_000).toISOString()
      });
    }
  });
  assert.equal(run.skipReason, "burst", "five automation messages an hour is the cap");
}

// A run older than an hour does not count toward the burst guard.
{
  const { run } = await runWith((w) => {
    w.automations.get("a1").conditions.maxRunsPerDay = 50;
    for (let index = 0; index < SESSION_BURST_PER_HOUR; index += 1) {
      w.runs.push({
        id: `stale-${index}`,
        automationId: "other",
        bindingId: `other-b${index}`,
        status: "success",
        triggerKind: "schedule",
        sessionId: "s1",
        startedAt: new Date(w.now.getTime() - 3 * 3_600_000).toISOString()
      });
    }
  });
  assert.equal(run.status, "success");
}

// ---------------------------------------------------------------------------
// A skipped run must not leave an empty conversation behind
// ---------------------------------------------------------------------------
// Guard rail 2 only *checks* that a target is resolvable; the conversation is
// created after every guard passes. Creating it up front would litter the
// sidebar with an empty thread on every cooldown or offline skip, and the
// activity watcher polls every 15 minutes.

for (const [label, configure] of [
  ["not signed in", (w) => { w.authenticated = false; }],
  ["COROS offline", (w) => { w.corosResult = { ok: false, twoFactorRequired: false }; }],
  ["quiet hours", (w) => {
    w.automations.get("a1").conditions.quietHours = { start: "00:00", end: "23:59" };
  }],
  ["cooldown", (w) => {
    w.bindings.get("b1").lastRunAt = new Date(w.now.getTime() - 60_000).toISOString();
  }]
]) {
  resetAutomationQueueForTests();
  const world = createWorld();
  addAutomation(world, "a1", { name: "Debrief" });
  addBinding(world, "b1", {
    mode: "per-run",
    sessionId: null,
    titleTemplate: "{{rule.name}} · {{date}}"
  });
  configure(world);

  const [run] = await runAutomationTrigger({ automationId: "a1", kind: "activity" }, world.deps);
  assert.equal(run.status, "skipped", `${label}: expected a skip`);
  assert.equal(
    world.sessions.size,
    0,
    `${label}: a skipped per-run binding created a conversation anyway`
  );
  assert.equal(run.sessionId, undefined, `${label}: skip recorded a session that was never made`);
}

// A dedicated binding whose conversation was deleted does not rebuild it just
// to skip: the rebuild happens on a run that actually reaches the provider.
{
  resetAutomationQueueForTests();
  const world = createWorld();
  world.authenticated = false;
  addAutomation(world, "a1");
  addBinding(world, "b1", { mode: "dedicated", sessionId: "s-gone" });

  const [run] = await runAutomationTrigger({ automationId: "a1", kind: "schedule" }, world.deps);
  assert.equal(run.skipReason, "no-auth");
  assert.equal(world.sessions.size, 0, "the conversation was rebuilt for a skipped run");
  assert.equal(world.bindings.get("b1").sessionId, "s-gone", "and the binding was repointed");
}

// The burst guard cannot fire for a conversation that does not exist yet.
{
  resetAutomationQueueForTests();
  const world = createWorld();
  addAutomation(world, "a1", {
    conditions: { batchWindowMin: 0, cooldownMin: 0, maxRunsPerDay: 50 }
  });
  addBinding(world, "b1", { mode: "per-run", sessionId: null });
  for (let index = 0; index < SESSION_BURST_PER_HOUR + 2; index += 1) {
    world.runs.push({
      id: `busy-${index}`,
      automationId: "other",
      bindingId: `other-${index}`,
      status: "success",
      triggerKind: "activity",
      sessionId: "some-other-session",
      startedAt: world.now.toISOString()
    });
  }
  const [run] = await runAutomationTrigger({ automationId: "a1", kind: "activity" }, world.deps);
  assert.equal(run.status, "success");
}

// ---------------------------------------------------------------------------
// One binding failing must not starve the rest of the fan-out
// ---------------------------------------------------------------------------

{
  resetAutomationQueueForTests();
  const world = createWorld();
  addAutomation(world, "a1", {
    conditions: { batchWindowMin: 0, cooldownMin: 0, maxRunsPerDay: 9 }
  });
  addSession(world, "sA");
  addSession(world, "sB");
  addSession(world, "sC");
  addBinding(world, "b1", { sessionId: "sA", sortOrder: 0 });
  addBinding(world, "b2", { sessionId: "sB", sortOrder: 0 });
  addBinding(world, "b3", { sessionId: "sC", sortOrder: 0 });

  // An unexpected store failure on the middle binding, not a stream error.
  // Keyed by conversation rather than by call count: a run reads its
  // transcript both before and after the stream.
  const realGetEntries = world.deps.getSessionEntries;
  world.deps.getSessionEntries = (sessionId) => {
    if (sessionId === "sB") throw new Error("database is locked");
    return realGetEntries(sessionId);
  };

  const runs = await runAutomationTrigger({ automationId: "a1", kind: "schedule" }, world.deps);
  assert.equal(runs.length, 3, "every binding still produced a run record");
  assert.deepEqual(
    runs.map((run) => run.status),
    ["success", "failed", "success"],
    "the failure is isolated to its own binding"
  );
  assert.equal(runs[1].error, "database is locked");
  assert.equal(world.streamCalls.length, 2, "the surviving bindings still reached the provider");
}

// ---------------------------------------------------------------------------
// 3.4 "Run now" bypasses the rate guards but still logs a run
// ---------------------------------------------------------------------------

{
  resetAutomationQueueForTests();
  const world = createWorld();
  addAutomation(world, "a1", {
    conditions: {
      batchWindowMin: 20,
      cooldownMin: 120,
      maxRunsPerDay: 1,
      quietHours: { start: "00:00", end: "23:59" }
    }
  });
  addSession(world, "s1");
  addBinding(world, "b1", {
    sessionId: "s1",
    lastRunAt: new Date(world.now.getTime() - 60_000).toISOString()
  });
  world.runs.push({
    id: "earlier",
    automationId: "a1",
    bindingId: "b1",
    status: "success",
    triggerKind: "schedule",
    sessionId: "s1",
    startedAt: world.now.toISOString()
  });

  const [run] = await runAutomationNow("a1", undefined, world.deps);
  assert.equal(run.status, "success");
  assert.equal(run.triggerKind, "manual");

  // It also reaches a binding the athlete has switched off, which is how they
  // try a rule out before enabling it.
  resetAutomationQueueForTests();
  const offWorld = createWorld();
  addAutomation(offWorld, "a1", { enabled: false });
  addSession(offWorld, "s1");
  addBinding(offWorld, "b1", { sessionId: "s1", enabled: false });
  const [offRun] = await runAutomationNow("a1", undefined, offWorld.deps);
  assert.equal(offRun.status, "success");
}

// ---------------------------------------------------------------------------
// Failure paths
// ---------------------------------------------------------------------------

{
  resetAutomationQueueForTests();
  const world = createWorld();
  world.outcome = { throws: "Claude Code is not installed." };
  addAutomation(world, "a1");
  addSession(world, "s1");
  addBinding(world, "b1", { sessionId: "s1" });

  const [run] = await runAutomationTrigger({ automationId: "a1", kind: "schedule" }, world.deps);
  assert.equal(run.status, "failed");
  assert.equal(run.error, "Claude Code is not installed.");
  assert.ok(run.finishedAt);
  assert.deepEqual(world.sessions.get("s1").entries, [], "nothing is persisted");
  assert.deepEqual(world.updates.map((update) => update.status), ["running", "failed"]);
}

{
  resetAutomationQueueForTests();
  const world = createWorld();
  world.outcome = { error: "Claude is not authenticated.", authError: true };
  addAutomation(world, "a1");
  addSession(world, "s1");
  addBinding(world, "b1", { sessionId: "s1" });

  const [run] = await runAutomationTrigger({ automationId: "a1", kind: "schedule" }, world.deps);
  assert.equal(run.status, "skipped");
  assert.equal(run.skipReason, "no-auth", "an auth failure mid-stream is a skip, not a failure");
  assert.equal(run.error, "Claude is not authenticated.");
}

{
  resetAutomationQueueForTests();
  const world = createWorld();
  world.outcome = { error: "The model exploded.", authError: false };
  addAutomation(world, "a1");
  addSession(world, "s1");
  addBinding(world, "b1", { sessionId: "s1" });

  const [run] = await runAutomationTrigger({ automationId: "a1", kind: "schedule" }, world.deps);
  assert.equal(run.status, "failed");
  assert.equal(run.error, "The model exploded.");
}

{
  resetAutomationQueueForTests();
  const world = createWorld();
  world.outcome = { cancelled: true, text: "half a th" };
  addAutomation(world, "a1");
  addSession(world, "s1");
  addBinding(world, "b1", { sessionId: "s1" });

  const [run] = await runAutomationTrigger({ automationId: "a1", kind: "schedule" }, world.deps);
  assert.equal(run.status, "cancelled");
  assert.deepEqual(world.sessions.get("s1").entries, []);
}

// The run log and the conversation take different things from the same answer:
// the log lifts the headline, the conversation keeps the answer verbatim. The
// runner asks for no label, so it has nothing to edit out on the way in.
{
  resetAutomationQueueForTests();
  const world = createWorld();
  world.outcome = {
    text: "**Load is ramping fast.**\n- Volume up 22%.\n- Sleep is short."
  };
  addAutomation(world, "a1");
  addSession(world, "s1");
  addBinding(world, "b1", { sessionId: "s1" });

  const [run] = await runAutomationTrigger({ automationId: "a1", kind: "schedule" }, world.deps);
  assert.equal(run.summary, "Load is ramping fast.", "the log lifts the headline");

  const saved = world.sessions.get("s1").entries;
  assert.equal(
    saved[saved.length - 1].content,
    world.outcome.text,
    "the answer reaches the athlete exactly as the model wrote it"
  );
  assert.doesNotMatch(AUTOMATION_OUTPUT_CONTRACT, /TLDR/);
}

// A run takes as long as the provider does. Anything the athlete said in that
// conversation meanwhile has to survive the automation's append.
{
  resetAutomationQueueForTests();
  const world = createWorld();
  addAutomation(world, "a1");
  addSession(world, "s1", [{ kind: "message", role: "user", content: "before" }]);
  addBinding(world, "b1", { sessionId: "s1" });

  const original = world.deps.streamChat;
  world.deps.streamChat = async (...args) => {
    // The athlete types while the model is still answering.
    world.sessions.get("s1").entries.push({
      kind: "message",
      role: "user",
      content: "typed mid-run"
    });
    return original(...args);
  };

  await runAutomationTrigger({ automationId: "a1", kind: "schedule" }, world.deps);
  assert.deepEqual(
    world.sessions.get("s1").entries.map((entry) => entry.content),
    [
      "before",
      "typed mid-run",
      world.streamCalls[0].messages[world.streamCalls[0].messages.length - 1].content,
      // The label the runner asked for is stripped on the way in; the run log
      // keeps it, the conversation does not.
      "Load is ramping fast.\nEase off Thursday."
    ],
    "the athlete's turn is not deleted by the automation's append"
  );
}

// A binding whose run fails still had its clock advanced, so a broken
// automation cannot hammer the provider every tick.
{
  resetAutomationQueueForTests();
  const world = createWorld();
  world.outcome = { error: "boom" };
  addAutomation(world, "a1");
  addSession(world, "s1");
  addBinding(world, "b1", { sessionId: "s1" });
  await runAutomationTrigger({ automationId: "a1", kind: "schedule" }, world.deps);
  assert.equal(world.bindings.get("b1").lastRunAt, world.now.toISOString());
}


// ---------------------------------------------------------------------------
// Activity selection: what a binding still owes an opinion on
// ---------------------------------------------------------------------------

const ACTIVITY_TRIGGER = { kind: "activity", sportTypes: [] };
const NO_LIMITS = { batchWindowMin: 0, cooldownMin: 0, maxRunsPerDay: 9 };

/** Which activity each run analysed, in the order the runs happened. */
const analysedIds = (world) =>
  world.runs
    .filter((run) => run.triggerPayload?.activityIds)
    .map((run) => run.triggerPayload.activityIds[0]);

// --- multiActivity off: only the newest match, however many piled up --------
{
  resetAutomationQueueForTests();
  const world = createWorld();
  addAutomation(world, "a1", { trigger: ACTIVITY_TRIGGER, conditions: NO_LIMITS });
  addSession(world, "s1");
  addBinding(world, "b1", { sessionId: "s1", lastActivityAt: RUNNER_NOW_EPOCH - 8 * 86_400 });
  addActivity(world, "t3", 5);
  addActivity(world, "t4", 4);
  addActivity(world, "t5", 3);

  const runs = await runAutomationTrigger({ automationId: "a1", kind: "activity" }, world.deps);
  assert.equal(runs.length, 1, "one trigger, one run");
  assert.deepEqual(analysedIds(world), ["t5"], "the newest match, not the backlog");
  assert.equal(
    world.bindings.get("b1").lastActivityAt,
    RUNNER_NOW_EPOCH - 3 * 86_400,
    "the watermark still jumps to the newest, so the skipped ones stay skipped"
  );
}

// --- multiActivity on: one run per pending activity, oldest first -----------
{
  resetAutomationQueueForTests();
  const world = createWorld();
  addAutomation(world, "a1", {
    trigger: { ...ACTIVITY_TRIGGER, multiActivity: true },
    conditions: NO_LIMITS
  });
  addSession(world, "s1");
  addBinding(world, "b1", { sessionId: "s1", lastActivityAt: RUNNER_NOW_EPOCH - 8 * 86_400 });
  addActivity(world, "t3", 5);
  addActivity(world, "t4", 4);
  addActivity(world, "t5", 3);

  const runs = await runAutomationTrigger({ automationId: "a1", kind: "activity" }, world.deps);
  assert.equal(runs.length, 3);
  assert.deepEqual(analysedIds(world), ["t3", "t4", "t5"], "chronological, not newest-first");
  assert.ok(
    runs.every((run) => run.status === "success"),
    "each pending activity gets its own answer"
  );

  // Each turn names its own subject, or the three answers would be
  // interchangeable — the playbook itself is identical across them.
  const focus = world.streamCalls.map(
    (call) => call.messages[call.messages.length - 1].content
  );
  assert.match(focus[0], /activity id t3/);
  assert.match(focus[1], /activity id t4/);
  assert.match(focus[2], /activity id t5/);

  assert.equal(world.bindings.get("b1").lastActivityAt, RUNNER_NOW_EPOCH - 3 * 86_400);

  // Nothing new since: the same trigger a second time does nothing at all.
  const again = await runAutomationTrigger({ automationId: "a1", kind: "activity" }, world.deps);
  assert.deepEqual(again, [], "an automatic trigger with nothing to say stays silent");
  assert.equal(world.runs.length, 3, "and logs no non-event");
}

// --- two triggers racing off the same watermark -----------------------------
{
  resetAutomationQueueForTests();
  const world = createWorld();
  addAutomation(world, "a1", { trigger: ACTIVITY_TRIGGER, conditions: NO_LIMITS });
  addSession(world, "s1");
  addBinding(world, "b1", { sessionId: "s1", lastActivityAt: RUNNER_NOW_EPOCH - 8 * 86_400 });
  addActivity(world, "t5", 3);

  // The 15-minute poll and a "Run now" seconds apart: both plan their runs
  // before either has moved the watermark.
  const [first, second] = await Promise.all([
    runAutomationTrigger({ automationId: "a1", kind: "activity" }, world.deps),
    runAutomationTrigger({ automationId: "a1", kind: "activity" }, world.deps)
  ]);

  const runs = [...first, ...second];
  assert.deepEqual(
    runs.map((run) => run.status).sort(),
    ["skipped", "success"],
    "the same activity is analysed once, not twice into the same conversation"
  );
  assert.equal(
    runs.find((run) => run.status === "skipped").skipReason,
    "no-activity"
  );
  assert.equal(world.streamCalls.length, 1, "and the provider was billed once");
}

// --- never analysed: the attach time is the floor ---------------------------
{
  resetAutomationQueueForTests();
  const world = createWorld();
  addAutomation(world, "a1", {
    trigger: { ...ACTIVITY_TRIGGER, multiActivity: true },
    conditions: NO_LIMITS
  });
  addSession(world, "s1");
  // Attached two days ago; the older activities predate it.
  addBinding(world, "b1", {
    sessionId: "s1",
    createdAt: new Date((RUNNER_NOW_EPOCH - 2 * 86_400) * 1000).toISOString()
  });
  addActivity(world, "before-attach", 5);
  addActivity(world, "after-attach", 1);

  await runAutomationTrigger({ automationId: "a1", kind: "activity" }, world.deps);
  assert.deepEqual(
    analysedIds(world),
    ["after-attach"],
    "attaching a coach today does not replay the back catalogue"
  );
}

// --- "Run now" on a binding that never analysed anything --------------------
{
  resetAutomationQueueForTests();
  const world = createWorld();
  addAutomation(world, "a1", { trigger: ACTIVITY_TRIGGER, conditions: NO_LIMITS });
  addSession(world, "s1");
  addBinding(world, "b1", {
    sessionId: "s1",
    createdAt: new Date((RUNNER_NOW_EPOCH - 60) * 1000).toISOString()
  });
  // Every activity predates the attach, so the automatic floor would find none.
  addActivity(world, "older", 5);
  addActivity(world, "newest", 3);

  const runs = await runAutomationNow("a1", undefined, world.deps);
  assert.equal(runs.length, 1);
  assert.deepEqual(
    analysedIds(world),
    ["newest"],
    "3.4: a coach attached five minutes ago still has something to answer about"
  );
}

// --- "Run now" with a watermark and nothing new -----------------------------
{
  resetAutomationQueueForTests();
  const world = createWorld();
  addAutomation(world, "a1", { trigger: ACTIVITY_TRIGGER, conditions: NO_LIMITS });
  addSession(world, "s1");
  addActivity(world, "already-done", 3);
  addBinding(world, "b1", {
    sessionId: "s1",
    lastActivityAt: RUNNER_NOW_EPOCH - 3 * 86_400
  });

  const runs = await runAutomationNow("a1", undefined, world.deps);
  assert.equal(runs.length, 1);
  assert.equal(runs[0].status, "skipped");
  assert.equal(
    runs[0].skipReason,
    "no-activity",
    "the button has to say something, so the refusal is recorded"
  );
  assert.equal(world.streamCalls.length, 0, "and no provider call was made");
}

// --- the cooldown gates the reaction, not the catch-up ----------------------
{
  resetAutomationQueueForTests();
  const world = createWorld();
  addAutomation(world, "a1", {
    trigger: { ...ACTIVITY_TRIGGER, multiActivity: true },
    conditions: { batchWindowMin: 0, cooldownMin: 120, maxRunsPerDay: 9 }
  });
  addSession(world, "s1");
  addBinding(world, "b1", { sessionId: "s1", lastActivityAt: RUNNER_NOW_EPOCH - 8 * 86_400 });
  addActivity(world, "t3", 5);
  addActivity(world, "t4", 4);
  addActivity(world, "t5", 3);

  const runs = await runAutomationTrigger({ automationId: "a1", kind: "activity" }, world.deps);
  assert.deepEqual(
    runs.map((run) => run.status),
    ["success", "success", "success"],
    "run 1 sets lastRunAt, but a two-hour cooldown must not strand the backlog"
  );
}

// --- the daily cap stops the sequence, and the leftovers are not lost -------
{
  resetAutomationQueueForTests();
  const world = createWorld();
  addAutomation(world, "a1", {
    trigger: { ...ACTIVITY_TRIGGER, multiActivity: true },
    conditions: { batchWindowMin: 0, cooldownMin: 0, maxRunsPerDay: 2 }
  });
  addSession(world, "s1");
  addBinding(world, "b1", { sessionId: "s1", lastActivityAt: RUNNER_NOW_EPOCH - 8 * 86_400 });
  addActivity(world, "t3", 5);
  addActivity(world, "t4", 4);
  addActivity(world, "t5", 3);
  // A fourth pending activity: without the break, the cap would log its
  // refusal once for t5 and again for t6.
  addActivity(world, "t6", 2);

  const runs = await runAutomationTrigger({ automationId: "a1", kind: "activity" }, world.deps);
  assert.deepEqual(runs.map((run) => run.status), ["success", "success", "skipped"]);
  assert.equal(runs[2].skipReason, "budget");
  assert.deepEqual(analysedIds(world), ["t3", "t4", "t5"]);
  assert.equal(
    world.runs.length,
    3,
    "the refusal is logged once, not once per pending activity"
  );
  assert.equal(
    world.bindings.get("b1").lastActivityAt,
    RUNNER_NOW_EPOCH - 4 * 86_400,
    "the watermark stops at t4, so t5 rides along with the next trigger"
  );
}

// --- the sport/duration filters still apply to the selection ---------------
{
  resetAutomationQueueForTests();
  const world = createWorld();
  addAutomation(world, "a1", {
    trigger: { kind: "activity", sportTypes: [100], multiActivity: true, minDurationSec: 1800 },
    conditions: NO_LIMITS
  });
  addSession(world, "s1");
  addBinding(world, "b1", { sessionId: "s1", lastActivityAt: RUNNER_NOW_EPOCH - 8 * 86_400 });
  addActivity(world, "swim", 5, { sport_type: 200, sport_name: "Swim" });
  addActivity(world, "short-run", 4, { duration: 600 });
  addActivity(world, "long-run", 3);

  await runAutomationTrigger({ automationId: "a1", kind: "activity" }, world.deps);
  assert.deepEqual(analysedIds(world), ["long-run"]);
}

// --- a failed run leaves the watermark alone, so the activity comes back ----
{
  resetAutomationQueueForTests();
  const world = createWorld();
  world.outcome = { error: "provider exploded" };
  addAutomation(world, "a1", { trigger: ACTIVITY_TRIGGER, conditions: NO_LIMITS });
  addSession(world, "s1");
  addBinding(world, "b1", { sessionId: "s1", lastActivityAt: RUNNER_NOW_EPOCH - 8 * 86_400 });
  addActivity(world, "t5", 3);

  const [run] = await runAutomationTrigger({ automationId: "a1", kind: "activity" }, world.deps);
  assert.equal(run.status, "failed");
  assert.equal(
    world.bindings.get("b1").lastActivityAt,
    RUNNER_NOW_EPOCH - 8 * 86_400,
    "a failure must not silently consume the activity"
  );
}

// --- a silent run still consumed the activity -------------------------------
{
  resetAutomationQueueForTests();
  const world = createWorld();
  world.outcome = { text: NOTHING_TO_REPORT };
  addAutomation(world, "a1", { trigger: ACTIVITY_TRIGGER, conditions: NO_LIMITS });
  addSession(world, "s1");
  addBinding(world, "b1", { sessionId: "s1", lastActivityAt: RUNNER_NOW_EPOCH - 8 * 86_400 });
  addActivity(world, "t5", 3);

  const [run] = await runAutomationTrigger({ automationId: "a1", kind: "activity" }, world.deps);
  assert.equal(run.status, "silent");
  assert.equal(
    world.bindings.get("b1").lastActivityAt,
    RUNNER_NOW_EPOCH - 3 * 86_400,
    "the model looked and had nothing to say; that is still an answer"
  );
}

// ---------------------------------------------------------------------------
// A provider that goes silent
// ---------------------------------------------------------------------------

const HUNG = Symbol("hung");

/**
 * Every assertion here is about a promise settling at all, so a regression
 * would otherwise show up as a test run that hangs rather than one that fails.
 */
async function withDeadline(work, ms, what) {
  const result = await Promise.race([
    work,
    new Promise((resolve) => setTimeout(() => resolve(HUNG), ms))
  ]);
  assert.notEqual(result, HUNG, what);
  return result;
}

// --- the run is given up on rather than left open ---------------------------
{
  resetAutomationQueueForTests();
  const world = createWorld({
    idleTimeoutMs: 20,
    // Never settles, and never emits: the shape of an MCP connect or a provider
    // fetch that has stopped answering. Neither carries a deadline of its own.
    streamChat: () => new Promise(() => {})
  });
  addAutomation(world, "a1");
  addSession(world, "s1");
  addBinding(world, "b1");

  const [run] = await withDeadline(
    runAutomationNow("a1", undefined, world.deps),
    2_000,
    "a run whose provider went quiet has to end by itself"
  );
  assert.equal(run.status, "failed");
  assert.match(run.error, /stopped responding/);
  assert.deepEqual(
    world.cancelledRunIds,
    [run.id],
    "the stream is aborted on the way out, so a provider that does watch the signal stops"
  );
}

// --- a stream that keeps talking is never given up on -----------------------
{
  resetAutomationQueueForTests();
  const world = createWorld({
    idleTimeoutMs: 40,
    // Six times the window in total, but never quiet for a whole one: a long
    // tool-using run must not be mistaken for a dead one.
    streamChat: async (sink) => {
      for (let tick = 0; tick < 12; tick += 1) {
        await new Promise((resolve) => setTimeout(resolve, 20));
        sink.emit("chat:streamToken", { delta: "." });
      }
    }
  });
  addAutomation(world, "a1");
  addSession(world, "s1");
  addBinding(world, "b1");

  const [run] = await withDeadline(
    runAutomationNow("a1", undefined, world.deps),
    2_000,
    "a talkative run has to finish"
  );
  assert.equal(run.status, "success");
}

// --- and it does not wedge the runs behind it -------------------------------
{
  resetAutomationQueueForTests();
  const stalled = createWorld({
    idleTimeoutMs: 20,
    streamChat: () => new Promise(() => {})
  });
  addAutomation(stalled, "a1");
  addSession(stalled, "s1");
  addBinding(stalled, "b1");

  const healthy = createWorld();
  addAutomation(healthy, "a2");
  addSession(healthy, "s1");
  addBinding(healthy, "b2", { automationId: "a2" });

  // Queued behind the stall, on the process-wide queue of 5.4. Without a bound
  // on the run in front of it this never resolves, which is what an athlete
  // sees as a "Run now" button that spins with nothing behind it.
  const first = runAutomationNow("a1", undefined, stalled.deps);
  const [behind] = await withDeadline(
    runAutomationNow("a2", undefined, healthy.deps),
    2_000,
    "one stalled run must not hold every later run for the life of the process"
  );
  assert.equal(behind.status, "success");
  await first;
}

Module._load = originalLoad;
console.log("coach automation runner tests passed");
