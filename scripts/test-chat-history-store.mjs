import assert from "node:assert/strict";
import path from "node:path";
import { pathToFileURL } from "node:url";

const repoRoot = path.resolve(import.meta.dirname, "..");
const distUrl = (file) =>
  pathToFileURL(path.join(repoRoot, "dist-electron", file)).href;

const {
  createChatSession,
  deleteChatSession,
  deriveSessionTitleFromEntries,
  getChatSession,
  listChatSessions,
  migrateLegacyTranscriptRow,
  parseChatTranscriptJson,
  restoreChatPlanDraftSources,
  saveChatSession,
  setChatSessionPinned,
  setChatSessionTitle
} = await import(`${distUrl("chatHistoryStore.js")}?cacheBust=${Date.now()}`);

function createMemoryDatabase() {
  /** @type {Map<string, { id: string, provider: string, title: string, messages_json: string, created_at: string, updated_at: string, pinned_at: string | null }>} */
  const rows = new Map();

  return {
    listSessions(provider) {
      return [...rows.values()]
        .filter((row) => row.provider === provider)
        .sort(
          (left, right) =>
            new Date(right.updated_at).getTime() -
            new Date(left.updated_at).getTime()
        );
    },
    getSession(id) {
      return rows.get(id);
    },
    insertSession(id, provider, title, messagesJson, createdAt, updatedAt) {
      rows.set(id, {
        id,
        provider,
        title,
        messages_json: messagesJson,
        created_at: createdAt,
        updated_at: updatedAt,
        pinned_at: null
      });
    },
    updateSession(id, title, messagesJson, updatedAt) {
      const row = rows.get(id);
      if (!row) return;
      rows.set(id, {
        ...row,
        title,
        messages_json: messagesJson,
        updated_at: updatedAt
      });
    },
    setSessionPinned(id, pinnedAt) {
      const row = rows.get(id);
      if (!row) return;
      rows.set(id, { ...row, pinned_at: pinnedAt });
    },
    setSessionTitle(id, title) {
      const row = rows.get(id);
      if (!row) return;
      rows.set(id, { ...row, title });
    },
    deleteSession(id) {
      rows.delete(id);
    }
  };
}

assert.deepEqual(parseChatTranscriptJson("not-json"), []);
assert.deepEqual(parseChatTranscriptJson("{}"), []);
assert.deepEqual(parseChatTranscriptJson('[{"role":"nope","content":"x"}]'), []);

assert.deepEqual(
  parseChatTranscriptJson(
    JSON.stringify([
      { kind: "message", role: "user", content: "Hello" },
      {
        kind: "message",
        role: "assistant",
        content: "Hi",
        reasoningSummary: "I should greet the athlete briefly.",
        source: {
          snapshotIncluded: true,
          mcpEnabled: false,
          mcpUsed: false,
          mcpTools: []
        }
      }
    ])
  ),
  [
    { kind: "message", role: "user", content: "Hello" },
    {
      kind: "message",
      role: "assistant",
      content: "Hi",
      reasoningSummary: "I should greet the athlete briefly.",
      source: {
        snapshotIncluded: true,
        mcpEnabled: false,
        mcpUsed: false,
        mcpTools: []
      }
    }
  ]
);

const waitingPromptEntry = {
  kind: "coachPrompt",
  prompt: {
    promptId: "prompt-1",
    question: "Which strength option should Coach use?",
    choices: [
      {
        id: "choice-1",
        label: "Use split squats",
        description: "Recommended supported alternative.",
        response: "Use split squats."
      },
      {
        id: "choice-2",
        label: "I’ll provide the exact name",
        response: "I’ll provide the exact COROS exercise name."
      }
    ],
    allowCustom: true
  }
};
assert.deepEqual(
  parseChatTranscriptJson(JSON.stringify([waitingPromptEntry])),
  [waitingPromptEntry]
);

