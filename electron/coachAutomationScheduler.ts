import {
  emitAutomationRunUpdate,
  isWithinQuietHours,
  parseTimeOfDay,
  runAutomationTrigger
} from "./coachAutomationService";
import {
  listActiveCoachAutomationBindings,
  listCoachAutomations,
  recordCoachAutomationRun,
  setCoachAutomationBindingSchedule
} from "./coachAutomationStore";
import type {
  AutomationTrigger,
  CoachAutomation,
  CoachAutomationBinding,
  CoachAutomationRun
} from "./types";

/** 3.1: the tick is a minute, not a cron — a desktop app is not always up. */
export const SCHEDULER_TICK_INTERVAL_MS = 60_000;

/**
 * 3.1: a slot missed by more than a day is written off rather than run late.
 * An overnight briefing delivered at lunchtime is worse than no briefing.
 */
export const STALE_SLOT_MS = 24 * 60 * 60_000;

type ScheduleTrigger = Extract<AutomationTrigger, { kind: "schedule" }>;

export interface CoachAutomationSchedulerDeps {
  now(): Date;
  listAutomations(): CoachAutomation[];
  /** Enabled bindings of an enabled automation, per 2.4. */
  listActiveBindings(automationId: string): CoachAutomationBinding[];
  /** Only ever a real slot: see `bookNextSlot`. */
  setBindingNextRun(bindingId: string, nextRunAt: string): void;
  recordStaleSlot(input: {
    automationId: string;
    bindingId: string;
    sessionId?: string;
  }): CoachAutomationRun;
  runTrigger(event: {
    automationId: string;
    kind: "schedule";
    bindingIds: string[];
  }): Promise<CoachAutomationRun[]>;
  onError(error: unknown): void;
}

function createDefaultDeps(): CoachAutomationSchedulerDeps {
  return {
    now: () => new Date(),
    listAutomations: () => listCoachAutomations(),
    listActiveBindings: (automationId) =>
      listActiveCoachAutomationBindings(automationId),
    setBindingNextRun: (bindingId, nextRunAt) => {
      setCoachAutomationBindingSchedule(bindingId, { nextRunAt });
    },
    recordStaleSlot: ({ automationId, bindingId, sessionId }) => {
      const finishedAt = new Date().toISOString();
      const run = recordCoachAutomationRun({
        automationId,
        bindingId,
        status: "skipped",
        triggerKind: "schedule",
        skipReason: "stale-slot",
        finishedAt,
        ...(sessionId ? { sessionId } : {})
      });
      emitAutomationRunUpdate(run);
      return run;
    },
    runTrigger: (event) => runAutomationTrigger(event),
    onError: (error) => {
      console.error("[coach-automation] scheduler tick failed:", error);
    }
  };
}

// ---------------------------------------------------------------------------
// Slot maths
// ---------------------------------------------------------------------------

/**
 * The first slot strictly after `after`, in the athlete's local wall clock.
 *
 * Every step is a *calendar* step (`setDate`), never `+ 86_400_000`: adding a
 * fixed span of milliseconds across a daylight-saving boundary moves the run an
 * hour off the time the athlete asked for. Returns null for a malformed
 * `timeOfDay`, which the store already rejects on the way in.
 */
export function nextScheduleSlot(
  trigger: ScheduleTrigger,
  after: Date
): Date | null {
  const minutes = parseTimeOfDay(trigger.timeOfDay);
  if (minutes === null) {
    return null;
  }
  const hour = Math.floor(minutes / 60);
  const minute = minutes % 60;
  const stepDays = trigger.cadence === "weekly" ? 7 : 1;

  const slot = new Date(after);
  slot.setHours(hour, minute, 0, 0);
  if (trigger.cadence === "weekly") {
    const wanted = trigger.dayOfWeek ?? 1;
    slot.setDate(slot.getDate() + ((wanted - slot.getDay() + 7) % 7));
    // The day step can cross a boundary; re-stating the wall clock keeps the
    // slot on the requested time rather than an hour either side of it.
    slot.setHours(hour, minute, 0, 0);
  }

  // A time that does not exist on a spring-forward day (02:30 where 02:00 goes
  // straight to 03:00) resolves forward, so the loop still terminates.
  while (slot.getTime() <= after.getTime()) {
    slot.setDate(slot.getDate() + stepDays);
    slot.setHours(hour, minute, 0, 0);
  }
  return slot;
}

/**
 * When a quiet window that is open right now closes. Reuses the daily slot
 * maths, because "the next 06:00 from here" is the same question.
 */
export function quietHoursEnd(
  now: Date,
  quietHours: { start: string; end: string }
): Date | null {
  return nextScheduleSlot(
    { kind: "schedule", cadence: "daily", timeOfDay: quietHours.end },
    now
  );
}

function parseSlot(value: string | undefined): Date | null {
  if (!value) {
    return null;
  }
  const slot = new Date(value);
  return Number.isNaN(slot.getTime()) ? null : slot;
}

// ---------------------------------------------------------------------------
// The ticker
// ---------------------------------------------------------------------------

