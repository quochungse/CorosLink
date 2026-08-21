import {
  getSetting,
  listUnseenCoachActivityRows,
  markAllCoachActivitiesSeen,
  markCoachActivitiesSeen,
  setSetting
} from "./database";
import type { CoachUnseenActivityRow } from "./database";
import { listCoachAutomations } from "./coachAutomationStore";
import {
  activityMatchesAutomation,
  runAutomationTrigger
} from "./coachAutomationService";
import {
  getTrainingHubStatus,
  listTrainingHubActivities
} from "./trainingHubService";
import type { CoachAutomation, CoachAutomationRun } from "./types";

/** 3.2: the watcher polls this often for as long as the process is alive. */
export const ACTIVITY_POLL_INTERVAL_MS = 15 * 60_000;

/** How far back page 1 of the activity index is fetched. */
export const ACTIVITY_LOOKBACK_DAYS = 7;

const INITIALIZED_SETTING = "coachAutomation.activityWatcherInitializedAt";

export interface CoachActivityWatcherDeps {
  now(): Date;
  /** Pulls page 1 of the index; persisting into `training_activities` is its
   * documented side effect, which is exactly what the watcher diffs against. */
  refreshActivityIndex(startDay: string, endDay: string): Promise<void>;
  listUnseenActivities(sinceEpochSeconds?: number): CoachUnseenActivityRow[];
  markSeen(activityIds: string[]): void;
  markAllSeen(): number;
  listAutomations(): CoachAutomation[];
  isCorosAuthenticated(): boolean;
  getSetting(key: string): string | undefined;
  setSetting(key: string, value: string): void;
  runTrigger(event: {
    automationId: string;
    kind: "activity";
  }): Promise<CoachAutomationRun[]>;
  onError(error: unknown): void;
}

function happenDay(value: Date): string {
  const year = value.getFullYear();
  const month = `${value.getMonth() + 1}`.padStart(2, "0");
  const day = `${value.getDate()}`.padStart(2, "0");
  return `${year}${month}${day}`;
}

function createDefaultDeps(): CoachActivityWatcherDeps {
  return {
    now: () => new Date(),
    refreshActivityIndex: async (startDay, endDay) => {
      await listTrainingHubActivities(1, 50, startDay, endDay);
    },
    listUnseenActivities: (since) => listUnseenCoachActivityRows(since),
    markSeen: (ids) => markCoachActivitiesSeen(ids),
    markAllSeen: () => markAllCoachActivitiesSeen(),
    listAutomations: () => listCoachAutomations(),
    isCorosAuthenticated: () => getTrainingHubStatus().authenticated,
    getSetting: (key) => getSetting(key),
    setSetting: (key, value) => setSetting(key, value),
    runTrigger: (event) => runAutomationTrigger(event),
    onError: (error) => {
      console.error("[coach-automation] activity watcher tick failed:", error);
    }
  };
}

// The matcher lives with the runner, which now owns activity selection too;
// re-exported here because this is where callers expect to find it.
export { activityMatchesAutomation };

interface PendingBatch {
  automationId: string;
  openedAt: number;
  activities: CoachUnseenActivityRow[];
}

export class CoachActivityWatcher {
  private readonly deps: CoachActivityWatcherDeps;
  private timer: ReturnType<typeof setInterval> | null = null;
  private ticking = false;
  private readonly batches = new Map<string, PendingBatch>();

  constructor(deps: Partial<CoachActivityWatcherDeps> = {}) {
    this.deps = { ...createDefaultDeps(), ...deps };
  }

  start(intervalMs = ACTIVITY_POLL_INTERVAL_MS): void {
    if (this.timer) {
      return;
    }
    // Tied to the app process, never to a window: a run started with the
    // window closed still completes and persists (Execution lifetime).
    this.timer = setInterval(() => {
      void this.tick();
    }, intervalMs);
    this.timer.unref?.();
    void this.tick();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    // Anything still batched is deliberately dropped rather than stamped: the
    // rows stay unseen, so the next launch picks them up again.
    this.batches.clear();
  }

  isRunning(): boolean {
    return this.timer !== null;
  }

  /** Visible for the scheduler and for tests; safe to call concurrently. */
  async tick(): Promise<void> {
    if (this.ticking) {
      return;
    }
    this.ticking = true;
    try {
      await this.poll();
      await this.flushDueBatches();
    } catch (error) {
      this.deps.onError(error);
    } finally {
      this.ticking = false;
    }
  }