const oneOffWorkoutEntry = {
  kind: "planDraft",
  draft: {
    draftId: "workout-1",
    artifactType: "workout",
    name: "Full Gym Push Day",
    summary: "Strength · 16 sets · structured",
    entries: [{
      key: "push-day",
      name: "Full Gym Push Day",
      sport: "strength",
      volume: "16 sets",
      scheduleDate: "2026-07-31",
      saveToLibrary: true,
      workoutType: "structured",
      stepsSummary: "warmup 10 min → Chest Press Machine 4 × 8 reps",
      source: {
        key: "push-day",
        name: "Full Gym Push Day",
        sport: "strength",
        save_to_library: true,
        steps: [
          {
            kind: "warmup",
            target_type: "time",
            target_duration_seconds: 600
          },
          {
            kind: "training",
            target_type: "reps",
            target_reps: 8,
            exercise_id: "1338",
            exercise_name: "Chest Press Machine",
            sets: 4,
            rest_type: 1,
            rest_value: 120,
            intensity: { type: "weight", mode: "weight", value: 0, unit: "kg" }
          }
        ]
      }
    }],
    conflicts: [],
    warnings: [],
    uploadedAt: 1234,
    uploadResult: {
      workoutsScheduled: 1,
      workoutsCreated: 0,
      destination: "calendar"
    }
  }
};
assert.equal(
  parseChatTranscriptJson(JSON.stringify([oneOffWorkoutEntry]))[0].draft.artifactType,
  "workout"
);
assert.equal(
  parseChatTranscriptJson(JSON.stringify([oneOffWorkoutEntry]))[0].draft.uploadResult.destination,
  "calendar"
);
const groupedLocalPlanEntry = structuredClone(oneOffWorkoutEntry);
groupedLocalPlanEntry.draft.artifactType = "plan";
groupedLocalPlanEntry.draft.uploadResult.destination = "localPlan";
groupedLocalPlanEntry.draft.uploadResult.localPlanId = "plan:coach:workout-1";
groupedLocalPlanEntry.draft.uploadResult.groupedPlanCreated = true;
assert.equal(
  parseChatTranscriptJson(JSON.stringify([groupedLocalPlanEntry]))[0].draft.uploadResult.destination,
  "localPlan"
);
assert.deepEqual(
  parseChatTranscriptJson(JSON.stringify([oneOffWorkoutEntry]))[0].draft.entries[0].source,
  oneOffWorkoutEntry.draft.entries[0].source
);
const flattenedWorkoutEntry = structuredClone(oneOffWorkoutEntry);
delete flattenedWorkoutEntry.draft.entries[0].source;
const restoredWorkoutEntry = restoreChatPlanDraftSources(
  parseChatTranscriptJson(JSON.stringify([flattenedWorkoutEntry])),
  (draftId) => draftId === oneOffWorkoutEntry.draft.draftId
    ? JSON.stringify(oneOffWorkoutEntry.draft)
    : undefined
)[0];
assert.deepEqual(
  restoredWorkoutEntry.draft.entries[0].source,
  oneOffWorkoutEntry.draft.entries[0].source
);
const legacyPlanEntry = structuredClone(oneOffWorkoutEntry);
delete legacyPlanEntry.draft.artifactType;
assert.equal(
  parseChatTranscriptJson(JSON.stringify([legacyPlanEntry]))[0].draft.artifactType,
  "plan"
);
assert.deepEqual(
  parseChatTranscriptJson(
    JSON.stringify([
      {
        ...waitingPromptEntry,
        prompt: {
          ...waitingPromptEntry.prompt,
          answer: "Use split squats.",
          selectedChoiceId: "choice-1",
          answeredAt: 1234
        }
      }
    ])
  )[0].prompt,
  {
    ...waitingPromptEntry.prompt,
    answer: "Use split squats.",
    selectedChoiceId: "choice-1",
    answeredAt: 1234
  }
);

assert.equal(
  deriveSessionTitleFromEntries([
    { kind: "message", role: "user", content: "How was my long run yesterday?" }
  ]),
  "How was my long run yesterday?"
);

const db = createMemoryDatabase();

const migrated = migrateLegacyTranscriptRow(
  "chatgpt",
  JSON.stringify([{ kind: "message", role: "user", content: "Plan my week" }]),
  "2026-07-01T12:00:00.000Z",
  db
);
assert.equal(migrated.title, "Plan my week");
assert.equal(migrated.messageCount, 1);