export class CoachAutomationScheduler {
  private readonly deps: CoachAutomationSchedulerDeps;
  private timer: ReturnType<typeof setInterval> | null = null;
  private ticking = false;

  constructor(deps: Partial<CoachAutomationSchedulerDeps> = {}) {
    this.deps = { ...createDefaultDeps(), ...deps };
  }

  start(intervalMs = SCHEDULER_TICK_INTERVAL_MS): void {
    if (this.timer) {
      return;
    }
    // Tied to the app process, never to a window (decision 1): a briefing due
    // with the window closed still runs and is read later.
    this.timer = setInterval(() => {
      void this.tick();
    }, intervalMs);
    this.timer.unref?.();
    // The catch-up pass of 3.1. It is the ordinary tick — a slot that came due
    // while the app was closed is simply a slot in the past — so it runs
    // immediately rather than up to a minute after launch.
    void this.tick();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  isRunning(): boolean {
    return this.timer !== null;
  }

  /** Visible for tests; safe to call concurrently. */
  async tick(): Promise<void> {
    if (this.ticking) {
      return;
    }
    this.ticking = true;
    try {
      for (const automation of this.deps.listAutomations()) {
        if (!automation.enabled || automation.trigger.kind !== "schedule") {
          continue;
        }
        const trigger = automation.trigger;
        for (const binding of this.deps.listActiveBindings(automation.id)) {
          // Each binding keeps its own slot, so one that is broken, deferred or
          // brand new cannot hold up the others (3.1, per-binding independence).
          try {
            await this.evaluateBinding(automation, trigger, binding);
          } catch (error) {
            this.deps.onError(error);
          }
        }
      }
    } catch (error) {
      this.deps.onError(error);
    } finally {
      this.ticking = false;
    }
  }

  private async evaluateBinding(
    automation: CoachAutomation,
    trigger: ScheduleTrigger,
    binding: CoachAutomationBinding
  ): Promise<void> {
    const now = this.deps.now();
    const slot = parseSlot(binding.nextRunAt);

    // No slot booked yet — a binding attached moments ago, or one whose
    // automation had its trigger edited. Book the next one and wait for it:
    // creating a "daily at 07:00" rule at lunchtime must not fire on the spot.
    if (!slot) {
      this.bookNextSlot(binding, nextScheduleSlot(trigger, now));
      return;
    }

    if (now.getTime() < slot.getTime()) {
      return;
    }

    if (now.getTime() - slot.getTime() > STALE_SLOT_MS) {
      // Written off, and the backlog behind it with it: the next slot is
      // computed from *now*, so a fortnight with the app closed logs one skip
      // rather than fourteen runs nobody asked for.
      this.deps.recordStaleSlot({
        automationId: automation.id,
        bindingId: binding.id,
        ...(binding.sessionId ? { sessionId: binding.sessionId } : {})
      });
      this.bookNextSlot(binding, nextScheduleSlot(trigger, now));
      return;
    }

    // Quiet hours defer, they never cancel (3.1): unlike an activity, a slot
    // has nowhere to wait. Moving it to the end of the window is the deferral,
    // and the window's end is by definition outside the window, so this
    // happens once rather than every tick.
    const quietHours = automation.conditions.quietHours;
    if (quietHours && isWithinQuietHours(now, quietHours)) {
      const end = quietHoursEnd(now, quietHours);
      if (end) {
        this.deps.setBindingNextRun(binding.id, end.toISOString());
        return;
      }
    }

    // Booked before the run, not after. A run takes as long as the provider
    // does, and the app may be closed mid-flight; advancing first means the
    // worst case is one missed briefing rather than the same slot retried on
    // every tick for the rest of the day.
    //
    // Booked from `now` rather than from `slot`, which is the same answer with
    // one fewer edge: a slot is only reached here once it is already due, so
    // "the first slot after now" can never land in the past the way
    // "slot + one cadence" can for a slot that is a whole day late.
    this.bookNextSlot(binding, nextScheduleSlot(trigger, now));

    // Guard rails 1-8 belong to the runner (section 4) and are not repeated
    // here. The scheduler decides *when*; whether it may is the runner's call.
    await this.deps.runTrigger({
      automationId: automation.id,
      kind: "schedule",
      bindingIds: [binding.id]
    });
  }

  private bookNextSlot(binding: CoachAutomationBinding, slot: Date | null): void {
    // Only a malformed `timeOfDay` has no next slot, and the store rejects
    // those on the way in. Writing null anyway would re-book nothing on every
    // tick for the life of the process, so nothing is written at all.
    if (!slot) {
      return;
    }
    this.deps.setBindingNextRun(binding.id, slot.toISOString());
  }
}

let scheduler: CoachAutomationScheduler | null = null;

/** Started from `app.whenReady()`, never from `createWindow`. */
export function startCoachAutomationScheduler(
  intervalMs = SCHEDULER_TICK_INTERVAL_MS
): CoachAutomationScheduler {
  scheduler ??= new CoachAutomationScheduler();
  scheduler.start(intervalMs);
  return scheduler;
}

/** Stopped from `before-quit`, never from the window's "closed". */
export function stopCoachAutomationScheduler(): void {
  scheduler?.stop();
  scheduler = null;
}
