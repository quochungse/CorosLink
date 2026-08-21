import assert from "node:assert/strict";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { readFileSync } from "node:fs";

const repoRoot = path.resolve(import.meta.dirname, "..");
const distUrl = (file) =>
  pathToFileURL(path.join(repoRoot, "dist-electron", file)).href;

const {
  MAX_BINDINGS_PER_SESSION,
  applyCoachAutomationSessionDeleted,
  attachCoachAutomation,
  countCoachAutomationBindings,
  countCoachAutomationBindingsForSession,
  createCoachAutomation,
  deleteCoachAutomation,
  detachCoachAutomation,
  getCoachAutomationBinding,
  listActiveCoachAutomationBindings,
  listCoachAutomationBindings,
  listCoachAutomationBindingsForSession,
  reorderCoachAutomationBindings,
  setCoachAutomationBindingEnabled,
  setCoachAutomationBindingSchedule,
  setCoachAutomationBindingSession,
  setCoachAutomationEnabled
} = await import(`${distUrl("coachAutomationStore.js")}?cacheBust=${Date.now()}`);

// better-sqlite3 is built for the Electron ABI and will not dlopen under plain
// node, so the store is exercised through its injectable database interface.
// The ordering here mirrors the ORDER BY clauses in database.ts so the fake and
// the real table agree on run order.
function createMemoryDatabase() {
  /** @type {Map<string, Record<string, any>>} */
  const automations = new Map();
  /** @type {Map<string, Record<string, any>>} */
  const bindings = new Map();

  const byOrder = (left, right) =>
    left.sort_order - right.sort_order ||
    left.created_at.localeCompare(right.created_at);

  return {
    _automations: automations,
    _bindings: bindings,
    listAutomations() {
      return [...automations.values()].sort((left, right) =>
        left.created_at.localeCompare(right.created_at)
      );
    },
    getAutomation(id) {
      const row = automations.get(id);
      return row ? { ...row } : undefined;
    },
    insertAutomation(row) {
      automations.set(row.id, { ...row });
    },
    updateAutomation(row) {
      automations.set(row.id, { ...row });
    },
    deleteAutomation(id) {
      automations.delete(id);
    },
    deleteBindingsForAutomation(automationId) {
      for (const [id, row] of bindings) {
        if (row.automation_id === automationId) bindings.delete(id);
      }
    },
    countBindings(automationId) {
      return [...bindings.values()].filter(
        (row) => row.automation_id === automationId
      ).length;
    },
    listBindings(automationId) {
      return [...bindings.values()]
        .filter((row) => row.automation_id === automationId)
        .sort(byOrder)
        .map((row) => ({ ...row }));
    },
    listBindingsForSession(sessionId) {
      return [...bindings.values()]
        .filter((row) => row.session_id !== null && row.session_id === sessionId)
        .sort(byOrder)
        .map((row) => ({ ...row }));
    },
    getBinding(id) {
      const row = bindings.get(id);
      return row ? { ...row } : undefined;
    },
    insertBinding(row) {
      assert.ok(!bindings.has(row.id), "duplicate binding id");
      // The partial unique indexes must never be reachable from the store —
      // every violation should have been refused with a code first.
      for (const existing of bindings.values()) {
        if (existing.automation_id !== row.automation_id) continue;
        assert.ok(
          !(existing.session_id === null && row.session_id === null),
          "store let a second per-run binding through to the unique index"
        );
        assert.ok(
          !(row.session_id !== null && existing.session_id === row.session_id),
          "store let a duplicate attach through to the unique index"
        );
      }
      bindings.set(row.id, { ...row });
    },
    updateBinding(row) {
      assert.ok(bindings.has(row.id), "update of unknown binding");
      bindings.set(row.id, { ...row });
    },
    deleteBinding(id) {
      bindings.delete(id);
    }
  };
}

function expectCode(fn, code, label) {
  try {
    fn();
  } catch (error) {
    assert.equal(error.code, code, `${label}: wrong code (${error.message})`);
    assert.equal(error.name, "CoachAutomationBindingError");
    return error;
  }
  assert.fail(`${label}: expected ${code}, nothing thrown`);
}

const db = createMemoryDatabase();
const makeAutomation = (name) =>
  createCoachAutomation(
    { name, playbook: `${name} playbook`, trigger: { kind: "manual" } },
    db
  );

const briefing = makeAutomation("Briefing");
const debrief = makeAutomation("Debrief");

// --- 2.1 modes --------------------------------------------------------------
const dedicated = attachCoachAutomation(
  { automationId: briefing.id, mode: "dedicated", sessionId: "s1" },
  db
);
assert.equal(dedicated.mode, "dedicated");
assert.equal(dedicated.sessionId, "s1");
assert.equal(dedicated.enabled, true);
assert.equal(dedicated.sortOrder, 0);
assert.equal(dedicated.titleTemplate, undefined);
assert.equal(db._bindings.get(dedicated.id).enabled, 1);