const first = createChatSession("chatgpt", db);
assert.equal(first.title, "New chat");
assert.equal(first.messageCount, 0);

const saved = saveChatSession(
  first.id,
  [{ kind: "message", role: "user", content: "Build a 5K plan" }],
  db
);
assert.ok(saved);
assert.equal(saved.title, "Build a 5K plan");
assert.equal(saved.preview, "Build a 5K plan");
assert.equal(saved.messageCount, 1);

assert.deepEqual(getChatSession(first.id, db), [
  { kind: "message", role: "user", content: "Build a 5K plan" }
]);

const second = createChatSession("chatgpt", db);
assert.equal(listChatSessions("chatgpt", db).length, 3);

deleteChatSession(first.id, db);
assert.equal(listChatSessions("chatgpt", db).length, 2);

const local = createChatSession("local", db);
saveChatSession(
  local.id,
  [{ kind: "message", role: "assistant", content: "Easy day tomorrow." }],
  db
);
assert.equal(listChatSessions("local", db).length, 1);
assert.equal(listChatSessions("chatgpt", db).length, 2);

const pinTarget = createChatSession("chatgpt", db);
assert.equal(pinTarget.pinnedAt, null);

const pinned = setChatSessionPinned(pinTarget.id, true, db);
assert.ok(pinned);
assert.ok(pinned.pinnedAt);
assert.equal(
  listChatSessions("chatgpt", db).find((session) => session.id === pinTarget.id)
    .pinnedAt,
  pinned.pinnedAt
);

// Re-pinning keeps the original timestamp so the pinned order stays stable.
assert.equal(setChatSessionPinned(pinTarget.id, true, db).pinnedAt, pinned.pinnedAt);

// Saving a transcript must not clear the pin.
saveChatSession(
  pinTarget.id,
  [{ kind: "message", role: "user", content: "Keep me pinned" }],
  db
);
assert.equal(
  listChatSessions("chatgpt", db).find((session) => session.id === pinTarget.id)
    .pinnedAt,
  pinned.pinnedAt
);

assert.equal(setChatSessionPinned(pinTarget.id, false, db).pinnedAt, null);
assert.equal(setChatSessionPinned("missing-session", true, db), null);

deleteChatSession(pinTarget.id, db);

// Opening a conversation replays its stored transcript back through
// saveChatSession; that must not count as a change and reorder the sidebar.
const replayTarget = createChatSession("chatgpt", db);
saveChatSession(
  replayTarget.id,
  [{ kind: "message", role: "user", content: "Replay me" }],
  db
);
const storedRow = db.getSession(replayTarget.id);
const backdated = "2020-01-01T00:00:00.000Z";
db.updateSession(
  replayTarget.id,
  storedRow.title,
  storedRow.messages_json,
  backdated
);

const replayed = saveChatSession(
  replayTarget.id,
  getChatSession(replayTarget.id, db),
  db
);
assert.equal(replayed.updatedAt, backdated);
assert.equal(replayed.title, storedRow.title);
assert.equal(replayed.messageCount, 1);

// A genuine edit still writes.
const appended = saveChatSession(
  replayTarget.id,
  [
    ...getChatSession(replayTarget.id, db),
    { kind: "message", role: "assistant", content: "Sure thing." }
  ],
  db
);
assert.notEqual(appended.updatedAt, backdated);
assert.equal(appended.messageCount, 2);

deleteChatSession(replayTarget.id, db);

const claude = createChatSession("claude-code", db);
saveChatSession(
  claude.id,
  [{ kind: "message", role: "assistant", content: "Claude CLI response." }],
  db
);
assert.equal(listChatSessions("claude-code", db).length, 1);
assert.equal(listChatSessions("local", db).length, 1);

const openRouter = createChatSession("openrouter", db);
saveChatSession(
  openRouter.id,
  [{ kind: "message", role: "assistant", content: "OpenRouter response." }],
  db
);
assert.equal(listChatSessions("openrouter", db).length, 1);
assert.equal(listChatSessions("chatgpt", db).length, 2);

