import { BrowserWindow } from "electron";
import {
  cancelChat,
  createCollectorSink,
  getChatAuthStatus,
  getChatSettings,
  streamChat
} from "./chatService";
import type { ChatStreamCollectorSink, ChatStreamSink } from "./chatService";
import {
  chatSessionExists,
  createChatSession,
  getChatSession,
  saveChatSession,
  setChatSessionTitle
} from "./chatHistoryStore";
import {
  getCoachAutomation,
  getCoachAutomationBinding,
  listCoachAutomationBindings,
  listCoachAutomationRuns,
  recordCoachAutomationRun,
  setCoachAutomationBindingEnabled,
  setCoachAutomationBindingSchedule,
  setCoachAutomationBindingSession,
  updateCoachAutomationRun
} from "./coachAutomationStore";
import { listCoachActivityRowsAfter } from "./database";
import type { CoachUnseenActivityRow as CoachActivityRow } from "./database";
import { getTrainingHubStatus, reconnectTrainingHub } from "./trainingHubService";
import { corosSportName } from "./corosSportTypes";
import { AUTOMATION_DEFAULT_EFFORT, NOTHING_TO_REPORT } from "./types";
import type {
  AnthropicEffort,
  AutomationRuntime,
  AutomationTriggerKind,
  ChatEntryAutomationMarker,
  ChatMessage,
  ChatProvider,
  CoachAutomation,
  CoachAutomationBinding,
  CoachAutomationRun,
  CoachAutomationRunQuery,
  PersistedChatEntry
} from "./types";

// ---------------------------------------------------------------------------
// Output contract (5.5)
// ---------------------------------------------------------------------------

const SUMMARY_MAX = 140;

/**
 * Appended to every playbook by the runner, not editable per automation.
 *
 * It asks for the two things the app cannot work without — an opening sentence
 * to put in the run log, and a way to say "nothing happened" — and nothing
 * else. An earlier version also dictated "up to 3 observations" and "at most 1
 * recommended action"; that is editorial taste, not machinery, and it quietly
 * overruled the athlete's own playbook, because it came last in the prompt. A
 * playbook asking for a week-by-week table could not get one.
 *
 * Rule 2 gives the reason rather than a list of prohibitions. A model told what
 * a line is *for* places it correctly in cases nobody enumerated; a model given
 * "no heading, no bullet, no table" only learns about the three cases someone
 * thought of.
 */
export const AUTOMATION_OUTPUT_CONTRACT = [
  "---",
  "Two house rules from the app. They sit on top of the playbook above and do",
  "not replace it — the playbook decides what to look at, how long to be, and",
  "how the answer is laid out.",
  "",
  `1. If nothing is materially different from recent history, reply with exactly ${NOTHING_TO_REPORT} and nothing else.`,
  `2. Otherwise make the very first line one plain sentence saying what you found, under ${SUMMARY_MAX} characters. The app shows that line on its own, away from the rest of the answer, so it has to make sense with no context around it. Everything after that line belongs to the playbook — length, structure, tables, whatever it asked for.`
].join("\n");

export { NOTHING_TO_REPORT };

export interface AutomationOutput {
  /** The model found nothing worth reporting; the run is logged, not shown. */
  silent: boolean;
  /** The headline, for the badge and (phase 2) the notification body. */
  summary?: string;
}

