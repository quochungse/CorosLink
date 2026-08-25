import { useCallback, useEffect, useState } from "react";
import { Loader2, Play, Plus, Settings2, TriangleAlert, Zap } from "lucide-react";
import type { CorosLinkApi } from "../../coroslink-api";
import type {
  ChatProvider,
  CoachAutomationSummary
} from "../../../electron/types";
import { AUTOMATION_DEFAULT_EFFORT } from "../../../electron/types";
import { supportsReasoningEffort } from "../../../electron/chatModels";
import { CoachAutomationDetail } from "./CoachAutomationDetail";
import { CoachAutomationCreate } from "./CoachAutomationCreate";
import { RunNowDialog } from "./RunNowDialog";
import {
  describeTrigger,
  formatTimeAgo,
  formatTimeUntil,
  runStatusLabel,
  skipReasonLabel
} from "./automationLabels";
import { announceRunNow } from "./runNow";

export function CoachAutomationsPanel({
  api,
  provider,
  onChanged,
  onEditingChange,
  onOpenConversation
}: {
  api: CorosLinkApi | undefined;
  provider: ChatProvider;
  /** Opens the conversation a run wrote into, from the run log. */
  onOpenConversation?: (sessionId: string) => void;
  /** Fired after any mutation so the conversation header can re-read its chips. */
  onChanged?: () => void;
  /**
   * True while a form is open. The modal uses it to stop a stray click on the
   * backdrop from throwing away what the athlete is part-way through writing.
   */
  onEditingChange?: (editing: boolean) => void;
}) {
  const [summaries, setSummaries] = useState<CoachAutomationSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);
  /** Covers the gap between the click and the run having a record of its own. */
  const [startingId, setStartingId] = useState<string | null>(null);
  /** The automation whose "where should this run?" dialog is open (3.4). */
  const [pickingId, setPickingId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const [openTab, setOpenTab] = useState<"definition" | "bindings" | "runs">(
    "definition"
  );

  const refresh = useCallback(async () => {
    if (!api) return;
    try {
      setSummaries(await api.listCoachAutomations());
      setError(null);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setLoading(false);
    }
  }, [api]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  /**
   * Section 10: an expired provider sign-in shows up as a `no-auth` skip and
   * nothing else — no error, no failed run, just automations quietly declining.
   * Derived from the summaries already on screen rather than a second query:
   * every enabled automation whose *last* run declined for that reason is
   * exactly the shape a signed-out provider makes, and it clears itself the
   * moment one of them runs again.
   *
   * This matters most for the providers guard rail 3 cannot pre-flight. ChatGPT
   * puts a sign-in gate in front of the whole Coach view; the others report
   * their auth state through the stream, so without this the athlete has no
   * indication at all.
   */
  const signedOut = summaries.filter(
    (summary) =>
      summary.automation.enabled &&
      summary.lastRun?.status === "skipped" &&
      summary.lastRun.skipReason === "no-auth"
  );

  const picking =
    summaries.find((summary) => summary.automation.id === pickingId) ?? null;

  const editing = creating || openId !== null;
  useEffect(() => {
    onEditingChange?.(editing);
  }, [editing, onEditingChange]);

  // Runs finish in the main process whether or not this screen is open, so the
  // cards follow the push instead of polling.
  useEffect(() => {
    if (!api?.onCoachAutomationRunUpdate) return;
    return api.onCoachAutomationRunUpdate(() => {
      void refresh();
    });
  }, [api, refresh]);

  /**
   * A run outlives the click that started it, and the screen that started it:
   * `runCoachAutomationNow` resolves only once the whole fan-out has finished,
   * which for a tool-using playbook is minutes. Anchoring the button to that
   * promise made it a lie in both directions — the spinner stayed up after
   * navigating into the coach and back out, because this component is not
   * unmounted by that, and it vanished on a reopen of the modal while the run
   * was still going. What the button reflects is the run itself: the run log
   * says `running`, and every update is pushed here already.
   *
   * The promise is still awaited, and `startingId` does last as long as it —
   * but as a floor under the run log rather than a substitute for it. A trigger
   * fans out to one run per place (2.3) and they are serialised, so between two
   * of them there is a moment with no `running` row at all; a card that read
   * only the log would offer "Run now" in the middle of its own fan-out. What
   * the promise alone can say is the outcome: whether every run declined, and
   * why (9.2).
   */
  const startRun = async (automationId: string, bindingIds?: string[]) => {
    if (!api) return;
    setPickingId(null);
    setStartingId(automationId);
    setError(null);
    try {
      announceRunNow(await api.runCoachAutomationNow(automationId, bindingIds));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setStartingId((current) => (current === automationId ? null : current));
      await refresh();
      onChanged?.();
    }
  };

  /** The way out of a run that is taking longer than the athlete wants to wait. */
  const stopRun = async (runId: string) => {
    if (!api) return;
    setError(null);
    try {
      await api.cancelCoachAutomationRun(runId);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    }
  };

  const withBusy = async (id: string, work: () => Promise<unknown>) => {
    setBusyId(id);
    setError(null);
    try {
      await work();
      await refresh();
      onChanged?.();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusyId(null);
    }
  };

  if (creating) {
    return (
      <CoachAutomationCreate
        api={api}
        provider={provider}
        onCancel={() => setCreating(false)}
        onCreated={(created) => {
          setCreating(false);
          void refresh();
          onChanged?.();
          // Straight into "where it runs": an automation attached to nothing
          // never fires, which is the likeliest mistake in this model.
          setOpenId(created.id);
          setOpenTab("bindings");
        }}
      />
    );
  }

  if (openId) {
    return (
      <CoachAutomationDetail
        api={api}
        provider={provider}
        automationId={openId}
        initialTab={openTab}
        onBack={() => {
          setOpenId(null);
          setOpenTab("definition");
          void refresh();
        }}
        onChanged={async () => {
          await refresh();
          onChanged?.();
        }}
        {...(onOpenConversation ? { onOpenConversation } : {})}
      />
    );
  }

  return (
    <div className="coach-automations-panel">
      {error ? <p className="coach-automation-error">{error}</p> : null}

      {signedOut.length > 0 ? (
        <p className="coach-automation-banner" role="status">
          <TriangleAlert size={15} aria-hidden="true" />
          <span>
            <strong>Signed out of the coach provider.</strong>{" "}
            {signedOut.length === 1
              ? `${signedOut[0].automation.name} skipped its last run because the provider it uses is not signed in.`
              : `${signedOut.length} automations skipped their last run because the provider they use is not signed in.`}{" "}
            Sign in again — nothing is lost, and the next trigger picks up as
            normal.
          </span>
        </p>
      ) : null}

      {loading ? (
        <p className="chat-settings-copy">
          <Loader2 className="chat-spinner" size={14} aria-hidden="true" /> Loading…
        </p>
      ) : summaries.length === 0 ? (
        <p className="chat-settings-copy">
          No automations yet. A coach automation runs on its own — after an
          activity, for example — and writes what it finds into a conversation.
        </p>
      ) : (
        <ul className="coach-automation-card-list">
          {summaries.map((summary) => {
            const { automation, lastRun } = summary;
            const nextRun = formatTimeUntil(summary.nextRunAt);
            const busy = busyId === automation.id;
            const inFlight = lastRun?.status === "running" ? lastRun : null;
            const starting = startingId === automation.id;
            // Section 7: an automation with no effort of its own runs at
            // `low`, so the card says `low` rather than staying silent about
            // something the run definitely did. Providers that have no notion
            // of effort are left alone.
            const runtimeProvider = automation.runtime.provider ?? provider;
            const runtimeBits = [
              automation.runtime.model,
              supportsReasoningEffort(runtimeProvider)
                ? `effort ${automation.runtime.effort ?? AUTOMATION_DEFAULT_EFFORT}`
                : null
            ].filter(Boolean);

            return (
              <li
                key={automation.id}
                className="coach-automation-card"
                data-enabled={automation.enabled ? "true" : "false"}
              >
                <div className="coach-automation-card-head">
                  <span className="coach-automation-card-name">
                    <Zap size={15} aria-hidden="true" />
                    {automation.name}
                  </span>
                  <label className="coach-automation-switch">
                    <input
                      type="checkbox"
                      checked={automation.enabled}
                      disabled={busy || !api}
                      onChange={(event) =>
                        void withBusy(automation.id, () =>
                          (api as CorosLinkApi).setCoachAutomationEnabled(
                            automation.id,
                            event.target.checked
                          )
                        )
                      }
                    />
                    <span>{automation.enabled ? "On" : "Off"}</span>
                  </label>
                </div>

                <p className="coach-automation-card-trigger">
                  {describeTrigger(automation.trigger)}
                  {/* A schedule fires with nobody watching, so the card says
                      when — the earliest slot across its bindings (3.1). */}
                  {automation.trigger.kind === "schedule" && nextRun
                    ? ` · next ${nextRun}`
                    : ""}
                  {runtimeBits.length ? ` · ${runtimeBits.join(" · ")}` : ""}
                </p>

                <p className="coach-automation-card-status">
                  {summary.bindingCount === 0 ? (
                    <button
                      type="button"
                      className="chat-inline-link coach-automation-unattached"
                      onClick={() => {
                        setOpenId(automation.id);
                        setOpenTab("bindings");
                      }}
                    >
                      Not attached anywhere — it will never run
                    </button>
                  ) : (
                    <button
                      type="button"
                      className="chat-inline-link"
                      onClick={() => {
                        setOpenId(automation.id);
                        setOpenTab("bindings");
                      }}
                    >
                      Runs in {summary.bindingCount} place
                      {summary.bindingCount === 1 ? "" : "s"}
                    </button>
                  )}
                  {lastRun ? (
                    <>
                      {" · "}Last run {formatTimeAgo(lastRun.startedAt)}
                      {lastRun.summary
                        ? ` · “${lastRun.summary}”`
                        : lastRun.skipReason
                          ? ` · skipped (${skipReasonLabel(lastRun.skipReason)})`
                          : ` · ${runStatusLabel(lastRun)}`}
                    </>
                  ) : null}
                </p>

                <div className="coach-automation-card-actions">
                  {inFlight ? (
                    <button
                      type="button"
                      className="chat-local-action"
                      disabled={!api}
                      title="Stop this run"
                      onClick={() => void stopRun(inFlight.id)}
                    >
                      <Loader2
                        className="chat-spinner"
                        size={14}
                        aria-hidden="true"
                      />
                      Stop
                    </button>
                  ) : (
                    // A coach attached to five paused conversations used to be
                    // told to attach itself to one. A manual run bypasses the
                    // guard rails on purpose (3.4), so being paused is a reason
                    // to ask rather than a reason to refuse.
                    <button
                      type="button"
                      className="chat-local-action"
                      disabled={
                        busy || starting || !api || summary.bindingCount === 0
                      }
                      aria-busy={starting || undefined}
                      title={
                        summary.bindingCount === 0
                          ? "Attach it to a conversation first."
                          : summary.enabledBindingCount === 0
                            ? "Every place it runs is paused — a manual run goes ahead anyway."
                            : undefined
                      }
                      onClick={() => {
                        // 3.4: with one place there is nothing to choose, so
                        // the button does what it says instead of asking.
                        if (summary.bindingCount > 1) {
                          setPickingId(automation.id);
                          return;
                        }
                        void startRun(automation.id);
                      }}
                    >
                      {starting ? (
                        <Loader2
                          className="chat-spinner"
                          size={14}
                          aria-hidden="true"
                        />
                      ) : (
                        <Play size={14} aria-hidden="true" />
                      )}
                      Run now
                    </button>
                  )}
                  <button
                    type="button"
                    className="chat-local-action"
                    onClick={() => {
                      setOpenId(automation.id);
                      setOpenTab("definition");
                    }}
                  >
                    <Settings2 size={14} aria-hidden="true" /> Manage
                  </button>
                </div>
              </li>
            );
          })}
        </ul>
      )}

      <button
        type="button"
        className="primary-button coach-automation-new"
        disabled={!api}
        onClick={() => setCreating(true)}
      >
        <Plus size={14} aria-hidden="true" /> New automation
      </button>

      {picking ? (
        <RunNowDialog
          api={api}
          automationId={picking.automation.id}
          automationName={picking.automation.name}
          onClose={() => setPickingId(null)}
          onRun={(bindingIds) => void startRun(picking.automation.id, bindingIds)}
        />
      ) : null}
    </div>
  );
}
