import { COROS_KNOWN_SPORT_TYPES } from "../../../electron/corosSportTypes";
import type {
  AutomationTrigger,
  CoachAutomationBindingView,
  CoachAutomationRun
} from "../../../electron/types";

/** Sports offered in the trigger filter, in the order athletes think of them. */
export const SPORT_FILTER_OPTIONS: Array<{ value: number; label: string }> = [
  100, 102, 101, 103, 200, 204, 201, 300, 301, 402, 104, 900
].map((value) => ({
  value,
  label: COROS_KNOWN_SPORT_TYPES[value] ?? `Sport ${value}`
}));

function formatMinutes(seconds: number): string {
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest ? `${hours}h ${rest}m` : `${hours}h`;
}

const WEEKDAYS = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday"
];

/** The one-line "when does this fire" copy under an automation's name. */
export function describeTrigger(trigger: AutomationTrigger): string {
  if (trigger.kind === "schedule") {
    return trigger.cadence === "weekly"
      ? `Every ${WEEKDAYS[trigger.dayOfWeek ?? 1]} at ${trigger.timeOfDay}`
      : `Every day at ${trigger.timeOfDay}`;
  }

  if (trigger.kind === "activity") {
    // No sport filter means every sport, which reads better as a bare
    // "activity" than as the literal "any activity" — especially once
    // multiActivity prefixes it with "Every new".
    const subject = trigger.sportTypes.length
      ? `${trigger.sportTypes
          .map((type) => COROS_KNOWN_SPORT_TYPES[type] ?? `sport ${type}`)
          .join(", ")} activity`
      : "activity";
    const filters: string[] = [];
    if (trigger.minDurationSec) {
      filters.push(`≥ ${formatMinutes(trigger.minDurationSec)}`);
    }
    if (trigger.minDistanceM) {
      filters.push(`≥ ${(trigger.minDistanceM / 1000).toFixed(1)} km`);
    }
    const suffix = filters.length ? ` ${filters.join(" · ")}` : "";
    return trigger.multiActivity
      ? `Every new ${subject}${suffix}`
      : `New ${subject}${suffix}`;
  }

  if (trigger.kind === "threshold") {
    return `When ${trigger.metric} crosses ${trigger.value}`;
  }
  return "Manual only";
}

export function describeBindingMode(binding: CoachAutomationBindingView): string {
  if (binding.mode === "per-run") {
    return binding.titleTemplate
      ? `titled "${binding.titleTemplate}"`
      : "a fresh conversation each run";
  }
  if (binding.sessionMissing) {
    return "conversation deleted";
  }
  return binding.sessionTitle ?? "conversation";
}

export function bindingModeLabel(binding: CoachAutomationBindingView): string {
  if (binding.mode === "per-run") return "New conversation each run";
  return binding.sessionTitle ?? "Conversation";
}

const RUN_STATUS_LABELS: Record<CoachAutomationRun["status"], string> = {
  running: "Running",
  success: "Reported",
  silent: "Nothing to report",
  skipped: "Skipped",
  failed: "Failed",
  cancelled: "Cancelled"
};

export function runStatusLabel(run: CoachAutomationRun): string {
  return RUN_STATUS_LABELS[run.status] ?? run.status;
}

const SKIP_REASON_LABELS: Record<string, string> = {
  disabled: "switched off",
  "missing-session": "conversation missing",
  "no-auth": "not signed in",
  offline: "COROS unreachable",
  "two-factor-required": "COROS needs a login code",
  "quiet-hours": "quiet hours",
  cooldown: "too soon after the last run",
  budget: "daily limit reached",
  burst: "conversation busy",
  "batch-window": "waiting for more activities",
  "no-activity": "no new activity to analyse",
  "stale-slot": "missed slot"
};

export function skipReasonLabel(reason: string): string {
  return SKIP_REASON_LABELS[reason] ?? reason;
}

/** "2h ago" style, for the last-run line on a card. */
export function formatTimeAgo(iso: string | undefined): string {
  if (!iso) return "never";
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "never";
  const minutes = Math.round((Date.now() - then) / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  return days === 1 ? "yesterday" : `${days}d ago`;
}

/**
 * "in 3h" style, for the next slot on a schedule automation's card. Null when
 * there is no slot booked yet — the scheduler seeds one on its next tick, and
 * an empty space says that better than a placeholder does.
 */
export function formatTimeUntil(iso: string | undefined): string | null {
  if (!iso) return null;
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return null;
  const minutes = Math.round((then - Date.now()) / 60_000);
  if (minutes <= 0) return "any moment";
  if (minutes < 60) return `in ${minutes}m`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `in ${hours}h`;
  const days = Math.round(hours / 24);
  return days === 1 ? "tomorrow" : `in ${days}d`;
}

export function formatDuration(run: CoachAutomationRun): string {
  if (!run.finishedAt) return "—";
  const ms = new Date(run.finishedAt).getTime() - new Date(run.startedAt).getTime();
  if (!Number.isFinite(ms) || ms < 0) return "—";
  return ms < 1000 ? "<1s" : `${Math.round(ms / 1000)}s`;
}