// --- setChatSessionTitle (coach automations name their own conversations) ---
const named = createChatSession("local", db);
const renamed = setChatSessionTitle(named.id, "  Morning briefing  ", db);
assert.equal(renamed.title, "Morning briefing");
assert.equal(
  renamed.updatedAt,
  named.updatedAt,
  "renaming must not jump the conversation to the top of the sidebar"
);

// An over-long title is truncated the same way a derived one is.
const longTitle = setChatSessionTitle(named.id, "x".repeat(120), db);
assert.equal(longTitle.title.length, 49);
assert.ok(longTitle.title.endsWith("\u2026"));

// A blank rename falls back to the default rather than storing "".
assert.equal(setChatSessionTitle(named.id, "   ", db).title, "New chat");

// Renaming to the stored title is a no-op that still returns the summary.
assert.equal(setChatSessionTitle(named.id, "New chat", db).title, "New chat");
assert.equal(setChatSessionTitle("missing", "Nope", db), null);

// A renamed conversation keeps its name: saveChatSession only derives a title
// while the stored one is still the default, which is exactly what stops an
// automation's conversation being named after its own playbook text.
setChatSessionTitle(named.id, "Daily briefing", db);
const afterPlaybook = saveChatSession(
  named.id,
  [{ kind: "message", role: "user", content: "Summarise yesterday and set today's focus." }],
  db
);
assert.equal(afterPlaybook.title, "Daily briefing");
deleteChatSession(named.id, db);

// --- automation attribution survives a round-trip (section 5.6) ------------
// parseMessageEntry rebuilds entries field by field, so an unlisted field is
// silently dropped on reload. These assertions are the guard on that.
const marker = {
  runId: "run-1",
  automationId: "auto-1",
  bindingId: "bind-1",
  name: "Morning briefing",
  triggerLabel: "Daily at 07:30"
};

const attributed = createChatSession("local", db);
saveChatSession(
  attributed.id,
  [
    // The synthetic user turn carrying the playbook, stored as role "user".
    {
      kind: "message",
      role: "user",
      content: "Summarise yesterday and set today's focus.",
      automation: marker
    },
    {
      kind: "message",
      role: "assistant",
      content: "Easy 40min today.",
      reasoningSummary: "checked yesterday's load",
      automation: marker
    },
    // An interactive turn in the same conversation carries no marker.
    { kind: "message", role: "user", content: "Why easy?" }
  ],
  db
);

const reloaded = getChatSession(attributed.id, db);
assert.equal(reloaded.length, 3);
assert.deepEqual(reloaded[0].automation, marker, "the user turn keeps its marker");
assert.deepEqual(reloaded[1].automation, marker, "the assistant turn keeps its marker");
assert.equal(reloaded[1].reasoningSummary, "checked yesterday's load");
assert.equal(
  "automation" in reloaded[2],
  false,
  "an interactive turn gains no marker"
);
// It survives the JSON the row actually stores, not just the in-memory object.
assert.deepEqual(
  parseChatTranscriptJson(db.getSession(attributed.id).messages_json)[1].automation,
  marker
);
deleteChatSession(attributed.id, db);

// A marker missing any field is dropped rather than half-restored, and the
// message itself still survives.
const partialCases = [
  { ...marker, triggerLabel: undefined },
  { ...marker, name: "   " },
  { ...marker, runId: 42 },
  { runId: "r", automationId: "a" },
  "not-an-object",
  null,
  []
];
for (const automation of partialCases) {
  const parsed = parseChatTranscriptJson(
    JSON.stringify([{ kind: "message", role: "assistant", content: "hi", automation }])
  );
  assert.equal(parsed.length, 1, `message dropped for ${JSON.stringify(automation)}`);
  assert.equal(
    parsed[0].automation,
    undefined,
    `partial marker kept for ${JSON.stringify(automation)}`
  );
}

// An extra field on the marker is not carried through.
const extraFields = parseChatTranscriptJson(
  JSON.stringify([
    {
      kind: "message",
      role: "assistant",
      content: "hi",
      automation: { ...marker, sessionId: "leaked" }
    }
  ])
);
assert.deepEqual(extraFields[0].automation, marker);

console.log("chat history store tests passed");