const perRun = attachCoachAutomation(
  {
    automationId: debrief.id,
    mode: "per-run",
    titleTemplate: "{{rule.name}} · {{activity.name}}"
  },
  db
);
assert.equal(perRun.sessionId, null);
assert.equal(perRun.titleTemplate, "{{rule.name}} · {{activity.name}}");

// A title template on a mode that does not create its conversation is dropped.
const existing = attachCoachAutomation(
  {
    automationId: debrief.id,
    mode: "existing",
    sessionId: "s1",
    titleTemplate: "ignored"
  },
  db
);
assert.equal(existing.titleTemplate, undefined);
assert.equal(existing.sortOrder, 1, "second attach queues behind the first");
assert.deepEqual(getCoachAutomationBinding(existing.id, db), existing);
assert.equal(getCoachAutomationBinding("missing", db), null);

// --- 2.2 constraint 1: max 5 per conversation ------------------------------
assert.equal(MAX_BINDINGS_PER_SESSION, 5);
const fillers = [];
for (let index = 0; index < MAX_BINDINGS_PER_SESSION - 2; index += 1) {
  const automation = makeAutomation(`Filler ${index}`);
  fillers.push(
    attachCoachAutomation(
      { automationId: automation.id, mode: "existing", sessionId: "s1" },
      db
    )
  );
}
assert.equal(countCoachAutomationBindingsForSession("s1", db), 5);

const sixth = makeAutomation("Sixth");
const limitError = expectCode(
  () =>
    attachCoachAutomation(
      { automationId: sixth.id, mode: "existing", sessionId: "s1" },
      db
    ),
  "BINDING_LIMIT_REACHED",
  "sixth attach"
);
assert.match(limitError.message, /at most 5 automations/);
assert.equal(countCoachAutomationBindingsForSession("s1", db), 5, "no partial write");

// A per-run binding has no conversation, so it never eats into the cap.
assert.equal(
  listCoachAutomationBindingsForSession("s1", db).some(
    (binding) => binding.id === perRun.id
  ),
  false
);
attachCoachAutomation({ automationId: sixth.id, mode: "per-run" }, db);

// --- 2.2 constraint 2: no duplicate attach ---------------------------------
expectCode(
  () =>
    attachCoachAutomation(
      { automationId: briefing.id, mode: "existing", sessionId: "s1" },
      db
    ),
  "BINDING_DUPLICATE",
  "duplicate attach"
);
// Same automation on a *different* conversation is fine (fan-out, 2.3).
const fanOut = attachCoachAutomation(
  { automationId: briefing.id, mode: "existing", sessionId: "s2" },
  db
);
assert.equal(fanOut.sortOrder, 0, "sort_order is per conversation");
assert.equal(countCoachAutomationBindings(briefing.id, db), 2);

// --- 2.2 constraint 3: one per-run binding per automation ------------------
expectCode(
  () => attachCoachAutomation({ automationId: debrief.id, mode: "per-run" }, db),
  "BINDING_PER_RUN_EXISTS",
  "second per-run"
);

// --- attach argument validation --------------------------------------------
expectCode(
  () => attachCoachAutomation({ automationId: "nope", mode: "existing", sessionId: "s3" }, db),
  "AUTOMATION_NOT_FOUND",
  "unknown automation"
);
expectCode(
  () => attachCoachAutomation({ automationId: briefing.id, mode: "existing" }, db),
  "BINDING_SESSION_REQUIRED",
  "existing without session"
);
expectCode(
  () => attachCoachAutomation({ automationId: briefing.id, mode: "dedicated", sessionId: "  " }, db),
  "BINDING_SESSION_REQUIRED",
  "dedicated with blank session"
);
expectCode(
  () =>
    attachCoachAutomation(
      { automationId: briefing.id, mode: "per-run", sessionId: "s3" },
      db
    ),
  "BINDING_SESSION_NOT_ALLOWED",
  "per-run with session"
);
assert.throws(
  () => attachCoachAutomation({ automationId: briefing.id, mode: "whatever" }, db),
  /Unknown automation binding mode/
);

// --- enable toggle ----------------------------------------------------------
assert.equal(setCoachAutomationBindingEnabled(existing.id, false, db).enabled, false);
assert.equal(db._bindings.get(existing.id).enabled, 0);
assert.equal(setCoachAutomationBindingEnabled(existing.id, true, db).enabled, true);
assert.equal(setCoachAutomationBindingEnabled("missing", true, db), null);

// --- 2.2 constraint 4 / 2.3: sort_order is the run order -------------------
const sessionOrder = () =>
  listCoachAutomationBindingsForSession("s1", db).map((binding) => binding.id);