/** Markup trimmed off both ends, so a run-log row is not full of asterisks. */
function trimMarkup(line: string): string {
  return line.replace(/^[\s>#*_`+-]+/, "").replace(/[\s*_`]+$/, "");
}

export function parseAutomationOutput(text: string): AutomationOutput {
  const trimmed = (text ?? "").trim();
  if (!trimmed) {
    return { silent: true };
  }
  // Accept the marker on its own line anywhere in the answer: models routinely
  // wrap it in a sentence of preamble, and treating that as a real finding
  // would badge the athlete with an empty report.
  const lines = trimmed.split(/\r?\n/).map((line) => line.trim());
  // Strip wrapper punctuation from the ends only — the marker's own
  // underscores must survive.
  const unwrap = (line: string): string =>
    line.replace(/^[*_`\s>-]+/, "").replace(/[*_`\s.]+$/, "");
  if (lines.some((line) => unwrap(line) === NOTHING_TO_REPORT)) {
    return { silent: true };
  }

  // Rule 2 puts the summary on the first line and says what it is for, so the
  // first line is simply read. The one guard is general rather than a list of
  // markdown constructs to skip: a line with no letters in it is not a
  // sentence, whatever syntax produced it.
  const line = lines.find((candidate) => /\p{L}/u.test(candidate)) ?? lines[0];
  return { silent: false, summary: trimMarkup(line).slice(0, SUMMARY_MAX) };
}

// ---------------------------------------------------------------------------
// Model and effort (section 7)
// ---------------------------------------------------------------------------

// Re-exported so callers that already talk to the runner do not need a second
// import for the one constant behind its decision.
export { AUTOMATION_DEFAULT_EFFORT };

/** The runtime a run actually uses, with section 7's default filled in. */
export function resolveAutomationRuntime(
  automation: CoachAutomation
): AutomationRuntime {
  return automation.runtime.effort
    ? automation.runtime
    : { ...automation.runtime, effort: AUTOMATION_DEFAULT_EFFORT };
}

// ---------------------------------------------------------------------------
// Template rendering (2.5)
// ---------------------------------------------------------------------------

export interface AutomationTemplateVars {
  rule?: { name?: string };
  date?: string;
  activity?: { name?: string; sport?: string };
  week?: { range?: string };
}

/** Renders `{{rule.name}}`-style variables; unknown ones collapse to "". */
export function renderAutomationTemplate(
  template: string,
  vars: AutomationTemplateVars
): string {
  const lookup: Record<string, string | undefined> = {
    "rule.name": vars.rule?.name,
    date: vars.date,
    "activity.name": vars.activity?.name,
    "activity.sport": vars.activity?.sport,
    "week.range": vars.week?.range
  };
  return template
    .replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_match, key: string) => lookup[key] ?? "")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

function isoDate(now: Date): string {
  return now.toISOString().slice(0, 10);
}

function weekRange(now: Date): string {
  const start = new Date(now);
  start.setDate(start.getDate() - start.getDay());
  const end = new Date(start);
  end.setDate(end.getDate() + 6);
  return `${isoDate(start)}..${isoDate(end)}`;
}

function triggerLabel(automation: CoachAutomation): string {
  const trigger = automation.trigger;
  if (trigger.kind === "schedule") {
    return trigger.cadence === "weekly"
      ? `Weekly at ${trigger.timeOfDay}`
      : `Daily at ${trigger.timeOfDay}`;
  }
  if (trigger.kind === "activity") {
    if (!trigger.sportTypes.length) return "After any activity";
    const names = trigger.sportTypes.map((type) => corosSportName(type) ?? `sport ${type}`);
    return `After ${names.join(", ")}`;
  }
  if (trigger.kind === "threshold") {
    return `When ${trigger.metric} crosses ${trigger.value}`;
  }
  return "Manual";
}

// ---------------------------------------------------------------------------
// Which activities a binding still owes an opinion on
// ---------------------------------------------------------------------------

/**
 * How far back one trigger will scan for candidates. Sport/duration/distance
 * filtering happens after the scan, so this has to be comfortably wider than
 * the fan-out cap or a rule that only fires on runs would lose a run buried
 * under a week of swims.
 */
const ACTIVITY_SCAN_LIMIT = 200;

/**
 * Ceiling on one catch-up sequence. A backlog longer than this analyses only
 * its most recent entries: replaying a month of history in one burst costs
 * real provider spend and buries the answer the athlete actually wanted.
 */
const MULTI_ACTIVITY_MAX_PER_TRIGGER = 10;

/**
 * 3.2 step 3: an activity automation fires only for the sports it names, and
 * only above its duration/distance floors. An empty `sportTypes` means every
 * sport.
 */
export function activityMatchesAutomation(
  activity: CoachActivityRow,
  automation: CoachAutomation
): boolean {
  const trigger = automation.trigger;
  if (trigger.kind !== "activity") {
    return false;
  }
  if (trigger.sportTypes.length && !trigger.sportTypes.includes(activity.sport_type)) {
    return false;
  }
  if (
    trigger.minDurationSec !== undefined &&
    (activity.duration ?? 0) < trigger.minDurationSec
  ) {
    return false;
  }
  if (
    trigger.minDistanceM !== undefined &&
    (activity.distance ?? 0) < trigger.minDistanceM
  ) {
    return false;
  }
  return true;
}

/** The attach moment, in the epoch seconds `start_time` is stored in. */
function attachEpochSeconds(binding: CoachAutomationBinding): number {
  const parsed = Date.parse(binding.createdAt);
  return Number.isFinite(parsed) ? Math.floor(parsed / 1000) : 0;
}

/**
 * What an activity-driven binding should analyse on this trigger, oldest
 * first.
 *
 * The watermark is per binding, not per automation: two conversations attached
 * a week apart legitimately owe answers on different activities, and the
 * automation-wide `coach_seen_at` stamp only decides *when* the watcher fires.
 *
 * - Never analysed anything → the attach time is the floor, so attaching a
 *   coach today does not replay the athlete's back catalogue.
 * - "Run now" on a binding that never analysed anything → the newest matching
 *   activity, ignoring that floor. The athlete asked for an answer now, and a
 *   coach attached five minutes ago would otherwise have nothing to say.
 * - `multiActivity` off → only the newest match, however many piled up.
 */
function selectActivitiesForBinding(
  automation: CoachAutomation,
  binding: CoachAutomationBinding,
  event: AutomationTriggerEvent,
  deps: CoachAutomationRunnerDeps
): CoachActivityRow[] {
  const trigger = automation.trigger;
  if (trigger.kind !== "activity") {
    return [];
  }

  const manualFirstRun =
    event.kind === "manual" && binding.lastActivityAt === undefined;
  const floor = manualFirstRun
    ? undefined
    : binding.lastActivityAt ?? attachEpochSeconds(binding);

  const matched = deps
    .listActivitiesAfter(floor, ACTIVITY_SCAN_LIMIT)
    .filter((activity) => activityMatchesAutomation(activity, automation));
  if (!matched.length) {
    return [];
  }
  if (!trigger.multiActivity || manualFirstRun) {
    return [matched[matched.length - 1]];
  }
  return matched.slice(-MULTI_ACTIVITY_MAX_PER_TRIGGER);
}

// ---------------------------------------------------------------------------
// Guard rails (4)
// ---------------------------------------------------------------------------

export type AutomationSkipReason =
  | "disabled"
  | "missing-session"
  | "no-auth"
  | "offline"
  | "two-factor-required"
  | "quiet-hours"
  | "cooldown"
  | "budget"
  | "burst"
  | "batch-window"
  /** Activity-driven, but nothing new to analyse since this binding's watermark. */
  | "no-activity"
  /** Schedule-driven: the slot came due more than a day ago (3.1). */
  | "stale-slot";

/** 2.3: at most this many automation messages land in one conversation per hour. */
export const SESSION_BURST_PER_HOUR = 5;

function minutesToMs(minutes: number): number {
  return minutes * 60_000;
}

function localMinutes(value: Date): number {
  return value.getHours() * 60 + value.getMinutes();
}

/**
 * Local wall-clock "HH:mm" as minutes since midnight, or null if malformed.
 * Exported for the scheduler, which reads the same two shapes of time — a
 * trigger's `timeOfDay` and a quiet window's edges.
 */
export function parseTimeOfDay(value: string): number | null {
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(value);
  return match ? Number(match[1]) * 60 + Number(match[2]) : null;
}

/** Quiet hours may wrap midnight, so "22:00".."06:30" is one window. */
export function isWithinQuietHours(
  now: Date,
  quietHours?: { start: string; end: string }
): boolean {
  if (!quietHours) return false;
  const start = parseTimeOfDay(quietHours.start);
  const end = parseTimeOfDay(quietHours.end);
  if (start === null || end === null || start === end) return false;
  const minute = localMinutes(now);
  return start < end
    ? minute >= start && minute < end
    : minute >= start || minute < end;
}

function startOfLocalDay(now: Date): Date {
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  return start;
}

// ---------------------------------------------------------------------------
// Injectable dependencies
// ---------------------------------------------------------------------------

export interface CoachAutomationRunnerDeps {
  now(): Date;
  getAutomation(id: string): CoachAutomation | null;
  listBindings(automationId: string): CoachAutomationBinding[];
  /** Re-read at run time: a queued binding's snapshot goes stale behind it. */
  getBinding(id: string): CoachAutomationBinding | null;
  setBindingSchedule(
    bindingId: string,
    schedule: {
      lastRunAt?: string | null;
      nextRunAt?: string | null;
      lastActivityAt?: number | null;
    }
  ): void;
  setBindingSession(bindingId: string, sessionId: string): void;
  setBindingEnabled(bindingId: string, enabled: boolean): void;
  listRuns(filter: CoachAutomationRunQuery): CoachAutomationRun[];
  /** Activities newer than a binding's watermark, oldest first. */
  listActivitiesAfter(
    afterEpochSeconds: number | undefined,
    limit: number
  ): CoachActivityRow[];
  recordRun(input: Omit<CoachAutomationRun, "id" | "startedAt">): CoachAutomationRun;
  updateRun(
    id: string,
    patch: Partial<Omit<CoachAutomationRun, "id" | "automationId" | "bindingId">>
  ): CoachAutomationRun | null;
  /** Undefined when the conversation no longer exists (2.4). */
  getSessionEntries(sessionId: string): PersistedChatEntry[] | undefined;
  createSession(provider: ChatProvider): string;
  saveSession(sessionId: string, entries: PersistedChatEntry[]): void;
  setSessionTitle(sessionId: string, title: string): void;
  getChatProvider(): ChatProvider;
  isProviderAuthenticated(provider: ChatProvider): boolean;
  ensureCorosSession(): Promise<
    { ok: true } | { ok: false; twoFactorRequired: boolean }
  >;
  createCollector(marker: ChatEntryAutomationMarker): ChatStreamCollectorSink;
  streamChat(
    sink: ChatStreamSink,
    runId: string,
    messages: ChatMessage[],
    options: {
      runtime?: CoachAutomation["runtime"];
      toolPolicy: "read-only";
      roleInstructions?: string;
    }
  ): Promise<void>;
  emitRunUpdate(run: CoachAutomationRun): void;
  /** Aborts an in-flight stream by run id; the same seam "Cancel" uses. */
  cancelRun(runId: string): void;
  /** How long a run may emit nothing before it is given up on. */
  idleTimeoutMs: number;
}

/**
 * A run update from outside the runner. The scheduler's `stale-slot` skips
 * never reach `runOneBinding`, so they need their own way onto the wire.
 */
export function emitAutomationRunUpdate(run: CoachAutomationRun): void {
  emitToAnyWindow("coachAutomation:runUpdate", run);
}

/**
 * Emits to whatever window exists *at emit time*. A run may start, continue or
 * finish with no window at all, so a reference is never captured up front.
 */
function emitToAnyWindow(channel: string, payload: unknown): void {
  const target = BrowserWindow.getAllWindows().find(
    (window) => !window.isDestroyed()
  );
  target?.webContents.send(channel, payload);
}

function createDefaultDeps(): CoachAutomationRunnerDeps {
  return {
    now: () => new Date(),
    getAutomation: (id) => getCoachAutomation(id),
    listBindings: (automationId) => listCoachAutomationBindings(automationId),
    getBinding: (id) => getCoachAutomationBinding(id),
    setBindingSchedule: (bindingId, schedule) => {
      setCoachAutomationBindingSchedule(bindingId, schedule);
    },
    setBindingSession: (bindingId, sessionId) => {
      setCoachAutomationBindingSession(bindingId, sessionId);
    },
    setBindingEnabled: (bindingId, enabled) => {
      setCoachAutomationBindingEnabled(bindingId, enabled);
    },
    listRuns: (filter) => listCoachAutomationRuns(filter),
    listActivitiesAfter: (after, limit) => listCoachActivityRowsAfter(after, limit),
    recordRun: (input) => recordCoachAutomationRun(input),
    updateRun: (id, patch) => updateCoachAutomationRun(id, patch),
    getSessionEntries: (sessionId) => {
      // getChatSession returns [] both for "empty" and "gone", so an empty
      // transcript is confirmed against the session list instead.
      if (!chatSessionExists(sessionId)) return undefined;
      return getChatSession(sessionId);
    },
    createSession: (provider) => createChatSession(provider).id,
    saveSession: (sessionId, entries) => {
      saveChatSession(sessionId, entries);
    },
    setSessionTitle: (sessionId, title) => {
      setChatSessionTitle(sessionId, title);
    },
    getChatProvider: () => getChatSettings().provider,
    isProviderAuthenticated: (provider) =>
      // Only ChatGPT's sign-in is inspectable from here; the other providers
      // report their auth state through the stream, which the runner maps to a
      // "no-auth" skip when it comes back flagged.
      provider === "chatgpt" ? getChatAuthStatus().signedIn : true,
    ensureCorosSession: async () => {
      if (getTrainingHubStatus().authenticated) {
        return { ok: true };
      }
      try {
        const result = await reconnectTrainingHub();
        if (result.twoFactorRequired) {
          return { ok: false, twoFactorRequired: true };
        }
        return result.status.authenticated
          ? { ok: true }
          : { ok: false, twoFactorRequired: false };
      } catch {
        return { ok: false, twoFactorRequired: false };
      }
    },
    createCollector: (marker) => createCollectorSink(marker),
    streamChat: (sink, runId, messages, options) =>
      streamChat(sink, runId, messages, options),
    emitRunUpdate: (run) => emitAutomationRunUpdate(run),
    cancelRun: (runId) => cancelChat(runId),
    idleTimeoutMs: AUTOMATION_IDLE_TIMEOUT_MS
  };
}

let defaultDeps: CoachAutomationRunnerDeps | null = null;
function resolveDeps(
  deps?: Partial<CoachAutomationRunnerDeps>
): CoachAutomationRunnerDeps {
  defaultDeps ??= createDefaultDeps();
  return deps ? { ...defaultDeps, ...deps } : defaultDeps;
}

// ---------------------------------------------------------------------------
// Trigger expansion and the run queue
// ---------------------------------------------------------------------------

export interface AutomationTriggerEvent {
  automationId: string;
  kind: AutomationTriggerKind;
  payload?: Record<string, unknown>;
  /** Restricts the fan-out; defaults to every enabled binding. */
  bindingIds?: string[];
  /**
   * 3.4: a manual run bypasses cooldown, quiet hours and the daily cap, so the
   * athlete can build confidence in a rule before enabling it.
   */
  bypassGuards?: boolean;
}

interface QueuedRun {
  binding: CoachAutomationBinding;
  automation: CoachAutomation;
  event: AutomationTriggerEvent;
  /** The single activity this run analyses; absent for non-activity triggers. */
  activity?: CoachActivityRow;
  /** Position in a multi-activity catch-up sequence; 0 is the first run. */
  sequenceIndex: number;
}

/**
 * 2.3: one trigger produces one run per enabled binding, not one run broadcast
 * to many conversations — each conversation carries different history, so the
 * answers legitimately differ. Ordering by session then `sort_order` keeps
 * same-conversation runs serialized and in the order the athlete chose.
 */
export function expandTriggerToQueue(
  event: AutomationTriggerEvent,
  deps?: Partial<CoachAutomationRunnerDeps>
): QueuedRun[] {
  const resolved = resolveDeps(deps);
  const automation = resolved.getAutomation(event.automationId);
  if (!automation || (!automation.enabled && !event.bypassGuards)) {
    return [];
  }

  const wanted = event.bindingIds ? new Set(event.bindingIds) : null;
  return resolved
    .listBindings(automation.id)
    .filter((binding) => binding.enabled || event.bypassGuards)
    .filter((binding) => !wanted || wanted.has(binding.id))
    .sort(
      (left, right) =>
        (left.sessionId ?? "").localeCompare(right.sessionId ?? "") ||
        left.sortOrder - right.sortOrder
    )
    .map((binding) => ({ binding, automation, event, sequenceIndex: 0 }));
}

// One run at a time process-wide (5.4). The provider is the bottleneck anyway,
// and it makes the same-conversation serialization requirement automatic.
let queueTail: Promise<unknown> = Promise.resolve();

function enqueue<T>(task: () => Promise<T>): Promise<T> {
  const result = queueTail.then(task, task);
  queueTail = result.catch(() => undefined);
  return result;
}

// ---------------------------------------------------------------------------
// Running one binding
// ---------------------------------------------------------------------------

function skip(
  queued: QueuedRun,
  reason: AutomationSkipReason,
  deps: CoachAutomationRunnerDeps,
  sessionId?: string
): CoachAutomationRun {
  const startedAt = deps.now().toISOString();
  const run = deps.recordRun({
    automationId: queued.automation.id,
    bindingId: queued.binding.id,
    status: "skipped",
    triggerKind: queued.event.kind,
    skipReason: reason,
    finishedAt: startedAt,
    ...(queued.event.payload ? { triggerPayload: queued.event.payload } : {}),
    ...(sessionId ? { sessionId } : {})
  });
  deps.emitRunUpdate(run);
  return run;
}

/** Guard rails 5-8, in the order section 4 fixes. */
function checkRateGuards(
  queued: QueuedRun,
  sessionId: string | null,
  deps: CoachAutomationRunnerDeps
): AutomationSkipReason | null {
  const { automation, binding, event } = queued;
  const now = deps.now();

  if (event.bypassGuards) {
    return null;
  }

  if (isWithinQuietHours(now, automation.conditions.quietHours)) {
    return "quiet-hours";
  }

  // The cooldown governs how often a binding may *react*, not how fast it may
  // work through the backlog that one reaction uncovered — so it is checked
  // once, on the first run of a multi-activity catch-up sequence.
  if (binding.lastRunAt && queued.sequenceIndex === 0) {
    const elapsed = now.getTime() - new Date(binding.lastRunAt).getTime();
    if (elapsed < minutesToMs(automation.conditions.cooldownMin)) {
      return "cooldown";
    }
  }

  const today = deps.listRuns({
    bindingId: binding.id,
    since: startOfLocalDay(now).toISOString(),
    statuses: ["success", "silent", "failed"]
  });
  if (today.length >= automation.conditions.maxRunsPerDay) {
    return "budget";
  }

  if (sessionId) {
    const lastHour = deps.listRuns({
      sessionId,
      since: new Date(now.getTime() - 3_600_000).toISOString(),
      statuses: ["success"]
    });
    if (lastHour.length >= SESSION_BURST_PER_HOUR) {
      return "burst";
    }
  }

  return null;
}

/**
 * Where a run will write, resolved in two halves. Only the *check* happens at
 * guard rail 2; the conversation itself is created after every guard has
 * passed, because a `per-run` binding that creates its conversation up front
 * would leave an empty thread behind on every cooldown, quiet-hour or offline
 * skip — and the activity watcher polls every 15 minutes.
 */
type SessionTarget =
  | { kind: "existing"; sessionId: string; entries: PersistedChatEntry[] }
  /** A conversation this binding still has to create. */
  | { kind: "create" };

/**
 * Guard rail 2 / 2.4. A `dedicated` binding rebuilds its conversation when the
 * athlete deleted it; an `existing` one is disabled instead, because only the
 * athlete knows which thread it should point at now.
 */
function checkSessionTarget(
  queued: QueuedRun,
  deps: CoachAutomationRunnerDeps
): { ok: true; target: SessionTarget } | { ok: false; reason: AutomationSkipReason } {
  const { binding } = queued;

  if (binding.mode === "per-run") {
    return { ok: true, target: { kind: "create" } };
  }

  const entries = binding.sessionId
    ? deps.getSessionEntries(binding.sessionId)
    : undefined;
  if (entries) {
    return {
      ok: true,
      target: { kind: "existing", sessionId: binding.sessionId as string, entries }
    };
  }

  if (binding.mode === "dedicated") {
    return { ok: true, target: { kind: "create" } };
  }

  deps.setBindingEnabled(binding.id, false);
  return { ok: false, reason: "missing-session" };
}

/** Creates and names the conversation a "create" target asked for. */
function createTargetSession(
  queued: QueuedRun,
  deps: CoachAutomationRunnerDeps
): string {
  const { automation, binding } = queued;
  const provider = automation.runtime.provider ?? deps.getChatProvider();
  const sessionId = deps.createSession(provider);

  if (binding.mode === "per-run") {
    const vars = templateVars(queued, deps);
    const title = binding.titleTemplate
      ? renderAutomationTemplate(binding.titleTemplate, vars)
      : `${automation.name} · ${vars.date}`;
    if (title) {
      deps.setSessionTitle(sessionId, title);
    }
    return sessionId;
  }

  // A dedicated binding owns its conversation, so it adopts the rebuilt one.
  deps.setSessionTitle(sessionId, automation.name);
  deps.setBindingSession(binding.id, sessionId);
  return sessionId;
}

function asText(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function toWireMessages(entries: PersistedChatEntry[]): ChatMessage[] {
  return entries.flatMap((entry) =>
    entry.kind === "message" && entry.content.trim()
      ? [{ role: entry.role, content: entry.content }]
      : []
  );
}

/** The 2.5 variables, resolved once from the run's own trigger payload. */
function templateVars(
  queued: QueuedRun,
  deps: CoachAutomationRunnerDeps
): AutomationTemplateVars {
  const now = deps.now();
  return {
    rule: { name: queued.automation.name },
    date: isoDate(now),
    week: { range: weekRange(now) },
    activity: {
      name: asText(queued.event.payload?.activityName),
      sport: asText(queued.event.payload?.activitySport)
    }
  };
}

/** "Long run · Run · 2026-08-21", for the run's focus line. */
function describeActivity(activity: CoachActivityRow): string {
  const parts: string[] = [asText(activity.name) ?? "Untitled activity"];
  const sport = asText(activity.sport_name);
  if (sport) {
    parts.push(sport);
  }
  if (activity.start_time) {
    parts.push(new Date(activity.start_time * 1000).toISOString().slice(0, 10));
  }
  return parts.join(" · ");
}

function buildPlaybookTurn(
  queued: QueuedRun,
  deps: CoachAutomationRunnerDeps
): string {
  const body = renderAutomationTemplate(
    queued.automation.playbook,
    templateVars(queued, deps)
  );
  // A catch-up sequence sends the same playbook once per activity, so each run
  // has to name its own subject or the three answers would be interchangeable.
  const focus = queued.activity
    ? `\n\nAnalyse this activity specifically: ${describeActivity(queued.activity)}` +
      ` (activity id ${queued.activity.activity_id}).`
    : "";
  return `${body}${focus}\n\n${AUTOMATION_OUTPUT_CONTRACT}`;
}

/**
 * A run is bounded by silence rather than by wall clock. A playbook that walks
 * a month of activities through several tool rounds is legitimately slow; a
 * provider that has stopped answering emits nothing at all, and the tee sink
 * sees every token, tool call and status line, so it is the one place that can
 * tell the two apart.
 *
 * The bound matters beyond the run that trips it. Runs are serialised
 * process-wide (5.4), so a `streamChat` that never settles wedges every later
 * run and every later "Run now" for the life of the process — the athlete sees
 * a button that spins with nothing behind it. Neither the MCP connect nor the
 * provider fetch on this path carries a deadline of its own, so the runner
 * keeps one.
 */
export const AUTOMATION_IDLE_TIMEOUT_MS = 3 * 60_000;

interface IdleWatchdog {
  /** Resolves — never rejects — once nothing has been emitted for the window. */
  readonly expired: Promise<void>;
  /** Called for every stream event: the run is alive, start the clock over. */
  touch(): void;
  stop(): void;
}

function createIdleWatchdog(timeoutMs: number): IdleWatchdog {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let fire: () => void = () => undefined;
  const expired = new Promise<void>((resolve) => {
    fire = resolve;
  });
  const arm = () => {
    clearTimeout(timer);
    timer = setTimeout(fire, timeoutMs);
  };
  arm();
  return {
    expired,
    touch: arm,
    stop: () => clearTimeout(timer)
  };
}

async function runOneBinding(
  queued: QueuedRun,
  deps?: Partial<CoachAutomationRunnerDeps>
): Promise<CoachAutomationRun> {
  const resolved = resolveDeps(deps);
  const { automation, event } = queued;

  // The binding was snapshotted when the trigger fanned out, and a catch-up
  // sequence writes to it between runs (its clock, its activity watermark), so
  // every guard below has to read the row as it stands now.
  const binding = resolved.getBinding(queued.binding.id) ?? queued.binding;
  const step: QueuedRun = { ...queued, binding };

  // 1. Both switches still on — they may have flipped between queue and run.
  const current = resolved.getAutomation(automation.id);
  if (!event.bypassGuards && (!current?.enabled || !binding.enabled)) {
    return skip(step, "disabled", resolved);
  }

  // 2. Target conversation resolvable — checked now, created below.
  const checked = checkSessionTarget(step, resolved);
  if (!checked.ok) {
    return skip(step, checked.reason, resolved);
  }
  const knownSessionId =
    checked.target.kind === "existing" ? checked.target.sessionId : undefined;

  // 2b. This activity is still owed. Two triggers can fan out from the same
  // watermark before either runs — a poll and a "Run now" seconds apart — and
  // the plan is built outside the run queue. The binding was re-read above, so
  // the check costs nothing and stops the same activity being analysed twice
  // into the same conversation.
  if (
    step.activity?.start_time != null &&
    binding.lastActivityAt !== undefined &&
    step.activity.start_time <= binding.lastActivityAt
  ) {
    return skip(step, "no-activity", resolved, knownSessionId);
  }

  // 3. Chat provider authenticated.
  const provider = automation.runtime.provider ?? resolved.getChatProvider();
  if (!resolved.isProviderAuthenticated(provider)) {
    return skip(step, "no-auth", resolved, knownSessionId);
  }

  // 4. COROS session usable.
  const coros = await resolved.ensureCorosSession();
  if (!coros.ok) {
    return skip(
      step,
      coros.twoFactorRequired ? "two-factor-required" : "offline",
      resolved,
      knownSessionId
    );
  }

  // 5-8. Rate guards. A conversation that does not exist yet cannot be busy,
  // so the burst guard only applies to one the binding already writes into.
  const rateSkip = checkRateGuards(step, knownSessionId ?? null, resolved);
  if (rateSkip) {
    return skip(step, rateSkip, resolved, knownSessionId);
  }

  // Every guard passed: only now is it worth putting a conversation on disk.
  const session =
    checked.target.kind === "existing"
      ? checked.target
      : {
          kind: "existing" as const,
          sessionId: createTargetSession(step, resolved),
          entries: [] as PersistedChatEntry[]
        };

  // Section 7's default is resolved once, here, so the run log records what the
  // run actually used rather than what the definition happened to leave blank.
  const runtime = resolveAutomationRuntime(automation);
  const startedAt = resolved.now().toISOString();
  let run = resolved.recordRun({
    automationId: automation.id,
    bindingId: binding.id,
    status: "running",
    triggerKind: event.kind,
    sessionId: session.sessionId,
    ...(runtime.model ? { model: runtime.model } : {}),
    ...(runtime.effort ? { effort: runtime.effort } : {}),
    ...(event.payload ? { triggerPayload: event.payload } : {}),
    startedAt
  } as Omit<CoachAutomationRun, "id" | "startedAt">);
  resolved.emitRunUpdate(run);

  const marker: ChatEntryAutomationMarker = {
    runId: run.id,
    automationId: automation.id,
    bindingId: binding.id,
    name: automation.name,
    triggerLabel: triggerLabel(automation)
  };

  const playbook = buildPlaybookTurn(step, resolved);
  const collector = resolved.createCollector(marker);
  const watchdog = createIdleWatchdog(resolved.idleTimeoutMs);
  const sink = createTeeSink(collector, watchdog.touch);

  const finish = (
    patch: Partial<Omit<CoachAutomationRun, "id" | "automationId" | "bindingId">>
  ): CoachAutomationRun => {
    const finished =
      resolved.updateRun(run.id, {
        ...patch,
        finishedAt: resolved.now().toISOString()
      }) ?? run;
    resolved.emitRunUpdate(finished);
    return finished;
  };

  let timedOut = false;
  try {
    const streaming = resolved.streamChat(
      sink,
      run.id,
      [...toWireMessages(session.entries), { role: "user", content: playbook }],
      {
        runtime,
        toolPolicy: "read-only",
        ...(automation.role ? { roleInstructions: automation.role } : {})
      }
    );
    // Nothing awaits the stream once the watchdog has won the race, so a
    // rejection arriving after that would be an unhandled one. Attaching a
    // handler here does not consume it: the race still sees the rejection.
    streaming.catch(() => undefined);
    await Promise.race([
      streaming,
      watchdog.expired.then(() => {
        timedOut = true;
      })
    ]);
  } catch (error) {
    return finish({
      status: "failed",
      error: error instanceof Error ? error.message : "Automation run failed."
    });
  } finally {
    watchdog.stop();
  }

  if (timedOut) {
    // Abort what can be aborted, and stop waiting on what cannot: a stall
    // inside a call that never looks at the signal would otherwise hold the
    // run queue behind it. The stream is left to settle in its own time.
    resolved.cancelRun(run.id);
    return finish({
      status: "failed",
      error: `The provider stopped responding — nothing arrived for ${Math.max(
        1,
        Math.round(resolved.idleTimeoutMs / 60_000)
      )} minutes.`
    });
  }

  // The binding's own clock advances for every attempt that reached the
  // provider, so a failing automation still respects its cooldown.
  resolved.setBindingSchedule(binding.id, {
    lastRunAt: resolved.now().toISOString()
  });

  if (collector.error()) {
    return finish(
      collector.authError()
        ? { status: "skipped", skipReason: "no-auth", error: collector.error() }
        : { status: "failed", error: collector.error() }
    );
  }
  if (collector.cancelled()) {
    return finish({ status: "cancelled" });
  }

  // The binding's watermark moves only once the model has actually looked at
  // the activity. A failed or cancelled run leaves it where it was, so the
  // activity comes back with the next trigger instead of being lost.
  const advanceWatermark = (): void => {
    if (step.activity?.start_time) {
      resolved.setBindingSchedule(binding.id, {
        lastActivityAt: step.activity.start_time
      });
    }
  };

  // The model looked at the activity, whatever it concluded. Failed and
  // cancelled runs returned above and leave the watermark where it was.
  advanceWatermark();

  // Re-read rather than reuse the snapshot taken before the stream: a run takes
  // as long as the provider does, and the athlete may well have said something
  // in that conversation meanwhile. Appending to the stale copy would delete
  // their turn.
  const readBack = (): PersistedChatEntry[] =>
    resolved.getSessionEntries(session.sessionId) ?? session.entries;

  const output = parseAutomationOutput(collector.text());
  if (output.silent) {
    // The answer itself is a control token the athlete must never read, so
    // nothing the model wrote is persisted. What lands instead is a one-line
    // trace saying the coach looked (5.5): a conversation that keeps no record
    // of a run reads as a broken automation rather than as a considered "no".
    resolved.saveSession(session.sessionId, [
      ...readBack(),
      {
        kind: "automationSilent",
        automation: marker,
        at: resolved.now().getTime()
      }
    ]);
    return finish({ status: "silent" });
  }

  const produced = collector.entries().map((entry) =>
    entry.kind === "message" ? { ...entry, automation: marker } : entry
  );
  const existing = readBack();
  // 5.6: the synthetic user turn carries the playbook and the same marker, so
  // the UI can render it as a chip rather than an athlete bubble.
  resolved.saveSession(session.sessionId, [
    ...existing,
    { kind: "message", role: "user", content: playbook, automation: marker },
    ...produced
  ]);

  return finish({
    status: "success",
    ...(output.summary ? { summary: output.summary } : {})
  });
}

/**
 * The tee sink of 5.2: the collector always, plus the window when one exists,
 * so an open Coach view streams live while persistence happens in main either
 * way. It never wires `bindAbort` — closing the window must not abort a run.
 * Every event also counts as a sign of life for the run's idle watchdog.
 */
function createTeeSink(
  collector: ChatStreamCollectorSink,
  onActivity: () => void
): ChatStreamSink {
  return {
    emit(channel, payload) {
      onActivity();
      collector.emit(channel, payload);
      emitToAnyWindow(channel, payload);
    }
  };
}

// ---------------------------------------------------------------------------
// Public entry points
// ---------------------------------------------------------------------------

/**
 * One binding's share of a trigger, expanded into the runs it actually owes.
 * A non-activity trigger is a single run, unchanged; an activity trigger turns
 * into one run per pending activity, oldest first, each naming its own subject.
 */
function planBindingRuns(
  queued: QueuedRun,
  deps: CoachAutomationRunnerDeps
): QueuedRun[] {
  if (queued.automation.trigger.kind !== "activity") {
    return [queued];
  }
  return selectActivitiesForBinding(
    queued.automation,
    queued.binding,
    queued.event,
    deps
  ).map((activity, index) => ({
    ...queued,
    activity,
    sequenceIndex: index,
    event: {
      ...queued.event,
      payload: {
        ...queued.event.payload,
        activityIds: [activity.activity_id],
        activityCount: 1,
        ...(activity.name ? { activityName: activity.name } : {}),
        ...(activity.sport_name ? { activitySport: activity.sport_name } : {}),
        ...(activity.start_time ? { activityStartTime: activity.start_time } : {})
      }
    }
  }));
}

/** Fans a trigger out and runs every resulting binding, one at a time. */
export async function runAutomationTrigger(
  event: AutomationTriggerEvent,
  deps?: Partial<CoachAutomationRunnerDeps>
): Promise<CoachAutomationRun[]> {
  const resolved = resolveDeps(deps);
  const queue = expandTriggerToQueue(event, deps);
  const runs: CoachAutomationRun[] = [];
  for (const queued of queue) {
    const plan = planBindingRuns(queued, resolved);

    if (!plan.length) {
      // Activity-driven, with nothing new since this binding's watermark. A
      // manual run records the skip so the UI can say so out loud; the
      // 15-minute poll stays quiet rather than filling the log with non-events.
      if (event.kind === "manual") {
        runs.push(
          skip(queued, "no-activity", resolved, queued.binding.sessionId ?? undefined)
        );
      }
      continue;
    }

    for (const step of plan) {
      let run: CoachAutomationRun;
      try {
        run = await enqueue(() => runOneBinding(step, deps));
      } catch (error) {
        // One binding blowing up must not starve the rest of the fan-out, and
        // the failure still has to be visible in the run log.
        const failedAt = resolved.now().toISOString();
        run = resolved.recordRun({
          automationId: step.automation.id,
          bindingId: step.binding.id,
          status: "failed",
          triggerKind: event.kind,
          error: error instanceof Error ? error.message : "Automation run failed.",
          finishedAt: failedAt
        } as Omit<CoachAutomationRun, "id" | "startedAt">);
        resolved.emitRunUpdate(run);
        runs.push(run);
        break;
      }
      runs.push(run);
      // A refusal applies to the whole catch-up sequence — the daily cap or
      // quiet hours will not have changed by the next activity in the list —
      // so stop rather than logging the same skip once per pending activity.
      // The watermark stays put, and the leftovers ride along with the next
      // trigger.
      if (run.status === "skipped") {
        break;
      }
    }
  }
  return runs;
}

/** 3.4 "Run now": bypasses cooldown, quiet hours and the daily cap. */
export function runAutomationNow(
  automationId: string,
  bindingIds?: string[],
  deps?: Partial<CoachAutomationRunnerDeps>
): Promise<CoachAutomationRun[]> {
  return runAutomationTrigger(
    {
      automationId,
      kind: "manual",
      bypassGuards: true,
      ...(bindingIds ? { bindingIds } : {})
    },
    deps
  );
}

/** Test seam: resets the process-wide queue between scenarios. */
export function resetAutomationQueueForTests(): void {
  queueTail = Promise.resolve();
}