  private async poll(): Promise<void> {
    const automations = this.deps
      .listAutomations()
      .filter(
        (automation) => automation.enabled && automation.trigger.kind === "activity"
      );

    // The cold-start stamp still has to happen with no automations configured,
    // otherwise the athlete's whole history is "new" the day they add one.
    const firstRun = !this.deps.getSetting(INITIALIZED_SETTING);

    if (!this.deps.isCorosAuthenticated()) {
      return;
    }

    const now = this.deps.now();
    const start = new Date(now);
    start.setDate(start.getDate() - ACTIVITY_LOOKBACK_DAYS);
    await this.deps.refreshActivityIndex(happenDay(start), happenDay(now));

    if (firstRun) {
      this.deps.markAllSeen();
      this.deps.setSetting(INITIALIZED_SETTING, now.toISOString());
      return;
    }

    if (!automations.length) {
      // Nothing is listening, so keep the marker moving; otherwise a rule added
      // next week would fire for everything that landed in the meantime.
      const unseen = this.deps.listUnseenActivities();
      this.deps.markSeen(unseen.map((activity) => activity.activity_id));
      return;
    }

    const lookbackStart = Math.floor(start.getTime() / 1000);
    const unseen = this.deps.listUnseenActivities(lookbackStart);
    if (!unseen.length) {
      return;
    }

    for (const automation of automations) {
      const matches = unseen.filter((activity) =>
        activityMatchesAutomation(activity, automation)
      );
      if (matches.length) {
        this.addToBatch(automation, matches, now);
      }
    }

    // Rows are stamped once every automation has had its look, whether or not
    // any of them matched. An unmatched activity is genuinely handled.
    const batched = new Set<string>();
    for (const batch of this.batches.values()) {
      for (const activity of batch.activities) batched.add(activity.activity_id);
    }
    this.deps.markSeen(
      unseen
        .map((activity) => activity.activity_id)
        .filter((id) => !batched.has(id))
    );
  }

  /**
   * 3.2 step 5: several activities arriving inside `batchWindowMin` collapse
   * into one run per binding, whose payload carries all their ids.
   */
  private addToBatch(
    automation: CoachAutomation,
    activities: CoachUnseenActivityRow[],
    now: Date
  ): void {
    const existing = this.batches.get(automation.id);
    if (!existing) {
      this.batches.set(automation.id, {
        automationId: automation.id,
        openedAt: now.getTime(),
        activities: [...activities]
      });
      return;
    }
    const known = new Set(existing.activities.map((entry) => entry.activity_id));
    for (const activity of activities) {
      if (!known.has(activity.activity_id)) {
        existing.activities.push(activity);
      }
    }
  }

  private async flushDueBatches(): Promise<void> {
    const now = this.deps.now().getTime();
    const automations = new Map(
      this.deps.listAutomations().map((automation) => [automation.id, automation])
    );

    for (const [automationId, batch] of [...this.batches]) {
      const automation = automations.get(automationId);
      if (!automation || !automation.enabled) {
        // Switched off while its batch was waiting: drop it and stop holding
        // the rows back from the seen marker.
        this.batches.delete(automationId);
        this.deps.markSeen(batch.activities.map((entry) => entry.activity_id));
        continue;
      }

      const windowMs = automation.conditions.batchWindowMin * 60_000;
      if (now - batch.openedAt < windowMs) {
        continue;
      }

      this.batches.delete(automationId);
      // Stamped only now: an app that quits mid-window leaves the rows unseen
      // so the next launch picks them up rather than losing them.
      this.deps.markSeen(batch.activities.map((entry) => entry.activity_id));

      // The batch decides *when* to fire, not what gets analysed: each binding
      // has its own watermark (a conversation attached yesterday owes a
      // different set than one attached last month), so the runner selects the
      // activities and fills in each run's payload itself.
      await this.deps.runTrigger({ automationId, kind: "activity" });
    }
  }

  /** Test seam: the batches waiting on their window. */
  pendingBatchSizes(): Record<string, number> {
    const sizes: Record<string, number> = {};
    for (const [id, batch] of this.batches) {
      sizes[id] = batch.activities.length;
    }
    return sizes;
  }
}

let watcher: CoachActivityWatcher | null = null;

/** Started from `app.whenReady()`, never from `createWindow`. */
export function startCoachActivityWatcher(
  intervalMs = ACTIVITY_POLL_INTERVAL_MS
): CoachActivityWatcher {
  watcher ??= new CoachActivityWatcher();
  watcher.start(intervalMs);
  return watcher;
}

/** Stopped from `before-quit`, never from the window's "closed". */
export function stopCoachActivityWatcher(): void {
  watcher?.stop();
  watcher = null;
}