const original = sessionOrder();
assert.deepEqual(original, [dedicated.id, existing.id, ...fillers.map((b) => b.id)]);

const reversed = [...original].reverse();
const reordered = reorderCoachAutomationBindings("s1", reversed, db);
assert.deepEqual(reordered.map((binding) => binding.id), reversed);
assert.deepEqual(
  reordered.map((binding) => binding.sortOrder),
  [0, 1, 2, 3, 4],
  "sort_order is compacted, so it stays unique within the conversation"
);

// Foreign, repeated and unknown ids are ignored; anything left out keeps its
// relative order behind what the caller did list.
const partial = reorderCoachAutomationBindings(
  "s1",
  [existing.id, existing.id, perRun.id, fanOut.id, "missing"],
  db
);
assert.equal(partial[0].id, existing.id);
assert.equal(partial.length, 5, "omitted bindings are not dropped");
assert.deepEqual(
  partial.slice(1).map((binding) => binding.id),
  reversed.filter((id) => id !== existing.id),
  "omitted bindings keep their relative order"
);
assert.deepEqual(partial.map((binding) => binding.sortOrder), [0, 1, 2, 3, 4]);
// The foreign binding was untouched by the reorder of another conversation.
assert.equal(getCoachAutomationBinding(fanOut.id, db).sortOrder, 0);

// --- schedule stamps (3.1 keeps these per binding) -------------------------
const stamped = setCoachAutomationBindingSchedule(
  dedicated.id,
  { nextRunAt: "2026-08-22T07:30:00.000Z" },
  db
);
assert.equal(stamped.nextRunAt, "2026-08-22T07:30:00.000Z");
assert.equal(stamped.lastRunAt, undefined);
const ranOnce = setCoachAutomationBindingSchedule(
  dedicated.id,
  { lastRunAt: "2026-08-22T07:30:04.000Z" },
  db
);
assert.equal(ranOnce.nextRunAt, "2026-08-22T07:30:00.000Z", "absent key is left alone");
assert.equal(ranOnce.lastRunAt, "2026-08-22T07:30:04.000Z");
assert.equal(
  setCoachAutomationBindingSchedule(dedicated.id, { nextRunAt: null }, db).nextRunAt,
  undefined
);
assert.equal(setCoachAutomationBindingSchedule("missing", {}, db), null);

// The activity watermark lives on the same row: a binding attached last month
// and one attached today owe answers on different activities, so it cannot be
// tracked per automation.
assert.equal(
  getCoachAutomationBinding(dedicated.id, db).lastActivityAt,
  undefined,
  "a fresh binding has never analysed anything"
);
const analysed = setCoachAutomationBindingSchedule(
  dedicated.id,
  { lastActivityAt: 1_755_766_800 },
  db
);
assert.equal(analysed.lastActivityAt, 1_755_766_800);
assert.equal(
  analysed.lastRunAt,
  "2026-08-22T07:30:04.000Z",
  "absent key is left alone"
);
assert.equal(
  getCoachAutomationBinding(dedicated.id, db).lastActivityAt,
  1_755_766_800,
  "and it survives the row round-trip"
);
assert.equal(
  setCoachAutomationBindingSchedule(dedicated.id, { lastActivityAt: null }, db)
    .lastActivityAt,
  undefined
);

// --- 2.4 automation disabled: bindings stop, rows survive -------------------
assert.equal(listActiveCoachAutomationBindings(briefing.id, db).length, 2);
setCoachAutomationEnabled(briefing.id, false, db);
assert.deepEqual(listActiveCoachAutomationBindings(briefing.id, db), []);
assert.equal(
  listCoachAutomationBindings(briefing.id, db).length,
  2,
  "binding rows are kept while the automation is off"
);
assert.equal(
  listCoachAutomationBindings(briefing.id, db).every((binding) => binding.enabled),
  true,
  "per-binding enabled flags are untouched"
);
setCoachAutomationEnabled(briefing.id, true, db);
assert.equal(listActiveCoachAutomationBindings(briefing.id, db).length, 2);
// A disabled binding on an enabled automation is also inactive.
setCoachAutomationBindingEnabled(fanOut.id, false, db);
assert.deepEqual(
  listActiveCoachAutomationBindings(briefing.id, db).map((b) => b.id),
  [dedicated.id]
);
setCoachAutomationBindingEnabled(fanOut.id, true, db);
assert.deepEqual(listActiveCoachAutomationBindings("missing", db), []);

