import type {
  AnthropicEffort,
  AutomationTrigger,
  ChatProvider,
  CoachAutomationInput
} from "../../../electron/types";
import { ModelSwitch } from "../ModelSwitch";
import { EffortSwitch } from "../EffortSwitch";
import { supportsReasoningEffort } from "../../../electron/chatModels";
import { SPORT_FILTER_OPTIONS } from "./automationLabels";

/**
 * The definition fields, shared by the create screen and the detail view's
 * Definition tab so the two can never drift apart.
 */
export function AutomationDefinitionForm({
  draft,
  provider,
  disabled,
  onChange
}: {
  draft: CoachAutomationInput;
  provider: ChatProvider;
  disabled?: boolean;
  onChange: (patch: Partial<CoachAutomationInput>) => void;
}) {
  const activityTrigger = draft.trigger.kind === "activity" ? draft.trigger : null;
  const runtimeProvider = draft.runtime?.provider ?? provider;
  // Mirrors what the two switches themselves decide to render.
  const showModel = runtimeProvider !== "local";
  const showEffort = supportsReasoningEffort(runtimeProvider);

  const patchTrigger = (
    patch: Partial<Extract<AutomationTrigger, { kind: "activity" }>>
  ) => {
    if (!activityTrigger) return;
    onChange({ trigger: { ...activityTrigger, ...patch } });
  };

  return (
    <>
      <label className="chat-local-field">
        <span>Name</span>
        <input
          type="text"
          value={draft.name}
          disabled={disabled}
          onChange={(event) => onChange({ name: event.target.value })}
        />
      </label>

      <label className="chat-local-field">
        <span>Role</span>
        <textarea
          className="chat-custom-instructions"
          rows={3}
          value={draft.role ?? ""}
          disabled={disabled}
          placeholder="Strict marathon coach, injury-prevention first"
          onChange={(event) => onChange({ role: event.target.value })}
        />
      </label>
      <p className="chat-settings-copy">
        The role is preference data, not operating rules — it can never widen what
        an automation is allowed to do.
      </p>

      <label className="chat-local-field">
        <span>Playbook</span>
        <textarea
          className="chat-custom-instructions"
          rows={8}
          value={draft.playbook}
          disabled={disabled}
          onChange={(event) => onChange({ playbook: event.target.value })}
        />
      </label>
      <p className="coach-automation-hint">
        Variables: {"{{rule.name}}"}, {"{{date}}"}, {"{{activity.name}}"},{" "}
        {"{{activity.sport}}"}, {"{{week.range}}"}
      </p>

      {activityTrigger ? (
        <fieldset className="coach-automation-fieldset" disabled={disabled}>
          <legend>Fires after a new activity</legend>
          <div className="coach-automation-sports">
            {SPORT_FILTER_OPTIONS.map((sport) => {
              const checked = activityTrigger.sportTypes.includes(sport.value);
              return (
                <label key={sport.value} className="coach-automation-chip">
                  <input
                    type="checkbox"
                    checked={checked}
                    onChange={() =>
                      patchTrigger({
                        sportTypes: checked
                          ? activityTrigger.sportTypes.filter(
                              (value) => value !== sport.value
                            )
                          : [...activityTrigger.sportTypes, sport.value]
                      })
                    }
                  />
                  <span>{sport.label}</span>
                </label>
              );
            })}
          </div>
          <p className="coach-automation-hint">
            {activityTrigger.sportTypes.length === 0
              ? "No sport selected means every sport."
              : `${activityTrigger.sportTypes.length} sport(s) selected.`}
          </p>
          <div className="coach-automation-row">
            <label className="chat-local-field">
              <span>Minimum duration (min)</span>
              <input
                type="number"
                min={0}
                value={Math.round((activityTrigger.minDurationSec ?? 0) / 60)}
                onChange={(event) => {
                  const minutes = Number(event.target.value);
                  patchTrigger({
                    minDurationSec: minutes > 0 ? minutes * 60 : undefined
                  });
                }}
              />
            </label>
            <label className="chat-local-field">
              <span>Minimum distance (km)</span>
              <input
                type="number"
                min={0}
                step={0.5}
                value={(activityTrigger.minDistanceM ?? 0) / 1000}
                onChange={(event) => {
                  const km = Number(event.target.value);
                  patchTrigger({
                    minDistanceM: km > 0 ? Math.round(km * 1000) : undefined
                  });
                }}
              />
            </label>
          </div>
          <label className="coach-automation-switch">
            <input
              type="checkbox"
              checked={activityTrigger.multiActivity === true}
              onChange={(event) =>
                patchTrigger({ multiActivity: event.target.checked })
              }
            />
            <span>Analyse every new activity</span>
          </label>
          <p className="coach-automation-hint">
            {activityTrigger.multiActivity
              ? "Every matching activity since the last analysis is analysed, one run each, oldest first."
              : "Only the most recent matching activity is analysed, however many piled up."}
          </p>
        </fieldset>
      ) : null}

      {/* Both switches render nothing for a local model, which would otherwise
          leave an empty box labelled "Model" on screen. */}
      {showModel || showEffort ? (
        <fieldset className="coach-automation-fieldset" disabled={disabled}>
          <legend>Model</legend>
          <div className="coach-automation-row coach-automation-model-row">
            {showModel ? (
              <ModelSwitch
                provider={runtimeProvider}
                model={draft.runtime?.model ?? ""}
                onChange={(model) =>
                  onChange({ runtime: { ...draft.runtime, model } })
                }
              />
            ) : null}
            {showEffort ? (
              <EffortSwitch
                provider={runtimeProvider}
                effort={(draft.runtime?.effort ?? "low") as AnthropicEffort}
                onChange={(effort) =>
                  onChange({ runtime: { ...draft.runtime, effort } })
                }
              />
            ) : null}
          </div>
        </fieldset>
      ) : null}

      <p className="chat-settings-copy">
        Automation runs are read-only: they can read, analyse and draft, but never
        write to COROS. Drafts wait in the conversation for you to confirm.
      </p>

      <fieldset className="coach-automation-fieldset" disabled={disabled}>
        <legend>Guard rails</legend>
        <div className="coach-automation-row">
          <label className="chat-local-field">
            <span>Batch window (min)</span>
            <input
              type="number"
              min={0}
              value={draft.conditions?.batchWindowMin ?? 20}
              onChange={(event) =>
                onChange({
                  conditions: {
                    ...draft.conditions,
                    batchWindowMin: Number(event.target.value)
                  }
                })
              }
            />
          </label>
          <label className="chat-local-field">
            <span>Cooldown (min)</span>
            <input
              type="number"
              min={0}
              value={draft.conditions?.cooldownMin ?? 120}
              onChange={(event) =>
                onChange({
                  conditions: {
                    ...draft.conditions,
                    cooldownMin: Number(event.target.value)
                  }
                })
              }
            />
          </label>
          <label className="chat-local-field">
            <span>Max runs per day</span>
            <input
              type="number"
              min={1}
              max={24}
              value={draft.conditions?.maxRunsPerDay ?? 3}
              onChange={(event) =>
                onChange({
                  conditions: {
                    ...draft.conditions,
                    maxRunsPerDay: Number(event.target.value)
                  }
                })
              }
            />
          </label>
        </div>
      </fieldset>
    </>
  );
}
