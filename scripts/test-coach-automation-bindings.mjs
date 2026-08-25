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
  listCoachAutomationSessionAttention,
  markCoachAutomationSessionSeen,
  recordCoachAutomationRun,
  setCoachAutomationEnabled,
  updateCoachAutomation
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

  /** @type {Array<Record<string, any>>} */
  const runs = [];

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
    },
    // Runs, for the conversation-list attention projection (9.3). The filters
    // mirror the WHERE clauses in listCoachAutomationRunRows.
    listRuns(filter = {}) {
      return runs
        .filter((run) => !filter.sessionId || run.session_id === filter.sessionId)
        .filter((run) => !filter.statuses || filter.statuses.includes(run.status))
        .filter((run) => !filter.unseenOnly || run.seen_at === null)
        .map((row) => ({ ...row }));
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

// A changed trigger invalidates the slots the scheduler already booked (3.1).
// Moving a briefing from 07:00 to 21:00 must not deliver one more 07:00 first.
{
  const rebooked = makeAutomation("Rebooked");
  const first = attachCoachAutomation(
    { automationId: rebooked.id, mode: "dedicated", sessionId: "s-reboot-a" },
    db
  );
  const second = attachCoachAutomation(
    { automationId: rebooked.id, mode: "dedicated", sessionId: "s-reboot-b" },
    db
  );
  const book = (binding) =>
    setCoachAutomationBindingSchedule(
      binding.id,
      { nextRunAt: "2026-08-22T07:00:00.000Z" },
      db
    );
  book(first);
  book(second);

  updateCoachAutomation(
    rebooked.id,
    { trigger: { kind: "schedule", cadence: "daily", timeOfDay: "07:00" } },
    db
  );
  assert.equal(
    getCoachAutomationBinding(first.id, db).nextRunAt,
    undefined,
    "every binding of the edited automation loses its booked slot"
  );
  assert.equal(getCoachAutomationBinding(second.id, db).nextRunAt, undefined);

  book(first);
  updateCoachAutomation(rebooked.id, { name: "Renamed" }, db);
  assert.equal(
    getCoachAutomationBinding(first.id, db).nextRunAt,
    "2026-08-22T07:00:00.000Z",
    "an edit that leaves the trigger alone leaves the slot alone"
  );
  updateCoachAutomation(
    rebooked.id,
    { trigger: { kind: "schedule", cadence: "daily", timeOfDay: "07:00" } },
    db
  );
  assert.equal(
    getCoachAutomationBinding(first.id, db).nextRunAt,
    "2026-08-22T07:00:00.000Z",
    "and re-sending the same trigger is not an edit"
  );
}

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

// --- conversation-list attention (9.3) -------------------------------------
// An auto run changes the transcript, so it bumps the conversation to the top
// of the list. The chip says a coach speaks here; the dot says it has said
// something new. Without the dot the row reorders for no visible reason.
{
  const attentionDb = createMemoryDatabase();
  const coach = createCoachAutomation(
    { name: "Debrief", playbook: "Debrief.", trigger: { kind: "manual" } },
    attentionDb
  );
  const attach = (sessionId, patch = {}) =>
    attachCoachAutomation(
      { automationId: coach.id, mode: "existing", sessionId, ...patch },
      attentionDb
    );
  const run = (sessionId, patch = {}) =>
    recordCoachAutomationRun(
      {
        automationId: coach.id,
        bindingId: "any",
        status: "success",
        triggerKind: "manual",
        sessionId,
        finishedAt: "2026-08-25T07:00:00.000Z",
        ...patch
      },
      attentionDb
    );
  const byId = () =>
    new Map(
      listCoachAutomationSessionAttention(attentionDb).map((row) => [
        row.sessionId,
        row
      ])
    );

  const live = attach("s-live");
  const off = attach("s-off");
  setCoachAutomationBindingEnabled(off.id, false, attentionDb);
  // A "per-run" binding has no conversation of its own to mark.
  attachCoachAutomation(
    { automationId: coach.id, mode: "per-run" },
    attentionDb
  );

  // Only conversations with something to say are listed at all: a row the
  // sidebar hears nothing about is a row with no marks on it.
  let marks = byId();
  assert.equal(marks.get("s-live").attached, true);
  assert.equal(marks.get("s-live").unread, 0, "attached is not the same as unread");
  assert.equal(
    marks.has("s-off"),
    false,
    "a binding switched off is not going to speak"
  );
  assert.equal(marks.size, 1, "and a per-run binding has no conversation of its own");

  // Only the two statuses that write to the transcript make a conversation
  // unread — those are the two that bumped it up the list.
  run("s-live");
  run("s-live", { status: "silent" });
  run("s-live", { status: "skipped", skipReason: "cooldown" });
  run("s-live", { status: "failed", error: "boom" });
  run("s-live", { status: "running", finishedAt: undefined });
  marks = byId();
  assert.equal(
    marks.get("s-live").unread,
    2,
    "a skip, a failure and a run still going wrote nothing to read"
  );

  // A run into a conversation nothing is attached to any more is still unread:
  // the answer is sitting in it either way.
  run("s-history");
  marks = byId();
  assert.equal(marks.get("s-history").attached, false);
  assert.equal(marks.get("s-history").unread, 1);

  // A run whose conversation was deleted has nowhere to be unread.
  run(undefined);
  assert.equal(byId().size, 2, "a run with no conversation marks nothing");

  // Opening a conversation is what reading it means, and it is scoped.
  assert.equal(markCoachAutomationSessionSeen("s-live", attentionDb), 2);
  marks = byId();
  assert.equal(marks.get("s-live").unread, 0);
  assert.equal(
    marks.get("s-history").unread,
    1,
    "reading one conversation does not clear another"
  );
  assert.equal(
    markCoachAutomationSessionSeen("s-live", attentionDb),
    0,
    "reading it twice is a no-op"
  );
  assert.equal(
    marks.get("s-live").attached,
    true,
    "and the chip stays: the coach still writes here"
  );
  assert.equal(
    byId().has("s-history"),
    true,
    "an unread conversation stays listed even with nothing attached"
  );

  // The skip is still unstamped, so it never silently became "read".
  const skipped = attentionDb
    .listRuns({ sessionId: "s-live", statuses: ["skipped"] })
    .at(0);
  assert.equal(skipped.seen_at, null, "a skip the athlete never saw stays unseen");

  // Switching the definition off silences every conversation it wrote into.
  setCoachAutomationEnabled(coach.id, false, attentionDb);
  assert.equal(
    byId().has("s-live"),
    false,
    "a disabled automation speaks nowhere, and its read conversation drops out"
  );
}

// --- the marks reach the conversation list ---------------------------------
// The projection above is only worth having if the sidebar asks for it, clears
// it, and keeps asking. All of this lives in JSX and effects, so it is asserted
// at the source level — the same trick test-ipc-surface.mjs uses for invariants
// TypeScript cannot see. A dropped argument is still a valid call.
{
  const read = (...parts) => readFileSync(path.join(repoRoot, ...parts), "utf8");

  const row = read("src", "chat", "ChatSessionRow.tsx");
  assert.match(
    row,
    /className="chat-session-row-automation-mark"/,
    "the row must carry the automation chip"
  );
  assert.match(
    row,
    /className="chat-session-row-unread"/,
    "the row must carry the unread dot"
  );

  const view = read("src", "chat", "ChatView.tsx");
  assert.match(
    view,
    /void markSessionRead\(sessionId\);/,
    "opening a conversation must clear its unread mark"
  );
  assert.match(
    view,
    /attention: sessionAttention/,
    "the marks must reach the sidebar"
  );
  // Three run-update listeners, each doing what the other two deliberately do
  // not. The live-view subscription returns early for conversations that are
  // not open, which is exactly the case the dot exists for, so a second one
  // watches all of them; and neither touches the conversation list, which a
  // `per-run` binding adds to on every run. Three is the point, not an accident.
  assert.equal(
    (view.match(/api\.onCoachAutomationRunUpdate\(/g) ?? []).length,
    3,
    "a run into a conversation that is not open must still update the marks"
  );
  // 2.2: a `per-run` binding creates a conversation this window has never heard
  // of, and every run bumps the one it wrote into to the top (9.3). The sidebar
  // renders from a list read on mount, so without this neither showed up until
  // the app was restarted.
  assert.match(
    view,
    /if \(!run\.sessionId\) return;\n\s*void refreshSessions\(provider\)/,
    "a run that reaches into the conversation list must make the sidebar re-read it"
  );

  // The ⚡ mark is derived from the bindings, so attaching or detaching moves
  // it. The header popover is the entry point most athletes use and the only
  // one with no way to report a change, so the mark stayed put until restart.
  assert.match(
    view,
    /onChanged=\{\(\) => setAutomationsVersion\(\(value\) => value \+ 1\)\}\n\s*onManageAutomations=/,
    "the header popover must be able to say it changed which coaches are attached"
  );
  const popover = read("src", "chat", "automations", "ConversationCoaches.tsx");
  // Both of its ways of changing a binding: the shared mutation wrapper — the
  // switch, the reorder, the detach — and the attach dialog it opens.
  assert.match(
    popover,
    /await work\(\);\n\s*await refresh\(\);\n\s*onChanged\?\.\(\);/,
    "switching, reordering or detaching a coach must say so"
  );
  assert.match(
    popover,
    /onAttached=\{async \(\) => \{\n\s*await refresh\(\);\n\s*onChanged\?\.\(\);/,
    "and so must attaching one"
  );

  // --- 3.4: which places a manual run reaches ------------------------------
  // From a conversation it is always that one place, whichever surface asked.
  assert.match(
    popover,
    /runCoachAutomationNow\(binding\.automationId, \[binding\.id\]\)/,
    "running from a conversation must run only in that conversation"
  );
  assert.match(
    read("src", "chat", "automations", "CoachAutomationDetail.tsx"),
    /runCoachAutomationNow\(automationId, \[bindingId\]\)/,
    "and so must running from one row of the coach's own list"
  );

  // From the automation screen the coach may run in several places at once, so
  // it asks first — but only where there is something to ask about.
  const runPanel = read("src", "chat", "automations", "CoachAutomationsPanel.tsx");
  assert.match(
    runPanel,
    /if \(summary\.bindingCount > 1\) \{\n\s*setPickingId\(automation\.id\);\n\s*return;\n\s*\}\n\s*void startRun\(automation\.id\);/,
    "one place runs straight away; several ask which"
  );
  assert.match(
    runPanel,
    /api\.runCoachAutomationNow\(automationId, bindingIds\)/,
    "and the answer has to reach the runner"
  );
  const runDialog = read("src", "chat", "automations", "RunNowDialog.tsx");
  assert.match(
    runDialog,
    /detail\.bindings\n\s*\.filter\(\(binding\) => binding\.enabled\)/,
    "the default is every live place, not every place"
  );

  // --- the run log is a way back into the conversation ----------------------
  const detailScreen = read("src", "chat", "automations", "CoachAutomationDetail.tsx");
  assert.match(
    detailScreen,
    /onClick=\{\(\) => onOpenConversation\?\.\(opensInto\)\}/,
    "a run log row must open the conversation the run wrote into"
  );
  // A `per-run` conversation can be newer than anything this window has heard
  // of, and one from an old run may have been deleted since. Selecting a
  // session id no row exists for leaves the sidebar with nothing selected and
  // the composer writing into a conversation that is not there.
  assert.match(
    view,
    /const listed = await refreshSessions\(chatSettings\.provider\);\n\s*if \(!listed\.some\(\(session\) => session\.id === sessionId\)\)/,
    "and the conversation has to still exist before it is opened"
  );

  // --- what "a run is in flight here" is read from -------------------------
  // Derived, not accumulated. A `per-run` binding attached to this conversation
  // runs into one of its own, so a subscription filtered on this session's id
  // threw away every update about the rows on screen — and switching away and
  // back left the map holding runs that had finished meanwhile.
  assert.match(
    popover,
    /listCoachAutomationRuns\(\{ statuses: \["running"\] \}\)[\s\S]{0,300}?setInFlightRuns\(\s*Object\.fromEntries\(running\.map/,
    "the popover must re-read which runs are in flight, and use the answer"
  );
  assert.doesNotMatch(
    popover,
    /run\.sessionId !== sessionId/,
    "and must not throw away the updates that tell it to"
  );
  // A trigger fans out to one run per place and they are serialised, so between
  // two of them no run is `running`. The card's optimistic flag has to outlast
  // that gap or it offers "Run now" in the middle of its own fan-out — which is
  // why it is set once and cleared once, when the whole fan-out has answered.
  assert.equal(
    (runPanel.match(/setStartingId\(/g) ?? []).length,
    2,
    "the card's run flag is set on the click and cleared on the outcome, nowhere else"
  );

  // 5.6: a run streams into the conversation as it happens, but the
  // subscription that shows it only ever hears about a run whose conversation
  // is *already* open. Opening one mid-run — which a `per-run` binding invites,
  // its conversation appearing in the sidebar the moment the run starts — left
  // an empty transcript with nothing to say why.
  assert.match(
    view,
    /statuses: \["running"\][\s\S]{0,200}?showLiveAutomation\(runs\[0\]\)/,
    "opening a conversation must pick up a run already streaming into it"
  );

  assert.match(
    read("electron", "preload.ts"),
    /invoke\("coachAutomation:markSessionSeen", sessionId\)/,
    "preload must forward the session id across the bridge"
  );
  assert.match(
    read("electron", "main.ts"),
    /markCoachAutomationSessionSeen\(sessionId\)/,
    "the ipcMain handler must forward the session id"
  );

  // 2.1: the store refuses a `dedicated` binding with no conversation, and it
  // is right to — it has no business creating chat sessions. Somebody still has
  // to, and that is the attach screen. Until the presets started recommending
  // this mode the button had never worked: it attached with no session id and
  // failed with BINDING_SESSION_REQUIRED every time.
  const attachScreen = read("src", "chat", "automations", "AttachAutomationScreen.tsx");
  assert.match(
    attachScreen,
    /api\.createChatSession\(provider\)/,
    "attaching a dedicated binding must create its conversation"
  );
  assert.match(
    attachScreen,
    /api\.renameChatSession\(created\.id, automationName\)/,
    "and name it, or its first run titles it after its own playbook (2.5)"
  );
  assert.match(
    attachScreen,
    /mode: "dedicated",\s*sessionId: created\.id/,
    "and hand that conversation to the store"
  );
  assert.doesNotMatch(
    attachScreen,
    /attachMode\("dedicated"\)/,
    "the session-less dedicated attach is the bug, not a fallback"
  );

  // A preset was written around one binding mode, and the attach screen says
  // which — advisory only, since all three modes stay on offer.
  const detail = read("src", "chat", "automations", "CoachAutomationDetail.tsx");
  assert.match(
    detail,
    /suggestedMode=\{suggestedBinding\?\.mode\}/,
    "the preset's recommended binding mode must reach the attach screen"
  );
  assert.match(
    attachScreen,
    /data-suggested=\{suggestedMode === "dedicated" \? "true" : undefined\}/,
    "and be marked on the mode it recommends"
  );

  // Section 10: an expired provider sign-in shows up as a no-auth skip and
  // nothing else. For the providers guard rail 3 cannot pre-flight, this banner
  // is the athlete's only indication.
  const panel = read("src", "chat", "automations", "CoachAutomationsPanel.tsx");
  assert.match(
    panel,
    /skipReason === "no-auth"/,
    "the panel must recognise a signed-out provider"
  );
  assert.match(
    panel,
    /className="coach-automation-banner"/,
    "and say so in a banner"
  );
}

console.log("coach automation binding tests passed");