// --- 2.4 conversation deleted ----------------------------------------------
const report = applyCoachAutomationSessionDeleted("s1", db);
assert.deepEqual(
  report.needsSession.map((binding) => binding.id),
  [dedicated.id],
  "the dedicated binding rebuilds its conversation on the next run"
);
assert.equal(report.needsSession[0].enabled, true, "and stays enabled");
assert.equal(
  db._bindings.get(dedicated.id).session_id,
  "s1",
  "stale session_id is kept so the row cannot masquerade as per-run"
);
assert.equal(report.disabled.length, 4, "every existing binding on s1 is disabled");
assert.equal(
  report.disabled.every((binding) => binding.enabled === false),
  true
);
assert.equal(
  report.disabled.some((binding) => binding.id === existing.id),
  true
);
assert.equal(
  getCoachAutomationBinding(perRun.id, db).enabled,
  true,
  "per-run bindings are untouched by a conversation deletion"
);
assert.equal(
  getCoachAutomationBinding(fanOut.id, db).enabled,
  true,
  "bindings on other conversations are untouched"
);
assert.deepEqual(applyCoachAutomationSessionDeleted("never-existed", db), {
  disabled: [],
  needsSession: []
});

// --- repointing a broken binding -------------------------------------------
const repointed = setCoachAutomationBindingSession(existing.id, "s3", db);
assert.equal(repointed.sessionId, "s3");
assert.equal(repointed.enabled, true, "repointing is the fix for being disabled");
assert.equal(repointed.sortOrder, 0, "it queues into the new conversation");
expectCode(
  () => setCoachAutomationBindingSession(perRun.id, "s3", db),
  "BINDING_SESSION_NOT_ALLOWED",
  "repoint a per-run binding"
);
expectCode(
  () => setCoachAutomationBindingSession(existing.id, "", db),
  "BINDING_SESSION_REQUIRED",
  "repoint at nothing"
);
// Repointing onto a conversation that already runs this automation is a
// duplicate; onto a full conversation it hits the same cap as an attach.
const clash = attachCoachAutomation(
  { automationId: debrief.id, mode: "dedicated", sessionId: "s4" },
  db
);
expectCode(
  () => setCoachAutomationBindingSession(existing.id, "s4", db),
  "BINDING_DUPLICATE",
  "repoint onto a duplicate"
);
for (let index = 0; index < 4; index += 1) {
  const automation = makeAutomation(`Packing ${index}`);
  attachCoachAutomation(
    { automationId: automation.id, mode: "existing", sessionId: "s4" },
    db
  );
}
assert.equal(countCoachAutomationBindingsForSession("s4", db), 5);
const briefingOnS2 = getCoachAutomationBinding(fanOut.id, db);
expectCode(
  () => setCoachAutomationBindingSession(briefingOnS2.id, "s4", db),
  "BINDING_LIMIT_REACHED",
  "repoint onto a full conversation"
);
assert.equal(getCoachAutomationBinding(fanOut.id, db).sessionId, "s2", "no partial write");
// Repointing at the conversation it already uses just re-enables it.
setCoachAutomationBindingEnabled(clash.id, false, db);
const sameSession = setCoachAutomationBindingSession(clash.id, "s4", db);
assert.equal(sameSession.enabled, true);
assert.equal(sameSession.sessionId, "s4");
assert.equal(sameSession.sortOrder, clash.sortOrder, "order is not disturbed");
assert.equal(setCoachAutomationBindingSession("missing", "s4", db), null);

// --- 2.4 binding removed: conversation and siblings survive ----------------
const beforeDetach = countCoachAutomationBindingsForSession("s4", db);
detachCoachAutomation(clash.id, db);
assert.equal(getCoachAutomationBinding(clash.id, db), null);
assert.equal(countCoachAutomationBindingsForSession("s4", db), beforeDetach - 1);
assert.equal(countCoachAutomationBindings(debrief.id, db), 2, "its other bindings stay");
detachCoachAutomation("missing", db); // no-op

// --- 2.4 automation deleted: bindings go, other automations stay -----------
const debriefBindings = countCoachAutomationBindings(debrief.id, db);
assert.ok(debriefBindings > 0);
const survivorCount = db._bindings.size - debriefBindings;
deleteCoachAutomation(debrief.id, db);
assert.deepEqual(listCoachAutomationBindings(debrief.id, db), []);
assert.equal(db._bindings.size, survivorCount, "only its own bindings were removed");
assert.equal(
  getCoachAutomationBinding(fanOut.id, db).id,
  fanOut.id,
  "another automation's binding on the same conversation survives"
);

// --- 2.4 is wired to the real delete path, not just exported ---------------
// applyCoachAutomationSessionDeleted is only useful if deleting a conversation
// actually calls it; without this the lifecycle silently never fires in the app.
const chatServiceSource = readFileSync(
  path.join(repoRoot, "electron", "chatService.ts"),
  "utf8"
);
assert.match(
  chatServiceSource,
  /export function deleteChatSessionById\([\s\S]*?applyCoachAutomationSessionDeleted\(id\)/,
  "deleting a conversation no longer notifies the bindings pointing at it"
);

console.log("coach automation binding tests passed");
