import type {
  AutomationBindingMode,
  CoachAutomationInput
} from "../../../electron/types";

export interface CoachAutomationPreset {
  id: string;
  label: string;
  description: string;
  definition: CoachAutomationInput;
  /** How the preset suggests attaching itself on the "where it runs" tab. */
  suggestedBinding: { mode: AutomationBindingMode; titleTemplate?: string };
}

/**
 * The only preset shipping in phase 1. A debrief is the cheapest rule to trust:
 * it fires on something the athlete just did, so they can judge the answer
 * immediately — which is the point of shipping one preset rather than a gallery.
 */
const POST_ACTIVITY_DEBRIEF: CoachAutomationPreset = {
  id: "post-activity-debrief",
  label: "Post-activity debrief",
  description:
    "After every activity over 20 minutes, review how it went against recent training and flag anything worth acting on.",
  definition: {
    name: "Post-activity debrief",
    presetId: "post-activity-debrief",
    role:
      "You are the athlete's endurance coach reviewing a session that has just finished. " +
      "Injury prevention and consistency come before chasing numbers. Be concrete and brief.",
    playbook:
      "A new activity has just synced: {{activity.name}} ({{activity.sport}}) on {{date}}.\n\n" +
      "Look at the activity against the athlete's recent training:\n" +
      "- How it compares with similar recent sessions (pace, heart rate, load, duration).\n" +
      "- Whether it fits the week's pattern, or breaks it.\n" +
      "- Anything in recovery or accumulated load that this session changes.\n\n" +
      "Only raise something if it is materially different from recent history.",
    trigger: { kind: "activity", sportTypes: [], minDurationSec: 1200 },
    // Section 7: activity triggers default to low effort so a rule that fires
    // several times a week stays cheap.
    runtime: { effort: "low" },
    conditions: { batchWindowMin: 20, cooldownMin: 120, maxRunsPerDay: 3 }
  },
  suggestedBinding: {
    mode: "per-run",
    titleTemplate: "{{rule.name}} · {{activity.name}} · {{date}}"
  }
};

export const COACH_AUTOMATION_PRESETS: CoachAutomationPreset[] = [
  POST_ACTIVITY_DEBRIEF
];
